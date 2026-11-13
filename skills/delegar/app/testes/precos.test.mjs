// Tabela de preços: resolução de modelo, custo, atualização pelo JSON do LiteLLM (sem internet, com fetch falso).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  carregarPrecos, precoDe, custoUsd, assinaturaDe, emBrl, idadeDias, atualizarPrecos, atualizarSeVencido, URL_LITELLM,
} from '../precos.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'delegar-precos-'));
const limpa = (d) => fs.rmSync(d, { recursive: true, force: true });

// Resposta parecida com Response, com corpo em stream.
function resposta(corpo, { status = 200, tamanhoChunk = 64 * 1024, headers = {} } = {}) {
  const bytes = Buffer.from(typeof corpo === 'string' ? corpo : JSON.stringify(corpo));
  let pos = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    body: {
      getReader() {
        return {
          async read() {
            if (pos >= bytes.length) return { done: true, value: undefined };
            const v = new Uint8Array(bytes.subarray(pos, pos + tamanhoChunk));
            pos += v.length;
            return { done: false, value: v };
          },
          async cancel() { pos = bytes.length; },
        };
      },
    },
  };
}
const fetchCom = (corpo, opts) => async () => resposta(corpo, opts);

// JSON do LiteLLM com preços novos (por token).
const liteNovo = () => ({
  sample_spec: { input_cost_per_token: 0 },
  'claude-sonnet-5-5': { input_cost_per_token: 3e-6, output_cost_per_token: 15e-6, cache_read_input_token_cost: 3e-7,
    cache_creation_input_token_cost: 3.75e-6, cache_creation_input_token_cost_above_1hr: 6e-6 },
  'gemini/gemini-3.8-flash': { input_cost_per_token: 1.5e-6, output_cost_per_token: 7.5e-6, cache_read_input_token_cost: 1.5e-7 },
});

function dirComTrabalho(modelosExtra = {}, resto = {}) {
  const dir = tmp();
  const base = carregarPrecos({ dataDir: dir });
  const trab = { ...base, ...resto, modelos: { ...base.modelos, ...modelosExtra } };
  delete trab.origem;
  fs.writeFileSync(path.join(dir, 'precos.json'), JSON.stringify(trab));
  return dir;
}

// ------------------------------------------------------------------ tabela versionada
test('tabela versionada cobre os modelos do contrato', () => {
  const t = carregarPrecos({ dataDir: tmp() });
  for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'gemini-3.8-flash',
    'gemini-4-argon', 'gemini-4-hydrogen', 'gpt-oss-120b']) assert.ok(precoDe(t, m), m);
  assert.equal(precoDe(t, 'claude-sonnet-5-5').entrada, 2);
  assert.equal(precoDe(t, 'claude-sonnet-5-5').saida, 10);
  assert.ok(t.usdBrl > 0);
  assert.match(t.atualizado, /^\d{4}-\d{2}-\d{2}$/);
});

test('todos os ids de modelos do Antigravity descobertos têm preço', () => {
  const t = carregarPrecos({ dataDir: tmp() });
  const ids = ['claude-opus-5-5-high', 'claude-opus-5-5-low', 'claude-opus-5-5-medium', 'claude-sonnet-5-5-high', 'claude-sonnet-5-5-low',
    'claude-sonnet-5-5-medium', 'gemini-3.8-flash-high', 'gemini-3.8-flash-low', 'gemini-3.8-flash-medium', 'gemini-4-argon-high',
    'gemini-4-argon-low', 'gemini-4-argon-medium', 'gemini-4-hydrogen-high', 'gemini-4-hydrogen-low', 'gemini-4-hydrogen-medium',
    'gemini-4-hydrogen-xhigh', 'gemini-pro-orchestrator-g1-pro', 'gpt-oss-120b-medium'];
  for (const id of ids) assert.ok(precoDe(t, id), id);
});

// ------------------------------------------------------------------ normalização
test('sufixos -high/-medium/-low/-xhigh e @esforço saem; high/medium/low dão o mesmo preço', () => {
  const t = carregarPrecos({ dataDir: tmp() });
  const a = precoDe(t, 'gemini-3.8-flash-high');
  assert.equal(a.chave, 'gemini-3.8-flash');
  assert.deepEqual(precoDe(t, 'gemini-3.8-flash-low'), a);
  assert.deepEqual(precoDe(t, 'gemini-3.8-flash-medium'), a);
  assert.equal(precoDe(t, 'gemini-4-hydrogen-xhigh').chave, 'gemini-4-hydrogen');
  assert.equal(precoDe(t, 'claude-opus-5-5-high').chave, 'claude-opus-5-5');
  assert.equal(precoDe(t, 'claude-sonnet-5-5@high').chave, 'claude-sonnet-5-5');
});

