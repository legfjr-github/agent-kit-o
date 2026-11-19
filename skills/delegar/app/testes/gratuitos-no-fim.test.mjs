// Gratuitos (opencode/* e nvidia/*) só vão na frente da cadeia em tarefa leve ou no modo desespero.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const linha = src.match(/^const ehGratuito = .*$/m)[0];
const i = src.indexOf('function gratuitosNoFim(');
const corpo = src.slice(i, src.indexOf('\n}', i) + 2);
const gratuitosNoFim = new Function(`${linha}\n${corpo}\nreturn gratuitosNoFim;`)();

const NV = 'opencode:nvidia/minimaxai/minimax-m3.1-flash';
const GLM = 'opencode:opencode/glm-5.3-flash-free';
const GEM = 'agy:gemini-3.8-flash-medium';
const SON = 'claude:sonnet@medium';

test('tarefa pesada e de volume: gratuitos vão para depois dos pagos, na mesma ordem', () => {
  for (const nivel of ['pesado', 'volume']) {
    assert.deepEqual(gratuitosNoFim({ modo: 'padrao' }, { nivel }, [NV, GEM, GLM, SON]), [GEM, SON, NV, GLM], nivel);
  }
});

test('tarefa leve mantém os gratuitos na frente', () => {
  assert.deepEqual(gratuitosNoFim({ modo: 'padrao' }, { nivel: 'leve' }, [NV, GEM]), [NV, GEM]);
});

test('modo desespero e cadeia só de gratuitos não mudam', () => {
  assert.deepEqual(gratuitosNoFim({ modo: 'desespero' }, { nivel: 'pesado' }, [NV, GEM]), [NV, GEM]);
  assert.deepEqual(gratuitosNoFim({ modo: 'personalizado' }, { nivel: 'pesado' }, [NV, GLM]), [NV, GLM]);
});

test('opencode pago (openrouter) não conta como gratuito', () => {
  const OR = 'opencode:openrouter/minimax/minimax-m3';
  assert.deepEqual(gratuitosNoFim({ modo: 'padrao' }, { nivel: 'pesado' }, [NV, OR]), [OR, NV]);
});
