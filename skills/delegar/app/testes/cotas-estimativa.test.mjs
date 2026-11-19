import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  registrarHistoricoCota,
  lerHistoricoCotas,
  coletarTentativasUso,
  estimarTokensPorCota,
  analisarTrabalhosComParalelos,
  normalizarSubmodelo,
  pesosDePrecoDoModelo,
  lerLogsClaudeCode,
  lerLogsAntigravityBrain,
  fmtMil,
} from '../cotas-estimativa.mjs';

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegar-estimativa-test-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

test('fmtMil: formata números inteiros, milhares e milhões', () => {
  assert.equal(fmtMil(0), '0');
  assert.equal(fmtMil(500), '500');
  assert.equal(fmtMil(5000), '5 mil');
  assert.equal(fmtMil(40000), '40 mil');
  assert.equal(fmtMil(1000000), '1 mi');
  assert.equal(fmtMil(1500000), '1,5 mi');
});

test('duas leituras consecutivas da mesma janela (claude-5h deltaPct = 10%)', () => {
  const t1 = '2026-11-16T10:00:00.000Z';
  const t2 = '2026-11-16T11:00:00.000Z';
  const resets = '2026-11-16T15:00:00.000Z';

  const historico = [
    { time: t1, claude: { read: true, fiveHourRemaining: 0.80, fiveHourResets: resets } },
    { time: t2, claude: { read: true, fiveHourRemaining: 0.70, fiveHourResets: resets } },
  ];

  const tentativas = [
    {
      modelo: 'claude:sonnet',
      provedor: 'claude',
      grupo: 'claude',
      inicioMs: Date.parse('2026-11-16T10:15:00.000Z'),
      fimMs: Date.parse('2026-11-16T10:45:00.000Z'),
      entrada: 400000,
      saida: 50000,
      cacheLido: 0,
      cacheGravado: 0,
    },
  ];

  const resultado = estimarTokensPorCota(historico, tentativas, { tentativasApenas: true });
  const est = resultado['claude-5h'];

  assert.equal(est.disponivel, true);
  assert.equal(est.amostras, 1);
  assert.equal(est.entradaPorPct, 40000);
  assert.equal(est.saidaPorPct, 5000);
  assert.equal(est.cachePorPct, 0);
  assert.match(est.texto, /1% ≈ 40 mil tokens de entrada \/ 5 mil de saída/);
  assert.match(est.texto, /1 amostra · confiança baixa/);
});

test('três leituras consecutivas com agregação e mediana', () => {
  const t1 = '2026-11-16T10:00:00.000Z';
  const t2 = '2026-11-16T11:00:00.000Z';
  const t3 = '2026-11-16T12:00:00.000Z';
  const t4 = '2026-11-16T13:00:00.000Z';
  const resets = '2026-11-16T18:00:00.000Z';

  const historico = [
    { time: t1, claude: { read: true, fiveHourRemaining: 0.90, fiveHourResets: resets } },
    { time: t2, claude: { read: true, fiveHourRemaining: 0.80, fiveHourResets: resets } }, // delta 10%
    { time: t3, claude: { read: true, fiveHourRemaining: 0.75, fiveHourResets: resets } }, // delta 5%
    { time: t4, claude: { read: true, fiveHourRemaining: 0.67, fiveHourResets: resets } }, // delta 8%
  ];

  const tentativas = [
    // Entre t1 e t2: delta 10%, 400k ent, 50k sai -> 40k / 5k
    { grupo: 'claude', modelo: 'claude:sonnet', inicioMs: Date.parse(t1) + 1000, fimMs: Date.parse(t2) - 1000, entrada: 400000, saida: 50000, cacheLido: 0, cacheGravado: 0 },
    // Entre t2 e t3: delta 5%, 210k ent, 25k sai -> 42k / 5k
    { grupo: 'claude', modelo: 'claude:sonnet', inicioMs: Date.parse(t2) + 1000, fimMs: Date.parse(t3) - 1000, entrada: 210000, saida: 25000, cacheLido: 0, cacheGravado: 0 },
    // Entre t3 e t4: delta 8%, 312k ent, 40k sai -> 39k / 5k
    { grupo: 'claude', modelo: 'claude:sonnet', inicioMs: Date.parse(t3) + 1000, fimMs: Date.parse(t4) - 1000, entrada: 312000, saida: 40000, cacheLido: 0, cacheGravado: 0 },
  ];

  const resultado = estimarTokensPorCota(historico, tentativas, { tentativasApenas: true });
  const est = resultado['claude-5h'];

  assert.equal(est.disponivel, true);
  assert.equal(est.amostras, 3);
  assert.equal(est.entradaPorPct, 40000); // mediana de [39000, 40000, 42000]
  assert.equal(est.saidaPorPct, 5000);
  assert.equal(est.confianca, 'media');
});

