import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatarUso, formatarPrecos, formatarCotas } from '../cli.mjs';

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

test('formatarUso (modo projeto): com 2+ rodadas mostra seção Rodadas e prefixa tarefas com Rn; com 1 rodada fica idêntico ao atual', () => {
  const rodadas = [
    {
      numero: 1,
      titulo: 'Primeira rodada',
      estado: 'done',
      uso: { total: { entrada: 1000, saida: 500, cacheLido: 100, cacheGravado: 0, usd: 0.01, brl: 0.056, origem: 'cli' } }
    },
    {
      numero: 2,
      titulo: 'Segunda rodada',
      estado: 'running',
      total: { entrada: 2000, saida: 800, cacheLido: 200, cacheGravado: 0, usd: 0.02, brl: 0.112, origem: 'cli' }
    }
  ];

  const dados = {
    usdBrl: 5.61,
    total: { entrada: 3000, saida: 1300, cacheLido: 300, cacheGravado: 0, usd: 0.03, brl: 0.168, origem: 'cli' },
    modelos: [],
    rodadas,
    tarefas: [
      { id: 'w1', titulo: 'W um', rodada: 1, estado: 'done', total: { entrada: 1000, saida: 500, cacheLido: 100, cacheGravado: 0, usd: 0.01, brl: 0.056, origem: 'cli' } },
      { id: 'planejador', titulo: 'Planejador', rodada: 2, estado: 'running', total: { entrada: 500, saida: 300, cacheLido: 100, cacheGravado: 0, usd: 0.005, brl: 0.028, origem: 'cli' } },
      { id: 'w1', titulo: 'W um', rodada: 2, estado: 'running', total: { entrada: 1500, saida: 500, cacheLido: 200, cacheGravado: 0, usd: 0.015, brl: 0.084, origem: 'cli' } }
    ]
  };

  const texto = formatarUso(dados, { projeto: true });
  // Seção Rodadas
  assert.ok(texto.includes('Rodadas:'));
  assert.ok(texto.includes('Rodada 1 (Primeira rodada)'));
  assert.ok(texto.includes('Rodada 2 (Segunda rodada)'));
  // a API devolve o total da rodada em r.total (rodada 2 acima); a linha precisa trazer os números, não '-'
  assert.ok(/Rodada 2 \(Segunda rodada\)\s+\S+\s+2\.000\s+800/.test(texto), texto);
  assert.ok(texto.includes('1.000') && texto.includes('concluída'));
  assert.ok(texto.includes('2.000') && texto.includes('rodando'));
  // Tarefas prefixadas com a rodada
  assert.ok(texto.includes('R1/w1 (W um)'));
  assert.ok(texto.includes('R2/w1 (W um)'));
  assert.ok(texto.includes('R2/planejador (Planejador)'));
  // Total do projeto permanece
  assert.ok(texto.includes('Total do projeto: 3.000 entrada'));

  // Com apenas uma rodada, sem seção Rodadas e sem prefixo
  const umaRodada = {
    usdBrl: 5.61,
    total: { entrada: 3000, saida: 1300, cacheLido: 300, cacheGravado: 0, usd: 0.03, brl: 0.168, origem: 'cli' },
    modelos: [],
    rodadas: [rodadas[0]],
    tarefas: [{ id: 'w1', titulo: 'W um', rodada: 1, estado: 'done', total: { entrada: 1000, saida: 500, cacheLido: 100, cacheGravado: 0, usd: 0.01, brl: 0.056, origem: 'cli' } }]
  };
  const textoUma = formatarUso(umaRodada, { projeto: true });
  assert.ok(!textoUma.includes('Rodadas:'));
  assert.ok(textoUma.includes('w1 (W um)'));
  assert.ok(!textoUma.includes('R1/w1'));
});

test('formatarUso (geral): aceita periodo com mes específico e intervalo de datas', () => {
  const usoMes = {
    periodo: '2026-10',
    projetos: 1,
    total: { entrada: 700, saida: 300, cacheLido: 0, cacheGravado: 0, usd: 0.007, brl: null, origem: 'cli' },
    modelos: []
  };
  const txtMes = formatarUso(usoMes, { projeto: false });
  assert.ok(txtMes.includes('Período: 2026-10 (1 projeto)'));

  const usoIntervalo = {
    periodo: '2026-10-01 a 2026-10-31',
    projetos: 2,
    total: { entrada: 810, saida: 350, cacheLido: 0, cacheGravado: 0, usd: 0.0081, brl: null, origem: 'cli' },
    modelos: []
  };
  const txtIntervalo = formatarUso(usoIntervalo, { projeto: false });
  assert.ok(txtIntervalo.includes('Período: 2026-10-01 a 2026-10-31 (2 projetos)'));
});

test('formatarCotas: inclui coluna 1% da cota e nota de estimativa no final', () => {
  const dados = {
    lidoEm: '2026-11-16T12:00:00.000Z',
    idadeMin: 5,
    linhas: [
      {
        chave: 'claude-5h',
        nome: 'Claude',
        janela: '5 h',
        instalado: true,
        restante: 0.85,
        renovaEm: '2026-11-16T15:00:00.000Z',
        lidoEm: '2026-11-16T12:00:00.000Z',
        fonte: 'leitura',
        estimativa: { texto: '1% ≈ 40 mil tokens de entrada / 5 mil de saída' },
      },
      {
        chave: 'opencode',
        nome: 'opencode (gratuitos)',
        janela: null,
        instalado: true,
        restante: null,
        estimativa: null,
      },
    ],
  };

  const txt = formatarCotas(dados);
  assert.ok(txt.includes('1% da cota'));
  assert.ok(txt.includes('1% ≈ 40 mil tokens de entrada / 5 mil de saída'));
  assert.ok(txt.includes('Nota: a estimativa por 1% soma o consumo local da máquina'));
});