test('aliases curtos, data no id e [1m] resolvem', () => {
  const t = carregarPrecos({ dataDir: tmp() });
  assert.equal(precoDe(t, 'sonnet').chave, 'claude-sonnet-5-5');
  assert.equal(precoDe(t, 'opus').chave, 'claude-opus-5-5');
  assert.equal(precoDe(t, 'haiku').chave, 'claude-haiku-5-5');
  assert.equal(precoDe(t, 'Sonnet').chave, 'claude-sonnet-5-5');
  assert.equal(precoDe(t, 'claude-opus-4-7-20260416').chave, 'claude-opus-4-7');
  assert.equal(precoDe(t, 'claude-sonnet-5-5[1m]').chave, 'claude-sonnet-5-5');
  assert.equal(precoDe(t, 'openrouter/anthropic/claude-opus-5.5').chave, 'claude-opus-5-5');
});

test('gratuitos: padrões opencode/*-free e big-pickle valem 0; modelo pago do opencode não', () => {
  const t = carregarPrecos({ dataDir: tmp() });
  const g = precoDe(t, 'opencode/glm-5.3-flash-free');
  assert.equal(g.gratuito, true);
  assert.equal(g.entrada, 0);
  assert.equal(precoDe(t, 'opencode/big-pickle').gratuito, true);
  assert.equal(precoDe(t, 'opencode/qualquer-coisa-free').gratuito, true);
  assert.equal(precoDe(t, 'opencode/modelo-pago'), null);
  assert.equal(precoDe(t, 'nvidia/z-ai/glm-5.3-flash'), null);
});

test('modelo sem preço, vazio ou com chave perigosa devolve null', () => {
  const t = carregarPrecos({ dataDir: tmp() });
  assert.equal(precoDe(t, 'modelo-que-nao-existe'), null);
  assert.equal(precoDe(t, ''), null);
  assert.equal(precoDe(t, '__proto__'), null);
  assert.equal(precoDe(t, 'constructor'), null);
  assert.equal(precoDe(null, 'sonnet'), null);
});

test('aproximado acompanha o preço do parente e vem marcado', () => {
  const t = carregarPrecos({ dataDir: tmp() });
  const o = precoDe(t, 'gemini-pro-orchestrator-g1-pro');
  assert.equal(o.aproximado, true);
  assert.equal(o.entrada, precoDe(t, 'gemini-3.1-pro-preview').entrada);
  t.modelos['gemini-3.1-pro-preview'].entrada = 7;
  assert.equal(precoDe(t, 'gemini-pro-orchestrator-g1-pro').entrada, 7);
});

// ------------------------------------------------------------------ custo
test('custoUsd: origem cli usa o valor informado', () => {
  const t = carregarPrecos({ dataDir: tmp() });
  const r = custoUsd(t, { provedor: 'claude', modelo: 'sonnet', entrada: 1e6, saida: 0, cacheLido: 0, cacheGravado: 0, custoCliUsd: 0.1234 });
  assert.deepEqual(r, { usd: 0.1234, origem: 'cli' });
  assert.deepEqual(custoUsd(t, { modelo: 'opencode/x-free', custoCliUsd: 0 }), { usd: 0, origem: 'cli' });
});

test('custoUsd: origem tabela calcula entrada, saída e cache', () => {
  const t = carregarPrecos({ dataDir: tmp() });
  // Sonnet 5.5: 2 / 10 / cache lido 0,10 / cache gravado 5m 2,50
  const r = custoUsd(t, { provedor: 'claude', modelo: 'claude-sonnet-5-5', entrada: 1e6, saida: 1e6, cacheLido: 1e6, cacheGravado: 1e6, custoCliUsd: null });
  assert.equal(r.origem, 'tabela');
  assert.ok(Math.abs(r.usd - (2 + 10 + 0.1 + 2.5)) < 1e-9);
});

test('custoUsd: cacheGravado1h cobra o preço de 1 hora na parte informada', () => {
  const t = carregarPrecos({ dataDir: tmp() });
  const r = custoUsd(t, { modelo: 'claude-sonnet-5-5', entrada: 0, saida: 0, cacheLido: 0, cacheGravado: 1e6, cacheGravado1h: 1e6, custoCliUsd: null });
  assert.ok(Math.abs(r.usd - 4) < 1e-9);
});

