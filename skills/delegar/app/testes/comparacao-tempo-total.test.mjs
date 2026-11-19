// Estimado x real: com workers simultâneos o tempo total é do primeiro início ao último fim, não a soma (19/11/2026).
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'delegar-comp-'));
process.env.DELEGAR_DATA = path.join(raiz, 'data');
process.env.DELEGAR_VAULT = path.join(raiz, 'vault');
process.env.DELEGAR_PORT = String(20000 + Math.floor(Math.random() * 1000));
process.env.DELEGAR_PROVEDORES = 'nenhum';
process.env.DELEGAR_SEM_AVISO = '1';
const { montarComparacaoEstimativa } = await import('../server.mjs');
after(() => { try { fs.rmSync(raiz, { recursive: true, force: true }); } catch {} setImmediate(() => process.exit(process.exitCode || 0)); });

test('dois workers juntos: total real 105 s (não 200) e total estimado pela simulação', () => {
  const p = { id: 'proj-comp-tempo', plano: { tarefas: [{ id: 'a', tipo: 'escritor', prompt: 'a' }, { id: 'b', tipo: 'escritor', prompt: 'b' }] },
    estimativaInicial: { tarefas: { a: { duracaoSeg: 100 }, b: { duracaoSeg: 100 } }, tempo: { totalSeg: 110 } } };
  const projDir = path.join(process.env.DELEGAR_DATA, 'projects', p.id);
  const res = (tid, ini, fim) => {
    fs.mkdirSync(path.join(projDir, 'logs', tid), { recursive: true });
    fs.writeFileSync(path.join(projDir, 'logs', tid, 'result.json'), JSON.stringify({ ok: true, attempts: [{ worker: 'claude:haiku', exitCode: 0, started: ini, finished: fim }] }));
  };
  res('a', '2026-11-19T10:00:00', '2026-11-19T10:01:40');
  res('b', '2026-11-19T10:00:05', '2026-11-19T10:01:45');
  const c = montarComparacaoEstimativa(p, null, { projDir, gravar: false });
  assert.equal(c.total.real.duracaoSeg, 105);
  assert.equal(c.total.real.duracaoSomadaSeg, 200);
  assert.equal(c.total.estimado.duracaoSeg, 110);
  assert.equal(c.total.estimado.duracaoSomadaSeg, 200);
  assert.equal(c.tarefas.find((t) => t.id === 'a').real.duracaoSeg, 100);
});
