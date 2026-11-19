import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimarDemandaPlano,
  recomendarAjusteModelos,
  aplicarPoliticaCotaAoProjeto,
} from '../demanda-ajuste.mjs';
import { carregarPrecos } from '../precos.mjs';

const PROJETO_BASE = {
  id: 'proj-teste',
  plano: {
    tarefas: [
      {
        id: 't1',
        tipo: 'escritor',
        nivel: 'pesado',
        esforco: 'high',
        prompt: 'Refatore skills/delegar/app/server.mjs e skills/delegar/app/cotas.mjs com seguranca.',
        cadeia: ['claude:opus@high', 'claude:sonnet@high'],
      },
      {
        id: 't2',
        tipo: 'escritor',
        nivel: 'leve',
        esforco: 'medium',
        prompt: 'Atualize README.md com exemplos.',
        cadeia: ['claude:sonnet@medium', 'claude:haiku'],
      },
      {
        id: 't3',
        tipo: 'tarefa',
        nivel: 'volume',
        esforco: 'medium',
        prompt: 'Crie testes em testes/novo.test.mjs.',
        cadeia: ['agy:gemini-4-argon-high', 'agy:gemini-3.8-flash-high'],
      },
      {
        id: 't4',
        tipo: 'integrador',
        nivel: 'pesado',
        esforco: 'high',
        prompt: 'Integre tudo e rode os testes.',
        cadeia: ['claude:sonnet@high', 'agy:gemini-3.8-flash-high'],
      },
    ],
  },
};

test('estimarDemandaPlano e deterministico para a mesma entrada', () => {
  const r1 = estimarDemandaPlano(PROJETO_BASE);
  const r2 = estimarDemandaPlano(PROJETO_BASE);
  assert.deepEqual(r1, r2);
  assert.equal(r1.tarefas.length, 4);
  assert.ok(r1.total.entrada > 0);
  assert.ok(r1.total.saida > 0);
  assert.ok(r1.total.usd > 0);
});

test('estimarDemandaPlano usa historico quando ha >= 3 tarefas similares e baseline quando vazio', () => {
  const semHist = estimarDemandaPlano(PROJETO_BASE);
  assert.equal(semHist.tarefas[0].fonteEstimativa, 'baseline');

  const historico = [
    { demanda: 'codigo', modelo: 'claude:opus@high', familia: 'claude', nivel: 'pesado', esforco: 'high', charsPrompt: 80, entrada: 50000, saida: 12000, cacheLido: 100000, cacheGravado: 5000, duracaoSeg: 200 },
    { demanda: 'codigo', modelo: 'claude:opus@high', familia: 'claude', nivel: 'pesado', esforco: 'high', charsPrompt: 80, entrada: 60000, saida: 14000, cacheLido: 120000, cacheGravado: 6000, duracaoSeg: 220 },
    { demanda: 'codigo', modelo: 'claude:opus@high', familia: 'claude', nivel: 'pesado', esforco: 'high', charsPrompt: 80, entrada: 55000, saida: 13000, cacheLido: 110000, cacheGravado: 5500, duracaoSeg: 210 },
  ];

  const comHist = estimarDemandaPlano(PROJETO_BASE, { historico });
  assert.equal(comHist.tarefas[0].fonteEstimativa, 'historico');
  assert.notEqual(comHist.tarefas[0].entradaEstimada, semHist.tarefas[0].entradaEstimada);
});

test('Cenario 1: faltam 5 dias e cota semanal em 15% -> economizar_maximo', () => {
  const agoraMs = Date.parse('2026-11-17T12:00:00Z');
  const renova5d = new Date(agoraMs + 5 * 86400000).toISOString();
  const linhasCotas = [
    { grupo: 'claude', janela: 'semanal', restante: 0.15, renovaEm: renova5d },
    { grupo: 'claude', janela: '5 h', restante: 0.5 },
    { grupo: 'argon', janela: 'semanal', restante: 0.15, renovaEm: renova5d },
  ];

  const rec = recomendarAjusteModelos(PROJETO_BASE, { linhasCotas, agoraMs });
  assert.equal(rec.estrategia, 'economizar_maximo');
  assert.equal(rec.cadeiasSugeridas.t1[0], 'claude:sonnet@medium');
  assert.equal(rec.cadeiasSugeridas.t2[0], 'claude:haiku');
  assert.ok(rec.cadeiasSugeridas.t3[0].includes('gemini-3.8-flash') || rec.cadeiasSugeridas.t3[0].includes('hydrogen'));
  assert.equal(rec.esforcosSugeridos.t1, 'medium');
  assert.equal(rec.esforcosSugeridos.t2, 'low');
});

