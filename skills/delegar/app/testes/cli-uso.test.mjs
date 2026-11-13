import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatarUso, formatarPrecos } from '../cli.mjs';

test('formatarPrecos: alinhamento, formatação de números, idade e null vira -', () => {
  const dados = {
    atualizado: '2026-11-13',
    idadeDias: 5,
    fonte: 'litellm',
    usdBrl: 5.61,
    modelos: {
      'claude-sonnet-5-5': {
        entrada: 3,
        saida: 15,
        cacheLido: 0.3,
        cacheGravado: 3.75,
        aproximado: false
      },
      'modelo-micro': {
        entrada: 0.005,
        saida: 0.02,
        cacheLido: null,
        cacheGravado: null,
        aproximado: true
      }
    }
  };

  const texto = formatarPrecos(dados);
  assert.ok(texto.includes('Tabela de preços: 13/11/2026 (há 5 dias) · fonte: litellm · US$ 1 = R$ 5,61'));
  assert.ok(texto.includes('claude-sonnet-5-5'));
  assert.ok(texto.includes('3,00'));
  assert.ok(texto.includes('15,00'));
  assert.ok(texto.includes('0,30'));
  assert.ok(texto.includes('3,75'));
  assert.ok(texto.includes('modelo-micro'));
  assert.ok(texto.includes('0,0050'));
  assert.ok(texto.includes('0,02'));
  assert.ok(texto.includes('sim')); // marca aproximado

  // Verifica que linhas possuem o traço '-' para valores nulos
  const linhas = texto.split('\n');
  const linhaMicro = linhas.find((l) => l.includes('modelo-micro'));
  assert.ok(linhaMicro);
  assert.ok(linhaMicro.includes('-'));
});

test('formatarPrecos: tabela vazia e aviso', () => {
  const texto = formatarPrecos({ modelos: {}, aviso: 'Falha ao conectar' });
  assert.ok(texto.includes('Nenhum preço para mostrar.'));
  assert.ok(texto.includes('Aviso: Falha ao conectar'));
});

test('formatarUso (geral): números formatados pt-BR, US$ 2/4 casas, R$ presente e nota de assinatura', () => {
  const dados = {
    periodo: '30d',
    projetos: 2,
    usdBrl: 5.61,
    total: {
      entrada: 1500000,
      saida: 25000,
      cacheLido: 8500,
      cacheGravado: 0,
      usd: 0.0456,
      brl: 0.2558,
      origem: 'cli'
    },
    modelos: [
      {
        provedor: 'claude',
        modelo: 'sonnet-5-5',
        entrada: 1000000,
        saida: 20000,
        cacheLido: 8000,
        cacheGravado: 0,
        usd: 0.04,
        brl: 0.2244,
        origem: 'cli'
      },
      {
        provedor: 'opencode',
        modelo: 'glm-5-free',
        entrada: 500000,
        saida: 5000,
        cacheLido: 500,
        cacheGravado: 0,
        usd: 0.0056,
        brl: 0.0314,
        origem: 'gratuito'
      }
    ]
  };

  const texto = formatarUso(dados, { projeto: false });
  // Período e total
  assert.ok(texto.includes('Período: 30d (2 projetos)'));
  assert.ok(texto.includes('1.500.000 entrada'));
  assert.ok(texto.includes('25.000 saída'));
  assert.ok(texto.includes('8.500 cache lido'));
  assert.ok(texto.includes('0 cache gravado'));
  assert.ok(texto.includes('US$ 0,05'));
  assert.ok(texto.includes('R$ 0,26'));

  // Modelos
  assert.ok(texto.includes('claude:sonnet-5-5'));
  assert.ok(texto.includes('1.000.000'));
  assert.ok(texto.includes('opencode:glm-5-free'));
  assert.ok(texto.includes('0,0056')); // 4 casas decimais para valor < 0,01
  assert.ok(texto.includes('(gratuito)')); // origem entre parênteses quando não for cli/tabela

  // Nota de assinatura obrigatória
  assert.ok(texto.includes('Claude Code e Antigravity sao assinaturas: valores sao o equivalente em API.'));
});

