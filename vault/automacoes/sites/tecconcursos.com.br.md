---
titulo: Mapa do site tecconcursos.com.br
categoria: automacoes
tags: [automacao, mapa-de-site, tecconcursos, selenium, api]
atualizado: 2026-11-16
resumo: API interna (/api) para pastas, cadernos, catálogos (matérias, assuntos, bancas, anos), contagem e geração de cadernos por URL; Guias por edital; discursivas (tipo, resolução da banca) e fórum. Conferido ao vivo em 16/11/2026. Estrutura AngularJS e seletores da interface.
---

# 🗺️ tecconcursos.com.br

Conferido ao vivo no Chrome do usuário (Claude in Chrome) em 16/11/2026, conta com Plano Avançado.

## Entrada
- **URL:** `https://www.tecconcursos.com.br/questoes/filtrar` (filtro), `/questoes/pastas` (pastas), `/guias/` (guias por edital).
- **Login:** formulário próprio (`/login`), feito pela pessoa. Perfil persistente `~/.automacoes/perfis/tecconcursos`.
- **Sessão logada:** `nav#header-menu.logado` ou `#secao-principal.logado`.
- **Front:** AngularJS 1.4.4 + jQuery 1.11. Scripts em `/js/angular/*.js` (versão no `?v=`, ex. 15.2.115).

## Regra de ouro: usar a API interna
Toda a tela chama `/api/...` pelo serviço Angular `tec`. Na página logada:
```js
const tec = angular.element(document.querySelector('.ng-scope')).injector().get('tec');
const D = r => (r && r.data !== undefined) ? r.data : r;   // algumas versões devolvem o JSON direto
await tec.apiGet('/materias');                // GET  /api/materias
await tec.apiPost('/pastas-cadernos', {nome}); // POST /api/pastas-cadernos (form-urlencoded)
```
- `apiGet/apiPost(url, params)` → `"/api" + url`. **`apiPut`/`apiDelete` são POST com `_method=put|delete`.**
- Corpo é `application/x-www-form-urlencoded`. **Listas vão achatadas**: `filtros[0].tipo=MATERIA&filtros[0].id=103` (um array JS aninhado é ignorado em silêncio e a contagem volta o total do site).
- Fora do navegador (requests/httpx): mesmos endpoints com os cookies da sessão do perfil. Não testado fora do navegador.

## Catálogos (só leitura)
| Endpoint | Parâmetros | Retorno |
|---|---|---|
| `GET /api/enums/grupos-filtro` | – | `MATERIAS_ASSUNTOS, BANCAS, ORGAOS_CARGOS, ANOS, AREAS, ESCOLARIDADES, PROFISSOES (Formação), ESFERAS (Região), FAVORITAS, ENUNCIADOS, QUESTOES (Opções)` |
| `GET /api/materias` | `formato`, `universo` (vazio) | `{materias:[{id,nome}]}` (145 objetivas, 143 discursivas) |
| `GET /api/assuntos` | `universo:'', formato, materia:<id>, hierarquico:true` | árvore `{assuntos:[{id,nome,hierarquia:"02.01",indice,contagem,subTree:[...]}]}` |
| `GET /api/assuntos` | `universo:'', formato, nome:'<texto>', hierarquico:false` | **busca por nome em todas as matérias**: `{assuntos:[{id,nome,materia:{nome},hierarquia,descendentes}]}` |
| `GET /api/bancas` | `formato, universo` | `{bancas:[{id,nome,sigla,url,bancaOculta}]}` (582) |
| `GET /api/orgaos` / `GET /api/cargos` | `formato, universo` (+ `orgao`, `nome`) | órgãos; cargos por órgão ou por nome |
| `GET /api/anos` | `formato, universo` | `{anos:[2026, 2025, ... 1989]}` |
| `GET /api/enums/areas`, `/enums/escolaridades`, `/profissoes`, `/esferas` | | demais grupos |

IDs conferidos: matérias Ciências Políticas 103, Direito Constitucional 2, Língua Portuguesa 3, Redação Oficial 26. Bancas **CEBRASPE 4, FCC 3, FGV 5, VUNESP 6, CESGRANRIO 7, QUADRIX 125**. Assuntos: Sistemas Eleitorais 3915 (Dir. Eleitoral), Partidos Lei 9.096 3925, Partidos art. 17 CF 3187, Processo Legislativo art. 59 CF 406, Fases do Processo Legislativo 3246.

