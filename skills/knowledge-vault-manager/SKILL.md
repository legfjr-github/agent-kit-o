---
name: "knowledge-vault-manager"
description: "Gerencia, pesquisa e atualiza a Base de Conhecimento Atômica (estilo Obsidian) compartilhada entre projetos, trabalho e modelos de IA, com índice geral e log diário."
---

# 🧠 Knowledge Vault Manager (Segundo Cérebro Atômico)

Esta skill permite que o agente opere de forma contínua com uma base de conhecimento em Markdown compatível com Obsidian, independente do projeto ou workspace em que estiver trabalhando.

O usuário mantém uma base de conhecimento única para projetos, trabalho e estudos. (Troque esta frase pelo seu papel: cargo, área e sistemas que mantém; os agentes usam isso como contexto.)

---

## 📍 Localização do Vault (Cofre Central)

O cofre mestre central e oficial está localizado em:
`{{VAULT_PATH}}\` (o instalador grava aqui o caminho real desta máquina).

**Regra de Ouro:** Todas as consultas, leituras e escritas devem ser feitas **diretamente no Cofre Central** acima, mesmo quando o workspace possuir pastas locais, garantindo que o conhecimento fique unificado em um único repositório Git.

---

## 📂 Estrutura de Categorias do Vault

O cofre divide-se nas seguintes categorias:
- `projetos/`: Sistemas em desenvolvimento ou sustentação (uma nota por projeto; `projetos/mapa_pc/` é gerada pelo instalador).
- `chamados/`: (opcional) histórico de chamados/tickets, causas-raiz e soluções.
- `regras_de_negocio/`: Cálculos, normas e decisões de negócio.
- `arquitetura_e_padroes/`: Design systems (ex.: PyQt6), infraestrutura, segurança e integridade.
- `guias_e_comandos/`: Manuais e checklists (segurança, testes, Nuitka, orquestrador, redação).
- `pessoal/`: Carreira, estudos, produtividade e metas fora dos projetos.

---

## 🔌 Acesso pelo servidor MCP `vault`

Se as ferramentas `list_notes`, `search_notes`, `read_note` e `write_note` (servidor MCP `vault`) estiverem disponíveis, prefira-as para ler e gravar notas: funcionam em qualquer pasta de trabalho e não saem do cofre. O servidor fica em `{{KIT_PATH}}\mcp\mcp_vault.py` e o `install.py` o registra no Claude Code, opencode, Antigravity, Gemini CLI, Qwen e Windsurf. Sem elas, leia e grave os arquivos direto em `{{VAULT_PATH}}`.

---

## 🔍 Protocolo de Leitura (Índice em Camadas)

Para gastar o mínimo de tokens possível e responder de forma rápida:

1. **Passo 1 (Índice e planejamento):** Leia o `00_INDICE.md` e o `02_PROXIMOS_PASSOS.md` do cofre:
   `{{VAULT_PATH}}\00_INDICE.md`.
2. **Passo 2 (Mapeamento):** Identifique no índice o link `[[categoria/nome_da_nota]]` relevante para o assunto pedido pelo usuário.
3. **Passo 3 (Carga Cirúrgica):** Leia **apenas** o arquivo `.md` correspondente à nota selecionada.
4. **Passo 4 (Aplicação):** Aplique as regras e decisões já homologadas sem reinventar a roda.

---

## ✍️ Protocolo Obrigatório de Escrita: O Tripé de Sincronização

Sempre que qualquer projeto, script ou rotina for atualizado, criado ou alterado pelo agente ou pelo usuário, é **MANDATÓRIO** atualizar simultaneamente 3 pontos:

```
          ┌─────────────────────────────────────────────────────┐
          │               TRIPÉ DE ATUALIZAÇÃO                  │
          ├──────────────────────────┬──────────────────────────┤
          │ 1. A Nota Específica     │ Atualizar a nota do      │
          │    (ex: projetos/...md)  │ projeto ou ticket        │
          ├──────────────────────────┼──────────────────────────┤
          │ 2. O Índice Geral        │ Registrar links novos ou │
          │    (00_INDICE.md)        │ ajustes de status no MOC │
          ├──────────────────────────┼──────────────────────────┤
          │ 3. O Log Diário          │ Registrar data, projeto, │
          │    (01_LOG_DIARIO.md)    │ adições e pendências     │
          └──────────────────────────┴──────────────────────────┘