test('descarte de intervalo com renovação no meio', () => {
  const t1 = '2026-11-16T10:00:00.000Z';
  const t2 = '2026-11-16T11:00:00.000Z';

  // Caso 1: restante subiu de 0.20 para 0.95
  const histSubiu = [
    { time: t1, claude: { read: true, fiveHourRemaining: 0.20, fiveHourResets: '2026-11-16T10:30:00.000Z' } },
    { time: t2, claude: { read: true, fiveHourRemaining: 0.95, fiveHourResets: '2026-11-16T15:30:00.000Z' } },
  ];
  const r1 = estimarTokensPorCota(histSubiu, [], { tentativasApenas: true })['claude-5h'];
  assert.equal(r1.disponivel, false);
  assert.equal(r1.texto, 'dados insuficientes');

  // Caso 2: horário de renovação mudou
  const histMudouResets = [
    { time: t1, claude: { read: true, fiveHourRemaining: 0.80, fiveHourResets: '2026-11-16T11:00:00.000Z' } },
    { time: t2, claude: { read: true, fiveHourRemaining: 0.70, fiveHourResets: '2026-11-16T16:00:00.000Z' } },
  ];
  const r2 = estimarTokensPorCota(histMudouResets, [
    { grupo: 'claude', modelo: 'claude:sonnet', inicioMs: Date.parse(t1), fimMs: Date.parse(t2), entrada: 100000, saida: 10000, cacheLido: 0, cacheGravado: 0 },
  ], { tentativasApenas: true })['claude-5h'];
  assert.equal(r2.disponivel, false);
  assert.equal(r2.texto, 'dados insuficientes');
});

test('descarte de intervalo com variação pequena demais (deltaPct < 1%)', () => {
  const t1 = '2026-11-16T10:00:00.000Z';
  const t2 = '2026-11-16T10:10:00.000Z';
  const resets = '2026-11-16T15:00:00.000Z';

  const historico = [
    { time: t1, claude: { read: true, fiveHourRemaining: 0.800, fiveHourResets: resets } },
    { time: t2, claude: { read: true, fiveHourRemaining: 0.795, fiveHourResets: resets } }, // delta = 0.5%
  ];

  const tentativas = [
    { grupo: 'claude', modelo: 'claude:sonnet', inicioMs: Date.parse(t1), fimMs: Date.parse(t2), entrada: 20000, saida: 2000, cacheLido: 0, cacheGravado: 0 },
  ];

  const est = estimarTokensPorCota(historico, tentativas, { tentativasApenas: true })['claude-5h'];
  assert.equal(est.disponivel, false);
  assert.equal(est.texto, 'dados insuficientes');
});

test('descarte de intervalo com uso externo suspeito (queda de 15% com 0 tokens)', () => {
  const t1 = '2026-11-16T10:00:00.000Z';
  const t2 = '2026-11-16T11:00:00.000Z';
  const resets = '2026-11-16T15:00:00.000Z';

  const historico = [
    { time: t1, claude: { read: true, fiveHourRemaining: 0.80, fiveHourResets: resets } },
    { time: t2, claude: { read: true, fiveHourRemaining: 0.65, fiveHourResets: resets } }, // delta = 15%
  ];

  // 0 tokens registrados
  const tentativas = [];

  const est = estimarTokensPorCota(historico, tentativas, { tentativasApenas: true })['claude-5h'];
  assert.equal(est.disponivel, false);
  assert.equal(est.descartadosExterno, 1);
  assert.equal(est.texto, 'dados insuficientes');
});

