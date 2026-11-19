// O planejador passa para o próximo modelo também quando o provedor falha de forma passageira.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const re = new Function(`${src.match(/^const FALHA_PASSAGEIRA_RE = .*$/m)[0]}\nreturn FALHA_PASSAGEIRA_RE;`)();

test('caso real 18/11: espera pelos cabeçalhos da NVIDIA conta como falha passageira', () => {
  const msg = '{"name":"APIError","data":{"message":"Provider response headers timed out after 30000ms","isRetryable":true,"metadata":{"code":"ProviderHeaderTimeoutError","timeoutMs":"30000"}}}';
  assert.ok(re.test(msg));
});

test('erros de rede e de servidor sobrecarregado também', () => {
  for (const m of ['read ECONNRESET', 'connect ETIMEDOUT 1.2.3.4:443', 'HTTP 503 Service Unavailable', 'model overloaded', 'socket hang up']) assert.ok(re.test(m), m);
});

test('erro do próprio pedido não troca de modelo', () => {
  for (const m of ['invalid api key', 'model not found', 'context length exceeded', 'HTTP 400 bad request']) assert.ok(!re.test(m), m);
});

test('o laço do planejador usa a regra ao lado da de cota', () => {
  const i = src.indexOf('async function chamarPlanejador(');
  const corpo = src.slice(i, src.indexOf('\n}', i));
  assert.match(corpo, /FALHA_PASSAGEIRA_RE\.test\(r\.text\)/);
  assert.match(corpo, /QUOTA_RE\.test\(r\.text\)/);
});
