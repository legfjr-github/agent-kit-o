'use strict';
const TOKEN = document.querySelector('meta[name="delegar-token"]').content;
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else e[k] = v; }
  for (const k of kids) if (k != null) e.append(k);
  return e;
};
async function call(method, url, body) {
  const r = await fetch(url, { method, headers: { 'X-Delegar-Token': TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.erro || r.statusText);
  return j;
}
const ESTADOS = { planejando: 'planejando', conversando: 'conversando', plano_pronto: 'plano pronto', executando: 'executando', concluido: 'concluído', incompleto: 'incompleto', cancelado: 'cancelado', interrompido: 'interrompido' };
const TAREFA = { pending: 'na fila', waiting: 'aguardando confirmação', running: 'rodando', done: 'concluída', failed: 'falhou', skipped: 'pulada' };
const PAPEIS = [['planner', 'Planejador'], ['pesado', 'Nível pesado'], ['volume', 'Nível volume'], ['leve', 'Nível leve'], ['fix', 'Correção'], ['coord', 'Coordenador de falhas']];
const ESFORCOS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
let MODES = {}, SUP = {}, CAT = { modelos: [], provedores: {} }, ULTIMO = null, PADRAO_CUSTOM = null;
let atual = null, ultimoMsgs = -1, timer = null, vista = 'vazio', projAtual = null;
const promptsAbertos = new Set();   // prompts de tarefa abertos: a tabela é refeita a cada 4 s e não pode fechá-los
let novoCfg = null, projCfg = null;
let PERFIS = null, PERFIS_AVISO = null, novoPerfil = null, msgModelos = '';   // PERFIS = null: a API de perfis não respondeu, a interface de perfis some

const flat = (t) => (Array.isArray(t?.[0]) ? t[0] : t || []);
const copia = (o) => JSON.parse(JSON.stringify(o));
function cfgDeModo(k) {
  const m = MODES[k];
  if (!m) return copia(ULTIMO || PADRAO_CUSTOM);
  return { base: k, planner: [...m.planner], fix: [...m.fix], coord: [...m.coord], maxConcurrent: m.maxConcurrent,
    tiers: { pesado: [...flat(m.tiers.pesado)], volume: [...flat(m.tiers.volume)], leve: [...flat(m.tiers.leve)] } };
}
const lista = (cfg, k) => (['planner', 'fix', 'coord'].includes(k) ? cfg[k] : cfg.tiers[k]);
function nomeModelo(id) {
  const m = CAT.modelos.find((x) => x.id === id.split('@')[0]);
  return id + (m && !m.instalado ? ' (não instalado)' : '');
}
function fillModes(sel) {
  sel.replaceChildren(...Object.entries(MODES).map(([k, m]) => el('option', { value: k, text: m.nome })), el('option', { value: 'personalizado', text: 'Personalizado' }));
}
function fillSup(sel) { sel.replaceChildren(...Object.keys(SUP).map((k) => el('option', { value: k, text: SUP[k].split(':')[0] }))); }
function show(id) { vista = id; for (const s of ['vazio', 'novo', 'proj', 'atividade', 'cotas']) $(s).classList.toggle('hidden', s !== id); }

// ---------- editor de modo ----------
function editor(box, cfg, { editavel = true, onChange } = {}) {
  const sel = () => {
    const s = el('select', { class: 'modelo' });
    for (const prov of ['claude', 'agy', 'opencode']) {
      const g = el('optgroup', { label: prov + (CAT.provedores[prov] ? '' : ' (não instalado neste PC)') });
      for (const m of CAT.modelos.filter((x) => x.provedor === prov)) g.append(el('option', { value: m.id, text: m.id.slice(prov.length + 1) + (m.desespero ? ` · gratuito nº ${m.desespero}` : '') + (m.novo ? ' · novo' : '') }));
      s.append(g);
    }
    return s;
  };
  const mudou = (re = true) => { if (re) render(); if (onChange) onChange(cfg); };
  const render = () => {
    box.replaceChildren();
    for (const [k, rot] of PAPEIS) {
      const arr = lista(cfg, k);
      const chips = el('div', { class: 'chips' }, ...arr.map((id, i) => {
        const cm = CAT.modelos.find((m) => m.id === id.split('@')[0]);
        const c = el('span', { class: 'chip', title: cm?.dica || '' }, el('span', { text: `${i + 1}. ${nomeModelo(id)}` }), cm?.novo ? el('span', { class: 'marca-novo', text: 'novo' }) : null);
        if (editavel) {
          if (i > 0) { const up = el('button', { class: 'mini', text: '↑', title: 'subir' }); up.onclick = () => { [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; mudou(); }; c.append(up); }
          const rm = el('button', { class: 'mini', text: '×', title: 'remover' }); rm.onclick = () => { arr.splice(i, 1); mudou(); }; c.append(rm);
        }
        return c;
      }));
      if (!arr.length) chips.append(el('span', { class: 'hint', text: 'nenhum modelo: adicione ao menos um' }));
      const linha = el('div', { class: 'papel' }, el('strong', { text: rot }), chips);
      if (editavel) {
        const s = sel(); const ef = el('select', { class: 'esforco' }, ...ESFORCOS.map((e) => el('option', { value: e, text: e || 'esforço padrão' })));
        const add = el('button', { text: 'Adicionar' });
        add.onclick = () => { const id = s.value + (ef.value ? '@' + ef.value : ''); if (!arr.includes(id) && arr.length < 8) { arr.push(id); mudou(); } };
        linha.append(el('div', { class: 'add' }, s, ef, add));
      }
      box.append(linha);
    }
    const mc = el('input', { type: 'number', min: 1, max: 4, value: cfg.maxConcurrent || 2, disabled: !editavel, class: 'num' });
    mc.onchange = () => { cfg.maxConcurrent = Math.max(1, Math.min(4, Number(mc.value) || 2)); mudou(false); };
    box.append(el('label', { class: 'inline' }, 'Agentes ao mesmo tempo (máximo) ', mc));
    if (editavel) {
      const zero = el('button', { text: 'Começar do zero' });
      zero.onclick = () => { for (const [k] of PAPEIS) lista(cfg, k).splice(0); cfg.base = null; mudou(); };
      box.append(el('div', { class: 'row' }, zero));
    }
  };
  render();
}

// ---------- perfis, atualização de modelos e fluxo ----------
const cfgDeCustom = (c) => ({ base: c.base || null, planner: [...c.planner], fix: [...c.fix], coord: [...c.coord], maxConcurrent: c.maxConcurrent || 2,
  tiers: { pesado: [...flat(c.tiers.pesado)], volume: [...flat(c.tiers.volume)], leve: [...flat(c.tiers.leve)] } });
const nomesErros = (e) => (Array.isArray(e) ? e.map(String) : Object.entries(e || {}).map(([k, v]) => k + ': ' + v));
async function carregarPerfis() {
  try { const r = await call('GET', '/api/perfis'); PERFIS = r.perfis; PERFIS_AVISO = r.aviso || null; }
  catch { PERFIS = null; PERFIS_AVISO = null; }
}
// Barra de perfis salvos e de atualização de modelos. o: { selId, valor(), desabilitado(), cfg(), aoEscolher(nome), aoSalvar(nome) }
function montarBarra(box, o) {
  const itens = [];
  if (PERFIS) {
    const sel = el('select', { class: 'perfil-sel', id: o.selId, title: 'Perfis salvos' }, el('option', { value: '', text: 'Nenhum perfil aplicado' }), ...PERFIS.map((p) => el('option', { value: p.nome, text: p.nome })));
    sel.value = o.valor() || ''; sel.disabled = !!o.desabilitado();
    sel.onchange = () => o.aoEscolher(sel.value || null);
    const salvar = el('button', { type: 'button', text: 'Salvar como perfil', title: 'Guarda os modelos atuais com um nome' });
    salvar.onclick = async () => {
      const nome = prompt('Nome do perfil (letras, números, espaço e . _ ( ) + -):', sel.value || ''); if (!nome || !nome.trim()) return;
      const grava = (sobrescrever) => call('POST', '/api/perfis', { nome: nome.trim(), custom: o.cfg(), sobrescrever });
      try {
        let r;
        try { r = await grava(false); }
        catch (e) { if (/já existe/.test(e.message) && confirm(`Já existe o perfil "${nome.trim()}". Substituir pelos modelos atuais?`)) r = await grava(true); else throw e; }
        await carregarPerfis(); if (o.aoSalvar) o.aoSalvar(r.perfil.nome); montarBarras();
      } catch (e) { alert(e.message); }
    };
    const renomear = el('button', { type: 'button', text: 'Renomear' });
    renomear.onclick = async () => {
      if (!sel.value) return alert('Escolha um perfil na lista para renomear.');
      const para = prompt('Novo nome do perfil:', sel.value); if (!para || !para.trim() || para.trim() === sel.value) return;
      try { const r = await call('POST', '/api/perfis/renomear', { de: sel.value, para: para.trim() }); if (novoPerfil === sel.value) novoPerfil = r.perfil.nome; await carregarPerfis(); montarBarras(); if (atual) refresh(); } catch (e) { alert(e.message); }
    };
    const excluir = el('button', { type: 'button', class: 'perigo', text: 'Excluir perfil' });
    excluir.onclick = async () => {
      if (!sel.value) return alert('Escolha um perfil na lista para excluir.');
      if (!confirm(`Excluir o perfil "${sel.value}"? Projetos que já o usam continuam com os modelos que têm.`)) return;
      try { await call('POST', '/api/perfis/excluir', { nome: sel.value }); if (novoPerfil === sel.value) novoPerfil = null; await carregarPerfis(); montarBarras(); } catch (e) { alert(e.message); }
    };
    itens.push(el('div', { class: 'perfilbar' }, el('strong', { text: 'Perfil' }), sel, el('div', { class: 'btns' }, salvar, renomear, excluir)));
    if (PERFIS_AVISO) itens.push(el('p', { class: 'hint', text: PERFIS_AVISO }));
  }
  const msg = el('span', { class: 'hint barra-msg', text: msgModelos });
  const atualizar = el('button', { type: 'button', text: 'Atualizar modelos', title: 'Consulta as CLIs instaladas (agy e opencode) e marca o que é novo' });
  atualizar.onclick = async () => {
    atualizar.disabled = true; msg.textContent = 'Consultando as CLIs…';
    try {
      const r = await call('POST', '/api/modelos/atualizar');
      const { resultado, ...cat } = r; CAT = cat;
      const erros = nomesErros(resultado?.erros);
      msgModelos = `${(resultado?.novos || []).length} modelo(s) novo(s) nesta consulta` + (erros.length ? '; falhas: ' + erros.join('; ') : '');
      montarBarras(); reeditar();
    } catch (e) { msg.textContent = e.message; atualizar.disabled = false; }
  };
  itens.push(el('div', { class: 'perfilbar modelosbar' }, atualizar, msg));
  const novos = CAT.descoberta?.novos || [];
  if (novos.length) itens.push(el('p', { class: 'hint novos-info', text: `Modelos novos achados nas CLIs (marcados "novo" nas listas): ${novos.slice(0, 12).join(', ')}${novos.length > 12 ? ` e mais ${novos.length - 12}` : ''}` }));
  if (CAT.descoberta?.emAndamento) itens.push(el('p', { class: 'hint novos-info', text: 'Descoberta de modelos em andamento; clique em Atualizar modelos daqui a pouco.' }));
  box.replaceChildren(...itens);
}
function montarBarras() {
  montarBarra($('nBarra'), { selId: 'nPerfil', valor: () => novoPerfil, desabilitado: () => false, cfg: () => novoCfg || cfgDeModo($('nModo').value),
    aoEscolher: (nome) => {
      novoPerfil = nome; if (!nome) return;
      const pf = PERFIS.find((x) => x.nome === nome); if (!pf) return;
      novoCfg = cfgDeCustom(pf.custom); $('nModo').value = 'personalizado'; $('nModelosBox').open = true;
      editor($('nEditor'), novoCfg, { onChange: aoMudarNovo }); descNovo(); fluxoNovo();
    },
    aoSalvar: (nome) => { novoPerfil = nome; } });
  montarBarra($('pBarra'), { selId: 'pPerfil', valor: () => projAtual?.perfil, desabilitado: () => projAtual?.estado === 'executando', cfg: () => projCfg || cfgDeCustom(projAtual.config),
    aoEscolher: async (nome) => {
      if (!nome) return;
      try { await call('POST', `/api/projetos/${atual}/ajustes`, { perfil: nome }); projCfg = null; $('pEditorBox').classList.add('hidden'); } catch (e) { alert(e.message); }
      refresh();
    } });
}
// refaz os editores abertos (depois de atualizar o catálogo de modelos)
function reeditar() {
  if (vista === 'novo' && novoCfg) editor($('nEditor'), novoCfg, { onChange: aoMudarNovo });
  if (projCfg && projAtual) editor($('pEditor'), projCfg, { editavel: projAtual.estado !== 'executando', onChange: aoMudarProj });
}

// ---------- fluxograma ----------
const fluxoLib = () => window.DelegarFluxo || null;
function atualizarFluxo(box, dados, forcar) {
  const lib = fluxoLib();
  if (!lib || box.classList.contains('hidden')) return;
  const ass = lib.assinatura(dados);
  if (!forcar && box.dataset.assin === ass) return;
  box.dataset.assin = ass; lib.desenhar(box, copia(dados));
}
function dadosFluxoNovo() { const c = novoCfg || cfgDeModo($('nModo').value); return { cfg: { planner: c.planner, tiers: c.tiers, fix: c.fix, coord: c.coord } }; }
function dadosFluxoProj(p) {
  const c = p.config;
  return { cfg: { planner: c.planner, tiers: c.tiers, fix: c.fix, coord: c.coord }, plano: p.plano || null, status: p.run?.status || null,
    planejadorEstado: p.ocupado || p.estado === 'planejando' ? 'rodando' : 'pendente' };
}
const fluxoNovo = (forcar) => atualizarFluxo($('nFluxo'), dadosFluxoNovo(), forcar);
function ligarFluxo(row, btn, box, dados) {
  if (!fluxoLib()) { row.classList.add('hidden'); return; }
  btn.onclick = () => {
    const abrir = box.classList.contains('hidden');
    box.classList.toggle('hidden', !abrir); btn.textContent = abrir ? 'Ocultar fluxo' : 'Ver fluxo'; btn.setAttribute('aria-expanded', String(abrir));
    if (abrir) { const d = dados(); if (d) atualizarFluxo(box, d, true); }
  };
}

// ---------- lista ----------
// estado da seção "Concluídos" (expandida ou não) e da seção "Arquivados" (aberta ou não):
// a lista é refeita a cada 8 s e essas escolhas não podem se perder
let concluidosTodos = false, arquivadosAbertos = false;
function itemLista(p) {
  const b = el('button', { class: 'item' + (p.id === atual ? ' ativo' : '') }, el('strong', { text: p.titulo }),
    el('small', { text: `${ESTADOS[p.estado] || p.estado} · ${p.modoNome}${p.ocupado ? ' · pensando…' : ''}` }),
    p.gates ? el('small', { class: 'alerta', text: `${p.gates} confirmação pendente` }) : null);
  b.onclick = () => abrir(p.id);
  return b;
}
const tituloSecao = (t, n) => el('h3', { class: 'secao', text: `${t} (${n})` });
async function carregarLista() {
  const ps = await call('GET', '/api/projetos');
  const g = { aguardando: [], rodando: [], conversa: [], concluidos: [], arquivados: [] };
  for (const p of ps) {
    if (p.arquivado) g.arquivados.push(p);
    else if (p.gates > 0 || p.estado === 'plano_pronto' || ['interrompido', 'incompleto'].includes(p.estado)) g.aguardando.push(p);
    else if (p.estado === 'executando' || p.ocupado) g.rodando.push(p);
    else if (['concluido', 'cancelado'].includes(p.estado)) g.concluidos.push(p);
    else g.conversa.push(p); // planejando/conversando, e qualquer estado novo que não esteja listado aqui
  }
  const blocos = [];
  if (g.aguardando.length) blocos.push(tituloSecao('Aguardando você', g.aguardando.length), ...g.aguardando.map(itemLista));
  if (g.rodando.length) blocos.push(tituloSecao('Rodando', g.rodando.length), ...g.rodando.map(itemLista));
  if (g.conversa.length) blocos.push(tituloSecao('Em conversa', g.conversa.length), ...g.conversa.map(itemLista));
  if (g.concluidos.length) {
    const n = g.concluidos.length;
    blocos.push(tituloSecao('Concluídos', n), ...(concluidosTodos ? g.concluidos : g.concluidos.slice(0, 5)).map(itemLista));
    if (n > 5) {
      const ver = el('button', { class: 'mais', text: concluidosTodos ? 'mostrar só os 5 últimos' : `ver todos (${n})` });
      ver.onclick = () => { concluidosTodos = !concluidosTodos; carregarLista().catch(() => {}); };
      blocos.push(ver);
    }
  }
  if (g.arquivados.length) {
    blocos.push(el('details', { class: 'arquivados', open: arquivadosAbertos, ontoggle: (e) => { arquivadosAbertos = e.target.open; } },
      el('summary', { class: 'secao', text: `Arquivados (${g.arquivados.length})` }), ...g.arquivados.map(itemLista)));
  }
  $('lista').replaceChildren(...(ps.length ? blocos : [el('p', { class: 'hint', text: 'Sem projetos ainda.' })]));
}

// ---------- projeto ----------
function renderMsgs(p) {
  if (p.mensagens.length === ultimoMsgs && !p.ocupado) return;
  const box = $('msgs'); const fim = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
  const quem = { usuario: 'Você', planejador: 'Planejador', sistema: 'Sistema', resumo: 'Resumo da execução' };
  const limpa = (m) => m.papel === 'planejador' ? m.texto.replace(/```json[\s\S]*?```/g, '[plano em JSON: veja a tabela em "Plano e divisão"]') : m.texto;
  box.replaceChildren(...p.mensagens.map((m) => el('div', { class: 'msg ' + m.papel }, el('span', { class: 'quem', text: `${quem[m.papel] || m.papel}${m.modelo ? ' (' + m.modelo + ')' : ''} · ${new Date(m.quando).toLocaleString('pt-BR')}` }), limpa(m))));
  if (p.ocupado) box.append(el('div', { class: 'pensando', text: 'O planejador está pensando… (pode levar alguns minutos)' }));
  if (fim || ultimoMsgs === -1) box.scrollTop = box.scrollHeight;
  ultimoMsgs = p.mensagens.length;
}

function renderPlano(p) {
  const tb = $('tarefas').tBodies[0];
  const run = p.run?.status || {};
  const editavel = p.estado !== 'executando';
  if (!p.plano) { $('planoResumo').textContent = 'Ainda sem plano.'; tb.replaceChildren(); $('divisao').replaceChildren(); $('verify').textContent = ''; renderPlano.chave = null; return; }
  // só refaz a tabela quando o plano ou o estado das tarefas muda (prompt aberto não fecha nem volta ao topo)
  const chave = p.id + JSON.stringify([p.estado, p.plano.tarefas.map((t) => [t.id, t.nivel, t.cadeiaEfetiva]), run]);
  if (renderPlano.chave === chave) return;
  renderPlano.chave = chave;
  $('planoResumo').textContent = p.plano.resumo || '';
  const cont = {};
  for (const t of p.plano.tarefas) { const k = t.cadeiaEfetiva[0] || '-'; cont[k] = (cont[k] || 0) + 1; }
  $('divisao').replaceChildren(...Object.entries(cont).map(([k, n]) => el('span', { text: `${k}: ${n} tarefa${n > 1 ? 's' : ''}` })));
  tb.replaceChildren(...p.plano.tarefas.map((t) => {
    const nivel = el('select', { disabled: !editavel }, ...['pesado', 'volume', 'leve'].map((n) => el('option', { value: n, text: n, selected: n === t.nivel })));
    nivel.onchange = async () => { try { await call('POST', `/api/projetos/${p.id}/ajustes`, { niveis: { [t.id]: nivel.value } }); refresh(); } catch (e) { alert(e.message); } };
    const s = run[t.id];
    return el('tr', {},
      el('td', {}, el('details', { open: promptsAbertos.has(p.id + '/' + t.id), ontoggle: (e) => { const k = p.id + '/' + t.id; if (e.target.open) promptsAbertos.add(k); else promptsAbertos.delete(k); } }, el('summary', { text: `${t.id}: ${t.titulo || ''}${t.confirmar ? ' ⚑' : ''}` }),
        t.confirmar ? el('p', { class: 'hint', text: 'Pede confirmação no modo acompanhado' + (t.motivo ? ': ' + t.motivo : '') }) : null, el('pre', { text: t.prompt }))),
      el('td', { text: t.tipo }), el('td', {}, nivel),
      el('td', { class: 'chain', text: t.cadeiaEfetiva.join(' → ') }),
      el('td', { text: t.depende.join(', ') || '-' }),
      el('td', {}, s ? el('span', { class: 'badge ' + s.state, text: (TAREFA[s.state] || s.state) + (s.model ? ` (${s.model})` : '') }) : el('span', { class: 'hint', text: '-' })));
  }));
  $('verify').textContent = (p.plano.verify || []).length ? 'Verificação após cada integração: ' + p.plano.verify.join(' · ') : '';
}

function renderGates(gates, pid, box) {
  box.classList.toggle('hidden', !gates.length);
  box.replaceChildren(...gates.map((g) => {
    const sim = el('button', { class: 'primary', text: 'Confirmar' }), nao = el('button', { class: 'perigo', text: 'Recusar' });
    const decidir = async (d) => { sim.disabled = nao.disabled = true; try { await call('POST', `/api/projetos/${pid}/confirmar`, { gate: g.gate, decisao: d }); refresh(); } catch (e) { alert(e.message); } };
    sim.onclick = () => decidir('sim'); nao.onclick = () => decidir('nao');
    return el('div', { class: 'card gate' }, el('strong', { text: 'Confirmação pendente' }), el('p', { text: g.motivo }),
      el('p', { class: 'hint', text: g.desde ? 'desde ' + new Date(g.desde).toLocaleString('pt-BR') : '' }), el('div', { class: 'row' }, sim, nao));
  }));
}

const tempo = (iso) => { if (!iso) return ''; const s = Math.max(0, (Date.now() - new Date(iso)) / 1000); return s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`; };
function blocoAtividade(a, { comTitulo = false } = {}) {
  const box = el('div', { class: 'ativ' });
  if (comTitulo) {
    const t = el('a', { href: '#' + a.id, text: a.titulo }); t.onclick = (e) => { e.preventDefault(); abrir(a.id); };
    box.append(el('h3', {}, t, ' ', el('span', { class: 'badge', text: `${a.modo} · ${a.supervisao}` }),
      a.desespero ? el('span', { class: 'badge desespero', text: 'desespero' }) : null, a.ocupado ? el('span', { class: 'badge', text: 'planejador pensando' }) : null));
  }
  if (a.gates?.length) box.append(el('p', { class: 'alerta', text: `${a.gates.length} confirmação pendente: ${a.gates.map((g) => g.motivo).join(' | ')}` }));
  box.append(el('h4', { text: 'Rodando agora' }));
  box.append(a.rodando.length ? el('ul', { class: 'rodando' }, ...a.rodando.map((r) => el('li', {},
    el('strong', { text: `${r.id}${r.titulo ? ': ' + r.titulo : ''}` }), ' ',
    el('span', { class: 'badge ' + r.estado, text: TAREFA[r.estado] || r.estado }), ' ',
    el('span', { class: 'mono', text: r.modelo || '' }), r.desde ? el('span', { class: 'hint', text: ` há ${tempo(r.desde)}` }) : null,
    r.agora?.acao ? el('div', { class: 'acao mono', text: '→ ' + r.agora.acao + (r.agora.atualizado ? ` (${tempo(r.agora.atualizado)} atrás)` : '') }) : null)))
    : el('p', { class: 'hint', text: 'Nenhuma tarefa rodando neste momento.' }));
  box.append(el('h4', { text: 'Últimas atualizações' }));
  box.append(a.eventos.length ? el('ul', { class: 'eventos' }, ...[...a.eventos].reverse().slice(0, 25).map((e) => el('li', {},
    el('span', { class: 'hint', text: new Date(e.time).toLocaleTimeString('pt-BR') + ' ' }),
    e.tarefa ? el('strong', { text: e.tarefa + ' ' }) : null, e.modelo ? el('span', { class: 'mono', text: e.modelo + ' ' }) : null, e.texto || e.tipo)))
    : el('p', { class: 'hint', text: 'Sem eventos ainda.' }));
  if (a.commits?.length) {
    box.append(el('h4', { text: 'Commits recentes no repositório' }));
    box.append(el('ul', { class: 'eventos' }, ...a.commits.map((c) => el('li', {}, el('span', { class: 'mono', text: c.hash + ' ' }), el('span', { class: 'hint', text: c.quando + ' ' }), c.assunto))));
  }
  return box;
}

function render(p) {
  projAtual = p;
  $('pTitulo').textContent = p.titulo;
  const b = $('pEstado'); b.textContent = (ESTADOS[p.estado] || p.estado) + (p.auto ? ' · automático' : ''); b.className = 'badge ' + p.estado;
  $('pDesesp').classList.toggle('hidden', !p.run?.desespero);
  $('pRepo').textContent = p.repo;
  $('pPlanejador').textContent = `Planejador: ${p.planejador || p.plannerEfetivo?.[0] || 'nenhum disponível'}${p.plannerEfetivo?.length > 1 ? ' (reservas: ' + p.plannerEfetivo.slice(1).join(', ') + ')' : ''}`;
  const rodando = p.estado === 'executando';
  if (document.activeElement !== $('pModo')) $('pModo').value = p.modo;
  $('pModo').disabled = rodando;
  if (document.activeElement !== $('pSup')) $('pSup').value = p.supervisao;
  $('pModelos').textContent = rodando ? 'Ver modelos' : 'Modelos';
  $('pAprovar').classList.toggle('hidden', !p.plano || rodando);
  $('pAprovar').textContent = ['concluido', 'incompleto', 'cancelado', 'interrompido'].includes(p.estado) ? 'Executar o plano de novo' : 'Aprovar e iniciar';
  $('pRetomar').classList.toggle('hidden', !['incompleto', 'cancelado', 'interrompido'].includes(p.estado));
  $('pCancelar').classList.toggle('hidden', !rodando);
  const gestaoBloqueada = rodando || p.ocupado;
  $('pArquivar').textContent = p.arquivado ? 'Desarquivar' : 'Arquivar';
  $('pArquivar').disabled = $('pExcluir').disabled = gestaoBloqueada;
  $('pArquivar').title = $('pExcluir').title = gestaoBloqueada ? 'Indisponível enquanto o projeto está rodando ou o planejador está pensando' : '';
  $('pEnviar').disabled = $('pGerar').disabled = p.ocupado || rodando;
  renderGates(p.run?.gates || [], p.id, $('pGates'));
  const ps = $('pPerfil'); if (ps) { if (document.activeElement !== ps) ps.value = p.perfil || ''; ps.disabled = rodando; }
  renderMsgs(p); renderPlano(p);
  atualizarFluxo($('pFluxo'), dadosFluxoProj(p));
  $('log').textContent = p.run?.log || '';
  $('relatorio').textContent = p.relatorio || '';
}

async function refresh() {
  if (vista === 'atividade') return refreshAtividade();
  if (vista === 'cotas') return refreshCotas();
  if (!atual) return;
  try {
    const p = await call('GET', `/api/projetos/${atual}`);
    render(p);
    refreshCotasProjeto(p.id);
    const ativo = p.estado === 'executando' || p.ocupado || Object.keys(p.run?.status || {}).length > 0;
    $('pAtivBox').classList.toggle('hidden', !ativo);
    if (ativo) $('pAtiv').replaceChildren(blocoAtividade(await call('GET', `/api/projetos/${atual}/atividade`)));
  } catch (e) { console.error(e); }
  carregarLista().catch(() => {});
}
// ---------- cotas ----------
let cotasAtualizando = false, cotasLendo = false, cotasUltima = 0, cotasBusy = false;
let pCotasUltima = 0, pCotasId = null;
const emTempo = (iso) => {
  const min = Math.round((new Date(iso) - Date.now()) / 60000);
  if (!(min > 0)) return '';
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  return ' (em ' + (d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`) + ')';
};
function linhaCota(l, { compacta = false, aoAtualizar } = {}) {
  const r = typeof l.restante === 'number' ? l.restante : null;
  let cls = 'cota';
  if (l.atual) cls += ' atual';
  if (l.semCota || (r !== null && r <= 0.02)) cls += ' esgotada';
  else if (r !== null && r < 0.2) cls += ' baixa';
  if (r === null) cls += ' sem-leitura';
  const nome = l.nome + (l.janela ? ' · ' + l.janela : '');
  let pct;
  if (l.instalado === false) pct = 'não instalado';
  else if (l.semCota) pct = 'sem cota';
  else if (r === null) pct = 'sem leitura';
  else pct = Math.round(r * 100) + '% restante';
  const info = [];
  if (l.renovaEm) info.push('renova ' + new Date(l.renovaEm).toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + emTempo(l.renovaEm));
  if (l.lidoEm) info.push('lido às ' + new Date(l.lidoEm).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }));
  if (l.nota || l.fonte) info.push(l.nota || l.fonte);
  const box = el('div', { class: cls }, el('span', { class: 'cota-nome', text: nome }));
  if (r !== null) box.append(el('progress', { class: 'cota-barra', max: 100, value: Math.round(r * 100) }));
  box.append(el('span', { class: 'cota-pct', text: pct }), el('span', { class: 'cota-info', text: info.join(' · ') }));
  if (l.atual) {
    const ms = (l.modelosAtuais || []).map((x) => `${x.modelo} (${x.tarefa})`).join(', ');
    box.append(el('span', { class: 'cota-agora', text: 'trabalhando agora: ' + ms }));
  }
  if (!compacta) {
    const b = el('button', { class: 'cota-btn', type: 'button', text: cotasAtualizando ? 'lendo…' : 'Atualizar', disabled: cotasAtualizando });
    b.onclick = () => atualizarCotas(aoAtualizar);
    box.append(b);
  }
  return box;
}
function marcarLendo(on) {
  cotasAtualizando = on;
  $('cotasLista').classList.toggle('cota-lendo', on);
  for (const b of document.querySelectorAll('.cota-btn')) { b.disabled = on; b.textContent = on ? 'lendo…' : 'Atualizar'; }
}
function cotasMsg(t, erro) { const m = $('cotasMsg'); m.textContent = t || ''; m.className = erro ? 'erro' : 'hint'; }
function renderCotas(d) {
  cotasLendo = !!d.lendo;
  const grupos = new Map();
  for (const l of d.linhas || []) { const g = l.grupo || ''; if (!grupos.has(g)) grupos.set(g, []); grupos.get(g).push(l); }
  const blocos = [];
  for (const [g, ls] of grupos) { if (g) blocos.push(el('h3', { class: 'cotas-grupo', text: g })); blocos.push(...ls.map((l) => el('div', { class: 'card' }, linhaCota(l)))); }
  $('cotasLista').replaceChildren(...(blocos.length ? blocos : [el('p', { class: 'card hint', text: 'Sem leitura de cotas ainda.' })]));
  $('cotasLista').classList.toggle('cota-lendo', cotasAtualizando);
  const partes = [];
  if (d.lidoEm) partes.push('Última leitura às ' + new Date(d.lidoEm).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) + (d.idadeMin != null ? ` (há ${d.idadeMin} min)` : '') + '.');
  if (d.lendo) partes.push('Lendo agora…');
  if (d.aviso) partes.push(d.aviso);
  if (d.erro) cotasMsg(d.erro, true); else cotasMsg(partes.join(' '), false);
}
async function refreshCotas(forcar) {
  if (cotasBusy || cotasAtualizando) return;
  if (!forcar && Date.now() - cotasUltima < (cotasLendo ? 5000 : 30000) - 1500) return;
  cotasBusy = true;
  try { renderCotas(await call('GET', '/api/cotas')); }
  catch (e) { cotasMsg('Não foi possível ler as cotas: ' + e.message, true); }
  finally { cotasBusy = false; cotasUltima = Date.now(); }
  carregarLista().catch(() => {});
}
async function atualizarCotas(aoAtualizar) {
  if (cotasAtualizando) return;
  marcarLendo(true); cotasMsg('Lendo as cotas; leva de 20 a 40 s…', false);
  let msg = null;
  try {
    const d = await call('POST', '/api/cotas/atualizar');
    marcarLendo(false);
    if (vista === 'cotas') { renderCotas(d); if (d.aviso || d.erro) msg = [d.aviso, d.erro].filter(Boolean).join(' '); }
  } catch (e) { marcarLendo(false); msg = 'Não foi possível atualizar: ' + e.message; }
  cotasUltima = Date.now();
  if (msg && vista === 'cotas') cotasMsg(msg, true);
  pCotasUltima = 0;
  if (aoAtualizar) aoAtualizar();
  else if (vista === 'proj') refresh();
}
async function refreshCotasProjeto(id) {
  const box = $('pCotasBox');
  if (pCotasId === id && Date.now() - pCotasUltima < 30000) return;
  pCotasId = id; pCotasUltima = Date.now();
  try {
    const d = await call('GET', `/api/projetos/${id}/cotas`);
    if (id !== atual) return;
    const ls = d.linhas || [];
    box.classList.toggle('hidden', !ls.length);
    $('pCotas').replaceChildren(...ls.map((l) => linhaCota(l, { compacta: true })));
  } catch { if (id === atual) box.classList.add('hidden'); }
}

