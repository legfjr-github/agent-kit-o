// Quantas tarefas ao mesmo tempo: o automático usa o número do planejador (até 6); o manual, o limite do modo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const i = src.indexOf('function paralelismo(');
const corpo = src.slice(i, src.indexOf('\n}', i) + 2);
const paralelismo = new Function('supDe', 'LIMITE_PARALELO', `${corpo}\nreturn paralelismo;`)((p) => p.supervisao || 'automatico', 6);
const modo = { maxConcurrent: 2 };

test('automático usa o pedido do planejador', () => {
  assert.equal(paralelismo({ auto: true, supervisao: 'acompanhado', plano: { maxConcurrent: 5 } }, modo), 5);
  assert.equal(paralelismo({ auto: false, supervisao: 'automatico', plano: { maxConcurrent: 4 } }, modo), 4);
});

test('automático nunca passa de 6', () => {
  assert.equal(paralelismo({ auto: true, plano: { maxConcurrent: 40 } }, modo), 6);
});

test('manual fica no limite do modo', () => {
  assert.equal(paralelismo({ auto: false, supervisao: 'acompanhado', plano: { maxConcurrent: 5 } }, modo), 2);
  assert.equal(paralelismo({ auto: false, supervisao: 'passo', plano: { maxConcurrent: 1 } }, modo), 1);
});

test('valor inválido cai no modo', () => {
  for (const v of [undefined, 0, -3, 2.5, 'cinco', null]) assert.equal(paralelismo({ auto: true, plano: { maxConcurrent: v } }, modo), 2);
});
