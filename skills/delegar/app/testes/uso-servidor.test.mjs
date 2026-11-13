// Testes do servidor para uso de tokens (/api/uso, /api/projetos/:id/uso) e preços (/api/precos).
// Sobe um servidor isolado com projeto falso, fixtures de logs e servidor HTTP falso para preços.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
const FIXTURES = path.join(HERE, 'fixtures');

let raiz, DATA, VAULT, REPO, TOKEN, filho, saida = '', PORT, fakeLiteLLM, LITELLM_PORT;

const PROJ_HOJE = '202611131200-proj-hoje-a1b2';
const PROJ_15D = '202610291200-proj-15d-c3d4';
const PROJ_45D = '202609251200-proj-45d-e5f6';

function req(method, urlPath, { body, token = TOKEN, host, raw } = {}) {
  return new Promise((resolve, reject) => {
    const dados = raw !== undefined ? raw : body === undefined ? null : JSON.stringify(body);
    const headers = { Host: host || `127.0.0.1:${PORT}` };
    if (token !== null) headers['X-Delegar-Token'] = token;
    if (dados !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(dados);
    }
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: urlPath, headers }, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => {
        const txt = Buffer.concat(partes).toString('utf8');
        let json = null;
        try { json = JSON.parse(txt); } catch {}
        resolve({ status: res.statusCode, json, txt });
      });
    });
    r.on('error', reject);
    r.setTimeout(15000, () => r.destroy(new Error('tempo esgotado na requisição')));
    if (dados !== null) r.write(dados);
    r.end();
  });
}
const get = (u, o) => req('GET', u, o);
const post = (u, body, o) => req('POST', u, { body, ...o });

function matar() {
  if (fakeLiteLLM) {
    try { fakeLiteLLM.close(); } catch {}
  }
  if (!filho || filho.exitCode !== null || !filho.pid) return;
  try { execFileSync('taskkill', ['/PID', String(filho.pid), '/T', '/F'], { stdio: 'ignore' }); }
  catch { try { filho.kill(); } catch {} }
}

