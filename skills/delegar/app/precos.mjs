// Preços por modelo (US$ por milhão de tokens), cálculo de custo e atualização mensal pelo JSON público do LiteLLM.
// A tabela versionada fica em app/precos.json. A cópia de trabalho (dataDir/precos.json) sobrepõe a versionada e é
// a única que a atualização grava. Só faz GET, sem enviar dado nenhum.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const URL_LITELLM = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
export const VALIDADE_DIAS = 30;
const ARQUIVO_VERSIONADO = path.join(path.dirname(fileURLToPath(import.meta.url)), 'precos.json');
const MAX_USD_POR_M = 1000;
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const objeto = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const preco = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_USD_POR_M;
const opcional = (v) => v === null || v === undefined || preco(v);

// ---------------------------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------------------------
function tabelaValida(t) {
  const o = objeto(t);
  if (!o || !objeto(o.modelos)) return false;
  if (o.usdBrl !== undefined && o.usdBrl !== null && !(typeof o.usdBrl === 'number' && Number.isFinite(o.usdBrl) && o.usdBrl > 0)) return false;
  if (o.aliases !== undefined && !objeto(o.aliases)) return false;
  if (o.gratuitos !== undefined && !(Array.isArray(o.gratuitos) && o.gratuitos.every((g) => typeof g === 'string'))) return false;
  for (const m of Object.values(o.modelos)) {
    const e = objeto(m);
    if (!e || !preco(e.entrada) || !preco(e.saida)) return false;
    if (!opcional(e.cacheLido) || !opcional(e.cacheGravado) || !opcional(e.cacheGravado1h)) return false;
  }
  return true;
}

function lerJson(arquivo) {
  try { return JSON.parse(fs.readFileSync(arquivo, 'utf8')); } catch { return null; }
}

const VAZIA = () => ({ versao: 1, atualizado: null, fonte: null, usdBrl: null, modelos: {}, aliases: {}, gratuitos: [] });

// Tabela versionada + cópia de trabalho (se existir e for válida). A cópia vence; o que só existe na versionada entra também.
export function carregarPrecos({ dataDir } = {}) {
  const base = lerJson(ARQUIVO_VERSIONADO);
  const versionada = tabelaValida(base) ? base : VAZIA();
  const trab = dataDir ? lerJson(path.join(dataDir, 'precos.json')) : null;
  if (!tabelaValida(trab)) return { ...versionada, origem: 'versionada' };
  return {
    ...versionada,
    ...trab,
    modelos: { ...versionada.modelos, ...trab.modelos },
    aliases: { ...(versionada.aliases || {}), ...(trab.aliases || {}) },
    gratuitos: [...new Set([...(versionada.gratuitos || []), ...(trab.gratuitos || [])])],
    origem: 'trabalho',
  };
}

