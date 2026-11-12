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
let MODES = {}, atual = null, ultimoMsgs = -1, timer = null;

function fillModes(sel) {
  sel.replaceChildren(...Object.entries(MODES).map(([k, m]) => el('option', { value: k, text: m.nome })));
}
function show(id) { for (const s of ['vazio', 'novo', 'proj']) $(s).classList.toggle('hidden', s !== id); }

async function carregarLista() {
  const ps = await call('GET', '/api/projetos');
  $('lista').replaceChildren(...(ps.length ? ps.map((p) => {
    const b = el('button', { class: 'item' + (p.id === atual ? ' ativo' : '') }, el('strong', { text: p.titulo }),
      el('small', { text: `${ESTADOS[p.estado] || p.estado} · ${MODES[p.modo]?.nome || p.modo}${p.ocupado ? ' · pensando…' : ''}` }));
    b.onclick = () => abrir(p.id);
    return b;
  }) : [el('p', { class: 'hint', text: 'Sem projetos ainda.' })]));
}

function renderMsgs(p) {
  if (p.mensagens.length === ultimoMsgs && !p.ocupado) return;
  const box = $('msgs'); const fim = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
  const quem = { usuario: 'Você', planejador: 'Planejador (Claude)', sistema: 'Sistema' };
  const limpa = (m) => m.papel === 'planejador' ? m.texto.replace(/```json[\s\S]*?```/g, '[plano em JSON: veja a tabela em "Plano e divisão"]') : m.texto;
  box.replaceChildren(...p.mensagens.map((m) => el('div', { class: 'msg ' + m.papel }, el('span', { class: 'quem', text: `${quem[m.papel] || m.papel} · ${new Date(m.quando).toLocaleString('pt-BR')}` }), limpa(m))));
  if (p.ocupado) box.append(el('div', { class: 'pensando', text: 'O planejador está pensando… (pode levar alguns minutos)' }));
  if (fim || ultimoMsgs === -1) box.scrollTop = box.scrollHeight;
  ultimoMsgs = p.mensagens.length;
}

function renderPlano(p) {
  const tb = $('tarefas').tBodies[0];
  const run = p.run?.status || {};
  const editavel = !['executando'].includes(p.estado);
  if (!p.plano) { $('planoResumo').textContent = 'Ainda sem plano.'; tb.replaceChildren(); $('divisao').replaceChildren(); $('verify').textContent = ''; return; }
  $('planoResumo').textContent = p.plano.resumo || '';
  const cont = {};
  for (const t of p.plano.tarefas) { const k = t.cadeiaEfetiva[0]; cont[k] = (cont[k] || 0) + 1; }
  $('divisao').replaceChildren(...Object.entries(cont).map(([k, n]) => el('span', { text: `${k}: ${n} tarefa${n > 1 ? 's' : ''}` })));
  tb.replaceChildren(...p.plano.tarefas.map((t) => {
    const nivel = el('select', { disabled: !editavel }, ...['pesado', 'volume', 'leve'].map((n) => el('option', { value: n, text: n, selected: n === t.nivel })));
    nivel.onchange = async () => { try { await call('POST', `/api/projetos/${p.id}/ajustes`, { niveis: { [t.id]: nivel.value } }); refresh(); } catch (e) { alert(e.message); } };
    const s = run[t.id];
    return el('tr', {},
      el('td', {}, el('details', {}, el('summary', { text: `${t.id}: ${t.titulo || ''}` }), el('pre', { text: t.prompt }))),
      el('td', { text: t.tipo }), el('td', {}, nivel),
      el('td', { class: 'chain', text: t.cadeiaEfetiva.join(' → ') }),
      el('td', { text: t.depende.join(', ') || '-' }),
      el('td', {}, s ? el('span', { class: 'badge ' + s.state, text: s.state + (s.model ? ` (${s.model})` : '') }) : el('span', { class: 'hint', text: '-' })));
  }));
  $('verify').textContent = (p.plano.verify || []).length ? 'Verificação após cada integração: ' + p.plano.verify.join(' · ') : '';
}

