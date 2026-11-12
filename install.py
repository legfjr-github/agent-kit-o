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
    --minimo          não instala ferramentas nem CLIs de IA (por padrão a instalação é completa)

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
GEMINI_RULES = HOME / ".gemini" / "config" / "rules"


def ias():
    """Cada IA que pode existir no PC: onde ficam as skills e o arquivo de regras globais.
    'sempre' = instala mesmo sem a IA no PC (Claude, Gemini/Antigravity, opencode e a pasta comum ~/.agents)."""
    win = HOME / ".codeium" / "windsurf"
    return [
        {"nome": "Claude Code", "base": HOME / ".claude", "cmd": "claude", "sempre": True,
         "skills": [HOME / ".claude" / "skills"], "regras": ("claude", HOME / ".claude" / "CLAUDE.md")},
        {"nome": "Antigravity (agy) e Gemini CLI", "base": HOME / ".gemini", "cmd": "agy", "sempre": True,
         "skills": [HOME / ".gemini" / "config" / "skills", HOME / ".gemini" / "skills"],
         "regras": ("bloco", HOME / ".gemini" / "GEMINI.md")},
        {"nome": "opencode", "base": HOME / ".config" / "opencode", "cmd": "opencode", "sempre": True,
         "skills": [HOME / ".config" / "opencode" / "skills"], "regras": ("opencode", None)},
        {"nome": "Agentes compatíveis (~/.agents)", "base": HOME / ".agents", "cmd": None, "sempre": True,
         "skills": [HOME / ".agents" / "skills"], "regras": None},
        {"nome": "Codex", "base": HOME / ".codex", "cmd": "codex", "sempre": False,
         "skills": [HOME / ".codex" / "skills"], "regras": ("bloco", HOME / ".codex" / "AGENTS.md")},
        {"nome": "Qwen Code", "base": HOME / ".qwen", "cmd": "qwen", "sempre": False,
         "skills": [HOME / ".qwen" / "skills"], "regras": ("bloco", HOME / ".qwen" / "QWEN.md")},
        {"nome": "Windsurf", "base": win, "cmd": None, "sempre": False,
         "skills": [win / "skills"], "regras": ("curto", win / "memories" / "global_rules.md")},
        {"nome": "Cursor", "base": HOME / ".cursor", "cmd": "cursor", "sempre": False,
         "skills": [HOME / ".cursor" / "skills"], "regras": None},
    ]


def ias_presentes():
    return [a for a in ias() if a["sempre"] or a["base"].is_dir() or (a["cmd"] and shutil.which(a["cmd"]))]
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
    print("    IAs que vão receber skills e regras: " + ", ".join(a["nome"] for a in ias_presentes()))
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
    """Instalação completa por padrão (sem perguntar); --minimo pula esta etapa."""
    if args.verificar or args.silencioso or args.minimo:
        return achados
    faltam = [c for c in ("git", "node") if not achados.get(c)]
    if faltam and WINDOWS and (kit / "instalar.ps1").exists():
        info(f"Instalando {', '.join(faltam)} em versão portátil ({TOOLS_DIR})")
        subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                        str(kit / "instalar.ps1"), "-SoFerramentas"], check=False)
        adicionar_path([TOOLS_DIR / "node", TOOLS_DIR / "git" / "cmd"], False)
        achados = {c: achar(c) for _, c, _, _ in FERRAMENTAS}
    elif faltam:
        print(f"    Instale {', '.join(faltam)} pelo gerenciador de pacotes do sistema e rode de novo.")
    npm = achados.get("npm") or achar("npm")
    pacotes = [("claude", "@anthropic-ai/claude-code", "Claude Code"), ("opencode", "opencode-ai", "opencode"),
               ("gemini", "@google/gemini-cli", "Gemini CLI")]
    faltam_cli = [(c, pkg, nome) for c, pkg, nome in pacotes if not achados.get(c)]
    if npm and faltam_cli:
        for c, pkg, nome in faltam_cli:
            info(f"Instalando {nome} (npm install -g {pkg})")
            subprocess.run([npm, "install", "-g", pkg], check=False)
            achados[c] = achar(c)
        print("    Faça o login de cada uma uma vez: `claude` (conta Anthropic), `gemini` (conta Google) e, no opencode,"
              " `opencode auth login` só se quiser provedores pagos; os modelos *-free não pedem conta.")
    elif faltam_cli:
        print(f"    Sem npm: não deu para instalar {', '.join(n for _, _, n in faltam_cli)}.")
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
    alvos = []
    for ia in ias_presentes():
        alvos += [(ia["nome"], d) for d in ia["skills"]]
    for nome_ia, target in alvos:
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
        print(f"    {len(skills)} skills -> {nome_ia}: {target}")


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

    # Claude Code: importa os arquivos (@caminho) no CLAUDE.md do usuário
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
    feitos = ["Claude Code (CLAUDE.md)", "opencode (instructions)"]

    # Demais IAs: o texto das regras vai dentro de um bloco no arquivo de memória global de cada uma
    completo = "\n\n".join(rendered.values())
    curto = "\n\n".join(rendered[n] for n in ("uso-do-kit.md", "knowledge-vault.md") if n in rendered)  # Windsurf: limite ~6000 caracteres
    for ia in ias_presentes():
        r = ia["regras"]
        if not r or r[0] not in {"bloco", "curto"}:
            continue
        gravar_bloco(r[1], curto if r[0] == "curto" else completo)
        feitos.append(f"{ia['nome']} ({r[1].name})")
    print(f"    {len(rules)} regras -> " + "; ".join(feitos))