async function refreshAtividade() {
  try {
    const as = await call('GET', '/api/atividade');
    $('ativLista').replaceChildren(...(as.length ? as.map((a) => el('div', { class: 'card' }, blocoAtividade(a, { comTitulo: true }))) : [el('p', { class: 'card hint', text: 'Nada em andamento agora.' })]));
  } catch (e) { console.error(e); }
  carregarLista().catch(() => {});
}
async function contarAtividade() {
  try {
    const as = await call('GET', '/api/atividade');
    const n = as.reduce((s, a) => s + a.rodando.filter((r) => r.estado === 'running').length, 0);
    const g = as.reduce((s, a) => s + a.gates.length, 0);
    const bd = $('ativBadge'); bd.classList.toggle('hidden', !n && !g);
    bd.textContent = g ? `${g} ⚑` : String(n); bd.classList.toggle('alerta', !!g);
  } catch {}
}
function iniciarTimer() { clearInterval(timer); timer = setInterval(refresh, 4000); }
async function abrir(id) {
  atual = id; ultimoMsgs = -1; projCfg = null; $('pEditorBox').classList.add('hidden'); delete $('pFluxo').dataset.assin; show('proj');
  history.replaceState(null, '', '#' + id);
  await refresh(); iniciarTimer();
}

// ---------- eventos da tela ----------
const aoMudarNovo = () => { $('nModo').value = 'personalizado'; novoPerfil = null; const ps = $('nPerfil'); if (ps) ps.value = ''; descNovo(); fluxoNovo(); };
$('btnNovo').onclick = () => {
  atual = null; clearInterval(timer); show('novo'); carregarLista();
  novoPerfil = null; novoCfg = cfgDeModo($('nModo').value); editor($('nEditor'), novoCfg, { onChange: aoMudarNovo });
  const ps = $('nPerfil'); if (ps) ps.value = '';
  fluxoNovo(true);
};
$('btnCotas').onclick = () => { atual = null; show('cotas'); history.replaceState(null, '', '#cotas'); refreshCotas(true); iniciarTimer(); };
$('btnAtividade').onclick = () => { atual = null; show('atividade'); history.replaceState(null, '', '#atividade'); refreshAtividade(); iniciarTimer(); };
$('nCancelar').onclick = () => show('vazio');
function descNovo() {
  const k = $('nModo').value;
  $('nModoDesc').textContent = k === 'personalizado' ? 'Personalizado: escolha os modelos de cada papel em "Ver e mudar os modelos", do zero ou a partir de um modo pronto.' : MODES[k]?.descricao || '';
  $('nSupDesc').textContent = SUP[$('nSup').value] || '';
}
$('nModo').onchange = () => {
  const k = $('nModo').value;
  novoPerfil = null; novoCfg = cfgDeModo(k); editor($('nEditor'), novoCfg, { onChange: aoMudarNovo });
  const ps = $('nPerfil'); if (ps) ps.value = '';
  if (k === 'personalizado') $('nModelosBox').open = true;
  descNovo(); fluxoNovo();
};
$('nSup').onchange = descNovo;
$('nCriar').onclick = async () => {
  $('nErro').textContent = ''; $('nCriar').disabled = true;
  try {
    const modo = $('nModo').value;
    const p = await call('POST', '/api/projetos', { titulo: $('nTitulo').value.trim() || undefined, repo: $('nRepo').value.trim(), modo, perfil: novoPerfil || undefined, custom: modo === 'personalizado' && !novoPerfil ? novoCfg : undefined,
      supervisao: $('nSup').value, auto: $('nAuto').checked, pedido: $('nPedido').value });
    try { localStorage.setItem('delegar.repo', $('nRepo').value.trim()); } catch {}
    $('nPedido').value = ''; $('nTitulo').value = '';
    abrir(p.id);
  } catch (e) { $('nErro').textContent = e.message; } finally { $('nCriar').disabled = false; }
};
$('pEnviar').onclick = async () => {
  const t = $('pMsg').value.trim(); if (!t) return;
  try { await call('POST', `/api/projetos/${atual}/mensagem`, { texto: t }); $('pMsg').value = ''; refresh(); } catch (e) { alert(e.message); }
};
$('pGerar').onclick = async () => { try { await call('POST', `/api/projetos/${atual}/gerar-plano`); refresh(); } catch (e) { alert(e.message); } };
$('pModo').onchange = async () => {
  const k = $('pModo').value;
  try {
    if (k === 'personalizado') { abrirEditor(true); await call('POST', `/api/projetos/${atual}/ajustes`, { modo: 'personalizado', custom: projCfg }); }
    else { await call('POST', `/api/projetos/${atual}/ajustes`, { modo: k }); $('pEditorBox').classList.add('hidden'); projCfg = null; }
    refresh();
  } catch (e) { alert(e.message); }
};
$('pSup').onchange = async () => { try { await call('POST', `/api/projetos/${atual}/ajustes`, { supervisao: $('pSup').value }); refresh(); } catch (e) { alert(e.message); } };
function aoMudarProj() { $('pModo').value = 'personalizado'; const ps = $('pPerfil'); if (ps) ps.value = ''; }
function abrirEditor(force) {
  if (!projAtual) return;
  const box = $('pEditorBox');
  if (!force && !box.classList.contains('hidden')) { box.classList.add('hidden'); projCfg = null; return; }
  const c = projAtual.config;
  projCfg = cfgDeCustom({ ...c, base: c.base || (projAtual.modo !== 'personalizado' ? projAtual.modo : null) });
  const editavel = projAtual.estado !== 'executando';
  editor($('pEditor'), projCfg, { editavel, onChange: aoMudarProj });
  $('pSalvarModo').classList.toggle('hidden', !editavel);
  $('pEditorErro').textContent = '';
  box.classList.remove('hidden');
}
$('pModelos').onclick = () => abrirEditor(false);
$('pFecharEditor').onclick = () => { $('pEditorBox').classList.add('hidden'); projCfg = null; if (projAtual) $('pModo').value = projAtual.modo; };
$('pSalvarModo').onclick = async () => {
  $('pEditorErro').textContent = '';
  try { await call('POST', `/api/projetos/${atual}/ajustes`, { modo: 'personalizado', custom: projCfg }); $('pEditorBox').classList.add('hidden'); projCfg = null; refresh(); }
  catch (e) { $('pEditorErro').textContent = e.message; }
};
$('pAprovar').onclick = async () => {
  if (!confirm('Iniciar a execução? Os agentes vão agir sem pedir confirmação (commit, push e deploy conforme o plano), exceto nas paradas do acompanhamento escolhido.')) return;
  try { await call('POST', `/api/projetos/${atual}/aprovar`); refresh(); } catch (e) { alert(e.message); }
};
$('pRetomar').onclick = async () => { try { await call('POST', `/api/projetos/${atual}/retomar`); refresh(); } catch (e) { alert(e.message); } };
$('pCancelar').onclick = async () => {
  if (!confirm('Cancelar a execução? Os agentes em andamento serão encerrados.')) return;
  try { await call('POST', `/api/projetos/${atual}/cancelar`); refresh(); } catch (e) { alert(e.message); }
};

