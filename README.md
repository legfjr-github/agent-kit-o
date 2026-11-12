# agent-kit-o

Kit para trabalhar com agentes de IA (Claude Code, Antigravity/Gemini, opencode, Gemini CLI) no Windows, com:

- **Cofre de conhecimento** (Markdown, compatível com Obsidian) que todos os agentes leem e atualizam: índice, log diário, próximos passos e notas por projeto.
- **Orquestrador `delegar`**: um modelo forte planeja, modelos mais baratos executam em paralelo, com troca automática quando a cota acaba, modo com modelos gratuitos, paradas para confirmação e tela de atividade. Ajusta-se às CLIs instaladas no PC.
- **Skills**: `delegar` (orquestrador), `knowledge-vault-manager` (cofre), `humanizer` (escrita sem cara de IA) e `sistemas-com-ia` (criar sistemas que usam IA pela API ou pelas CLIs locais).
- **Regras globais** para todas as IAs: como usar o kit, consulta e atualização do cofre, segurança por padrão, redação humana.
- **Cofre de exemplo** com padrões prontos: checklist de segurança e testes de ataque, padrões de testes, sistemas com integração de IA, executáveis com Nuitka, interfaces com PyQt6, uso do orquestrador.

Nenhum dado pessoal ou projeto vem junto: o cofre começa vazio, só com os guias.

## Instalar (Windows)

No PowerShell, sem administrador:

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
iwr https://raw.githubusercontent.com/legfjr-github/agent-kit-o/main/instalar.ps1 -OutFile instalar.ps1
.\instalar.ps1 -Repo https://github.com/legfjr-github/agent-kit-o.git
```

O instalador:
1. Usa o Python, Git e Node que já existirem. O que faltar baixa em versão portátil (zip oficial) para `%USERPROFILE%\agent-kit-tools`, confere a assinatura digital e o SHA-256 e põe no PATH do usuário.
2. Instala Claude Code, opencode e Gemini CLI pelo npm (instalação completa; `install.py --minimo` pula). O Antigravity (que traz a CLI `agy`) é instalado à parte, em https://antigravity.google.
3. Clona o kit em `%USERPROFILE%\agent-kit` e põe skills e regras em **todas as IAs do PC**: Claude Code, Antigravity, Gemini CLI, opencode e a pasta comum `~/.agents`, e também Codex, Qwen Code, Windsurf e Cursor quando estiverem instalados, trocando os caminhos pelos desta máquina.
4. Corrige servidores MCP do opencode que apontem para executáveis inexistentes.
5. Pergunta se deve **mapear os projetos do PC** e criar uma nota para cada um no cofre.
6. Dá acesso fácil ao orquestrador: atalho **"Orquestrador de IA (Delegar)"** na área de trabalho, favorito com o mesmo nome na barra do Chrome (todos os perfis; se o Chrome estiver aberto, avisa para fechar e rodar `python install.py --atalhos`) e início automático do painel com o Windows (pasta Inicializar), para o favorito sempre funcionar. No fim, abre o painel e mostra um resumo de como usar.

Depois: faça login em cada CLI uma vez (`claude`, `agy`; o opencode usa os modelos gratuitos sem conta).

Só diagnóstico, sem mudar nada: `python %USERPROFILE%\agent-kit\install.py --verificar`.

## Usar

- A regra `uso-do-kit` já diz a cada IA quando ler o cofre e qual skill usar. Peça normalmente; para forçar: "consulte o cofre", "registre no log", "delegar: <pedido grande>", "crie um sistema que usa IA para ...".
- Comece cada projeto com uma nota no cofre (copie `vault/projetos/exemplo_projeto.md`): as IAs passam a ter contexto sem você repetir.
- Painel do orquestrador: `node %USERPROFILE%\.claude\skills\delegar\app\cli.mjs iniciar` e abra http://127.0.0.1:8790.
- Atualizar o kit: `python %USERPROFILE%\agent-kit\sync.py pull`.
- Guardar seu cofre num repositório seu (privado): crie o repositório, troque o `origin` (`git remote set-url origin <seu repo>`) e use `python sync.py push "mensagem"`.

## Estrutura

```
instalar.ps1   instalação no Windows (ferramentas portáteis + install.py)
install.py     skills, regras, caminhos, MCP, mapa de projetos (--verificar, --mapear)
sync.py        pull / push
rules/         regras globais (vão para Claude Code, opencode e Gemini)
skills/        skills; skills/delegar é o orquestrador
vault/         cofre de exemplo (00_INDICE.md é a porta de entrada)
```

## O orquestrador se adapta ao PC

| CLIs instaladas | Quem planeja | Quem executa |
|---|---|---|
| Claude + agy + opencode | Claude Opus | conforme o modo (Gemini, Sonnet, Haiku, gratuitos) |
| só agy (+ opencode) | Gemini 4 Argon | Gemini Flash; gratuitos de reserva |
| só Claude | Claude Opus | Sonnet, Haiku |
| só opencode | GLM 5.3 gratuito | modelos gratuitos, do melhor para o pior |

Detalhes em `skills/delegar/SKILL.md` e `vault/guias_e_comandos/skill_delegar_orquestracao.md`.
