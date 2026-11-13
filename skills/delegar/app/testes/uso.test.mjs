// Uso de tokens por CLI: parsers (claude, opencode, agy), estimativa, soma e linha de comando.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  modeloSemEsforco, usoClaudeStream, usoClaudeJson, usoOpencode, usoAgyStream,
  estimar, usoDaTentativa, somarUsos,
} from '../uso.mjs';

const fileURLPath = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const fx = (n) => fileURLPath(`./fixtures/${n}`);
const le = (n) => fs.readFileSync(fx(n), 'utf8');
const USO_CLI = fileURLPath('../uso.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uso-test-'));
const grava = (nome, conteudo) => { const f = path.join(tmp, nome); fs.writeFileSync(f, conteudo); return f; };

test('modeloSemEsforco tira só o sufixo @esforco', () => {
  assert.equal(modeloSemEsforco('claude:haiku@high'), 'claude:haiku');
  assert.equal(modeloSemEsforco('agy:gemini-3.8-flash-high'), 'agy:gemini-3.8-flash-high');
  assert.equal(modeloSemEsforco('opencode:opencode/glm-5.3-flash-free@max'), 'opencode:opencode/glm-5.3-flash-free');
  assert.equal(modeloSemEsforco('claude:sonnet@alto'), 'claude:sonnet@alto');
  assert.equal(modeloSemEsforco(undefined), '');
});

test('claude stream-json: usa o evento result e o modelUsage', () => {
  const u = usoClaudeStream(le('uso-claude-stream.jsonl'), 'claude:haiku@high');
  assert.equal(u.modelo, 'claude:haiku');
  assert.equal(u.fonte, 'cli');
  assert.equal(u.entrada, 20);
  assert.equal(u.saida, 11287);
  assert.equal(u.cacheLido, 583472);
  assert.equal(u.cacheGravado, 38883);
  assert.equal(u.custoCliUsd, 0.01925682);
  assert.deepEqual(u.porModelo, [{
    provedor: 'claude', modelo: 'claude-haiku-5-5', entrada: 20, saida: 11287, cacheLido: 583472, cacheGravado: 38883, custoCliUsd: 0.01925682,
  }]);
});

test('claude stream-json: result sem modelUsage vira uma linha com o modelo da cadeia', () => {
  const ev = { type: 'result', total_cost_usd: 0.5, usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 } };
  const u = usoClaudeStream(JSON.stringify(ev), 'claude:sonnet');
  assert.equal(u.fonte, 'cli');
  assert.equal(u.custoCliUsd, 0.5);
  assert.deepEqual(u.porModelo, [{ provedor: 'claude', modelo: 'sonnet', entrada: 10, saida: 20, cacheLido: 30, cacheGravado: 40, custoCliUsd: 0.5 }]);
});

test('claude stream-json: modelUsage com dois modelos gera duas linhas e o total é a soma', () => {
  const ev = { type: 'result', total_cost_usd: 0.3, modelUsage: {
    'claude-sonnet-5-5': { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4, costUSD: 0.2 },
    'claude-haiku-5-5': { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40, costUSD: 0.1 },
  } };
  const u = usoClaudeStream(JSON.stringify(ev), 'claude:sonnet');
  assert.equal(u.porModelo.length, 2);
  assert.equal(u.entrada, 11); assert.equal(u.saida, 22); assert.equal(u.cacheLido, 33); assert.equal(u.cacheGravado, 44);
  assert.equal(u.custoCliUsd, 0.3);
});

test('claude parcial (sem result): soma message.usage deduplicando por message.id', () => {
  const texto = le('uso-claude-parcial.jsonl');
  const eventosAssistente = texto.split('\n').filter((l) => l.includes('"type":"assistant"')).length;
  assert.equal(eventosAssistente, 9); // 3 mensagens repetidas em vários eventos
  const u = usoClaudeStream(texto, 'claude:haiku');
  assert.equal(u.fonte, 'cli-parcial');
  assert.equal(u.entrada, 6);
  assert.equal(u.saida, 13);
  assert.equal(u.cacheLido, 29769 + 45656 + 56942);
  assert.equal(u.cacheGravado, 15887 + 11286 + 5597);
  assert.equal(u.custoCliUsd, null);
  assert.deepEqual(u.porModelo.map((l) => `${l.provedor}:${l.modelo}`), ['claude:claude-haiku-5-5']);
});

