'use strict';
// Fluxograma do Delegar: monta o grafo (montar), calcula posições (posicionar) e desenha em SVG (desenhar).
// Sem dependências. Todo texto entra por textContent; nada de atributo style (a CSP não permite).
(function () {
  const raiz = typeof window !== 'undefined' ? window : globalThis;

  const NW = 150;          // largura padrão do nó
  const NH = 62;           // altura do nó: três linhas de 12 px
  const MARG = 12;         // margem lateral e vertical
  const GAP_X = 16;        // espaço entre nós da mesma linha
  const GAP_LINHA = 16;    // espaço entre linhas de uma mesma camada
  const GAP_CAMADA = 34;   // espaço entre camadas
  const LARGURA_PADRAO = 640;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const ESTADO_TAREFA = { pending: 'pendente', waiting: 'aguardando', running: 'rodando', done: 'ok', failed: 'falhou', skipped: 'pulada' };
  const ESTADO_PLANEJADOR = { pendente: 'pendente', rodando: 'rodando', concluido: 'ok' };
  const NOME_ESTADO = { pendente: 'na fila', aguardando: 'aguardando confirmação', rodando: 'rodando', ok: 'concluída', falhou: 'falhou', pulada: 'pulada', neutro: 'sem execução (previsto)' };
  const GLIFO = { pendente: '○', aguardando: '‖', rodando: '▶', ok: '✓', falhou: '✕', pulada: '–', neutro: '' };
  const ORDEM_ESTADOS = ['pendente', 'aguardando', 'rodando', 'ok', 'falhou', 'pulada', 'neutro'];

  const lista = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : []);
  const limpa = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const corta = (s, n) => { s = limpa(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

  // ---------- montar ----------

  function cadeiaDoTier(t) {
    // string[] simples, ou string[][] (volume alternado)
    if (Array.isArray(t) && t.length > 1 && t.every(Array.isArray)) return { alterna: true, cadeias: t.map(lista).filter((c) => c.length) };
    if (Array.isArray(t) && t.length === 1 && Array.isArray(t[0])) return { alterna: false, cadeias: [lista(t[0])] };
    return { alterna: false, cadeias: [lista(t)] };
  }

  function camadasDasTarefas(tarefas) {
    const ids = new Set(tarefas.map((t) => t.id));
    const deps = new Map();
    for (const t of tarefas) deps.set(t.id, [...new Set(lista(t.depende).filter((d) => ids.has(d) && d !== t.id))]);
    const cam = new Map();
    let andou = true;
    while (andou) {
      andou = false;
      for (const t of tarefas) {
        if (cam.has(t.id)) continue;
        const d = deps.get(t.id);
        if (d.every((x) => cam.has(x))) {
          cam.set(t.id, 1 + Math.max(0, ...d.map((x) => cam.get(x))));
          andou = true;
        }
      }
    }
    // o que sobrou está em ciclo (ou depende de um ciclo): vai para uma camada final
    const final = 1 + Math.max(0, ...cam.values());
    for (const t of tarefas) if (!cam.has(t.id)) cam.set(t.id, final);
    return { cam, deps };
  }

  function montar(dados) {
    dados = dados || {};
    const cfg = dados.cfg || {};
    const tiers = cfg.tiers || {};
    const status = dados.status || null;
    const plano = dados.plano && Array.isArray(dados.plano.tarefas) ? dados.plano : null;
    const nos = [];
    const arestas = [];
    const no = (o) => { const n = Object.assign({ modelos: [], estado: 'neutro', lateral: false }, o); nos.push(n); return n; };
    const liga = (de, para, tipo) => arestas.push({ de, para, tipo: tipo || 'normal' });

    const plan = no({ id: '_planejador', rotulo: 'Planejador', sub: 'divide o pedido em tarefas', modelos: lista(cfg.planner),
      estado: plano ? 'ok' : (ESTADO_PLANEJADOR[dados.planejadorEstado] || 'neutro'), tipo: 'planejador', camada: 0 });
    const corrModelos = lista(cfg.fix);
    const coordModelos = lista(cfg.coord);

    if (!plano) {
      const grupos = [['pesado', 'Escritores pesado'], ['volume', 'Escritores volume'], ['leve', 'Escritores leve']];
      for (const [k, rot] of grupos) {
        const { alterna, cadeias } = cadeiaDoTier(tiers[k]);
        const n = no({ id: '_esc_' + k, rotulo: rot, sub: alterna ? 'alterna' : 'em paralelo', modelos: alterna ? cadeias.map((c) => c.join(' > ')) : (cadeias[0] || []),
          estado: 'neutro', tipo: 'escritor', camada: 1 });
        if (alterna) n.alterna = true;
        liga(plan.id, n.id);
      }
      const integ = no({ id: '_integrador', rotulo: 'Integrador', sub: 'um por vez; cadeia do nível da tarefa', modelos: [], estado: 'neutro', tipo: 'integrador', camada: 2 });
      for (const [k] of grupos) liga('_esc_' + k, integ.id);
      const fim = no({ id: '_fim', rotulo: 'Fim', sub: 'resultado entregue', estado: 'neutro', tipo: 'fim', camada: 3 });
      const corr = no({ id: '_correcao', rotulo: 'Correção', sub: 'refaz o que falhou', modelos: corrModelos, tipo: 'correcao', camada: 3, lateral: true });
      const coord = no({ id: '_coord', rotulo: 'Coordenador de falhas', sub: 'decide o que fazer', modelos: coordModelos, tipo: 'coordenador', camada: 3, lateral: true });
      liga(integ.id, fim.id);
      liga(integ.id, corr.id, 'falha');
      liga(corr.id, coord.id, 'falha');
      return { nos, arestas };
    }

    // com plano
    const vistos = new Set(nos.map((n) => n.id));
    const tarefas = [];
    for (const t of plano.tarefas) {
      if (!t || t.id == null) continue;
      const id = String(t.id);
      if (vistos.has(id)) continue;
      vistos.add(id);
      tarefas.push({ id, titulo: t.titulo, tipo: t.tipo || 'tarefa', nivel: t.nivel, depende: t.depende, cadeiaEfetiva: t.cadeiaEfetiva });
    }
    const { cam, deps } = camadasDasTarefas(tarefas);
    let fixing = false, rodando = false, falhou = false, tudoOk = tarefas.length > 0;
    for (const t of tarefas) {
      const st = (status && status[t.id]) || {};
      const estado = ESTADO_TAREFA[st.state] || 'pendente';
      if (st.note === 'fixing') fixing = true;
      if (estado === 'rodando') rodando = true;
      if (estado === 'falhou') falhou = true;
      if (estado !== 'ok' && estado !== 'pulada') tudoOk = false;
      const modelos = st.model ? [String(st.model)] : lista(t.cadeiaEfetiva);
      no({ id: t.id, rotulo: `${t.id} ${corta(t.titulo, 28)}`.trim(), sub: [t.tipo, t.nivel].filter((x) => x != null && x !== '').join('/'),
        modelos, estado, tipo: t.tipo, camada: cam.get(t.id) });
    }
    const ultima = Math.max(0, ...cam.values());
    const referenciados = new Set();
    for (const t of tarefas) {
      for (const d of deps.get(t.id)) { liga(d, t.id); referenciados.add(d); }
      if (!deps.get(t.id).length) liga(plan.id, t.id);
    }
    const sinks = tarefas.filter((t) => !referenciados.has(t.id)).map((t) => t.id);
    // em ciclo todos têm dependente: o fim ainda precisa de alguma entrada
    const entradas = sinks.length ? sinks : tarefas.filter((t) => cam.get(t.id) === ultima).map((t) => t.id);
    const estadoFim = tudoOk ? 'ok' : (falhou && !rodando ? 'falhou' : 'pendente');
    const fim = no({ id: '_fim', rotulo: 'Fim', sub: 'resultado entregue', estado: estadoFim, tipo: 'fim', camada: ultima + 1 });
    const estLateral = fixing ? 'rodando' : 'neutro';
    const corr = no({ id: '_correcao', rotulo: 'Correção', sub: 'refaz o que falhou', modelos: corrModelos, estado: estLateral, tipo: 'correcao', camada: ultima + 1, lateral: true });
    const coord = no({ id: '_coord', rotulo: 'Coordenador de falhas', sub: 'decide o que fazer', modelos: coordModelos, estado: estLateral, tipo: 'coordenador', camada: ultima + 1, lateral: true });
    for (const id of entradas) { liga(id, fim.id); liga(id, corr.id, 'falha'); }
    liga(corr.id, coord.id, 'falha');
    if (!tarefas.length) liga(plan.id, fim.id);
    return { nos, arestas };
  }

  // ---------- posicionar ----------

  const arred = (n) => Math.round(n * 10) / 10;

  function posicionar(grafo, largura) {
    largura = Number.isFinite(largura) && largura > 0 ? largura : LARGURA_PADRAO;
    const w = Math.min(NW, Math.max(60, largura - 2 * MARG));
    largura = Math.max(largura, w + 2 * MARG);
    let porLinha = Math.max(1, Math.floor((largura - 2 * MARG + GAP_X) / (w + GAP_X)));
    if (largura < 480) porLinha = Math.min(porLinha, 2);

    const porCamada = new Map();
    for (const n of grafo.nos) {
      if (!porCamada.has(n.camada)) porCamada.set(n.camada, []);
      porCamada.get(n.camada).push(n);
    }
    const nos = [];
    let y = MARG;
    let primeira = true;
    for (const c of [...porCamada.keys()].sort((a, b) => a - b)) {
      const grupo = porCamada.get(c);
      const linhas = Math.ceil(grupo.length / porLinha);
      const cols = Math.ceil(grupo.length / linhas);   // distribui por igual entre as linhas
      if (!primeira) y += GAP_CAMADA;
      primeira = false;
      for (let l = 0; l < linhas; l++) {
        const fatia = grupo.slice(l * cols, (l + 1) * cols);
        const total = fatia.length * w + (fatia.length - 1) * GAP_X;
        const x0 = (largura - total) / 2;
        fatia.forEach((n, i) => nos.push(Object.assign({}, n, { x: arred(x0 + i * (w + GAP_X)), y: arred(y), w, h: NH })));
        y += NH + (l < linhas - 1 ? GAP_LINHA : 0);
      }
    }
    const altura = y + MARG;
    const porId = new Map(nos.map((n) => [n.id, n]));
    const arestas = [];
    for (const a of grafo.arestas) {
      const o = porId.get(a.de), d = porId.get(a.para);
      if (!o || !d) continue;
      let pontos;
      if (Math.abs(o.y - d.y) < 1) {
        // mesma linha: de lado a lado
        const dir = d.x >= o.x;
        const x1 = dir ? o.x + o.w : o.x, x2 = dir ? d.x : d.x + d.w, ym = o.y + o.h / 2;
        pontos = [{ x: x1, y: ym }, { x: (x1 + x2) / 2, y: ym }, { x: (x1 + x2) / 2, y: ym }, { x: x2, y: ym }];
      } else {
        const x1 = o.x + o.w / 2, y1 = o.y + o.h, x2 = d.x + d.w / 2, y2 = d.y;
        const dy = Math.max(20, Math.abs(y2 - y1) / 2);
        pontos = [{ x: x1, y: y1 }, { x: x1, y: y1 + dy }, { x: x2, y: y2 - dy }, { x: x2, y: y2 }];
      }
      arestas.push(Object.assign({}, a, { pontos: pontos.map((p) => ({ x: arred(p.x), y: arred(p.y) })) }));
    }
    return { nos, arestas, largura: arred(largura), altura: arred(altura) };
  }

  // ---------- assinatura ----------

  function assinatura(dados) {
    const g = montar(dados);
    const txt = JSON.stringify([g.nos.map((n) => [n.id, n.rotulo, n.sub, n.modelos, n.estado, n.tipo, n.camada, n.lateral]), g.arestas.map((a) => [a.de, a.para, a.tipo])]);
    let h1 = 0x811c9dc5, h2 = 5381;
    for (let i = 0; i < txt.length; i++) {
      const c = txt.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = (Math.imul(h2, 33) + c) >>> 0;
    }
    return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0') + '-' + g.nos.length;
  }

  // ---------- desenhar ----------

  const observadores = new WeakMap();   // container -> { ro, dados, largura }
  let seq = 0;

  function s(tag, attrs, texto) {
    const e = document.createElementNS(SVG_NS, tag);
    for (const k in attrs || {}) e.setAttribute(k, String(attrs[k]));
    if (texto != null) e.textContent = texto;
    return e;
  }
  function h(tag, classe, texto) {
    const e = document.createElement(tag);
    if (classe) e.className = classe;
    if (texto != null) e.textContent = texto;
    return e;
  }

  function resumo(g) {
    const n = (est) => g.nos.filter((x) => x.estado === est).length;
    const partes = [`${g.nos.length} etapas`];
    for (const e of ['ok', 'rodando', 'falhou', 'aguardando', 'pendente', 'pulada']) if (n(e)) partes.push(`${n(e)} ${NOME_ESTADO[e]}`);
    return 'Fluxo de execução: ' + partes.join(', ');
  }

  function renderiza(container, dados, larguraCont) {
    const bruto = montar(dados);
    const g = posicionar(bruto, larguraCont);
    const id = 'fx' + (++seq);
    const svg = s('svg', { width: '100%', viewBox: `0 0 ${g.largura} ${g.altura}`, role: 'img', 'aria-label': resumo(g), class: 'fx-svg' });
    const defs = s('defs');
    for (const t of ['normal', 'falha']) {
      const m = s('marker', { id: `${id}-${t}`, viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 8, markerHeight: 8, markerUnits: 'userSpaceOnUse', orient: 'auto' });
      m.appendChild(s('path', { d: 'M0,0 L8,4 L0,8 z', class: t === 'falha' ? 'fx-seta fx-seta-falha' : 'fx-seta' }));
      defs.appendChild(m);
    }
    svg.appendChild(defs);
    for (const a of g.arestas) {
      const [p0, p1, p2, p3] = a.pontos;
      svg.appendChild(s('path', { d: `M${p0.x},${p0.y} C${p1.x},${p1.y} ${p2.x},${p2.y} ${p3.x},${p3.y}`,
        class: a.tipo === 'falha' ? 'fx-aresta fx-falha' : 'fx-aresta', 'marker-end': `url(#${id}-${a.tipo === 'falha' ? 'falha' : 'normal'})` }));
    }
    for (const n of g.nos) {
      const gr = s('g', { class: `fx-no fx-${n.estado}${n.lateral ? ' fx-lateral' : ''}` });
      const cadeia = n.alterna ? n.modelos.join(' / ') : n.modelos.join(' > ');
      gr.appendChild(s('title', null, [n.rotulo, n.sub, 'estado: ' + NOME_ESTADO[n.estado], cadeia ? 'modelos: ' + cadeia : ''].filter(Boolean).join('\n')));
      gr.appendChild(s('rect', { x: n.x, y: n.y, width: n.w, height: n.h, rx: 8, ry: 8, class: 'fx-rect' }));
      const cabem = Math.max(6, Math.floor((n.w - 16) / 6.6));
      gr.appendChild(s('text', { x: n.x + 8, y: n.y + 17, class: 'fx-rot' }, corta(n.rotulo, GLIFO[n.estado] ? cabem - 2 : cabem)));
      if (GLIFO[n.estado]) gr.appendChild(s('text', { x: n.x + n.w - 8, y: n.y + 17, class: 'fx-glifo', 'text-anchor': 'end' }, GLIFO[n.estado]));
      gr.appendChild(s('text', { x: n.x + 8, y: n.y + 33, class: 'fx-sub' }, corta(n.sub, cabem)));
      gr.appendChild(s('text', { x: n.x + 8, y: n.y + 49, class: 'fx-mod' }, corta(cadeia, cabem)));
      svg.appendChild(gr);
    }
    const leg = h('div', 'fx-legenda');
    const presentes = new Set(g.nos.map((n) => n.estado));
    for (const e of ORDEM_ESTADOS) {
      if (!presentes.has(e)) continue;
      const it = h('span', 'fx-leg-item');
      it.appendChild(h('span', `fx-chip fx-${e}`, GLIFO[e]));
      it.appendChild(document.createTextNode(' ' + NOME_ESTADO[e]));
      leg.appendChild(it);
    }
    if (g.arestas.some((a) => a.tipo === 'falha')) leg.appendChild(h('span', 'fx-leg-item', 'linha tracejada: caminho de falha'));
    container.replaceChildren(svg, leg);
  }

  function desenhar(container, dados) {
    if (!container) return;
    container.classList.add('fluxo');
    let obs = observadores.get(container);
    if (!obs) {
      obs = { ro: null, dados: null, largura: 0 };
      observadores.set(container, obs);
      if (typeof ResizeObserver === 'function') {
        let pendente = false;
        obs.ro = new ResizeObserver(() => {
          const w = Math.round(container.clientWidth);
          if (!w || w === obs.largura || pendente) return;
          pendente = true;
          const faz = () => { pendente = false; if (obs.dados) { obs.largura = Math.round(container.clientWidth) || obs.largura; renderiza(container, obs.dados, obs.largura); } };
          (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : setTimeout)(faz);
        });
        obs.ro.observe(container);
      }
    }
    obs.dados = dados;
    obs.largura = Math.round(container.clientWidth) || obs.largura || LARGURA_PADRAO;
    renderiza(container, dados, obs.largura);
  }

  raiz.DelegarFluxo = { montar, posicionar, desenhar, assinatura };
})();