test('Cenario 2: falta 1 dia e cota semanal em 75% -> usar_melhor', () => {
  const agoraMs = Date.parse('2026-11-17T12:00:00Z');
  const renova1d = new Date(agoraMs + 1 * 86400000).toISOString();
  const linhasCotas = [
    { grupo: 'claude', janela: 'semanal', restante: 0.75, renovaEm: renova1d },
    { grupo: 'claude', janela: '5 h', restante: 0.8 },
  ];

  const projLeve = {
    id: 'proj-folga',
    plano: {
      tarefas: [
        { id: 't1', tipo: 'escritor', nivel: 'pesado', esforco: 'medium', prompt: 'Implementar feature', cadeia: ['agy:gemini-3.8-flash-medium'] },
        { id: 't2', tipo: 'tarefa', nivel: 'volume', esforco: 'medium', prompt: 'Escrever modulo', cadeia: ['agy:gemini-3.8-flash-medium'] },
      ],
    },
  };

  const rec = recomendarAjusteModelos(projLeve, { linhasCotas, agoraMs });
  assert.equal(rec.estrategia, 'usar_melhor');
  assert.equal(rec.cadeiasSugeridas.t1[0], 'claude:opus@high');
  assert.equal(rec.cadeiasSugeridas.t2[0], 'claude:sonnet@high');
});

test('Cenario 3: modoPolitica === ignorar mantem cadeias originais inalteradas', () => {
  const agoraMs = Date.parse('2026-11-17T12:00:00Z');
  const renova5d = new Date(agoraMs + 5 * 86400000).toISOString();
  const linhasCotas = [
    { grupo: 'claude', janela: 'semanal', restante: 0.10, renovaEm: renova5d },
  ];

  const res = aplicarPoliticaCotaAoProjeto(PROJETO_BASE, 'ignorar', { linhasCotas, agoraMs });
  assert.equal(res.alterado, false);
  assert.equal(res.recomendacao, null);
  assert.deepEqual(res.projeto, PROJETO_BASE);
});

test('estimativa com histórico falso usando similares de categoria+modelo (fonte historico, amostras e faixa preenchidas)', () => {
  const historicoFalso = [
    {
      demanda: 'codigo',
      modelo: 'claude:opus@high',
      familia: 'claude',
      nivel: 'pesado',
      esforco: 'high',
      charsPrompt: 100,
      entrada: 40000,
      saida: 8000,
      cacheLido: 80000,
      cacheGravado: 4000,
      duracaoSeg: 300,
    },
    {
      demanda: 'codigo',
      modelo: 'claude:opus@high',
      familia: 'claude',
      nivel: 'pesado',
      esforco: 'high',
      charsPrompt: 100,
      entrada: 50000,
      saida: 10000,
      cacheLido: 100000,
      cacheGravado: 5000,
      duracaoSeg: 350,
    },
    {
      demanda: 'codigo',
      modelo: 'claude:opus@high',
      familia: 'claude',
      nivel: 'pesado',
      esforco: 'high',
      charsPrompt: 100,
      entrada: 60000,
      saida: 12000,
      cacheLido: 120000,
      cacheGravado: 6000,
      duracaoSeg: 400,
    },
  ];

  const res = estimarDemandaPlano(PROJETO_BASE, { historico: historicoFalso });
  const t1 = res.tarefas[0];
  assert.equal(t1.fonteEstimativa, 'historico');
  assert.equal(t1.similaridade, 'categoria+modelo');
  assert.equal(t1.amostras, 3);
  assert.equal(t1.aproximado, false);
  assert.ok(t1.faixa);
  assert.ok(Array.isArray(t1.faixa.entrada));
  assert.equal(t1.faixa.entrada.length, 2);
  assert.ok(t1.faixa.entrada[0] > 0);
  assert.ok(t1.faixa.entrada[1] >= t1.faixa.entrada[0]);
  assert.ok(Array.isArray(t1.faixa.duracaoSeg));
  assert.ok(res.total.faixaEntrada);
  assert.equal(res.total.faixaEntrada.length, 2);
  assert.ok(res.total.faixaEntrada[0] > 0);
});

test('sem histórico (baseline)', () => {
  const res = estimarDemandaPlano(PROJETO_BASE, { historico: [] });
  for (const t of res.tarefas) {
    assert.equal(t.fonteEstimativa, 'baseline');
    assert.equal(t.similaridade, 'baseline');
    assert.equal(t.amostras, 0);
    assert.equal(t.aproximado, true);
    assert.ok(t.entradaEstimada > 0);
    assert.ok(t.saidaEstimada > 0);
    assert.ok(t.duracaoSegEstimada > 0);
    assert.ok(t.faixa);
  }
  assert.ok(res.total.entrada > 0);
  assert.ok(res.total.faixaEntrada[0] > 0);
  assert.ok(res.tempo.totalSeg > 0);
  assert.ok(res.linhaResumo.includes('Estimativa:'));
});

