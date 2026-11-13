// Testes de cotas.mjs (puro): grupos dos modelos, linhas de cotas e filtro por projeto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grupoDoModelo, linhasDeCotas, cotasDoProjeto } from '../cotas.mjs';

const CHAVES = ['claude-5h', 'claude-semanal', 'gemini-5h', 'gemini-semanal', 'argon-semanal', 'agy-claude-gpt-5h', 'agy-claude-gpt-semanal', 'opencode'];
const L = (linhas, chave) => linhas.find((l) => l.chave === chave);

const completo = () => ({
  time: '2026-11-13T12:00:00',
  claude: { installed: true, read: true, fiveHour: 0.85, sevenDay: 0.4, fiveHourRemaining: 0.15, sevenDayRemaining: 0.6, fiveHourResets: '2026-11-13T15:00:00', sevenDayResets: '2026-11-17T12:00:00', readAt: '2026-11-13T12:00:00' },
  gemini: { source: 'agy', read: true, fiveHour: 0.1, sevenDay: 0.45, fiveHourRemaining: 0.9, sevenDayRemaining: 0.55, exhausted: false, readAt: '2026-11-13T12:00:00' },
  argon: { read: true, sevenDay: 0.16, sevenDayRemaining: 0.84, exhausted: false },
  agyClaudeGpt: { read: true, fiveHourRemaining: 1, sevenDayRemaining: 1, exhausted: false },
  agy: { installed: true }, opencode: { installed: true },
});

test('grupoDoModelo: provedores, argon, claude/gpt no agy e sufixo de esforço', () => {
  assert.equal(grupoDoModelo('claude:sonnet'), 'claude');
  assert.equal(grupoDoModelo('claude:opus@xhigh'), 'claude');
  assert.equal(grupoDoModelo('agy:gemini-3.8-flash-high'), 'gemini');
  assert.equal(grupoDoModelo('agy:gemini-4-argon@high'), 'argon');
  assert.equal(grupoDoModelo('agy:gemini-4-argon-high'), 'argon');
  assert.equal(grupoDoModelo('agy:claude-sonnet-4.6'), 'agy-claude-gpt');
  assert.equal(grupoDoModelo('agy:gpt-5'), 'agy-claude-gpt');
  assert.equal(grupoDoModelo('agy:outro-modelo'), 'gemini');
  assert.equal(grupoDoModelo('opencode:x/y-free'), 'opencode');
  assert.equal(grupoDoModelo('opencode:opencode/glm-5.3-flash-free'), 'opencode');
});

test('grupoDoModelo: lixo vira null', () => {
  for (const v of [null, undefined, 5, {}, [], '', 'claude', 'claude:', 'evil:x', 'agy', ':x', 'claude: x', ['claude:sonnet']]) assert.equal(grupoDoModelo(v), null, String(v));
});

test('linhasDeCotas: ordem, nomes e conversões de um JSON completo', () => {
  const l = linhasDeCotas(completo(), { claude: true, agy: true, opencode: true });
  assert.deepEqual(l.map((x) => x.chave), CHAVES);
  assert.deepEqual(l.map((x) => x.nome), ['Claude', 'Claude', 'Gemini', 'Gemini', 'Gemini 4 Argon', 'Claude e GPT (Antigravity)', 'Claude e GPT (Antigravity)', 'opencode (gratuitos)']);
  assert.deepEqual(l.map((x) => x.janela), ['5 h', 'semanal', '5 h', 'semanal', 'semanal', '5 h', 'semanal', null]);
  const c5 = L(l, 'claude-5h');
  assert.equal(c5.restante, 0.15);
  assert.equal(c5.lida, true);
  assert.equal(c5.fonte, 'leitura');
  assert.equal(c5.renovaEm, new Date('2026-11-13T15:00:00').toISOString());
  assert.equal(c5.lidoEm, new Date('2026-11-13T12:00:00').toISOString());
  assert.equal(c5.provedor, 'claude');
  assert.equal(L(l, 'gemini-5h').restante, 0.9);
  assert.equal(L(l, 'gemini-5h').provedor, 'agy');
  assert.equal(L(l, 'argon-semanal').restante, 0.84);
  const oc = L(l, 'opencode');
  assert.equal(oc.restante, null);
  assert.equal(oc.nota, 'sem cota');
  assert.equal(oc.instalado, true);
  for (const x of l) assert.ok(['claude', 'agy', 'opencode'].includes(x.provedor) && typeof x.semCota === 'boolean' && typeof x.nota === 'string');
});

test('linhasDeCotas: Claude sem fiveHourRemaining usa 1 - fiveHour', () => {
  const l = linhasDeCotas({ claude: { installed: true, read: true, fiveHour: 0.25, sevenDay: 0.9 } }, {});
  assert.equal(L(l, 'claude-5h').restante, 0.75);
  assert.ok(Math.abs(L(l, 'claude-semanal').restante - 0.1) < 1e-9);
});

