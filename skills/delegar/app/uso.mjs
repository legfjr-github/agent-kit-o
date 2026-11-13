// Uso real de tokens por CLI (claude, agy, opencode), extraído da saída que a própria CLI já produz.
// Sem dependências externas. Nenhuma função lança exceção: sem dado, o retorno é null.
//
// Registro de uso (um por tentativa e por chamada do planejador):
//   { modelo, entrada, saida, cacheLido, cacheGravado, fonte, custoCliUsd,
//     porModelo: [{ provedor, modelo, entrada, saida, cacheLido, cacheGravado, custoCliUsd }] }
// fonte: 'cli' (contagem completa), 'cli-parcial' (execução interrompida) ou 'estimado' (caracteres / 4).
// saida inclui os tokens de raciocínio quando a CLI os separa. custoCliUsd é null quando a CLI não informa.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const PROVEDORES = ['claude', 'agy', 'opencode'];
const REGEX_ESFORCO = /@(low|medium|high|xhigh|max)$/;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const numOuNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const arred = (v) => (v === null ? null : Math.round(v * 1e6) / 1e6);

// 'claude:haiku@high' -> 'claude:haiku'
export function modeloSemEsforco(entry) {
  return String(entry ?? '').trim().replace(REGEX_ESFORCO, '');
}

// Separa 'provedor:modelo'. Sem prefixo de provedor conhecido, usa o provedor padrão.
function partes(entry, provPadrao) {
  const s = modeloSemEsforco(entry);
  const i = s.indexOf(':');
  if (i > 0 && PROVEDORES.includes(s.slice(0, i))) return { provedor: s.slice(0, i), modelo: s.slice(i + 1) };
  return { provedor: provPadrao || 'desconhecido', modelo: s };
}

function linhaModelo(provedor, modelo, t, custo) {
  return {
    provedor, modelo,
    entrada: num(t.entrada), saida: num(t.saida), cacheLido: num(t.cacheLido), cacheGravado: num(t.cacheGravado),
    custoCliUsd: numOuNull(custo),
  };
}

function montar(p, fonte, linhas, custoTotal) {
  const soma = { entrada: 0, saida: 0, cacheLido: 0, cacheGravado: 0 };
  let custoLinhas = null;
  for (const l of linhas) {
    soma.entrada += l.entrada; soma.saida += l.saida; soma.cacheLido += l.cacheLido; soma.cacheGravado += l.cacheGravado;
    if (l.custoCliUsd !== null) custoLinhas = (custoLinhas ?? 0) + l.custoCliUsd;
  }
  const custo = numOuNull(custoTotal) ?? arred(custoLinhas);
  return {
    modelo: `${p.provedor}:${p.modelo}`,
    ...soma, fonte, custoCliUsd: custo,
    porModelo: linhas,
  };
}

// ---------- leitura tolerante ----------
const semBom = (s) => String(s ?? '').replace(/^﻿/, '');

// Aceita texto JSONL (ignora linhas que não são JSON), um array de eventos ou um objeto único.
function eventos(entrada) {
  if (Array.isArray(entrada)) return entrada.filter((e) => e && typeof e === 'object');
  if (entrada && typeof entrada === 'object') return [entrada];
  const out = [];
  for (const bruta of semBom(entrada).split(/\r?\n/)) {
    const l = bruta.trim().replace(/^﻿/, '');
    if (!l.startsWith('{')) continue;
    try { const e = JSON.parse(l); if (e && typeof e === 'object') out.push(e); } catch {}
  }
  return out;
}

// ---------- claude ----------
// Linha do evento result do claude (stream-json) ou objeto de `claude -p --output-format json`.
function deResultadoClaude(ev, modelo) {
  const p = partes(modelo, 'claude');
  const mu = ev.modelUsage && typeof ev.modelUsage === 'object' ? ev.modelUsage : null;
  const chaves = mu ? Object.keys(mu) : [];
  let linhas;
  if (chaves.length) {
    linhas = chaves.map((id) => {
      const m = mu[id] || {};
      return linhaModelo('claude', id, {
        entrada: m.inputTokens, saida: m.outputTokens, cacheLido: m.cacheReadInputTokens, cacheGravado: m.cacheCreationInputTokens,
      }, m.costUSD);
    });
  } else if (ev.usage && typeof ev.usage === 'object') {
    const u = ev.usage;
    linhas = [linhaModelo('claude', p.modelo, {
      entrada: u.input_tokens, saida: u.output_tokens, cacheLido: u.cache_read_input_tokens, cacheGravado: u.cache_creation_input_tokens,
    }, ev.total_cost_usd)];
  } else return null;
  return montar(p, 'cli', linhas, ev.total_cost_usd);
}