test('formatarUso: sem R$ quando usdBrl for null e null vira traço (-)', () => {
  const dados = {
    periodo: 'hoje',
    projetos: 1,
    usdBrl: null,
    total: {
      entrada: 1200,
      saida: null,
      cacheLido: null,
      cacheGravado: null,
      usd: null,
      brl: null,
      origem: 'cli'
    },
    modelos: [
      {
        provedor: 'agy',
        modelo: 'gemini-3.8-flash',
        entrada: 1200,
        saida: null,
        cacheLido: null,
        cacheGravado: null,
        usd: null,
        brl: null,
        origem: 'desconhecido'
      }
    ]
  };

  const texto = formatarUso(dados);
  // Não deve conter coluna ou rótulo de R$
  assert.ok(!texto.includes('R$'));
  // Null vira traço '-'
  assert.ok(texto.includes('1.200 entrada · - saída · - cache lido · - cache gravado · US$ -'));
  assert.ok(texto.includes('(desconhecido)'));
});

test('formatarUso (modo projeto): lista o planejador primeiro e detalha tarefas', () => {
  const dados = {
    emAndamento: true,
    usdBrl: 5.61,
    total: {
      entrada: 3000,
      saida: 1500,
      cacheLido: 700,
      cacheGravado: 0,
      usd: 0.0375,
      brl: 0.21,
      origem: 'aproximado'
    },
    modelos: [
      {
        provedor: 'claude',
        modelo: 'sonnet-5-5',
        entrada: 3000,
        saida: 1500,
        cacheLido: 700,
        cacheGravado: 0,
        usd: 0.0375,
        brl: 0.21,
        origem: 'aproximado'
      }
    ],
    tarefas: [
      {
        id: 't2',
        titulo: 'Segunda tarefa',
        estado: 'running',
        total: {
          entrada: 500,
          saida: 200,
          cacheLido: 100,
          cacheGravado: 0,
          usd: 0.005,
          brl: 0.028,
          origem: 'cli'
        }
      },
      {
        id: 't1',
        titulo: 'Primeira tarefa',
        estado: 'done',
        total: {
          entrada: 1500,
          saida: 800,
          cacheLido: 400,
          cacheGravado: 0,
          usd: 0.02,
          brl: 0.112,
          origem: 'cli'
        }
      },
      {
        id: 'planejador',
        titulo: 'Planejador',
        estado: 'done',
        total: {
          entrada: 1000,
          saida: 500,
          cacheLido: 200,
          cacheGravado: 0,
          usd: 0.0125,
          brl: 0.07,
          origem: 'cli'
        }
      }
    ]
  };

  const texto = formatarUso(dados, { projeto: true });
  assert.ok(texto.includes('Execução em andamento.'));
  assert.ok(texto.includes('Total do projeto: 3.000 entrada · 1.500 saída · 700 cache lido · 0 cache gravado · US$ 0,04 · R$ 0,21 (aproximado)'));
  assert.ok(texto.includes('Modelos:'));
  assert.ok(texto.includes('Tarefas:'));

  // Planejador deve ser listado primeiro nas tarefas
  const linhasTarefas = texto.split('Tarefas:')[1].split('\n').filter((l) => l.trim().length > 0);
  // A primeira linha após o cabeçalho deve ser a pseudotarefa planejador
  assert.ok(linhasTarefas.length >= 2);
  const linhaPrimeiraTarefa = linhasTarefas[1]; // linhasTarefas[0] é o cabeçalho
  assert.ok(linhaPrimeiraTarefa.includes('planejador (Planejador)'));
  assert.ok(linhaPrimeiraTarefa.includes('concluída'));

  // Verifica as outras tarefas
  assert.ok(texto.includes('t1 (Primeira tarefa)'));
  assert.ok(texto.includes('t2 (Segunda tarefa)'));
  assert.ok(texto.includes('rodando'));

  // Nota de assinatura
  assert.ok(texto.includes('Claude Code e Antigravity sao assinaturas: valores sao o equivalente em API.'));
});
