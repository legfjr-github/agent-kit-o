// estimarTarefaPorHistorico: a duração vem do mesmo modelo antes de misturar todos (teste NVIDIA de 19/11/2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimarTarefaPorHistorico } from '../historico-estimativa.mjs';

const amostra = (modelo, duracaoSeg, familia) => ({ modelo, familia, demanda: 'codigo', nivel: 'volume', esforco: 'medium', charsPrompt: 1000, entrada: 1000, saida: 100, cacheLido: 0, cacheGravado: 0, duracaoSeg });
const NV = 'opencode:nvidia/minimaxai/minimax-m3.1-flash';
const historico = [
  ...[3000, 3600, 4200].map((d) => amostra(NV, d, 'nvidia')),
  ...Array.from({ length: 20 }, () => amostra('claude:sonnet', 120, 'claude')),
];
const tarefa = { demanda: 'codigo', nivel: 'volume', esforco: 'medium', prompt: 'x'.repeat(1000) };

test('modelo lento não é diluído pelos rápidos', () => {
  assert.equal(estimarTarefaPorHistorico(tarefa, { historico, modelo: NV }).duracaoSeg, 3600);
  assert.equal(estimarTarefaPorHistorico(tarefa, { historico, modelo: 'claude:sonnet' }).duracaoSeg, 120);
});

test('modelo sem histórico de duração cai para categoria', () => {
  const r = estimarTarefaPorHistorico(tarefa, { historico, modelo: 'agy:gemini-4-hydrogen-medium' });
  assert.equal(r.duracaoSeg, 120);
});
