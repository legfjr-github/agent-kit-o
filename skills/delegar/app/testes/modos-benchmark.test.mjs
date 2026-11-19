// Modos montados com o benchmark de 19/11/2026: NVIDIA fora dos projetos normais, Gemini como reserva do Claude,
// Argon no planejador e ordem de modelos por velocidade.
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DELEGAR_SEM_USO_FORA = '1';
const { MODES } = await import('../server.mjs');
import { DESESPERO } from '../modelos.mjs';

const todas = (m) => {
  const out = [...m.planner, ...m.fix, ...m.coord];
  const add = (t) => { for (const v of Object.values(t)) out.push(...v.flat()); };
  add(m.tiers); for (const t of Object.values(m.porVelocidade || {})) add(t);
  return out;
};

test('nenhum modo normal usa NVIDIA nem gratuito na frente', () => {
  for (const k of ['agressivo', 'equilibrado', 'padrao']) {
    assert.ok(!todas(MODES[k]).some((e) => e.includes('nvidia')), k);
    assert.ok(!todas(MODES[k]).some((e) => e.startsWith('opencode:')), k);
  }
});

test('Argon fica no planejador e o Gemini cobre o Claude', () => {
  for (const k of ['agressivo', 'equilibrado', 'padrao']) {
    assert.ok(MODES[k].planner.some((e) => e.includes('argon')), k);
    for (const t of Object.values(MODES[k].tiers)) {
      for (const c of Array.isArray(t[0]) ? t : [t]) assert.ok(c.some((e) => e.startsWith('agy:')), `${k}: ${c}`);
    }
  }
});

test('rápido põe o mais rápido na frente; demorado o de melhor nota', () => {
  assert.match(MODES.padrao.porVelocidade.rapido.volume[0], /hydrogen/);
  assert.match(MODES.padrao.porVelocidade.demorado.volume[0], /neon/);
  assert.match(MODES.agressivo.porVelocidade.rapido.volume[0], /opus/);
  assert.match(MODES.equilibrado.porVelocidade.demorado.pesado[0], /opus/);
});

test('no desespero a NVIDIA vem depois dos gratuitos do opencode', () => {
  const i = DESESPERO.findIndex((e) => e.includes('nvidia'));
  assert.ok(i >= 4);
  assert.ok(!MODES.desespero.tiers.volume.flat().slice(0, 1).some((e) => e.includes('nvidia')));
});