export function usoClaudeStream(texto, modelo) {
  try {
    const evs = eventos(texto);
    const res = evs.filter((e) => e.type === 'result' && (e.usage || e.modelUsage)).pop();
    if (res) return deResultadoClaude(res, modelo);
    // Sem result: soma o uso das mensagens do assistente. O mesmo message.id repete em vários eventos; vale o último.
    const porId = new Map();
    evs.forEach((e, n) => {
      const m = e.type === 'assistant' ? e.message : null;
      if (!m || !m.usage) return;
      porId.set(m.id || `sem-id-${n}`, m);
    });
    if (!porId.size) return null;
    const p = partes(modelo, 'claude');
    const acc = new Map();
    for (const m of porId.values()) {
      const id = m.model && m.model !== '<synthetic>' ? m.model : p.modelo;
      const t = acc.get(id) || { entrada: 0, saida: 0, cacheLido: 0, cacheGravado: 0 };
      t.entrada += num(m.usage.input_tokens); t.saida += num(m.usage.output_tokens);
      t.cacheLido += num(m.usage.cache_read_input_tokens); t.cacheGravado += num(m.usage.cache_creation_input_tokens);
      acc.set(id, t);
    }
    const linhas = [...acc].map(([id, t]) => linhaModelo('claude', id, t, null));
    return montar(p, 'cli-parcial', linhas, null);
  } catch { return null; }
}

export function usoClaudeJson(obj, modelo) {
  try {
    let o = obj;
    if (typeof o === 'string') {
      let inteiro = null;
      try { inteiro = JSON.parse(semBom(o)); } catch {}   // objeto único, possivelmente em várias linhas
      o = inteiro && typeof inteiro === 'object' ? inteiro : eventos(o).filter((e) => e.usage || e.modelUsage).pop();
    }
    if (Array.isArray(o)) o = o.filter((e) => e && (e.usage || e.modelUsage)).pop();
    if (!o || typeof o !== 'object') return null;
    return deResultadoClaude(o, modelo);
  } catch { return null; }
}

// ---------- opencode ----------
// `opencode run --format json`: um evento step_finish por passo, com part.tokens
// {total,input,output,reasoning,cache:{read,write}} e part.cost.
export function usoOpencode(textoOuEventos, modelo) {
  try {
    const passos = eventos(textoOuEventos).filter((e) => e.type === 'step_finish' && e.part && e.part.tokens);
    if (!passos.length) return null;
    const p = partes(modelo, 'opencode');
    const t = { entrada: 0, saida: 0, cacheLido: 0, cacheGravado: 0 };
    let custo = null;
    for (const e of passos) {
      const k = e.part.tokens;
      t.entrada += num(k.input); t.saida += num(k.output) + num(k.reasoning);
      t.cacheLido += num(k.cache?.read); t.cacheGravado += num(k.cache?.write);
      if (numOuNull(e.part.cost) !== null) custo = (custo ?? 0) + e.part.cost;
    }
    custo = arred(custo);
    return montar(p, 'cli', [linhaModelo(p.provedor, p.modelo, t, custo)], custo);
  } catch { return null; }
}

// ---------- agy ----------
const linhaAgy = (u) => ({
  entrada: num(u.input_tokens), saida: num(u.output_tokens) + num(u.thinking_tokens),
  cacheLido: num(u.cache_read_tokens), cacheGravado: num(u.cache_write_tokens),
});