## Filtros
- **Formatos:** `OBJETIVA`, `OBJETIVA_INEDITAS`/`INEDITAS`, `DISCURSIVA`.
- **Tipos de filtro** (`filtros[i].tipo`): `MATERIA`, `ASSUNTO`, `BANCA`, `ANO`, `ORGAO`, `CARGO`, ..., `FILTRO_QUESTAO` com id `REMOVER_ANULADAS` / `REMOVER_DESATUALIZADAS`.
- **Lógica:** mesmo grupo soma (OU); grupos diferentes cruzam (E). **MATERIA e ASSUNTO são o mesmo grupo** (Matéria e assunto): Cebraspe + matéria 103 = 1.050, + assunto 406 = 16, os dois juntos = 1.066 (conferido em 16/11/2026). Ex. (16/11/2026, 3 assuntos de sistemas eleitorais/partidos): qualquer banca 1.089; Cebraspe 317; Cebraspe 2017–2026 90; Cebraspe+Quadrix 2017–2026 105; + remover anuladas/desatualizadas 88.
- **Contar sem gerar:** `POST /api/questoes/contagem/filtros` com `universo:'', formato, gerarEmSerie:false, caderno:'', filtros[i].tipo/id` → `{"int": N}`.
- **Listar ids das questões:** `POST /api/questoes/filtros` com `formato, universo:'', pagina:'', filtros[...]` → `{questoes:[id,...]}`.
- A busca por nome devolve assuntos de outros entes (constituições estaduais, regimentos de outras casas, decretos estaduais). **Escolher só os pertinentes ao edital**; não pegar a lista inteira.
- A matéria do TEC nem sempre coincide com a do edital: "Ciências Políticas" (103) tem só 4 assuntos de topo; sistemas eleitorais e partidos estão em Direito Eleitoral e Direito Constitucional. Montar o caderno por **assunto**, buscando por palavra-chave do edital.

## Pastas (`/questoes/pastas`)
| Ação | Endpoint | Interface |
|---|---|---|
| Listar | `GET /api/pastas-cadernos/` (`buscarSubpastas:true`) → `{pastas:[{id,nome,ativa,imagemUuid,qtdCadernos}]}` | cards |
| Criar | `POST /api/pastas-cadernos` `{nome}` → `{pasta:{id,nome}}`; nome repetido dá erro "Já existe uma pasta com esse nome." | `#nova-pasta` (`vm.criarNovaPasta()`) → modal Alertify `.alertify input.ajs-input` + `button.ajs-ok` |
| Itens | `GET /api/pastas-cadernos/<id>/itens` `{ordenacao:'nome', paginar:true, pagina:1}` → `{itens:[{id,nome,quantidadeItens,formatoQuestoes,cadernoGuia,finalizado,subpasta,...}]}` | |
| Subpasta | `POST /api/pastas-cadernos/<id>/subpastas` `{nome}`; itens em `/pastas-cadernos/<id>/subpastas/<idSub>` | |
| Renomear / excluir | `apiPut /pastas-cadernos/<id> {nome}` / `apiDelete /pastas-cadernos/<id>` | excluir pede digitar `APAGAR PASTA` |
| Buscar caderno | `GET /api/cadernos/pesquisarPorNome {nomeCaderno}` | `#valor-busca` + `#buscar` |
| Cadernos | `apiPut /cadernos/<id> {nome}` (renomear), `POST /cadernos/multiple-delete {cadernos}`, `POST /cadernos/unir-cadernos`, `POST /cadernos/multiple-set` (mover) | |