test('custoUsd: origem gratuito vale 0', () => {
  const t = carregarPrecos({ dataDir: tmp() });
  assert.deepEqual(custoUsd(t, { provedor: 'opencode', modelo: 'opencode/glm-5.3-flash-free', entrada: 5e6, saida: 5e6, cacheLido: 0, cacheGravado: 0, custoCliUsd: null }),
    { usd: 0, origem: 'gratuito' });
});

test('custoUsd: origem aproximado calcula e marca', () => {
  const t = carregarPrecos({ dataDir: tmp() });
  const r = custoUsd(t, { provedor: 'agy', modelo: 'gemini-pro-orchestrator-g1-pro', entrada: 1e6, saida: 1e6, cacheLido: 0, cacheGravado: 0, custoCliUsd: null });
  assert.equal(r.origem, 'aproximado');
  assert.ok(r.usd > 0);
});

test('custoUsd: origem desconhecido devolve usd null', () => {
  const t = carregarPrecos({ dataDir: tmp() });
  assert.deepEqual(custoUsd(t, { provedor: 'opencode', modelo: 'nvidia/z-ai/glm-5.3-flash', entrada: 100, saida: 100, cacheLido: 0, cacheGravado: 0, custoCliUsd: null }),
    { usd: null, origem: 'desconhecido' });
});

test('custoUsd: tokens ausentes, negativos ou NaN contam como 0; custo cli inválido é ignorado', () => {
  const t = carregarPrecos({ dataDir: tmp() });
  const r = custoUsd(t, { modelo: 'sonnet', entrada: NaN, saida: -5, cacheLido: undefined, cacheGravado: null, custoCliUsd: NaN });
  assert.deepEqual(r, { usd: 0, origem: 'tabela' });
  assert.equal(custoUsd(t, undefined).origem, 'desconhecido');
});

test('cache sem preço próprio (Gemini) cobra como entrada', () => {
  const t = carregarPrecos({ dataDir: tmp() });
  const r = custoUsd(t, { modelo: 'gemini-3.8-flash-high', entrada: 0, saida: 0, cacheLido: 0, cacheGravado: 1e6 });
  assert.ok(Math.abs(r.usd - 0.75) < 1e-9);
});

test('assinaturaDe e emBrl', () => {
  assert.equal(assinaturaDe('claude'), 'Claude Code');
  assert.equal(assinaturaDe('agy'), 'Antigravity');
  assert.equal(assinaturaDe('opencode'), null);
  assert.equal(emBrl({ usdBrl: 5 }, 2), 10);
  assert.equal(emBrl({ usdBrl: 5 }, null), null);
  assert.equal(emBrl({}, 2), null);
  assert.equal(emBrl({ usdBrl: 0 }, 2), null);
  assert.equal(emBrl({ usdBrl: 5 }, NaN), null);
});

test('idadeDias', () => {
  const t = { atualizado: '2026-10-01' };
  assert.equal(idadeDias(t, new Date('2026-10-31T12:00:00Z')), 30);
  assert.equal(idadeDias(t, new Date('2026-11-02T00:00:00Z')), 32);
  assert.equal(idadeDias({}, new Date()), Infinity);
});

// ------------------------------------------------------------------ cópia de trabalho
test('cópia de trabalho sobrepõe a versionada; modelos só da versionada continuam', () => {
  const dir = dirComTrabalho({ 'claude-sonnet-5-5': { entrada: 99, saida: 1, cacheLido: 0.1, cacheGravado: 1, fonte: 'manual', litellm: null, aproximado: false, manual: true } }, { usdBrl: 6.5 });
  try {
    const t = carregarPrecos({ dataDir: dir });
    assert.equal(precoDe(t, 'sonnet').entrada, 99);
    assert.equal(t.usdBrl, 6.5);
    assert.ok(precoDe(t, 'claude-haiku-5-5'));
    assert.equal(t.origem, 'trabalho');
  } finally { limpa(dir); }
});