test('gravação, deduplicação por time e rotação de state/quota-historico.jsonl', () => {
  const t1 = '2026-11-16T10:00:00.000Z';
  const l1 = {
    time: t1,
    claude: { read: true, fiveHourRemaining: 0.8, fiveHourResets: '2026-11-16T15:00:00.000Z' },
  };

  // Primeira gravação
  const g1 = registrarHistoricoCota(dir, l1);
  assert.equal(g1, true);

  // Tentativa de gravar mesmo time (deduplicação)
  const g2 = registrarHistoricoCota(dir, l1);
  assert.equal(g2, false);

  const histAposDup = lerHistoricoCotas(dir);
  assert.equal(histAposDup.length, 1);
  assert.equal(histAposDup[0].time, t1);

  // Grava com time diferente
  const t2 = '2026-11-16T10:30:00.000Z';
  const l2 = {
    time: t2,
    claude: { read: true, fiveHourRemaining: 0.75, fiveHourResets: '2026-11-16T15:00:00.000Z' },
  };
  const g3 = registrarHistoricoCota(dir, l2);
  assert.equal(g3, true);

  const histAposNovo = lerHistoricoCotas(dir);
  assert.equal(histAposNovo.length, 2);

  // Teste de rotação: grava com maxBytes bem pequeno
  for (let i = 3; i <= 10; i++) {
    registrarHistoricoCota(dir, {
      time: `2026-11-16T10:${String(i).padStart(2, '0')}:00.000Z`,
      claude: { read: true, fiveHourRemaining: 0.7 },
    }, { maxBytes: 300, manterLinhas: 3 });
  }

  const histRotacionado = lerHistoricoCotas(dir);
  assert.equal(histRotacionado.length <= 4, true);
  assert.equal(histRotacionado.length >= 3, true);
});

