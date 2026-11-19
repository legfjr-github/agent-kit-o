import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  categoriaDemanda,
  CATEGORIAS_DEMANDA,
  montarHistoricoTarefas,
  cacheHistorico,
  estimarTarefaPorHistorico,
  BASELINE_POR_CATEGORIA,
  fatorEsforcoDe,
  semCota,
  modeloProvavel,
  simularTempoPlano,
  formatarDuracao,
  linhaEstimativa,
} from '../historico-estimativa.mjs';

// ---------------------------------------------------------------------------------------------
// 1. categoriaDemanda
// ---------------------------------------------------------------------------------------------
test('categoriaDemanda: campo explicito, integrador e palavras-chave de cada categoria', () => {
  // Explícito
  assert.equal(categoriaDemanda({ demanda: 'leitura' }), 'leitura');
  assert.equal(categoriaDemanda({ demanda: 'geracao' }), 'geracao');
  assert.equal(categoriaDemanda({ demanda: 'codigo' }), 'codigo');
  assert.equal(categoriaDemanda({ demanda: 'integracao' }), 'integracao');

  // Tipo integrador
  assert.equal(categoriaDemanda({ tipo: 'integrador', titulo: 'Tarefa qualquer' }), 'integracao');

  // Palavras de leitura
  assert.equal(categoriaDemanda({ titulo: 'Auditar e revisar código do módulo', prompt: 'Favor auditar' }), 'leitura');
  assert.equal(categoriaDemanda({ titulo: 'Revisão geral', prompt: 'Conferir e diagnosticar falhas' }), 'leitura');
  assert.equal(categoriaDemanda({ titulo: 'Investigar bug', prompt: 'analisar código detalhadamente' }), 'leitura');

  // Palavras de geração
  assert.equal(categoriaDemanda({ titulo: 'Gerar novas lições', prompt: 'Escrever texto e redigir questões' }), 'geracao');
  assert.equal(categoriaDemanda({ titulo: 'Traduzir documentação', prompt: 'analisar lotes de texto' }), 'geracao');

  // Palavras de código
  assert.equal(categoriaDemanda({ titulo: 'Implementar novo endpoint', prompt: 'corrigir função e testes' }), 'codigo');
  assert.equal(categoriaDemanda({ titulo: 'Refatorar módulo', prompt: 'resolver bug no backend' }), 'codigo');

  // Palavras de integração
  assert.equal(categoriaDemanda({ titulo: 'Fazer deploy em homologação', prompt: 'publicar release' }), 'integracao');
  assert.equal(categoriaDemanda({ titulo: 'Finalizar', prompt: 'executar commit e push' }), 'integracao');

  // Empate ou nada encontrado
  assert.equal(categoriaDemanda({ tipo: 'tarefa', titulo: 'Sem palavras conhecidas' }), 'codigo');
  assert.equal(categoriaDemanda({ tipo: 'escritor', nivel: 'volume', titulo: 'Nada aqui' }), 'geracao');
  assert.equal(categoriaDemanda({ tipo: 'escritor', nivel: 'leve', titulo: 'Texto neutro' }), 'geracao');
  assert.equal(categoriaDemanda({ tipo: 'escritor', nivel: 'pesado', titulo: 'Texto neutro' }), 'codigo');
  assert.equal(categoriaDemanda(null), 'codigo');
});

