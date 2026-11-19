// Testes do servidor para estimativa de demanda, histórico real e comparação.
// Sobe um servidor real isolado com DELEGAR_DATA e DELEGAR_VAULT em diretório temporário.
process.env.DELEGAR_SEM_AVISO = '1';

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

const PROJ_TESTE = '202611181200-proj-estimativa-a1b2';
const PROJ_HIST = '202611171000-proj-historico-c3d4';
const PROJ_COMP = '202611181201-proj-concluido-e5f6';

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
  raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'delegar-est-srv-'));
  DATA = path.join(raiz, 'data');
  VAULT = path.join(raiz, 'vault');
  REPO = path.join(raiz, 'repo');
  for (const d of [DATA, VAULT, REPO]) fs.mkdirSync(d, { recursive: true });

  // 1. Projeto com histórico anterior (result.json falso com consumo)
  const dirHist = path.join(DATA, 'projects', PROJ_HIST);
  const logsHist = path.join(dirHist, 'logs');
  gravar(path.join(dirHist, 'project.json'), {
    id: PROJ_HIST,
    titulo: 'Projeto Histórico Teste',
    repo: REPO,
    modo: 'padrao',
    estado: 'concluido',
    criado: '2026-11-17T10:00:00.000Z',
    plano: {
      titulo: 'Plano Histórico',
      tarefas: [
        { id: 'h1', titulo: 'Tarefa histórica código', tipo: 'tarefa', nivel: 'volume', prompt: 'Implementar modulo no servidor com testes unitarios', demanda: 'codigo' },
        { id: 'h2', titulo: 'Tarefa histórica leitura', tipo: 'tarefa', nivel: 'volume', prompt: 'Auditar codigo e diagnosticar problemas', demanda: 'leitura' },
      ],
    },
    uso: { chamadas: [] },
  });
  gravar(path.join(logsHist, 'h1', 'result.json'), {
    ok: true,
    attempts: [
      {
        worker: 'claude:sonnet',
        started: '2026-11-17T10:01:00.000Z',
        finished: '2026-11-17T10:05:00.000Z',
        uso: { entrada: 120000, saida: 25000, cacheLido: 800000, cacheGravado: 10000 },
      },
    ],
  });
  gravar(path.join(logsHist, 'h2', 'result.json'), {
    ok: true,
    attempts: [
      {
        worker: 'claude:sonnet',
        started: '2026-11-17T10:06:00.000Z',
        finished: '2026-11-17T10:09:00.000Z',
        uso: { entrada: 30000, saida: 15000, cacheLido: 900000, cacheGravado: 5000 },
      },
    ],
  });

  // 2. Projeto que receberá o plano via API
  const dirTeste = path.join(DATA, 'projects', PROJ_TESTE);
  gravar(path.join(dirTeste, 'project.json'), {
    id: PROJ_TESTE,
    titulo: 'Projeto Teste Estimativa',
    pedido: 'Fazer o script da funcionalidade X',
    repo: REPO,
    modo: 'padrao',
    auto: false,
    velocidade: 'auto',
    supervisao: 'automatico',
    politicaCota: 'ignorar',
    criado: '2026-11-18T10:00:00.000Z',
    estado: 'planejando',
    mensagens: [
      { papel: 'usuario', texto: 'Fazer o script da funcionalidade X', quando: '2026-11-18T10:00:00.000Z' },
    ],
    plano: null,
    uso: { chamadas: [] },
  });

  // 3. Projeto concluído para testar estimativa x real
  const dirComp = path.join(DATA, 'projects', PROJ_COMP);
  const logsComp = path.join(dirComp, 'logs');
  gravar(path.join(dirComp, 'project.json'), {
    id: PROJ_COMP,
    titulo: 'Projeto Concluído Comparação',
    repo: REPO,
    modo: 'padrao',
    auto: false,
    velocidade: 'auto',
    supervisao: 'automatico',
    criado: '2026-11-18T11:00:00.000Z',
    inicio: '2026-11-18T11:01:00.000Z',
    fim: '2026-11-18T11:06:00.000Z',
    estado: 'concluido',
    plano: {
      titulo: 'Plano Comparação',
      tarefas: [
        { id: 't1', titulo: 'Tarefa C1', tipo: 'tarefa', nivel: 'volume', prompt: 'Implementar modulo no servidor', demanda: 'codigo' },
      ],
    },
    estimativaInicial: {
      quando: '2026-11-18T11:01:00.000Z',
      tarefas: {
        t1: {
          entrada: 100000,
          saida: 20000,
          cacheLido: 500000,
          cacheGravado: 0,
          duracaoSeg: 200,
          modeloAssumido: 'claude:sonnet',
          demanda: 'codigo',
        },
      },
      total: { entrada: 100000, saida: 20000, cacheLido: 500000, duracaoSeg: 200 },
      tempo: { totalSeg: 200 },
    },
    mensagens: [],
    uso: { chamadas: [] },
  });
  gravar(path.join(logsComp, 'status.json'), {
    t1: { state: 'done', model: 'claude:sonnet', started: '2026-11-18T11:01:10.000Z', finished: '2026-11-18T11:05:10.000Z' },
  });
  gravar(path.join(logsComp, 'summary.md'), '# Resumo\nRESULTADO: CONCLUIDO\n');
  gravar(path.join(logsComp, 't1', 'result.json'), {
    ok: true,
    attempts: [
      {
        worker: 'claude:sonnet',
        started: '2026-11-18T11:01:10.000Z',
        finished: '2026-11-18T11:05:10.000Z',
        uso: { entrada: 120000, saida: 24000, cacheLido: 600000, cacheGravado: 0 },
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
    if (filho.exitCode !== null) throw new Error(`o servidor saiu antes de responder (código ${filho.exitCode}):\n${saida}`);
    no = await fetch(`http://127.0.0.1:${PORT}/api/saude`).then((r) => r.ok, () => false);
    if (!no) await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(no, `o servidor não respondeu em 20 s:\n${saida}`);
  TOKEN = fs.readFileSync(path.join(DATA, 'token'), 'utf8').trim();
});

after(() => {
  matar();
  if (raiz) fs.rmSync(raiz, { recursive: true, force: true });
});

test('validatePlan: aceita demanda valida e recusa demanda invalida citando id', async () => {
  const { validatePlan } = await import('../server.mjs');
  const base = {
    tarefas: [
      { id: 't1', tipo: 'tarefa', nivel: 'volume', prompt: 'Implementar a funcao de teste com vinte chars' },
    ],
  };

  for (const cat of ['leitura', 'geracao', 'codigo', 'integracao']) {
    const errs = validatePlan({ tarefas: [{ ...base.tarefas[0], demanda: cat }] }, true);
    assert.deepEqual(errs, [], `demanda '${cat}' deve ser aceita`);
  }

  const errsInvalido = validatePlan({ tarefas: [{ ...base.tarefas[0], demanda: 'xyz' }] }, true);
  assert.ok(errsInvalido.length > 0, 'deve recusar demanda invalida');
  assert.ok(errsInvalido.some((e) => e.includes('t1') && e.includes('demanda')), 'deve citar o id da tarefa e a demanda');
});

test('POST do plano: rejeita entrada com demanda invalida (checklist seguranca)', async () => {
  const r = await post(`/api/projetos/${PROJ_TESTE}/plano`, {
    tarefas: [
      { id: 't1', tipo: 'tarefa', nivel: 'volume', prompt: 'Prompt com comprimento suficiente para passar', demanda: 'invalida' },
    ],
  });
  assert.equal(r.status, 400);
  assert.ok(r.json?.erro?.includes('t1'), 'erro cita id da tarefa');
});

test('POST do plano: aceita plano, gera mensagem "Plano recebido" com "Estimativa:" e preenche p.demanda', async () => {
  const r = await post(`/api/projetos/${PROJ_TESTE}/plano`, {
    titulo: 'Plano com Estimativa',
    tarefas: [
      { id: 't1', tipo: 'tarefa', nivel: 'volume', prompt: 'Implementar endpoint novo no servidor com testes unitarios', demanda: 'codigo' },
    ],
  });
  assert.equal(r.status, 200);
  assert.ok(r.json?.plano, 'devolve plano');
  assert.ok(r.json?.demanda, 'GET/resposta expõe demanda');

  const msgs = r.json.mensagens || [];
  const msgPlano = msgs.find((m) => m.papel === 'sistema' && m.texto?.startsWith('Plano recebido:'));
  assert.ok(msgPlano, 'mensagem Plano recebido deve existir');
  assert.ok(msgPlano.texto.includes('Estimativa:'), 'mensagem deve conter linha Estimativa:');
});

test('mudar modo atualiza a linha de estimativa na mesma mensagem sem criar outra', async () => {
  const antes = await get(`/api/projetos/${PROJ_TESTE}`);
  const msgsAntes = antes.json?.mensagens || [];
  const qtdPlanoAntes = msgsAntes.filter((m) => m.papel === 'sistema' && m.texto?.startsWith('Plano recebido:')).length;
  assert.equal(qtdPlanoAntes, 1, 'deve haver exatamente 1 mensagem Plano recebido');

  const rAjuste = await post(`/api/projetos/${PROJ_TESTE}/ajustes`, {
    modo: 'agressivo',
  });
  assert.equal(rAjuste.status, 200);

  const depois = await get(`/api/projetos/${PROJ_TESTE}`);
  const msgsDepois = depois.json?.mensagens || [];
  const msgsPlanoDepois = msgsDepois.filter((m) => m.papel === 'sistema' && m.texto?.startsWith('Plano recebido:'));
  assert.equal(msgsPlanoDepois.length, 1, 'não deve criar outra mensagem Plano recebido');
  assert.ok(msgsPlanoDepois[0].texto.includes('Estimativa:'), 'deve continuar com Estimativa:');
});

test('projeto concluído: monta comparacaoEstimativa e grava linha em state/estimativas.jsonl', async () => {
  const { montarComparacaoEstimativa } = await import('../server.mjs');

  const dirComp = path.join(DATA, 'projects', PROJ_COMP);
  const projPath = path.join(dirComp, 'project.json');
  const proj = JSON.parse(fs.readFileSync(projPath, 'utf8'));

  const comp = montarComparacaoEstimativa(proj, null, { dataDir: DATA, projDir: dirComp });
  assert.ok(comp, 'comparação deve ser gerada');
  assert.ok(Array.isArray(comp.tarefas) && comp.tarefas.length === 1);
  assert.equal(comp.tarefas[0].id, 't1');
  assert.equal(comp.tarefas[0].demanda, 'codigo');
  assert.equal(comp.tarefas[0].modeloAssumido, 'claude:sonnet');
  assert.equal(comp.tarefas[0].modeloReal, 'claude:sonnet');
  assert.equal(comp.tarefas[0].estimado.entrada, 100000);
  assert.equal(comp.tarefas[0].real.entrada, 120000);
  // Erro relativo: (120000 - 100000) / 100000 = +0.20
  assert.equal(comp.tarefas[0].erroRel.entrada, 0.2);
  assert.equal(comp.total.erroRel.entrada, 0.2);

  // Verifica gravação em state/estimativas.jsonl
  const jsonlPath = path.join(DATA, 'state', 'estimativas.jsonl');
  assert.ok(fs.existsSync(jsonlPath), 'estimativas.jsonl deve ter sido criado');
  const linhas = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
  assert.ok(linhas.length >= 1, 'deve ter ao menos 1 linha');
  const reg = JSON.parse(linhas[linhas.length - 1]);
  assert.equal(reg.projeto, PROJ_COMP);
  assert.equal(reg.tarefa, 't1');
  assert.equal(reg.modeloAssumido, 'claude:sonnet');
  assert.equal(reg.modeloReal, 'claude:sonnet');
  assert.equal(reg.demanda, 'codigo');
  assert.equal(reg.estimado.entrada, 100000);
  assert.equal(reg.real.entrada, 120000);
  assert.equal(reg.erroRel.entrada, 0.2);

  // Salva no projeto e verifica exposição no GET
  proj.comparacaoEstimativa = comp;
  fs.writeFileSync(projPath, JSON.stringify(proj, null, 2), 'utf8');

  const getProj = await get(`/api/projetos/${PROJ_COMP}`);
  assert.equal(getProj.status, 200);
  assert.ok(getProj.json?.comparacaoEstimativa, 'GET do projeto expõe comparacaoEstimativa');
  assert.equal(getProj.json?.comparacaoEstimativa?.tarefas?.[0]?.id, 't1');
});