```

### 1. Formato da Nota Específica (`.md`)
Toda nota criada deve conter o YAML Frontmatter no topo:

```markdown
---
titulo: Nome Claro do Tópico, Chamado ou Projeto
categoria: [projetos | chamados | regras_de_negocio | arquitetura_e_padroes | guias_e_comandos | pessoal]
tags: [tag1, tag2, tag3]
atualizado: AAAA-MM-DD
resumo: Breve resumo de 1 a 2 linhas explicando o propósito desta nota.
---

# Título da Nota

## 1. Visão Geral / Contexto
...

## 2. Detalhamento / Solução Técnica
...

## 3. Snippets ou Comandos Úteis
...

## 🔗 Links Relacionados
- [[00_INDICE]]
- [[01_LOG_DIARIO]]
- [[outra_nota_relevante]]
```

### 2. Atualização Automática do `00_INDICE.md`
Após criar ou renomear qualquer nota:
1. Abra o `00_INDICE.md`.
2. Insira a nova nota na seção apropriada mantendo a sintaxe de link do Obsidian:
   `- [[categoria/nome_da_nota]]: Resumo de 1 linha.`

### 3. Registro Obrigatório no `01_LOG_DIARIO.md`
Toda alteração de projeto deve ser registrada no topo do `01_LOG_DIARIO.md` com o dia corrente, detalhamento claro das ações e pendências:

```markdown
## 📅 DD/MM/AAAA

### 📌 [Nome do Projeto ou Chamado]
- **Adicionado:** O que foi criado ou implementado de novo.
- **Iniciado:** Tarefas ou módulos cujo desenvolvimento começou hoje.
- **Corrigido / Removido:** Bugs consertados, refatorações ou trechos obsoletos excluídos.
- **Pendências:** Itens restantes para a próxima sessão, bloqueios ou dependências externas.
```


### 4. Planejamento Vivo no `02_PROXIMOS_PASSOS.md`
O arquivo `02_PROXIMOS_PASSOS.md` (raiz do vault) guarda, por projeto, **exatamente o que será implementado e como**.
- **Ler** no início de toda sessão, logo depois do `00_INDICE.md`, para saber o que está pendente em cada projeto.
- **Alimentar** sempre que surgir trabalho futuro: um item por tarefa, no projeto certo, com data, o que fazer e a abordagem técnica.
- **Ao concluir** um item: removê-lo do arquivo e registrar o que foi feito no `01_LOG_DIARIO.md` e na nota do projeto.
- As "Pendências" do log diário apontam para este arquivo em vez de repetir a lista.
- **Sempre no cofre central** (`{{VAULT_PATH}}\`): nunca grave notas numa cópia do cofre dentro de um projeto.

---

## 💡 Princípios da Base de Conhecimento
- **Atomicidade:** Notas focadas em um único assunto, ticket ou projeto.
- **Interoperabilidade:** Todo o conteúdo é Markdown padrão com links `[[...]]`, navegável no Obsidian e por qualquer IA.
- **Rastreabilidade Contínua:** Nada se perde entre conversas graças ao `01_LOG_DIARIO.md`.

---

## 🔗 Instalação e Sincronização (repositório agent-kit)

O cofre e todas as skills vivem num repositório Git: `{{KIT_PATH}}` (remoto: `{{REPO_URL}}`).
O instalador copia as skills para Claude Code (`~/.claude/skills`), opencode (`~/.agents/skills`) e Gemini/Antigravity (`~/.gemini/config/skills`).

- **Antes de consultar o cofre:** rode `python "{{KIT_PATH}}/sync.py" pull` para trazer as atualizações feitas em outros computadores.
- **Depois de atualizar notas (tripé):** rode `python "{{KIT_PATH}}/sync.py" push "<resumo da alteração>"` para commitar e enviar.
- **Ao alterar uma skill:** edite em `{{KIT_PATH}}/skills/<skill>/` (fonte canônica, com placeholders), nunca nas cópias instaladas; depois rode `python "{{KIT_PATH}}/sync.py" push "<resumo>"`, que reinstala e envia.
