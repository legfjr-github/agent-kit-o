# 🧭 Regra Global: Como usar o kit (cofre, skills e orquestrador)

1. **Começo de sessão com trabalho de projeto:** leia `{{VAULT_PATH}}\00_INDICE.md` e `{{VAULT_PATH}}\02_PROXIMOS_PASSOS.md` e abra só a nota que interessa. Não releia o cofre inteiro.
2. **Antes de criar do zero,** procure no índice um guia ou decisão que já resolve: segurança (`guias_e_comandos/checklist_seguranca_sistemas_web`), testes (`guias_e_comandos/padroes_de_testes`), sistemas com IA (`guias_e_comandos/sistemas_com_ia`), executáveis Python (`guias_e_comandos/executaveis_nuitka`), interface desktop (`arquitetura_e_padroes/pyqt6_design_desktop`), orquestração (`guias_e_comandos/skill_delegar_orquestracao`), automação de sites (`guias_e_comandos/automacao_web` e `automacoes/00_MAPA_DE_SITES`).
3. **Qual skill usar:**
   - trabalho grande, muitos arquivos, vários lotes, ou "economizar cota" → `delegar` (mostre o plano e a divisão por modelo antes de aprovar, a não ser que o usuário diga para confiar);
   - sistema que chama IA → `sistemas-com-ia`;
   - automação de site, robô, formulário web, ou projeto com selenium/undetected_chromedriver/playwright → `automacao-web`: ler o mapa do site antes, usar undetected-chromedriver por padrão e, ao terminar, registrar no mapa cada passo, aba, iframe, seletor e armadilha descobertos;
   - texto para pessoas (relatório, documentação, mensagem) → `humanizer`;
   - ler ou gravar no cofre → `knowledge-vault-manager`.
4. **Tarefa pequena** (uma correção, uma pergunta, poucos arquivos): faça direto, sem orquestrador.
5. **Commits:** nunca registre a exclusão de um arquivo que você não apagou de propósito. Antes de commitar, confira as exclusões em `git status`; arquivo que sumiu sozinho (antivírus) fica no git. O hook do `scripts/git_protecao.py` (instalado pelo kit) faz isso para os arquivos do `.protegidos` e para os que o PC não deixa criar; se um arquivo protegido já foi apagado, rode `git_protecao.py reparar <repo>`. Guia: `guias_e_comandos/git_protecao_antivirus`.
6. **Ao terminar,** rode os testes que se aplicam, relate o que foi testado e o que ficou de fora, e atualize o tripé do cofre (nota do projeto, `00_INDICE.md`, `01_LOG_DIARIO.md`) e o `02_PROXIMOS_PASSOS.md`.
