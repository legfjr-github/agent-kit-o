// Estimado x real: ao vivo durante a execução, sem gravar o histórico; rodada nova apaga a anterior.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const corpo = (nome) => { const i = src.indexOf(`function ${nome}(`); return src.slice(i, src.indexOf('\n}', i)); };

test('em execução o painel recebe a comparação ao vivo, fora dela a gravada', () => {
  assert.match(src, /v\.comparacaoEstimativa = p\.estado === 'executando' \? comparacaoAoVivo\(p\) : \(p\.comparacaoEstimativa \|\| null\)/);
  assert.match(corpo('comparacaoAoVivo'), /gravar: false/);
});

test('comparação ao vivo sai antes de gravar estimativas.jsonl e conta o tempo da tarefa rodando até agora', () => {
  const c = corpo('montarComparacaoEstimativa');
  const iSai = c.indexOf('if (!gravar) { comp.aoVivo = true; return comp; }');
  assert.ok(iSai > 0, 'retorno antecipado');
  assert.ok(iSai < c.indexOf('estimativas.jsonl'), 'retorna antes de gravar');
  assert.match(c, /emAndamento \? Date\.now\(\)/);
});

test('rodada nova ou retomada apaga a comparação da rodada anterior', () => {
  assert.match(corpo('startPipeline'), /delete p\.comparacaoEstimativa;/);
});
