# 🌐 Regra Global: Consulta e Atualização da Base de Conhecimento

1. **Memória de Longo Prazo:** O usuário mantém uma Base de Conhecimento Atômica (Markdown, estilo Obsidian) gerenciada pela skill `knowledge-vault-manager`, compartilhada entre projetos, trabalho e modelos de IA.
2. **Localização Mestre:**
   - Prioridade 1: Pasta `knowledge/` no workspace atual (se existir).
   - Prioridade 2 (Cofre Central): `{{VAULT_PATH}}`.
3. **Consulta Econômica:** Antes de pesquisar extensivamente por arquivos ou criar soluções do zero, consulte o `00_INDICE.md` do cofre para reaproveitar regras, padrões de código e decisões já tomadas.
4. **Tripé Obrigatório de Atualização:**
   Sempre que qualquer projeto, rotina ou documentação for criada ou atualizada, é **OBRIGATÓRIO** atualizar:
   - **A Nota Específica:** No diretório temático correspondente (`projetos/`, `regras_de_negocio/`, `guias_e_comandos/`, etc.).
   - **O Índice Geral:** `00_INDICE.md` com link `[[...]]`.
   - **O Log Diário:** `01_LOG_DIARIO.md` com data (`DD/MM/AAAA`), nome do projeto, o que foi **Adicionado**, **Iniciado**, **Corrigido/Removido** e as **Pendências** com detalhamento suficiente.
5. **Próximos Passos por Projeto:** Leia `02_PROXIMOS_PASSOS.md` no início de toda sessão. Ele lista, por projeto, o que será implementado e como. Ao planejar trabalho futuro, acrescente o item ali; ao concluir, remova o item e registre o que foi feito no log diário e na nota do projeto.
6. **Cofre único:** grave sempre em `{{VAULT_PATH}}`.
