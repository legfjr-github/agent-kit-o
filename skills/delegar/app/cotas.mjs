// Cotas dos modelos: transforma o JSON do quota.ps1 em linhas para o painel.
// Puro: não lê arquivo nem roda processo; tudo que precisa vem por parâmetro.

const ENTRADA = /^(claude|agy|opencode):([^@\s]+)(@[A-Za-z]+)?$/;

// Grupo de cota do modelo "<provedor>:<modelo>[@esforço]"; null se a entrada não for válida.
export function grupoDoModelo(entry) {
  if (typeof entry !== 'string') return null;
  const m = ENTRADA.exec(entry);
  if (!m) return null;
  const [, prov, modelo] = m;
  if (prov === 'claude') return 'claude';
  if (prov === 'opencode') return 'opencode';
  const nome = modelo.toLowerCase();
  if (nome.includes('argon')) return 'argon';
  if (nome.startsWith('claude') || nome.startsWith('gpt')) return 'agy-claude-gpt';
  return 'gemini';
}

const limita = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null);

// Hora local sem fuso ("2026-11-13T14:30:00") ou ISO completo -> ISO; null se não der para ler.
function iso(v) {
  if (typeof v !== 'string' || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function hhmm(v) {
  const d = typeof v === 'string' && v ? new Date(v) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

// Restante (0..1): usa o campo de restante; sem ele, 1 - usado.
function restanteDe(g, usado, restante) {
  const r = limita(g[restante]);
  if (r !== null) return r;
  const u = limita(g[usado]);
  return u === null ? null : limita(1 - u);
}

// Linhas na ordem fixa do painel. `provedores` é o que o servidor detectou ({ claude, agy, opencode }); o campo
// installed do quota.ps1 tem prioridade.
export function linhasDeCotas(q, provedores) {
  q = obj(q); provedores = obj(provedores);
  const inst = (nome) => {
    const v = obj(q[nome]).installed;
    return typeof v === 'boolean' ? v : !!provedores[nome];
  };
  const instClaude = inst('claude');
  const instAgy = inst('agy');
  const instOpencode = inst('opencode');
  const linhas = [];

  const linha = (chave, grupo, nome, janela, provedor, instalado, g, campos, extra = {}) => {
    const restante = extra.restante !== undefined ? extra.restante : campos ? restanteDe(g, campos.usado, campos.restante) : null;
    const lida = g.read === true && restante !== null;
    const temValor = restante !== null;
    let fonte = extra.fonte;
    if (!fonte) fonte = lida ? 'leitura' : temValor ? 'última leitura' : 'sem leitura';
    linhas.push({
      chave, grupo, nome, janela, provedor, instalado, lida, restante,
      renovaEm: campos ? iso(g[campos.renova]) : null,
      lidoEm: iso(g.readAt) || (temValor ? iso(q.time) : null),
      fonte, semCota: !!extra.semCota, nota: extra.nota || '',
    });
  };

  const c = obj(q.claude);
  linha('claude-5h', 'claude', 'Claude', '5 h', 'claude', instClaude, c, { usado: 'fiveHour', restante: 'fiveHourRemaining', renova: 'fiveHourResets' });
  linha('claude-semanal', 'claude', 'Claude', 'semanal', 'claude', instClaude, c, { usado: 'sevenDay', restante: 'sevenDayRemaining', renova: 'sevenDayResets' });

  // Gemini: leitura real do agy, arquivo manual ou só o registro de estouros.
  const g = obj(q.gemini);
  const src = typeof g.source === 'string' ? g.source : '';
  const soRegistro = src === 'ledger' && g.read !== true;
  const fonteGemini = src === 'manual' ? 'arquivo manual' : soRegistro ? 'registro de estouros' : null;
  const hora = soRegistro ? hhmm(g.lastQuotaHit) : null;
  const estouro = soRegistro && (g.exhausted === true || !!hora);
  const extraG = (campos) => {
    const e = {};
    if (fonteGemini) e.fonte = fonteGemini;
    if (soRegistro) { e.restante = null; if (estouro) { e.semCota = true; e.nota = hora ? `estouro registrado às ${hora}` : 'estouro registrado'; } }
    else if (g.exhausted === true) { e.semCota = true; if (restanteDe(g, campos.usado, campos.restante) === null) e.restante = 0; }
    return e;
  };
  const cg5 = { usado: 'fiveHour', restante: 'fiveHourRemaining', renova: 'fiveHourResets' };
  const cgSem = { usado: 'sevenDay', restante: 'sevenDayRemaining', renova: 'sevenDayResets' };
  linha('gemini-5h', 'gemini', 'Gemini', '5 h', 'agy', instAgy, g, cg5, extraG(cg5));
  linha('gemini-semanal', 'gemini', 'Gemini', 'semanal', 'agy', instAgy, g, cgSem, extraG(cgSem));

  // Gemini 4 Argon: só a janela semanal.
  const a = obj(q.argon);
  const ca = { usado: 'sevenDay', restante: 'sevenDayRemaining', renova: 'sevenDayResets' };
  linha('argon-semanal', 'argon', 'Gemini 4 Argon', 'semanal', 'agy', instAgy, a, ca,
    a.exhausted === true ? { semCota: true, ...(restanteDe(a, ca.usado, ca.restante) === null ? { restante: 0 } : {}) } : {});

  // Claude e GPT pelo Antigravity.
  const x = obj(q.agyClaudeGpt);
  const cx5 = { usado: 'fiveHour', restante: 'fiveHourRemaining', renova: 'fiveHourResets' };
  const exX = x.exhausted === true;
  linha('agy-claude-gpt-5h', 'agy-claude-gpt', 'Claude e GPT (Antigravity)', '5 h', 'agy', instAgy, x, cx5,
    exX ? { semCota: true, ...(restanteDe(x, cx5.usado, cx5.restante) === null ? { restante: 0 } : {}) } : {});
  linha('agy-claude-gpt-semanal', 'agy-claude-gpt', 'Claude e GPT (Antigravity)', 'semanal', 'agy', instAgy, x, cgSem,
    exX ? { semCota: true, ...(restanteDe(x, cgSem.usado, cgSem.restante) === null ? { restante: 0 } : {}) } : {});

  linhas.push({
    chave: 'opencode', grupo: 'opencode', nome: 'opencode (gratuitos)', janela: null, provedor: 'opencode', instalado: instOpencode,
    lida: false, restante: null, renovaEm: null, lidoEm: null, fonte: 'sem leitura', semCota: false, nota: 'sem cota',
  });
  return linhas;
}

// Linhas dos grupos usados pelo projeto. `entradas`: lista de "provedor:modelo"; `atuais`: [{ tarefa, modelo }] das tarefas rodando.
export function cotasDoProjeto(linhas, entradas, atuais) {
  const grupos = new Set((Array.isArray(entradas) ? entradas : []).map(grupoDoModelo).filter(Boolean));
  const emUso = {};
  for (const it of Array.isArray(atuais) ? atuais : []) {
    const gr = grupoDoModelo(it && it.modelo);
    if (!gr) continue;
    (emUso[gr] ||= []).push({ tarefa: it.tarefa, modelo: it.modelo });
  }
  return (Array.isArray(linhas) ? linhas : []).filter((l) => grupos.has(l.grupo))
    .map((l) => ({ ...l, atual: !!emUso[l.grupo], modelosAtuais: emUso[l.grupo] || [] }));
}
