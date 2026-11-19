// worker.ps1: falha passageira do provedor repete o mesmo modelo (até 2 vezes) e depois segue a cadeia,
// em vez de encerrar a tarefa (caso de 18/11: ECONNRESET da NVIDIA derrubava a tarefa inteira).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../../scripts/worker.ps1', import.meta.url), 'utf8');
const padrao = src.match(/^\$transienteRe = '\(\?i\)(.+)'$/m)[1];
const re = new RegExp(padrao, 'i');

test('reconhece as falhas passageiras vistas na NVIDIA', () => {
  for (const m of [
    'ERRO: {"name":"APIError","data":{"message":"Connection reset by server","metadata":{"code":"ECONNRESET"}}}',
    'AI_APICallError: Internal Server Error',
    'Provider response headers timed out after 300000ms (ProviderHeaderTimeoutError)',
    'HTTP 503 Service Unavailable',
    'agy.EXE : error: failed to start conversation: backend returned an empty conversation id',
  ]) assert.ok(re.test(m), m);
});

test('err.log é lido respeitando o BOM (agy grava em UTF-16)', () => {
  assert.match(src, /\$errText = if \(Test-Path \$err\) \{ \[string\]\[IO\.File\]::ReadAllText\(\$err\) \}/);
});

test('não confunde falha da tarefa com falha do provedor', () => {
  for (const m of ['teste falhou: esperado 3, recebido 2', 'SyntaxError: Unexpected token', 'timeout de 500 ms no teste', 'arquivo não encontrado']) assert.ok(!re.test(m), m);
});

test('a checagem vem depois da de cota e antes do encerramento por falha real', () => {
  const iCota = src.indexOf("if ($quota) { Ev 'troca'");
  const iPass = src.indexOf('-match $transienteRe');
  const iReal = src.indexOf('# real failure: let the orchestrator decide');
  assert.ok(iCota > 0 && iPass > iCota && iReal > iPass);
  const trecho = src.slice(iPass, iReal);
  assert.match(trecho, /if \(\$n -le 2\)/);
  assert.match(trecho, /\$chainIdx--/);
});
