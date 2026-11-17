---
name: tec-concursos
description: Assistente do TEC Concursos (tecconcursos.com.br) pelo Playwright MCP e pela API interna do site. Lê um edital, propõe os filtros de cada matéria (assuntos, banca, período, bancas de reserva), conta as questões, cria a pasta e os cadernos, e extrai questões objetivas e discursivas com gabarito, comentário do professor, resolução da banca e os comentários mais votados do fórum. Use quando o pedido falar de TEC Concursos, cadernos de questões, filtros por edital, montar estudo para um concurso no TEC, ou extrair discursivas/comentários/gabaritos do TEC.
---

# TEC Concursos: edital → filtros → cadernos → extração

Mapa completo do site (endpoints, ids, armadilhas): `{{VAULT_PATH}}\automacoes\sites\tecconcursos.com.br.md`. Leia antes de começar se algo aqui não bastar.

## Ferramentas
- **Principal: Playwright MCP** (`browser_navigate`, `browser_evaluate`, `browser_wait_for`, `browser_snapshot`), de preferência em modo `--extension`, ligado ao Chrome em que o usuário já está logado no TEC.
- Equivalentes: Claude in Chrome (`javascript_tool`) ou Selenium (`scripts/referencia_selenium.md`).
- Toda a lógica está em `scripts/tec_api.js` (objeto `window.TecAPI`). Não reescreva chamadas à mão: use as funções da biblioteca.

### Carregar a biblioteca
1. `browser_navigate` para `https://www.tecconcursos.com.br/questoes/pastas`. Se cair em `/login`, peça ao usuário para entrar (login e CAPTCHA são dele) e espere.
2. **Primeira vez na sessão:** leia `scripts/tec_api.js` e rode `browser_evaluate` com `function: "() => { <conteúdo do arquivo>\n; return TecAPI.versao }"`. A biblioteca se grava no `localStorage` do site.
   Versão atual: **7**. Se a recarga do passo 3 devolver versão menor, repita a primeira carga (o `localStorage` tem cópia antiga).
3. **Depois de qualquer navegação** (a página perde o `window.TecAPI`): `browser_evaluate` com `function: "() => { (0, eval)(localStorage.getItem('__tecapi')); return TecAPI.versao }"`.
4. Chamadas: `browser_evaluate` com `function: "async () => await TecAPI.contar('OBJETIVA', [{tipo:'BANCA', id:4}])"`. Devolva só o necessário (use `.map`/`.slice`); respostas grandes gastam contexto.

## Fluxo A: montar a pasta de um concurso
1. **Ler o edital** (PDF/texto do usuário ou nota do cofre): cargo, banca, data da prova, provas (P1, P2, discursiva) com pesos, número de itens e conteúdo programático por matéria.
2. **Perguntar ao usuário** só o que não estiver no pedido e não tiver padrão: se quer discursivas, nome da pasta. Período: padrão de 10 anos com redução automática (ver Regras).
3. **Guia primeiro:** `await TecAPI.buscarGuias('<órgão ou sigla>')`. Se houver guia do edital (`editalUrl`), abra `/guias/<editalUrl>` (`TecAPI.lerPaginaEdital()` lista os cargos), depois a página do cargo (`TecAPI.lerPaginaCargo()` dá o link "Ver detalhes" de cada caderno-guia). Para cada link, `await TecAPI.assuntosDoGuia(link)` devolve os ids de assunto do índice que o TEC montou para o edital (`assuntos`, `materias`, `falhas`). Use esses ids no plano; resolva as `falhas` à mão com `buscarAssuntos`. O caderno "Inéditas" do guia não vira filtro (são questões próprias do TEC); ofereça salvá-lo pronto. Os totais do guia não batem com os do plano (o guia tem critérios próprios); vale a contagem do plano.
4. **Escolher os assuntos de cada matéria do edital:**
   - `TecAPI.buscarAssuntos('<palavra-chave do edital>')` procura em todas as matérias do TEC; `TecAPI.listaAssuntos(idMateria)` dá a árvore com caminho.
   - A matéria do edital nem sempre é a do TEC (ex.: "sistemas eleitorais" está em Direito Eleitoral, não em Ciências Políticas). Monte por **assunto**.
   - Descarte o que a busca trouxer de outros entes (constituições estaduais, regimentos de outras casas, decretos estaduais) e o que o edital não pede.
   - Só use a matéria inteira (`materias:[id]`) quando o edital cobrir a matéria toda.