## Gerar caderno (testado em 16/11/2026)
**Caminho que funciona: filtros pela URL + formulário da página.**
1. Abrir `/questoes/filtrar?formato=<FORMATO>&f[0].tipo=<TIPO>&f[0].id=<ID>&f[1].tipo=...` → a página carrega todos os filtros ("Filtros ativos: N") e mostra "N questões encontradas" em `.gerador-filtrador-resultado`.
2. Nome: `#nomeCadernoId` (máx. 150, `ng-model-options updateOn: blur` → digitar e sair do campo com Tab).
3. Pasta: `select#pastaCadernosId` (ng-options por nome; **o padrão é a pasta ativa do usuário**, trocar sempre). Conferir em `angular.element(select).scope().vm.pastaCadernosAtual.id`.
4. Botão `Gerar Caderno` (`vm.gerarCaderno()`, desabilitado sem nome ou com 0 questões).
5. A página vai para `/questoes/cadernos/<idCaderno>`; o id está na URL.

- Sem "Gerar cadernos em série", o caderno sai por **POST de formulário HTML** (`#geradorForm`, `action=""`, jQuery `.submit()`): XHR não vê e o evento `submit` não dispara. Com "em série" (`.caderno-em-serie`, `vm.gerarEmSerie`) vai por `POST /api/cadernos/gerar-caderno` com `$("#geradorForm").serializeToJSON()` (não testado).
- **Conferir o que foi gravado:** `GET /api/cadernos/<id>/configuracoes/filtros` → `{grupos:[{quantidadeQuestoes, filtros:[{codigo:"Banca_4", descricao:"Banca: CEBRASPE (CESPE)", tipo, id}]}]}`. Cadernos salvos de Guia vêm `{}`.

## Guias por edital (`/guias/`)
- O TEC já monta cadernos por cargo para editais grandes. **Conferir antes de montar filtros na mão.**
- API: `GET /api/guias/destaques`, `/guias/recentes {pagina}`, `/guias/carreira {pagina}`, `/guias/busca {pagina, busca, bancas, areas}` → `[{editalId, editalUrl, editalAno, orgaoSigla, orgaoUuid, quantidadeCargos, bancaSigla, menorDataProva, ...}]`.
- Página do edital `/guias/<editalUrl>` (ex. `cam-dep-2026-02`) → links `Acessar` por cargo: `/guias/<editalUrl>/<cargo>/<especialidade>/<sub|->`.
- Página do cargo: "Cadernos por matéria" por prova (Conhecimentos Básicos, Específicos), cada um com questões, botão `Salvar` (`vm.salvarCaderno(cadernoGuia)`) ou `Abrir` (`/questoes/cadernos/<id>` se já salvo) e `Ver detalhes`.
- `Ver detalhes` = índice do caderno-guia em `div.caderno-guia-arvore-indice`: `ul > li > span` (nome) + `span.capitulo-questoes` (contagem), níveis em `ul.sub-arvore`. É o mapeamento edital → assuntos feito pelo TEC; os nomes batem com `/api/assuntos`.

## Questões, discursivas e comentários
| Endpoint | Retorno |
|---|---|
| `GET /api/questoes/<id>` | `{questao:{idQuestao, enunciado(html), alternativas, nomeMateria, idMateria, bancaSigla, orgaoSigla, cargoSigla, concursoAno, formatoQuestao, tipoQuestao, anulada, possuiComentario, possuiComentarioIA, possuiComentarioVideo, possuiResolucaoDaBanca, numeroPosts, ...}}` |
| `GET /api/questoes/<id>/resolucao-banca` | `{resolucaoDaBanca:{textoResolucao(html), nomeBanca, siglaBanca}}` (padrão de resposta da discursiva) |
| `GET /api/questoes/<id>/desempenho` | **gabarito**: `{desempenho:{alternativaCorreta, dificuldade, desempenhoGeral:{acertos, erros, alternativa1..5}}}`. `alternativaCorreta` começa em 1 (índice em `alternativas`); em `CERTO_ERRADO` 1 = Certo, 2 = Errado. Conferido com o comentário do professor em 7 questões (16/11/2026) |
| `GET /api/questoes/<id>/comentario` | **comentário do professor** (se `possuiComentario`): `{comentario:{textoComentario(html), nomeProfessor, fotoProfessor, urlProfessor, dataPublicacaoComentario}}`. Variantes `/comentario-ia` e `/comentario-video` |
| `GET /api/questoes/<id>/detalhes` | prova, número da questão, dificuldade, órgão |
| `GET /api/discussoes/<id>/comentarios-alunos` `{ordenarPor:'pontos'|'data', pagina:N}` | `{comentarios:{pageComentarios:{list:[{id, apelidoUsuario, comentario(html), quantidadeVoto, pontos, professor, administrador, censurado, dataPublicacao}], pageSize:50, totalPages}}}`. `pontos` = mais votados; outros valores dão erro. `totalPages` vem 0 quando cabe em uma página: paginar enquanto `list.length == pageSize` |
| `GET /api/questoes/<id>/solicitacoes-comentario` | pedidos de comentário do professor |
| **Proibido** `POST /api/questoes/<id>/comentario/<TIPO>/solicitar` e `PUT /api/questoes/<id>/resolucao` | o primeiro pede comentário ao professor em nome do usuário; o segundo registra resposta nas estatísticas |

