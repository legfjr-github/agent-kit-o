---
titulo: Orquestrador delegar (planejar com um modelo, executar com vários)
categoria: guias_e_comandos
tags: [ia, orquestracao, claude, gemini, opencode, agentes]
atualizado: 2026-11-17
resumo: Como usar a skill delegar: painel local, CLI, modos e perfis, velocidade e esforço, cotas reais do Antigravity, tokens e custos, rodadas, vigia de 20 min e paralelismo até 6.
---

# 🤖 Orquestrador `delegar`

Fonte: `skills/delegar/` do kit; instalado em `~/.claude/skills/delegar`. Instruções completas para o agente em `SKILL.md`.

## Como usar
- Diga ao agente: "delegar: <pedido grande>" (ou "orquestra", "manda pro Gemini", "economiza minha cota").
- Ou abra o painel: `node %USERPROFILE%\.claude\skills\delegar\app\cli.mjs iniciar` → http://127.0.0.1:8790.
- **Acesso exclusivo deste computador:** o painel escuta apenas em `127.0.0.1` (recusa subir se `DELEGAR_HOST`, `HOST` ou `--host` apontar para outro endereço) e `ehLoopback` recusa com HTTP 403 qualquer `remoteAddress` fora de `127.0.0.1`, `::1` e `::ffff:127.0.0.1` antes do token e do `Host`, inclusive em `/api/saude` e arquivos estáticos.
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

## Troca de modelo no meio da tarefa, retomada e resumo (12/11/2026)
- **Troca de modelo por cota no meio da tarefa:** `worker.ps1` lê a cota do Claude a cada 10 min enquanto um modelo Claude trabalha (parâmetros `-HandoffAt 0.85` e `-QuotaCheckMinutes 10`; `quota.ps1` guarda a última leitura em `~/.delegar/state/quota-last.json` e aceita `-MaxAgeMinutes`). Ao passar de 85% na janela de 5 h ou 95% na semana, encerra o Claude e passa a tarefa ao próximo modelo da cadeia que não seja Claude, com um resumo das últimas ações e a instrução de conferir `git status`/`diff` e continuar.
- **Retomada automática após queda:** se o processo do pipeline cair, o painel retoma sozinho até 3 vezes; a tarefa que estava no meio recebe aviso de tarefa retomada. Depois disso, botão Retomar ou `cli.mjs retomar <id>`.
- **Resumo da execução:** no fim, a conversa do projeto recebe a mensagem "Resumo da execução" (o que cada tarefa entregou, modelo usado, trocas de modelo, commits) e o relatório do cofre ganha a seção Resumo.
- **Instalação incremental:** o `install.py` só grava arquivos novos ou alterados, não apaga a pasta da skill.
- **Teste feito:** cota falsa a 99%, cadeia `claude:haiku`, `claude:sonnet`, `opencode:opencode/big-pickle`: Haiku encerrado em 31 s, Sonnet pulado, `big-pickle` concluiu e fez o commit.

## Perfis, velocidade, esforço e rodadas
- **Perfis salvos:** permitem guardar um conjunto personalizado de cadeias em `~/.delegar/perfis.json` (até 50 perfis) para reaproveitar entre projetos pelo painel ou pela CLI (`cli.mjs perfis`, `novo --perfil`, `modo <id> --perfil`).
- **Velocidade e esforço:** a velocidade do projeto (`auto`, `rapido`, `medio`, `demorado`) controla o esforço dos modelos (`low`, `medium`, `high`). A prioridade é: velocidade fixa do projeto > `esforco` individual da tarefa > padrão do modo. Integração e verificação (`fixChain` e `coordinatorChain`) nunca usam esforço baixo.
- **Histórico de rodadas:** ao continuar um projeto `concluido` ou `cancelado` com uma nova mensagem, a execução anterior é arquivada em `p.rodadas[]` e seus arquivos vão para `logs/rodada-N/`. O contexto das rodadas anteriores alimenta o planejador e os custos são somados no acumulado do projeto (`cli.mjs migrar-rodadas <id>` converte o formato legado).

## Cotas, tokens e custos
- **Cotas reais do Antigravity e Claude:** `quota.ps1` lê `agy --p /usage` em três grupos (`gemini`, `argon`, `agyClaudeGpt`) além da cota direta do Claude (janelas de 5 h e semanal). `worker.ps1` e `quota.ps1` separam estouros em `quota-ledger.jsonl` por grupo e pulam `agy:claude-*` e `agy:gpt-*` quando `agyClaudeGpt` está esgotado.
- **Histórico e estimativa por 1%:** leituras de cota ficam em `~/.delegar/state/quota-historico.jsonl` para estimar quantos tokens locais correspondem a 1% de cota por modelo e a relação entre janela de 5 h e semanal.
- **Tokens e custos:** conta tokens reais do Claude e do opencode (e do `result` ou estimativa de caracteres no agy), aplica a tabela de preços (`~/.delegar/precos.json`, atualizada mensalmente via LiteLLM) e exibe por período (`hoje`, `7d`, `30d`, `tudo`), mês (`--mes`) ou intervalo (`--de`/`--ate`).

## Paralelismo até 6, vigia e integração protegida (17/11/2026)
- **Paralelismo até 6:** com cota de Gemini folgada (`gemini.maxParallel = 6` com menos de 50% usado ou janela de 5 h renovando em menos de 1 h), `quota.ps1` recomenda até 6 simultâneos, o planejador preenche `maxConcurrent` igual ao número de escritores independentes (até 6) e o pipeline sobe a concorrência das tarefas prontas em cadeias Gemini.
- **Vigia de 20 min:** o `worker.ps1` monitora todas as CLIs com `-IdleTimeoutMinutes 20`: se uma tentativa ficar 20 minutos sem saída nem evento, é encerrada, registra o evento `vigia` em `events.jsonl` e passa para o próximo modelo da cadeia.
- **Integração sem cair em gratuito:** tarefas `main`/integradoras não recebem reserva gratuita e, sem cota nos modelos pagos, aguardam a cota renovar (exceto no modo `desespero`). O `Verify` do `pipeline.ps1` ignora arquivos que já estavam sujos antes da tarefa por outras sessões, e `fixChain` / `coordinatorChain` aproveitam na frente os modelos das cadeias editadas por tarefa (`cadeias` em `/ajustes`).

## Cuidados
- Os agentes executam sem pedir confirmação (exceto as paradas do acompanhamento). Os prompts devem proibir mexer em segredos, outros repositórios e trabalho alheio.
- Prompts curtos, apontando para arquivos: o agy recebe o prompt como argumento (limite de ~30 mil caracteres no Windows).
- Dois agentes nunca escrevem no mesmo arquivo ao mesmo tempo: escrita em paralelo, integração em série.
