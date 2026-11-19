// Prévia, aplicação e desfazer do ajuste por cota (19/11/2026). Antes, os botões só gravavam a política e nenhum
// modelo mudava. Importar o server.mjs sobe o servidor: DATA temporário, porta livre e sem provedores.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'delegar-ajuste-'));
process.env.DELEGAR_DATA = path.join(raiz, 'data');
process.env.DELEGAR_VAULT = path.join(raiz, 'vault');
process.env.DELEGAR_PORT = String(19000 + Math.floor(Math.random() * 1000));
process.env.DELEGAR_PROVEDORES = 'nenhum';
process.env.DELEGAR_SEM_AVISO = '1';
const { previaAjusteCota, aplicarAjusteCotaNoPlano } = await import('../server.mjs');
after(() => { try { fs.rmSync(raiz, { recursive: true, force: true }); } catch {} setImmediate(() => process.exit(process.exitCode || 0)); });

const projeto = () => ({
  id: 'proj-ajuste-teste', modo: 'padrao', velocidade: 'auto', mensagens: [],
  plano: { titulo: 'x', resumo: 'x', verify: [], maxConcurrent: 2, tarefas: [
    { id: 'w1', titulo: 'escrever a', tipo: 'escritor', nivel: 'volume', esforco: 'medium', depende: [], prompt: 'faça a', cadeia: ['claude:sonnet@medium'] },
    { id: 'i1', titulo: 'integrar', tipo: 'integrador', nivel: 'pesado', esforco: 'medium', depende: ['w1'], prompt: 'junte', cadeia: ['claude:sonnet@medium'] },
  ] },
});

test('prévia não muda o plano e lista antes x depois', () => {
  const p = projeto();
  const antes = JSON.stringify(p.plano);
  const pv = previaAjusteCota(p, 'usar_melhor');
  assert.equal(JSON.stringify(p.plano), antes);
  assert.equal(pv.politica, 'usar_melhor');
  assert.ok(pv.antes && pv.depois);
  assert.ok(pv.mudancas.length >= 1, JSON.stringify(pv.mudancas));
  assert.ok(pv.mudancas.every((m) => m.id && ('de' in m) && ('para' in m)));
});

test('aplicar troca as cadeias e "manter originais" desfaz', () => {
  const p = projeto();
  const r = aplicarAjusteCotaNoPlano(p, 'usar_melhor');
  assert.ok(r.mudou >= 1, r.texto);
  assert.ok(p.ajusteCota && p.ajusteCota.politica === 'usar_melhor');
  assert.notDeepEqual(p.plano.tarefas.map((t) => t.cadeia), projeto().plano.tarefas.map((t) => t.cadeia));
  const pv = previaAjusteCota(p, 'ignorar');
  assert.ok(pv.mudancas.length >= 1);
  const d = aplicarAjusteCotaNoPlano(p, 'ignorar');
  assert.ok(d.mudou >= 1, d.texto);
  assert.equal(p.ajusteCota, undefined);
  assert.deepEqual(p.plano.tarefas.map((t) => t.cadeia), projeto().plano.tarefas.map((t) => t.cadeia));
});

test('dois ajustes seguidos: desfazer volta ao plano do planejador, não ao primeiro ajuste', () => {
  const p = projeto();
  aplicarAjusteCotaNoPlano(p, 'usar_melhor');
  aplicarAjusteCotaNoPlano(p, 'economizar');
  aplicarAjusteCotaNoPlano(p, 'ignorar');
  assert.deepEqual(p.plano.tarefas.map((t) => t.cadeia), projeto().plano.tarefas.map((t) => t.cadeia));
});

test('manter originais sem ajuste aplicado: nada muda', () => {
  const p = projeto();
  assert.equal(aplicarAjusteCotaNoPlano(p, 'ignorar').mudou, 0);
  assert.equal(previaAjusteCota(p, 'ignorar').mudancas.length, 0);
});

test('personalizado: escolher Haiku numa tarefa reestima e aplica só nela; desfazer volta', () => {
  const p = projeto();
  const pv = previaAjusteCota(p, 'personalizado', { cadeias: { w1: 'claude:haiku' } });
  assert.equal(pv.tarefas.length, 2);
  const w1 = pv.tarefas.find((t) => t.id === 'w1');
  assert.equal(w1.escolhido, 'claude:haiku');
  assert.ok(w1.mudou);
  assert.ok(!pv.tarefas.find((t) => t.id === 'i1').mudou);
  assert.equal(p.plano.tarefas[0].cadeia[0], 'claude:sonnet@medium');
  const r = aplicarAjusteCotaNoPlano(p, 'personalizado', { cadeias: { w1: 'claude:haiku' } });
  assert.equal(r.mudou, 1);
  assert.equal(p.plano.tarefas[0].cadeia[0], 'claude:haiku');
  assert.equal(p.plano.tarefas[1].cadeia[0], 'claude:sonnet@medium');
  aplicarAjusteCotaNoPlano(p, 'ignorar');
  assert.deepEqual(p.plano.tarefas.map((t) => t.cadeia), projeto().plano.tarefas.map((t) => t.cadeia));
});

test('personalizado sem escolha ou com modelo inválido não muda nada', () => {
  const p = projeto();
  assert.equal(previaAjusteCota(p, 'personalizado', { cadeias: {} }).mudancas.length, 0);
  assert.equal(previaAjusteCota(p, 'personalizado', { cadeias: { w1: 'rm -rf /' } }).mudancas.length, 0);
});