// ---------------------------------------------------------------------------------------------
// 2. Histórico lido de result.json de dois projetos falsos com DELEGAR_DATA
// ---------------------------------------------------------------------------------------------
test('montarHistoricoTarefas: le de dois projetos falsos, tentativa falha+sucesso, rodada arquivada e json quebrado', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'delegar-hist-test-'));
  const projectsDir = path.join(tmpBase, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });

  const p1Dir = path.join(projectsDir, 'proj-1');
  const p2Dir = path.join(projectsDir, 'proj-2');
  fs.mkdirSync(p1Dir, { recursive: true });
  fs.mkdirSync(p2Dir, { recursive: true });

  // Projeto 1:
  // - t1: tentativa falha (10 s, claude) seguida de sucesso (20 s, agy@high), duração soma as duas = 30 s
  // - t2: result.json quebrado
  // - rodada arquivada rodada-1 com t3
  const t1Dir = path.join(p1Dir, 'logs', 't1');
  const t2Dir = path.join(p1Dir, 'logs', 't2');
  const r1t3Dir = path.join(p1Dir, 'logs', 'rodada-1', 't3');
  fs.mkdirSync(t1Dir, { recursive: true });
  fs.mkdirSync(t2Dir, { recursive: true });
  fs.mkdirSync(r1t3Dir, { recursive: true });

  fs.writeFileSync(
    path.join(t1Dir, 'result.json'),
    JSON.stringify({
      ok: true,
      attempts: [
        {
          attempt: 1,
          code: 1,
          worker: 'claude:sonnet',
          started: '2026-11-18T10:00:00.000Z',
          finished: '2026-11-18T10:00:10.000Z',
          uso: { entrada: 1000, saida: 200, cacheLido: 50, cacheGravado: 10 },
        },
        {
          attempt: 2,
          code: 0,
          ok: true,
          worker: 'agy:gemini-3.8-flash-high@high',
          started: '2026-11-18T10:00:15.000Z',
          finished: '2026-11-18T10:00:35.000Z',
          uso: { entrada: 5000, saida: 1000, cacheLido: 500, cacheGravado: 100 },
        },
      ],
    })
  );

  // t2 com JSON quebrado
  fs.writeFileSync(path.join(t2Dir, 'result.json'), '{ invalid json [[[ !');

  // t3 na rodada arquivada
  fs.writeFileSync(
    path.join(r1t3Dir, 'result.json'),
    JSON.stringify({
      ok: true,
      attempts: [
        {
          attempt: 1,
          code: 0,
          ok: true,
          worker: 'claude:haiku',
          started: '2026-11-18T09:00:00.000Z',
          finished: '2026-11-18T09:00:45.000Z',
          uso: { entrada: 2500, saida: 600, cacheLido: 100, cacheGravado: 0 },
        },
      ],
    })
  );

  // Projeto 2:
  // - t4 com 0 tokens (semTokens: true, guarda só duração)
  const t4Dir = path.join(p2Dir, 'logs', 't4');
  fs.mkdirSync(t4Dir, { recursive: true });
  fs.writeFileSync(
    path.join(t4Dir, 'result.json'),
    JSON.stringify({
      ok: true,
      attempts: [
        {
          attempt: 1,
          code: 0,
          worker: 'agy:gemini-3.8-flash',
          started: '2026-11-18T11:00:00.000Z',
          finished: '2026-11-18T11:00:15.000Z',
          uso: { entrada: 0, saida: 0, cacheLido: 0, cacheGravado: 0 },
        },
      ],
    })
  );

  const projetos = [
    {
      id: 'proj-1',
      plano: {
        tarefas: [
          { id: 't1', tipo: 'tarefa', prompt: 'Implementar modulo.mjs e server.mjs' },
          { id: 't2', tipo: 'tarefa', prompt: 'Refatorar cotas.mjs' },
        ],
      },
      rodadas: [
        {
          numero: 1,
          logDir: 'logs/rodada-1',
          plano: {
            tarefas: [{ id: 't3', tipo: 'escritor', nivel: 'volume', prompt: 'Gerar lições' }],
          },
        },
      ],
    },
    {
      id: 'proj-2',
      plano: {
        tarefas: [{ id: 't4', tipo: 'integrador', prompt: 'Deploy da aplicacao' }],
      },
    },
  ];

  const historico = montarHistoricoTarefas(projetos, { dataDir: tmpBase });

  // 3 tarefas válidas encontradas (t1, t3, t4; t2 quebrado é ignorado)
  assert.equal(historico.length, 3);

  // t1: modelo da tentativa de sucesso, esforço extraído de @high, duração somada (10 + 20 = 30)
  const h1 = historico.find((h) => h.tarefa === 't1');
  assert.ok(h1);
  assert.equal(h1.projeto, 'proj-1');
  assert.equal(h1.modelo, 'agy:gemini-3.8-flash-high@high');
  assert.equal(h1.esforco, 'high');
  assert.equal(h1.duracaoSeg, 30);
  assert.equal(h1.entrada, 6000); // 1000 + 5000
  assert.equal(h1.saida, 1200);   // 200 + 1000
  assert.equal(h1.arquivosCitados, 2); // modulo.mjs e server.mjs
  assert.equal(h1.semTokens, undefined);

  // t3 da rodada arquivada
  const h3 = historico.find((h) => h.tarefa === 't3');
  assert.ok(h3);
  assert.equal(h3.projeto, 'proj-1');
  assert.equal(h3.modelo, 'claude:haiku');
  assert.equal(h3.duracaoSeg, 45);
  assert.equal(h3.entrada, 2500);

  // t4 do projeto 2: semTokens true, duração 15 s
  const h4 = historico.find((h) => h.tarefa === 't4');
  assert.ok(h4);
  assert.equal(h4.projeto, 'proj-2');
  assert.equal(h4.semTokens, true);
  assert.equal(h4.duracaoSeg, 15);
  assert.equal(h4.entrada, 0);

  // Limpeza
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// 3. cacheHistorico
// ---------------------------------------------------------------------------------------------
test('cacheHistorico: memoiza o resultado pelo tempo ttlMs', () => {
  let chamadas = 0;
  const fn = (x) => {
    chamadas++;
    return x * 2;
  };
  const memo = cacheHistorico(fn, 1000);

  assert.equal(memo(5), 10);
  assert.equal(chamadas, 1);
  assert.equal(memo(5), 10);
  assert.equal(chamadas, 1);

  assert.equal(memo(6), 12);
  assert.equal(chamadas, 2);
});