before(async () => {
  raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'delegar-uso-srv-'));
  DATA = path.join(raiz, 'data');
  VAULT = path.join(raiz, 'vault');
  REPO = path.join(raiz, 'repo');
  for (const d of [DATA, VAULT, REPO]) fs.mkdirSync(d, { recursive: true });

  // 1. Servidor LiteLLM local para testar atualização de preços
  fakeLiteLLM = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        'claude-sonnet-5-5': {
          input_cost_per_token: 0.000003,
          output_cost_per_token: 0.000015,
          cache_read_input_token_cost: 0.0000003,
          cache_creation_input_token_cost: 0.00000375,
          cache_creation_input_token_cost_above_1hr: 0.000006
        }
      }));
    } else {
      res.writeHead(405);
      res.end();
    }
  });
  await new Promise((r) => fakeLiteLLM.listen(0, '127.0.0.1', r));
  LITELLM_PORT = fakeLiteLLM.address().port;

  // 2. Projeto Principal (Hoje): 2 tarefas, result.json em t1, out.log ao vivo em t2, planejador em p.uso
  const projHojeDir = path.join(DATA, 'projects', PROJ_HOJE);
  const logsHojeDir = path.join(projHojeDir, 'logs');
  const t1Dir = path.join(logsHojeDir, 't1');
  const t2Dir = path.join(logsHojeDir, 't2');
  for (const d of [t1Dir, t2Dir]) fs.mkdirSync(d, { recursive: true });

  const projHoje = {
    id: PROJ_HOJE,
    titulo: 'Projeto Teste Uso Hoje',
    tituloFixo: true,
    pedido: 'Testar agregacao de uso ao vivo',
    repo: REPO,
    modo: 'padrao',
    auto: true,
    supervisao: 'automatico',
    criado: '2026-11-13T10:00:00.000Z',
    estado: 'executando',
    mensagens: [{ papel: 'usuario', texto: 'Testar agregacao', quando: '2026-11-13T10:00:00.000Z' }],
    sessao: null,
    plano: {
      titulo: 'Plano Hoje',
      tarefas: [
        { id: 't1', titulo: 'Tarefa concluida', tipo: 'tarefa', nivel: 'volume', prompt: 'Prompt T1', depende: [], confirmar: false },
        { id: 't2', titulo: 'Tarefa em andamento', tipo: 'tarefa', nivel: 'leve', prompt: 'Prompt T2', depende: ['t1'], confirmar: false }
      ]
    },
    uso: {
      chamadas: [
        {
          quando: '2026-11-13T10:05:00',
          papel: 'planejador',
          modelo: 'claude:sonnet',
          entrada: 1000,
          saida: 500,
          cacheLido: 200,
          cacheGravado: 0,
          fonte: 'cli',
          custoCliUsd: 0.0125,
          porModelo: [
            { provedor: 'claude', modelo: 'sonnet', entrada: 1000, saida: 500, cacheLido: 200, cacheGravado: 0, custoCliUsd: 0.0125 }
          ]
        }
      ]
    }
  };
  fs.writeFileSync(path.join(projHojeDir, 'project.json'), JSON.stringify(projHoje, null, 2), 'utf8');

  // Status de execução do projeto hoje
  fs.writeFileSync(path.join(logsHojeDir, 'status.json'), JSON.stringify({
    t1: { state: 'done', model: 'claude:sonnet', started: '2026-11-13T10:06:00', finished: '2026-11-13T10:10:00' },
    t2: { state: 'running', model: 'opencode:opencode/glm-5.3-flash-free', started: '2026-11-13T10:12:00', finished: null }
  }, null, 2), 'utf8');

  // T1: result.json com tentativa finalizada
  fs.writeFileSync(path.join(t1Dir, 'result.json'), JSON.stringify({
    ok: true,
    model: 'claude:sonnet',
    attempts: [
      {
        worker: 'claude:sonnet',
        exitCode: 0,
        quota: false,
        emptyOutput: false,
        started: '2026-11-13T10:06:00',
        finished: '2026-11-13T10:10:00',
        out: path.join(t1Dir, '1-sonnet.out.log'),
        err: path.join(t1Dir, '1-sonnet.err.log'),
        text: path.join(t1Dir, '1-sonnet.txt'),
        uso: {
          modelo: 'claude:sonnet',
          entrada: 2000,
          saida: 1000,
          cacheLido: 500,
          cacheGravado: 0,
          fonte: 'cli',
          custoCliUsd: 0.025,
          porModelo: [
            { provedor: 'claude', modelo: 'sonnet', entrada: 2000, saida: 1000, cacheLido: 500, cacheGravado: 0, custoCliUsd: 0.025 }
          ]
        }
      }
    ],
    uso: {
      modelo: 'claude:sonnet',
      entrada: 2000,
      saida: 1000,
      cacheLido: 500,
      cacheGravado: 0,
      fonte: 'cli',
      custoCliUsd: 0.025,
      porModelo: [
        { provedor: 'claude', modelo: 'sonnet', entrada: 2000, saida: 1000, cacheLido: 500, cacheGravado: 0, custoCliUsd: 0.025 }
      ]
    }
  }, null, 2), 'utf8');

  // T2: tarefa ao vivo sem result.json, com out.log copiado de fixtures/uso-opencode.jsonl
  fs.copyFileSync(path.join(FIXTURES, 'uso-opencode.jsonl'), path.join(t2Dir, '1-glm-5.3-flash-free.out.log'));
  fs.writeFileSync(path.join(t2Dir, 'current.json'), JSON.stringify({
    worker: 'opencode:opencode/glm-5.3-flash-free',
    attempt: 1,
    started: '2026-11-13T10:12:00'
  }), 'utf8');

  // 3. Projeto de 15 dias atrás (2026-10-29): entra em 30d e tudo, fora de hoje e 7d
  const proj15Dir = path.join(DATA, 'projects', PROJ_15D);
  const logs15Dir = path.join(proj15Dir, 'logs');
  fs.mkdirSync(path.join(logs15Dir, 't1'), { recursive: true });
  const proj15 = {
    id: PROJ_15D,
    titulo: 'Projeto Teste 15d',
    repo: REPO,
    modo: 'padrao',
    criado: '2026-10-29T10:00:00.000Z',
    estado: 'concluido',
    mensagens: [],
    plano: { tarefas: [{ id: 't1', titulo: 'T1 15d', prompt: 'P1' }] },
    uso: {
      chamadas: [
        {
          quando: '2026-10-29T10:02:00',
          papel: 'planejador',
          modelo: 'claude:sonnet',
          entrada: 300,
          saida: 100,
          cacheLido: 0,
          cacheGravado: 0,
          fonte: 'cli',
          custoCliUsd: 0.003,
          porModelo: [{ provedor: 'claude', modelo: 'sonnet', entrada: 300, saida: 100, cacheLido: 0, cacheGravado: 0, custoCliUsd: 0.003 }]
        }
      ]
    }
  };
  fs.writeFileSync(path.join(proj15Dir, 'project.json'), JSON.stringify(proj15, null, 2), 'utf8');
  fs.writeFileSync(path.join(logs15Dir, 'status.json'), JSON.stringify({
    t1: { state: 'done', model: 'claude:sonnet', started: '2026-10-29T10:05:00', finished: '2026-10-29T10:10:00' }
  }), 'utf8');
  fs.writeFileSync(path.join(logs15Dir, 't1', 'result.json'), JSON.stringify({
    ok: true,
    attempts: [
      {
        worker: 'claude:sonnet',
        started: '2026-10-29T10:05:00',
        finished: '2026-10-29T10:10:00',
        uso: {
          modelo: 'claude:sonnet',
          entrada: 400,
          saida: 200,
          cacheLido: 0,
          cacheGravado: 0,
          fonte: 'cli',
          custoCliUsd: 0.004,
          porModelo: [{ provedor: 'claude', modelo: 'sonnet', entrada: 400, saida: 200, cacheLido: 0, cacheGravado: 0, custoCliUsd: 0.004 }]
        }
      }
    ]
  }), 'utf8');

  // 4. Projeto de 45 dias atrás (2026-09-25): só entra em tudo
  const proj45Dir = path.join(DATA, 'projects', PROJ_45D);
  const logs45Dir = path.join(proj45Dir, 'logs');
  fs.mkdirSync(path.join(logs45Dir, 't1'), { recursive: true });
  const proj45 = {
    id: PROJ_45D,
    titulo: 'Projeto Teste 45d',
    repo: REPO,
    modo: 'padrao',
    criado: '2026-09-25T10:00:00.000Z',
    estado: 'concluido',
    mensagens: [],
    plano: { tarefas: [{ id: 't1', titulo: 'T1 45d', prompt: 'P1' }] },
    uso: {
      chamadas: [
        {
          quando: '2026-09-25T10:02:00',
          papel: 'planejador',
          modelo: 'claude:sonnet',
          entrada: 50,
          saida: 20,
          cacheLido: 0,
          cacheGravado: 0,
          fonte: 'cli',
          custoCliUsd: 0.0005,
          porModelo: [{ provedor: 'claude', modelo: 'sonnet', entrada: 50, saida: 20, cacheLido: 0, cacheGravado: 0, custoCliUsd: 0.0005 }]
        }
      ]
    }
  };
  fs.writeFileSync(path.join(proj45Dir, 'project.json'), JSON.stringify(proj45, null, 2), 'utf8');
  fs.writeFileSync(path.join(logs45Dir, 'status.json'), JSON.stringify({
    t1: { state: 'done', model: 'claude:sonnet', started: '2026-09-25T10:05:00', finished: '2026-09-25T10:10:00' }
  }), 'utf8');
  fs.writeFileSync(path.join(logs45Dir, 't1', 'result.json'), JSON.stringify({
    ok: true,
    attempts: [
      {
        worker: 'claude:sonnet',
        started: '2026-09-25T10:05:00',
        finished: '2026-09-25T10:10:00',
        uso: {
          modelo: 'claude:sonnet',
          entrada: 60,
          saida: 30,
          cacheLido: 0,
          cacheGravado: 0,
          fonte: 'cli',
          custoCliUsd: 0.0006,
          porModelo: [{ provedor: 'claude', modelo: 'sonnet', entrada: 60, saida: 30, cacheLido: 0, cacheGravado: 0, custoCliUsd: 0.0006 }]
        }
      }
    ]
  }), 'utf8');

  // Encontra porta livre para o servidor de teste
  const srvTemp = http.createServer();
  await new Promise((r) => srvTemp.listen(0, '127.0.0.1', r));
  PORT = srvTemp.address().port;
  await new Promise((r) => srvTemp.close(r));

  // Inicia o servidor delegado
  filho = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      DELEGAR_PORT: String(PORT),
      DELEGAR_DATA: DATA,
      DELEGAR_VAULT: VAULT,
      DELEGAR_PROVEDORES: 'nenhum',
      DELEGAR_PRECOS_OFFLINE: '1',
      DELEGAR_PRECOS_URL: `http://127.0.0.1:${LITELLM_PORT}/prices.json`
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  filho.stdout.on('data', (c) => { saida += c; });
  filho.stderr.on('data', (c) => { saida += c; });

  const limite = Date.now() + 20000;
  let no = false;
  while (Date.now() < limite && !no) {
    if (filho.exitCode !== null) throw new Error(`o servidor saiu antes de responder:\n${saida}`);
    no = await fetch(`http://127.0.0.1:${PORT}/api/saude`).then((r) => r.ok, () => false);
    if (!no) await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(no, `o servidor não respondeu em 20 s:\n${saida}`);
  TOKEN = fs.readFileSync(path.join(DATA, 'token'), 'utf8').trim();
});

