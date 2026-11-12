#!/usr/bin/env python3
"""Impede que arquivos apagados pelo antivírus (ou que o antivírus não deixa criar) sumam do git.

Alguns antivírus corporativos removem arquivos legítimos (.pyw, .mjs, .js...) e depois negam
recriá-los no mesmo caminho. Um `git add -A` registraria a exclusão e o arquivo sumiria do
repositório também nos outros PCs. Este script:

  instalar [repo ...]   põe o hook pre-commit nos repositórios e roda `reparar`
  verificar             (o hook chama) tira do commit a exclusão de arquivos protegidos
  reparar [repo ...]    arquivo do HEAD ausente na pasta e protegido: mantém no git (skip-worktree);
                        arquivo listado em .protegidos apagado num commit recente: devolve ao git
  status [repo ...]     mostra o que está protegido e o que falta na pasta

Um arquivo é protegido quando:
  - está listado no `.protegidos` da raiz do repositório (um caminho ou padrão glob por linha), ou
  - o caminho não pode ser criado neste PC (acesso negado = bloqueio do antivírus).
Exclusão de propósito: `GIT_PERMITIR_APAGAR=1 git commit ...` ou tire o arquivo do `.protegidos`.
"""
import fnmatch
import os
import subprocess
import sys
from pathlib import Path

AQUI = Path(__file__).resolve()
MARCA_HOOK = "agent-kit git_protecao"


def git(repo, *args, check=False, entrada=None):
    r = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, encoding="utf-8",
                       errors="replace", input=entrada)
    if check and r.returncode:
        raise RuntimeError(f"git {' '.join(args)}: {r.stderr.strip()}")
    return r.stdout


def raiz(repo="."):
    out = git(repo, "rev-parse", "--show-toplevel").strip()
    return Path(out) if out else None


def lista_protegidos(repo: Path):
    f = repo / ".protegidos"
    if not f.exists():
        return []
    return [l.strip().replace("\\", "/") for l in f.read_text(encoding="utf-8").splitlines()
            if l.strip() and not l.strip().startswith("#")]


def bloqueado(repo: Path, caminho: str) -> bool:
    """True se este PC nega criar o arquivo nesse caminho (antivírus)."""
    alvo = repo / caminho
    if alvo.exists() or not alvo.parent.is_dir():
        return False
    try:
        with open(alvo, "x"):
            pass
    except PermissionError:
        return True
    except OSError:
        return False
    try:
        alvo.unlink()
    except OSError:
        pass
    return False


def protegido(repo: Path, caminho: str, padroes) -> str | None:
    if any(fnmatch.fnmatch(caminho, p) for p in padroes):
        return "listado em .protegidos"
    if bloqueado(repo, caminho):
        return "o antivírus não deixa criar o arquivo neste PC"
    return None


def manter_no_git(repo: Path, caminho: str):
    """Deixa o arquivo como está no HEAD e faz o git ignorar a ausência dele na pasta."""
    git(repo, "reset", "-q", "HEAD", "--", caminho)
    git(repo, "update-index", "--skip-worktree", "--", caminho)


def verificar():
    repo = raiz()
    if not repo or os.environ.get("GIT_PERMITIR_APAGAR") == "1":
        return 0
    apagados = [l for l in git(repo, "diff", "--cached", "--name-only", "--diff-filter=D", "-z").split("\0") if l]
    if not apagados:
        return 0
    padroes = lista_protegidos(repo)
    salvos = []
    for c in apagados:
        motivo = protegido(repo, c, padroes)
        if motivo:
            manter_no_git(repo, c)
            salvos.append(f"{c} ({motivo})")
    if salvos:
        print("[git_protecao] Exclusão retirada do commit; os arquivos continuam no repositório:", file=sys.stderr)
        for s in salvos:
            print("   - " + s, file=sys.stderr)
        print("   Para apagar de propósito: GIT_PERMITIR_APAGAR=1 git commit ...", file=sys.stderr)
        restante = git(repo, "diff", "--cached", "--name-only").strip()
        if not restante:
            print("[git_protecao] Nada mais a commitar.", file=sys.stderr)
            return 1
    return 0