5. **Montar o plano** em JSON (modelo em `scripts/exemplo_plano.json`): um caderno por matéria do edital, mais um de discursivas se pedido.
6. **Contar sem gravar:** `await TecAPI.contarPlano(plano)`. Mostre ao usuário uma tabela: caderno, bancas, período final (`anos`), sem reserva, com reserva, total. **Peça confirmação antes de criar qualquer coisa.**
7. **Criar:** `await TecAPI.garantirPasta('<nome>')` (reaproveita se já existir) → para cada caderno do resultado:
   1. `const c = TecAPI.urlFiltroCurta(item.formato, item.filtros)`: URL com bancas, anos, opções e só os temas que cabem (URL longa dá **403** no TEC). Guarde `c.resto` (ex.: `localStorage.setItem('__resto', JSON.stringify(c.resto))`) e `browser_navigate` para `https://www.tecconcursos.com.br` + `c.url`.
   2. Recarregar a biblioteca; se houver resto, `TecAPI.completarFiltros(resto)`. Esperar (2–5 s) até `TecAPI.estadoGerador()` ter `pronto: true` e **`encontradas` igual ao `total` do plano**. Se não bater, pare e investigue; não gere.
   3. `TecAPI.prepararGerador('<nome do caderno>', idPasta, true)`: preenche nome e pasta e clica em Gerar (o formulário vai por POST com todos os filtros no corpo).
   4. Esperar a URL `/questoes/cadernos/<id>`, recarregar a biblioteca, `TecAPI.idCadernoDaUrl()`.
   5. Conferir: `TecAPI.converterFiltrosGravados(await TecAPI.filtrosCaderno(id))` deve ter os mesmos filtros (a ordem muda) e a mesma quantidade, e `TecAPI.itensPasta(idPasta)` deve listar o caderno.
8. Relatar ao usuário a pasta, os cadernos (id, nome, questões) e o que ficou de fora.

### Regras de filtro
- **Período (regra do usuário):** padrão **últimos 10 anos** (`padrao.anos: {ultimos: 10}` = ano atual e os 9 anteriores). Se o caderno ficar **muito acima de 1.000 questões** (mais de `alvo × tolerancia`, padrão 1.000 × 1,3), `contarPlano` **encurta o período sozinho**, um ano por vez a partir do mais antigo, e fica com o total mais próximo de 1.000 (`item.anos`, `item.reducao` mostra cada passo). Não perguntar antes de reduzir; só informar o período final de cada caderno. Se o usuário pedir outro período, use-o no lugar dos 10 anos.
- **Bancas de reserva** quando um caderno ficar com poucas questões (`reserva.minimo`): Cebraspe → Quadrix (125), estilo parecido; reserva geral FCC (3); se a banca do concurso for FCC, Cebraspe (4) de reserva, porque o Certo/Errado é bom para estudar. Para discursivas, FCC e FGV (5) costumam completar. Sempre mostrar o antes e depois.
- **Discursivas:** costumam ser poucas; use `anos: null` (sem filtro de ano) e reserva FCC/FGV. Os assuntos de um guia são de objetivas e trazem poucas discursivas; prefira as matérias inteiras ligadas à prova discursiva (ex.: Ciência Política 103, Redação Oficial 26) mais os assuntos-chave.
- **Ordem:** primeiro a reserva (se faltar questão nos 10 anos), depois a redução de período (se sobrar). Um caderno com 1 ano e ainda muito acima de 1.000 fica assim mesmo; avise.
- **Sempre** `REMOVER_ANULADAS` e `REMOVER_DESATUALIZADAS` nas objetivas (padrão da biblioteca). Em discursivas o TEC ignora essas opções e não as grava; `contarPlano` já as retira.
- **Lógica do TEC:** filtros do mesmo grupo somam (OU), grupos diferentes cruzam (E). **Matéria e assunto são o mesmo grupo**: `materias:[103]` + `assuntos:[406]` = questões da matéria **ou** do assunto.
- **Nomes dos cadernos** por prioridade de estudo: `01. [P2] Linguística`, `02. [P2] Processo Legislativo`, ..., `08. [P1] Inglês`, `09. [P3] Discursivas`. Ordem pelo peso da prova (P2 antes de P1 quando a P2 decide) e pelo número de itens.
- IDs comuns: bancas CEBRASPE 4, FCC 3, FGV 5, VUNESP 6, CESGRANRIO 7, QUADRIX 125. Formatos `OBJETIVA`, `DISCURSIVA`, `OBJETIVA_INEDITAS`.