function render(p) {
  $('pTitulo').textContent = p.titulo;
  const b = $('pEstado'); b.textContent = (ESTADOS[p.estado] || p.estado) + (p.auto ? ' · automático' : ''); b.className = 'badge ' + p.estado;
  $('pRepo').textContent = p.repo;
  $('pModo').value = p.modo; $('pModo').disabled = p.estado === 'executando';
  $('pAprovar').classList.toggle('hidden', !p.plano || ['executando'].includes(p.estado));
  $('pAprovar').textContent = ['concluido', 'incompleto', 'cancelado', 'interrompido'].includes(p.estado) ? 'Executar o plano de novo' : 'Aprovar e iniciar';
  $('pRetomar').classList.toggle('hidden', !['incompleto', 'cancelado', 'interrompido'].includes(p.estado));
  $('pCancelar').classList.toggle('hidden', p.estado !== 'executando');
  $('pEnviar').disabled = $('pGerar').disabled = p.ocupado || p.estado === 'executando';
  renderMsgs(p); renderPlano(p);
  $('log').textContent = p.run?.log || '';
  $('relatorio').textContent = p.relatorio || '';
}

async function refresh() {
  if (!atual) return;
  try { render(await call('GET', `/api/projetos/${atual}`)); } catch (e) { console.error(e); }
  carregarLista().catch(() => {});
}
async function abrir(id) {
  atual = id; ultimoMsgs = -1; show('proj'); await refresh();
  clearInterval(timer); timer = setInterval(refresh, 4000);
}

$('btnNovo').onclick = () => { atual = null; clearInterval(timer); show('novo'); carregarLista(); };
$('nCancelar').onclick = () => show('vazio');
$('nModo').onchange = () => { $('nModoDesc').textContent = MODES[$('nModo').value]?.descricao || ''; };
$('nCriar').onclick = async () => {
  $('nErro').textContent = ''; $('nCriar').disabled = true;
  try {
    const p = await call('POST', '/api/projetos', { titulo: $('nTitulo').value.trim() || undefined, repo: $('nRepo').value.trim(), modo: $('nModo').value, auto: $('nAuto').checked, pedido: $('nPedido').value });
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
$('pModo').onchange = async () => { try { await call('POST', `/api/projetos/${atual}/ajustes`, { modo: $('pModo').value }); refresh(); } catch (e) { alert(e.message); } };
$('pAprovar').onclick = async () => {
  if (!confirm('Iniciar a execução? Os agentes vão agir sem pedir confirmação (commit, push e deploy conforme o plano).')) return;
  try { await call('POST', `/api/projetos/${atual}/aprovar`); refresh(); } catch (e) { alert(e.message); }
};
$('pRetomar').onclick = async () => { try { await call('POST', `/api/projetos/${atual}/retomar`); refresh(); } catch (e) { alert(e.message); } };
$('pCancelar').onclick = async () => {
  if (!confirm('Cancelar a execução? Os agentes em andamento serão encerrados.')) return;
  try { await call('POST', `/api/projetos/${atual}/cancelar`); refresh(); } catch (e) { alert(e.message); }
};

(async () => {
  MODES = await call('GET', '/api/modos');
  fillModes($('nModo')); fillModes($('pModo')); $('nModo').value = 'padrao'; $('nModo').onchange();
  try { const r = localStorage.getItem('delegar.repo'); if (r) $('nRepo').value = r; } catch {}
  $('modosInfo').replaceChildren(...Object.values(MODES).map((m) => el('div', {}, el('strong', { text: m.nome }), el('p', { class: 'hint', text: m.descricao }))));
  const h = location.hash.slice(1);
  await carregarLista();
  if (h) abrir(h);
  setInterval(() => { if (!atual) carregarLista().catch(() => {}); }, 8000);
})();