def reparar(repo: Path, profundidade=200, commitar=True):
    repo = raiz(repo)
    if not repo:
        return []
    feitos = []
    padroes = lista_protegidos(repo)
    # 1) arquivos do HEAD que faltam na pasta
    for c in [l for l in git(repo, "ls-files", "--deleted", "-z").split("\0") if l]:
        motivo = protegido(repo, c, padroes)
        if motivo:
            git(repo, "update-index", "--skip-worktree", "--", c)
            feitos.append(f"{c}: mantido no git ({motivo})")
    # 2) arquivos listados em .protegidos que algum commit recente apagou: volta ao índice a partir do commit anterior
    if padroes:
        no_head = set(l for l in git(repo, "ls-files", "-z").split("\0") if l)
        log = git(repo, "-c", "core.quotepath=false", "log", f"-{profundidade}", "--diff-filter=D", "--name-only", "--format=@@%H")
        commit, voltaram = None, []
        for item in log.splitlines():
            item = item.strip()
            if item.startswith("@@"):
                commit = item[2:]
                continue
            if not item or item in no_head or item in voltaram or not any(fnmatch.fnmatch(item, p) for p in padroes):
                continue
            blob = git(repo, "rev-parse", f"{commit}^:{item}").strip()
            modo = git(repo, "ls-tree", f"{commit}^", "--", item).split(" ")[0] or "100644"
            if not blob:
                continue
            git(repo, "update-index", "--add", "--cacheinfo", f"{modo},{blob},{item}")
            if not (repo / item).exists():
                try:  # tenta devolver também à pasta; se o antivírus negar, fica só no git
                    (repo / item).parent.mkdir(parents=True, exist_ok=True)
                    (repo / item).write_bytes(subprocess.run(["git", "-C", str(repo), "cat-file", "blob", blob],
                                                             capture_output=True).stdout)
                except OSError:
                    git(repo, "update-index", "--skip-worktree", "--", item)
            voltaram.append(item)
            feitos.append(f"{item}: devolvido ao git (apagado em {commit[:7]})")
        if voltaram and commitar:
            outros = set(git(repo, "diff", "--cached", "--name-only").split()) - set(voltaram)
            if outros:
                feitos.append("commit não feito: há outras mudanças preparadas; faça o commit junto com elas")
            else:
                env = dict(os.environ, GIT_PERMITIR_APAGAR="1")
                subprocess.run(["git", "-C", str(repo), "commit", "-q", "-m",
                                "restaura arquivos protegidos apagados por engano (git_protecao)"], env=env)
    return feitos


def instalar(repo: Path):
    repo = raiz(repo)
    if not repo:
        return f"{repo}: não é repositório git"
    hooks = Path(git(repo, "rev-parse", "--git-path", "hooks").strip())
    if not hooks.is_absolute():
        hooks = repo / hooks
    hooks.mkdir(parents=True, exist_ok=True)
    hook = hooks / "pre-commit"
    exe = Path(sys.executable)
    if exe.name.lower() == "pythonw.exe" and (exe.parent / "python.exe").exists():
        exe = exe.parent / "python.exe"  # pythonw não mostra as mensagens do hook
    py = exe.as_posix()
    linha = f'"{py}" "{AQUI.as_posix()}" verificar || exit 1  # {MARCA_HOOK}'
    if hook.exists():
        atual = hook.read_text(encoding="utf-8", errors="ignore")
        if MARCA_HOOK in atual:
            novo = "\n".join(linha if MARCA_HOOK in l else l for l in atual.splitlines()) + "\n"
        else:
            novo = atual.rstrip("\n") + "\n" + linha + "\n"  # mantém o hook que já existia
    else:
        novo = "#!/bin/sh\n" + linha + "\n"
    hook.write_text(novo, encoding="utf-8", newline="\n")
    feitos = reparar(repo)
    return f"{repo}: hook instalado" + ("; " + "; ".join(feitos) if feitos else "")


def status(repo: Path):
    repo = raiz(repo)
    if not repo:
        return
    skip = [l[2:] for l in git(repo, "ls-files", "-v").splitlines() if l[:1] == "S"]
    faltam = [l for l in git(repo, "ls-files", "--deleted", "-z").split("\0") if l]
    hook = Path(git(repo, "rev-parse", "--git-path", "hooks").strip())
    hook = (hook if hook.is_absolute() else repo / hook) / "pre-commit"
    ativo = hook.exists() and MARCA_HOOK in hook.read_text(encoding="utf-8", errors="ignore")
    print(f"{repo}: hook {'ativo' if ativo else 'AUSENTE'}; .protegidos={lista_protegidos(repo) or '-'}; "
          f"mantidos só no git={skip or '-'}; faltando na pasta={faltam or '-'}")


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    cmd, *repos = sys.argv[1:] or ["status"]
    repos = [Path(r) for r in repos] or [Path.cwd()]
    if cmd == "verificar":
        sys.exit(verificar())
    for r in repos:
        if cmd == "instalar":
            print(instalar(r))
        elif cmd == "reparar":
            print(f"{r}: " + ("; ".join(reparar(r)) or "nada a reparar"))
        elif cmd == "status":
            status(r)
        else:
            sys.exit(__doc__)


if __name__ == "__main__":
    main()