test('fixture sintética Claude: transcrição JSONL com message.id repetido conta apenas uma vez', () => {
  const pastaProjetos = path.join(dir, 'claude_projects', 'proj1');
  fs.mkdirSync(pastaProjetos, { recursive: true });

  const msgId = 'msg_repetida_123';
  const timestamp = '2026-11-16T10:20:00.000Z';

  // 3 linhas no mesmo arquivo ou repetidas pelo streaming
  const linhas = [
    JSON.stringify({ type: 'assistant', timestamp, message: { id: msgId, model: 'claude-3-5-sonnet', usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }),
    JSON.stringify({ type: 'assistant', timestamp, message: { id: msgId, model: 'claude-3-5-sonnet', usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }),
    JSON.stringify({ type: 'assistant', timestamp, message: { id: msgId, model: 'claude-3-5-sonnet', usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }),
    JSON.stringify({ type: 'assistant', timestamp, message: { id: 'msg_distinta_456', model: 'claude-3-5-sonnet', usage: { input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }),
  ];

  fs.writeFileSync(path.join(pastaProjetos, 'session.jsonl'), linhas.join('\n') + '\n', 'utf8');

  const evs = lerLogsClaudeCode(path.join(dir, 'claude_projects'));
  assert.equal(evs.length, 2, 'deve conter apenas 2 mensagens distintas');

  const totalEntrada = evs.reduce((acc, e) => acc + e.entrada, 0);
  assert.equal(totalEntrada, 1500, 'não deve somar 3x a mensagem repetida');
});

test('fixture sintética Antigravity: transcrição do brain', () => {
  const sessaoDir = path.join(dir, 'brain', 'sessao-1', '.system_generated', 'logs');
  fs.mkdirSync(sessaoDir, { recursive: true });

  const linhas = [
    JSON.stringify({ source: 'USER', content: 'olá' }),
    JSON.stringify({ source: 'MODEL', created_at: '2026-11-16T10:15:00.000Z', model: 'gemini-3.8-flash-high', input_tokens: 12000, output_tokens: 1500, cache_read_tokens: 500, cache_write_tokens: 0 }),
    JSON.stringify({ source: 'MODEL', created_at: '2026-11-16T10:16:00.000Z', model: 'gemini-4-argon-high', input_tokens: 8000, output_tokens: 2000, cache_read_tokens: 0, cache_write_tokens: 0 }),
  ];

  fs.writeFileSync(path.join(sessaoDir, 'transcript_full.jsonl'), linhas.join('\n') + '\n', 'utf8');

  const evs = lerLogsAntigravityBrain(path.join(dir, 'brain'));
  assert.equal(evs.length, 2);
  assert.equal(evs[0].grupo, 'gemini');
  assert.equal(evs[0].entrada, 12000);
  assert.equal(evs[1].grupo, 'argon');
  assert.equal(evs[1].entrada, 8000);
});

test('janela zerada recebe peso maior na média ponderada', () => {
  const t1 = '2026-11-16T10:00:00.000Z';
  const t2 = '2026-11-16T11:00:00.000Z';
  const t3 = '2026-11-16T12:00:00.000Z';
  const resets = '2026-11-16T15:00:00.000Z';

  const historico = [
    { time: t1, claude: { read: true, fiveHourRemaining: 0.95, fiveHourResets: resets } },
    { time: t2, claude: { read: true, fiveHourRemaining: 0.85, fiveHourResets: resets } }, // delta 10%, restante 85% -> peso 1
    { time: t3, claude: { read: true, fiveHourRemaining: 0.01, fiveHourResets: resets } }, // delta 84%, restante 1% -> ZEROU, peso maior
  ];

  const tentativas = [
    { grupo: 'claude', modelo: 'claude:sonnet', inicioMs: Date.parse(t1) + 1000, fimMs: Date.parse(t2) - 1000, entrada: 100000, saida: 10000, cacheLido: 0, cacheGravado: 0 },
    { grupo: 'claude', modelo: 'claude:sonnet', inicioMs: Date.parse(t2) + 1000, fimMs: Date.parse(t3) - 1000, entrada: 840000, saida: 84000, cacheLido: 0, cacheGravado: 0 },
  ];

  const est = estimarTokensPorCota(historico, tentativas, { tentativasApenas: true })['claude-5h'];
  assert.equal(est.disponivel, true);
  assert.equal(est.janelasCompletas >= 1, true);
});

test('relação da cota semanal a partir da janela de 5h', () => {
  const t1 = '2026-11-16T10:00:00.000Z';
  const t2 = '2026-11-16T11:00:00.000Z';
  const r5h = '2026-11-16T15:00:00.000Z';
  const rSem = '2026-11-23T10:00:00.000Z';

  const historico = [
    {
      time: t1,
      claude: {
        read: true,
        fiveHourRemaining: 0.90,
        fiveHourResets: r5h,
        sevenDayRemaining: 0.98,
        sevenDayResets: rSem,
      },
    },
    {
      time: t2,
      claude: {
        read: true,
        fiveHourRemaining: 0.80,
        fiveHourResets: r5h,
        sevenDayRemaining: 0.96,
        sevenDayResets: rSem,
      },
    },
  ];

  const tentativas = [
    { grupo: 'claude', modelo: 'claude:sonnet', inicioMs: Date.parse(t1) + 1000, fimMs: Date.parse(t2) - 1000, entrada: 200000, saida: 20000, cacheLido: 0, cacheGravado: 0 },
  ];

  const res = estimarTokensPorCota(historico, tentativas, { tentativasApenas: true });
  assert.equal(res['claude-5h'].disponivel, true);
  assert.equal(res['claude-semanal'].disponivel, true);
  assert.equal(Boolean(res['claude-semanal'].relacao5h), true);
  assert.match(res['claude-semanal'].relacao5h.textoRelacao, /100% de 5 h ≈/);
});

test('coletarTentativasUso extrai tarefas e tentativas do projeto', () => {
  const proj = {
    id: 'p1',
    uso: {
      tarefas: [
        {
          id: 't1',
          tentativas: [
            { modelo: 'sonnet', provedor: 'claude', inicio: '2026-11-16T10:00:00Z', fim: '2026-11-16T10:30:00Z', entrada: 5000, saida: 500, cacheLido: 100, cacheGravado: 0 },
          ],
        },
      ],
    },
  };

  const lista = coletarTentativasUso([proj]);
  assert.equal(lista.length, 1);
  assert.equal(lista[0].modelo, 'claude:sonnet');
  assert.equal(lista[0].grupo, 'claude');
  assert.equal(lista[0].entrada, 5000);
});

test('input_tokens minúsculo com cache lido alto não distorce entradaPorPct para 8 tokens', () => {
  const t1 = '2026-11-16T10:00:00.000Z';
  const t2 = '2026-11-16T11:00:00.000Z';
  const resets = '2026-11-16T15:00:00.000Z';

  const historico = [
    { time: t1, claude: { read: true, fiveHourRemaining: 0.90, fiveHourResets: resets } },
    { time: t2, claude: { read: true, fiveHourRemaining: 0.80, fiveHourResets: resets } },
  ];

  const tentativas = [
    {
      grupo: 'claude',
      modelo: 'claude:claude-sonnet-5-5',
      inicioMs: Date.parse('2026-11-16T10:10:00.000Z'),
      fimMs: Date.parse('2026-11-16T10:50:00.000Z'),
      entrada: 80,
      saida: 20000,
      cacheLido: 300000,
      cacheGravado: 0,
    },
  ];

  const est = estimarTokensPorCota(historico, tentativas, { tentativasApenas: true })['claude-5h'];
  assert.equal(est.disponivel, true);
  assert.equal(est.saidaPorPct, 2000);
  assert.equal(est.entradaPorPct > est.saidaPorPct, true, 'entradaPorPct deve ser maior que saidaPorPct');
  assert.equal(est.entradaPorPct >= 10000, true, 'entradaPorPct deve refletir peso ~5x-10x da saída + cache');
  assert.equal(est.usdPorPct > 0, true);
  assert.equal(est.entradaEquivalentePorPct > est.saidaEquivalentePorPct, true);
});

test('trabalhos paralelos na mesma janela são somados e rateados proporcionalmente', () => {
  const t1 = '2026-11-16T10:00:00.000Z';
  const t2 = '2026-11-16T11:00:00.000Z';
  const resets = '2026-11-16T15:00:00.000Z';

  const historico = [
    { time: t1, claude: { read: true, fiveHourRemaining: 0.80, fiveHourResets: resets } },
    { time: t2, claude: { read: true, fiveHourRemaining: 0.60, fiveHourResets: resets } },
  ];

  const tentativas = [
    {
      grupo: 'claude',
      modelo: 'claude:sonnet',
      inicioMs: Date.parse('2026-11-16T10:05:00.000Z'),
      fimMs: Date.parse('2026-11-16T10:45:00.000Z'),
      entrada: 400000,
      saida: 40000,
      cacheLido: 0,
      cacheGravado: 0,
    },
    {
      grupo: 'claude',
      modelo: 'claude:sonnet',
      inicioMs: Date.parse('2026-11-16T10:10:00.000Z'),
      fimMs: Date.parse('2026-11-16T10:50:00.000Z'),
      entrada: 400000,
      saida: 40000,
      cacheLido: 0,
      cacheGravado: 0,
    },
  ];

  const pontos = [
    { tMs: Date.parse(t1), restante: 0.80, renovaMs: Date.parse(resets) },
    { tMs: Date.parse(t2), restante: 0.60, renovaMs: Date.parse(resets) },
  ];
  const analise = analisarTrabalhosComParalelos(pontos, tentativas, null, { grupo: 'claude' });
  assert.equal(analise.trabalhosAnalisados, 2);
  assert.equal(analise.paralelosDetectados, 2);
  assert.equal(Math.round(analise.amostrasTrabalhos[0].deltaPct), 10);
  assert.equal(Math.round(analise.amostrasTrabalhos[1].deltaPct), 10);

  const est = estimarTokensPorCota(historico, tentativas, { tentativasApenas: true })['claude-5h'];
  assert.equal(est.disponivel, true);
  assert.equal(est.trabalhosAnalisados, 2);
  assert.equal(est.paralelosDetectados, 2);
  assert.equal(est.entradaPorPct, 40000);
  assert.equal(est.saidaPorPct, 4000);
});

test('detalhamento por submodelo unifica chaves canônicas sem duplicatas', () => {
  assert.equal(normalizarSubmodelo('claude:claude-sonnet-5-5', 'claude'), 'claude:sonnet');
  assert.equal(normalizarSubmodelo('claude:sonnet@high', 'claude'), 'claude:sonnet');
  assert.equal(normalizarSubmodelo('agy:gemini-3.8-flash-high', 'gemini'), 'agy:gemini-3.8-flash');
  assert.equal(normalizarSubmodelo('agy:gemini-4-argon-low', 'argon'), 'agy:gemini-4-argon');

  const t1 = '2026-11-16T10:00:00.000Z';
  const t2 = '2026-11-16T11:00:00.000Z';
  const resets = '2026-11-16T15:00:00.000Z';

  const historico = [
    {
      time: t1,
      claude: { read: true, fiveHourRemaining: 0.90, fiveHourResets: resets },
      gemini: { read: true, fiveHourRemaining: 0.90, fiveHourResets: resets },
    },
    {
      time: t2,
      claude: { read: true, fiveHourRemaining: 0.80, fiveHourResets: resets },
      gemini: { read: true, fiveHourRemaining: 0.80, fiveHourResets: resets },
    },
  ];

  const tentativas = [
    {
      grupo: 'claude',
      modelo: 'claude:claude-sonnet-5-5',
      inicioMs: Date.parse('2026-11-16T10:10:00.000Z'),
      fimMs: Date.parse('2026-11-16T10:30:00.000Z'),
      entrada: 200000,
      saida: 25000,
      cacheLido: 0,
      cacheGravado: 0,
    },
    {
      grupo: 'claude',
      modelo: 'claude:sonnet@high',
      inicioMs: Date.parse('2026-11-16T10:35:00.000Z'),
      fimMs: Date.parse('2026-11-16T10:50:00.000Z'),
      entrada: 200000,
      saida: 25000,
      cacheLido: 0,
      cacheGravado: 0,
    },
    {
      grupo: 'gemini',
      modelo: 'agy:gemini-3.8-flash-high',
      inicioMs: Date.parse('2026-11-16T10:15:00.000Z'),
      fimMs: Date.parse('2026-11-16T10:45:00.000Z'),
      entrada: 500000,
      saida: 50000,
      cacheLido: 0,
      cacheGravado: 0,
    },
  ];

  const res = estimarTokensPorCota(historico, tentativas, { tentativasApenas: true });
  const claude = res['claude-5h'];
  assert.equal(Boolean(claude.porModelo['claude:sonnet']), true);
  assert.equal(Boolean(claude.porModelo['claude:haiku']), true);
  assert.equal(Boolean(claude.porModelo['claude:opus']), true);
  assert.equal(claude.porModelo['claude:claude-sonnet-5-5'], undefined);
  assert.equal(claude.porModelo['claude:sonnet@high'], undefined);
  assert.equal(Array.isArray(claude.submodelos), true);

  const gemini = res['gemini-5h'];
  assert.equal(Boolean(gemini.porModelo['agy:gemini-3.8-flash']), true);
  assert.equal(Boolean(gemini.porModelo['agy:gemini-4-hydrogen']), true);
  assert.equal(gemini.porModelo['agy:gemini-3.8-flash-high'], undefined);
});