// ---------------------------------------------------------------------------------------------
// 4. estimarTarefaPorHistorico: escolha de similares por nível e fallbacks
// ---------------------------------------------------------------------------------------------
test('estimarTarefaPorHistorico: cascata de similares categoria+modelo -> categoria+familia -> categoria -> nivel -> baseline', () => {
  const tarefa = {
    tipo: 'tarefa',
    nivel: 'volume',
    prompt: 'Implementar testes unitarios',
    modelo: 'claude:sonnet',
  };

  // Nível 1: categoria+modelo com >= 3 amostras
  const histCatMod = [
    { demanda: 'codigo', modelo: 'claude:sonnet', familia: 'claude', nivel: 'volume', charsPrompt: 30, esforco: 'medium', entrada: 1000, saida: 200, cacheLido: 0, cacheGravado: 0, duracaoSeg: 10 },
    { demanda: 'codigo', modelo: 'claude:sonnet@high', familia: 'claude', nivel: 'volume', charsPrompt: 30, esforco: 'high', entrada: 1200, saida: 220, cacheLido: 0, cacheGravado: 0, duracaoSeg: 12 },
    { demanda: 'codigo', modelo: 'claude:sonnet', familia: 'claude', nivel: 'volume', charsPrompt: 30, esforco: 'medium', entrada: 1100, saida: 210, cacheLido: 0, cacheGravado: 0, duracaoSeg: 11 },
  ];
  const e1 = estimarTarefaPorHistorico(tarefa, { historico: histCatMod });
  assert.equal(e1.similaridade, 'categoria+modelo');
  assert.equal(e1.aproximado, false);
  assert.equal(e1.amostras, 3);
  assert.equal(e1.fonte, 'historico');

  // Nível 2: categoria+modelo com apenas 2 amostras, mas categoria+familia com 3 (inclui claude:haiku)
  const histCatFam = [
    { demanda: 'codigo', modelo: 'claude:sonnet', familia: 'claude', nivel: 'volume', charsPrompt: 30, esforco: 'medium', entrada: 1000, saida: 200, cacheLido: 0, cacheGravado: 0, duracaoSeg: 10 },
    { demanda: 'codigo', modelo: 'claude:sonnet', familia: 'claude', nivel: 'volume', charsPrompt: 30, esforco: 'medium', entrada: 1100, saida: 210, cacheLido: 0, cacheGravado: 0, duracaoSeg: 11 },
    { demanda: 'codigo', modelo: 'claude:haiku', familia: 'claude', nivel: 'volume', charsPrompt: 30, esforco: 'low', entrada: 800, saida: 150, cacheLido: 0, cacheGravado: 0, duracaoSeg: 8 },
  ];
  const e2 = estimarTarefaPorHistorico(tarefa, { historico: histCatFam });
  assert.equal(e2.similaridade, 'categoria+familia');
  assert.equal(e2.aproximado, true);
  assert.equal(e2.amostras, 3);

  // Nível 3: apenas 2 de claude na categoria, mas 3 na categoria geral (inclui agy:gemini)
  const histCat = [
    { demanda: 'codigo', modelo: 'claude:sonnet', familia: 'claude', nivel: 'volume', charsPrompt: 30, esforco: 'medium', entrada: 1000, saida: 200, cacheLido: 0, cacheGravado: 0, duracaoSeg: 10 },
    { demanda: 'codigo', modelo: 'claude:sonnet', familia: 'claude', nivel: 'volume', charsPrompt: 30, esforco: 'medium', entrada: 1100, saida: 210, cacheLido: 0, cacheGravado: 0, duracaoSeg: 11 },
    { demanda: 'codigo', modelo: 'agy:gemini-3.8-flash', familia: 'gemini', nivel: 'volume', charsPrompt: 30, esforco: 'medium', entrada: 1500, saida: 300, cacheLido: 0, cacheGravado: 0, duracaoSeg: 15 },
  ];
  const e3 = estimarTarefaPorHistorico(tarefa, { historico: histCat });
  assert.equal(e3.similaridade, 'categoria');
  assert.equal(e3.aproximado, true);

  // Nível 4: apenas 2 na categoria 'codigo', mas 3 no nível 'volume' (outras categorias)
  const histNiv = [
    { demanda: 'codigo', modelo: 'claude:sonnet', familia: 'claude', nivel: 'volume', charsPrompt: 30, esforco: 'medium', entrada: 1000, saida: 200, cacheLido: 0, cacheGravado: 0, duracaoSeg: 10 },
    { demanda: 'codigo', modelo: 'claude:sonnet', familia: 'claude', nivel: 'volume', charsPrompt: 30, esforco: 'medium', entrada: 1100, saida: 210, cacheLido: 0, cacheGravado: 0, duracaoSeg: 11 },
    { demanda: 'geracao', modelo: 'claude:haiku', familia: 'claude', nivel: 'volume', charsPrompt: 30, esforco: 'medium', entrada: 2000, saida: 400, cacheLido: 0, cacheGravado: 0, duracaoSeg: 20 },
  ];
  const e4 = estimarTarefaPorHistorico(tarefa, { historico: histNiv });
  assert.equal(e4.similaridade, 'nivel');
  assert.equal(e4.aproximado, true);

  // Queda para baseline quando não há amostras suficientes
  const e5 = estimarTarefaPorHistorico(tarefa, { historico: [] });
  assert.equal(e5.similaridade, 'baseline');
  assert.equal(e5.fonte, 'baseline');
  assert.equal(e5.aproximado, true);
  assert.equal(e5.amostras, 0);
  assert.equal(e5.entrada, BASELINE_POR_CATEGORIA.codigo.entrada);
  assert.equal(e5.saida, BASELINE_POR_CATEGORIA.codigo.saida);
});

