#!/usr/bin/env python3
"""Instala/atualiza skills, regras, o orquestrador (delegar) e o cofre de conhecimento do agent-kit.

Uso em um computador novo (Windows): rode instalar.ps1, que instala o que faltar em versão
portátil (Python, Git, Node) e depois chama este script. Com Python e Git já instalados:
    git clone <REPO_URL> ~/agent-kit
    python ~/agent-kit/install.py

Opções:
    --repo URL        clona o kit se a pasta ainda não for um clone
    --dir PASTA       pasta do clone (padrão: a deste script ou ~/agent-kit)
    --vault PASTA     cofre em outro lugar (padrão: <kit>/vault)
    --mapear          mapeia os projetos do PC e grava no cofre sem perguntar
    --nao-mapear      não pergunta sobre o mapeamento
    --verificar       só mostra o diagnóstico (ferramentas, PATH, caminhos), sem mudar nada
    --silencioso      sem perguntas (usado pelo sync.py); não instala ferramentas nem mapeia

Rodar de novo apenas atualiza (git pull + reinstala).
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

HOME = Path.home()
WINDOWS = os.name == "nt"
SKILL_TARGETS = [
    HOME / ".claude" / "skills",            # Claude Code
    HOME / ".agents" / "skills",            # opencode
    HOME / ".gemini" / "config" / "skills",  # Gemini CLI / Antigravity
]
GEMINI_RULES = HOME / ".gemini" / "config" / "rules"
OPENCODE_DIR = HOME / ".config" / "opencode"
CLAUDE_MD = HOME / ".claude" / "CLAUDE.md"
TOOLS_DIR = HOME / "agent-kit-tools"   # versões portáteis instaladas pelo instalar.ps1
MANIFEST = ".agent-kit-manifest.json"
BLOCK_START = "<!-- agent-kit:start -->"
BLOCK_END = "<!-- agent-kit:end -->"
TEXT_SUFFIXES = {".md", ".txt", ".py", ".json", ".yaml", ".yml", ".mjs", ".js", ".ps1", ".toml"}


def info(msg):
    print(f"==> {msg}")


def perguntar(msg, padrao=False, silencioso=False):
    if silencioso or not sys.stdin or not sys.stdin.isatty():
        return padrao
    resp = input(f"{msg} [{'S/n' if padrao else 's/N'}] ").strip().lower()
    return padrao if not resp else resp in {"s", "sim", "y", "yes"}


def git(kit: Path, *args, check=True):
    return subprocess.run(["git", "-C", str(kit), *args], check=check, capture_output=True, text=True,
                          encoding="utf-8", errors="replace")


def documentos() -> Path:
    if WINDOWS:
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                                r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders") as k:
                return Path(os.path.expandvars(winreg.QueryValueEx(k, "Personal")[0]))
        except OSError:
            pass
    return HOME / "Documents"


# ---------------------------------------------------------------- repositório

def ensure_repo(kit: Path, repo: str | None, verificar: bool) -> str:
    if not (kit / ".git").exists():
        if not repo:
            sys.exit(f"{kit} não é um clone do agent-kit; informe --repo <url>.")
        if verificar:
            sys.exit("--verificar não clona nada.")
        info(f"Clonando {repo} em {kit}")
        subprocess.run(["git", "clone", repo, str(kit)], check=True)
    elif not verificar:
        r = git(kit, "pull", "--rebase", "--autostash", check=False)
        print("    git pull:", ((r.stdout or r.stderr).strip().splitlines() or ["ok"])[-1])
    url = git(kit, "remote", "get-url", "origin", check=False).stdout.strip() or (repo or "")
    return re.sub(r"//[^/@]+@", "//", url)  # nunca grava usuário/token de uma URL


# ---------------------------------------------------------------- ferramentas e PATH

FERRAMENTAS = [
    # nome, comando, obrigatória, para que serve
    ("Git", "git", True, "clonar o kit, worktrees do orquestrador"),
    ("Node.js", "node", True, "painel e CLI do orquestrador (delegar), CLIs de IA via npm"),
    ("npm", "npm", False, "instalar Claude Code, opencode e Gemini CLI"),
    ("Claude Code", "claude", False, "planejador e executor Claude"),
    ("Antigravity CLI (agy)", "agy", False, "executor Gemini; vem com o Antigravity IDE"),
    ("opencode", "opencode", False, "modelos gratuitos (modo desespero) e executor"),
    ("Gemini CLI", "gemini", False, "opcional"),
]


def achar(cmd):
    p = shutil.which(cmd)
    if p:
        return p
    extras = {
        "agy": [HOME / ".gemini" / "bin" / "agy.exe"],
        "node": [TOOLS_DIR / "node" / "node.exe"],
        "npm": [TOOLS_DIR / "node" / "npm.cmd"],
        "git": [TOOLS_DIR / "git" / "cmd" / "git.exe"],
        "claude": [Path(os.environ.get("APPDATA", "")) / "npm" / "claude.cmd"],
        "opencode": [Path(os.environ.get("APPDATA", "")) / "npm" / "opencode.cmd"],
    }.get(cmd, [])
    return next((str(x) for x in extras if x.exists()), None)


def diagnostico():
    achados = {}
    info("Ferramentas neste PC")
    for nome, cmd, obrig, uso in FERRAMENTAS:
        p = achar(cmd)
        achados[cmd] = p
        marca = "ok " if p else ("FALTA" if obrig else "-- ")
        print(f"    [{marca}] {nome:<22} {p or ''}{'' if p else '  (' + uso + ')'}")
    print(f"    [ok ] Python                 {sys.executable}")
    provs = [c for c in ("claude", "agy", "opencode") if achados.get(c)]
    if provs:
        print(f"    Orquestrador: vai usar {', '.join(provs)}. "
              + ("O planejamento fica com o Claude." if "claude" in provs else
                 "Sem Claude: o planejamento fica com o Gemini (agy)." if "agy" in provs else
                 "Só opencode: tudo roda nos modelos gratuitos."))
    else:
        print("    Orquestrador: nenhuma CLI de IA encontrada (claude, agy ou opencode); o painel abre, mas não planeja.")
    return achados


def path_usuario_windows():
    import winreg
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment", 0, winreg.KEY_READ) as k:
        try:
            valor, tipo = winreg.QueryValueEx(k, "Path")
        except FileNotFoundError:
            valor, tipo = "", winreg.REG_EXPAND_SZ
    return valor, tipo


def adicionar_path(pastas, verificar):
    """Põe as pastas no PATH do usuário (Windows) e no PATH deste processo."""
    pastas = [str(p) for p in pastas if Path(p).is_dir()]
    if not pastas:
        return
    for p in pastas:
        if p.lower() not in os.environ.get("PATH", "").lower():
            os.environ["PATH"] = p + os.pathsep + os.environ.get("PATH", "")
    if not WINDOWS:
        faltam = [p for p in pastas if p not in os.environ.get("PATH", "")]
        if faltam:
            print("    Acrescente ao PATH do seu shell:", os.pathsep.join(faltam))
        return
    import winreg
    atual, tipo = path_usuario_windows()
    itens = [x for x in atual.split(";") if x]
    novos = [p for p in pastas if p.lower() not in {os.path.expandvars(x).lower().rstrip("\\") for x in itens}]
    if not novos:
        return
    if verificar:
        print("    Faltam no PATH do usuário:", "; ".join(novos))
        return
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment", 0, winreg.KEY_SET_VALUE) as k:
        winreg.SetValueEx(k, "Path", 0, tipo, ";".join(itens + novos))
    try:  # avisa o Windows para os próximos terminais já verem o PATH novo
        import ctypes
        ctypes.windll.user32.SendMessageTimeoutW(0xFFFF, 0x001A, 0, "Environment", 0x0002, 5000, None)
    except Exception:
        pass
    info("PATH do usuário: " + "; ".join(novos) + " (abra um terminal novo para valer)")


def instalar_ferramentas(kit, achados, args):
    """Chama o instalar.ps1 para o que faltar (versões portáteis) e o npm para as CLIs de IA."""
    if args.verificar or args.silencioso:
        return achados
    faltam = [c for c in ("git", "node") if not achados.get(c)]
    if faltam and WINDOWS and (kit / "instalar.ps1").exists():
        if perguntar(f"Faltam {', '.join(faltam)}. Instalar versões portáteis em {TOOLS_DIR}?", True):
            subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                            str(kit / "instalar.ps1"), "-SoFerramentas"], check=False)
            adicionar_path([TOOLS_DIR / "node", TOOLS_DIR / "git" / "cmd"], False)
            achados = {c: achar(c) for _, c, _, _ in FERRAMENTAS}
    elif faltam:
        print(f"    Instale {', '.join(faltam)} pelo gerenciador de pacotes do sistema e rode de novo.")
    npm = achados.get("npm") or achar("npm")
    pacotes = [("claude", "@anthropic-ai/claude-code", "Claude Code"), ("opencode", "opencode-ai", "opencode")]
    faltam_cli = [(c, pkg, nome) for c, pkg, nome in pacotes if not achados.get(c)]
    if npm and faltam_cli and perguntar(f"Instalar {', '.join(n for _, _, n in faltam_cli)} pelo npm?", True):
        for c, pkg, nome in faltam_cli:
            info(f"npm install -g {pkg}")
            subprocess.run([npm, "install", "-g", pkg], check=False)
            achados[c] = achar(c)
        print("    Faça o login de cada uma uma vez: `claude` (conta Anthropic) e `opencode auth login` se quiser provedores pagos;"
              " os modelos *-free do opencode não pedem conta.")
    if not achados.get("agy"):
        print("    Antigravity (agy): não há versão portátil. Para usar o Gemini, instale o Antigravity IDE"
              " (https://antigravity.google) e rode `agy` uma vez para entrar com a conta Google.")
    return achados


# ---------------------------------------------------------------- skills e regras

def render(text: str, ctx: dict) -> str:
    for k, v in ctx.items():
        text = text.replace("{{" + k + "}}", v)
    return text


def copy_rendered(src: Path, dst: Path, ctx: dict):
    if dst.exists():
        shutil.rmtree(dst)
    for f in src.rglob("*"):
        if "__pycache__" in f.parts:
            continue
        out = dst / f.relative_to(src)
        if f.is_dir():
            out.mkdir(parents=True, exist_ok=True)
            continue
        out.parent.mkdir(parents=True, exist_ok=True)
        if f.suffix in TEXT_SUFFIXES:
            try:
                out.write_text(render(f.read_text(encoding="utf-8"), ctx), encoding="utf-8", newline="")
                continue
            except UnicodeDecodeError:
                pass
        shutil.copy2(f, out)


def install_skills(kit: Path, ctx: dict):
    skills = sorted(p.name for p in (kit / "skills").iterdir() if (p / "SKILL.md").exists())
    for target in SKILL_TARGETS:
        target.mkdir(parents=True, exist_ok=True)
        manifest = target / MANIFEST
        previous = set(json.loads(manifest.read_text())) if manifest.exists() else set()
        for name in previous - set(skills):  # skill removida do repositório
            shutil.rmtree(target / name, ignore_errors=True)
        for name in skills:
            try:
                copy_rendered(kit / "skills" / name, target / name, ctx)
            except PermissionError as e:  # ex.: painel do delegar aberto segurando um arquivo
                print(f"    [AVISO] {name} em {target}: {e}. Feche o que estiver usando a pasta e rode de novo.")
        manifest.write_text(json.dumps(skills, indent=2))
        print(f"    {len(skills)} skills -> {target}")


def install_rules(kit: Path, ctx: dict):
    rules = sorted((kit / "rules").glob("*.md"))
    rendered = {r.name: render(r.read_text(encoding="utf-8"), ctx) for r in rules}

    GEMINI_RULES.mkdir(parents=True, exist_ok=True)
    for name, text in rendered.items():
        (GEMINI_RULES / name).write_text(text, encoding="utf-8")

    OPENCODE_DIR.mkdir(parents=True, exist_ok=True)
    paths = []
    for name, text in rendered.items():
        p = OPENCODE_DIR / name
        p.write_text(text, encoding="utf-8")
        paths.append(p.as_posix())
    cfg = OPENCODE_DIR / "opencode.jsonc"
    if not cfg.exists():
        cfg.write_text(json.dumps({"$schema": "https://opencode.ai/config.json",
                                   "instructions": paths}, indent=2), encoding="utf-8")
    else:
        text = cfg.read_text(encoding="utf-8")
        missing = [p for p in paths if p not in text]
        if missing:
            entries = "".join(f'\n    "{p}",' for p in missing)
            if re.search(r'"instructions"\s*:\s*\[', text):
                text = re.sub(r'("instructions"\s*:\s*\[)', lambda m: m.group(1) + entries, text, count=1)
            else:
                text = re.sub(r"\{", lambda m: "{\n  \"instructions\": [" + entries.rstrip(",") + "\n  ],", text, count=1)
            cfg.write_text(text, encoding="utf-8")

    CLAUDE_MD.parent.mkdir(parents=True, exist_ok=True)
    block = "\n".join([BLOCK_START] + [f"@{p}" for p in paths] + [BLOCK_END])
    current = CLAUDE_MD.read_text(encoding="utf-8") if CLAUDE_MD.exists() else ""
    if BLOCK_START in current:
        current = re.sub(re.escape(BLOCK_START) + r".*?" + re.escape(BLOCK_END), lambda m: block, current, flags=re.S)
    elif all(f"@{p}" in current for p in paths):
        pass  # já importadas à mão
    else:
        current = (current.rstrip() + "\n\n" if current.strip() else "") + block + "\n"
    CLAUDE_MD.write_text(current, encoding="utf-8")
    print(f"    {len(rules)} regras -> Gemini, opencode e Claude Code")


# ---------------------------------------------------------------- endereços quebrados

def _sem_comentarios(jsonc: str) -> str:
    out, i, n, em_str = [], 0, len(jsonc), False
    while i < n:
        c = jsonc[i]
        if em_str:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(jsonc[i + 1]); i += 2; continue
            if c == '"':
                em_str = False
        elif c == '"':
            em_str = True; out.append(c)
        elif jsonc.startswith("//", i):
            while i < n and jsonc[i] != "\n":
                i += 1
            continue
        elif jsonc.startswith("/*", i):
            j = jsonc.find("*/", i + 2); i = n if j < 0 else j + 2; continue
        else:
            out.append(c)
        i += 1
    return re.sub(r",(\s*[}\]])", r"\1", "".join(out))


def ajustar_mcp_opencode(verificar):
    """Servidores MCP do opencode cujo executável não existe mais nesta máquina: troca pelo que estiver no PATH."""
    cfg = OPENCODE_DIR / "opencode.jsonc"
    if not cfg.exists():
        return
    texto = cfg.read_text(encoding="utf-8")
    try:
        dados = json.loads(_sem_comentarios(texto))
    except ValueError:
        print(f"    [AVISO] {cfg} não é JSON válido; não mexi nele.")
        return
    trocas = []
    for nome, srv in (dados.get("mcp") or {}).items():
        cmd = srv.get("command") if isinstance(srv, dict) else None
        if not isinstance(cmd, list) or not cmd or not isinstance(cmd[0], str):
            continue
        for arg in cmd[1:]:
            if isinstance(arg, str) and re.match(r"^[A-Za-z]:[\\/]", arg) and not Path(arg).exists():
                print(f"    [AVISO] MCP '{nome}' do opencode aponta para {arg}, que não existe neste PC; reinstale o servidor ou remova a entrada.")
        exe = Path(cmd[0])
        if not exe.is_absolute() or exe.exists():
            continue
        base = exe.stem.lower()
        if base.startswith("python") or base == "py":
            novo = sys.executable  # o Python que está rodando o instalador
        else:
            novo = next((shutil.which(c) for c in [base] if shutil.which(c)), None)
        if novo:
            trocas.append((nome, cmd[0], novo))
        else:
            print(f"    [AVISO] MCP '{nome}' do opencode usa {cmd[0]}, que não existe e não tem substituto no PATH.")
    if not trocas:
        return
    for nome, velho, novo in trocas:
        print(f"    MCP '{nome}' do opencode: {velho} -> {novo}" + (" (só diagnóstico)" if verificar else ""))
    if verificar:
        return
    shutil.copy2(cfg, cfg.with_suffix(".jsonc.bak-agent-kit"))
    for _, velho, novo in trocas:
        for forma in {velho, velho.replace("\\", "/"), velho.replace("\\", "\\\\")}:
            texto = texto.replace(json.dumps(forma)[1:-1], json.dumps(Path(novo).as_posix())[1:-1])
    cfg.write_text(texto, encoding="utf-8")


def preparar_delegar(ctx):
    d = HOME / ".delegar"
    d.mkdir(exist_ok=True)
    (d / "ambiente.json").write_text(json.dumps({"vault": ctx["VAULT_PATH"], "kit": ctx["KIT_PATH"],
                                                 "atualizado": datetime.now().isoformat(timespec="seconds")}, indent=2), encoding="utf-8")


# ---------------------------------------------------------------- mapa de projetos

PULAR = {"node_modules", "venv", ".venv", "env", "__pycache__", "site-packages", "dist", "build", "target", "bin", "obj",
         "AppData", "Application Data", "Program Files", "Program Files (x86)", "Windows", "$Recycle.Bin", "OneDriveTemp",
         "Minhas Imagens", "Minhas Músicas", "Meus Vídeos", "My Pictures", "My Music", "My Videos", "Downloads", "agent-kit-tools"}
MARCAS = {
    "package.json": "Node.js", "pyproject.toml": "Python", "requirements.txt": "Python", "setup.py": "Python",
    "manage.py": "Django", "go.mod": "Go", "Cargo.toml": "Rust", "pom.xml": "Java (Maven)", "build.gradle": "Java/Android (Gradle)",
    "build.gradle.kts": "Kotlin/Android (Gradle)", "wrangler.toml": "Cloudflare Workers", "wrangler.jsonc": "Cloudflare Workers",
    "Dockerfile": "Docker", "docker-compose.yml": "Docker Compose", "compose.yaml": "Docker Compose", "CMakeLists.txt": "C/C++ (CMake)",
    "composer.json": "PHP", "Gemfile": "Ruby", "pubspec.yaml": "Flutter/Dart", "main.py": "Python", "app.py": "Python",
    "iniciar.pyw": "Python",
}
LIBS = {"react": "React", "vue": "Vue", "next": "Next.js", "express": "Express", "hono": "Hono", "vite": "Vite",
        "django": "Django", "fastapi": "FastAPI", "flask": "Flask", "pyqt6": "PyQt6", "pyside6": "PySide6", "nuitka": "Nuitka",
        "playwright": "Playwright", "selenium": "Selenium", "pandas": "pandas", "electron": "Electron", "streamlit": "Streamlit"}


def eh_projeto(d: Path):
    try:
        nomes = {x.name for x in d.iterdir()}
    except OSError:
        return False
    return ".git" in nomes or bool(nomes & set(MARCAS)) or any(n.endswith((".sln", ".csproj")) for n in nomes)


def varrer(raizes):
    """Desce em cada raiz até a profundidade indicada; uma pasta de projeto não é aberta (subpastas dela não contam)."""
    vistos, achados = set(), []

    def visitar(d: Path, nivel, limite):
        try:
            real = d.resolve()
        except OSError:
            return
        if real in vistos:
            return
        vistos.add(real)
        if nivel > 0 and eh_projeto(d):
            achados.append(d)
            return
        if nivel >= limite:
            return
        try:
            filhos = sorted(x for x in d.iterdir() if x.is_dir() and not x.is_symlink())
        except OSError:
            return
        for f in filhos:
            if f.name.startswith((".", "$")) or f.name in PULAR or f.name.endswith("-wt"):
                continue
            visitar(f, nivel + 1, limite)

    for raiz, limite in raizes:
        if raiz.is_dir():
            visitar(raiz, 0, limite)
    return achados


def descrever(d: Path):
    nomes = {x.name for x in d.iterdir()}
    stack = sorted({v for k, v in MARCAS.items() if k in nomes} | ({".NET"} if any(n.endswith((".sln", ".csproj")) for n in nomes) else set()))
    texto_deps = ""
    for f in ("package.json", "requirements.txt", "pyproject.toml"):
        if f in nomes:
            try:
                texto_deps += (d / f).read_text(encoding="utf-8", errors="ignore")[:20000].lower()
            except OSError:
                pass
    libs = sorted({v for k, v in LIBS.items() if re.search(r'(^|["\s/=<>~^-])' + re.escape(k) + r'(["\s=<>~^\[]|$)', texto_deps, re.M)})
    g = {}
    if (d / ".git").exists():
        run = lambda *a: subprocess.run(["git", "-C", str(d), *a], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=15).stdout.strip()
        try:
            g["remoto"] = re.sub(r"//[^/@]+@", "//", run("remote", "get-url", "origin"))  # tira usuário/token
            g["branch"] = run("rev-parse", "--abbrev-ref", "HEAD")
            g["ultimo"] = run("log", "-1", "--format=%cs %s")
            g["pendentes"] = len([l for l in run("status", "--porcelain").splitlines() if l.strip()])
        except (OSError, subprocess.SubprocessError):
            pass
    resumo = ""
    for nome in ("README.md", "readme.md", "README.txt", "README"):
        if nome in nomes:
            try:
                linhas = (d / nome).read_text(encoding="utf-8", errors="ignore").splitlines()
            except OSError:
                break
            par = []
            for l in linhas:
                s = l.strip()
                if not s or s.startswith(("#", "!", "[!", "<", "```", "|", "---")):
                    if par:
                        break
                    continue
                par.append(s)
            resumo = " ".join(par)[:500]
            break
    return {"stack": stack, "libs": libs, "git": g, "resumo": resumo}


def slug(s):
    import unicodedata
    s = unicodedata.normalize("NFD", s).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "_", s).strip("_")[:60] or "projeto"


def mapear_projetos(vault: Path, kit: Path):
    docs = documentos()
    raizes = [(docs, 3), (HOME / "Desktop", 2), (HOME / "source", 3), (HOME / "repos", 3), (HOME / "projects", 3),
              (HOME / "projetos", 3), (HOME / "dev", 3), (HOME / "code", 3), (HOME / "workspace", 3), (HOME / "git", 3)]
    info("Procurando projetos (pastas com .git ou arquivos de projeto) em: " + ", ".join(str(r) for r, _ in raizes if r.is_dir()))
    projetos = [p for p in varrer(raizes) if kit.resolve() not in (p.resolve(), *p.resolve().parents)
                and vault.resolve() not in (p.resolve(), *p.resolve().parents)]
    if not projetos:
        print("    Nenhum projeto encontrado.")
        return 0
    pasta = vault / "projetos" / "mapa_pc"   # notas automáticas, separadas das escritas à mão
    pasta.mkdir(parents=True, exist_ok=True)
    hoje = datetime.now().strftime("%d/%m/%Y")
    ini, fim = "<!-- agent-kit:mapa:inicio -->", "<!-- agent-kit:mapa:fim -->"
    linhas_mapa, novos, atualizados = [], 0, 0
    usados = set()
    # notas do cofre que já citam cada pasta (para ligar o mapa ao que já foi escrito)
    textos = {}
    for md in vault.rglob("*.md"):
        if pasta in md.parents or md.name == "00_mapa_de_projetos.md":
            continue
        try:
            textos[md.relative_to(vault).with_suffix("").as_posix()] = md.read_text(encoding="utf-8", errors="ignore").lower()
        except OSError:
            pass
    for p in sorted(projetos, key=lambda x: str(x).lower()):
        try:
            dsc = descrever(p)
        except OSError:
            continue
        nome = slug(p.name)
        while nome in usados:
            nome = slug(p.parent.name + "_" + p.name) if nome == slug(p.name) else nome + "_2"
        usados.add(nome)
        g = dsc["git"]
        tecs = list(dict.fromkeys(dsc["stack"] + dsc["libs"]))
        alvos = {str(p).lower(), str(p).lower().replace("\\", "/"), str(p).lower().replace("\\", "\\\\")}
        relacionadas = sorted((k for k, t in textos.items() if any(a in t for a in alvos)), key=lambda k: (k[:1].isdigit(), k))[:8]
        bloco = "\n".join([ini,
            f"- **Caminho:** `{p}`",
            f"- **Tecnologias:** {', '.join(tecs) or 'não identificadas'}",
            f"- **Notas do cofre que citam esta pasta:** {', '.join(f'[[{r}]]' for r in relacionadas) or 'nenhuma'}",
            (f"- **Git:** {g.get('remoto') or 'sem remoto'} · branch `{g.get('branch', '-')}` · último commit: {g.get('ultimo') or '-'}"
             + (f" · {g['pendentes']} arquivos alterados sem commit" if g.get("pendentes") else "")) if g else "- **Git:** não é repositório git",
            f"- **Descrição (README):** {dsc['resumo'] or 'sem README'}",
            f"- **Mapeado em:** {hoje}, pelo instalador do agent-kit. Rodar `install.py --mapear` atualiza este bloco.",
            fim])
        nota = pasta / f"{nome}.md"
        if nota.exists():
            atual = nota.read_text(encoding="utf-8")
            if ini in atual and fim in atual:
                nota.write_text(re.sub(re.escape(ini) + r".*?" + re.escape(fim), lambda m: bloco, atual, flags=re.S), encoding="utf-8")
                atualizados += 1
            # nota escrita à mão: não mexe
        else:
            nota.write_text(f"# {p.name}\n\n{bloco}\n\n## Notas\n\n- Objetivo, decisões e pendências deste projeto.\n", encoding="utf-8")
            novos += 1
        linhas_mapa.append(f"| [[projetos/mapa_pc/{nome}]] | `{p}` | {', '.join(tecs) or '-'} | {(g.get('ultimo') or '-')[:10] if g else '-'} | "
                           f"{', '.join(f'[[{r}]]' for r in relacionadas[:3]) or '-'} |")
    mapa = vault / "projetos" / "00_mapa_de_projetos.md"
    mapa.write_text("# Mapa de projetos do PC\n\nGerado pelo instalador do agent-kit em " + hoje +
                    ". Rode `python install.py --mapear` para atualizar. As notas automáticas ficam em `projetos/mapa_pc/`;"
                    " as notas escritas à mão não são alteradas.\n\n| Nota | Pasta | Tecnologias | Último commit | Notas relacionadas |\n|---|---|---|---|---|\n"
                    + "\n".join(linhas_mapa) + "\n", encoding="utf-8")
    indice = vault / "00_INDICE.md"
    if indice.exists():
        s = indice.read_text(encoding="utf-8")
        if "[[projetos/00_mapa_de_projetos]]" not in s:
            s = s.rstrip() + "\n\n## 🗺️ Mapa de projetos do PC\n- [[projetos/00_mapa_de_projetos]]: todos os projetos encontrados neste computador, com pasta, tecnologias e último commit.\n"
            indice.write_text(s, encoding="utf-8")
    log = vault / "01_LOG_DIARIO.md"
    if log.exists():
        s = log.read_text(encoding="utf-8")
        entrada = (f"### 📌 Instalador do agent-kit: mapa de projetos do PC\n"
                   f"- **Adicionado:** {novos} notas novas em `projetos/mapa_pc/`; {atualizados} atualizadas; mapa em [[projetos/00_mapa_de_projetos]] ({len(linhas_mapa)} projetos).\n"
                   f"- **Pendências:** completar objetivo e decisões nas notas novas.\n\n")
        cab = f"## 📅 {hoje}"
        if cab in s:
            i = s.index(cab) + len(cab)
            s = s[:i] + "\n\n" + entrada + s[i:].lstrip("\n")
        else:
            sep = s.find("\n---\n")
            s = (s[:sep + 5] + f"\n{cab}\n\n{entrada}" + s[sep + 5:].lstrip()) if sep >= 0 else f"{cab}\n\n{entrada}{s}"
        log.write_text(s, encoding="utf-8")
    info(f"Mapa de projetos: {len(linhas_mapa)} projetos ({novos} notas novas, {atualizados} atualizadas) em {pasta}")
    return len(linhas_mapa)


# ---------------------------------------------------------------- principal

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", help="URL do repositório GitHub do agent-kit")
    ap.add_argument("--dir", help="Pasta do clone (padrão: pasta deste script ou ~/agent-kit)")
    ap.add_argument("--vault", help="Pasta do cofre (padrão: <kit>/vault)")
    ap.add_argument("--mapear", action="store_true")
    ap.add_argument("--nao-mapear", action="store_true")
    ap.add_argument("--verificar", action="store_true")
    ap.add_argument("--silencioso", action="store_true")
    args = ap.parse_args()
    if not sys.stdout.isatty():
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    here = Path(__file__).resolve().parent
    kit = Path(args.dir).expanduser().resolve() if args.dir else (here if (here / "skills").is_dir() else HOME / "agent-kit")
    repo_url = ensure_repo(kit, args.repo, args.verificar)
    vault = Path(args.vault).expanduser().resolve() if args.vault else kit / "vault"
    ctx = {"VAULT_PATH": str(vault), "KIT_PATH": str(kit), "REPO_URL": repo_url, "HOME": str(HOME), "DOCS_PATH": str(documentos())}
    info(f"agent-kit em {kit}; cofre em {vault}")

    achados = diagnostico()
    if not args.silencioso:
        achados = instalar_ferramentas(kit, achados, args)
    adicionar_path([TOOLS_DIR / "node", TOOLS_DIR / "git" / "cmd", TOOLS_DIR / "python",
                    Path(os.environ.get("APPDATA", "")) / "npm" if WINDOWS else HOME / ".npm-global" / "bin",
                    HOME / ".gemini" / "bin"], args.verificar)
    ajustar_mcp_opencode(args.verificar)
    if args.verificar:
        print("Diagnóstico concluído; nada foi alterado.")
        return

    info("Skills")
    install_skills(kit, ctx)
    info("Regras")
    install_rules(kit, ctx)
    preparar_delegar(ctx)

    if args.mapear or (not args.nao_mapear and not args.silencioso and perguntar(
            "Mapear os projetos deste PC (pastas com .git ou arquivos de projeto em Documentos, Desktop, source, repos...)"
            " e criar uma nota para cada um no cofre?", False)):
        mapear_projetos(vault, kit)

    print(f"\nPronto. Cofre em {vault}")
    print("Orquestrador: diga ao Claude/Gemini \"delegar <pedido>\" ou rode "
          f"`node \"{HOME / '.claude' / 'skills' / 'delegar' / 'app' / 'cli.mjs'}\" iniciar` e abra http://127.0.0.1:8790")


if __name__ == "__main__":
    main()