## Fluxo B (preferido para baixar cadernos): imprimir em PDF com gabarito
Pedido do usuário. É a função "Imprimir" do caderno, em lotes de até 200 questões, com gabarito junto de cada questão. Testado em 16/11/2026: 5 lotes de 200, layout igual ao dos PDFs que o usuário já tinha.
1. **Saldo:** o TEC permite **1.000 questões impressas por dia** por conta. `await TecAPI.saldoImpressao(idCaderno)`. Planeje os lotes pelo saldo: `001-200`, `201-400`, ... e o último do dia ajustado ao que sobrar (ex.: saldo 150 → `801-950`). O resto fica para o dia seguinte; diga ao usuário o que faltou.
2. **Para cada lote**, numa página do TEC (ex.: `/questoes/cadernos/<id>/configurar-impressao`): `await TecAPI.imprimirLote(idCaderno, inicio, quantidade)`. Aguardar `TecAPI.estadoImpressao()` com `pronto: true` e `questoes` igual a `esperado` (10–15 s para 200). `alerta` preenchido ou HTTP 409 = limite diário; pare.
3. `TecAPI.salvarImpressao('<nome>.html')` baixa o HTML do lote (pasta Downloads em modo extensão).
4. **PDF:** fora do navegador, com o Chrome do PC: `chrome --headless=new --disable-gpu --no-pdf-header-footer --user-data-dir=<pasta temporária> --virtual-time-budget=15000 --print-to-pdf="<destino>.pdf" "file:///<Downloads>/<nome>.html"`.
5. **Nome e pasta:** seguir o padrão da pasta do projeto, com nome curto e a numeração: `Caderno <Matéria curta> - 001-200.pdf` (3 dígitos até 999; depois `1001-1200`). Salve na pasta `questoes/` do projeto de estudos correspondente.
6. **Conferir:** cada PDF com o número de questões do lote, todas com "Gabarito", sem ids repetidos entre lotes.
- O QR code do cabeçalho pode sair quebrado (imagem que exige sessão); não afeta as questões.
- Não abrir o formulário com o botão "Imprimir caderno" (abre o diálogo de impressão do Chrome, que trava a automação).

## Fluxo C: extrair questões pela API (fórum, resolução da banca, comentário do professor)
Use quando precisar do fórum ou do texto completo de comentários. Atenção ao **limite de ritmo**: chamadas rápidas demais (≈ 25 questões em 35 s) levam **HTTP 405**, e o site recarrega a página para pedir verificação. O job usa 2,5 s por questão, pausa 3 min ao receber 405 e para depois de 3 pausas. CAPTCHA, se aparecer, é do usuário.
1. **Ids das questões:**
   - de um caderno gerado por filtro: `await TecAPI.idsDoCaderno(idCaderno, 'DISCURSIVA')` (cadernos de Guia não guardam filtros: use os filtros do plano);
   - de um filtro: `await TecAPI.idsQuestoes('OBJETIVA', filtros)`.
   Teste com 5 a 10 ids antes de um lote grande.