after(() => {
  matar();
  if (raiz) {
    try { fs.rmSync(raiz, { recursive: true, force: true }); } catch {}
  }
});

test('sem token ou com token inválido: 401 nas rotas de uso e preços', async () => {
  const rotas = [
    ['GET', '/api/uso'],
    ['GET', `/api/projetos/${PROJ_HOJE}/uso`],
    ['GET', '/api/precos'],
    ['POST', '/api/precos/atualizar']
  ];
  for (const [m, u] of rotas) {
    for (const token of [null, '', 'invalido', TOKEN + 'x']) {
      const r = await req(m, u, { token });
      assert.equal(r.status, 401, `${m} ${u} com token ${token}`);
    }
  }
});

test('GET /api/uso com período inválido devolve 400', async () => {
  for (const p of ['invalido', '15d', 'ontem', 'ano', '']) {
    const r = await get(`/api/uso?periodo=${p}`);
    assert.equal(r.status, 400, `período ${p}`);
    assert.ok(r.json?.erro);
  }
});

test('GET /api/projetos/:id/uso traz planejador primeiro, tarefas e totais exatos', async () => {
  const r = await get(`/api/projetos/${PROJ_HOJE}/uso`);
  assert.equal(r.status, 200);
  const j = r.json;

  // Projeto está em andamento (t2 running)
  assert.equal(j.emAndamento, true);
  assert.ok(Array.isArray(j.tarefas));
  assert.equal(j.tarefas.length, 3);

  // Pseudotarefa 'planejador' é a primeira
  const plan = j.tarefas[0];
  assert.equal(plan.id, 'planejador');
  assert.equal(plan.titulo, 'Planejador');
  assert.equal(plan.total.entrada, 1000);
  assert.equal(plan.total.saida, 500);
  assert.equal(plan.total.cacheLido, 200);
  assert.equal(plan.total.cacheGravado, 0);
  assert.equal(plan.total.usd, 0.0125);
  assert.equal(plan.tentativas.length, 1);
  assert.equal(plan.tentativas[0].modelo, 'sonnet');
  assert.equal(plan.tentativas[0].provedor, 'claude');
  assert.equal(plan.tentativas[0].fonte, 'cli');

  // Tarefa t1 (result.json)
  const t1 = j.tarefas[1];
  assert.equal(t1.id, 't1');
  assert.equal(t1.estado, 'done');
  assert.equal(t1.total.entrada, 2000);
  assert.equal(t1.total.saida, 1000);
  assert.equal(t1.total.cacheLido, 500);
  assert.equal(t1.total.cacheGravado, 0);
  assert.equal(t1.total.usd, 0.025);
  assert.equal(t1.tentativas.length, 1);
  assert.equal(t1.tentativas[0].origem, 'cli');

  // Tarefa t2 (ao vivo a partir do out.log de uso-opencode.jsonl)
  const t2 = j.tarefas[2];
  assert.equal(t2.id, 't2');
  assert.equal(t2.estado, 'running');
  // 145482 + 1000 = 146482 de entrada; 3 + 19 + 100 + 50 = 172 de saída
  assert.equal(t2.total.entrada, 146482);
  assert.equal(t2.total.saida, 172);
  assert.equal(t2.total.cacheLido, 150);
  assert.equal(t2.total.cacheGravado, 200);
  assert.equal(t2.total.usd, 0.0021);
  assert.equal(t2.tentativas.length, 1);
  assert.equal(t2.tentativas[0].fonte, 'cli-parcial');
  assert.equal(t2.tentativas[0].fim, null);

  // Total do projeto
  assert.equal(j.total.entrada, 1000 + 2000 + 146482); // 149482
  assert.equal(j.total.saida, 500 + 1000 + 172);       // 1672
  assert.equal(j.total.cacheLido, 200 + 500 + 150);    // 850
  assert.equal(j.total.cacheGravado, 200);
  assert.equal(j.total.usd, 0.0396);                  // 0.0125 + 0.025 + 0.0021
  assert.ok(typeof j.total.brl === 'number' && j.total.brl > 0);

  // Modelos do projeto
  assert.ok(Array.isArray(j.modelos));
  assert.equal(j.modelos.length, 2);
  const sonnet = j.modelos.find((m) => m.modelo === 'sonnet');
  assert.ok(sonnet);
  assert.equal(sonnet.entrada, 3000);
  assert.equal(sonnet.saida, 1500);
  assert.equal(sonnet.usd, 0.0375);
  assert.equal(sonnet.assinatura, 'Claude Code');

  const glm = j.modelos.find((m) => m.modelo === 'opencode/glm-5.3-flash-free');
  assert.ok(glm);
  assert.equal(glm.entrada, 146482);
  assert.equal(glm.usd, 0.0021);
  assert.equal(glm.assinatura, null);
});

