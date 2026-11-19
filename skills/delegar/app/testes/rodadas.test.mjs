// Testes de rodadas.mjs: arquivamento, contexto, migração e soma de uso com fixtures isoladas.
// Nada é gravado fora de os.tmpdir(); fixtures reais são copiadas em modo somente leitura.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  temRodadaExecutada,
  limparLogsRaiz,
  moverLogsParaRodada,
  dadosUsoDaRodada,
  dadosUsoProjetoComRodadas,
  arquivarRodada,
  contextoRodadasParaPlanejador,
  migrarRodadas,
} from '../rodadas.mjs';

const TABELA = {
  versao: 1,
  atualizado: '2026-11-01',
  fonte: 'teste',
  usdBrl: 5,
  modelos: {
    haiku: { entrada: 1, saida: 5, cacheLido: 0.1, cacheGravado: 1.25 },
    sonnet: { entrada: 3, saida: 15, cacheLido: 0.3, cacheGravado: 3.75 },
    opus: { entrada: 15, saida: 75, cacheLido: 1.5, cacheGravado: 18.75 },
  },
  aliases: {},
  gratuitos: [],
};

let RAIZ;
before(() => {
  RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'rodadas-test-'));
});
after(() => {
  try { fs.rmSync(RAIZ, { recursive: true, force: true }); } catch {}
});

const novoProjDir = (nome) => {
  const projDir = path.join(RAIZ, nome);
  fs.mkdirSync(path.join(projDir, 'logs'), { recursive: true });
  return projDir;
};

const gravar = (arquivo, conteudo) => {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  fs.writeFileSync(arquivo, typeof conteudo === 'string' ? conteudo : JSON.stringify(conteudo, null, 2), 'utf8');
};

const usoTent = (custoCliUsd) => ({
  modelo: 'claude:haiku',
  entrada: 100,
  saida: 50,
  cacheLido: 10,
  cacheGravado: 5,
  fonte: 'cli',
  custoCliUsd,
  porModelo: [
    { provedor: 'claude', modelo: 'haiku', entrada: 100, saida: 50, cacheLido: 10, cacheGravado: 5, custoCliUsd },
  ],
});

const jsonl = (custo, entrada = 100, saida = 50) =>
  `${JSON.stringify({ type: 'step_finish', part: { tokens: { input: entrada, output: saida, cache: { read: 10, write: 5 } }, cost: custo } })}\n`;