test('claude parcial: o mesmo id vale o último evento', () => {
  const mk = (out) => JSON.stringify({ type: 'assistant', message: { id: 'msg_a', model: 'claude-haiku-5-5', usage: { input_tokens: 1, output_tokens: out } } });
  const u = usoClaudeStream([mk(5), mk(50), mk(500)].join('\n'), 'claude:haiku');
  assert.equal(u.saida, 500);
  assert.equal(u.entrada, 1);
});

test('claude --output-format json: objeto único com os mesmos campos do result', () => {
  const u = usoClaudeJson(JSON.parse(le('uso-claude-json.json')), 'claude:haiku');
  assert.equal(u.fonte, 'cli');
  assert.equal(u.entrada, 20);
  assert.equal(u.saida, 11287);
  assert.equal(u.cacheLido, 583472);
  assert.equal(u.cacheGravado, 38883);
  assert.equal(u.porModelo[0].modelo, 'claude-haiku-5-5');
  assert.equal(usoClaudeJson(le('uso-claude-json.json'), 'claude:haiku').saida, 11287); // aceita texto
});

test('opencode: soma os eventos step_finish (saida inclui reasoning)', () => {
  const u = usoOpencode(le('uso-opencode.jsonl'), 'opencode:opencode/glm-5.3-flash-free@high');
  assert.equal(u.modelo, 'opencode:opencode/glm-5.3-flash-free');
  assert.equal(u.fonte, 'cli');
  assert.equal(u.entrada, 145482 + 1000);
  assert.equal(u.saida, 3 + 19 + 100 + 50);
  assert.equal(u.cacheLido, 150);
  assert.equal(u.cacheGravado, 200);
  assert.equal(u.custoCliUsd, 0.0021);
  assert.deepEqual(u.porModelo.map((l) => [l.provedor, l.modelo]), [['opencode', 'opencode/glm-5.3-flash-free']]);
});

test('opencode: aceita array de eventos e sem step_finish devolve null', () => {
  const evs = le('uso-opencode.jsonl').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(usoOpencode(evs, 'opencode:x').entrada, 146482);
  assert.equal(usoOpencode(evs.filter((e) => e.type !== 'step_finish'), 'opencode:x'), null);
});

test('agy stream-json: o evento result traz a contagem', () => {
  const u = usoAgyStream(le('uso-agy-stream.jsonl'), 'agy:gemini-3.8-flash-low@low', { prompt: 'x'.repeat(400) });
  assert.equal(u.modelo, 'agy:gemini-3.8-flash-low');
  assert.equal(u.fonte, 'cli');
  assert.equal(u.entrada, 13381);
  assert.equal(u.saida, 1);
  assert.equal(u.cacheLido, 0);
  assert.equal(u.custoCliUsd, null);
  assert.deepEqual(u.porModelo.map((l) => [l.provedor, l.modelo]), [['agy', 'gemini-3.8-flash-low']]);
});

test('agy stream-json sem result: soma o uso dos passos e marca cli-parcial; thinking entra na saida', () => {
  const linhas = le('uso-agy-stream.jsonl').trim().split('\n').filter((l) => !l.includes('"event":"result"'));
  assert.equal(usoAgyStream(linhas.join('\n'), 'agy:g').fonte, 'cli-parcial');
  assert.equal(usoAgyStream(linhas.join('\n'), 'agy:g').entrada, 13381);
  const r = JSON.stringify({ event: 'result', result: { usage: { input_tokens: 100, output_tokens: 10, thinking_tokens: 7, cache_read_tokens: 60 } } });
  const u = usoAgyStream(r, 'agy:g');
  assert.equal(u.saida, 17);
  assert.equal(u.cacheLido, 60);
});

