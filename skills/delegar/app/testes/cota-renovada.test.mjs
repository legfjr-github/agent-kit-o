// Leitura de cota de uma janela que já renovou não bloqueia o modelo na estimativa (19/11/2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { semCota, modeloProvavel } from '../historico-estimativa.mjs';

const agora = Date.parse('2026-11-19T16:21:28Z');
const antes = new Date(agora - 60e3).toISOString();
const depois = new Date(agora + 3600e3).toISOString();

test('Claude em 108% com janela já renovada conta como livre', () => {
  const cotas = { claude: { read: true, fiveHour: 1.08, fiveHourResets: antes } };
  assert.equal(semCota('claude', 'haiku', cotas, agora), null);
  assert.equal(modeloProvavel(['claude:haiku', 'opencode:nvidia/x'], { dadosCotas: cotas, agoraMs: agora }).modelo, 'claude:haiku');
});

test('Claude em 108% com janela ainda aberta continua bloqueado', () => {
  const cotas = { claude: { read: true, fiveHour: 1.08, fiveHourResets: depois } };
  assert.match(semCota('claude', 'haiku', cotas, agora), /108%/);
});

test('Antigravity esgotado com janela renovada volta a valer', () => {
  assert.equal(semCota('agy', 'gemini-4-neon-low', { gemini: { read: true, exhausted: true, fiveHourRemaining: 0, fiveHourResets: antes } }, agora), null);
  assert.ok(semCota('agy', 'gemini-4-neon-low', { gemini: { read: true, exhausted: true, fiveHourRemaining: 0, fiveHourResets: depois } }, agora));
});