test('1. temRodadaExecutada, limparLogsRaiz e moverLogsParaRodada', () => {
  assert.equal(temRodadaExecutada(null, null), false);
  assert.equal(temRodadaExecutada({ plano: { tarefas: [] } }, null), false);
  assert.equal(temRodadaExecutada({ plano: { tarefas: [{ id: 'w1' }] }, inicio: 12345 }, null), true);

  const projDir = novoProjDir('tem-rodada-fs');
  assert.equal(temRodadaExecutada({ plano: { tarefas: [{ id: 'w1' }] } }, projDir), false);
  gravar(path.join(projDir, 'logs', 'status.json'), {});
  assert.equal(temRodadaExecutada({ plano: { tarefas: [{ id: 'w1' }] } }, projDir), true);

  // limparLogsRaiz: remove arquivos e subpastas exceto rodada-\d+
  const logsLimpar = path.join(RAIZ, 'limpar-logs');
  gravar(path.join(logsLimpar, 'status.json'), {});
  gravar(path.join(logsLimpar, 'temp.log'), 'log');
  gravar(path.join(logsLimpar, 'w1', 'result.json'), {});
  gravar(path.join(logsLimpar, 'rodada-1', 'status.json'), {});
  gravar(path.join(logsLimpar, 'rodada-2', 'status.json'), {});

  const removidos = limparLogsRaiz(logsLimpar);
  assert.equal(removidos, 3);
  assert.equal(fs.existsSync(path.join(logsLimpar, 'status.json')), false);
  assert.equal(fs.existsSync(path.join(logsLimpar, 'temp.log')), false);
  assert.equal(fs.existsSync(path.join(logsLimpar, 'w1')), false);
  assert.equal(fs.existsSync(path.join(logsLimpar, 'rodada-1', 'status.json')), true);
  assert.equal(fs.existsSync(path.join(logsLimpar, 'rodada-2', 'status.json')), true);

  // moverLogsParaRodada
  const projDir2 = novoProjDir('mover-logs-teste');
  gravar(path.join(projDir2, 'logs', 'status.json'), { w1: 'done' });
  gravar(path.join(projDir2, 'logs', 'summary.md'), '# Resumo');
  gravar(path.join(projDir2, 'plan.json'), { name: 'plano1' });
  gravar(path.join(projDir2, 'prompts', 'p1.txt'), 'prompt');
  gravar(path.join(projDir2, 'logs', 'rodada-9', 'marcador'), 'fica');

  const rel = moverLogsParaRodada(projDir2, 1);
  assert.equal(rel, 'logs/rodada-1');
  assert.equal(fs.existsSync(path.join(projDir2, 'logs', 'rodada-1', 'status.json')), true);
  assert.equal(fs.existsSync(path.join(projDir2, 'logs', 'rodada-1', 'summary.md')), true);
  assert.equal(fs.existsSync(path.join(projDir2, 'logs', 'rodada-1', 'plan.json')), true);
  assert.equal(fs.existsSync(path.join(projDir2, 'logs', 'rodada-1', 'prompts', 'p1.txt')), true);
  assert.equal(fs.existsSync(path.join(projDir2, 'plan.json')), true);
  assert.equal(fs.existsSync(path.join(projDir2, 'logs', 'status.json')), false);
  assert.equal(fs.existsSync(path.join(projDir2, 'logs', 'rodada-9', 'marcador')), true);
});