test('modelo assumido pulando claude sem cota', () => {
  const projCota = {
    id: 'proj-cota',
    plano: {
      tarefas: [
        {
          id: 't1',
          tipo: 'tarefa',
          prompt: 'Implementar funcionalidade',
          cadeia: ['claude:sonnet@high', 'agy:gemini-3.8-flash@high', 'opencode:glm-5.3-flash-free'],
        },
      ],
    },
  };

  const dadosCotas = {
    claude: {
      read: true,
      fiveHour: 0.90,
      fiveHourResets: '2099-01-01T18:00:00Z',
    },
  };

  const res = estimarDemandaPlano(projCota, { dadosCotas });
  const t1 = res.tarefas[0];
  assert.equal(t1.modeloAssumido, 'agy:gemini-3.8-flash');
  assert.equal(t1.modeloPrincipal, 'agy:gemini-3.8-flash');
  assert.equal(t1.esforcoEfetivo, 'high');
  assert.ok(t1.pulados.length >= 1);
  assert.equal(t1.pulados[0].modelo, 'claude:sonnet@high');
  assert.match(t1.pulados[0].motivo, /cota do Claude em 90%/);
});

test('tempo do plano com dependências e paralelismo', () => {
  const projDeps = {
    id: 'proj-deps',
    plano: {
      maxConcurrent: 2,
      tarefas: [
        { id: 't1', tipo: 'tarefa', prompt: 'Tarefa 1', cadeia: ['agy:gemini-3.8-flash'] },
        { id: 't2', tipo: 'tarefa', prompt: 'Tarefa 2', cadeia: ['agy:gemini-3.8-flash'] },
        { id: 't3', tipo: 'integrador', prompt: 'Integrar', depende: ['t1', 't2'], cadeia: ['agy:gemini-3.8-flash'] },
      ],
    },
  };

  const res = estimarDemandaPlano(projDeps, { paralelismo: 2 });
  assert.ok(res.tempo);
  assert.ok(res.tempo.totalSeg > 0);
  assert.ok(Array.isArray(res.tempo.faixaSeg));
  assert.equal(res.tempo.faixaSeg.length, 2);
  assert.equal(res.tempo.paralelismo, 2);
  assert.ok(res.tempo.inicioSeg);
  assert.equal(res.tempo.inicioSeg.t1, 0);
  // Pagos saem juntos (pipeline.ps1 não espera quando a cota comporta); gratuitos com 10 s entre disparos.
  assert.equal(res.tempo.inicioSeg.t2, 0);
  assert.ok(res.tempo.inicioSeg.t3 >= res.tarefas[0].duracaoSegEstimada);
});

test('recomendarAjusteModelos chamado sem demanda com chainForFn e tabela de precos', () => {
  const projSemDemanda = {
    id: 'proj-sem-demanda',
    plano: {
      tarefas: [
        {
          id: 't1',
          tipo: 'escritor',
          nivel: 'volume',
          esforco: 'medium',
          prompt: 'Refatorar codigo do modulo',
        },
      ],
    },
  };

  const tabelaPrecos = carregarPrecos();
  const chainForFn = (p, t) => ['claude:sonnet@medium', 'agy:gemini-3.8-flash'];

  const rec = recomendarAjusteModelos(projSemDemanda, {
    chainForFn,
    tabelaPrecos,
  });

  assert.ok(rec);
  assert.ok(rec.estrategia);

  const dem = estimarDemandaPlano(projSemDemanda, { chainForFn, tabelaPrecos });
  assert.equal(dem.tarefas[0].modeloPrincipal, 'claude:sonnet');
  assert.equal(dem.tarefas[0].modeloAssumido, 'claude:sonnet');
  assert.ok(dem.tarefas[0].custoUsdEstimado > 0);
  assert.ok(dem.total.usd > 0);
});

test('tempo do plano: gratuitos na frente saem com 10 s entre disparos', () => {
  const nv = 'opencode:nvidia/minimaxai/minimax-m3.1-flash';
  const proj = { id: 'proj-nv', plano: { maxConcurrent: 3, tarefas: [
    { id: 'a', tipo: 'escritor', prompt: 'A', cadeia: [nv] },
    { id: 'b', tipo: 'escritor', prompt: 'B', cadeia: [nv] },
    { id: 'c', tipo: 'escritor', prompt: 'C', cadeia: [nv] },
  ] } };
  const res = estimarDemandaPlano(proj, { paralelismo: 3 });
  assert.equal(res.tempo.inicioSeg.b, 10);
  assert.equal(res.tempo.inicioSeg.c, 20);
});
