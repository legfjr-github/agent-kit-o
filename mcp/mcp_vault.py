"""Servidor MCP do cofre de conhecimento (stdio).

Ferramentas: list_notes, search_notes, read_note, write_note. Tudo fica preso à pasta do cofre
(VAULT_PATH, padrão ~/Documents/agent-kit/vault); caminhos com '..' ou absolutos são recusados.
Registro: o install.py do agent-kit registra este servidor no Claude Code, opencode, Antigravity,
Gemini CLI (e Qwen/Windsurf, se houver). À mão: claude mcp add -s user vault -- <python> <este arquivo>
Requer: pip install mcp (o instalador já instala)
"""
import os
from pathlib import Path

from mcp.server.fastmcp import FastMCP

VAULT = Path(os.environ.get("VAULT_PATH") or Path.home() / "Documents" / "agent-kit" / "vault").resolve()
mcp = FastMCP("vault")


def _caminho(nota: str) -> Path:
    """Converte 'pasta/nota' ou 'pasta/nota.md' num arquivo dentro do cofre; recusa sair dele."""
    nota = nota.strip().replace("\\", "/").removeprefix("[[").removesuffix("]]")
    if not nota.endswith(".md"):
        nota += ".md"
    alvo = (VAULT / nota).resolve()
    if VAULT not in alvo.parents:
        raise ValueError("caminho fora do cofre")
    return alvo


def _rel(p: Path) -> str:
    return p.relative_to(VAULT).with_suffix("").as_posix()


@mcp.tool()
def list_notes(pasta: str = "") -> list[str]:
    """Lista as notas do cofre (sem .md), opcionalmente só de uma pasta (ex.: 'projetos')."""
    base = (VAULT / pasta).resolve() if pasta else VAULT
    if base != VAULT and VAULT not in base.parents:
        raise ValueError("pasta fora do cofre")
    return sorted(_rel(p) for p in base.rglob("*.md") if ".obsidian" not in p.parts)


@mcp.tool()
def search_notes(termo: str, limite: int = 20) -> list[dict]:
    """Procura um termo (sem diferenciar maiúsculas) no nome e no texto das notas; devolve trechos."""
    termo_l = termo.lower()
    achados = []
    for p in VAULT.rglob("*.md"):
        if ".obsidian" in p.parts:
            continue
        try:
            texto = p.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        i = texto.lower().find(termo_l)
        if i >= 0 or termo_l in p.stem.lower():
            ini = max(0, i - 120) if i >= 0 else 0
            achados.append({"nota": _rel(p), "trecho": texto[ini:ini + 300].replace("\n", " ")})
            if len(achados) >= max(1, min(limite, 100)):
                break
    return achados


@mcp.tool()
def read_note(nota: str) -> str:
    """Lê uma nota pelo caminho no cofre (ex.: '00_INDICE' ou 'projetos/exemplo_projeto')."""
    alvo = _caminho(nota)
    if not alvo.exists():
        raise FileNotFoundError(f"nota não encontrada: {nota}")
    return alvo.read_text(encoding="utf-8")


@mcp.tool()
def write_note(nota: str, conteudo: str, modo: str = "substituir") -> str:
    """Grava uma nota. modo='substituir' (padrão) ou 'acrescentar' (adiciona ao fim). Cria as pastas que faltarem."""
    if modo not in {"substituir", "acrescentar"}:
        raise ValueError("modo deve ser 'substituir' ou 'acrescentar'")
    if len(conteudo) > 500_000:
        raise ValueError("conteúdo grande demais")
    alvo = _caminho(nota)
    alvo.parent.mkdir(parents=True, exist_ok=True)
    if modo == "acrescentar" and alvo.exists():
        conteudo = alvo.read_text(encoding="utf-8").rstrip("\n") + "\n\n" + conteudo
    alvo.write_text(conteudo, encoding="utf-8")
    return f"gravado: {_rel(alvo)}"


if __name__ == "__main__":
    mcp.run()