test('2. arquivarRodada arquiva rodada 1, move logs, gera contexto e limpa campos ativos', () => {
  const projDir = novoProjDir('arquivo-r1');
  const p = {
    id: 'proj-arq',
    titulo: 'Projeto Arquivar',
    estado: 'executando',
    modo: 'padrao',
    inicio: 1000,
    fim: 2000,
    resumoFinal: 'Entrega finalizada com sucesso. Commit abc1234.',
    statusHash: 'hash-abc',
    pid: 9999,
    retomadasAuto: 3,
    contextoRodadaPendente: false,
    uso: {
      chamadas: [
        {
          modelo: 'claude:haiku',
          entrada: 100,
          saida: 50,
          cacheLido: 0,
          cacheGravado: 0,
          fonte: 'cli',
          custoCliUsd: 0.01,
          porModelo: [{ provedor: 'claude', modelo: 'haiku', entrada: 100, saida: 50, cacheLido: 0, cacheGravado: 0, custoCliUsd: 0.01 }],
        },
      ],
    },
    plano: {
      titulo: 'Plano Rodada 1',
      tarefas: [{ id: 'w1', titulo: 'Tarefa 1', chain: ['claude:haiku'], after: [], prompt: 'p1' }],
    },
  };

  gravar(path.join(projDir, 'logs', 'status.json'), { w1: { state: 'done' } });
  gravar(path.join(projDir, 'logs', 'summary.md'), '# Execução\n\nRESULTADO: CONCLUIDO\n');
  gravar(path.join(projDir, 'logs', 'w1', 'result.json'), {
    ok: true,
    attempts: [
      {
        worker: 'claude:haiku',
        out: path.join(projDir, 'logs', 'w1', '1-haiku.out.log'),
        uso: usoTent(0.005),
      },
    ],
  });

  const r1 = arquivarRodada(p, {
    projDir,
    tabela: TABELA,
    chainFor: (pp, t) => t.chain || [],
    nomeModo: (pp) => `Modo ${pp.modo}`,
    velDe: () => 'auto',
    supDe: () => 'automatico',
    resumoFinal: (pp) => pp.resumoFinal,
  });

  assert.ok(r1);
  assert.equal(r1.numero, 1);
  assert.equal(r1.titulo, 'Plano Rodada 1');
  assert.equal(r1.estado, 'concluido');
  assert.equal(r1.modoNome, 'Modo padrao');
  assert.equal(r1.velocidade, 'auto');
  assert.equal(r1.supervisao, 'automatico');
  assert.equal(r1.inicio, 1000);
  assert.equal(r1.fim, 2000);
  assert.equal(r1.logDir, 'logs/rodada-1');
  assert.equal(r1.resumoFinal, 'Entrega finalizada com sucesso. Commit abc1234.');
  assert.deepEqual(r1.plano.tarefas[0].cadeiaEfetiva, ['claude:haiku']);

  // Verifica que arquivos foram movidos para logs/rodada-1
  assert.equal(fs.existsSync(path.join(projDir, 'logs', 'rodada-1', 'status.json')), true);
  assert.equal(fs.existsSync(path.join(projDir, 'logs', 'rodada-1', 'summary.md')), true);
  assert.equal(fs.existsSync(path.join(projDir, 'logs', 'rodada-1', 'w1', 'result.json')), true);
  assert.equal(fs.existsSync(path.join(projDir, 'logs', 'status.json')), false);

  // Limpeza dos campos ativos em p
  assert.equal(p.plano, null);
  assert.equal(p.inicio, null);
  assert.equal(p.fim, null);
  assert.equal(p.resumoFinal, null);
  assert.equal(p.statusHash, null);
  assert.equal(p.pid, null);
  assert.equal(p.retomadasAuto, 0);
  assert.deepEqual(p.uso, { chamadas: [] });
  assert.ok(p.contextoRodadaPendente.includes('Rodada 1'));

  // Teste de contextoRodadasParaPlanejador
  const ctx = contextoRodadasParaPlanejador(p);
  assert.ok(ctx.includes('Rodada 1: Plano Rodada 1'));
  assert.ok(ctx.includes('w1 (Tarefa 1): concluída'));
  assert.ok(ctx.includes('Entrega finalizada com sucesso. Commit abc1234.'));
  assert.ok(ctx.endsWith('As rodadas acima já foram executadas no repositório. Planeje apenas o que falta para atender à nova mensagem do usuário, sem refazer o que já foi entregue.'));
});