// stream-json do agy: evento 'result' com result.usage {input_tokens,output_tokens,thinking_tokens,cache_read_tokens,total_tokens}
// e, em cada passo concluído, step_update.usage com os mesmos campos.
// Texto puro (o que o worker grava com --print) não traz contagem: estima por prompt + resposta.
export function usoAgyStream(textoOuEventos, modelo, { prompt } = {}) {
  try {
    const p = partes(modelo, 'agy');
    const evs = eventos(textoOuEventos).filter((e) => typeof e.event === 'string');
    const res = evs.filter((e) => e.event === 'result').pop();
    if (res?.result?.usage) return montar(p, 'cli', [linhaModelo(p.provedor, p.modelo, linhaAgy(res.result.usage), null)], null);
    const passos = new Map();
    evs.forEach((e, n) => {
      const s = e.event === 'step_update' ? e.step_update : null;
      if (s && s.usage) passos.set(`${s.conversation_id}#${s.step_index ?? n}`, s.usage);
    });
    if (passos.size) {
      const t = { entrada: 0, saida: 0, cacheLido: 0, cacheGravado: 0 };
      for (const u of passos.values()) { const l = linhaAgy(u); for (const k of Object.keys(t)) t[k] += l[k]; }
      return montar(p, 'cli-parcial', [linhaModelo(p.provedor, p.modelo, t, null)], null);
    }
    let resposta;
    if (evs.length) {
      resposta = String(res?.result?.response ?? evs.map((e) => (e.event === 'step_update' && e.step_update?.step_type === 'agent_response' ? e.step_update.text_delta || '' : '')).join(''));
    } else resposta = typeof textoOuEventos === 'string' ? semBom(textoOuEventos) : '';
    if (!resposta.trim()) return null;
    return estimar(String(prompt ?? '').length, resposta.length, modelo);
  } catch { return null; }
}