2. **Iniciar em segundo plano** (não estoura o tempo do `browser_evaluate`): `TecAPI.iniciarExtracao(ids, {forum: 3, nomeArquivo: 'discursivas-concurso', titulo: 'Discursivas Concurso 2026'})`. O `nomeArquivo` identifica o job; cada questão é gravada no IndexedDB do site assim que extraída.
3. **Acompanhar:** `TecAPI.statusExtracao()` a cada 30–60 s (cerca de 1 s por questão; 1.000 questões ≈ 15–20 min). Deixe a aba do TEC em primeiro plano e não navegue nela: o Chrome pode descartar ou recarregar abas em segundo plano. **Se a página recarregar** (`statusExtracao()` diz que não há job), recarregue a biblioteca e chame `TecAPI.retomarExtracao('<nomeArquivo>')`: ele pula o que já foi gravado. `await TecAPI.resumoExtracao('<nome>')` conta gabaritos, comentários, resoluções e fórum.
4. **Arquivos:** ao terminar, a página baixa `<nomeArquivo>-<data>.json` e `.md` (na ordem dos ids). Com o Playwright MCP em modo `--extension` eles vão para a pasta Downloads do Chrome do usuário (`%USERPROFILE%\Downloads`, conferido em 16/11/2026); sem extensão, para a pasta de saída do Playwright MCP. Para baixar de novo: `await TecAPI.exportarExtracao('<nome>')`. Sem download possível: `{baixar: false}` e `await TecAPI.resultadosExtracao('<nome>', 0, 10)`, gravando do seu lado. Depois de conferir os arquivos, `await TecAPI.limparExtracao('<nome>')` libera o espaço.
5. Uma questão isolada: `await TecAPI.extrairQuestao(id, {forum: 3})`.

O que vem em cada questão (`extrairQuestao`):
- `enunciado` e `alternativas` em texto; `tipo` (`MULTIPLA_ESCOLHA`, `CERTO_ERRADO`, `QUESTAO_DISCURSIVA`, `PECA_TECNICA`, `REDACAO_DISSERTACAO`).
- **Gabarito** (objetivas): letra `A`–`E` ou `Certo`/`Errado`, vindo de `GET /questoes/<id>/desempenho` → `desempenho.alternativaCorreta` (1 = primeira alternativa; em C/E 1 = Certo, 2 = Errado). Inclui `acertoGeral` (%) e `dificuldade`. Anulada sem gabarito sai `"Anulada"`.
- **Comentário do professor** (`possuiComentario`): `GET /questoes/<id>/comentario` → texto e nome do professor. Comentário de IA só com `{comentarioIA: true}`.
- **Resolução da banca** (discursivas com `possuiResolucaoDaBanca`): padrão de resposta completo.
- **Fórum**: todas as páginas, ordenado por votos; `forum.professor` traz os posts de professor/administrador; `forum.melhores` os N alunos mais votados.

## Proibido
- `POST /questoes/<id>/comentario/<TIPO>/solicitar` (pede comentário ao professor em nome do usuário).
- `PUT /questoes/<id>/resolucao` (registra resposta e mexe nas estatísticas do usuário).
- Excluir pastas ou cadernos, ou mexer nas pastas existentes do usuário, sem pedido explícito. Criar sempre em pasta nova ou na pasta que o usuário indicar.

## Armadilhas
- URL de filtro com muitos assuntos (≳ 2.000 caracteres) dá **403 Forbidden**: use sempre `urlFiltroCurta` + `completarFiltros`.
- `POST /questoes/filtros` devolve 100 ids por página (páginas a partir de 1); `idsQuestoes`/`idsDoCaderno` já paginam.
- Excluir cadernos (só com pedido do usuário): `TecAPI.post('/cadernos/multiple-delete', {cadernos: [ids]})` → vão para a lixeira de cadernos do TEC.
- Listas na API vão achatadas (`filtros[0].tipo`); a biblioteca já faz isso. Array aninhado é ignorado em silêncio e a contagem volta o total do site.
- A pasta de destino padrão do gerador é a pasta ativa do usuário: `prepararGerador` troca pela pasta pedida; confira em `estadoGerador().pasta`.
- Gerar caderno navega a página (POST de formulário): depois, recarregue a biblioteca.
- `numeroPosts` existe em objetivas e discursivas; não depender de outro campo para saber se há fórum.
- O fórum só aceita `ordenarPor` `data` ou `pontos`; outros valores dão erro.
- Respostas da API podem vir com o objeto `$http` (`{data, status}`) ou o JSON direto; a biblioteca trata os dois.