test('3. Executar rodada 2 com ids de tarefa repetidos (w1, i1) sem colisão e somar uso com dadosUsoProjetoComRodadas', () => {
  const projDir = novoProjDir('rodada2-colisao');
  const p = {
    id: 'proj-colisao',
    titulo: 'Projeto Duas Rodadas',
    estado: 'executando',
    modo: 'padrao',
    inicio: 1000,
    fim: 2000,
    uso: {
      chamadas: [
        {
          modelo: 'claude:haiku',
          entrada: 100,
          saida: 50,
          fonte: 'cli',
          custoCliUsd: 0.01,
          porModelo: [{ provedor: 'claude', modelo: 'haiku', entrada: 100, saida: 50, custoCliUsd: 0.01 }],
        },
      ],
    },
    plano: {
      titulo: 'Rodada 1',
      tarefas: [
        { id: 'w1', titulo: 'Escritor R1', chain: ['claude:haiku'], after: [], prompt: 'p1' },
        { id: 'i1', titulo: 'Integrador R1', chain: ['claude:haiku'], after: ['w1'], prompt: 'p2' },
      ],
    },
  };

  // Cria logs da Rodada 1
  gravar(path.join(projDir, 'logs', 'status.json'), { w1: { state: 'done' }, i1: { state: 'done' } });
  gravar(path.join(projDir, 'logs', 'summary.md'), '# R1\n\nRESULTADO: CONCLUIDO\n');
  gravar(path.join(projDir, 'logs', 'w1', 'result.json'), {
    ok: true,
    attempts: [
      {
        worker: 'claude:haiku',
        out: path.join(projDir, 'logs', 'w1', '1-haiku.out.log'),
        uso: usoTent(0.01),
      },
    ],
  });
  gravar(path.join(projDir, 'logs', 'i1', 'result.json'), {
    ok: true,
    attempts: [
      {
        worker: 'claude:haiku',
        out: path.join(projDir, 'logs', 'i1', '1-haiku.out.log'),
        uso: usoTent(0.015),
      },
    ],
  });

  // Arquiva a Rodada 1 -> logs vão para logs/rodada-1/
  const r1 = arquivarRodada(p, { projDir, tabela: TABELA });
  assert.ok(r1);
  assert.equal(r1.numero, 1);
  assert.equal(r1.uso.total.usd, 0.035); // 0.01 (plan) + 0.01 (w1) + 0.015 (i1)

  // Agora inicia Rodada 2 com os MESMOS ids de tarefa ('w1', 'i1')
  p.estado = 'executando';
  p.inicio = 3000;
  p.fim = null;
  p.plano = {
    titulo: 'Rodada 2',
    tarefas: [
      { id: 'w1', titulo: 'Escritor R2', chain: ['claude:haiku'], after: [], prompt: 'p1-r2' },
      { id: 'i1', titulo: 'Integrador R2', chain: ['claude:haiku'], after: ['w1'], prompt: 'p2-r2' },
    ],
  };
  p.uso = {
    chamadas: [
      {
        modelo: 'claude:haiku',
        entrada: 200,
        saida: 100,
        fonte: 'cli',
        custoCliUsd: 0.02,
        porModelo: [{ provedor: 'claude', modelo: 'haiku', entrada: 200, saida: 100, custoCliUsd: 0.02 }],
      },
    ],
  };

  // Cria logs da Rodada 2 na raiz de logs/ com custos diferentes
  gravar(path.join(projDir, 'logs', 'status.json'), { w1: { state: 'done' }, i1: { state: 'done' } });
  gravar(path.join(projDir, 'logs', 'w1', 'result.json'), {
    ok: true,
    attempts: [
      {
        worker: 'claude:haiku',
        out: path.join(projDir, 'logs', 'w1', '1-haiku.out.log'),
        uso: usoTent(0.02),
      },
    ],
  });
  gravar(path.join(projDir, 'logs', 'i1', 'result.json'), {
    ok: true,
    attempts: [
      {
        worker: 'claude:haiku',
        out: path.join(projDir, 'logs', 'i1', '1-haiku.out.log'),
        uso: usoTent(0.03),
      },
    ],
  });

  const usoGeral = dadosUsoProjetoComRodadas(p, { projDir, tabela: TABELA });
  assert.equal(usoGeral.emAndamento, true);
  assert.equal(usoGeral.rodadas.length, 2);

  // Rodada 1 calculada a partir de logs/rodada-1/ sem interferência de logs/
  const r1Uso = usoGeral.rodadas[0];
  assert.equal(r1Uso.numero, 1);
  assert.equal(r1Uso.total.usd, 0.035);
  const w1R1 = r1Uso.tarefas.find((t) => t.id === 'w1');
  assert.equal(w1R1.total.usd, 0.01);
  assert.equal(w1R1.tentativas.length, 1);

  // Rodada 2 calculada a partir de logs/
  const r2Uso = usoGeral.rodadas[1];
  assert.equal(r2Uso.numero, 2);
  assert.equal(r2Uso.total.usd, 0.07); // 0.02 (plan) + 0.02 (w1) + 0.03 (i1)
  const w1R2 = r2Uso.tarefas.find((t) => t.id === 'w1');
  assert.equal(w1R2.total.usd, 0.02);
  assert.equal(w1R2.tentativas.length, 1);

  // Ausência de colisão no topo: tarefas concatenadas trazem o rodada correspondente
  const topoW1R1 = usoGeral.tarefas.find((t) => t.id === 'w1' && t.rodada === 1);
  const topoW1R2 = usoGeral.tarefas.find((t) => t.id === 'w1' && t.rodada === 2);
  assert.equal(topoW1R1.total.usd, 0.01);
  assert.equal(topoW1R2.total.usd, 0.02);

  // Total somado do projeto: 0.035 + 0.07 = 0.105
  assert.equal(usoGeral.total.usd, 0.105);
  assert.equal(usoGeral.total.brl, 0.105 * 5);
});

