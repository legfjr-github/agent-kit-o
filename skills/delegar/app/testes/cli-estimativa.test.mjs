import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatarEstimativa, formatarComparacao } from '../cli.mjs';

test('demanda completa: imprime linha de resumo pronta e linha curta por tarefa com faixa, amostras e tempo', () => {
  const projeto = {
    id: 'proj-1',
    demanda: {
      linhaResumo: 'Demanda estimada: ~45.000 ent (entre 30.000 e 60.000) · US$ 0,15 · ~8 min',
      total: {
        entrada: 45000,
        saida: 15000,
        usd: 0.15,
        faixaEntrada: [30000, 60000],
      },
      tempo: {
        totalSeg: 480,
        faixaSeg: [300, 600],
        paralelismo: 2,
      },
      tarefas: [
        {
          id: 't1',
          demanda: 'pesado',
          modeloAssumido: 'claude:sonnet-5-5@high',
          esforcoEfetivo: 'high',
          aproximado: false,
          amostras: 5,
          entradaEstimada: 30000,
          saidaEstimada: 10000,
          duracaoSegEstimada: 360,
          faixa: { entrada: [20000, 40000], duracaoSeg: [240, 480] },
          custoUsdEstimado: 0.10,
        },
        {
          id: 't2',
          demanda: 'leve',
          modeloAssumido: 'modelo-micro',
          esforcoEfetivo: 'low',
          aproximado: true,
          amostras: 2,
          entradaEstimada: 15000,
          saidaEstimada: 5000,
          duracaoSegEstimada: 120,
          faixa: { entrada: [10000, 20000], duracaoSeg: [60, 180] },
          custoUsdEstimado: 0.05,
        },
      ],
    },
  };

  const texto = formatarEstimativa(projeto);

  // Linha de resumo pronta
  assert.ok(texto.includes('Demanda estimada: ~45.000 ent (entre 30.000 e 60.000) · US$ 0,15 · ~8 min'));

  // Tarefa 1: id, modelo, categoria, tokens com faixa e amostras, tempo em min
  assert.ok(texto.includes('t1'));
  assert.ok(texto.includes('claude:sonnet-5-5@high'));
  assert.ok(texto.includes('pesado'));
  assert.ok(texto.includes('~30.000 ent (entre 20.000 e 40.000, 5 amostras)'));
  assert.ok(texto.includes('~6 min'));

  // Tarefa 2: id, modelo aproximado marcado, categoria, tokens e tempo
  assert.ok(texto.includes('t2'));
  assert.ok(texto.includes('modelo-micro (aproximado)'));
  assert.ok(texto.includes('leve'));
  assert.ok(texto.includes('~15.000 ent (entre 10.000 e 20.000, 2 amostras)'));
  assert.ok(texto.includes('~2 min'));
});

test('demanda sem faixa nem tempo (não quebra): formata com valores disponíveis e fallback de resumo', () => {
  const projeto = {
    id: 'proj-2',
    demanda: {
      total: {
        entrada: 10000,
        saida: 2000,
        usd: 0.03,
      },
      tarefas: [
        {
          id: 'w1',
          demanda: 'volume',
          modeloAssumido: 'agy:gemini-3.8-flash',
          aproximado: false,
          entradaEstimada: 10000,
          saidaEstimada: 2000,
        },
      ],
    },
  };

  const texto = formatarEstimativa(projeto);

  // Fallback de resumo formatado
  assert.ok(texto.includes('Demanda estimada:'));
  assert.ok(texto.includes('10.000 ent / 2.000 sai'));
  assert.ok(texto.includes('US$ 0,03'));

  // Tarefa sem faixa nem tempo
  assert.ok(texto.includes('w1'));
  assert.ok(texto.includes('agy:gemini-3.8-flash'));
  assert.ok(texto.includes('volume'));
  assert.ok(texto.includes('~10.000 ent'));
  assert.ok(!texto.includes('undefined'));
  assert.ok(!texto.includes('NaN'));
});