- **`tipoQuestao` nas discursivas:** `QUESTAO_DISCURSIVA`, `PECA_TECNICA`, `REDACAO_DISSERTACAO`. Serve para separar treino de questão (20 linhas) e de peça.
- Em 32 discursivas de teste: resolução da banca em ~metade, comentário de professor em nenhuma; o fórum tinha de 1 a 8 posts.
- `numeroPosts` também existe nas objetivas (ex. 13 e 25 posts). A skill antiga do Gemini lia outro campo, achava `None` e pulava o fórum.
- Teste da TecAPI v2 (16/11/2026): 8 discursivas + 8 objetivas em 13 s, sem erro: gabarito 8/8, comentário do professor 7, resolução da banca 5, fórum 16/16 (top votos 118/13/11, 137/127/90).
- Caderno aberto (`/questoes/cadernos/<id>`): abas Questões, Índice, Estatísticas, Configurações. Navegação: `vm.questaoSeguinte`, `vm.questaoAnterior`, `vm.abrirQuestaoPorNumero()`, `apiPut /cadernos/<id>/questao-atual {numeroQuestaoAtual}`. Complementos: `vm.abrirComplemento('discussao'|'comentario'|'banca'|'detalhes'|'desempenho')`.
- Questão sem login: `GET /api/questoes/<id>/deslogado`.

## Impressão do caderno (16/11/2026)
- Tela: `/questoes/cadernos/<id>/configurar-impressao`. Form `action="imprimir"` (POST, `target=_blank`) com `configuracoes.idCadernoQuestoes`, `numeroQuestoes` (máx. 200), `questaoSequencial=true`, `questaoInicial`, `gabaritoImpresso` (`CONSOLIDADO` | `JUNTO_QUESTAO` | `SEM_GABARITO`), `cabecalhoQuestoes` (`COMPLETO`…), `tamanhoFonte`, `removerQuestoes` (`NENHUMA`|`RESOLVIDAS`|`ACERTADAS`|`NAO_FAVORITAS`), `imprimirTextoAssociado`, `espacoRascunho`, `linhasRascunho`, `qrCodeQuestoes`.
- A resposta é um molde (`imprimir.js`, jTemplates) que busca as questões por AJAX, monta, roda o MathJax e chama `window.print()` no fim. O **saldo diário (1.000 questões)** é gasto nesse carregamento; HTTP 409 = limite atingido. O texto "Você tem um saldo de N questões para impressão hoje" fica na tela de configuração.
- Automação: carregar o HTML num iframe com `window.print` trocado (sinal de pronto), clonar sem scripts com CSS embutido, baixar e converter com Chrome headless (`--print-to-pdf`). O PDF sai igual ao impresso pela interface; scripts locais de extração de PDF leem sem ajuste.
- `util.js`: HTTP 405 em chamada AJAX → `location.reload()` (comentado como "captcha"). Disparado por ritmo alto de chamadas à API.

## Regras para o assistente de filtros (pedido do usuário, 16/11/2026)
- **Guia primeiro:** se `/guias/busca` achar o edital, usar os cadernos-guia (ou o índice deles como base de assuntos); senão, montar por assunto a partir do edital.
- **Perguntar o período.** Ex.: "últimos 10 anos" = ano atual e os 9 a 10 anteriores (2017–2026 em 2026) como filtros `ANO`. **Sempre verificar a contagem antes de gerar** (`POST /api/questoes/contagem/filtros`): quando passar muito de **1.000 questões**, reduzir progressivamente para os anos mais atuais (5 anos `2022–2026`, 3 anos `2024–2026`, 2 anos `2025–2026`) até chegar a um volume razoável.
- **Bancas parecidas quando faltar questão** num assunto: Cebraspe → Quadrix (estilo parecido); reserva geral FCC; se a banca do concurso for FCC, Cebraspe de reserva (C/E é bom para estudar). Mostrar a contagem antes e depois de somar a reserva.
- Remover anuladas e desatualizadas por padrão.
- Um caderno por matéria do edital; discursivas em caderno separado, filtrando por tipo de peça quando a prova pedir.

