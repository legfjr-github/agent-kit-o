// Consumo fora do orquestrador: nada contado duas vezes (19/11/2026).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { montarUsoFora, usoForaNoPeriodo, usoForaVencido, gravarUsoFora, lerUsoFora } from '../uso-fora.mjs';

let raiz, claudeDir, brainDir, projectsDir;
const hoje = new Date().toISOString();
const msg = (id, out, extra = {}) => JSON.stringify({ type: 'assistant', timestamp: hoje, message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: out, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 }, ...extra } });
const escrever = (f, linhas) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, linhas.join('\n') + '\n'); };
const sessaoAgy = (nome, primeira, out) => escrever(path.join(brainDir, nome, '.system_generated', 'logs', 'transcript_full.jsonl'), [
  JSON.stringify({ step_index: 0, source: 'USER', created_at: hoje, content: primeira }),
  JSON.stringify({ step_index: 1, source: 'MODEL', created_at: hoje, model: 'gemini-4-neon-low', input_tokens: 50, cache_read_tokens: 5, output_tokens: out }),
]);

before(() => {
  raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'delegar-fora-'));
  claudeDir = path.join(raiz, 'claude'); brainDir = path.join(raiz, 'brain'); projectsDir = path.join(raiz, 'projects');
  // Sessão do usuário: msg_A aparece em 3 linhas (blocos de conteúdo), msg_B é de um worker, synthetic não conta.
  escrever(path.join(claudeDir, 'proj-x', 's1.jsonl'), [msg('msg_A', 7), msg('msg_A', 7), msg('msg_A', 7), msg('msg_B', 1000),
    JSON.stringify({ type: 'assistant', timestamp: hoje, message: { id: 'msg_S', model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } } })]);
  // Sessão continuada que copia msg_A, e o transcript que o próprio worker gravou (msg_B).
  escrever(path.join(claudeDir, 'proj-x', 's2.jsonl'), [msg('msg_A', 7), msg('msg_C', 20)]);
  escrever(path.join(claudeDir, 'proj-wt', 's3.jsonl'), [msg('msg_B', 1000)]);
  escrever(path.join(projectsDir, 'p1', 'logs', 'w1', '1-opus.out.log'), [msg('msg_B', 1000)]);
  // Antigravity: com a marca, igual a um prompt de tentativa (coordenador, sem marca) e uma conversa do usuário.
  sessaoAgy('s-marca', 'faça X\n\n(Projeto Delegar 2026-abc. Execute sem pedir confirmação.)', 900);
  const promptCoord = 'Voce e o coordenador de recuperacao do projeto; a tarefa w3 falhou depois de varias tentativas e precisa de nova cadeia.';
  escrever(path.join(projectsDir, 'p1', 'logs', 'recovery1', '1-gemini-4-neon-low.prompt.txt'), [promptCoord]);
  sessaoAgy('s-coord', promptCoord + ' detalhes', 800);
  sessaoAgy('s-usuario', 'me explique este erro', 30);
  // Planejador: Claude grava o transcript com o nome da sessão guardada no projeto; o do agy começa com o planner.md.
  escrever(path.join(projectsDir, 'p1', 'project.json'), [JSON.stringify({ id: 'p1', sessao: 'sess-plan', uso: { chamadas: [{ papel: 'corretor', sessao: 'sess-corr' }, { papel: 'planejador', modelo: 'agy:gemini-4-hydrogen-medium', quando: hoje }] } })]);
  escrever(path.join(claudeDir, 'app-delegar', 'sess-plan.jsonl'), [msg('msg_P', 5000)]);
  escrever(path.join(claudeDir, 'app-delegar', 'sess-corr.jsonl'), [msg('msg_Q', 600)]);
  sessaoAgy('s-plan-agy', '# Planejador do Delegar\n\nVocê é o planejador do sistema Delegar. ...', 4000);
  // Tarefa antiga (sem .prompt.txt) de projeto que existe: a tabela já conta, então sai daqui pela marca.
  escrever(path.join(projectsDir, 'proj-antigo', 'project.json'), [JSON.stringify({ id: 'proj-antigo' })]);
  sessaoAgy('s-antiga', 'escreva a.js\n\n(Projeto Delegar proj-antigo. Execute sem pedir confirmação.)', 700);
});
after(() => fs.rmSync(raiz, { recursive: true, force: true }));

test('cada resposta conta uma vez e o que é do orquestrador fica de fora', () => {
  const d = montarUsoFora({ claudeDir, brainDir, projectsDir });
  const porModelo = usoForaNoPeriodo(d, () => true);
  assert.deepEqual(porModelo['claude:claude-opus-5-5'], { entrada: 2, saida: 27, cacheLido: 200, cacheGravado: 20, respostas: 2 });
  // s-marca só tem a marca, sem prompt de projeto atual (projeto excluído): continua contando aqui.
  assert.equal(porModelo['agy:gemini-4-neon-low'].saida, 930);
  assert.equal(porModelo['agy:gemini-4-neon-low'].respostas, 2);
  assert.equal(d.excluidos.claude, 3); // msg_B (worker), msg_P (planejador), msg_Q (corretor)
  assert.equal(d.excluidos.agy, 3); // prompt do coordenador, planejador, tarefa antiga de projeto que existe
  assert.ok(!Object.keys(porModelo).some((k) => k.includes('synthetic')));
});

test('filtro de período e validade de 24 h', () => {
  const d = montarUsoFora({ claudeDir, brainDir, projectsDir });
  assert.deepEqual(usoForaNoPeriodo(d, () => false), {});
  assert.equal(usoForaVencido(d), false);
  assert.equal(usoForaVencido({ ...d, atualizado: new Date(Date.now() - 25 * 3600e3).toISOString() }), true);
  assert.equal(usoForaVencido(null), true);
  const dataDir = path.join(raiz, 'data');
  gravarUsoFora(dataDir, d);
  assert.equal(lerUsoFora(dataDir).atualizado, d.atualizado);
});
