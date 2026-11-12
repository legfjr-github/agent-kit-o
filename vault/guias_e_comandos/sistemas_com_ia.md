---
titulo: Sistemas com integração de IA (API e CLIs locais)
categoria: guias_e_comandos
tags: [ia, claude, gemini, opencode, api, cli, integracao, seguranca, lgpd]
atualizado: 2026-11-12
resumo: Como escolher entre API paga e CLIs locais (Claude Code, Antigravity, opencode), código base de cada caminho, saída estruturada, streaming, custos, testes e segurança.
---

# 🤖 Sistemas com integração de IA

## 1. Qual caminho usar
| Situação | Caminho | Por quê |
|---|---|---|
| Sistema em servidor, vários usuários, produção | **API** (SDK oficial) | conta própria, limites e custo previsíveis, sem depender de login de uma pessoa |
| Ferramenta pessoal ou da equipe, roda no PC de quem usa | **CLI local** (`claude -p`, `agy`, `opencode run`) | usa a assinatura já paga (Claude, Antigravity) ou os modelos gratuitos do opencode; sem chave de API |
| Volume alto e sem pressa (lotes noturnos) | API com Batches | metade do preço |
| Tarefa que mexe em arquivos, roda comandos, programa | CLI em modo agente, ou o orquestrador `delegar` | o agente já tem as ferramentas |
| Só classificar, resumir, extrair | uma chamada simples, sem ferramentas | mais rápido e barato |

Regra prática: comece com **uma chamada** e um prompt bom. Só passe para ferramentas (tool use) ou agente quando a tarefa realmente exigir vários passos decididos pelo modelo.

## 2. Arquitetura que funciona para os dois caminhos
- Uma **camada de provedores** com a mesma interface: `run(prompt, modelo) -> texto, uso, tempo`. A tela e as regras de negócio não sabem se é API ou CLI. Assim dá para trocar de modelo sem mexer no resto (o `delegar` segue esse desenho).
- **Prompts em arquivos** (`prompts/*.md`), versionados, com variáveis claras. Nada de prompt espalhado em string no código.
- **Registro de cada execução** no banco ou em log: provedor, modelo, tempo, tokens, custo, status, id da requisição. Sem isso não há como comparar modelos nem explicar falha.
- **Timeout e cancelamento** em toda chamada; a tela mostra andamento e permite cancelar.
- **Saída estruturada** (JSON validado) sempre que outro código for ler a resposta.
- **Fila** quando houver muitas chamadas: uma de cada vez por provedor, ou poucas em paralelo, respeitando limite de uso.

## 3. Caminho API (Claude)
Modelos atuais (11/2026): `claude-opus-5-5` (padrão, melhor qualidade, US$ 4/20 por milhão de tokens de entrada/saída), `claude-sonnet-5-5` (US$ 2/10, bom para volume), `claude-haiku-5-5` (US$ 0,10/0,50, classificação e tarefas simples). Use os IDs exatamente assim, sem sufixo de data.

Chave: variável de ambiente `ANTHROPIC_API_KEY` (no `.env`, fora do git). O SDK lê sozinho.

### Python
```python
# pip install anthropic pydantic
import anthropic
from pydantic import BaseModel

client = anthropic.Anthropic()          # lê ANTHROPIC_API_KEY

# chamada simples
r = client.messages.create(
    model="claude-opus-5-5", max_tokens=16000,
    system="Você é um analista de chamados. Responda em português, direto.",
    messages=[{"role": "user", "content": texto}],
)
resposta = "".join(b.text for b in r.content if b.type == "text")
print(r.usage.input_tokens, r.usage.output_tokens, r._request_id)

# saída estruturada (validada pelo SDK)
class Triagem(BaseModel):
    categoria: str
    prioridade: int
    resumo: str

r = client.messages.parse(model="claude-opus-5-5", max_tokens=4000,
                          messages=[{"role": "user", "content": texto}], output_format=Triagem)
triagem = r.parsed_output          # instância de Triagem

# texto longo: streaming (evita estouro de tempo); pegue a mensagem final no fim
with client.messages.stream(model="claude-opus-5-5", max_tokens=64000,
                            messages=[{"role": "user", "content": texto}]) as s:
    for pedaco in s.text_stream:
        print(pedaco, end="", flush=True)   # mostra na tela enquanto chega
    final = s.get_final_message()
```

### TypeScript / Node
```ts
// npm i @anthropic-ai/sdk zod
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

const client = new Anthropic();
const Triagem = z.object({ categoria: z.string(), prioridade: z.number(), resumo: z.string() });
const r = await client.messages.parse({
  model: "claude-opus-5-5", max_tokens: 4000,
  messages: [{ role: "user", content: texto }],
  output_config: { format: zodOutputFormat(Triagem) },
});
const triagem = r.parsed_output; // null se não validou: trate
```