// ---------------------------------------------------------------------------------------------
// 5. Faixa p25 e p75 e contagem de amostras
// ---------------------------------------------------------------------------------------------
test('estimarTarefaPorHistorico: calcula percentis p25 e p75 na faixa e contagem de amostras', () => {
  const tarefa = {
    tipo: 'tarefa',
    nivel: 'volume',
    prompt: 'x'.repeat(100),
    modelo: 'claude:sonnet',
  };

  const amostras = [100, 200, 300, 400, 500].map((v) => ({
    demanda: 'codigo',
    modelo: 'claude:sonnet',
    familia: 'claude',
    nivel: 'volume',
    charsPrompt: 100,
    esforco: 'medium',
    entrada: v,
    saida: v / 10,
    cacheLido: v * 2,
    cacheGravado: 0,
    duracaoSeg: v / 5,
  }));

  const est = estimarTarefaPorHistorico(tarefa, { historico: amostras });
  assert.equal(est.amostras, 5);
  assert.equal(est.entrada, 300); // mediana de [100, 200, 300, 400, 500]
  assert.equal(est.faixa.entrada[0], 200); // p25
  assert.equal(est.faixa.entrada[1], 400); // p75
});

// ---------------------------------------------------------------------------------------------
// 6. semCota e modeloProvavel
// ---------------------------------------------------------------------------------------------
test('semCota e modeloProvavel: pula claude com fiveHour alto e gemini esgotado', () => {
  const dadosCotas = {
    claude: {
      read: true,
      fiveHour: 0.88,
      fiveHourResets: '2099-01-01T15:00:00Z',
      sevenDay: 0.50,
    },
    gemini: {
      read: true,
      exhausted: true,
      fiveHourRemaining: 0,
    },
  };

  // Teste de semCota individual
  const motClaude = semCota('claude', 'sonnet', dadosCotas);
  assert.ok(motClaude);
  assert.match(motClaude, /cota do Claude em 88% na janela de 5 h/);

  const motGemini = semCota('agy', 'gemini-3.8-flash', dadosCotas);
  assert.ok(motGemini);
  assert.match(motGemini, /cota de gemini no Antigravity esgotada/);

  const motOpencode = semCota('opencode', 'glm-5.3-flash-free', dadosCotas);
  assert.equal(motOpencode, null);

  // Teste de modeloProvavel com cadeia contendo claude, gemini e opencode
  const cadeia = [
    'claude:sonnet@high',
    'agy:gemini-3.8-flash',
    'opencode:opencode/glm-5.3-flash-free',
  ];

  const res = modeloProvavel(cadeia, { dadosCotas });
  assert.equal(res.modelo, 'opencode:opencode/glm-5.3-flash-free');
  assert.equal(res.esforco, 'medium');
  assert.equal(res.pulados.length, 2);
  assert.equal(res.pulados[0].modelo, 'claude:sonnet@high');
  assert.equal(res.pulados[1].modelo, 'agy:gemini-3.8-flash');

  // Se todos forem pulados, devolve o último
  const cadeiaTodosPulados = ['claude:sonnet', 'agy:gemini-3.8-flash'];
  const resTodos = modeloProvavel(cadeiaTodosPulados, { dadosCotas });
  assert.equal(resTodos.modelo, 'agy:gemini-3.8-flash');
  assert.equal(resTodos.pulados.length, 2);
});

