// Testa agoraNaTarefa (server.mjs): leitura de .out.log e, sem ação legível, de .err.log.
// Importar o server.mjs sobe o servidor; por isso usa DATA temporário, porta livre e sem provedores.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'delegar-agora-'));
process.env.DELEGAR_DATA = path.join(raiz, 'data');
process.env.DELEGAR_PORT = String(18000 + Math.floor(Math.random() * 1000));
process.env.DELEGAR_PROVEDORES = 'nenhum';
process.env.DELEGAR_SEM_AVISO = '1';
const { agoraNaTarefa } = await import('../server.mjs');

const P = { id: 'proj-teste-agora' };
const TID = 't1';
let ld;
const out = (txt) => fs.writeFileSync(path.join(ld, '1-w.out.log'), txt);
const err = (txt) => fs.writeFileSync(path.join(ld, '1-w.err.log'), txt);
const claude = (cmd) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: cmd } }] } });

before(() => { ld = path.join(process.env.DELEGAR_DATA, 'projects', P.id, 'logs', TID); fs.mkdirSync(ld, { recursive: true }); });
after(() => { try { fs.rmSync(raiz, { recursive: true, force: true }); } catch {} setImmediate(() => process.exit(process.exitCode || 0)); });
const limpa = () => { for (const f of fs.readdirSync(ld)) fs.rmSync(path.join(ld, f)); };

test('out.log com ação legível ignora err.log', () => {
  limpa(); out(claude('ls -la') + '\n'); err('falha qualquer\n');
  const r = agoraNaTarefa(P, TID);
  assert.equal(r.acao, 'Bash: ls -la');
  assert.ok(!r.acao.startsWith('erro: '));
});

test('out.log vazio + err.log com erro devolve "erro: " e atualizado do err.log', () => {
  limpa(); out(''); err('Error: quota exceeded\n');
  const antigo = new Date(Date.now() - 3600_000);
  fs.utimesSync(path.join(ld, '1-w.out.log'), antigo, antigo);
  const r = agoraNaTarefa(P, TID);
  assert.equal(r.acao, 'erro: Error: quota exceeded');
  assert.ok(new Date(r.atualizado) > antigo);
  assert.equal(new Date(r.atualizado).getTime(), fs.statSync(path.join(ld, '1-w.err.log')).mtime.getTime());
});

test('out.log só com JSON sem texto cai para o err.log', () => {
  limpa(); out('{"type":"system"}\n'); err('boom\n');
  assert.equal(agoraNaTarefa(P, TID).acao, 'erro: boom');
});

test('err.log ausente, vazio, só espaços ou JSON sem texto: acao vazia, sem exceção', () => {
  for (const conteudo of [null, '', '  \n\r\n \t\n', '{"type":"x"', '{"a":1}\n']) {
    limpa(); out('');
    if (conteudo !== null) err(conteudo);
    let r;
    assert.doesNotThrow(() => { r = agoraNaTarefa(P, TID); });
    assert.equal(r.acao, '');
    assert.ok(r.atualizado);
  }
});

test('rodada nova: usa o log mais recente, não o de maior número (caso de 18/11)', () => {
  limpa();
  const oc = (ts, tipo, extra = {}) => JSON.stringify({ type: tipo, timestamp: ts, part: extra });
  fs.writeFileSync(path.join(ld, '2-w.out.log'), oc(Date.now() - 1800_000, 'tool_use', { tool: 'write', state: { input: { filePath: 'antigo.js' } } }) + '\n');
  const antigo = new Date(Date.now() - 1800_000);
  fs.utimesSync(path.join(ld, '2-w.out.log'), antigo, antigo);
  out(oc(Date.now() - 60_000, 'tool_use', { tool: 'bash', state: { input: { command: 'node --check a.js' } } }) + '\n' + oc(Date.now() - 30_000, 'step_start') + '\n');
  fs.writeFileSync(path.join(ld, 'current.json'), JSON.stringify({ worker: 'opencode:nvidia/x', attempt: 1 }));
  const r = agoraNaTarefa(P, TID);
  assert.equal(r.arquivo, '1-w.out.log');
  assert.match(r.acao, /^bash: node --check a\.js · esperando o modelo há \d+ s$/);
});