test('4. migrarRodadas: project.json com plano divergente, executando só em memória, concluído grava no disco', () => {
  const FIM_R1 = 1700000000000;
  const fixtureMigracao = (projDir) => {
    // Cenário onde project.json já tinha o plano da rodada 2 (4 tarefas: t1, t2, t3, t4),
    // mas plan.json e logs pertencem à rodada 1 (1 tarefa: w1)
    gravar(path.join(projDir, 'rodadas', '1', 'project.json'), {
      id: 'proj-migra',
      estado: 'concluido',
      fim: new Date(FIM_R1).toISOString(),
      titulo: 'Projeto Antigo',
      plano: {
        tarefas: [
          { id: 't1', titulo: 'Nova T1' },
          { id: 't2', titulo: 'Nova T2' },
          { id: 't3', titulo: 'Nova T3' },
          { id: 't4', titulo: 'Nova T4' },
        ],
      },
      uso: {
        chamadas: [
          {
            quando: new Date(FIM_R1 - 5000).toISOString(),
            modelo: 'claude:haiku',
            entrada: 200,
            saida: 100,
            fonte: 'estimado',
            porModelo: [{ provedor: 'claude', modelo: 'haiku', entrada: 200, saida: 100 }],
          },
          {
            quando: new Date(FIM_R1 + 120000).toISOString(), // > fim + 60s -> pertence à rodada 2
            modelo: 'claude:haiku',
            entrada: 50,
            saida: 50,
            fonte: 'estimado',
            porModelo: [{ provedor: 'claude', modelo: 'haiku', entrada: 50, saida: 50 }],
          },
        ],
      },
      mensagens: [
        {
          papel: 'planejador',
          texto: 'Título da Rodada 1\nDetalhes do planejamento da rodada 1',
          quando: new Date(FIM_R1 - 10000).toISOString(),
        },
      ],
    });

    gravar(path.join(projDir, 'rodadas', '1', 'plan.json'), {
      name: 'plano-r1',
      tasks: [
        {
          id: 'w1',
          titulo: 'Tarefa Antiga Real',
          worktree: true,
          chain: ['claude:sonnet'],
          after: [],
          confirm: false,
          reason: 'motivo antigo',
        },
      ],
      verify: ['npm test'],
      maxConcurrent: 1,
    });

    gravar(path.join(projDir, 'rodadas', '1', 'logs', 'summary.md'), '# Resumo R1\n\nRESULTADO: CONCLUIDO\n');
    gravar(path.join(projDir, 'rodadas', '1', 'logs', 'w1.prompt.md'), 'Implementar funcionalidade base.\n\n(Projeto Delegar: proj-migra)\n');
    gravar(path.join(projDir, 'rodadas', '1', 'logs', 'status.json'), { w1: { state: 'done' } });
    gravar(path.join(projDir, 'rodadas', '1', 'logs', 'w1', 'result.json'), {
      ok: true,
      attempts: [
        {
          worker: 'claude:sonnet',
          uso: {
            modelo: 'claude:sonnet',
            entrada: 1000,
            saida: 500,
            cacheLido: 0,
            cacheGravado: 0,
            fonte: 'cli',
            custoCliUsd: 0.01,
            porModelo: [{ provedor: 'claude', modelo: 'sonnet', entrada: 1000, saida: 500, custoCliUsd: 0.01 }],
          },
        },
      ],
    });
  };

  // Teste A: estado 'executando' -> só altera em memória, NADA gravado no disco
  const projDirA = novoProjDir('migra-executando');
  fixtureMigracao(projDirA);
  const pA = { id: 'proj-a', estado: 'executando', uso: { chamadas: [] } };

  const resA = migrarRodadas(pA, { projDir: projDirA, tabela: TABELA, gravar: true });
  assert.equal(resA.migrado, true);
  assert.equal(resA.gravado, false);
  assert.equal(resA.motivo, 'execução em andamento');
  assert.equal(pA.rodadas.length, 1);

  // Rodada 1 foi reconstruída a partir de plan.json (1 tarefa: w1, não as 4 de project.json)
  const rA = pA.rodadas[0];
  assert.equal(rA.numero, 1);
  assert.equal(rA.titulo, 'Projeto Antigo'); // título do projeto, não a primeira fala do planejador
  assert.equal(rA.plano.tarefas.length, 1);
  assert.equal(rA.plano.tarefas[0].id, 'w1');
  assert.equal(rA.plano.tarefas[0].tipo, 'escritor');
  assert.equal(rA.plano.tarefas[0].prompt, 'Implementar funcionalidade base.'); // sem o rodapé
  assert.deepEqual(rA.plano.tarefas[0].cadeiaEfetiva, ['claude:sonnet']);

  // Chamada posterior a fim + 60s ficou fora da rodada e permaneceu em p.uso.chamadas
  assert.equal(rA.chamadas.length, 1);
  assert.equal(pA.uso.chamadas.length, 1);
  assert.equal(pA.uso.chamadas[0].entrada, 50);

  // Nada gravado no disco
  assert.equal(fs.existsSync(path.join(projDirA, 'project.json')), false);
  assert.equal(fs.existsSync(path.join(projDirA, 'logs', 'rodada-1')), false);
  assert.equal(rA.logDir, 'rodadas/1/logs');

  // Teste B: estado 'concluido' -> grava logs/rodada-1 e project.json, mantém rodadas/1 intacta
  const projDirB = novoProjDir('migra-concluido');
  fixtureMigracao(projDirB);
  const pB = { id: 'proj-b', estado: 'concluido', uso: { chamadas: [] } };

  const resB = migrarRodadas(pB, { projDir: projDirB, tabela: TABELA, gravar: true });
  assert.equal(resB.migrado, true);
  assert.equal(resB.gravado, true);
  assert.equal(fs.existsSync(path.join(projDirB, 'logs', 'rodada-1', 'status.json')), true);
  assert.equal(fs.existsSync(path.join(projDirB, 'logs', 'rodada-1', 'plan.json')), true);
  assert.equal(fs.existsSync(path.join(projDirB, 'project.json')), true);
  assert.equal(fs.existsSync(path.join(projDirB, 'rodadas', '1', 'plan.json')), true); // intacto

  // Segunda chamada não regrava
  const deNovo = migrarRodadas(pB, { projDir: projDirB, tabela: TABELA });
  assert.equal(deNovo.migrado, false);
});

