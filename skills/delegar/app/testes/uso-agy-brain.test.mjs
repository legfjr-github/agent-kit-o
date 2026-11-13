// Contagem real do agy pelos logs locais (brain), com uma pasta falsa.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { usoAgyBrain } from '../uso.mjs';

function sessao(base, nome, criada, conteudo, passos) {
  const dir = path.join(base, nome, '.system_generated', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const linhas = [{ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: criada, content: '<USER_REQUEST>\n' + conteudo }]
    .concat(passos.map((p, i) => ({ step_index: i + 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: criada, ...p })))
    .concat([{ step_index: 99, source: 'SYSTEM', type: 'TOOL_RESULT', created_at: criada, input_tokens: 999999 }]);
  fs.writeFileSync(path.join(dir, 'transcript_full.jsonl'), linhas.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

test('soma os passos do modelo da sessão certa e ignora as outras', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-'));
  try {
    const agora = Date.now(); const iso = new Date(agora).toISOString();
    const prompt = 'Você é um agente ESCRITOR numa worktree git isolada.\nFaça a tarefa X do projeto Delegar 123 com cuidado e testes.';
    sessao(base, 'certa', iso, prompt + '\n(Projeto Delegar 123.)', [
      { input_tokens: 15278, cache_read_tokens: 0, output_tokens: 1738 },
      { input_tokens: 2610, cache_read_tokens: 15089, output_tokens: 255 },
    ]);
    sessao(base, 'outra', iso, 'Outro pedido qualquer, sem relação com a tarefa acima de forma alguma.', [{ input_tokens: 5, cache_read_tokens: 0, output_tokens: 5 }]);
    const u = usoAgyBrain(prompt, agora - 1000, agora + 1000, 'agy:gemini-3.8-flash-high', [base]);
    assert.equal(u.fonte, 'cli');
    assert.equal(u.entrada, 17888);
    assert.equal(u.saida, 1993);
    assert.equal(u.cacheLido, 15089);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('sessão fora da janela da tentativa ou pasta inexistente não conta', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-'));
  try {
    const antiga = new Date(Date.now() - 6 * 3600e3).toISOString();
    const prompt = 'Prompt de teste com tamanho suficiente para virar assinatura da sessão.';
    sessao(base, 'velha', antiga, prompt, [{ input_tokens: 10, cache_read_tokens: 0, output_tokens: 10 }]);
    assert.equal(usoAgyBrain(prompt, Date.now() - 1000, Date.now(), 'agy:x', [base]), null);
    assert.equal(usoAgyBrain(prompt, Date.now(), Date.now(), 'agy:x', [path.join(base, 'nao-existe')]), null);
    assert.equal(usoAgyBrain('curto', Date.now(), Date.now(), 'agy:x', [base]), null);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