def gravar_bloco(arquivo: Path, texto: str):
    """Põe o texto entre os marcadores do agent-kit no arquivo, preservando o resto."""
    arquivo.parent.mkdir(parents=True, exist_ok=True)
    bloco = f"{BLOCK_START}\n<!-- gerado pelo install.py do agent-kit; edite em agent-kit/rules -->\n{texto.strip()}\n{BLOCK_END}"
    atual = arquivo.read_text(encoding="utf-8") if arquivo.exists() else ""
    if BLOCK_START in atual:
        atual = re.sub(re.escape(BLOCK_START) + r".*?" + re.escape(BLOCK_END), lambda m: bloco, atual, flags=re.S)
    else:
        atual = (atual.rstrip() + "\n\n" if atual.strip() else "") + bloco + "\n"
    arquivo.write_text(atual, encoding="utf-8")


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


# ---------------------------------------------------------------- acesso ao orquestrador (kit público)

KIT_PUBLICO = True   # o montar_kit_publico.py troca para True: atalho, favorito e aviso só no kit público
PAINEL_URL = "http://127.0.0.1:8790"
PAINEL_NOME = "Orquestrador de IA (Delegar)"


def pasta_shell(nome: str, padrao: Path) -> Path:
    """Pasta especial do Windows (Desktop, Startup...), respeitando redirecionamento do OneDrive."""
    if WINDOWS:
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                                r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders") as k:
                return Path(os.path.expandvars(winreg.QueryValueEx(k, nome)[0]))
        except OSError:
            pass
    return padrao


def criar_lancador() -> Path:
    """Script que sobe o painel (se não estiver no ar) e abre o navegador nele."""
    cli = HOME / ".claude" / "skills" / "delegar" / "app" / "cli.mjs"
    node = achar("node") or "node"
    lanc = HOME / ".delegar" / "abrir-painel.cmd"
    lanc.write_text(f'@echo off\r\n"{node}" "{cli}" iniciar >nul 2>&1\r\nif not "%1"=="--sem-navegador" start "" {PAINEL_URL}\r\n', encoding="utf-8")
    return lanc


def atalho_windows(lnk: Path, alvo: Path, args: str = "", descricao: str = ""):
    """Cria um .lnk que roda o lançador sem janela de console."""
    ps = ("$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:AK_LNK);"
          "$s.TargetPath=$env:ComSpec; $s.Arguments='/c \"\"'+$env:AK_ALVO+'\" '+$env:AK_ARGS+'\"';"
          "$s.WindowStyle=7; $s.IconLocation=\"$env:SystemRoot\\System32\\imageres.dll,109\";"
          "$s.Description=$env:AK_DESC; $s.WorkingDirectory=$env:USERPROFILE; $s.Save()")
    env = dict(os.environ, AK_LNK=str(lnk), AK_ALVO=str(alvo), AK_ARGS=args, AK_DESC=descricao)
    lnk.parent.mkdir(parents=True, exist_ok=True)
    r = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], env=env,
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r.returncode == 0 and lnk.exists()


