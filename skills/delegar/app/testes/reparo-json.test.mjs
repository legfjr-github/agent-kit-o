// Reparo local do JSON do plano (sem IA). As funções são lidas do server.mjs (que sobe o servidor ao ser
// importado), então o teste recorta o código delas e o avalia isolado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const corte = (nome) => {
  const i = src.indexOf(`function ${nome}(`);
  assert.ok(i >= 0, nome);
  const k = src.indexOf('\n}', i); // funções de topo fecham com } na coluna 0
  return src.slice(i, k + 2);
};
const { repararJson, extractPlan } = new Function(`${corte('repararJson')}\n${corte('extractPlan')}\nreturn { repararJson, extractPlan };`)();
const bloco = (j) => 'Segue o plano.\n```json\n' + j + '\n```\n';

test('JSON correto passa sem reparo', () => {
  const r = extractPlan(bloco('{"tarefas":[{"id":"w1","prompt":"faça x"}]}'));
  assert.equal(r.plan.tarefas[0].id, 'w1');
  assert.equal(r.reparo, undefined);
});

test('quebra de linha crua dentro do texto (Unterminated string) é consertada', () => {
  const r = extractPlan(bloco('{"tarefas":[{"id":"w1","prompt":"linha 1\nlinha 2\tcom tab"}]}'));
  assert.equal(r.reparo, 'local');
  assert.equal(r.plan.tarefas[0].prompt, 'linha 1\nlinha 2\tcom tab');
});

test('vírgula sobrando antes de } e ] é removida, mas não dentro de texto', () => {
  const r = extractPlan(bloco('{"tarefas":[{"id":"w1","prompt":"a, ]b",},],}'));
  assert.equal(r.plan.tarefas[0].prompt, 'a, ]b');
});

test('aspas tipográficas fora de texto e lixo em volta', () => {
  const r = extractPlan(bloco('lixo {“tarefas”:[]} fim'));
  assert.deepEqual(r.plan, { tarefas: [] });
});

test('bloco ```json sem fecho é lido', () => {
  const r = extractPlan('texto\n```json\n{"tarefas":[]}\n');
  assert.deepEqual(r.plan, { tarefas: [] });
});

test('escape já correto não é duplicado', () => {
  const r = extractPlan(bloco('{"p":"a\\\\b \\"c\\" \\n"}'));
  assert.equal(r.plan.p, 'a\\b "c" \n');
  assert.equal(r.reparo, undefined);
});

test('defeito que o reparo local não resolve devolve erro e o texto bruto para o corretor', () => {
  const r = extractPlan(bloco('{"tarefas":[{"id":"w1","prompt":"ele disse "oi" e saiu"}]}'));
  assert.equal(r.plan, null);
  assert.match(r.error, /^JSON do plano inválido: /);
  assert.ok(r.bruto.includes('"oi"'));
});

test('sem bloco json não é erro', () => {
  assert.deepEqual(extractPlan('só conversa'), { plan: null });
});

test('__proto__ no JSON não polui Object.prototype', () => {
  const r = extractPlan(bloco('{"__proto__":{"x":1},"tarefas":[],}'));
  assert.ok(r.plan);
  assert.equal(({}).x, undefined);
});