test('GET /api/uso: período hoje filtra só o projeto de hoje com números exatos', async () => {
  const r = await get('/api/uso?periodo=hoje');
  assert.equal(r.status, 200);
  const j = r.json;

  assert.equal(j.periodo, 'hoje');
  assert.equal(j.projetos, 1);
  assert.ok(j.aviso.includes('Claude Code e Antigravity são assinaturas'));
  assert.equal(j.total.entrada, 149482);
  assert.equal(j.total.saida, 1672);
  assert.equal(j.total.cacheLido, 850);
  assert.equal(j.total.cacheGravado, 200);
  assert.equal(j.total.usd, 0.0396);
});

test('GET /api/uso: período 7d traz só o projeto de hoje', async () => {
  const r = await get('/api/uso?periodo=7d');
  assert.equal(r.status, 200);
  const j = r.json;

  assert.equal(j.periodo, '7d');
  assert.equal(j.projetos, 1);
  assert.equal(j.total.entrada, 149482);
  assert.equal(j.total.saida, 1672);
  assert.equal(j.total.cacheLido, 850);
  assert.equal(j.total.cacheGravado, 200);
  assert.equal(j.total.usd, 0.0396);
});

test('GET /api/uso: período 30d (padrão) inclui hoje e 15d com números exatos', async () => {
  // Chamada sem query usa o padrão 30d
  const rSem = await get('/api/uso');
  assert.equal(rSem.status, 200);
  assert.equal(rSem.json.periodo, '30d');

  const r = await get('/api/uso?periodo=30d');
  assert.equal(r.status, 200);
  const j = r.json;

  assert.equal(j.periodo, '30d');
  assert.equal(j.projetos, 2);
  // Hoje: 149482 + 15d: (300 plan + 400 t1) = 700 -> 150182
  assert.equal(j.total.entrada, 149482 + 700);
  // Hoje: 1672 + 15d: (100 plan + 200 t1) = 300 -> 1972
  assert.equal(j.total.saida, 1672 + 300);
  assert.equal(j.total.cacheLido, 850);
  assert.equal(j.total.cacheGravado, 200);
  // Hoje: 0.0396 + 15d: (0.003 + 0.004) = 0.007 -> 0.0466
  assert.equal(j.total.usd, 0.0466);
});

