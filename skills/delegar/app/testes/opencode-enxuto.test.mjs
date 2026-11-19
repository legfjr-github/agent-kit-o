// O opencode dos workers e do planejador roda enxuto: sem MCP, sem skills e CLAUDE.md do Claude Code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const worker = fs.readFileSync(new URL('../../scripts/worker.ps1', import.meta.url), 'utf8');

test('planejador e corretor do opencode recebem o ambiente enxuto', () => {
  const i = src.indexOf('async function runOpencode(');
  const corpo = src.slice(i, src.indexOf('\n}', i));
  assert.match(corpo, /env: envOpencodeEnxuto\(\)/);
});

test('envOpencodeEnxuto desliga os MCP do opencode.jsonc e as skills do Claude Code', () => {
  const i = src.indexOf('function envOpencodeEnxuto(');
  const corpo = src.slice(i, src.indexOf('\n}', i) + 2);
  const dir = fs.mkdtempSync(`${process.env.TEMP || '/tmp'}/oc-enxuto-`);
  fs.mkdirSync(`${dir}/.config/opencode`, { recursive: true });
  fs.writeFileSync(`${dir}/.config/opencode/opencode.jsonc`, '{\n  // comentario\n  "mcp": { "rea": {}, "vault": {} }\n}');
  const fn = new Function('fs', 'path', 'HOME', `${corpo}\nreturn envOpencodeEnxuto;`)(fs, { join: (...p) => p.join('/') }, dir);
  const env = fn({ X: '1' });
  assert.equal(env.X, '1');
  assert.equal(env.OPENCODE_DISABLE_CLAUDE_CODE, '1');
  assert.equal(env.OPENCODE_DISABLE_EXTERNAL_SKILLS, '1');
  assert.deepEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT), { mcp: { rea: { enabled: false }, vault: { enabled: false } } });
});

test('worker.ps1 aplica o mesmo ambiente antes de rodar o opencode', () => {
  const i = worker.indexOf("elseif ($kind -eq 'opencode')");
  const trecho = worker.slice(i, worker.indexOf('RunWatchedProcess', i));
  for (const v of ['OPENCODE_DISABLE_CLAUDE_CODE', 'OPENCODE_DISABLE_EXTERNAL_SKILLS', 'OPENCODE_CONFIG_CONTENT = (OpencodeSemMcp)']) assert.ok(trecho.includes(v), v);
});