// ---------------------------------------------------------------------------------------------
// 7. simularTempoPlano
// ---------------------------------------------------------------------------------------------
test('simularTempoPlano: 4 escritores paralelos, 1 integrador dependente e paralelismo 2 com intervalo de 60 s', () => {
  const tarefas = [
    { id: 't1', depende: [] },
    { id: 't2', depende: [] },
    { id: 't3', depende: [] },
    { id: 't4', depende: [] },
    { id: 't5', depende: ['t1', 't2', 't3', 't4'] },
  ];

  // Cada tarefa de escrita dura 100 s, integrador dura 50 s
  const duracaoSeg = {
    t1: 100,
    t2: 100,
    t3: 100,
    t4: 100,
    t5: 50,
  };

  const sim = simularTempoPlano(tarefas, { duracaoSeg, paralelismo: 2, intervaloSeg: 60 });

  // Cronologia esperada:
  // t = 0: t1 dispara (termina em 100)
  // t = 60: t2 dispara (intervalo 60 s, termina em 160)
  // t = 100: t1 termina, vaga abre. Próximo disparo possível em max(100, 60 + 60) = 120
  // t = 120: t3 dispara (termina em 220)
  // t = 160: t2 termina, vaga abre. Próximo disparo possível em max(160, 120 + 60) = 180
  // t = 180: t4 dispara (termina em 280)
  // t = 220: t3 termina
  // t = 280: t4 termina. Todas as dependências de t5 satisfeitas.
  //          Último disparo foi em 180 (280 - 180 = 100 >= 60). t5 dispara em 280!
  // t = 330: t5 termina (280 + 50 = 330)
  assert.equal(sim.inicioSeg.t1, 0);
  assert.equal(sim.inicioSeg.t2, 60);
  assert.equal(sim.inicioSeg.t3, 120);
  assert.equal(sim.inicioSeg.t4, 180);
  assert.equal(sim.inicioSeg.t5, 280);
  assert.equal(sim.totalSeg, 330);
  assert.deepEqual(sim.faixaSeg, [330, 330]);
});

// ---------------------------------------------------------------------------------------------
// 8. formatarDuracao e linhaEstimativa
// ---------------------------------------------------------------------------------------------
test('formatarDuracao e linhaEstimativa: montagem de texto formatado pt-BR', () => {
  assert.equal(formatarDuracao(30), '30 s');
  assert.equal(formatarDuracao(2700), '45 min');
  assert.equal(formatarDuracao(4800), '~1 h 20 min');
  assert.equal(formatarDuracao(4800, { semTilde: true }), '1 h 20 min');

  const resumo = {
    tempo: {
      totalSeg: 4800,
      faixaSeg: [3300, 6600], // 55 min e 1 h 50 min
    },
    total: {
      entrada: 2100000,
      usd: 1.40,
    },
    porGrupo: {
      gemini: { pct5hEstimado: 18 },
      claude: { pct5hEstimado: 0 },
    },
  };

  const linha = linhaEstimativa(resumo);
  assert.equal(
    linha,
    'Estimativa: ~1 h 20 min (entre 55 min e 1 h 50 min), ~2,1 mi tokens de entrada, ~US$ 1,40; Gemini ~18% da janela de 5 h'
  );
});