test('modelo que só existe na cópia de trabalho entra; cópia inválida é ignorada', () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'precos.json'), JSON.stringify({ modelos: { 'meu-modelo': { entrada: 1, saida: 2 } } }));
    assert.equal(precoDe(carregarPrecos({ dataDir: dir }), 'meu-modelo').saida, 2);
    fs.writeFileSync(path.join(dir, 'precos.json'), '{ quebrado');
    assert.equal(carregarPrecos({ dataDir: dir }).origem, 'versionada');
    fs.writeFileSync(path.join(dir, 'precos.json'), JSON.stringify({ modelos: { x: { entrada: -1, saida: 2 } } }));
    assert.equal(carregarPrecos({ dataDir: dir }).origem, 'versionada');
    fs.writeFileSync(path.join(dir, 'precos.json'), JSON.stringify({ modelos: { x: { entrada: 1, saida: 2 } }, usdBrl: 'abc' }));
    assert.equal(carregarPrecos({ dataDir: dir }).origem, 'versionada');
  } finally { limpa(dir); }
});

// ------------------------------------------------------------------ atualização
test('atualiza os mapeados, grava a data e a cópia de trabalho', async () => {
  const dir = tmp();
  try {
    const agora = new Date(2026, 11, 20, 12, 0, 0);
    const r = await atualizarPrecos({ dataDir: dir, fetchFn: fetchCom(liteNovo()), agora });
    assert.equal(r.ok, true);
    assert.ok(r.atualizados >= 2);
    const p = precoDe(r.tabela, 'claude-sonnet-5-5');
    assert.equal(p.entrada, 3);
    assert.equal(p.saida, 15);
    assert.equal(p.cacheLido, 0.3);
    assert.equal(p.cacheGravado1h, 6);
    assert.equal(p.fonte, 'litellm');
    assert.equal(precoDe(r.tabela, 'gemini-3.8-flash-high').entrada, 1.5);
    const gravado = JSON.parse(fs.readFileSync(path.join(dir, 'precos.json'), 'utf8'));
    assert.equal(gravado.atualizado, '2026-12-20');
    assert.equal(gravado.modelos['claude-sonnet-5-5'].entrada, 3);
    assert.equal(precoDe(carregarPrecos({ dataDir: dir }), 'sonnet').saida, 15);
    assert.deepEqual(fs.readdirSync(dir), ['precos.json']); // sem arquivo temporário
  } finally { limpa(dir); }
});

test('GET sem dado nenhum: só User-Agent genérico, sem query, sem cookie', async () => {
  const dir = tmp();
  try {
    let visto;
    await atualizarPrecos({ dataDir: dir, fetchFn: async (u, o) => { visto = { u, o }; return resposta(liteNovo()); } });
    assert.equal(visto.u, URL_LITELLM);
    assert.ok(!visto.u.includes('?'));
    assert.equal(visto.o.method, 'GET');
    assert.deepEqual(visto.o.headers, { 'User-Agent': 'delegar-precos' });
    assert.equal(visto.o.body, undefined);
    assert.ok(visto.o.signal);
  } finally { limpa(dir); }
});

test('preserva modelo manual, usdBrl, aliases e itens sem mapeamento', async () => {
  const dir = dirComTrabalho({
    'claude-sonnet-5-5': { entrada: 9, saida: 9, cacheLido: 1, cacheGravado: 1, fonte: 'manual', litellm: 'claude-sonnet-5-5', aproximado: false, manual: true },
    'meu-modelo': { entrada: 1, saida: 2, cacheLido: null, cacheGravado: null, fonte: 'manual', litellm: null, aproximado: false, manual: false },
  }, { usdBrl: 6.01, usdBrlAtualizado: '2026-01-01', aliases: { meu: 'meu-modelo', sonnet: 'claude-sonnet-5-5' } });
  try {
    const r = await atualizarPrecos({ dataDir: dir, fetchFn: fetchCom(liteNovo()) });
    assert.equal(r.ok, true);
    assert.equal(r.tabela.modelos['claude-sonnet-5-5'].entrada, 9); // manual não muda mesmo com litellm
    assert.equal(r.tabela.modelos['meu-modelo'].entrada, 1);
    assert.equal(r.tabela.usdBrl, 6.01);
    assert.equal(r.tabela.usdBrlAtualizado, '2026-01-01');
    assert.equal(r.tabela.aliases.meu, 'meu-modelo');
    assert.equal(precoDe(r.tabela, 'gemini-3.8-flash').entrada, 1.5); // o mapeado não manual muda
  } finally { limpa(dir); }
});

test('aproximado com parente acompanha a atualização do parente', async () => {
  const dir = tmp();
  try {
    const lite = { 'gemini/gemini-3.1-pro-preview': { input_cost_per_token: 5e-6, output_cost_per_token: 20e-6 } };
    const r = await atualizarPrecos({ dataDir: dir, fetchFn: fetchCom(lite) });
    assert.equal(r.ok, true);
    assert.equal(r.tabela.modelos['gemini-pro-orchestrator-g1-pro'].entrada, 5);
    assert.equal(precoDe(r.tabela, 'gemini-pro-orchestrator-g1-pro').saida, 20);
  } finally { limpa(dir); }
});

