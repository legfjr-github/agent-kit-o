---
name: delegar
description: Orquestra modelos para executar trabalho grande, com painel web local (porta 8790) e CLI. Um modelo forte planeja e revisa; Claude (Sonnet, Haiku), Gemini via Antigravity CLI (agy) e modelos gratuitos do opencode executam conforme o modo (agressivo, equilibrado, padrão econômico, desespero ou personalizado), com reserva automática quando a cota acaba, paradas de confirmação opcionais e registro de atividade. Ajusta-se às CLIs instaladas no PC. Use quando o usuário disser "delegar", "manda pro Gemini", "orquestra", "usa outros modelos", "economiza minha cota", "abre o painel", pedir algo remotamente para ser planejado e executado por agentes, ou pedir uma série de lotes que deve rodar sozinha até o fim.
---

# Delegar: orquestração de modelos

Você é o orquestrador. Trabalhe como um líder técnico experiente: decide o que fazer, escreve ordens claras, entrega a execução ao modelo mais barato que dá conta e confere o resultado antes de seguir. Não repasse o trabalho de pensar; repasse o trabalho de digitar.

## Painel e CLI (caminho preferido)

O sistema fica em `app/` desta skill: `server.mjs` (painel em http://127.0.0.1:8790), `cli.mjs` (comandos) e `planner.md` (instruções do planejador). Dados em `%USERPROFILE%\.delegar\` (projetos, token, logs, `perfis.json` e `modelos-descobertos.json`). Relatórios no cofre em `{{VAULT_PATH}}\orquestracao\<id>.md`, com entrada no `00_INDICE.md` e no `01_LOG_DIARIO.md` ao iniciar e ao terminar.

Quando o usuário pedir para delegar (inclusive remotamente, por mensagem), encaminhe pela CLI. `SKILL` abaixo é a pasta desta skill (`%USERPROFILE%\.claude\skills\delegar`):

```powershell
node SKILL\app\cli.mjs novo --repo <pasta> --modo padrao|equilibrado|agressivo|desespero [--acompanhamento automatico|acompanhado|passo] [--auto] [--titulo "..."] "pedido completo"
node SKILL\app\cli.mjs novo --repo <pasta> --personalizado modo.json "pedido"   # modo personalizado
node SKILL\app\cli.mjs novo --repo <pasta> --perfil "Nome do perfil" "pedido"   # perfil salvo
node SKILL\app\cli.mjs esperar <id> 30      # espera o planejador, uma confirmação ou o fim (rode em segundo plano)
node SKILL\app\cli.mjs ver <id>             # conversa recente, plano, divisão por modelo, estado, confirmações pendentes
node SKILL\app\cli.mjs msg <id> "ajuste"    # continua a conversa com o planejador
node SKILL\app\cli.mjs plano <id>           # pede o plano final
node SKILL\app\cli.mjs aprovar <id>         # inicia a execução
node SKILL\app\cli.mjs confirmar <id> <confirmação> sim|nao   # responde a uma parada do modo acompanhado
node SKILL\app\cli.mjs atividade [id]       # quem está fazendo o quê agora, últimas atualizações e commits
node SKILL\app\cli.mjs cotas [--atualizar]  # cota restante de cada grupo, renovação e hora da leitura; --atualizar lê de novo (20 a 40 s)
node SKILL\app\cli.mjs modelos              # CLIs instaladas, catálogo (novos marcados com [novo]) e ordem do modo desespero
node SKILL\app\cli.mjs modelos --atualizar  # lê de novo as listas do agy e do opencode agora
node SKILL\app\cli.mjs perfis               # lista os perfis salvos (nome, primeiro modelo do planejador, data)
node SKILL\app\cli.mjs perfis salvar <nome> --personalizado modo.json [--sobrescrever]
node SKILL\app\cli.mjs perfis renomear <de> <para> | perfis excluir <nome>
node SKILL\app\cli.mjs modo <id> --perfil <nome>   # aplica um perfil salvo ao projeto, antes de aprovar
node SKILL\app\cli.mjs status | retomar <id> | cancelar <id> | modo <id> <modo> | acompanhamento <id> <tipo>
```

- Sem `--auto`: o planejador conversa e propõe; mostre ao usuário a divisão (`ver`) e só rode `aprovar` quando ele aprovar, ou quando ele disser para confiar.
- Com `--auto`: o planejador não pergunta, gera o plano e a execução começa sozinha.
- Abrir o painel: o usuário dá dois cliques em `SKILL\iniciar-painel.bat` (ou no atalho "Orquestrador de IA (Delegar)", ou na pasta Inicializar com `--sem-navegador`). Se o painel estiver fora do ar, peça isso a ele. O primeiro comando da CLI também sobe o painel, mas aí ele fica preso à sessão do agente e cai quando a sessão ou o app fecham (caso de 13/11/2026). Logs: `%USERPROFILE%\.delegar\startup.log` e `server.log` (com data e hora; sem a linha "painel saiu", o processo foi encerrado de fora).
- O usuário acompanha e aprova em http://127.0.0.1:8790 (conversa, plano, modelos por tarefa, editor de modelos, acompanhamento, confirmações, atividade ao vivo, log).
- Pedido longo: grave num arquivo e use `--arquivo <caminho>`.
- Confirmação pendente: não confirme no lugar do usuário. Mostre o motivo e pergunte; só rode `confirmar` com a resposta dele.

### Modos

O modo define o planejador e a cadeia de modelos de cada nível de tarefa (a ordem é a de reserva). Tudo passa por `adaptar()` em `app/modelos.mjs`: modelos de CLIs que não existem no PC saem da cadeia, e os dois melhores gratuitos entram no fim como última reserva.

| Modo | Planejador | pesado | volume | leve | Correção / coordenação |
|---|---|---|---|---|---|
| agressivo | Opus xhigh | Opus high → Sonnet high | Sonnet high → Opus → Haiku | Haiku → Sonnet | Opus high |
| equilibrado | Opus high | Sonnet high → Gemini high | alterna Sonnet e Gemini high | Haiku → Gemini low → GLM gratuito | Sonnet |
| padrao | Opus high | Gemini high → Sonnet → Haiku | Gemini high → Sonnet → Haiku | GLM gratuito → Gemini low/medium → Haiku | Sonnet / Gemini high |
| desespero | GLM gratuito → GPT-OSS (agy) → Sonnet | GLM → big-pickle → MiniMax | alterna GLM e big-pickle | big-pickle → inkling → GLM | GLM → big-pickle |
| personalizado | o usuário escolhe | o usuário escolhe | o usuário escolhe | o usuário escolhe | o usuário escolhe |

Sem Claude no PC, o planejador cai para Gemini 4 Argon (agy) e depois para o melhor gratuito; sem nada instalado, o painel recusa o projeto.

**Personalizado:** no painel, "Ver e mudar os modelos" mostra as cadeias do modo escolhido; qualquer mudança transforma o modo em Personalizado. "Começar do zero" esvazia tudo. Pela CLI, `--personalizado modo.json` com `{"planner":[...],"tiers":{"pesado":[...],"volume":[...],"leve":[...]},"fix":[...],"coord":[...],"maxConcurrent":2}`; cada item é `claude|agy|opencode:<modelo>[@low|medium|high|xhigh|max]`. O último personalizado fica em `%USERPROFILE%\.delegar\personalizado.json`.

**Desespero automático:** quando `quota.ps1` diz que nenhum provedor pago tem cota (Gemini estourado e Claude acima de 90% na janela de 5 h ou 95% na semanal), o pipeline passa a usar `desperateChain` (os gratuitos, do melhor para o pior) em vez de esperar 15 min, e volta ao normal quando a cota retorna. A ordem vem de um teste de 12/11/2026 (ver a nota do cofre `guias_e_comandos/skill_delegar_orquestracao.md`).

### Perfis salvos

Um perfil é um modo personalizado com nome, guardado em `%USERPROFILE%\.delegar\perfis.json` (até 50). Serve para reaproveitar a mesma escolha de modelos em vários projetos.

- **Painel:** acima do editor de modelos, na tela de projeto novo e na tela do projeto, há a barra **Perfil**: lista de perfis, **Salvar como perfil** (guarda os modelos atuais; nome repetido pergunta se substitui), **Renomear** e **Excluir perfil**. Escolher um perfil o aplica; editar qualquer modelo depois solta o vínculo e o modo volta a Personalizado. Com o projeto rodando, a lista fica travada.
- **CLI:** `perfis` lista; `perfis salvar <nome> --personalizado modo.json` grava (nome repetido dá erro sem `--sobrescrever`); `perfis renomear <de> <para>`; `perfis excluir <nome>`; `novo --perfil <nome>` cria o projeto já com o perfil; `modo <id> --perfil <nome>` aplica a um projeto existente.
- **Nome:** de 1 a 60 caracteres, começando por letra ou número, com letras, números, espaço e `. _ ( ) + -`; maiúscula e minúscula contam como o mesmo nome. Nomes como `__proto__` e `constructor` são recusados. O nome só viaja no corpo da requisição, nunca no caminho, e nunca vira nome de arquivo.
- **Validação:** as cadeias de cada perfil passam pela mesma checagem do modo personalizado ao salvar, ao ler do disco e ao aplicar. Perfil inválido no arquivo é ignorado com aviso; arquivo ilegível é guardado como `perfis.json.corrompido-<data>` e a lista recomeça vazia.
- O projeto guarda uma cópia dos modelos do perfil. Renomear ou excluir o perfil depois não muda projetos que já o usam.

### Fluxograma

O botão **Ver fluxo** (na tela de projeto novo, abaixo do editor de modelos, e no cartão "Plano e divisão" do projeto) desenha o caminho do trabalho: planejador, escritores por nível, integrador, fim e, ao lado, correção e coordenador de falhas, cada um com a cadeia de modelos. Antes do plano, é a previsão do modo escolhido; com plano, mostra as tarefas e suas dependências, e durante a execução o estado de cada uma (na fila, rodando, concluída, falhou, pulada) e o modelo em uso. Mudar o modo ou os modelos redesenha na hora. É só leitura: não altera nada.

### Descoberta de modelos

O painel descobre sozinho modelos novos do Antigravity e do opencode:

- **Quando:** logo depois que o painel sobe (em segundo plano, sem atrasar o início nem derrubar o processo se uma CLI falhar ou travar; limite de 45 s por CLI), pelo botão **Atualizar modelos** do painel e por `cli.mjs modelos --atualizar`. Roda `agy models` e `opencode models`, sem shell com texto interpolado, e mata o processo se passar do limite.
- **Onde fica:** o acumulado vai para `%USERPROFILE%\.delegar\modelos-descobertos.json` (primeira e última vez que cada id apareceu, quando a consulta rodou, erros por CLI). Um arquivo corrompido ou maior que 1 MB é guardado como `.corrompido-<data>` e a lista recomeça vazia.
- **Validação:** só entra id que a própria descoberta teria aceitado (`provedor:modelo`, sem `-` na frente, sem `//`, `.` ou `..`), tanto ao ler a saída da CLI quanto ao ler o arquivo. Id inválido, mesmo escrito à mão no arquivo, não chega ao catálogo nem às cadeias dos trabalhadores.
- **Marca novo:** modelo que não está na lista fixa de `app/modelos.mjs` nem nas dicas aparece com "novo" nas listas do editor e em `modelos` (`[novo]`).
- **Modo desespero:** os gratuitos novos do opencode (id terminado em `-free`) entram no fim da ordem do desespero, no máximo 10, na ordem em que foram descobertos, e ficam ali até alguém ranquear o modelo medindo-o como no teste de 12/11/2026 e movê-lo para `DESESPERO` em `app/modelos.mjs`. Modelo novo que não é gratuito só aparece nas listas; não entra em nenhuma cadeia sozinho.

### Acompanhamento

| Tipo | Para quando |
|---|---|
| automatico | nunca; roda até o fim |
| acompanhado | antes da primeira integração no repositório, de tarefas marcadas pelo planejador com `"confirmar": true` (deploy, migração, apagamento, segurança), de recuperar falhas e de entrar no modo desespero |
| passo | antes de cada tarefa |

A parada é um arquivo `logs\gates\<confirmação>.json`; o painel ou `cli.mjs confirmar` grava `.ok` ou `.no`. Tarefa recusada fica como "pulada", e as que dependem dela também. O Windows mostra um aviso (`msg`) quando surge uma parada. O tipo de acompanhamento pode mudar durante a execução.

### Atividade

Mesmo no automático, o botão **Atividade** do painel (e `cli.mjs atividade`) mostra, para cada projeto em andamento: a tarefa rodando, o modelo que está com ela, há quanto tempo, a última ação do agente (arquivo editado, comando rodado), as últimas atualizações (início, troca de modelo por cota, fim, falha, confirmação) e os últimos commits do repositório. Os eventos ficam em `logs\events.jsonl`; o modelo em uso em `logs\<tarefa>\current.json`.

Todos os agentes rodam sem pedir confirmação (`--dangerously-skip-permissions` no Claude e no agy, `--auto` no opencode). O planejador não edita: Claude sem as ferramentas de edição, opencode com o agente `plan`, agy sem aprovação automática.

Para trabalho pequeno ou quando o painel não servir, use os scripts diretamente (seções abaixo).

## Papéis

| Papel | Quem | Quando |
|---|---|---|
| Planejar, dividir, revisar, decidir | Você (Opus, esforço alto) | Sempre. Leia o contexto, defina lotes, critérios de aceite e verifique cada entrega. |
| Tarefa que exige julgamento (código delicado, revisão de qualidade, correção de erro do Gemini) | `claude:sonnet` | Quando o erro custa caro ou o Gemini já falhou nela. |
| Volume: gerar muitas lições/arquivos, traduzir, preencher dados, refatoração mecânica | `agy:gemini-3.8-flash-high` | Padrão para trabalho longo. |
| Volume simples e repetitivo (formatação, listas, conferências mecânicas) | `agy:gemini-3.8-flash-medium` ou `-low` | Quando a tarefa não pede raciocínio. |
| Reserva quando a cota do Gemini acaba | `claude:sonnet`, depois `claude:haiku` | Automático pelo script. Haiku só para tarefa simples. |

Modelos disponíveis no agy: `agy models` (ex.: `gemini-3.8-flash-high|medium|low`, `gemini-4-argon-*`, `claude-sonnet-5-5-*`, `gpt-oss-120b-medium`). No Claude Code CLI: `--model sonnet|haiku|opus`. No opencode: `opencode models` (os `*-free` e `opencode/big-pickle` são gratuitos; entrada `opencode:opencode/glm-5.3-flash-free`).

## Executar um trabalhador

Use o script `scripts/worker.ps1` (PowerShell 5.1). Ele roda o prompt na primeira opção da cadeia; se a saída indicar cota ou limite (quota, rate limit, 429, RESOURCE_EXHAUSTED, usage limit), passa para a próxima, avisando o novo modelo de que o trabalho pode estar pela metade.

```powershell
& "$env:USERPROFILE\.claude\skills\delegar\scripts\worker.ps1" `
  -PromptFile <arquivo.md> -Cwd <repositório> -LogDir <scratchpad>\<tarefa> `
  -Chain 'agy:gemini-3.8-flash-high','claude:sonnet','claude:haiku'
```

Rode com `run_in_background: true` e timeout de 7200000. Você é notificado quando termina; não fique consultando com sleep. O resultado fica em `<LogDir>\result.json` (`ok`, `model`, `attempts`) e as saídas em `<LogDir>\<n>-<modelo>.out.log`.

Os trabalhadores rodam sem pedir confirmação: agy com `--dangerously-skip-permissions`, Claude com `--dangerously-skip-permissions`. Por isso o prompt deve proibir o que não pode ser tocado (segredos, `.dev.vars`, outros repositórios) e dizer exatamente o que publicar.

## Escrever o prompt do trabalhador

O trabalhador começa sem contexto. O prompt deve trazer:
1. Onde está o repositório e de onde continuar (último commit, lote anterior como modelo).
2. Arquivos de contexto a ler: notas do cofre (`{{VAULT_PATH}}\`), README, guias do projeto, exemplos já prontos.
3. A tarefa, com escopo fechado e numerado.
4. Critérios de verificação que ele mesmo roda (validador, testes, build).
5. O fechamento obrigatório: commit, push, deploy quando houver, atualização do cofre (nota do projeto, `01_LOG_DIARIO.md`, `02_PROXIMOS_PASSOS.md`, `00_INDICE.md`) e um resumo final curto.
6. Proibições explícitas.

Prompt curto, apontando para arquivos, não colando conteúdo (o agy recebe o prompt como argumento; limite prático de ~30.000 caracteres no Windows).

## Modo autônomo (padrão para séries de lotes)

Para não depender desta sessão nem do usuário entre um lote e outro, você planeja e entrega a execução ao pipeline:

1. Escreva os prompts (um por tarefa) e um `plan.json` numa pasta do plano (ex.: `<repo>-plano\<nome>\`, fora do repositório).
2. Rode `scripts/start-pipeline.ps1 -Plan <plan.json>`. Ele abre `pipeline.ps1` num processo oculto e destacado, que continua rodando mesmo se a sessão do Claude terminar.
3. O pipeline agenda tudo sozinho:
   - dispara as tarefas cujas dependências terminaram, até `min(maxConcurrent, recommendedConcurrent)` (ele lê a cota com `quota.ps1` a cada 10 min) e com 60 s de intervalo entre os disparos;
   - cria a worktree de cada escritor no momento do disparo, a partir do HEAD atual, e a remove depois da integração;
   - roda as tarefas `main` uma por vez e as verifica: comandos em `verify`, árvore limpa e push feito; se a verificação falhar, manda uma tentativa de correção para `fixChain`;
   - se uma tarefa falhar, para de disparar novas e chama um **coordenador Gemini** (`coordinatorChain`), que lê os logs, corrige a causa e devolve; depois o pipeline repete a tarefa (até `maxRecoveries` vezes);
   - sem cota em nenhum provedor, espera 15 min e tenta de novo.
4. Ao final grava `<logDir>\summary.md`, mostra um aviso na tela do Windows (`msg`) e sai com 0 (concluído) ou 1 (incompleto). Para continuar um pipeline interrompido: `start-pipeline.ps1 -Plan <plan.json> -Resume`.
5. Se a sessão ainda estiver aberta, acompanhe com Monitor (`until grep -q "pipeline end" <logDir>/pipeline.log`) e confira o resultado como na seção abaixo antes de avisar o usuário.

`plan.json`:

```json
{
  "name": "meu-site-lote-A",
  "repo": "C:\\projetos\\meu-site",
  "worktreeRoot": "C:\\projetos\\meu-site-wt",
  "logDir": "C:\\projetos\\meu-site-plano\\lote-a\\logs",
  "chain": ["agy:gemini-3.8-flash-high", "claude:sonnet", "claude:haiku"],
  "fixChain": ["claude:sonnet", "agy:gemini-3.8-flash-high"],
  "coordinatorChain": ["agy:gemini-3.8-flash-high", "claude:sonnet"],
  "maxConcurrent": 2,
  "maxRecoveries": 2,
  "verify": ["node ferramentas\\validar_licoes.mjs"],
  "tasks": [
    { "id": "w1", "prompt": "escritor_1.md", "worktree": "l1" },
    { "id": "w2", "prompt": "escritor_2.md", "worktree": "l2" },
    { "id": "i1", "prompt": "integrador_1.md", "main": true, "after": ["w1"], "removeWorktrees": ["l1"] },
    { "id": "i2", "prompt": "integrador_2.md", "main": true, "after": ["w2", "i1"], "removeWorktrees": ["l2"] }
  ]
}
```

Nos prompts, `{WT}` vira o caminho da worktree da tarefa e `{REPO}` o do repositório. Para a cadeia de integradores ficar em série, cada uma depende da anterior (`after`); os escritores não dependem de nada e o pipeline os adianta conforme a cota permite. Um `chain` dentro da tarefa substitui a cadeia padrão (ex.: `["agy:gemini-3.8-flash-low"]` para trabalho mecânico).

## Sequência de lotes até o fim

Use o modo autônomo acima. Os passos abaixo valem quando você mesmo encadeia (série curta, ou o pipeline indisponível):
1. Planeje todos os lotes de uma vez e grave os prompts em arquivos no scratchpad.
2. Dispare em segundo plano. Lotes que mexem nos mesmos arquivos não rodam juntos inteiros; use o pipeline escritor/integrador da seção Paralelismo quando a cota permitir.
3. Ao ser notificado do fim, confira você mesmo: `git log -1`, `git status` limpo, validador/testes do projeto, deploy no ar, cofre atualizado. Faça uma amostragem da qualidade (abra um ou dois arquivos gerados).
4. Se algo falhou, mande a correção a `claude:sonnet` (ou corrija você, se for pequeno) antes do próximo lote.
5. Dispare o próximo lote. Só fale com o usuário no fim de tudo, ou se todos os modelos estiverem sem cota, ou se surgir uma decisão que só ele pode tomar.

## Cotas

Antes de cada rodada, leia `scripts/quota.ps1` (leva cerca de 30 s: o agy responde em ~18 s, com limite de 60 s, e a sonda do Claude gasta um prompt mínimo no Haiku). O mesmo dado aparece no painel, no botão **Cotas** e no bloco "Cotas dos modelos deste projeto", e pelo comando `cli.mjs cotas`.

- **Grupos do Antigravity:** o script roda `agy --p /usage` e lê três grupos:
  - Gemini (`agy:gemini-*`): janelas de 5 h e semanal;
  - Gemini 4 Argon (`agy:*argon*`): semanal;
  - Claude e GPT via Antigravity (`agy:claude-*` e `agy:gpt-*`): janelas de 5 h e semanal.
- O agy informa o que **resta**. O script guarda o que foi **usado** (de 0 a 1) nos campos `fiveHour` e `sevenDay` e acrescenta `fiveHourRemaining` e `sevenDayRemaining`. Gemini com 2% ou menos restante na janela de 5 h ou na semanal fica com 0 trabalhadores.
- **Se a leitura falhar:** valem, nessa ordem, a última leitura boa (até 6 h), o arquivo manual `%USERPROFILE%\.delegar\state\gemini.json` (`usedPercent`, `resetsAt`, `updated`) e o registro de estouros `quota-ledger.jsonl` (o `worker.ps1` grava ali cada estouro; estouro há menos de 5 h vale 0, vá direto para Sonnet/Haiku). Sem nenhum deles, o Gemini vale 1 trabalhador.
- **Cache:** `quota-last.json` guarda a última leitura. Com `-MaxAgeMinutes`, o script reaproveita essa leitura se ela for mais nova que o limite, sem chamar o agy. A pasta de estado é `%USERPROFILE%\.delegar\state`, ou a de `DELEGAR_DATA` quando a variável existe.
- **Testes:** `-SkipAgy` pula a leitura do agy; `-AgyUsageFile <arquivo>` lê uma saída guardada.
- **Claude direto (`claude:`):** leitura real da janela de 5 h e da semanal (`utilization`, `resetsAt`).
- **Painel e API:** `GET /api/cotas` responde com o cache de até 10 min; se ele estiver mais velho, a leitura roda em segundo plano e a resposta sai na hora com `lendo=true`. `POST /api/cotas/atualizar` força uma leitura, uma por vez, com intervalo mínimo de 30 s. `GET /api/projetos/<id>/cotas` traz só os grupos usados nas cadeias do projeto. Todas exigem o token.
- `recommendedConcurrent` soma as duas recomendações (máximo 3). O segundo trabalhador é seguro mesmo com a cota do Gemini incerta quando o Claude tem folga, porque a cadeia de reserva cai no Sonnet.

Acelere (2 simultâneos, raramente 3) quando a cota estiver quase cheia ou quando sobrar bastante e a janela estiver perto de renovar (cota que seria perdida). Reduza para 1 quando qualquer provedor passar de ~80% usado. Se todos estiverem acima de 90% usado, pare e avise o usuário com os horários de renovação.

## Paralelismo

Rode tarefas em simultâneo só quando as três condições valem:
1. **Arquivos disjuntos.** Nenhum par de trabalhadores escreve no mesmo arquivo. Índices, JSON agregados, dicionários gerados, lockfiles, migrações, o cofre, `git commit`, `push` e deploy são recursos compartilhados: ficam com um único trabalhador por vez.
2. **Sem dependência de conteúdo.** A tarefa B não precisa ler o resultado de A (ex.: links cruzados para lições que ainda não existem). Se precisar, B roda depois ou a ligação fica para a integração.
3. **Cota.** `recommendedConcurrent` ≥ número de trabalhadores, contando os que já estão rodando.

Padrão para trabalho em lotes que tocam arquivos compartilhados: **escrita em paralelo, integração em série.**
- **Escritor** (paralelizável): roda numa worktree isolada (`git worktree add <repo>-wt\<tarefa> -b wt/<tarefa>`), lê o repositório principal para referência, grava só os arquivos novos dele e um manifesto (ex.: `cobertura.json`). Proibido: editar arquivos compartilhados, commit, push, deploy, cofre.
- **Integrador** (um por vez, no repositório principal): copia os arquivos do escritor, atualiza índices e JSON, regera o que for gerado, faz os links cruzados, valida, commita, publica e atualiza o cofre. Depois remove a worktree (`git worktree remove`, `git branch -D`).
- Pipeline típico com 2 simultâneos: integrador do lote N junto com o escritor do lote N+1.

Cuidados:
- Um agente que rode `git add -A` no repositório principal captura arquivos alheios; por isso escritores ficam fora dele.
- Escalone o início dos trabalhadores em alguns minutos; estouros de cota costumam vir juntos.
- Se um trabalhador paralelo estoura a cota, não relance os outros no mesmo modelo: use a próxima opção da cadeia.
- Cada trabalhador tem seu próprio `-LogDir`.

## Antes de disparar

- Veja se outro agente já está mexendo no repositório: processos `agy`/`Antigravity IDE` com CPU subindo, arquivos alterados nos últimos minutos, última entrada em `%USERPROFILE%\.gemini\antigravity\brain\<id>\.system_generated\logs\transcript.jsonl`. Se estiver, espere e continue de onde ele parar.
- Em mudanças com login, formulário ou dado pessoal, inclua no prompt os testes do checklist de segurança do cofre.

## Relato final ao usuário

Lista curta: o que cada modelo fez, lotes concluídos com commit e deploy, falhas e como foram resolvidas, trocas de modelo por cota, o que ficou pendente.