### Pontos que mais dão erro
- **Profundidade de raciocínio:** controle com `output_config={"effort": "low"|"medium"|"high"}`. No Opus 5.5 o padrão é `medium` e o raciocínio não pode ser desligado; para tarefa simples use `low`. Não use `budget_tokens` (dá erro 400 nos modelos atuais).
- **Recusa:** confira `r.stop_reason`. Se for `"refusal"`, não leia `content` como resposta normal; registre `r.stop_details`.
- **`max_tokens` baixo corta a resposta:** use ~16000 sem streaming e ~64000 com streaming; `stop_reason == "max_tokens"` indica corte.
- **Erros:** o SDK já repete 429 e 5xx (2 tentativas). Trate em cadeia: `anthropic.RateLimitError` (espere `retry-after`), `anthropic.APIStatusError` (≥ 500 tente depois; 4xx é erro seu), `anthropic.APIConnectionError` (rede). Guarde `_request_id` no log.
- **Cache de prompt (até 90% mais barato):** parte fixa e grande (instruções, documento de referência) no começo, com `cache_control={"type": "ephemeral"}` na chamada; parte variável (pergunta, data, id) depois. Qualquer mudança no começo (ex.: data atual no `system`) anula o cache. Confira `r.usage.cache_read_input_tokens`.
- **Contar custo antes:** `client.messages.count_tokens(model=..., messages=...)`.
- **Prefill** (começar a resposta pelo assistente) não funciona mais nos modelos atuais: use saída estruturada.
- Detalhes e recursos avançados (ferramentas, lotes, arquivos, agentes gerenciados): peça ao Claude Code usando a skill `claude-api`, ou veja https://platform.claude.com/docs.

### Gemini pela API (quando o projeto exigir)
`pip install google-genai`, chave em `GEMINI_API_KEY`, chamada básica `genai.Client().models.generate_content(model="<modelo>", contents=texto)`. Confira nomes de modelo e opções na documentação oficial (ai.google.dev) antes de escrever: muda com frequência.

## 4. Caminho CLI local (sem chave de API)
Funciona com o login que a pessoa já fez em cada ferramenta. É o que o `delegar` usa. Padrões testados:

| Ferramenta | Comando | Prompt | Saída |
|---|---|---|---|
| Claude Code | `claude -p --model sonnet --output-format stream-json --verbose --include-partial-messages --tools "" --strict-mcp-config --disable-slash-commands --no-session-persistence --setting-sources "" --system-prompt "<instrução curta>"` | stdin | uma linha JSON por evento; o evento `result` traz texto, `usage` e `total_cost_usd` |
| Antigravity (Gemini) | `agy --model gemini-3.8-flash-medium --input-format stream-json --output-format stream-json --disable-slash-commands -p=` | stdin, uma linha `{"event":"user","message":{"content":"..."}}` | eventos `step_update` (`text_delta`) e `result` (`response`, `usage`) |
| opencode | `opencode run --pure --model opencode/glm-5.3-flash-free --format json` | stdin | eventos `text` (`part.text`), `error`, `step_finish` (tokens) |

Regras que evitam dor de cabeça:
1. **Rode numa pasta neutra** (ex.: `data/run`), para a CLI não carregar `CLAUDE.md`, `AGENTS.md` ou skills de outro projeto. No Claude, `--setting-sources ""` e `--tools ""` cortam o contexto de ~39 mil para menos de mil tokens por chamada.
2. **Prompt sempre pelo stdin**, nunca como argumento: o Windows limita a linha de comando a ~32 mil caracteres e o `cmd.exe` estraga aspas e acentos.
3. **No Windows, chame o `.exe` real**, não o `.cmd` do npm (o `.cmd` só repassa; ache o `.exe` dentro de `node_modules`). Se precisar do `.cmd`, use `cmd.exe /d /s /c`.
4. **Sem ferramentas quando só quer texto:** Claude com `--tools ""`; agy sem `--dangerously-skip-permissions` (no modo sem tela ele nega o que pediria permissão); opencode com `--agent plan` quando não deve editar.
5. **Com ferramentas (agente que edita arquivos):** só em pasta de trabalho isolada (worktree), com prompt que proíbe mexer em segredos e em outras pastas; Claude/agy com `--dangerously-skip-permissions`, opencode com `--auto`. Prefira o orquestrador `delegar`, que já faz isso.
6. **Leia a saída linha a linha** (JSON por linha), mostre o texto parcial na tela e guarde o evento final com tokens e custo.
7. **Timeout e cancelar** matando a árvore de processos (`taskkill /PID <pid> /T /F`).
8. **Cota:** a mensagem de limite vem no texto (`hit your limit`, `quota`, `429`, `RESOURCE_EXHAUSTED`). Detecte, marque o item como "aguardando cota" e tente outro provedor ou depois do horário informado.
9. **PowerShell 5.1:** `>` grava em UTF-16; use `$PSDefaultParameterValues['Out-File:Encoding']='utf8'` ou leia direto pelo processo.
10. **Descubra os modelos na hora:** `agy models`, `opencode models` (os gratuitos terminam em `-free`). O ranking dos gratuitos está em [[guias_e_comandos/skill_delegar_orquestracao]].