test('ignora valores inválidos (negativo, enorme, texto, NaN) e mantém o preço anterior', async () => {
  const dir = tmp();
  try {
    const antes = precoDe(carregarPrecos({ dataDir: dir }), 'claude-sonnet-5-5');
    const lite = {
      'claude-sonnet-5-5': { input_cost_per_token: -1e-6, output_cost_per_token: 15e-6 },
      'gemini/gemini-3.8-flash': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-3 }, // 2000 US$/M, acima de 1000
      'claude-haiku-5-5': { input_cost_per_token: '0.0000001', output_cost_per_token: 5e-7 },
      'claude-opus-5-5': { input_cost_per_token: 4e-6, output_cost_per_token: 20e-6, cache_read_input_token_cost: -3 }, // cache inválido, resto vale
      'gemini/gemini-4-argon': { input_cost_per_token: null, output_cost_per_token: 1e-5 },
    };
    const r = await atualizarPrecos({ dataDir: dir, fetchFn: fetchCom(lite) });
    assert.equal(r.ok, true);
    assert.match(r.aviso, /ignorados/);
    assert.equal(precoDe(r.tabela, 'claude-sonnet-5-5').entrada, antes.entrada);
    assert.equal(precoDe(r.tabela, 'gemini-3.8-flash').entrada, 0.75);
    assert.equal(precoDe(r.tabela, 'claude-haiku-5-5').entrada, 0.1);
    assert.equal(precoDe(r.tabela, 'claude-opus-5-5').cacheLido, 0.2); // manteve o cache anterior
    assert.equal(precoDe(r.tabela, 'gemini-4-argon').entrada, 2);
  } finally { limpa(dir); }
});

test('recusa resposta maior que o limite (stream e content-length) e não grava', async () => {
  const dir = tmp();
  try {
    const grande = JSON.stringify({ ...liteNovo(), lixo: 'x'.repeat(5000) });
    const r1 = await atualizarPrecos({ dataDir: dir, fetchFn: fetchCom(grande, { tamanhoChunk: 500 }), limiteBytes: 2000 });
    assert.equal(r1.ok, false);
    assert.match(r1.aviso, /limite/);
    const r2 = await atualizarPrecos({ dataDir: dir, fetchFn: fetchCom(liteNovo(), { headers: { 'content-length': '999999' } }), limiteBytes: 2000 });
    assert.equal(r2.ok, false);
    assert.ok(!fs.existsSync(path.join(dir, 'precos.json')));
  } finally { limpa(dir); }
});

test('o stream é cancelado ao passar do limite', async () => {
  const dir = tmp();
  try {
    let lidos = 0, cancelado = false;
    const fetchFn = async () => ({
      ok: true, status: 200, headers: { get: () => null },
      body: { getReader: () => ({ async read() { lidos++; return { done: false, value: new Uint8Array(1000) }; }, async cancel() { cancelado = true; } }) },
    });
    const r = await atualizarPrecos({ dataDir: dir, fetchFn, limiteBytes: 5000 });
    assert.equal(r.ok, false);
    assert.equal(cancelado, true);
    assert.ok(lidos <= 6);
  } finally { limpa(dir); }
});

test('timeout mantém a tabela anterior e não grava', async () => {
  const dir = tmp();
  try {
    const fetchFn = (u, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('abortado'))));
    const r = await atualizarPrecos({ dataDir: dir, fetchFn, timeoutMs: 30 });
    assert.equal(r.ok, false);
    assert.ok(r.aviso);
    assert.equal(precoDe(r.tabela, 'sonnet').entrada, 2);
    assert.ok(!fs.existsSync(path.join(dir, 'precos.json')));
  } finally { limpa(dir); }
});

test('corpo que trava no meio também estoura o timeout', async () => {
  const dir = tmp();
  try {
    const fetchFn = async () => ({ ok: true, status: 200, headers: { get: () => null }, body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: async () => {} }) } });
    const r = await atualizarPrecos({ dataDir: dir, fetchFn, timeoutMs: 30 });
    assert.equal(r.ok, false);
    assert.match(r.aviso, /tempo/);
  } finally { limpa(dir); }
});