test('linhasDeCotas: cache antigo sem campos novos não quebra e dá restante null', () => {
  for (const q of [null, undefined, {}, [], 'texto', { time: '2026-11-13T12:00:00' }, { claude: null, gemini: 5, argon: [], agy: 'x' }, { claude: { installed: true }, gemini: { source: 'not installed' } }]) {
    const l = linhasDeCotas(q, { claude: true });
    assert.deepEqual(l.map((x) => x.chave), CHAVES);
    for (const x of l) {
      assert.equal(x.restante, null, x.chave);
      assert.equal(x.lida, false);
      assert.equal(x.renovaEm, null);
    }
  }
  const l = linhasDeCotas({}, { claude: true, agy: false, opencode: false });
  assert.equal(L(l, 'claude-5h').instalado, true);
  assert.equal(L(l, 'gemini-5h').instalado, false);
  assert.equal(L(l, 'claude-5h').fonte, 'sem leitura');
  assert.equal(linhasDeCotas({ claude: { installed: false } }, { claude: true })[0].instalado, false, 'o campo installed do script tem prioridade');
});

test('linhasDeCotas: valores fora de 0..1 ou inválidos são limitados', () => {
  const l = linhasDeCotas({
    claude: { read: true, fiveHourRemaining: 1.7, sevenDayRemaining: -0.3 },
    gemini: { read: true, fiveHourRemaining: 'x', sevenDay: 2, fiveHourResets: 'lixo' },
    argon: { read: true, sevenDayRemaining: Number.NaN },
  }, {});
  assert.equal(L(l, 'claude-5h').restante, 1);
  assert.equal(L(l, 'claude-semanal').restante, 0);
  assert.equal(L(l, 'gemini-5h').restante, null);
  assert.equal(L(l, 'gemini-semanal').restante, 0, '1 - 2 limitado a 0');
  assert.equal(L(l, 'gemini-5h').renovaEm, null, 'data inválida vira null');
  assert.equal(L(l, 'argon-semanal').restante, null);
});

test('linhasDeCotas: Gemini só com registro de estouros marca semCota e a hora', () => {
  const hit = new Date(2026, 10, 13, 9, 5, 0).toISOString();
  const l = linhasDeCotas({ gemini: { source: 'ledger', read: false, exhausted: true, lastQuotaHit: hit, fiveHourRemaining: 0.5 } }, { agy: true });
  for (const k of ['gemini-5h', 'gemini-semanal']) {
    const x = L(l, k);
    assert.equal(x.semCota, true);
    assert.equal(x.nota, 'estouro registrado às 09:05');
    assert.equal(x.fonte, 'registro de estouros');
    assert.equal(x.lida, false);
    assert.equal(x.restante, null);
  }
  assert.equal(L(l, 'claude-5h').semCota, false);
});

test('linhasDeCotas: arquivo manual e última leitura', () => {
  const l = linhasDeCotas({ time: '2026-11-13T12:00:00', gemini: { source: 'manual', read: true, fiveHourRemaining: 0.4 }, claude: { read: false, fiveHour: 0.5 } }, {});
  assert.equal(L(l, 'gemini-5h').fonte, 'arquivo manual');
  assert.equal(L(l, 'gemini-5h').restante, 0.4);
  assert.equal(L(l, 'claude-5h').fonte, 'última leitura');
  assert.equal(L(l, 'claude-5h').lida, false);
  assert.equal(L(l, 'claude-5h').restante, 0.5);
});

test('linhasDeCotas: esgotado sem número vira restante 0 e semCota', () => {
  const l = linhasDeCotas({ argon: { read: true, exhausted: true }, agyClaudeGpt: { read: true, exhausted: true } }, {});
  assert.equal(L(l, 'argon-semanal').restante, 0);
  assert.equal(L(l, 'argon-semanal').semCota, true);
  assert.equal(L(l, 'agy-claude-gpt-5h').restante, 0);
  assert.equal(L(l, 'agy-claude-gpt-semanal').semCota, true);
});

test('cotasDoProjeto: filtra os grupos usados e marca os que rodam agora', () => {
  const todas = linhasDeCotas(completo(), { claude: true, agy: true, opencode: true });
  const r = cotasDoProjeto(todas, ['claude:sonnet@high', 'agy:gemini-3.8-flash-high', 'opencode:x/y-free', 'lixo', null],
    [{ tarefa: 't1', modelo: 'agy:gemini-3.8-flash-medium' }, { tarefa: 't2', modelo: 'agy:gemini-4-argon-high' }, { tarefa: 't3', modelo: 'evil' }]);
  assert.deepEqual(r.map((x) => x.chave), ['claude-5h', 'claude-semanal', 'gemini-5h', 'gemini-semanal', 'opencode']);
  assert.ok(r.filter((x) => x.grupo === 'gemini').every((x) => x.atual === true && x.modelosAtuais.length === 1 && x.modelosAtuais[0].tarefa === 't1'));
  assert.ok(r.filter((x) => x.grupo !== 'gemini').every((x) => x.atual === false && x.modelosAtuais.length === 0));
  assert.ok(!r.some((x) => x.grupo === 'argon'), 'argon em uso mas fora das entradas do projeto não entra');
  assert.equal(todas[0].atual, undefined, 'as linhas originais não são alteradas');
});

test('cotasDoProjeto: entradas ou atuais inválidos não quebram', () => {
  const todas = linhasDeCotas({}, {});
  assert.deepEqual(cotasDoProjeto(todas, null, null), []);
  assert.deepEqual(cotasDoProjeto(null, ['claude:sonnet'], undefined), []);
  assert.equal(cotasDoProjeto(todas, ['claude:sonnet'], [null, {}, { tarefa: 'a' }]).length, 2);
});