$('pArquivar').onclick = async () => {
  try { await call('POST', `/api/projetos/${atual}/arquivar`, { arquivar: !projAtual.arquivado }); await refresh(); } catch (e) { alert(e.message); }
};
$('pExcluir').onclick = async () => {
  if (!confirm(`Excluir o projeto "${projAtual.titulo}"?\n\nEle vai para a lixeira do orquestrador. O repositório e o relatório no cofre não são afetados.`)) return;
  try {
    await call('POST', `/api/projetos/${atual}/excluir`, { confirmar: atual });
    atual = null; projAtual = null; clearInterval(timer);
    history.replaceState(null, '', location.pathname);
    show('vazio'); await carregarLista();
  } catch (e) { alert(e.message); }
};

(async () => {
  const [mo, cat] = await Promise.all([call('GET', '/api/modos'), call('GET', '/api/modelos'), carregarPerfis()]);
  MODES = mo.modos; SUP = mo.supervisao; ULTIMO = mo.ultimoPersonalizado; PADRAO_CUSTOM = mo.padraoPersonalizado; CAT = cat;
  $('provs').replaceChildren(...Object.entries(CAT.provedores).map(([k, v]) => el('span', { class: 'prov ' + (v ? 'ok' : 'nao'), text: k, title: v ? 'instalado' : 'não encontrado neste PC' })));
  fillModes($('nModo')); fillModes($('pModo')); fillSup($('nSup')); fillSup($('pSup'));
  montarBarras();
  ligarFluxo($('nFluxoRow'), $('nFluxoBtn'), $('nFluxo'), dadosFluxoNovo);
  ligarFluxo($('pFluxoRow'), $('pFluxoBtn'), $('pFluxo'), () => (projAtual ? dadosFluxoProj(projAtual) : null));
  $('nModo').value = 'padrao'; $('nSup').value = 'automatico'; descNovo();
  try { const r = localStorage.getItem('delegar.repo'); if (r) $('nRepo').value = r; } catch {}
  $('modosInfo').replaceChildren(
    ...Object.values(MODES).map((m) => el('div', {}, el('strong', { text: m.nome }), el('p', { class: 'hint', text: m.descricao }), el('p', { class: 'hint mono', text: 'Planejador neste PC: ' + (m.plannerEfetivo[0] || 'nenhum instalado') }))),
    el('div', {}, el('strong', { text: 'Personalizado' }), el('p', { class: 'hint', text: 'Escolha os modelos de cada papel do zero, ou parta de um modo pronto e troque o que quiser.' })),
    el('div', {}, el('strong', { text: 'Acompanhamento' }), ...Object.values(SUP).map((d) => el('p', { class: 'hint', text: d }))));
  const h = location.hash.slice(1);
  await carregarLista();
  if (h === 'atividade') $('btnAtividade').onclick();
  else if (h === 'cotas') $('btnCotas').onclick();
  else if (h) abrir(h);
  contarAtividade(); setInterval(contarAtividade, 8000);
  setInterval(() => { if (!atual && vista !== 'atividade' && vista !== 'cotas') carregarLista().catch(() => {}); }, 8000);
})();
