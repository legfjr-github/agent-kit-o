/*
 * TecAPI v2: API interna do TEC Concursos (/api/...) usada pela página logada.
 *
 * Como carregar (Playwright MCP, browser_evaluate), numa página do TEC já logada:
 *   1ª vez na sessão: function = "() => { <conteúdo deste arquivo> ; return TecAPI.versao }"
 *   depois de navegar: function = "() => { (0, eval)(localStorage.getItem('__tecapi')); return TecAPI.versao }"
 * A biblioteca se guarda no localStorage do site, então a recarga é uma linha.
 *
 * Só leitura, exceto: criarPasta/garantirPasta/criarSubpasta, prepararGerador(..., true) e renomearCaderno.
 * NUNCA chamar /questoes/<id>/comentario/<TIPO>/solicitar (pede comentário ao professor)
 * nem PUT /questoes/<id>/resolucao (registra resposta nas estatísticas do usuário).
 * Mapa: cofre automacoes/sites/tecconcursos.com.br.md
 */
(function fabricaTecAPI() {
  var VERSAO = 7;
  try { localStorage.setItem("__tecapi", "(" + fabricaTecAPI.toString() + ")()"); } catch (e) { /* sem storage */ }

  // ------------------------------------------------------------------ base
  function servico() {
    if (!window.angular) throw new Error("Página sem AngularJS: abra uma página do TEC logado (ex.: /questoes/pastas).");
    var el = document.querySelector(".ng-scope") || document.body;
    return window.angular.element(el).injector().get("tec");
  }
  function dados(r) { return r && r.data !== undefined && r.status !== undefined ? r.data : r; }
  function achatar(filtros, base, prefixo) {
    var p = Object.assign({}, base || {});
    (filtros || []).forEach(function (f, i) {
      p[(prefixo || "filtros") + "[" + i + "].tipo"] = f.tipo;
      p[(prefixo || "filtros") + "[" + i + "].id"] = f.id;
    });
    return p;
  }
  async function get(url, params) { return dados(await servico().apiGet(url, params || {})); }
  async function post(url, params) { return dados(await servico().apiPost(url, params || {})); }
  // GET direto (fetch) para a extração em lote. Motivo: o site trata HTTP 405 (limite de ritmo /
  // verificação antirrobô) recarregando a página (util.js, "//captcha"), o que mata o job. Aqui o 405
  // só marca window.__tecLimite e o job pausa; nada de contornar verificação.
  async function getDireto(url, params) {
    var qs = params ? new URLSearchParams(params).toString() : "";
    var r = await fetch("/api" + url + (qs ? "?" + qs : ""), { credentials: "include", headers: { "Accept": "application/json", "X-Requested-With": "XMLHttpRequest" } });
    if (r.status === 405 || r.status === 429) { window.__tecLimite = r.status; var e = new Error("HTTP " + r.status + " (limite do TEC)"); e.status = r.status; throw e; }
    if (!r.ok) { var e2 = new Error("HTTP " + r.status); e2.status = r.status; throw e2; }
    return await r.json();
  }
  function erroTexto(e) {
    if (e && e.status !== undefined) return "HTTP " + e.status + " " + JSON.stringify(e.data || "").slice(0, 200);
    return (e && e.message) || String(e);
  }
  function esperar(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function logado() { return !!document.querySelector("nav#header-menu.logado, #secao-principal.logado"); }

  function htmlParaTexto(html) {
    if (!html) return "";
    var d = document.createElement("div");
    d.innerHTML = String(html)
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h\d|tr)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "- ");
    return d.textContent.replace(/ /g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  // ------------------------------------------------------------------ catálogos
  async function materias(formato) { return (await get("/materias", { formato: formato || "OBJETIVA", universo: "" })).materias; }
  async function assuntosDaMateria(idMateria, formato) {
    return (await get("/assuntos", { universo: "", formato: formato || "OBJETIVA", materia: idMateria, hierarquico: true })).assuntos;
  }
  // Árvore achatada com caminho e nível, boa para escolher assuntos do edital.
  async function listaAssuntos(idMateria, formato) {
    var out = [];
    (function walk(lista, nivel, caminho) {
      (lista || []).forEach(function (a) {
        var cam = caminho.concat(a.nome);
        out.push({ id: a.id, nome: a.nome, hierarquia: a.hierarquia, nivel: nivel, caminho: cam.join(" > ") });
        walk(a.subTree, nivel + 1, cam);
      });
    })(await assuntosDaMateria(idMateria, formato), 0, []);
    return out;
  }
  async function buscarAssuntos(nome, formato) {
    var r = await get("/assuntos", { universo: "", formato: formato || "OBJETIVA", nome: nome, hierarquico: false });
    return (r.assuntos || []).map(function (a) {
      return { id: a.id, nome: a.nome, materia: a.materia && a.materia.nome, idMateria: a.materia && a.materia.id, hierarquia: a.hierarquia };
    });
  }
  async function bancas(formato, filtroNome) {
    var b = (await get("/bancas", { formato: formato || "OBJETIVA", universo: "" })).bancas;
    if (!filtroNome) return b;
    var re = new RegExp(filtroNome, "i");
    return b.filter(function (x) { return re.test(x.nome) || re.test(x.sigla || ""); });
  }
  async function anos(formato) { return (await get("/anos", { formato: formato || "OBJETIVA", universo: "" })).anos; }
  async function orgaos(formato) { return (await get("/orgaos", { formato: formato || "OBJETIVA", universo: "" })).orgaos; }
  async function cargos(idOrgao, formato) {
    return (await get("/cargos", { universo: "", formato: formato || "OBJETIVA", orgao: idOrgao, hierarquico: true })).cargos;
  }

  // ------------------------------------------------------------------ contagem e planos
  async function contar(formato, filtros) {
    var r = await post("/questoes/contagem/filtros", achatar(filtros, { universo: "", formato: formato || "OBJETIVA", gerarEmSerie: false, caderno: "" }));
    return r && r.int !== undefined ? r.int : r;
  }
  // Paginado: 100 ids por página, páginas a partir de 1 (página vazia = fim).
  async function idsQuestoes(formato, filtros) {
    var ids = [];
    for (var pagina = 1; pagina <= 200; pagina++) {
      var r = await post("/questoes/filtros", achatar(filtros, { formato: formato || "OBJETIVA", universo: "", pagina: pagina }));
      var lote = (r && r.questoes) || [];
      ids = ids.concat(lote);
      if (lote.length < 100) break;
    }
    return ids;
  }

  // Monta a lista de filtros de um caderno do plano (ver exemplo_plano.json).
  function filtrosDoCaderno(c, padrao, bancasUsadas) {
    padrao = padrao || {};
    var f = [];
    (c.materias || []).forEach(function (id) { f.push({ tipo: "MATERIA", id: id }); });
    (c.assuntos || []).forEach(function (id) { f.push({ tipo: "ASSUNTO", id: id }); });
    (bancasUsadas || []).forEach(function (id) { f.push({ tipo: "BANCA", id: id }); });
    var anosC = c.anos !== undefined ? c.anos : padrao.anos;
    if (anosC && anosC.ultimos) anosC = { de: (anosC.ate || new Date().getFullYear()) - anosC.ultimos + 1, ate: anosC.ate };
    if (anosC && anosC.de) for (var a = anosC.ate || new Date().getFullYear(); a >= anosC.de; a--) f.push({ tipo: "ANO", id: a });
    else if (Array.isArray(anosC)) anosC.forEach(function (a) { f.push({ tipo: "ANO", id: a }); });
    (c.extras || []).forEach(function (x) { f.push({ tipo: x.tipo, id: x.id }); });
    var remover = c.remover !== undefined ? c.remover : (padrao.remover !== undefined ? padrao.remover : ["REMOVER_ANULADAS", "REMOVER_DESATUALIZADAS"]);
    remover.forEach(function (id) { f.push({ tipo: "FILTRO_QUESTAO", id: id }); });
    return f;
  }

  // Intervalo de anos efetivo de um caderno ({de, ate}) ou null se não houver filtro de ano.
  function intervaloAnos(c, padrao) {
    var a = c.anos !== undefined ? c.anos : (padrao || {}).anos;
    if (!a) return null;
    var ate = a.ate || new Date().getFullYear();
    if (a.ultimos) return { de: ate - a.ultimos + 1, ate: ate };
    if (a.de) return { de: a.de, ate: ate };
    return null; // lista explícita de anos: não mexe
  }

  // Conta cada caderno do plano. Regras (pedido do usuário):
  // 1. período padrão = últimos 10 anos (padrao.anos = {ultimos: 10});
  // 2. abaixo de reserva.minimo -> soma as bancas de reserva;
  // 3. muito acima do alvo (total > alvo * tolerancia; padrão 1000 e 1.3) -> encurta o período
  //    um ano por vez (sempre terminando no ano atual) e fica com o total mais próximo do alvo.
  // Não grava nada.
  async function contarPlano(plano) {
    var padrao = plano.padrao || {};
    var res = [];
    for (var i = 0; i < plano.cadernos.length; i++) {
      var c = plano.cadernos[i];
      var formato = c.formato || plano.formato || "OBJETIVA";
      // Discursivas: o TEC ignora REMOVER_ANULADAS/DESATUALIZADAS (não grava no caderno); não enviar.
      if (formato === "DISCURSIVA" && c.remover === undefined) c = Object.assign({}, c, { remover: [] });
      var bancasBase = c.bancas || padrao.bancas || [];
      var reserva = (c.reserva || padrao.reserva || {});
      var minimo = reserva.minimo || 0;
      var item = { nome: c.nome, formato: formato, bancas: bancasBase.slice() };
      item.semReserva = await contar(formato, filtrosDoCaderno(c, padrao, bancasBase));
      item.total = item.semReserva;
      if (minimo && item.semReserva < minimo && (reserva.bancas || []).length) {
        var comReserva = bancasBase.concat(reserva.bancas.filter(function (b) { return bancasBase.indexOf(b) < 0; }));
        item.comReserva = await contar(formato, filtrosDoCaderno(c, padrao, comReserva));
        item.bancas = comReserva;
        item.total = item.comReserva;
        item.reservaAplicada = true;
      }
      var alvo = c.alvo || c.maximo || padrao.alvo || padrao.maximo || 1000;
      var tolerancia = c.tolerancia || padrao.tolerancia || 1.3;
      var faixa = intervaloAnos(c, padrao);
      if (faixa) item.anos = faixa.de + "-" + faixa.ate;
      if (faixa && item.total > alvo * tolerancia && faixa.ate - faixa.de > 0) {
        item.reducao = [{ anos: item.anos, total: item.total }];
        var melhor = { de: faixa.de, total: item.total };
        for (var de = faixa.de + 1; de <= faixa.ate; de++) {
          var cc = Object.assign({}, c, { anos: { de: de, ate: faixa.ate } });
          var t = await contar(formato, filtrosDoCaderno(cc, padrao, item.bancas));
          item.reducao.push({ anos: de + "-" + faixa.ate, total: t });
          if (Math.abs(t - alvo) < Math.abs(melhor.total - alvo)) melhor = { de: de, total: t };
          if (t <= alvo) break; // encurtar mais só afasta do alvo
        }
        c = Object.assign({}, c, { anos: { de: melhor.de, ate: faixa.ate } });
        item.anos = melhor.de + "-" + faixa.ate;
        item.total = melhor.total;
        item.periodoReduzido = true;
      }
      item.filtros = filtrosDoCaderno(c, padrao, item.bancas);
      item.url = urlFiltro(formato, item.filtros);
      res.push(item);
    }
    return res;
  }

  // ------------------------------------------------------------------ pastas e cadernos
  async function pastas() { return (await get("/pastas-cadernos/", { buscarSubpastas: true })).pastas || []; }
  async function criarPasta(nome) { return (await post("/pastas-cadernos", { nome: nome })).pasta; }
  async function garantirPasta(nome) {
    var achada = (await pastas()).filter(function (p) { return p.nome.trim().toLowerCase() === nome.trim().toLowerCase(); })[0];
    return achada ? { id: achada.id, nome: achada.nome, criada: false } : Object.assign(await criarPasta(nome), { criada: true });
  }
  async function criarSubpasta(idPasta, nome) { return await post("/pastas-cadernos/" + idPasta + "/subpastas", { nome: nome }); }
  async function itensPasta(idPasta) {
    var todos = [];
    for (var pagina = 1; pagina <= 40; pagina++) {
      var r = await get("/pastas-cadernos/" + idPasta + "/itens", { ordenacao: "nome", paginar: true, pagina: pagina });
      var itens = (r && r.itens) || [];
      todos = todos.concat(itens);
      if (itens.length < 20) break;
    }
    return todos;
  }
  async function renomearCaderno(idCaderno, nome) { return await post("/cadernos/" + idCaderno, { _method: "put", nome: nome }); }
  async function filtrosCaderno(idCaderno) { return await get("/cadernos/" + idCaderno + "/configuracoes/filtros"); }
  // "Banca_4" / "FiltroQuestao_REMOVER_ANULADAS-0" -> {tipo:"BANCA", id:4}. Cadernos de Guia não têm filtros ({}).
  function converterFiltrosGravados(cfg) {
    var mapa = { Banca: "BANCA", Materia: "MATERIA", Assunto: "ASSUNTO", Ano: "ANO", Orgao: "ORGAO", Cargo: "CARGO", FiltroQuestao: "FILTRO_QUESTAO" };
    return ((cfg && cfg.grupos) || []).map(function (g) {
      return {
        nome: g.nome, quantidade: g.quantidadeQuestoes,
        filtros: (g.filtros || []).map(function (f) {
          var idStr = String(f.id).replace(/-\d+$/, "");
          return { tipo: mapa[f.tipo] || String(f.tipo).toUpperCase(), id: /^\d+$/.test(idStr) ? Number(idStr) : idStr, descricao: f.descricao };
        })
      };
    });
  }
  async function idsDoCaderno(idCaderno, formato) {
    var g = converterFiltrosGravados(await filtrosCaderno(idCaderno));
    if (!g.length) throw new Error("Caderno " + idCaderno + " sem filtros gravados (caderno de Guia?). Use os filtros do plano.");
    var ids = [];
    for (var i = 0; i < g.length; i++) ids = ids.concat(await idsQuestoes(formato || "OBJETIVA", g[i].filtros));
    return ids;
  }

  // ------------------------------------------------------------------ gerador (/questoes/filtrar)
  function urlFiltro(formato, filtros) {
    var p = new URLSearchParams();
    p.set("formato", formato || "OBJETIVA");
    (filtros || []).forEach(function (f, i) { p.set("f[" + i + "].tipo", f.tipo); p.set("f[" + i + "].id", f.id); });
    return "/questoes/filtrar?" + p.toString();
  }
  // URLs longas (dezenas de assuntos) levam 403 do servidor. urlFiltroCurta põe na URL bancas, anos,
  // opções e só os temas que couberem (limite ~1500 caracteres); o resto vai depois por completarFiltros.
  function urlFiltroCurta(formato, filtros, limite) {
    limite = limite || 1500;
    var fixos = filtros.filter(function (f) { return f.tipo !== "ASSUNTO" && f.tipo !== "MATERIA"; });
    var temas = filtros.filter(function (f) { return f.tipo === "ASSUNTO" || f.tipo === "MATERIA"; });
    var naUrl = fixos.slice(), resto = [];
    temas.forEach(function (t) {
      if (!resto.length && urlFiltro(formato, naUrl.concat(t)).length <= limite) naUrl.push(t); else resto.push(t);
    });
    return { url: urlFiltro(formato, naUrl), resto: resto };
  }
  // Acrescenta filtros ao modelo do gerador (página /questoes/filtrar já carregada). Troca a referência de
  // vm.filtros, como o próprio site faz, para recalcular contagem e campos do formulário. Conferir depois
  // estadoGerador().encontradas e filtrosAtivos (leva alguns segundos).
  function completarFiltros(filtros) {
    var sel = document.getElementById("pastaCadernosId");
    if (!sel) throw new Error("Gerador não encontrado (#pastaCadernosId).");
    var escopo = window.angular.element(sel).scope(), vm = escopo.vm;
    var novo = {};
    Object.keys(vm.filtros || {}).forEach(function (t) { novo[t] = Object.assign({}, vm.filtros[t]); });
    var descr = { ASSUNTO: "Assunto", MATERIA: "Matéria", BANCA: "Banca", ANO: "Ano", ORGAO: "Órgão", CARGO: "Cargo", FILTRO_QUESTAO: "Opções" };
    (filtros || []).forEach(function (f) {
      novo[f.tipo] = novo[f.tipo] || {};
      if (!novo[f.tipo][f.id]) novo[f.tipo][f.id] = { id: f.id, nome: f.nome || (descr[f.tipo] || f.tipo) + " " + f.id, tipo: f.tipo, tipoDescricao: descr[f.tipo] || f.tipo, ultimaSelecao: Date.now() };
    });
    escopo.$apply(function () { vm.filtros = novo; });
    return { adicionados: (filtros || []).length };
  }

  function estadoGerador() {
    var sel = document.getElementById("pastaCadernosId");
    var res = Array.prototype.slice.call(document.querySelectorAll(".gerador-filtrador-resultado"))
      .map(function (e) { return e.textContent.replace(/\s+/g, " ").trim(); }).filter(Boolean)[0] || "";
    var m = res.match(/([\d.]+)\s+quest/i);
    var vm = sel && window.angular ? window.angular.element(sel).scope().vm : null;
    return {
      pagina: location.pathname,
      pronto: !!(vm && vm.pastasCadernos && vm.pastasCadernos.length && m),
      encontradas: m ? Number(m[1].replace(/\./g, "")) : null,
      filtrosAtivos: vm && vm.arrayFiltros ? vm.arrayFiltros.length : null,
      pasta: vm && vm.pastaCadernosAtual ? { id: vm.pastaCadernosAtual.id, nome: vm.pastaCadernosAtual.nome } : null,
      nome: vm ? vm.nomeCaderno : null
    };
  }
  // Preenche nome e pasta pelo modelo Angular e, se gerar=true, clica em Gerar Caderno.
  // A página navega para /questoes/cadernos/<id>; ler o id da URL depois.
  function prepararGerador(nome, idPasta, gerar) {
    var sel = document.getElementById("pastaCadernosId");
    if (!sel) throw new Error("Gerador não encontrado: abra a URL do filtro (urlFiltro) e espere carregar.");
    var escopo = window.angular.element(sel).scope();
    var vm = escopo.vm;
    var pasta = (vm.pastasCadernos || []).filter(function (p) { return Number(p.id) === Number(idPasta); })[0];
    if (!pasta) throw new Error("Pasta " + idPasta + " não aparece no gerador. Recarregue a página do filtro.");
    escopo.$apply(function () { vm.nomeCaderno = nome; vm.pastaCadernosAtual = pasta; });
    window.confirm = function () { return true; };
    var estado = estadoGerador();
    if (gerar) {
      if (!estado.encontradas) throw new Error("Filtro com 0 questões ou ainda carregando; não gerei.");
      var botao = Array.prototype.slice.call(document.querySelectorAll("button")).filter(function (b) {
        return /gerar caderno/i.test(b.textContent) && b.offsetParent && !b.disabled;
      })[0];
      if (!botao) throw new Error("Botão Gerar Caderno indisponível.");
      setTimeout(function () { botao.click(); }, 50);
      estado.gerando = true;
    }
    return estado;
  }
  function idCadernoDaUrl() { var m = location.pathname.match(/\/questoes\/cadernos\/(\d+)/); return m ? Number(m[1]) : null; }

  // ------------------------------------------------------------------ guias por edital
  async function buscarGuias(texto, pagina) {
    var r = await get("/guias/busca", { pagina: pagina || 1, busca: texto || "" });
    return (r && (r.list || r)) || [];
  }
  function lerPaginaEdital() {
    var vistos = {};
    return Array.prototype.slice.call(document.querySelectorAll("a")).filter(function (a) { return /acessar/i.test(a.textContent); })
      .map(function (a) {
        var href = (a.getAttribute("href") || "").replace(/^https?:\/\/[^/]+/, "");
        var bloco = a.parentElement;
        for (var i = 0; i < 5 && bloco && bloco.textContent.replace(/\s+/g, " ").trim().length < 40; i++) bloco = bloco.parentElement;
        return { url: href, texto: bloco ? bloco.textContent.replace(/\s+/g, " ").trim().slice(0, 200) : "" };
      })
      .filter(function (c) { if (!c.url || vistos[c.url]) return false; vistos[c.url] = true; return true; });
  }
  function lerPaginaCargo() {
    return Array.prototype.slice.call(document.querySelectorAll("a")).filter(function (a) { return /ver detalhes/i.test(a.textContent); })
      .map(function (a) {
        var bloco = a;
        for (var i = 0; i < 6 && bloco.parentElement; i++) {
          bloco = bloco.parentElement;
          if (/quest/i.test(bloco.textContent) && bloco.querySelector("button, a[href*='/questoes/cadernos/']")) break;
        }
        var texto = bloco.textContent.replace(/\s+/g, " ").trim();
        var abrir = bloco.querySelector("a[href*='/questoes/cadernos/']");
        var qtd = texto.match(/([\d.]+)\s+Quest/i);
        return {
          texto: texto.slice(0, 220),
          questoes: qtd ? Number(qtd[1].replace(/\./g, "")) : null,
          detalhes: (a.getAttribute("href") || "").replace(/^https?:\/\/[^/]+/, ""),
          idCadernoUsuario: abrir ? Number((abrir.getAttribute("href").match(/cadernos\/(\d+)/) || [])[1]) : null
        };
      });
  }
  function lerIndiceGuia() {
    var raiz = document.querySelector(".caderno-guia-arvore-indice");
    if (!raiz) return null;
    function nivel(ul, prof) {
      var itens = [];
      Array.prototype.slice.call(ul.children).forEach(function (filho) {
        if (filho.tagName === "LI") {
          var span = filho.querySelector(":scope > span");
          var q = filho.querySelector(".capitulo-questoes");
          itens.push({ nome: span ? span.textContent.replace(/\s+/g, " ").trim() : filho.textContent.trim(),
            questoes: q ? Number((q.textContent.match(/[\d.]+/) || ["0"])[0].replace(/\./g, "")) : null, nivel: prof, filhos: [] });
        } else if (filho.tagName === "UL" && itens.length) {
          itens[itens.length - 1].filhos = nivel(filho, prof + 1);
        }
      });
      return itens;
    }
    var ul = raiz.querySelector("ul");
    return ul ? nivel(ul, 0) : [];
  }

  // Lê por fetch o índice de um caderno-guia (URL "Ver detalhes") e converte as folhas em ids de assunto.
  // Raiz do índice = matéria do TEC; folha = assunto (casado pelo caminho na árvore, ou pelo nome se for único).
  // Os links "Ver detalhes" só aparecem renderizados: pegue-os com lerPaginaCargo() na página do cargo.
  async function assuntosDoGuia(urlDetalhes) {
    var html = await (await fetch(urlDetalhes, { credentials: "include" })).text();
    var doc = new DOMParser().parseFromString(html, "text/html");
    var raiz = doc.querySelector(".caderno-guia-arvore-indice");
    if (!raiz) throw new Error("Índice não encontrado em " + urlDetalhes);
    function nivel(ul) {
      var itens = [];
      Array.prototype.slice.call(ul.children).forEach(function (f) {
        if (f.tagName === "LI") {
          var sp = f.querySelector(":scope > span"), q = f.querySelector(".capitulo-questoes");
          itens.push({ nome: sp ? sp.textContent.replace(/\s+/g, " ").trim() : "", questoes: q ? Number((q.textContent.match(/[\d.]+/) || ["0"])[0].replace(/\./g, "")) : null, filhos: [] });
        } else if (f.tagName === "UL" && itens.length) itens[itens.length - 1].filhos = nivel(f);
      });
      return itens;
    }
    var indice = nivel(raiz.querySelector("ul"));
    var norm = function (s) { return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim(); };
    var mats = await materias("OBJETIVA");
    var out = { url: urlDetalhes, questoesGuia: 0, materias: [], assuntos: [], falhas: [] };
    for (var i = 0; i < indice.length; i++) {
      var r = indice[i];
      out.questoesGuia += r.questoes || 0;
      var m = mats.filter(function (x) { return norm(x.nome) === norm(r.nome); })[0];
      if (!m) { out.falhas.push("matéria não encontrada: " + r.nome); continue; }
      if (!r.filhos.length) { out.materias.push(m.id); continue; }
      var arv = await listaAssuntos(m.id, "OBJETIVA");
      (function w(lista, caminho) {
        lista.forEach(function (n) {
          var cam = caminho.concat(n.nome);
          if (n.filhos.length) return w(n.filhos, cam);
          var hit = arv.filter(function (a) { return norm(a.caminho) === norm(cam.join(" > ")); })[0];
          if (!hit) { var c = arv.filter(function (a) { return norm(a.nome) === norm(n.nome); }); if (c.length === 1) hit = c[0]; }
          if (hit) out.assuntos.push(hit.id); else out.falhas.push(m.nome + ": " + cam.join(" > "));
        });
      })(r.filhos, []);
    }
    return out;
  }

  // ------------------------------------------------------------------ questões
  var LETRAS = ["A", "B", "C", "D", "E"];

  // Fórum completo (todas as páginas), ordenado por votos; posts de professor sempre incluídos.
  async function forum(id, limite) {
    var todos = [];
    for (var pagina = 1; pagina <= 20; pagina++) {
      var r = await getDireto("/discussoes/" + id + "/comentarios-alunos", { ordenarPor: "pontos", pagina: pagina });
      var pc = r && r.comentarios && r.comentarios.pageComentarios;
      var lista = (pc && pc.list) || [];
      todos = todos.concat(lista);
      if (lista.length < ((pc && pc.pageSize) || 50)) break;
    }
    todos = todos.filter(function (c) { return !c.censurado && !c.usuarioExcluido; })
      .map(function (c) {
        return { id: c.id, autor: c.apelidoUsuario, votos: c.quantidadeVoto || 0, professor: !!c.professor,
          administrador: !!c.administrador, data: c.dataPublicacao && (c.dataPublicacao.$ || c.dataPublicacao), texto: htmlParaTexto(c.comentario) };
      })
      .sort(function (a, b) { return (b.professor - a.professor) || (b.votos - a.votos); });
    var prof = todos.filter(function (c) { return c.professor || c.administrador; });
    var alunos = todos.filter(function (c) { return !c.professor && !c.administrador; });
    return { total: todos.length, professor: prof, melhores: alunos.slice(0, limite === undefined ? 3 : limite) };
  }

  // Extrai uma questão completa. opcoes: {forum: 3, html: false, comentarioIA: false}
  async function extrairQuestao(id, opcoes) {
    opcoes = opcoes || {};
    var q = (await getDireto("/questoes/" + id)).questao;
    var out = {
      id: q.idQuestao, url: "https://www.tecconcursos.com.br/questoes/" + q.idQuestao,
      formato: q.formatoQuestao, tipo: q.tipoQuestao, banca: q.bancaSigla, orgao: q.orgaoSigla, cargo: q.cargoSigla,
      ano: q.concursoAno, materia: q.nomeMateria, assunto: q.nomeAssunto, idMateria: q.idMateria, idAssunto: q.idAssunto,
      anulada: !!q.anulada, desatualizada: !!q.desatualizada,
      enunciado: htmlParaTexto(q.enunciado)
    };
    if (opcoes.html) out.enunciadoHtml = q.enunciado;
    if (q.formatoQuestao !== "DISCURSIVA") {
      out.alternativas = (q.alternativas || []).map(htmlParaTexto);
      try {
        var d = (await getDireto("/questoes/" + id + "/desempenho")).desempenho || {};
        var idx = d.alternativaCorreta; // 1 = primeira alternativa; em Certo/Errado 1=Certo, 2=Errado
        out.dificuldade = d.dificuldade;
        if (idx) {
          out.gabarito = q.tipoQuestao === "CERTO_ERRADO" ? (idx === 1 ? "Certo" : "Errado") : LETRAS[idx - 1];
          out.gabaritoIndice = idx;
        } else {
          out.gabarito = out.anulada ? "Anulada" : null;
        }
        var g = d.desempenhoGeral || {};
        out.acertoGeral = g.acertos + g.erros ? Math.round(1000 * g.acertos / (g.acertos + g.erros)) / 10 : null;
      } catch (e) { out.erroGabarito = erroTexto(e); }
    }
    if (q.possuiComentario) {
      try {
        var c = (await getDireto("/questoes/" + id + "/comentario", {})).comentario || {};
        out.comentarioProfessor = { professor: c.nomeProfessor, data: c.dataPublicacaoComentario, texto: htmlParaTexto(c.textoComentario) };
      } catch (e) { out.erroComentario = erroTexto(e); }
    }
    if (q.possuiComentarioIA && opcoes.comentarioIA) {
      try {
        var ia = (await getDireto("/questoes/" + id + "/comentario-ia", {})).comentario || {};
        out.comentarioIA = htmlParaTexto(ia.textoComentario);
      } catch (e) { out.erroComentarioIA = erroTexto(e); }
    }
    out.possuiComentarioVideo = !!q.possuiComentarioVideo;
    if (q.possuiResolucaoDaBanca) {
      try {
        var rb = (await getDireto("/questoes/" + id + "/resolucao-banca")).resolucaoDaBanca || {};
        out.resolucaoBanca = htmlParaTexto(rb.textoResolucao);
      } catch (e) { out.erroResolucao = erroTexto(e); }
    }
    out.postsForum = q.numeroPosts || 0;
    if (out.postsForum > 0 && opcoes.forum !== 0) {
      try { out.forum = await forum(id, opcoes.forum === undefined ? 3 : opcoes.forum); } catch (e) { out.erroForum = erroTexto(e); }
    }
    return out;
  }

  // ------------------------------------------------------------------ exportação em segundo plano
  function paraMarkdown(questoes, titulo) {
    var L = ["# " + (titulo || "Questões TEC Concursos"), "", "Gerado em " + new Date().toLocaleString("pt-BR") + ". " + questoes.length + " questões.", ""];
    questoes.forEach(function (q, i) {
      if (q.erro) { L.push("## " + (i + 1) + ". Questão " + q.id, "", "Erro: " + q.erro, ""); return; }
      L.push("## " + (i + 1) + ". " + [q.banca, q.ano, q.orgao, q.cargo].filter(Boolean).join(" · ") + " (#" + q.id + ")", "");
      L.push("*" + [q.materia, q.assunto, q.tipo, q.anulada ? "ANULADA" : "", q.desatualizada ? "DESATUALIZADA" : ""].filter(Boolean).join(" · ") + "* · " + q.url, "");
      L.push(q.enunciado, "");
      (q.alternativas || []).forEach(function (a, k) { L.push((q.tipo === "CERTO_ERRADO" ? "( ) " : LETRAS[k] + ") ") + a); });
      if (q.alternativas) L.push("");
      if (q.gabarito !== undefined) L.push("**Gabarito:** " + (q.gabarito || "não informado") + (q.acertoGeral != null ? " · acerto geral " + q.acertoGeral + "%" : ""), "");
      if (q.resolucaoBanca) L.push("### Resolução da banca", "", q.resolucaoBanca, "");
      if (q.comentarioProfessor) L.push("### Comentário do professor" + (q.comentarioProfessor.professor ? " (" + q.comentarioProfessor.professor + ")" : ""), "", q.comentarioProfessor.texto, "");
      if (q.comentarioIA) L.push("### Comentário IA", "", q.comentarioIA, "");
      if (q.forum) {
        q.forum.professor.forEach(function (c) { L.push("### Fórum: professor " + c.autor + " (" + c.votos + " votos)", "", c.texto, ""); });
        q.forum.melhores.forEach(function (c, k) { L.push("### Fórum: " + (k + 1) + "º mais votado, " + c.autor + " (" + c.votos + " votos)", "", c.texto, ""); });
      }
      L.push("---", "");
    });
    return L.join("\n");
  }
  function baixar(nomeArquivo, conteudo, tipo) {
    var blob = new Blob([conteudo], { type: (tipo || "text/plain") + ";charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = nomeArquivo;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    return nomeArquivo;
  }

  // ---- persistência: cada questão extraída vai para o IndexedDB do site (banco "tecapi").
  // Se a aba recarregar (o Chrome descarta abas em segundo plano), retomarExtracao(nome) continua de onde parou.
  function idb() {
    return new Promise(function (ok, falha) {
      var req = indexedDB.open("tecapi", 1);
      req.onupgradeneeded = function () {
        var s = req.result.createObjectStore("questoes", { keyPath: "chave" });
        s.createIndex("job", "job");
      };
      req.onsuccess = function () { ok(req.result); };
      req.onerror = function () { falha(req.error); };
    });
  }
  async function idbPut(rec) {
    var db = await idb();
    return new Promise(function (ok, falha) {
      var tx = db.transaction("questoes", "readwrite"); tx.objectStore("questoes").put(rec);
      tx.oncomplete = function () { db.close(); ok(); }; tx.onerror = function () { db.close(); falha(tx.error); };
    });
  }
  async function idbDoJob(nome) {
    var db = await idb();
    return new Promise(function (ok, falha) {
      var req = db.transaction("questoes").objectStore("questoes").index("job").getAll(nome);
      req.onsuccess = function () { db.close(); ok(req.result.map(function (r) { return r.q; })); };
      req.onerror = function () { db.close(); falha(req.error); };
    });
  }
  async function limparExtracao(nome) {
    var db = await idb();
    await new Promise(function (ok) {
      var tx = db.transaction("questoes", "readwrite"), st = tx.objectStore("questoes");
      st.index("job").openCursor(IDBKeyRange.only(nome)).onsuccess = function (e) { var c = e.target.result; if (c) { c.delete(); c.continue(); } };
      tx.oncomplete = function () { db.close(); ok(); };
    });
    localStorage.removeItem("__tecjob:" + nome);
    return true;
  }
  function metaJob(nome) { try { return JSON.parse(localStorage.getItem("__tecjob:" + nome) || "null"); } catch (e) { return null; } }

  // Inicia (ou retoma) a extração e volta na hora; acompanhar com statusExtracao().
  // opcoes: {forum:3, intervaloMs:200, nomeArquivo:"concurso-dir-adm", titulo:"...", baixar:true, comentarioIA:false}
  // nomeArquivo identifica o job: chamar de novo com o mesmo nome pula o que já está gravado.
  function iniciarExtracao(ids, opcoes) {
    opcoes = Object.assign({}, opcoes || {});
    var nome = opcoes.nomeArquivo = opcoes.nomeArquivo || "tec-questoes";
    localStorage.setItem("__tecjob:" + nome, JSON.stringify({ ids: ids, opcoes: opcoes, criado: Date.now() }));
    var job = { nome: nome, ids: ids.slice(), feitas: 0, erros: 0, inicio: Date.now(), terminou: false, arquivos: [] };
    window.__tecJob = job;
    (async function () {
      var feitos = {};
      (await idbDoJob(nome)).forEach(function (q) { feitos[q.id] = q; });
      job.jaGravadas = Object.keys(feitos).length;
      var intervalo = opcoes.intervaloMs === undefined ? 2500 : opcoes.intervaloMs;
      job.pausas = 0;
      for (var i = 0; i < job.ids.length; i++) {
        if (job.cancelar) break;
        var id = job.ids[i];
        if (feitos[id] && !feitos[id].erro) { job.feitas++; continue; }
        var q;
        window.__tecLimite = null;
        try { q = await extrairQuestao(id, opcoes); } catch (e) { q = { id: id, erro: erroTexto(e) }; }
        if (window.__tecLimite) {
          // Limite de ritmo do TEC: não grava esta questão, espera, dobra o intervalo e tenta de novo.
          job.pausas++;
          if (job.pausas > (opcoes.maxPausas || 3)) { job.parado = "O TEC continuou limitando (HTTP " + window.__tecLimite + "). Abra o TEC, veja se pede verificação (o usuário resolve) e depois retomarExtracao('" + nome + "')."; break; }
          intervalo = Math.min(intervalo * 2, 20000);
          job.pausadoAte = Date.now() + (opcoes.pausaMs || 180000);
          await esperar(opcoes.pausaMs || 180000);
          job.pausadoAte = null;
          i--; continue;
        }
        if (q.erro) job.erros++;
        await idbPut({ chave: nome + ":" + id, job: nome, q: q });
        job.feitas++;
        job.intervaloMs = intervalo;
        await esperar(intervalo);
      }
      job.terminou = !job.cancelar && !job.parado;
      job.fim = Date.now();
      if (job.terminou && opcoes.baixar !== false) job.arquivos = await exportarExtracao(nome);
    })().catch(function (e) { job.falha = erroTexto(e); });
    return statusExtracao();
  }
  // Continua um job depois de recarregar a página (precisa só do nome).
  function retomarExtracao(nome) {
    var m = metaJob(nome);
    if (!m) throw new Error("Job " + nome + " não encontrado no localStorage.");
    return iniciarExtracao(m.ids, m.opcoes);
  }
  function statusExtracao() {
    var j = window.__tecJob;
    if (!j) return { ativo: false, aviso: "Nenhum job nesta página (recarregou?). Use retomarExtracao('<nome>')." };
    return {
      nome: j.nome, total: j.ids.length, feitas: j.feitas, erros: j.erros, jaGravadas: j.jaGravadas, terminou: j.terminou, falha: j.falha,
      segundos: Math.round(((j.fim || Date.now()) - j.inicio) / 1000), arquivos: j.arquivos
    };
  }
  // Monta e baixa os arquivos a partir do que está gravado (na ordem dos ids do job).
  async function exportarExtracao(nome, titulo) {
    var m = metaJob(nome) || { ids: [], opcoes: {} };
    var mapa = {};
    (await idbDoJob(nome)).forEach(function (q) { mapa[q.id] = q; });
    var lista = (m.ids.length ? m.ids : Object.keys(mapa)).map(function (id) { return mapa[id]; }).filter(Boolean);
    var base = nome + "-" + new Date().toISOString().slice(0, 10);
    return [
      baixar(base + ".json", JSON.stringify(lista, null, 2), "application/json"),
      baixar(base + ".md", paraMarkdown(lista, titulo || m.opcoes.titulo), "text/markdown")
    ];
  }
  async function resumoExtracao(nome) {
    var r = await idbDoJob(nome);
    return {
      gravadas: r.length, erros: r.filter(function (q) { return q.erro; }).length,
      comGabarito: r.filter(function (q) { return q.gabarito; }).length,
      comComentarioProfessor: r.filter(function (q) { return q.comentarioProfessor; }).length,
      comResolucaoBanca: r.filter(function (q) { return q.resolucaoBanca; }).length,
      comForum: r.filter(function (q) { return q.forum && q.forum.total; }).length,
      comPostProfessorNoForum: r.filter(function (q) { return q.forum && q.forum.professor.length; }).length
    };
  }
  async function resultadosExtracao(nome, de, ate) { var r = await idbDoJob(nome); return r.slice(de || 0, ate || r.length); }
  function cancelarExtracao() { if (window.__tecJob) window.__tecJob.cancelar = true; return statusExtracao(); }

  // ------------------------------------------------------------------ impressão (método preferido para baixar em lote)
  // É a função "Imprimir" do caderno (/questoes/cadernos/<id>/configurar-impressao): até 200 questões por vez,
  // questão inicial livre, gabarito junto de cada questão; saldo de 1.000 questões por dia (HTTP 409 = limite).
  // O saldo é gasto quando a página de impressão carrega as questões, não no POST.
  async function saldoImpressao(idCaderno) {
    var html = await (await fetch("/questoes/cadernos/" + idCaderno + "/configurar-impressao", { credentials: "include" })).text();
    var m = html.replace(/<[^>]+>/g, " ").match(/saldo de\s*([\d.]+)/i);
    return m ? Number(m[1].replace(/\./g, "")) : null;
  }
  // Carrega o lote num iframe da própria página (qualquer página do TEC), trocando window.print por um aviso
  // de "pronto" (a página original chama window.print() quando termina de montar, inclusive o MathJax).
  async function imprimirLote(idCaderno, inicio, quantidade, opcoes) {
    opcoes = opcoes || {};
    var p = {
      "configuracoes.idCadernoQuestoes": idCaderno, "configuracoes.idTeoriaModulo": "", "configuracoes.idTeoriaAssunto": "",
      "configuracoes.numeroQuestoes": Math.min(quantidade, 200), "configuracoes.cabecalhoQuestoes": opcoes.cabecalho || "COMPLETO",
      "configuracoes.questaoSequencial": "true", "configuracoes.questaoInicial": inicio,
      "configuracoes.gabaritoImpresso": opcoes.gabarito || "JUNTO_QUESTAO", "configuracoes.tamanhoFonte": opcoes.fonte || "NORMAL",
      "configuracoes.removerQuestoes": opcoes.remover || "NENHUMA", "configuracoes.imprimirTextoAssociado": "true",
      "configuracoes.espacoRascunho": "NENHUM", "configuracoes.linhasRascunho": "1", "configuracoes.qrCodeQuestoes": "false"
    };
    var r = await fetch("/questoes/cadernos/" + idCaderno + "/imprimir", { method: "POST", body: new URLSearchParams(p), credentials: "include" });
    var html = (await r.text()).replace(/<head([^>]*)>/i, "<head$1><script>window.print=function(){window.__pronto=true;};window.alert=function(m){window.__alerta=String(m);};</script>");
    var velho = document.getElementById("__ifrImp"); if (velho) velho.remove();
    var ifr = document.createElement("iframe"); ifr.id = "__ifrImp";
    ifr.style.cssText = "position:fixed;left:0;top:0;width:900px;height:600px;z-index:99999;background:#fff;border:2px solid #c00";
    document.body.appendChild(ifr);
    ifr.contentDocument.open(); ifr.contentDocument.write(html); ifr.contentDocument.close();
    window.__loteImp = { idCaderno: idCaderno, inicio: inicio, quantidade: Math.min(quantidade, 200), status: r.status, desde: Date.now() };
    return r.status;
  }
  function estadoImpressao() {
    var f = document.getElementById("__ifrImp"); if (!f) return { ativo: false };
    var w = f.contentWindow;
    return { pronto: !!w.__pronto, alerta: w.__alerta || null, questoes: w.document.querySelectorAll("#prova-conteudo .questao").length,
      esperado: (window.__loteImp || {}).quantidade, segundos: Math.round((Date.now() - (window.__loteImp || {}).desde) / 1000) };
  }
  // Baixa o lote renderizado como HTML independente (sem scripts, CSS embutido, imagens carregadas viram data URL).
  // Converter depois em PDF fora do navegador: chrome --headless=new --no-pdf-header-footer --print-to-pdf=<saida.pdf> <arquivo.html>
  function salvarImpressao(nomeArquivo) {
    var w = document.getElementById("__ifrImp").contentWindow, d = w.document, css = "";
    Array.prototype.forEach.call(d.styleSheets, function (sh) {
      try { css += Array.prototype.map.call(sh.cssRules, function (r) { return r.cssText; }).join("\n") + "\n"; }
      catch (e) { if (sh.href) css += '@import url("' + sh.href + '");\n'; }
    });
    var orig = Array.prototype.slice.call(d.images), clone = d.documentElement.cloneNode(true);
    Array.prototype.slice.call(clone.querySelectorAll("img")).forEach(function (img, i) {
      var o = orig[i], s = img.getAttribute("src") || o.src;
      try {
        if (!(o.complete && o.naturalWidth)) throw 0;
        var cv = document.createElement("canvas"); cv.width = o.naturalWidth; cv.height = o.naturalHeight;
        cv.getContext("2d").drawImage(o, 0, 0); img.setAttribute("src", cv.toDataURL("image/png"));
      } catch (e) { img.setAttribute("src", new URL(s, d.baseURI).href); }
    });
    Array.prototype.forEach.call(clone.querySelectorAll("script, link[rel=stylesheet], style"), function (e) { e.remove(); });
    clone.querySelector("head").insertAdjacentHTML("afterbegin", '<meta charset="utf-8"><base href="https://www.tecconcursos.com.br/"><style>' + css.replace(/<\/style/gi, "<\\/style") + "</style>");
    var html = "<!DOCTYPE html>\n" + clone.outerHTML;
    baixar(nomeArquivo, html, "text/html");
    return { arquivo: nomeArquivo, kb: Math.round(html.length / 1024), questoes: clone.querySelectorAll(".questao").length };
  }

  window.TecAPI = {
    versao: VERSAO, logado: logado, get: get, post: post, achatar: achatar, htmlParaTexto: htmlParaTexto,
    materias: materias, assuntosDaMateria: assuntosDaMateria, listaAssuntos: listaAssuntos, buscarAssuntos: buscarAssuntos,
    bancas: bancas, anos: anos, orgaos: orgaos, cargos: cargos,
    contar: contar, idsQuestoes: idsQuestoes, filtrosDoCaderno: filtrosDoCaderno, contarPlano: contarPlano,
    pastas: pastas, criarPasta: criarPasta, garantirPasta: garantirPasta, criarSubpasta: criarSubpasta, itensPasta: itensPasta,
    renomearCaderno: renomearCaderno, filtrosCaderno: filtrosCaderno, converterFiltrosGravados: converterFiltrosGravados, idsDoCaderno: idsDoCaderno,
    urlFiltro: urlFiltro, urlFiltroCurta: urlFiltroCurta, completarFiltros: completarFiltros, estadoGerador: estadoGerador, prepararGerador: prepararGerador, idCadernoDaUrl: idCadernoDaUrl,
    buscarGuias: buscarGuias, lerPaginaEdital: lerPaginaEdital, lerPaginaCargo: lerPaginaCargo, lerIndiceGuia: lerIndiceGuia, assuntosDoGuia: assuntosDoGuia, intervaloAnos: intervaloAnos,
    forum: forum, extrairQuestao: extrairQuestao, paraMarkdown: paraMarkdown, baixar: baixar,
    iniciarExtracao: iniciarExtracao, statusExtracao: statusExtracao, resultadosExtracao: resultadosExtracao, cancelarExtracao: cancelarExtracao,
    retomarExtracao: retomarExtracao, exportarExtracao: exportarExtracao, resumoExtracao: resumoExtracao, limparExtracao: limparExtracao,
    saldoImpressao: saldoImpressao, imprimirLote: imprimirLote, estadoImpressao: estadoImpressao, salvarImpressao: salvarImpressao
  };
})();