test('agy em texto puro (como o worker grava): estima por prompt + resposta', () => {
  const u = usoAgyStream(le('uso-agy-texto.txt'), 'agy:gemini-3.8-flash-high', { prompt: 'p'.repeat(401) });
  const resposta = le('uso-agy-texto.txt').replace(/^﻿/, '');
  assert.equal(u.fonte, 'estimado');
  assert.equal(u.entrada, 101);
  assert.equal(u.saida, Math.ceil(resposta.length / 4));
  assert.equal(u.porModelo[0].provedor, 'agy');
  assert.equal(u.porModelo[0].modelo, 'gemini-3.8-flash-high');
});

test('estimar: ceil(caracteres / 4)', () => {
  const u = estimar(10, 9, 'agy:gemini-3.8-flash-high@high');
  assert.equal(u.entrada, 3);
  assert.equal(u.saida, 3);
  assert.equal(u.fonte, 'estimado');
  assert.equal(u.cacheLido, 0);
  assert.equal(u.custoCliUsd, null);
  assert.equal(estimar(0, 0, 'claude:haiku').saida, 0);
  assert.equal(estimar(4, 5, 'claude:haiku').saida, 2);
});

test('usoDaTentativa: claude, opencode e agy a partir de arquivos', () => {
  const c = usoDaTentativa({ tipo: 'claude', modelo: 'claude:haiku@high', out: fx('uso-claude-stream.jsonl') });
  assert.equal(c.saida, 11287);
  const o = usoDaTentativa({ tipo: 'opencode', modelo: 'opencode:opencode/glm-5.3-flash-free', out: fx('uso-opencode.jsonl') });
  assert.equal(o.fonte, 'cli');
  assert.equal(o.entrada, 146482);
  const a = usoDaTentativa({ tipo: 'agy', modelo: 'agy:gemini-3.8-flash-high', out: fx('uso-agy-texto.txt'), prompt: grava('p.txt', 'q'.repeat(40)) });
  assert.equal(a.fonte, 'estimado');
  assert.equal(a.entrada, 10);
  const j = usoDaTentativa({ tipo: 'claude', modelo: 'claude:sonnet', out: fx('uso-claude-json.json') });
  assert.equal(j.entrada, 20);
});

test('usoDaTentativa: arquivo ausente, vazio, lixo e BOM nunca lançam', () => {
  assert.equal(usoDaTentativa({ tipo: 'claude', modelo: 'claude:haiku', out: path.join(tmp, 'nao-existe.log') }), null);
  assert.equal(usoDaTentativa({ tipo: 'claude', modelo: 'claude:haiku' }), null);
  assert.equal(usoDaTentativa({}), null);
  assert.equal(usoDaTentativa(), null);
  assert.equal(usoDaTentativa({ tipo: 'claude', modelo: 'claude:haiku', out: grava('vazio.log', '') }), null);
  assert.equal(usoDaTentativa({ tipo: 'opencode', modelo: 'opencode:x', out: grava('lixo.log', 'isto nao e json\n{quebrado\n[1,2]\n') }), null);
  assert.equal(usoDaTentativa({ tipo: 'agy', modelo: 'agy:g', out: grava('agy-vazio.log', '﻿') }), null);
  const comBom = '﻿' + le('uso-claude-stream.jsonl').replace(/\n/g, '\r\n');
  const u = usoDaTentativa({ tipo: 'claude', modelo: 'claude:haiku', out: grava('bom.log', comBom) });
  assert.equal(u.saida, 11287);
  const misto = 'aviso solto\n' + le('uso-claude-stream.jsonl') + '{"type":"result"\n';
  assert.equal(usoDaTentativa({ tipo: 'claude', modelo: 'claude:haiku', out: grava('misto.log', misto) }).entrada, 20);
});

