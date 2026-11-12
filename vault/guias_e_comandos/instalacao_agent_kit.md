---
titulo: Instalação do agent-kit (instalar.ps1 + install.py)
categoria: guias_e_comandos
tags: [instalacao, windows, path, portatil, claude, antigravity, opencode]
atualizado: 2026-11-12
resumo: O que o instalador faz, opções e como diagnosticar.
---

# ⚙️ Instalação do agent-kit

## Comandos
```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
.\instalar.ps1 -Repo https://github.com/<usuario>/<repo>.git   # clona em ~\agent-kit e instala
.\instalar.ps1 -SoFerramentas                                 # só Python/Git/Node portáteis
python install.py --verificar                                 # diagnóstico, não muda nada
python install.py --mapear                                    # mapeia os projetos do PC sem perguntar
python sync.py pull                                           # atualiza (roda install.py --silencioso)
```

## instalar.ps1
1. Python 3.10+, Git e Node: usa o que existir; o que faltar baixa em versão portátil para `%USERPROFILE%\agent-kit-tools`, sem administrador:
   - Python embeddable 3.13 (python.org), com assinatura digital do `python.exe` conferida.
   - MinGit (Git for Windows), com SHA-256 publicado pelo GitHub e assinatura do `git.exe` conferidos.
   - Node LTS (nodejs.org), com SHA-256 do `SHASUMS256.txt` e assinatura do `node.exe` conferidos.
   Se a conferência falhar, o download é apagado e a instalação para.
2. PATH do usuário: essas pastas, `%APPDATA%\npm` (CLIs instaladas pelo npm) e `%USERPROFILE%\.gemini\bin` (agy).
3. Clona o kit (se preciso) e roda `install.py`.

## install.py
1. Mostra quais ferramentas existem e quem vai planejar no orquestrador.
2. Instala Claude Code, opencode e Gemini CLI pelo npm sem perguntar (`--minimo` pula). O Antigravity não tem versão portátil: instale o Antigravity IDE e rode `agy` uma vez.
3. Copia as skills para todas as IAs do PC (Claude Code `~/.claude/skills`; Antigravity `~/.gemini/config/skills`; Gemini CLI `~/.gemini/skills`; opencode `~/.config/opencode/skills`; pasta comum `~/.agents/skills`; e, se instalados, Codex `~/.codex/skills`, Qwen `~/.qwen/skills`, Windsurf `~/.codeium/windsurf/skills`, Cursor `~/.cursor/skills`). Regras: imports no `CLAUDE.md`, `instructions` do opencode e um bloco em `GEMINI.md`, `AGENTS.md` (Codex), `QWEN.md` e `global_rules.md` (Windsurf, versão curta), trocando `{{VAULT_PATH}}`, `{{KIT_PATH}}`, `{{HOME}}`, `{{DOCS_PATH}}` pelos caminhos desta máquina.
4. Corrige servidores MCP do `opencode.jsonc` cujo executável não existe (backup em `.bak-agent-kit`) e avisa quando o script do servidor sumiu.
5. Acesso ao orquestrador: cria `~/.delegar/abrir-painel.cmd`, o atalho "Orquestrador de IA (Delegar)" na área de trabalho, um atalho na pasta Inicializar (sobe o painel ao entrar no Windows, sem abrir o navegador) e o favorito na barra do Chrome em cada perfil (backup `Bookmarks.bak-agent-kit`; com o Chrome aberto não mexe e avisa). Depois abre o painel e mostra como usar. Para refazer: `python install.py --atalhos`. Para tirar: apague os dois atalhos e o favorito.
6. Pergunta se deve mapear os projetos do PC: pastas com `.git` ou arquivos de projeto em Documentos, Desktop, source, repos, projects, dev, code. Cria `projetos/mapa_pc/<nome>.md` (caminho, tecnologias, remoto sem credenciais, branch, último commit, trecho do README, notas que já citam a pasta) e `projetos/00_mapa_de_projetos.md`, com link no índice e entrada no log. Não lê `.env`; notas escritas à mão não são alteradas.

## Problemas comuns
| Sintoma | Solução |
|---|---|
| `não é reconhecido como comando` logo após instalar | abra um terminal novo (o PATH muda só para os próximos) |
| Painel do delegar não planeja | `python install.py --verificar`: precisa de ao menos uma CLI (claude, agy ou opencode) com login feito |
| Erro de assinatura no instalar.ps1 | rede ou proxy alterando o download; tente de outra rede. Não desative a conferência |
| Skill não aparece no agente | rode `python install.py` de novo e reinicie o agente |