def chrome_aberto() -> bool:
    r = subprocess.run(["tasklist", "/FI", "IMAGENAME eq chrome.exe", "/NH"], capture_output=True, text=True, errors="replace")
    return "chrome.exe" in r.stdout.lower()


def favorito_chrome(user_data: Path) -> list:
    """Põe o painel na barra de favoritos de cada perfil do Chrome. Devolve os perfis alterados."""
    feitos = []
    if not user_data.is_dir():
        return feitos
    for arq in sorted(user_data.glob("*/Bookmarks")):
        try:
            dados = json.loads(arq.read_text(encoding="utf-8"))
            barra = dados["roots"]["bookmark_bar"]
        except (OSError, ValueError, KeyError):
            continue
        texto = json.dumps(dados)
        if PAINEL_URL in texto:
            continue  # já tem
        ids = [int(x) for x in re.findall(r'"id":\s*"(\d+)"', texto)] or [0]
        import uuid
        from datetime import timezone
        agora = str(int((datetime.now(timezone.utc).replace(tzinfo=None) - datetime(1601, 1, 1)).total_seconds() * 1_000_000))
        barra.setdefault("children", []).insert(0, {"date_added": agora, "date_last_used": "0", "guid": str(uuid.uuid4()),
                                                    "id": str(max(ids) + 1), "name": PAINEL_NOME, "type": "url", "url": PAINEL_URL})
        dados.pop("checksum", None)  # o Chrome recalcula
        shutil.copy2(arq, arq.with_name("Bookmarks.bak-agent-kit"))
        arq.write_text(json.dumps(dados, indent=3, ensure_ascii=False), encoding="utf-8")
        feitos.append(arq.parent.name)
    return feitos


PACOTES_AUTOMACAO = ["undetected-chromedriver", "selenium", "setuptools", "mcp"]  # setuptools: distutils no 3.12+; mcp: servidor do cofre