test('usoDaTentativa: sem contagem da CLI mas com resposta, estima', () => {
  const u = usoDaTentativa({ tipo: 'opencode', modelo: 'opencode:opencode/x-free', out: grava('sem-tokens.log', '{"type":"text","part":{"text":"ok"}}\n'), prompt: grava('p2.txt', 'a'.repeat(8)), texto: grava('t2.txt', 'b'.repeat(12)) });
  assert.equal(u.fonte, 'estimado');
  assert.equal(u.entrada, 2);
  assert.equal(u.saida, 3);
});

test('somarUsos: total e agregação por provedor:modelo', () => {
  const a = usoClaudeStream(le('uso-claude-stream.jsonl'), 'claude:haiku');
  const b = usoClaudeStream(le('uso-claude-stream.jsonl'), 'claude:haiku');
  const c = usoOpencode(le('uso-opencode.jsonl'), 'opencode:opencode/glm-5.3-flash-free');
  const d = estimar(40, 80, 'agy:gemini-3.8-flash-high');
  const s = somarUsos([a, null, b, c, d, undefined]);
  assert.equal(s.total.entrada, 40 + 146482 + 10);
  assert.equal(s.total.saida, 22574 + 172 + 20);
  assert.equal(s.total.cacheLido, 583472 * 2 + 150);
  assert.equal(s.total.cacheGravado, 38883 * 2 + 200);
  assert.equal(s.total.custoCliUsd, 0.040614);
  assert.deepEqual(Object.keys(s.porModelo).sort(), ['agy:gemini-3.8-flash-high', 'claude:claude-haiku-5-5', 'opencode:opencode/glm-5.3-flash-free']);
  const h = s.porModelo['claude:claude-haiku-5-5'];
  assert.equal(h.entrada, 40);
  assert.equal(h.custoCliUsd, 0.038514);
  assert.deepEqual(h.fontes, ['cli']);
  assert.equal(s.porModelo['agy:gemini-3.8-flash-high'].custoCliUsd, null);
  assert.deepEqual(s.porModelo['agy:gemini-3.8-flash-high'].fontes, ['estimado']);
});

test('somarUsos: lista vazia ou inválida não lança', () => {
  assert.deepEqual(somarUsos([]).total, { entrada: 0, saida: 0, cacheLido: 0, cacheGravado: 0, custoCliUsd: null });
  assert.deepEqual(somarUsos(null).porModelo, {});
});

test('linha de comando extrair: uma linha JSON e código 0', () => {
  const r = spawnSync(process.execPath, [USO_CLI, 'extrair', '--tipo', 'claude', '--modelo', 'claude:haiku@high',
    '--out', fx('uso-claude-stream.jsonl'), '--prompt', path.join(tmp, 'nada.txt'), '--texto', path.join(tmp, 'nada2.txt')], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  const linhas = r.stdout.trim().split(/\r?\n/);
  assert.equal(linhas.length, 1);
  const u = JSON.parse(linhas[0]);
  assert.equal(u.modelo, 'claude:haiku');
  assert.equal(u.saida, 11287);
  assert.equal(u.porModelo[0].modelo, 'claude-haiku-5-5');
});

test('linha de comando extrair: sem dado imprime null e sai com 0; argumentos faltando também', () => {
  const r = spawnSync(process.execPath, [USO_CLI, 'extrair', '--tipo', 'agy', '--modelo', 'agy:x', '--out', path.join(tmp, 'nao-existe')], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'null');
  const s = spawnSync(process.execPath, [USO_CLI, 'extrair'], { encoding: 'utf8' });
  assert.equal(s.status, 0);
  assert.equal(s.stdout.trim(), 'null');
  const t = spawnSync(process.execPath, [USO_CLI, 'comando-que-nao-existe'], { encoding: 'utf8' });
  assert.equal(t.status, 0);
  assert.equal(t.stdout.trim(), 'null');
});

test('linha de comando somar: lê a lista pela entrada padrão', () => {
  const lista = [estimar(8, 8, 'agy:g'), estimar(4, 4, 'agy:g')];
  const r = spawnSync(process.execPath, [USO_CLI, 'somar'], { input: JSON.stringify(lista), encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).total.entrada, 3);
});