test('5. Fixture real: migra a rodada 1 do painel local (se existir na máquina)', (t) => {
  const origem = path.join(
    os.homedir(),
    '.delegar',
    'projects',
    '202611161012-painel-local-login-acesso-so-local-pan-cd2f',
    'rodadas',
    '1',
  );
  if (!fs.existsSync(path.join(origem, 'project.json'))) {
    return t.skip('fixture real do painel local não disponível no PC');
  }

  const projDir = novoProjDir('fixture-real-local');
  // Copia APENAS para a pasta temporária de teste (SÓ LEITURA na origem!)
  fs.cpSync(origem, path.join(projDir, 'rodadas', '1'), { recursive: true });

  const p = { id: 'fixture-local', estado: 'concluido', uso: { chamadas: [] } };
  const res = migrarRodadas(p, { projDir });
  assert.equal(res.migrado, true);

  const r = p.rodadas[0];
  assert.equal(r.numero, 1);
  // Valida que reconstrói as 9 tarefas da rodada 1
  assert.equal(r.plano.tarefas.length, 9);
  // Valida custo em torno de US$ 6,83 (6.8303)
  assert.ok(Math.abs(r.uso.total.usd - 6.8303) < 0.02, `esperado ~6.8303, obtido ${r.uso.total.usd}`);
});