## Interface
| Elemento | Seletor | Observação |
|---|---|---|
| Expandir filtros | `#mostrar-filtros` | só clicar se o rótulo for "Expandir" |
| Limpar filtros | `a.gerador-filtrador-cabecalho-limpar` | abre `confirm` nativo: redefinir `window.confirm` |
| Formato | radios no topo ("Objetivas (todas)", "Objetivas (inéditas)", "Discursivas") | trocar formato limpa os filtros |
| Abas de filtro (desktop) | `.gerador-conteudo-filtros li.menu-alternador-opcao[title='Matéria e assunto']` | `li.grupo-filtro` é o mobile, oculto |
| Busca na árvore | `a[ng-click*='exibirBusca']` → `input[name='campoPesquisa']` | lista virtualizada: sem busca só ~25 itens no DOM |
| Item da árvore | `.arvore-item-conteudo`; pasta `.arvore-item-pasta`; "Todo o conteúdo de ..." = `li.arvore-item-selecionar-tudo` | clicar em pasta aberta fecha |
| Opções | links "Remover anuladas" / "Remover desatualizadas" no painel de filtros ativos | |
| Questões encontradas | `.gerador-filtrador-resultado` | duplicado desktop/mobile |
| Questão | `#container-questoes .questao[data-tec-agent-questao-id]`, `article.questao-enunciado`, `li.questao-enunciado-alternativa` | |
| Fórum | `button[aria-label='Fórum de discussão da questão']` | |
| Próxima | `button.questao-navegacao-botao-proxima` | esperar troca de `data-tec-agent-questao-id` |
| Desempenho / gabarito C/E | `.questao-complementos-desempenho .detalhes-resolucoes-legenda-item` com `span.legenda-acertos` | nunca deduzir pela palavra "Certa" |

## Armadilhas
- (16/11/2026) Arrays aninhados nos parâmetros da API são ignorados sem erro: achatar `filtros[i].tipo/id`.
- (16/11/2026) Em `DISCURSIVA`, `REMOVER_ANULADAS/REMOVER_DESATUALIZADAS` são ignorados: não mudam a contagem e não ficam gravados no caderno.
- (16/11/2026) Com o Playwright MCP em `--extension`, downloads disparados pela página vão para `%USERPROFILE%\Downloads`. Skill testada pelo agy de ponta a ponta (TecAPI v3).
- (16/11/2026) A geração normal de caderno é POST de formulário com navegação: não dá para capturar por XHR nem pelo evento `submit`. Ler o id na URL de destino e os filtros em `/configuracoes/filtros`.
- (16/11/2026) A pasta de destino padrão é a pasta ativa do usuário; esquecer de trocar grava o caderno na pasta errada.
- (16/11/2026) `GET /api/pastas-cadernos/<id>` marca a pasta como `ativa`.
- (16/11/2026) Trocar o formato (Objetivas/Discursivas) limpa os filtros; montar a URL já com o `formato` certo.
- (13/11/2026) Confirmação nativa ao limpar/trocar filtros; listas virtualizadas; duplicação desktop/mobile; painel recolhido (`.gerador-conteudo.esconder`); gabarito C/E pela legenda de acertos.

## Projetos que usam este site
- Skill **`tec-concursos`** (`agent-kit/skills/tec-concursos`, 16/11/2026): Playwright MCP + `scripts/tec_api.js` (objeto `TecAPI`, recarga pelo `localStorage`, extração em segundo plano com download JSON/MD), plano de exemplo e referência para Selenium. Substitui a versão de um arquivo só criada pelo Gemini. Notas de edital: [[automacoes/tec_concursos_assistente]].
