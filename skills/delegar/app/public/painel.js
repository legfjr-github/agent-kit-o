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
function show(id) { vista = id; for (const s of ['vazio', 'novo', 'proj', 'atividade']) $(s).classList.toggle('hidden', s !== id); }

// ---------- editor de modo ----------
function editor(box, cfg, { editavel = true, onChange } = {}) {
  const sel = () => {
    const s = el('select', { class: 'modelo' });
    for (const prov of ['claude', 'agy', 'opencode']) {
      const g = el('optgroup', { label: prov + (CAT.provedores[prov] ? '' : ' (não instalado neste PC)') });
      for (const m of CAT.modelos.filter((x) => x.provedor === prov)) g.append(el('option', { value: m.id, text: m.id.slice(prov.length + 1) + (m.desespero ? ` · gratuito nº ${m.desespero}` : '') }));
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
        const c = el('span', { class: 'chip', title: (CAT.modelos.find((m) => m.id === id.split('@')[0])?.dica) || '' }, el('span', { text: `${i + 1}. ${nomeModelo(id)}` }));
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

// ---------- lista ----------
async function carregarLista() {
  const ps = await call('GET', '/api/projetos');
  $('lista').replaceChildren(...(ps.length ? ps.map((p) => {
    const b = el('button', { class: 'item' + (p.id === atual ? ' ativo' : '') }, el('strong', { text: p.titulo }),
      el('small', { text: `${ESTADOS[p.estado] || p.estado} · ${p.modoNome}${p.ocupado ? ' · pensando…' : ''}` }),
      p.gates ? el('small', { class: 'alerta', text: `${p.gates} confirmação pendente` }) : null);
    b.onclick = () => abrir(p.id);
    return b;
  }) : [el('p', { class: 'hint', text: 'Sem projetos ainda.' })]));
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
  $('pEnviar').disabled = $('pGerar').disabled = p.ocupado || rodando;
  renderGates(p.run?.gates || [], p.id, $('pGates'));
  renderMsgs(p); renderPlano(p);
  $('log').textContent = p.run?.log || '';
  $('relatorio').textContent = p.relatorio || '';
}

async function refresh() {
  if (vista === 'atividade') return refreshAtividade();
  if (!atual) return;
  try {
    const p = await call('GET', `/api/projetos/${atual}`);
    render(p);
    const ativo = p.estado === 'executando' || p.ocupado || Object.keys(p.run?.status || {}).length > 0;
    $('pAtivBox').classList.toggle('hidden', !ativo);
    if (ativo) $('pAtiv').replaceChildren(blocoAtividade(await call('GET', `/api/projetos/${atual}/atividade`)));
  } catch (e) { console.error(e); }
  carregarLista().catch(() => {});
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
  atual = id; ultimoMsgs = -1; projCfg = null; $('pEditorBox').classList.add('hidden'); show('proj');
  history.replaceState(null, '', '#' + id);
  await refresh(); iniciarTimer();
}

// ---------- eventos da tela ----------
const aoMudarNovo = () => { $('nModo').value = 'personalizado'; descNovo(); };
$('btnNovo').onclick = () => {
  atual = null; clearInterval(timer); show('novo'); carregarLista();
  novoCfg = cfgDeModo($('nModo').value); editor($('nEditor'), novoCfg, { onChange: aoMudarNovo });
};
$('btnAtividade').onclick = () => { atual = null; show('atividade'); history.replaceState(null, '', '#atividade'); refreshAtividade(); iniciarTimer(); };
$('nCancelar').onclick = () => show('vazio');
function descNovo() {
  const k = $('nModo').value;
  $('nModoDesc').textContent = k === 'personalizado' ? 'Personalizado: escolha os modelos de cada papel em "Ver e mudar os modelos", do zero ou a partir de um modo pronto.' : MODES[k]?.descricao || '';
  $('nSupDesc').textContent = SUP[$('nSup').value] || '';
}
$('nModo').onchange = () => {
  const k = $('nModo').value;
  novoCfg = cfgDeModo(k); editor($('nEditor'), novoCfg, { onChange: aoMudarNovo });
  if (k === 'personalizado') $('nModelosBox').open = true;
  descNovo();
};
$('nSup').onchange = descNovo;
$('nCriar').onclick = async () => {
  $('nErro').textContent = ''; $('nCriar').disabled = true;
  try {
    const modo = $('nModo').value;
    const p = await call('POST', '/api/projetos', { titulo: $('nTitulo').value.trim() || undefined, repo: $('nRepo').value.trim(), modo, custom: modo === 'personalizado' ? novoCfg : undefined,
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
function abrirEditor(force) {
  if (!projAtual) return;
  const box = $('pEditorBox');
  if (!force && !box.classList.contains('hidden')) { box.classList.add('hidden'); projCfg = null; return; }
  const c = projAtual.config;
  projCfg = { base: c.base || (projAtual.modo !== 'personalizado' ? projAtual.modo : null), planner: [...c.planner], fix: [...c.fix], coord: [...c.coord], maxConcurrent: c.maxConcurrent,
    tiers: { pesado: [...flat(c.tiers.pesado)], volume: [...flat(c.tiers.volume)], leve: [...flat(c.tiers.leve)] } };
  const editavel = projAtual.estado !== 'executando';
  editor($('pEditor'), projCfg, { editavel, onChange: () => { $('pModo').value = 'personalizado'; } });
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

(async () => {
  const [mo, cat] = await Promise.all([call('GET', '/api/modos'), call('GET', '/api/modelos')]);
  MODES = mo.modos; SUP = mo.supervisao; ULTIMO = mo.ultimoPersonalizado; PADRAO_CUSTOM = mo.padraoPersonalizado; CAT = cat;
  $('provs').replaceChildren(...Object.entries(CAT.provedores).map(([k, v]) => el('span', { class: 'prov ' + (v ? 'ok' : 'nao'), text: k, title: v ? 'instalado' : 'não encontrado neste PC' })));
  fillModes($('nModo')); fillModes($('pModo')); fillSup($('nSup')); fillSup($('pSup'));
  $('nModo').value = 'padrao'; $('nSup').value = 'automatico'; descNovo();
  try { const r = localStorage.getItem('delegar.repo'); if (r) $('nRepo').value = r; } catch {}
  $('modosInfo').replaceChildren(
    ...Object.values(MODES).map((m) => el('div', {}, el('strong', { text: m.nome }), el('p', { class: 'hint', text: m.descricao }), el('p', { class: 'hint mono', text: 'Planejador neste PC: ' + (m.plannerEfetivo[0] || 'nenhum instalado') }))),
    el('div', {}, el('strong', { text: 'Personalizado' }), el('p', { class: 'hint', text: 'Escolha os modelos de cada papel do zero, ou parta de um modo pronto e troque o que quiser.' })),
    el('div', {}, el('strong', { text: 'Acompanhamento' }), ...Object.values(SUP).map((d) => el('p', { class: 'hint', text: d }))));
  const h = location.hash.slice(1);
  await carregarLista();
  if (h === 'atividade') $('btnAtividade').onclick();
  else if (h) abrir(h);
  contarAtividade(); setInterval(contarAtividade, 8000);
  setInterval(() => { if (!atual && vista !== 'atividade') carregarLista().catch(() => {}); }, 8000);
})();
