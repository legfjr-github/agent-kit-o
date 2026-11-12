#!/usr/bin/env python3
"""Sincroniza o agent-kit com o GitHub.

    python sync.py pull              # traz mudanças e reinstala skills/regras
    python sync.py push "mensagem"   # commita cofre/skills, envia e reinstala
"""
import subprocess
import sys
from pathlib import Path

KIT = Path(__file__).resolve().parent


def git(*args, check=True):
    return subprocess.run(["git", "-C", str(KIT), *args], check=check, text=True)


def reinstall():
    subprocess.run([sys.executable, str(KIT / "install.py"), "--dir", str(KIT), "--silencioso"], check=True)


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in {"pull", "push"}:
        sys.exit(__doc__)
    if sys.argv[1] == "push":
        msg = sys.argv[2] if len(sys.argv) > 2 else "Atualiza cofre de conhecimento"
        # hook pre-commit + reparo: arquivo apagado pelo antivírus não sai do git
        subprocess.run([sys.executable, str(KIT / "scripts" / "git_protecao.py"), "instalar", str(KIT)], check=False)
        git("add", "-A")
        if subprocess.run(["git", "-C", str(KIT), "diff", "--cached", "--quiet"]).returncode:
            git("commit", "-m", msg)
        git("pull", "--rebase", "--autostash")
        git("push")
    reinstall()  # install.py já faz o pull


if __name__ == "__main__":
    main()
