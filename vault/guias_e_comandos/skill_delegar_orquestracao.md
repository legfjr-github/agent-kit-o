---
titulo: Orquestrador delegar (planejar com um modelo, executar com vários)
categoria: guias_e_comandos
tags: [ia, orquestracao, claude, gemini, opencode, agentes]
atualizado: 2026-11-12
resumo: Como usar a skill delegar - painel, CLI, modos de modelos, modo desespero com gratuitos, acompanhamento com paradas e tela de atividade.
---

# 🤖 Orquestrador `delegar`

Fonte: `skills/delegar/` do kit; instalado em `~/.claude/skills/delegar`. Instruções completas para o agente em `SKILL.md`.

## Como usar
- Diga ao agente: "delegar: <pedido grande>" (ou "orquestra", "manda pro Gemini", "economiza minha cota").
- Ou abra o painel: `node %USERPROFILE%\.claude\skills\delegar\app\cli.mjs iniciar` → http://127.0.0.1:8790.
- Fluxo: novo projeto (pasta + pedido) → conversa com o planejador → plano em tabela (tarefas, nível, modelos, dependências) → Aprovar → execução em segundo plano, que continua mesmo se a sessão do agente fechar.
- "Confiar no orquestrador" (`--auto`): planeja sem perguntar e já executa.

## Papéis e tipos de tarefa
- **Planejador:** lê o repositório e o cofre, divide o trabalho e escreve um prompt autossuficiente por tarefa. Não edita nada.
- **Escritor:** roda numa worktree git isolada, em paralelo com outros escritores; só cria/edita arquivos dele.
- **Integrador / tarefa:** roda no repositório, um por vez; junta o trabalho, valida, faz commit, push, deploy e atualiza o cofre.
- Níveis: **pesado** (raciocínio, segurança), **volume** (muito conteúdo seguindo um padrão), **leve** (mecânico).

## Modos
| Modo | Para quê |
|---|---|
| Agressivo | só Claude, esforço alto; mais rápido e mais caro |
| Equilibrado | Sonnet no que pede cuidado, volume dividido entre Sonnet e Gemini |
| Padrão (econômico) | Gemini executa; tarefa simples vai primeiro para o melhor gratuito; Claude só de reserva |
| Desespero | tudo nos modelos gratuitos do opencode, do melhor para o pior |
| Personalizado | você escolhe a cadeia de cada papel; partindo do zero ou de um modo pronto (mudar qualquer modelo vira personalizado) |

O sistema tira das cadeias os modelos de CLIs que não estão instaladas e põe os dois melhores gratuitos no fim de cada cadeia. Quando nenhum provedor pago tem cota (Gemini estourado e Claude acima de 90% na janela de 5 h), o pipeline entra sozinho no modo desespero e volta quando a cota retorna.

## Acompanhamento
| Tipo | Para quando |
|---|---|
| Automático | nunca |
| Acompanhado | antes da primeira integração, de tarefas que o planejador marcou como importantes (deploy, migração, apagamento, segurança), de recuperar uma falha e de entrar no modo desespero |
| Passo a passo | antes de cada tarefa |
O painel mostra a pergunta com Confirmar/Recusar; o Windows também mostra um aviso. Pela CLI: `cli.mjs confirmar <id> <confirmação> sim|nao`.

## Atividade
Botão **Atividade** (todos os projetos) e bloco Atividade em cada projeto: tarefa rodando, modelo em uso, há quanto tempo, última ação do agente (arquivo editado, comando), últimas atualizações (início, troca de modelo, falha, fim) e últimos commits. CLI: `cli.mjs atividade`.

## Modelos gratuitos (teste de 12/11/2026)
Duas tarefas no opencode em modo agente: escrever 4 funções (20 testes ocultos) e corrigir defeitos num módulo existente rodando os testes (10 testes ocultos).

| Ordem | Modelo | Tarefa 1 | Tarefa 2 |
|---|---|---|---|
| 1 | `opencode/glm-5.3-flash-free` | 20/20 | 10/10 |
| 2 | `opencode/big-pickle` (o mais rápido) | 20/20 | 10/10 |
| 3 | `opencode/minimax-m3.1-flash-free` | erro de caminho | 10/10 |
| 4 | `opencode/iceman-free` | 20/20 | 10/10 |
| 5 | `opencode/beam-free` | 20/20 | 10/10 |
| 6 | `opencode/inkling-2-small-free` | 20/20 | 10/10 |
| 7 | `opencode/longcat-2.5-free` (lento) | 20/20 | 10/10 |
| 8 | `agy:gpt-oss-120b-medium` | não testado | não testado |
| 9 | `opencode/deepseek-v4.1-flash-free` | 20/20 | 9/10 |
| fora | `mimo-v2.6-flash` (muito lento), `nemotron-3.5-*` (gravaram fora da pasta), `flint-40b` (falhou) | | |

A lista de modelos gratuitos muda com o tempo: quando `opencode models` mostrar outros, refaça o teste e ajuste `DESESPERO` em `skills/delegar/app/modelos.mjs`.

## Cuidados
- Os agentes executam sem pedir confirmação (exceto as paradas do acompanhamento). Os prompts devem proibir mexer em segredos, outros repositórios e trabalho alheio.
- Prompts curtos, apontando para arquivos: o agy recebe o prompt como argumento (limite de ~30 mil caracteres no Windows).
- Dois agentes nunca escrevem no mesmo arquivo ao mesmo tempo: escrita em paralelo, integração em série.
