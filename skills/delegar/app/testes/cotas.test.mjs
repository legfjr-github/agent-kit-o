// Testes do quota.ps1 com a saída do agy vinda de arquivo (-AgyUsageFile). Nunca chama o agy nem o Claude de verdade.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const QUOTA = path.resolve(aqui, '..', '..', 'scripts', 'quota.ps1');
const FIX = path.join(aqui, 'fixtures');

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegar-cotas-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

// Roda o quota.ps1 e devolve o JSON (sem a última linha recommendedConcurrent=).
function rodar(arquivoUso) {
  const saida = execFileSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', QUOTA, '-SkipClaudeProbe', '-AgyUsageFile', arquivoUso,
  ], { env: { ...process.env, DELEGAR_DATA: dir }, encoding: 'utf8', timeout: 60000 });
  const linhas = saida.split(/\r?\n/).filter((l) => !l.startsWith('recommendedConcurrent='));
  return JSON.parse(linhas.join('\n'));
}
const gravar = (texto) => {
  const f = path.join(dir, 'uso.txt');
  fs.writeFileSync(f, texto, 'utf8');
  return f;
};
// Hora local no formato 's' (yyyy-MM-ddTHH:mm:ss), como o quota.ps1 devolve.
const p2 = (n) => String(n).padStart(2, '0');
const local = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
};

test('formato TAB: Gemini, Argon e Claude/GPT', () => {
  const r = rodar(path.join(FIX, 'agy-usage-tab.txt'));
  assert.equal(r.agy.read, true);
  assert.equal(r.agy.error, null);
  assert.equal(r.agy.limits.length, 5);
  assert.equal(r.gemini.source, 'agy');
  assert.equal(r.gemini.read, true);
  assert.equal(r.gemini.fiveHourRemaining, 0.9);
  assert.equal(r.gemini.sevenDayRemaining, 0.55);
  assert.equal(r.gemini.fiveHour, 0.1);
  assert.equal(r.gemini.sevenDay, 0.45);
  assert.equal(r.gemini.exhausted, false);
  assert.equal(r.gemini.maxParallel, 2);
  assert.equal(r.gemini.fiveHourResets, local('2026-11-13T17:07:41Z'));
  assert.equal(r.gemini.sevenDayResets, local('2026-11-17T14:04:15Z'));
  assert.equal(r.argon.read, true);
  assert.equal(r.argon.sevenDayRemaining, 0.84);
  assert.equal(r.argon.exhausted, false);
  assert.equal(r.agyClaudeGpt.read, true);
  assert.equal(r.agyClaudeGpt.fiveHourRemaining, 1);
  assert.equal(r.agyClaudeGpt.sevenDayRemaining, 1);
  const grupos = r.agy.limits.map((l) => `${l.group}/${l.window}`).sort();
  assert.deepEqual(grupos, [
    'agyClaudeGpt/fiveHour', 'agyClaudeGpt/sevenDay', 'argon/sevenDay', 'gemini/fiveHour', 'gemini/sevenDay',
  ]);
});

test('formato de terminal com Quota: e hora -03', () => {
  const r = rodar(path.join(FIX, 'agy-usage-terminal.txt'));
  assert.equal(r.agy.read, true);
  assert.equal(r.gemini.fiveHourRemaining, 0.9);
  assert.equal(r.gemini.sevenDay, 0.45);
  assert.equal(r.argon.sevenDayRemaining, 0.84);
  assert.equal(r.agyClaudeGpt.read, true);
  assert.equal(r.gemini.maxParallel, 2);
  assert.equal(r.gemini.sevenDayResets, local('2026-11-17T14:04:00Z'));
  assert.equal(r.gemini.fiveHourResets, local('2026-11-13T17:07:00Z'));
  assert.equal(r.argon.sevenDayResets, local('2026-11-17T16:25:00Z'));
});

test('linhas estranhas no meio são ignoradas sem quebrar', () => {
  const tab = fs.readFileSync(path.join(FIX, 'agy-usage-tab.txt'), 'utf8').split('\n');
  const texto = [tab[0], 'xyz sem numero', 'Gemini Models  abc%', '', '   ', tab[1], tab[4]].join('\n');
  const r = rodar(gravar(texto));
  assert.equal(r.agy.read, true);
  assert.equal(r.agy.limits.length, 3);
  assert.equal(r.gemini.sevenDayRemaining, 0.55);
  assert.equal(r.gemini.fiveHourRemaining, 0.9);
  assert.equal(r.argon.read, true);
  assert.equal(r.agyClaudeGpt.read, false);
});

test('saída vazia: leitura falha mas não conta como cota esgotada', () => {
  const r = rodar(gravar(''));
  assert.equal(r.agy.read, false);
  assert.equal(r.agy.limits.length, 0);
  assert.equal(r.gemini.read, false);
  assert.equal(r.gemini.exhausted, false);
  assert.notEqual(r.gemini.maxParallel, 0);
  assert.equal(r.argon.exhausted, false);
});

test('porcentagem fora de 0..100 descarta a linha', () => {
  const texto = [
    'Gemini Models\tWeekly Limit Remaining\t150%\t2026-11-17T14:04:15Z',
    'Gemini Models\tFive Hour Limit Remaining\t-5%\t2026-11-13T17:07:41Z',
    'Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-11-20T14:30:15Z',
    '  Gemini Models  Weekly Limit Remaining  150%  2026-11-17 11:04 -03',
    '  Gemini Models  Five Hour Limit Remaining  -5%  2026-11-13 14:07 -03',
  ].join('\n');
  const r = rodar(gravar(texto));
  assert.equal(r.agy.limits.length, 1);
  assert.equal(r.gemini.read, false);
  assert.equal(r.gemini.exhausted, false);
  assert.equal(r.agyClaudeGpt.read, true);
});

test('Gemini com 1% na janela de 5 h: esgotado e zero workers', () => {
  const texto = [
    'Gemini Models\tWeekly Limit Remaining\t55%\t2026-11-17T14:04:15Z',
    'Gemini Models\tFive Hour Limit Remaining\t1%\t2026-11-13T17:07:41Z',
  ].join('\n');
  const r = rodar(gravar(texto));
  assert.equal(r.gemini.read, true);
  assert.equal(r.gemini.fiveHourRemaining, 0.01);
  assert.equal(r.gemini.exhausted, true);
  assert.equal(r.gemini.maxParallel, 0);
});

test('quota.ps1 é ASCII puro', () => {
  const bytes = fs.readFileSync(QUOTA);
  const fora = [...bytes].findIndex((b) => b > 127);
  assert.equal(fora, -1, `byte não ASCII na posição ${fora}`);
});