// Logs locais do agy: cada sessão é uma pasta em ~/.gemini/antigravity-cli/brain/<sessão> com
// .system_generated/logs/transcript_full.jsonl; cada resposta do modelo é uma linha com input_tokens,
// cache_read_tokens e output_tokens. A sessão da tentativa é a que começou na janela da tentativa e cuja
// primeira mensagem contém o começo do prompt. DELEGAR_AGY_BRAIN troca a pasta (testes).
export function usoAgyBrain(prompt, inicioMs, fimMs, modelo, pastas) {
  try {
    const p = partes(modelo, 'agy');
    const bases = pastas || (process.env.DELEGAR_AGY_BRAIN ? [process.env.DELEGAR_AGY_BRAIN]
      : [path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain')]);
    const assinatura = String(prompt || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    if (assinatura.length < 20 || !Number.isFinite(inicioMs)) return null;
    const ate = Number.isFinite(fimMs) ? fimMs + 120000 : Date.now();
    const t = { entrada: 0, saida: 0, cacheLido: 0, cacheGravado: 0 };
    let achou = false;
    for (const base of bases) {
      let dirs = [];
      try { dirs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { continue; }
      for (const d of dirs) {
        const pasta = path.join(base, d.name);
        let st; try { st = fs.statSync(pasta); } catch { continue; }
        if (st.mtimeMs < inicioMs - 120000) continue; // sessão anterior à tentativa
        const arq = path.join(pasta, '.system_generated', 'logs', 'transcript_full.jsonl');
        let txt; try { if (fs.statSync(arq).size > 50 * 1024 * 1024) continue; txt = fs.readFileSync(arq, 'utf8'); } catch { continue; }
        const linhas = txt.split(/\r?\n/).filter(Boolean);
        let primeira; try { primeira = JSON.parse(linhas[0]); } catch { continue; }
        const conteudo = String(primeira.content || '').replace(/\s+/g, ' ');
        const criada = Date.parse(primeira.created_at);
        if (!conteudo.includes(assinatura) || !(criada >= inicioMs - 120000 && criada <= ate)) continue;
        achou = true;
        for (const l of linhas) {
          let e; try { e = JSON.parse(l); } catch { continue; }
          if (e.source !== 'MODEL' || e.input_tokens == null) continue;
          t.entrada += num(e.input_tokens); t.saida += num(e.output_tokens); t.cacheLido += num(e.cache_read_tokens);
        }
      }
    }
    return achou ? montar(p, 'cli', [linhaModelo(p.provedor, p.modelo, t, null)], null) : null;
  } catch { return null; }
}

// ---------- estimativa ----------
export function estimar(caracteresEntrada, caracteresSaida, modelo) {
  const p = partes(modelo, 'desconhecido');
  const tok = (c) => Math.ceil(Math.max(0, num(Number(c))) / 4);
  return montar(p, 'estimado', [linhaModelo(p.provedor, p.modelo, { entrada: tok(caracteresEntrada), saida: tok(caracteresSaida), cacheLido: 0, cacheGravado: 0 }, null)], null);
}

// ---------- tentativa ----------
function ler(arquivo) {
  if (!arquivo) return '';
  try { return semBom(fs.readFileSync(String(arquivo), 'utf8')); } catch { return ''; }
}

export function usoDaTentativa({ tipo, modelo, out, prompt, texto } = {}) {
  try {
    const p = partes(modelo, PROVEDORES.includes(tipo) ? tipo : 'desconhecido');
    const prov = PROVEDORES.includes(tipo) ? tipo : p.provedor;
    const m = `${p.provedor}:${p.modelo}`;
    const saidaCli = ler(out);
    const promptTxt = ler(prompt);
    const final = ler(texto);
    let uso = null;
    if (prov === 'claude') {
      uso = usoClaudeStream(saidaCli, m) || usoClaudeJson(saidaCli, m);
    } else if (prov === 'opencode') uso = usoOpencode(saidaCli, m);
    else if (prov === 'agy') {
      const s = usoAgyStream(saidaCli, m, { prompt: promptTxt });
      if (s && s.fonte === 'cli') return s;
      // o worker roda o agy em modo texto: a contagem real vem dos logs locais (brain) da sessão
      const mt = (f) => { try { return fs.statSync(String(f)).mtimeMs; } catch { return NaN; } };
      return usoAgyBrain(promptTxt, mt(prompt), mt(out), m) || s;
    }
    if (uso) return uso;
    // A CLI não trouxe contagem: estima pelo que houve de resposta (tentativa sem resposta não gera registro).
    if (final.trim()) return estimar(promptTxt.length, final.length, m);
    return null;
  } catch { return null; }
}

// ---------- agregação ----------
export function somarUsos(lista) {
  const total = { entrada: 0, saida: 0, cacheLido: 0, cacheGravado: 0, custoCliUsd: null };
  const porModelo = {};
  try {
    for (const r of Array.isArray(lista) ? lista : []) {
      if (!r || typeof r !== 'object') continue;
      const linhas = Array.isArray(r.porModelo) && r.porModelo.length ? r.porModelo : (() => {
        const p = partes(r.modelo);
        return [{ provedor: p.provedor, modelo: p.modelo, entrada: r.entrada, saida: r.saida, cacheLido: r.cacheLido, cacheGravado: r.cacheGravado, custoCliUsd: r.custoCliUsd }];
      })();
      for (const l of linhas) {
        const chave = `${l.provedor}:${l.modelo}`;
        const a = porModelo[chave] || (porModelo[chave] = { provedor: l.provedor, modelo: l.modelo, entrada: 0, saida: 0, cacheLido: 0, cacheGravado: 0, custoCliUsd: null, fontes: [] });
        for (const k of ['entrada', 'saida', 'cacheLido', 'cacheGravado']) { a[k] += num(l[k]); total[k] += num(l[k]); }
        const c = numOuNull(l.custoCliUsd);
        if (c !== null) { a.custoCliUsd = (a.custoCliUsd ?? 0) + c; total.custoCliUsd = (total.custoCliUsd ?? 0) + c; }
        if (r.fonte && !a.fontes.includes(r.fonte)) a.fontes.push(r.fonte);
      }
    }
  } catch {}
  total.custoCliUsd = arred(total.custoCliUsd);
  for (const a of Object.values(porModelo)) a.custoCliUsd = arred(a.custoCliUsd);
  return { total, porModelo };
}

// ---------- linha de comando ----------
// node uso.mjs extrair --tipo claude --modelo claude:haiku@high --out <f> --prompt <f> --texto <f>
// node uso.mjs somar < lista-de-usos.json
// Imprime UMA linha JSON (o resultado ou null) e sai sempre com código 0.
function argumentos(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { o[argv[i].slice(2)] = argv[i + 1] ?? ''; i++; }
  return o;
}

function principal(argv) {
  const [cmd, ...resto] = argv;
  if (cmd === 'extrair') return usoDaTentativa(argumentos(resto));
  if (cmd === 'somar') {
    let lista = [];
    try { lista = JSON.parse(semBom(fs.readFileSync(0, 'utf8'))); } catch {}
    return somarUsos(lista);
  }
  return null;
}

const ehPrincipal = (() => { try { return path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url); } catch { return false; } })();
if (ehPrincipal) {
  let r = null;
  try { r = principal(process.argv.slice(2)); } catch { r = null; }
  process.stdout.write(JSON.stringify(r ?? null) + '\n');
  process.exitCode = 0;
}