test('6. Tentativas puladas (skipped, 0 tokens) não geram modelos zerados', () => {
  const projDir = novoProjDir('skipped-zero');
  const p = {
    id: 'proj-skipped',
    estado: 'concluido',
    inicio: 1000,
    fim: 2000,
    plano: {
      titulo: 'Teste skipped',
      tarefas: [{ id: 'w1', titulo: 'W1', chain: ['claude:sonnet', 'claude:haiku'], after: [], prompt: 'p1' }],
    },
    uso: { chamadas: [] },
  };
  gravar(path.join(projDir, 'logs', 'status.json'), { w1: { state: 'done' } });
  gravar(path.join(projDir, 'logs', 'w1', 'result.json'), {
    ok: true,
    attempts: [
      { worker: 'claude:sonnet', skipped: true, reason: 'cota' },
      {
        worker: 'claude:haiku',
        uso: {
          fonte: 'cli',
          entrada: 100,
          saida: 50,
          cacheLido: 0,
          cacheGravado: 0,
          custoCliUsd: 0.01,
          porModelo: [{ provedor: 'claude', modelo: 'claude-haiku-5-5', entrada: 100, saida: 50, custoCliUsd: 0.01 }],
        },
      },
    ],
  });

  const dados = dadosUsoProjetoComRodadas(p, { projDir, tabela: TABELA });
  assert.equal(dados.modelos.length, 1);
  assert.equal(dados.modelos[0].provedor, 'claude');
  assert.equal(dados.modelos[0].modelo, 'claude-haiku-5-5');
  assert.equal(dados.modelos[0].entrada, 100);
});

test('7. dadosUsoProjetoComRodadas unifica apelido (sonnet) e nome canônico (claude-sonnet-5-5)', () => {
  const projDir = novoProjDir('unifica-sonnet');
  const p = {
    id: 'proj-unifica',
    estado: 'concluido',
    inicio: 1000,
    fim: 2000,
    plano: {
      titulo: 'Teste unifica',
      tarefas: [{ id: 'w1', titulo: 'W1', chain: ['claude:sonnet'], after: [], prompt: 'p1' }],
    },
    uso: {
      chamadas: [
        {
          modelo: 'claude:sonnet',
          entrada: 200,
          saida: 50,
          fonte: 'cli',
          custoCliUsd: 0.02,
          porModelo: [{ provedor: 'claude', modelo: 'sonnet', entrada: 200, saida: 50, custoCliUsd: 0.02 }],
        },
      ],
    },
  };
  gravar(path.join(projDir, 'logs', 'status.json'), { w1: { state: 'done' } });
  gravar(path.join(projDir, 'logs', 'w1', 'result.json'), {
    ok: true,
    attempts: [
      {
        worker: 'claude:sonnet',
        uso: {
          fonte: 'cli',
          entrada: 300,
          saida: 100,
          cacheLido: 0,
          cacheGravado: 0,
          custoCliUsd: 0.03,
          porModelo: [{ provedor: 'claude', modelo: 'claude-sonnet-5-5', entrada: 300, saida: 100, custoCliUsd: 0.03 }],
        },
      },
    ],
  });

  const dados = dadosUsoProjetoComRodadas(p, { projDir, tabela: TABELA });
  assert.equal(dados.modelos.length, 1);
  assert.equal(dados.modelos[0].provedor, 'claude');
  assert.equal(dados.modelos[0].modelo, 'claude-sonnet-5-5');
  assert.equal(dados.modelos[0].entrada, 500);
  assert.equal(dados.modelos[0].saida, 150);
  assert.equal(dados.modelos[0].usd, 0.05);
});
