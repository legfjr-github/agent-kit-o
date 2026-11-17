// Testes do servidor para múltiplas rodadas e migração de rodadas.
// Sobe um servidor real isolado com DELEGAR_DATA e DELEGAR_VAULT em diretório temporário.
process.env.DELEGAR_SEM_AVISO = '1'; // pipelines de teste não abrem o aviso msg do Windows
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

let raiz, DATA, VAULT, REPO, TOKEN, filho, saida = '', PORT;

const PROJ_CONT = '202611161200-proj-continuar-a1b2';
const PROJ_MIGRAR = '202611161201-proj-migrar-c3d4';

function req(method, urlPath, { body, token = TOKEN, host } = {}) {
  return new Promise((resolve, reject) => {
    const dados = body === undefined ? null : JSON.stringify(body);
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

function gravar(arquivo, conteudo) {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  fs.writeFileSync(arquivo, typeof conteudo === 'string' ? conteudo : JSON.stringify(conteudo, null, 2), 'utf8');
}

function matar() {
  if (!filho || filho.exitCode !== null || !filho.pid) return;
  try { execFileSync('taskkill', ['/PID', String(filho.pid), '/T', '/F'], { stdio: 'ignore' }); }
  catch { try { filho.kill(); } catch {} }
}

before(async () => {
  raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'delegar-rodadas-srv-'));
  DATA = path.join(raiz, 'data');
  VAULT = path.join(raiz, 'vault');
  REPO = path.join(raiz, 'repo');
  for (const d of [DATA, VAULT, REPO]) fs.mkdirSync(d, { recursive: true });

  // 1. Projeto PROJ_CONT (Rodada 1 concluída)
  const dirCont = path.join(DATA, 'projects', PROJ_CONT);
  const logsCont = path.join(dirCont, 'logs');
  gravar(path.join(dirCont, 'project.json'), {
    id: PROJ_CONT,
    titulo: 'Projeto Teste Continuar',
    tituloFixo: true,
    pedido: 'Fazer funcionalidade A',
    repo: REPO,
    modo: 'padrao',
    velocidade: 'auto',
    supervisao: 'automatico',
    criado: '2026-11-16T10:00:00.000Z',
    inicio: '2026-11-16T10:01:00.000Z',
    fim: '2026-11-16T10:15:00.000Z',
    estado: 'concluido',
    resumoFinal: 'Rodada 1 concluída com sucesso.',
    mensagens: [
      { papel: 'usuario', texto: 'Fazer funcionalidade A', quando: '2026-11-16T10:00:00.000Z' },
      { papel: 'planejador', texto: 'Plano R1', quando: '2026-11-16T10:00:30.000Z' },
    ],
    plano: {
      titulo: 'Plano R1',
      tarefas: [
        { id: 't1', titulo: 'Tarefa 1', tipo: 'tarefa', nivel: 'volume', prompt: 'P1', depende: [], confirmar: false },
        { id: 't2', titulo: 'Tarefa 2', tipo: 'tarefa', nivel: 'leve', prompt: 'P2', depende: ['t1'], confirmar: false },
      ],
    },
    uso: {
      chamadas: [
        {
          quando: '2026-11-16T10:00:30.000Z',
          papel: 'planejador',
          modelo: 'claude:sonnet',
          entrada: 1000,
          saida: 500,
          cacheLido: 0,
          cacheGravado: 0,
          fonte: 'cli',
          custoCliUsd: 0.0125,
          porModelo: [{ provedor: 'claude', modelo: 'sonnet', entrada: 1000, saida: 500, cacheLido: 0, cacheGravado: 0, custoCliUsd: 0.0125 }],
        },
      ],
    },
  });

  gravar(path.join(logsCont, 'status.json'), {
    t1: { state: 'done', model: 'claude:sonnet', started: '2026-11-16T10:02:00.000Z', finished: '2026-11-16T10:08:00.000Z' },
    t2: { state: 'done', model: 'claude:haiku', started: '2026-11-16T10:09:00.000Z', finished: '2026-11-16T10:14:00.000Z' },
  });
  gravar(path.join(logsCont, 'summary.md'), '# Summary\nRESULTADO: CONCLUIDO\n');
  gravar(path.join(logsCont, 't1', 'result.json'), {
    ok: true,
    attempts: [
      {
        worker: 'claude:sonnet',
        text: path.join(logsCont, 't1', '1.txt'),
        started: '2026-11-16T10:02:00.000Z',
        finished: '2026-11-16T10:08:00.000Z',
        uso: {
          modelo: 'claude:sonnet',
          entrada: 2000,
          saida: 1000,
          cacheLido: 0,
          cacheGravado: 0,
          fonte: 'cli',
          custoCliUsd: 0.025,
          porModelo: [{ provedor: 'claude', modelo: 'sonnet', entrada: 2000, saida: 1000, cacheLido: 0, cacheGravado: 0, custoCliUsd: 0.025 }],
        },
      },
    ],
  });
  gravar(path.join(logsCont, 't1', '1.txt'), 'Saída T1 R1');
  gravar(path.join(logsCont, 't2', 'result.json'), {
    ok: true,
    attempts: [
      {
        worker: 'claude:haiku',
        text: path.join(logsCont, 't2', '1.txt'),
        started: '2026-11-16T10:09:00.000Z',
        finished: '2026-11-16T10:14:00.000Z',
        uso: {
          modelo: 'claude:haiku',
          entrada: 800,
          saida: 400,
          cacheLido: 0,
          cacheGravado: 0,
          fonte: 'cli',
          custoCliUsd: 0.0028,
          porModelo: [{ provedor: 'claude', modelo: 'haiku', entrada: 800, saida: 400, cacheLido: 0, cacheGravado: 0, custoCliUsd: 0.0028 }],
        },
      },
    ],
  });
  gravar(path.join(logsCont, 't2', '1.txt'), 'Saída T2 R1');

  // 2. Projeto PROJ_MIGRAR com pasta rodadas/1/
  const dirMigrar = path.join(DATA, 'projects', PROJ_MIGRAR);
  const r1Migrar = path.join(dirMigrar, 'rodadas', '1');
  gravar(path.join(dirMigrar, 'project.json'), {
    id: PROJ_MIGRAR,
    titulo: 'Projeto com Pasta Rodadas',
    repo: REPO,
    modo: 'padrao',
    estado: 'executando',
    criado: '2026-11-16T11:00:00.000Z',
    inicio: '2026-11-16T11:10:00.000Z',
    plano: {
      titulo: 'Plano R2 Atual',
      tarefas: [{ id: 'x1', titulo: 'Tarefa Executando', prompt: 'PX' }],
    },
    uso: {
      chamadas: [],
    },
  });
  gravar(path.join(dirMigrar, 'logs', 'status.json'), {
    x1: { state: 'running', model: 'claude:haiku', started: '2026-11-16T11:11:00.000Z' },
  });
  gravar(path.join(dirMigrar, 'logs', 'x1', 'result.json'), {
    ok: true,
    attempts: [
      {
        worker: 'claude:haiku',
        uso: {
          modelo: 'claude:haiku',
          entrada: 300,
          saida: 150,
          fonte: 'cli',
          custoCliUsd: 0.001,
          porModelo: [{ provedor: 'claude', modelo: 'haiku', entrada: 300, saida: 150, custoCliUsd: 0.001 }],
        },
      },
    ],
  });

  // Conteúdo legado de rodadas/1/
  gravar(path.join(r1Migrar, 'project.json'), {
    id: PROJ_MIGRAR,
    estado: 'concluido',
    fim: '2026-11-16T11:08:00.000Z',
    titulo: 'Projeto com Pasta Rodadas',
    plano: {
      tarefas: [{ id: 'w1', titulo: 'Tarefa R1 Legada', prompt: 'PW' }],
    },
    uso: {
      chamadas: [
        {
          quando: '2026-11-16T11:01:00.000Z',
          modelo: 'claude:haiku',
          entrada: 500,
          saida: 200,
          fonte: 'cli',
          custoCliUsd: 0.0015,
          porModelo: [{ provedor: 'claude', modelo: 'haiku', entrada: 500, saida: 200, custoCliUsd: 0.0015 }],
        },
      ],
    },
    mensagens: [
      { papel: 'planejador', texto: 'Plano Legado R1', quando: '2026-11-16T11:01:00.000Z' },
    ],
  });
  gravar(path.join(r1Migrar, 'plan.json'), {
    name: 'plano-legado',
    tasks: [{ id: 'w1', titulo: 'Tarefa R1 Legada', chain: ['claude:haiku'], after: [] }],
  });
  gravar(path.join(r1Migrar, 'logs', 'summary.md'), '# Resumo R1\nRESULTADO: CONCLUIDO\n');
  gravar(path.join(r1Migrar, 'logs', 'status.json'), { w1: { state: 'done' } });
  gravar(path.join(r1Migrar, 'logs', 'w1', 'result.json'), {
    ok: true,
    attempts: [
      {
        worker: 'claude:haiku',
        uso: {
          modelo: 'claude:haiku',
          entrada: 600,
          saida: 300,
          fonte: 'cli',
          custoCliUsd: 0.002,
          porModelo: [{ provedor: 'claude', modelo: 'haiku', entrada: 600, saida: 300, custoCliUsd: 0.002 }],
        },
      },
    ],
  });

  // Porta livre para o servidor de teste
  const srvTemp = http.createServer();
  await new Promise((r) => srvTemp.listen(0, '127.0.0.1', r));
  PORT = srvTemp.address().port;
  await new Promise((r) => srvTemp.close(r));

  // Inicia o servidor
  filho = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      DELEGAR_PORT: String(PORT),
      DELEGAR_DATA: DATA,
      DELEGAR_VAULT: VAULT,
      DELEGAR_PROVEDORES: 'nenhum',
      DELEGAR_PRECOS_OFFLINE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
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

test('1. Continuar projeto concluído: arquiva rodada 1, move logs e preserva ao rodar rodada 2 com ids repetidos', async () => {
  const dirCont = path.join(DATA, 'projects', PROJ_CONT);

  // Antes de continuar: status.json está na raiz de logs
  assert.equal(fs.existsSync(path.join(dirCont, 'logs', 'status.json')), true);
  assert.equal(fs.existsSync(path.join(dirCont, 'logs', 'rodada-1')), false);

  // Envia mensagem ao projeto concluído
  const resMsg = await post(`/api/projetos/${PROJ_CONT}/mensagem`, { texto: 'Agora faça a funcionalidade B' });
  assert.equal(resMsg.status, 202);

  // Verifica que a rodada 1 foi arquivada imediatamente: logs movidos para logs/rodada-1/
  assert.equal(fs.existsSync(path.join(dirCont, 'logs', 'rodada-1', 'status.json')), true);
  assert.equal(fs.existsSync(path.join(dirCont, 'logs', 'rodada-1', 'summary.md')), true);
  assert.equal(fs.existsSync(path.join(dirCont, 'logs', 'rodada-1', 't1', 'result.json')), true);
  assert.equal(fs.existsSync(path.join(dirCont, 'logs', 'status.json')), false);

  // Confere project.json salvo no disco (aguarda o término do plannerTurn em background)
  let pSalvo;
  const limite = Date.now() + 5000;
  while (Date.now() < limite) {
    pSalvo = JSON.parse(fs.readFileSync(path.join(dirCont, 'project.json'), 'utf8'));
    if (!pSalvo.ocupado && pSalvo.mensagens.some((m) => m.papel === 'sistema' || m.papel === 'planejador')) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(Array.isArray(pSalvo.rodadas), true);
  assert.equal(pSalvo.rodadas.length, 1);
  assert.equal(pSalvo.rodadas[0].numero, 1);
  assert.equal(pSalvo.rodadas[0].logDir, 'logs/rodada-1');
  assert.equal(pSalvo.rodadas[0].estado, 'concluido');

  // Agora simula a execução da rodada 2 com ids de tarefa repetidos (t1, t2)
  pSalvo.plano = {
    titulo: 'Plano R2 Repetido',
    tarefas: [
      { id: 't1', titulo: 'Tarefa 1 Nova', tipo: 'tarefa', nivel: 'volume', prompt: 'P1-novo', depende: [], confirmar: false },
      { id: 't2', titulo: 'Tarefa 2 Nova', tipo: 'tarefa', nivel: 'leve', prompt: 'P2-novo', depende: ['t1'], confirmar: false },
    ],
  };
  pSalvo.estado = 'concluido';
  pSalvo.inicio = '2026-11-16T12:00:00.000Z';
  pSalvo.fim = '2026-11-16T12:20:00.000Z';
  pSalvo.uso = {
    chamadas: [
      {
        quando: '2026-11-16T12:00:10.000Z',
        papel: 'planejador',
        modelo: 'claude:sonnet',
        entrada: 800,
        saida: 400,
        cacheLido: 0,
        cacheGravado: 0,
        fonte: 'cli',
        custoCliUsd: 0.01,
        porModelo: [{ provedor: 'claude', modelo: 'sonnet', entrada: 800, saida: 400, custoCliUsd: 0.01 }],
      },
    ],
  };
  fs.writeFileSync(path.join(dirCont, 'project.json'), JSON.stringify(pSalvo, null, 2), 'utf8');

  // Cria logs da rodada 2 na raiz de logs (sem tocar em logs/rodada-1/)
  const logsR2 = path.join(dirCont, 'logs');
  gravar(path.join(logsR2, 'status.json'), {
    t1: { state: 'done', model: 'claude:sonnet', started: '2026-11-16T12:01:00.000Z', finished: '2026-11-16T12:09:00.000Z' },
    t2: { state: 'done', model: 'claude:haiku', started: '2026-11-16T12:10:00.000Z', finished: '2026-11-16T12:18:00.000Z' },
  });
  gravar(path.join(logsR2, 'summary.md'), '# Summary R2\nRESULTADO: CONCLUIDO\n');
  gravar(path.join(logsR2, 't1', 'result.json'), {
    ok: true,
    attempts: [
      {
        worker: 'claude:sonnet',
        text: path.join(logsR2, 't1', '2.txt'),
        uso: {
          modelo: 'claude:sonnet',
          entrada: 3000,
          saida: 1500,
          cacheLido: 0,
          cacheGravado: 0,
          fonte: 'cli',
          custoCliUsd: 0.0375,
          porModelo: [{ provedor: 'claude', modelo: 'sonnet', entrada: 3000, saida: 1500, custoCliUsd: 0.0375 }],
        },
      },
    ],
  });
  gravar(path.join(logsR2, 't1', '2.txt'), 'Saída T1 R2');
  gravar(path.join(logsR2, 't2', 'result.json'), {
    ok: true,
    attempts: [
      {
        worker: 'claude:haiku',
        text: path.join(logsR2, 't2', '2.txt'),
        uso: {
          modelo: 'claude:haiku',
          entrada: 1200,
          saida: 600,
          cacheLido: 0,
          cacheGravado: 0,
          fonte: 'cli',
          custoCliUsd: 0.0042,
          porModelo: [{ provedor: 'claude', modelo: 'haiku', entrada: 1200, saida: 600, custoCliUsd: 0.0042 }],
        },
      },
    ],
  });
  gravar(path.join(logsR2, 't2', '2.txt'), 'Saída T2 R2');

  // logs/rodada-1/ continua intacta!
  assert.equal(fs.existsSync(path.join(dirCont, 'logs', 'rodada-1', 'status.json')), true);
  assert.equal(fs.existsSync(path.join(dirCont, 'logs', 'rodada-1', 't1', 'result.json')), true);
  const t1R1Result = JSON.parse(fs.readFileSync(path.join(dirCont, 'logs', 'rodada-1', 't1', 'result.json'), 'utf8'));
  assert.equal(t1R1Result.attempts[0].uso.entrada, 2000);
});

test('2. GET uso do projeto, uso geral, view pública, resumoFinal e VAULT orquestração', async () => {
  // A. GET /api/projetos/:id/uso
  const resUsoProj = await get(`/api/projetos/${PROJ_CONT}/uso`);
  assert.equal(resUsoProj.status, 200);
  const uProj = resUsoProj.json;
  assert.equal(Array.isArray(uProj.rodadas), true);
  assert.equal(uProj.rodadas.length, 2);

  // Rodada 1: entrada = 1000 (plan) + 2000 (t1) + 800 (t2) = 3800
  // Rodada 2: entrada = 800 (plan) + 3000 (t1) + 1200 (t2) = 5000
  // Total somado: 8800
  assert.equal(uProj.rodadas[0].total.entrada, 3800);
  assert.equal(uProj.rodadas[1].total.entrada, 5000);
  assert.equal(uProj.total.entrada, 8800);

  // Tarefas da resposta trazem o prefixo da rodada
  assert.equal(uProj.tarefas.length, 6); // 3 em R1 (plan, t1, t2), 3 em R2 (plan, t1, t2)
  assert.equal(uProj.tarefas.some((t) => t.rodada === 1 && t.id === 't1'), true);
  assert.equal(uProj.tarefas.some((t) => t.rodada === 2 && t.id === 't1'), true);

  // B. GET /api/uso?periodo=tudo
  const resUsoGeral = await get('/api/uso?periodo=tudo');
  assert.equal(resUsoGeral.status, 200);
  assert.ok(resUsoGeral.json.total.entrada >= 8800);

  // C. GET /api/projetos/:id (view pública full)
  const resProj = await get(`/api/projetos/${PROJ_CONT}`);
  assert.equal(resProj.status, 200);
  assert.equal(Array.isArray(resProj.json.rodadas), true);
  assert.equal(resProj.json.rodadas.length, 1); // rodadas anteriores arquivadas
  assert.equal(resProj.json.rodadas[0].numero, 1);
  assert.ok(resProj.json.rodadas[0].uso);
  assert.equal(resProj.json.rodadas[0].uso.total.entrada, 3800);

  // D. Dispara report via POST ajustes
  const resAjustes = await post(`/api/projetos/${PROJ_CONT}/ajustes`, {});
  assert.equal(resAjustes.status, 200);

  // E. Confere o arquivo gerado no VAULT
  const mdPath = path.join(VAULT, 'orquestracao', `${PROJ_CONT}.md`);
  assert.equal(fs.existsSync(mdPath), true);
  const mdTxt = fs.readFileSync(mdPath, 'utf8');

  assert.ok(mdTxt.includes('## Tokens e custo'), 'tem seção Tokens e custo');
  assert.ok(mdTxt.includes('### Por rodada'), 'tem subseção Por rodada');
  assert.ok(mdTxt.includes('Rodada 1'), 'tem Rodada 1 na tabela');
  assert.ok(mdTxt.includes('Rodada 2'), 'tem Rodada 2 na tabela');
  assert.ok(mdTxt.includes('R1 · t1'), 'tarefa t1 de R1 identificada');
  assert.ok(mdTxt.includes('R2 · t1'), 'tarefa t1 de R2 identificada');
  assert.ok(mdTxt.includes('## Rodadas anteriores'), 'tem seção Rodadas anteriores');
  assert.ok(mdTxt.includes('### Rodada 1: Plano R1'), 'traz título da Rodada 1');
});

test('3. Migração via servidor de projeto com rodadas/1/: 409 em execução e 200 quando concluído', async () => {
  const dirMigrar = path.join(DATA, 'projects', PROJ_MIGRAR);

  // 1. Enquanto executando: POST migrar-rodadas devolve 409
  const res409 = await post(`/api/projetos/${PROJ_MIGRAR}/migrar-rodadas`, {});
  assert.equal(res409.status, 409);
  assert.ok(res409.json.erro.includes('execução em andamento'));

  // Nada gravado no project.json do disco ainda
  const pDiscoAntes = JSON.parse(fs.readFileSync(path.join(dirMigrar, 'project.json'), 'utf8'));
  assert.equal(pDiscoAntes.rodadas, undefined);

  // Mas GET uso já soma a rodada 1 legada em memória
  const resUsoMem = await get(`/api/projetos/${PROJ_MIGRAR}/uso`);
  assert.equal(resUsoMem.status, 200);
  assert.equal(resUsoMem.json.rodadas.length, 2);
  // R1: 500 (chamada) + 600 (w1) = 1100
  // R2: 300 (x1) = 300
  // Total: 1400
  assert.equal(resUsoMem.json.rodadas[0].total.entrada, 1100);
  assert.equal(resUsoMem.json.rodadas[1].total.entrada, 300);
  assert.equal(resUsoMem.json.total.entrada, 1400);

  // 2. Passa projeto para concluído e chama POST migrar-rodadas
  pDiscoAntes.estado = 'concluido';
  pDiscoAntes.fim = '2026-11-16T11:20:00.000Z';
  fs.writeFileSync(path.join(dirMigrar, 'project.json'), JSON.stringify(pDiscoAntes, null, 2), 'utf8');

  const res200 = await post(`/api/projetos/${PROJ_MIGRAR}/migrar-rodadas`, {});
  assert.equal(res200.status, 200);
  assert.equal(Array.isArray(res200.json.rodadas), true);
  assert.equal(res200.json.rodadas.length, 1);
  assert.equal(res200.json.rodadas[0].numero, 1);

  // Gravado no project.json do disco
  const pDiscoDepois = JSON.parse(fs.readFileSync(path.join(dirMigrar, 'project.json'), 'utf8'));
  assert.equal(Array.isArray(pDiscoDepois.rodadas), true);
  assert.equal(pDiscoDepois.rodadas.length, 1);
  assert.equal(pDiscoDepois.rodadas[0].numero, 1);

  // logs/rodada-1/ foi criado no disco
  assert.equal(fs.existsSync(path.join(dirMigrar, 'logs', 'rodada-1', 'status.json')), true);

  // Pasta legada rodadas/1/ permanece intacta
  assert.equal(fs.existsSync(path.join(dirMigrar, 'rodadas', '1', 'plan.json')), true);

  // GET uso confirma a soma persistida
  const resUsoPos = await get(`/api/projetos/${PROJ_MIGRAR}/uso`);
  assert.equal(resUsoPos.status, 200);
  assert.equal(resUsoPos.json.total.entrada, 1400);
});