test('erro de rede, status ruim, JSON quebrado e JSON sem os modelos mantêm a tabela', async () => {
  const dir = tmp();
  try {
    const casos = [
      async () => { throw new Error('ENOTFOUND'); },
      fetchCom('nada', { status: 503 }),
      fetchCom('{ isto não é json'),
      fetchCom('[1,2,3]'),
      fetchCom({ 'outro-modelo': { input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 } }),
    ];
    for (const fetchFn of casos) {
      const r = await atualizarPrecos({ dataDir: dir, fetchFn });
      assert.equal(r.ok, false);
      assert.ok(r.aviso);
      assert.equal(precoDe(r.tabela, 'sonnet').entrada, 2);
    }
    assert.ok(!fs.existsSync(path.join(dir, 'precos.json')));
  } finally { limpa(dir); }
});

test('URL que não é https é recusada sem chamar a rede', async () => {
  const dir = tmp();
  try {
    let chamou = false;
    const r = await atualizarPrecos({ dataDir: dir, url: 'http://exemplo.com/p.json', fetchFn: async () => { chamou = true; return resposta({}); } });
    assert.equal(r.ok, false);
    assert.equal(chamou, false);
  } finally { limpa(dir); }
});

test('DELEGAR_PRECOS_URL troca a URL padrão', async () => {
  const dir = tmp();
  const antes = process.env.DELEGAR_PRECOS_URL;
  try {
    process.env.DELEGAR_PRECOS_URL = 'https://exemplo.test/precos.json';
    let url;
    await atualizarPrecos({ dataDir: dir, fetchFn: async (u) => { url = u; return resposta(liteNovo()); } });
    assert.equal(url, 'https://exemplo.test/precos.json');
  } finally {
    if (antes === undefined) delete process.env.DELEGAR_PRECOS_URL; else process.env.DELEGAR_PRECOS_URL = antes;
    limpa(dir);
  }
});

// ------------------------------------------------------------------ atualizarSeVencido
test('atualizarSeVencido: tabela com até 30 dias não baixa; com mais de 30 baixa', async () => {
  const dir = dirComTrabalho({}, { atualizado: '2026-10-01' });
  try {
    let chamadas = 0;
    const fetchFn = async () => { chamadas++; return resposta(liteNovo()); };
    const novo = await atualizarSeVencido({ dataDir: dir, fetchFn, agora: new Date('2026-10-31T12:00:00Z') });
    assert.equal(novo.pulou, true);
    assert.equal(novo.ok, true);
    assert.equal(novo.atualizados, 0);
    assert.equal(chamadas, 0);
    const velho = await atualizarSeVencido({ dataDir: dir, fetchFn, agora: new Date('2026-11-05T12:00:00Z') });
    assert.equal(chamadas, 1);
    assert.equal(velho.ok, true);
    assert.equal(velho.pulou, undefined);
    assert.equal(velho.tabela.atualizado, '2026-11-05');
  } finally { limpa(dir); }
});

test('atualizarSeVencido: DELEGAR_PRECOS_OFFLINE=1 nunca baixa', async () => {
  const dir = dirComTrabalho({}, { atualizado: '2020-01-01' });
  const antes = process.env.DELEGAR_PRECOS_OFFLINE;
  try {
    process.env.DELEGAR_PRECOS_OFFLINE = '1';
    let chamadas = 0;
    const r = await atualizarSeVencido({ dataDir: dir, fetchFn: async () => { chamadas++; return resposta(liteNovo()); } });
    assert.equal(r.pulou, true);
    assert.equal(chamadas, 0);
    process.env.DELEGAR_PRECOS_OFFLINE = '0';
    const r2 = await atualizarSeVencido({ dataDir: dir, fetchFn: async () => { chamadas++; return resposta(liteNovo()); } });
    assert.equal(chamadas, 1);
    assert.equal(r2.ok, true);
  } finally {
    if (antes === undefined) delete process.env.DELEGAR_PRECOS_OFFLINE; else process.env.DELEGAR_PRECOS_OFFLINE = antes;
    limpa(dir);
  }
});

test('atualizarSeVencido: tabela sem data conta como vencida e erro de rede não lança', async () => {
  const dir = dirComTrabalho({}, { atualizado: null });
  try {
    const r = await atualizarSeVencido({ dataDir: dir, fetchFn: async () => { throw new Error('sem rede'); } });
    assert.equal(r.ok, false);
    assert.ok(r.aviso);
    assert.ok(r.tabela);
  } finally { limpa(dir); }
});