test('GET /api/uso: período tudo inclui os 3 projetos com números exatos', async () => {
  const r = await get('/api/uso?periodo=tudo');
  assert.equal(r.status, 200);
  const j = r.json;

  assert.equal(j.periodo, 'tudo');
  assert.equal(j.projetos, 3);
  // 150182 + 45d: (50 plan + 60 t1) = 110 -> 150292
  assert.equal(j.total.entrada, 150182 + 110);
  // 1972 + 45d: (20 plan + 30 t1) = 50 -> 2022
  assert.equal(j.total.saida, 1972 + 50);
  assert.equal(j.total.cacheLido, 850);
  assert.equal(j.total.cacheGravado, 200);
  // 0.0466 + 45d: (0.0005 + 0.0006) = 0.0011 -> 0.0477
  assert.equal(j.total.usd, 0.0477);
});

test('GET /api/precos devolve a tabela de preços e campos obrigatórios', async () => {
  const r = await get('/api/precos');
  assert.equal(r.status, 200);
  const j = r.json;

  assert.ok('atualizado' in j);
  assert.ok(typeof j.idadeDias === 'number');
  assert.ok(typeof j.fonte === 'string');
  assert.ok(typeof j.usdBrl === 'number');
  assert.ok(typeof j.modelos === 'object' && j.modelos !== null);
  assert.ok('claude-sonnet-5-5' in j.modelos);
});

test('POST /api/precos/atualizar chama o servidor LiteLLM local e atualiza os preços', async () => {
  const r = await post('/api/precos/atualizar', {});
  assert.equal(r.status, 200);
  const j = r.json;

  assert.equal(j.ok, true);
  assert.ok(typeof j.atualizados === 'number');
  assert.ok('atualizado' in j);
  assert.ok(typeof j.usdBrl === 'number');
  assert.ok(typeof j.modelos === 'object');
});