test('comparação com erro positivo e negativo: tabela Estimado x real com tokens, tempo e total', () => {
  const projeto = {
    id: 'proj-3',
    comparacaoEstimativa: {
      tarefas: [
        {
          id: 't1',
          estimado: { entrada: 10000, saida: 2000, duracaoSeg: 120 },
          real: { entrada: 12000, saida: 1800, duracaoSeg: 180 },
          erroRel: { entrada: 0.20, saida: -0.10, duracaoSeg: 0.50 },
        },
        {
          id: 't2',
          estimado: { entrada: 5000, saida: 1000, duracaoSeg: 60 },
          real: { entrada: 4500, saida: 1100, duracaoSeg: 60 },
          erroRel: { entrada: -0.10, saida: 0.10, duracaoSeg: 0 },
        },
      ],
      total: {
        estimado: { entrada: 15000, saida: 3000, duracaoSeg: 180 },
        real: { entrada: 16500, saida: 2900, duracaoSeg: 240 },
        erroRel: { entrada: 0.10, saida: -0.033, duracaoSeg: 0.333 },
      },
    },
  };

  const texto = formatarComparacao(projeto);

  // Cabeçalho da tabela
  assert.ok(texto.includes('Estimado x real:'));
  assert.ok(texto.includes('Tarefa'));
  assert.ok(texto.includes('Entrada est.'));
  assert.ok(texto.includes('Entrada real'));
  assert.ok(texto.includes('Erro ent.'));
  assert.ok(texto.includes('Saída est.'));
  assert.ok(texto.includes('Saída real'));
  assert.ok(texto.includes('Erro saí.'));
  assert.ok(texto.includes('Tempo est.'));
  assert.ok(texto.includes('Tempo real'));
  assert.ok(texto.includes('Erro tempo'));

  // Tarefa t1: valores e erros positivo (+20%, +50%) e negativo (-10%)
  assert.ok(texto.includes('t1'));
  assert.ok(texto.includes('10.000'));
  assert.ok(texto.includes('12.000'));
  assert.ok(texto.includes('+20%'));
  assert.ok(texto.includes('2.000'));
  assert.ok(texto.includes('1.800'));
  assert.ok(texto.includes('-10%'));
  assert.ok(texto.includes('2 min'));
  assert.ok(texto.includes('3 min'));
  assert.ok(texto.includes('+50%'));

  // Tarefa t2: erro negativo (-10%), positivo (+10%) e nulo (0%)
  assert.ok(texto.includes('t2'));
  assert.ok(texto.includes('5.000'));
  assert.ok(texto.includes('4.500'));
  assert.ok(texto.includes('1.100'));
  assert.ok(texto.includes('+10%'));
  assert.ok(texto.includes('1 min'));
  assert.ok(texto.includes('0%'));

  // Total
  assert.ok(texto.includes('Total'));
  assert.ok(texto.includes('15.000'));
  assert.ok(texto.includes('16.500'));
  assert.ok(texto.includes('3.000'));
  assert.ok(texto.includes('2.900'));
  assert.ok(texto.includes('4 min'));
  assert.ok(texto.includes('+33%'));
});

test('projeto sem demanda (string vazia): formatarEstimativa e formatarComparacao retornam string vazia', () => {
  assert.equal(formatarEstimativa(null), '');
  assert.equal(formatarEstimativa(undefined), '');
  assert.equal(formatarEstimativa({}), '');
  assert.equal(formatarEstimativa({ id: 'proj-vazio', titulo: 'Sem demanda' }), '');

  assert.equal(formatarComparacao(null), '');
  assert.equal(formatarComparacao(undefined), '');
  assert.equal(formatarComparacao({}), '');
  assert.equal(formatarComparacao({ id: 'proj-vazio', titulo: 'Sem comparacao' }), '');
});