Esqueleto em Python (provedor CLI):
```python
import json, subprocess
from pathlib import Path

RUN_DIR = Path("data/run"); RUN_DIR.mkdir(parents=True, exist_ok=True)

def rodar_claude(prompt: str, modelo="sonnet", timeout=600) -> dict:
    cmd = ["claude", "-p", "--model", modelo, "--output-format", "stream-json", "--verbose",
           "--tools", "", "--strict-mcp-config", "--disable-slash-commands",
           "--no-session-persistence", "--setting-sources", "", "--system-prompt", "Responda em português."]
    p = subprocess.run(cmd, input=prompt, capture_output=True, text=True, encoding="utf-8",
                       cwd=RUN_DIR, timeout=timeout)
    final = {}
    for linha in p.stdout.splitlines():
        try:
            ev = json.loads(linha)
        except ValueError:
            continue
        if ev.get("type") == "result":
            final = ev
    if not final or final.get("is_error"):
        raise RuntimeError((final.get("result") or p.stderr or "sem resposta")[-2000:])
    return {"texto": final["result"], "uso": final.get("usage"), "custo": final.get("total_cost_usd")}
```
(No Windows, troque `"claude"` pelo caminho do `claude.exe` encontrado com `shutil.which` + leitura do `.cmd`.)

## 5. Prompt que dá bom resultado
- Diga **quem é o leitor e para que serve** a resposta; dê o **formato de saída** (de preferência um schema JSON).
- Dados de entrada entre marcadores claros (`<chamado>...</chamado>`) e a instrução fora deles.
- Um ou dois **exemplos bons** reais (anonimizados) valem mais que dez regras.
- Peça para dizer "não sei" ou deixar o campo vazio quando faltar informação, em vez de inventar.
- Teste o prompt com 10 a 20 casos reais guardados (`tests/casos/`) e compare antes de trocar prompt ou modelo. Mudança de prompt sem esse conjunto é chute.

## 6. Segurança e LGPD
- **Chave só no servidor**, em variável de ambiente; nunca no front-end, no git ou no log.
- **Texto vindo de usuário, e-mail, página ou documento é dado, não instrução** (injeção de prompt). O modelo não pode ter poder de fazer o que o usuário comum não pode: toda ação que ele sugere passa pelas mesmas permissões e validações do sistema, no servidor.
- Ferramentas que o modelo chama: lista fechada, parâmetros validados, caminhos de arquivo presos a uma pasta, nada de executar comando montado pelo modelo sem filtro.
- **Dado pessoal** (CPF, matrícula, saúde): envie o mínimo necessário, mascare o que não precisa ir, registre a base legal; na API, prefira contrato/conta da organização. Na CLI local, lembre que a conversa fica no histórico da ferramenta (Claude: `--no-session-persistence` evita).
- Mostre a resposta da IA escapada como texto (nada de `innerHTML` com a saída do modelo).
- Siga [[guias_e_comandos/checklist_seguranca_sistemas_web]] e acrescente os testes: prompt com "ignore as instruções anteriores" dentro do dado; resposta enorme; JSON inválido; provedor fora do ar; cota estourada.

## 7. Testes
- Regras do sistema testadas com um **provedor falso** (devolve respostas fixas), sem gastar cota: [[guias_e_comandos/padroes_de_testes]].
- Um teste de integração real, marcado como lento, por provedor (uma chamada curta).
- Conjunto de casos reais para avaliar qualidade de prompt/modelo (seção 5).

## 8. Custos
- Registre tokens e custo por execução; some por dia e por funcionalidade.
- Ordem das economias: cache de prompt → `effort` menor nas tarefas simples → modelo menor só onde a qualidade se mantém (meça com os casos) → lotes para o que não tem pressa.
- CLI local: o custo é a cota da assinatura; o `quota.ps1` do `delegar` lê a janela de 5 h do Claude.