def chrome_instalado() -> bool:
    if not WINDOWS:
        return bool(shutil.which("google-chrome") or shutil.which("chrome"))
    import winreg
    for raiz in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        try:
            with winreg.OpenKey(raiz, r"Software\Google\Chrome\BLBeacon"):
                return True
        except OSError:
            pass
    locais = [Path(os.environ.get(v, "")) / "Google" / "Chrome" / "Application" / "chrome.exe"
              for v in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA")]
    return any(p.exists() for p in locais)


def garantir_automacao(args):
    """undetected-chromedriver sempre instalado (padrão das automações do kit) e Chrome presente."""
    if args.verificar or args.minimo:
        return
    py = sys.executable
    teste = subprocess.run([py, "-c", "import undetected_chromedriver, selenium, mcp"], capture_output=True, text=True)
    if teste.returncode != 0:
        info("Instalando undetected-chromedriver e selenium (automação web)")
        r = subprocess.run([py, "-m", "pip", "install", "-U", *PACOTES_AUTOMACAO], capture_output=True, text=True,
                           encoding="utf-8", errors="replace")
        ok = subprocess.run([py, "-c", "import undetected_chromedriver"], capture_output=True).returncode == 0
        print("    ok" if ok else "    [AVISO] não instalou: " + (r.stderr or r.stdout)[-400:].strip()
              + f"\n    Rode: \"{py}\" -m pip install -U {' '.join(PACOTES_AUTOMACAO)}")
    if not chrome_instalado():
        if WINDOWS and shutil.which("winget") and not args.silencioso:
            info("Instalando o Google Chrome (as automações usam o Chrome com undetected-chromedriver)")
            subprocess.run(["winget", "install", "-e", "--id", "Google.Chrome", "--accept-source-agreements",
                            "--accept-package-agreements", "--silent"], check=False)
        else:
            print("    [AVISO] Google Chrome não encontrado; as automações web precisam dele (https://www.google.com/chrome).")


def _json_config(arq: Path, nome: str, entrada: dict, chave="mcpServers"):
    """Grava/atualiza um servidor MCP num arquivo JSON de configuração, preservando o resto (backup antes)."""
    dados = {}
    if arq.exists():
        try:
            dados = json.loads(_sem_comentarios(arq.read_text(encoding="utf-8")) or "{}")
        except ValueError:
            return f"{arq.name}: JSON inválido, não alterado"
        if dados.get(chave, {}).get(nome) == entrada:
            return None
        shutil.copy2(arq, arq.with_name(arq.name + ".bak-agent-kit"))
    dados.setdefault(chave, {})[nome] = entrada
    arq.parent.mkdir(parents=True, exist_ok=True)
    arq.write_text(json.dumps(dados, indent=2, ensure_ascii=False), encoding="utf-8")
    return str(arq)


def registrar_mcp_cofre(kit: Path, vault: Path):
    """Servidor MCP do cofre (mcp/mcp_vault.py: list_notes, search_notes, read_note, write_note) em todas as IAs."""
    servidor = kit / "mcp" / "mcp_vault.py"
    if not servidor.exists():
        return
    py, srv, env = Path(sys.executable).as_posix(), servidor.as_posix(), {"VAULT_PATH": str(vault)}
    feitos = []
    claude = achar("claude")
    if claude:
        atual = subprocess.run(["cmd", "/d", "/c", "claude", "mcp", "get", "vault"] if WINDOWS else [claude, "mcp", "get", "vault"],
                               capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
        if srv not in atual.stdout or py not in atual.stdout.replace("\\", "/"):
            base = ["cmd", "/d", "/c", "claude"] if WINDOWS else [claude]
            subprocess.run(base + ["mcp", "remove", "vault", "-s", "user"], capture_output=True, timeout=120)
            r = subprocess.run(base + ["mcp", "add", "-s", "user", "vault", "-e", f"VAULT_PATH={vault}", "--", py, srv],
                               capture_output=True, text=True, timeout=120)
            feitos.append("Claude Code" if r.returncode == 0 else "Claude Code (falhou: rode `claude mcp add`)")
        else:
            feitos.append("Claude Code (já estava)")
    oc = OPENCODE_DIR / "opencode.jsonc"
    r = _json_config(oc, "vault", {"type": "local", "command": [py, srv], "environment": env, "enabled": True}, chave="mcp")
    feitos.append("opencode" + ("" if r else " (já estava)"))
    entrada = {"command": py, "args": [srv], "env": env}
    alvos = [("Antigravity", HOME / ".gemini" / "config" / "mcp_config.json", True),
             ("Gemini CLI", HOME / ".gemini" / "settings.json", True),
             ("Qwen Code", HOME / ".qwen" / "settings.json", (HOME / ".qwen").is_dir()),
             ("Windsurf", HOME / ".codeium" / "windsurf" / "mcp_config.json", (HOME / ".codeium" / "windsurf").is_dir())]
    for nome, arq, usar in alvos:
        if usar:
            r = _json_config(arq, "vault", entrada)
            feitos.append(nome + ("" if r and not r.startswith(arq.name) else " (já estava)" if r is None else f" ({r})"))
    print("    Servidor MCP do cofre (vault) registrado: " + ", ".join(feitos))


def proteger_git(kit: Path, repos):
    """Hook pre-commit contra arquivos apagados pelo antivírus (scripts/git_protecao.py) nos repositórios."""
    script = kit / "scripts" / "git_protecao.py"
    if not script.exists():
        return 0
    n = 0
    for r in repos:
        if (Path(r) / ".git").exists():
            subprocess.run([sys.executable, str(script), "instalar", str(r)], capture_output=True)
            n += 1
    return n


def abrir_painel(lanc: Path):
    """Sobe o painel e abre o navegador nele, sem prender o instalador."""
    subprocess.Popen(["cmd", "/c", str(lanc)], creationflags=0x08000000)


def acesso_orquestrador():
    """Atalho na área de trabalho, início com o Windows, favorito no Chrome e aviso de uso."""
    if not WINDOWS:
        return
    info("Acesso ao orquestrador")
    lanc = criar_lancador()
    desktop = pasta_shell("Desktop", HOME / "Desktop")
    if atalho_windows(desktop / f"{PAINEL_NOME}.lnk", lanc, "", "Abre o painel do orquestrador de agentes de IA"):
        print(f"    Atalho criado na área de trabalho: {PAINEL_NOME}")
    startup = pasta_shell("Startup", Path(os.environ.get("APPDATA", "")) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup")
    if atalho_windows(startup / "Delegar - painel.lnk", lanc, "--sem-navegador", "Sobe o painel do orquestrador ao entrar no Windows"):
        print("    O painel passa a subir sozinho ao entrar no Windows (atalho na pasta Inicializar), para o favorito funcionar.")
    user_data = Path(os.environ.get("LOCALAPPDATA", "")) / "Google" / "Chrome" / "User Data"
    if user_data.is_dir():
        if chrome_aberto():
            print("    Chrome aberto: o favorito não foi adicionado (o Chrome sobrescreveria). Feche o Chrome e rode"
                  " `python install.py --atalhos`, ou adicione à mão: " + PAINEL_URL)
        else:
            perfis = favorito_chrome(user_data)
            if perfis:
                print(f"    Favorito \"{PAINEL_NOME}\" na barra do Chrome (perfis: {', '.join(perfis)}).")
    abrir_painel(lanc)
    print(f"""
  ┌─────────────────────────────────────────────────────────────────────────┐
  │ ORQUESTRADOR DE IA (DELEGAR)                                            │
  └─────────────────────────────────────────────────────────────────────────┘
  O que é: um painel em {PAINEL_URL} onde um modelo forte planeja um trabalho
  grande e vários modelos executam em paralelo, trocando sozinhos de modelo
  quando a cota acaba (e usando modelos gratuitos se tudo acabar).

  Como abrir: atalho "{PAINEL_NOME}" na área de trabalho, o favorito
  no Chrome, ou peça ao Claude/Gemini/opencode: "delegar: <o que você quer>".

  Como usar:
    1. Novo projeto: escolha a pasta do projeto e descreva o trabalho.
    2. Modo: Padrão (econômico), Equilibrado, Agressivo, Desespero (só
       gratuitos) ou Personalizado (você escolhe os modelos de cada papel).
    3. Acompanhamento: Automático, Acompanhado (para e pergunta nos momentos
       importantes) ou Passo a passo.
    4. Converse com o planejador, confira o plano e clique em Aprovar.
    5. Botão Atividade: quem está fazendo o quê, agora.
  Antes: entre uma vez em cada CLI (rode `claude` e `agy`; o opencode usa os
  gratuitos sem conta). Guia completo no cofre:
  guias_e_comandos/skill_delegar_orquestracao.md
""")


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
        "playwright": "Playwright", "selenium": "Selenium", "undetected-chromedriver": "undetected-chromedriver", "pandas": "pandas", "electron": "Electron", "streamlit": "Streamlit"}


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
    return {"stack": stack, "libs": libs, "git": g, "resumo": resumo, "automacao": automacao_do_projeto(d)}


# Só import de verdade (não basta a palavra aparecer num texto).
AUTO_RE = re.compile(r"^\s*(?:import|from)\s+(undetected_chromedriver|selenium|playwright|pyautogui|seleniumbase)\b"
                     r"|(?:require\(|from\s+)['\"](puppeteer|playwright|selenium-webdriver)['\"]", re.M)
CONFIG_RE = re.compile(r"(config|settings|constantes?|urls?)\.(py|js|ts|json|toml|ya?ml)$|^\.env\.example$", re.I)
URL_RE = re.compile(r"https?://([a-z0-9][a-z0-9.-]*\.[a-z]{2,})", re.I)
DOMINIOS_IGNORADOS = re.compile(r"(^|\.)(googleapis\.com|gstatic\.com|jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|w3\.org|omg\.org|"
                                r"github\.com|githubusercontent\.com|pypi\.org|python\.org|npmjs\.(com|org)|example\.(com|org)|"
                                r"schemas\.|bpmn\.io|mozilla\.org|microsoft\.com|chromium\.org|googlechromelabs|stackoverflow\.com|"
                                r"localhost|readthedocs)|\.(test|local|example|invalid|localhost)$", re.I)


def automacao_do_projeto(d: Path, limite=400):
    """Se o código usa automação de navegador: ferramentas e domínios citados nos arquivos que automatizam."""
    ferramentas, dominios, arquivos, configs = set(), {}, [], []
    vistos = 0
    if (d / "install.py").exists() and (d / "skills").is_dir():
        return None  # o próprio agent-kit
    for f in d.rglob("*"):
        if any(p in PULAR or p.startswith(".") for p in f.relative_to(d).parts[:-1]):
            continue
        if CONFIG_RE.search(f.name) and f.is_file():
            configs.append(f)
        if f.suffix.lower() not in {".py", ".js", ".ts", ".mjs"} or not f.is_file():
            continue
        vistos += 1
        if vistos > limite:
            break
        try:
            txt = f.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        achou = {(m.group(1) or m.group(2)).lower() for m in AUTO_RE.finditer(txt)}
        if not achou:
            continue
        ferramentas |= {"undetected-chromedriver" if "undetected" in a else "Selenium" if "selenium" in a
                        else "Playwright" if "playwright" in a else "pyautogui" if "pyautogui" in a else "Puppeteer" for a in achou}
        arquivos.append(f.relative_to(d).as_posix())
        for dom in URL_RE.findall(txt):
            dom = dom.lower().rstrip(".")
            if not DOMINIOS_IGNORADOS.search(dom):
                dominios[dom] = dominios.get(dom, 0) + 1
    if not ferramentas:
        return None
    for f in configs[:20]:  # URL base costuma ficar na configuração
        try:
            for dom in URL_RE.findall(f.read_text(encoding="utf-8", errors="ignore")):
                dom = dom.lower().rstrip(".")
                if not DOMINIOS_IGNORADOS.search(dom):
                    dominios[dom] = dominios.get(dom, 0) + 1
        except OSError:
            pass
    return {"ferramentas": sorted(ferramentas), "dominios": [k for k, _ in sorted(dominios.items(), key=lambda x: -x[1])[:8]],
            "arquivos": arquivos[:10]}


def esboco_mapa_site(vault: Path, dominio: str, projeto: Path, arquivos: list) -> bool:
    """Cria automacoes/sites/<dominio>.md a partir do modelo (se ainda não existir) e põe no índice de sites."""
    pasta = vault / "automacoes" / "sites"
    nota = pasta / f"{dominio}.md"
    criada = False
    if not nota.exists():
        pasta.mkdir(parents=True, exist_ok=True)
        modelo = pasta / "_modelo_site.md"
        base = modelo.read_text(encoding="utf-8") if modelo.exists() else "# 🗺️ <dominio>\n"
        base = base.replace("<dominio>", dominio).replace("AAAA-MM-DD", datetime.now().strftime("%Y-%m-%d"))
        pend = (f"\n> **Pendente (gerado pelo instalador):** transcrever para este mapa os passos que o projeto `{projeto}` já executa"
                f" neste site. Arquivos com automação: {', '.join('`' + a + '`' for a in arquivos[:6])}.\n")
        base = base.replace("\n## Entrada", pend + "\n## Entrada", 1)
        nota.write_text(base, encoding="utf-8")
        criada = True
    indice = vault / "automacoes" / "00_MAPA_DE_SITES.md"
    if not indice.exists():
        indice.parent.mkdir(parents=True, exist_ok=True)
        indice.write_text("# 🕹️ Mapa de sites automatizados\n\nRegras: [[guias_e_comandos/automacao_web]].\n\n"
                          "| Site | Mapa | Login | Fluxos mapeados | Projetos |\n|---|---|---|---|---|\n", encoding="utf-8")
    s = indice.read_text(encoding="utf-8")
    if f"[[automacoes/sites/{dominio}]]" not in s:
        linha = f"| {dominio} | [[automacoes/sites/{dominio}]] | a mapear | a mapear (esboço) | {projeto.name} |"
        partes = s.split("\n<!--", 1)
        s = partes[0].rstrip("\n") + "\n" + linha + "\n" + ("\n<!--" + partes[1] if len(partes) > 1 else "")
        indice.write_text(s, encoding="utf-8")
    return criada


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
    projetos_auto, sites_novos = 0, 0
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
        auto = dsc.get("automacao")
        linha_auto = []
        if auto:
            projetos_auto += 1
            for dom in auto["dominios"]:
                sites_novos += esboco_mapa_site(vault, dom, p, auto["arquivos"])
            sites = ", ".join(f"[[automacoes/sites/{d}]]" for d in auto["dominios"]) or "nenhum domínio no código"
            linha_auto = [f"- **Automação web:** {', '.join(auto['ferramentas'])}; sites: {sites}. "
                          f"Antes de mexer, siga [[guias_e_comandos/automacao_web]] e mantenha o mapa de cada site atualizado."]
        bloco = "\n".join([ini,
            f"- **Caminho:** `{p}`",
            f"- **Tecnologias:** {', '.join(tecs) or 'não identificadas'}",
            f"- **Notas do cofre que citam esta pasta:** {', '.join(f'[[{r}]]' for r in relacionadas) or 'nenhuma'}",
            (f"- **Git:** {g.get('remoto') or 'sem remoto'} · branch `{g.get('branch', '-')}` · último commit: {g.get('ultimo') or '-'}"
             + (f" · {g['pendentes']} arquivos alterados sem commit" if g.get("pendentes") else "")) if g else "- **Git:** não é repositório git",
            f"- **Descrição (README):** {dsc['resumo'] or 'sem README'}",
            *linha_auto,
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
    protegidos = proteger_git(kit, projetos)
    if protegidos:
        print(f"    Proteção do git (arquivo apagado pelo antivírus não sai do repositório) instalada em {protegidos} repositórios.")
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
                   + (f"- **Automação:** {projetos_auto} projetos com automação web; {sites_novos} esboços de mapa de site criados em `automacoes/sites/` ([[automacoes/00_MAPA_DE_SITES]]).\n" if projetos_auto else "")
                   + f"- **Pendências:** completar objetivo e decisões nas notas novas" + ("; transcrever os passos das automações para os mapas de site" if sites_novos else "") + ".\n\n")
        cab = f"## 📅 {hoje}"
        if cab in s:
            i = s.index(cab) + len(cab)
            s = s[:i] + "\n\n" + entrada + s[i:].lstrip("\n")
        else:
            sep = s.find("\n---\n")
            s = (s[:sep + 5] + f"\n{cab}\n\n{entrada}" + s[sep + 5:].lstrip()) if sep >= 0 else f"{cab}\n\n{entrada}{s}"
        log.write_text(s, encoding="utf-8")
    info(f"Mapa de projetos: {len(linhas_mapa)} projetos ({novos} notas novas, {atualizados} atualizadas) em {pasta}"
         + (f"; {projetos_auto} com automação web, {sites_novos} mapas de site novos" if projetos_auto else ""))
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
    ap.add_argument("--minimo", action="store_true")
    ap.add_argument("--atalhos", action="store_true", help="cria atalho, favorito no Chrome e início automático do painel")
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
    garantir_automacao(args)
    proteger_git(kit, [kit])
    registrar_mcp_cofre(kit, vault)

    if args.mapear or (not args.nao_mapear and not args.silencioso and perguntar(
            "Mapear os projetos deste PC (pastas com .git ou arquivos de projeto em Documentos, Desktop, source, repos...)"
            " e criar uma nota para cada um no cofre?", False)):
        mapear_projetos(vault, kit)

    if args.atalhos or (KIT_PUBLICO and not args.silencioso):
        acesso_orquestrador()

    print(f"\nPronto. Cofre em {vault}")
    print("Orquestrador: diga ao Claude/Gemini \"delegar <pedido>\" ou rode "
          f"`node \"{HOME / '.claude' / 'skills' / 'delegar' / 'app' / 'cli.mjs'}\" iniciar` e abra http://127.0.0.1:8790")


if __name__ == "__main__":
    main()