// ---------------------------------------------------------------------------------------------
// Resolução do modelo
// ---------------------------------------------------------------------------------------------
const globParaRegex = (g) => new RegExp('^' + g.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');

// Variantes do id, da mais literal para a mais normalizada (cada passo vale para os seguintes).
function variantes(modelo) {
  let m = String(modelo ?? '').trim().toLowerCase();
  m = m.replace(/\[[^\]]*\]$/, '').replace(/@(low|medium|high|xhigh|max)$/, '');
  const lista = [m];
  const passo = (f) => { const n = f(lista[lista.length - 1]); if (n && n !== lista[lista.length - 1]) lista.push(n); };
  passo((s) => s.replace(/^(openrouter|nvidia|opencode)\//, '').replace(/^(anthropic|google|openai)\//, ''));
  passo((s) => (s.startsWith('claude-') ? s.replace(/(\d)\.(\d)/g, '$1-$2') : s));
  passo((s) => s.replace(/-\d{8}$/, ''));
  passo((s) => s.replace(/-(high|medium|low|xhigh)$/, ''));
  return lista;
}

const ehGratuito = (tabela, modelo) => {
  const m = String(modelo ?? '').trim().toLowerCase();
  return (Array.isArray(tabela?.gratuitos) ? tabela.gratuitos : []).some((g) => typeof g === 'string' && globParaRegex(g).test(m));
};

const numOu = (v, padrao) => (typeof v === 'number' && Number.isFinite(v) ? v : padrao);

// Preço do modelo (sem prefixo de provedor) ou null. Cache sem preço próprio cobra como entrada.
export function precoDe(tabela, modelo) {
  const modelos = objeto(tabela?.modelos);
  if (!modelos || typeof modelo !== 'string' || !modelo.trim()) return null;
  if (ehGratuito(tabela, modelo)) {
    return { chave: String(modelo).trim().toLowerCase(), entrada: 0, saida: 0, cacheLido: 0, cacheGravado: 0, cacheGravado1h: 0, aproximado: false, gratuito: true, fonte: 'manual' };
  }
  const aliases = objeto(tabela.aliases) || {};
  for (const v of variantes(modelo)) {
    const chave = hasOwn(modelos, v) ? v : hasOwn(aliases, v) && hasOwn(modelos, aliases[v]) ? aliases[v] : null;
    if (!chave) continue;
    let e = objeto(modelos[chave]);
    if (!e) continue;
    // Aproximado com parente: acompanha o preço atual do parente.
    const pai = e.aproximado && typeof e.parente === 'string' && hasOwn(modelos, e.parente) ? objeto(modelos[e.parente]) : null;
    if (pai && preco(pai.entrada) && preco(pai.saida)) e = { ...e, entrada: pai.entrada, saida: pai.saida, cacheLido: pai.cacheLido, cacheGravado: pai.cacheGravado, cacheGravado1h: pai.cacheGravado1h };
    if (!preco(e.entrada) || !preco(e.saida)) return null;
    const cacheGravado = numOu(e.cacheGravado, e.entrada);
    return {
      chave,
      entrada: e.entrada,
      saida: e.saida,
      cacheLido: numOu(e.cacheLido, e.entrada),
      cacheGravado,
      cacheGravado1h: numOu(e.cacheGravado1h, cacheGravado),
      aproximado: !!e.aproximado,
      gratuito: false,
      fonte: typeof e.fonte === 'string' ? e.fonte : 'manual',
    };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Custo
// ---------------------------------------------------------------------------------------------
const tok = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

// item: {provedor, modelo, entrada, saida, cacheLido, cacheGravado, custoCliUsd, cacheGravado1h?}.
// cacheGravado1h (opcional) é a parte de cacheGravado gravada com validade de 1 hora; o Claude Code grava assim e cobra mais.
export function custoUsd(tabela, item) {
  const it = objeto(item) || {};
  if (typeof it.custoCliUsd === 'number' && Number.isFinite(it.custoCliUsd) && it.custoCliUsd >= 0) return { usd: it.custoCliUsd, origem: 'cli' };
  const p = precoDe(tabela, it.modelo);
  if (!p) return { usd: null, origem: 'desconhecido' };
  if (p.gratuito) return { usd: 0, origem: 'gratuito' };
  const gravado = tok(it.cacheGravado);
  const g1h = Math.min(tok(it.cacheGravado1h), gravado);
  const usd = (tok(it.entrada) * p.entrada + tok(it.saida) * p.saida + tok(it.cacheLido) * p.cacheLido
    + (gravado - g1h) * p.cacheGravado + g1h * p.cacheGravado1h) / 1e6;
  return { usd, origem: p.aproximado ? 'aproximado' : 'tabela' };
}

export const assinaturaDe = (provedor) => (provedor === 'claude' ? 'Claude Code' : provedor === 'agy' ? 'Antigravity' : null);

export function emBrl(tabela, usd) {
  const taxa = tabela?.usdBrl;
  if (typeof usd !== 'number' || !Number.isFinite(usd) || typeof taxa !== 'number' || !Number.isFinite(taxa) || taxa <= 0) return null;
  return usd * taxa;
}

// Dias inteiros desde a data da tabela; Infinity quando a tabela não tem data legível.
export function idadeDias(tabela, agora = new Date()) {
  const t = typeof tabela?.atualizado === 'string' ? new Date(tabela.atualizado) : null;
  if (!t || Number.isNaN(t.getTime())) return Infinity;
  return Math.floor((agora.getTime() - t.getTime()) / 86400000);
}

// ---------------------------------------------------------------------------------------------
// Atualização
// ---------------------------------------------------------------------------------------------
const hojeLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const aMilhao = (v) => (typeof v === 'number' && Number.isFinite(v) ? Number((v * 1e6).toPrecision(6)) : null);
const urlPermitida = (u) => /^https:\/\//i.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(u);

// Lê o corpo em stream e aborta ao passar do limite.
async function lerCorpo(resp, limiteBytes, sinal) {
  const len = Number(resp.headers?.get?.('content-length'));
  if (Number.isFinite(len) && len > limiteBytes) throw new Error('resposta maior que o limite');
  const abortou = new Promise((_, rej) => {
    if (sinal.aborted) rej(new Error('tempo esgotado'));
    sinal.addEventListener('abort', () => rej(new Error('tempo esgotado')), { once: true });
  });
  abortou.catch(() => {}); // evita rejeição sem tratamento quando ninguém está esperando
  const corrida = (p) => Promise.race([p, abortou]);
  if (!resp.body?.getReader) {
    const t = await corrida(resp.text());
    if (Buffer.byteLength(t) > limiteBytes) throw new Error('resposta maior que o limite');
    return t;
  }
  const leitor = resp.body.getReader();
  const partes = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await corrida(leitor.read());
      if (done) break;
      total += value.byteLength;
      if (total > limiteBytes) throw new Error('resposta maior que o limite');
      partes.push(Buffer.from(value));
    }
  } catch (e) {
    try { await leitor.cancel(); } catch { /* já encerrado */ }
    throw e;
  }
  return Buffer.concat(partes).toString('utf8');
}

function gravarAtomico(arquivo, texto) {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const tmp = `${arquivo}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, texto, 'utf8');
    try { fs.renameSync(tmp, arquivo); } catch { fs.renameSync(tmp, arquivo); } // 2ª tentativa: antivírus costuma soltar o arquivo logo
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nada a limpar */ }
    throw e;
  }
}

const CAMPOS = [
  ['entrada', 'input_cost_per_token', true],
  ['saida', 'output_cost_per_token', true],
  ['cacheLido', 'cache_read_input_token_cost', false],
  ['cacheGravado', 'cache_creation_input_token_cost', false],
  ['cacheGravado1h', 'cache_creation_input_token_cost_above_1hr', false],
];

export async function atualizarPrecos({ dataDir, fetchFn = globalThis.fetch, url = process.env.DELEGAR_PRECOS_URL || URL_LITELLM,
  agora = new Date(), timeoutMs = 20000, limiteBytes = 20 * 1024 * 1024 } = {}) {
  const anterior = carregarPrecos({ dataDir });
  const falha = (aviso) => ({ ok: false, atualizados: 0, aviso, tabela: anterior });
  if (!dataDir) return falha('dataDir não informado.');
  if (typeof fetchFn !== 'function') return falha('fetch indisponível.');
  if (!urlPermitida(String(url))) return falha('URL de preços precisa ser https.');

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let texto;
  try {
    const resp = await Promise.race([
      fetchFn(url, { method: 'GET', headers: { 'User-Agent': 'delegar-precos' }, signal: ctl.signal }),
      new Promise((_, rej) => ctl.signal.addEventListener('abort', () => rej(new Error('tempo esgotado')), { once: true })),
    ]);
    if (!resp || !resp.ok) return falha(`Servidor de preços respondeu ${resp?.status ?? 'sem status'}.`);
    texto = await lerCorpo(resp, limiteBytes, ctl.signal);
  } catch (e) {
    return falha(`Não foi possível baixar os preços: ${e?.message || e}. Mantida a tabela anterior.`);
  } finally {
    clearTimeout(timer);
  }

  let fonte;
  try { fonte = JSON.parse(texto); } catch { return falha('JSON de preços inválido. Mantida a tabela anterior.'); }
  if (!objeto(fonte)) return falha('JSON de preços com formato inesperado. Mantida a tabela anterior.');

  const modelos = {};
  let atualizados = 0, achados = 0, invalidos = 0;
  for (const [chave, atual] of Object.entries(anterior.modelos)) {
    const e = objeto(atual);
    if (!e || e.manual === true || typeof e.litellm !== 'string' || !e.litellm || !hasOwn(fonte, e.litellm)) { modelos[chave] = atual; continue; }
    const origem = objeto(fonte[e.litellm]);
    if (!origem) { modelos[chave] = atual; continue; }
    achados++;
    const novo = { ...e };
    let valido = true;
    for (const [campo, chaveLite, obrigatorio] of CAMPOS) {
      if (!hasOwn(origem, chaveLite) || origem[chaveLite] === null) { if (obrigatorio) valido = false; continue; }
      const v = aMilhao(origem[chaveLite]);
      if (typeof origem[chaveLite] !== 'number' || v === null || v < 0 || v > MAX_USD_POR_M) { if (obrigatorio) valido = false; else invalidos++; continue; }
      novo[campo] = v;
    }
    if (!valido) { invalidos++; modelos[chave] = atual; continue; }
    novo.fonte = 'litellm';
    if (CAMPOS.some(([c]) => novo[c] !== e[c])) atualizados++;
    modelos[chave] = novo;
  }
  // Aproximados com parente acompanham o preço do parente.
  for (const [chave, e] of Object.entries(modelos)) {
    const pai = e?.aproximado && e.manual !== true && typeof e.parente === 'string' && hasOwn(modelos, e.parente) ? modelos[e.parente] : null;
    if (!pai) continue;
    const copia = { ...e, entrada: pai.entrada, saida: pai.saida, cacheLido: pai.cacheLido, cacheGravado: pai.cacheGravado, cacheGravado1h: pai.cacheGravado1h };
    if (['entrada', 'saida', 'cacheLido', 'cacheGravado', 'cacheGravado1h'].some((c) => copia[c] !== e[c])) { modelos[chave] = copia; atualizados++; }
  }
  if (achados === 0) return falha('O JSON baixado não traz nenhum dos modelos mapeados. Mantida a tabela anterior.');

  const { origem: _origem, ...resto } = anterior;
  const tabela = { ...resto, atualizado: hojeLocal(agora), modelos, origem: 'trabalho' };
  try {
    const { origem: _o, ...paraGravar } = tabela;
    gravarAtomico(path.join(dataDir, 'precos.json'), JSON.stringify(paraGravar, null, 2) + '\n');
  } catch (e) {
    return falha(`Preços baixados, mas não foi possível gravar: ${e?.message || e}.`);
  }
  const avisos = [];
  if (invalidos) avisos.push(`${invalidos} valor(es) fora do intervalo aceito foram ignorados.`);
  return { ok: true, atualizados, aviso: avisos.length ? avisos.join(' ') : null, tabela };
}

// Só age se a tabela tem mais de 30 dias e DELEGAR_PRECOS_OFFLINE não for '1'. Nunca lança.
export async function atualizarSeVencido(opcoes = {}) {
  try {
    const tabela = carregarPrecos({ dataDir: opcoes.dataDir });
    if (process.env.DELEGAR_PRECOS_OFFLINE === '1' || idadeDias(tabela, opcoes.agora || new Date()) <= VALIDADE_DIAS) {
      return { ok: true, atualizados: 0, pulou: true, aviso: null, tabela };
    }
    return await atualizarPrecos(opcoes);
  } catch (e) {
    return { ok: false, atualizados: 0, aviso: `Falha na atualização de preços: ${e?.message || e}.`, tabela: carregarPrecos({ dataDir: opcoes.dataDir }) };
  }
}
