// Testes de API das rotas de agendamento e reexecução do Delegar.
// Sobe o server.mjs real numa porta de teste isolada com DATA e cofre temporários.
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
const QUOTA_FALSO = path.join(HERE, 'fixtures', 'quota-falso.ps1');
const PORT = Number(process.env.DELEGAR_TESTE_PORTA_AGENDAMENTO) || 8797;

let raiz, DATA, VAULT, REPO, TOKEN, filho, saida = '';

function req(method, url, { body, token = TOKEN, host = `127.0.0.1:${PORT}` } = {}) {
  return new Promise((resolve, reject) => {
    const dados = body === undefined ? null : JSON.stringify(body);
    const headers = { Host: host };
    if (token !== null) headers['X-Delegar-Token'] = token;
    if (dados !== null) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(dados); }
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: url, headers }, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => {
        const txt = Buffer.concat(partes).toString('utf8');
        let json = null; try { json = JSON.parse(txt); } catch {}
        resolve({ status: res.statusCode, json, txt });
      });
    });
    r.on('error', reject);
    r.setTimeout(15000, () => r.destroy(new Error('tempo esgotado na requisição')));
    if (dados !== null) r.write(dados);
    r.end();
  });
}
const post = (u, body, o) => req('POST', u, { body, ...o });

function matar() {
  if (!filho || filho.exitCode !== null || !filho.pid) return;
  try { execFileSync('taskkill', ['/PID', String(filho.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { try { filho.kill(); } catch {} }
}

before(async () => {
  raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'delegar-ag-api-'));
  DATA = path.join(raiz, 'data'); VAULT = path.join(raiz, 'cofre'); REPO = path.join(raiz, 'repo');
  for (const d of [DATA, VAULT, REPO]) fs.mkdirSync(d, { recursive: true });
  try {
    const ocupada = await fetch(`http://127.0.0.1:${PORT}/api/saude`).then(() => true, () => false);
    assert.ok(!ocupada, `porta ${PORT} já está em uso por outro processo; libere-a ou defina DELEGAR_TESTE_PORTA_AGENDAMENTO`);
    filho = spawn(process.execPath, [SERVER], {
      env: { ...process.env, DELEGAR_PORT: String(PORT), DELEGAR_DATA: DATA, DELEGAR_VAULT: VAULT, DELEGAR_PROVEDORES: 'nenhum', DELEGAR_QUOTA_SCRIPT: QUOTA_FALSO, DELEGAR_PRECOS_OFFLINE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
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
  } catch (e) {
    matar();
    fs.rmSync(raiz, { recursive: true, force: true });
    throw e;
  }
});

after(() => {
  matar();
  if (raiz) fs.rmSync(raiz, { recursive: true, force: true });
});

test('agendamento via API: validações de estado, plano, cancelado e arquivado', async () => {
  const futuro = new Date(Date.now() + 2 * 3600e3).toISOString();

  // (a) projeto sem plano em 'conversando', POST agendar com só executarEm futuro -> 400 com a mensagem de falta de plano e nenhuma mensagem 'Agendamento salvo'
  const idSemPlano = '202611180001-sem-plano';
  const dirSemPlano = path.join(DATA, 'projects', idSemPlano);
  fs.mkdirSync(dirSemPlano, { recursive: true });
  const arqSemPlano = path.join(dirSemPlano, 'project.json');
  const projSemPlano = {
    id: idSemPlano,
    titulo: 'Projeto Sem Plano',
    pedido: 'Criar algo',
    repo: REPO,
    modo: 'padrao',
    velocidade: 'auto',
    supervisao: 'automatico',
    auto: false,
    criado: new Date().toISOString(),
    estado: 'conversando',
    mensagens: [{ papel: 'planejador', texto: 'Iniciando conversa', quando: new Date().toISOString() }],
    plano: null,
    uso: { chamadas: [] },
  };
  fs.writeFileSync(arqSemPlano, JSON.stringify(projSemPlano, null, 2), 'utf8');

  const rA = await post(`/api/projetos/${idSemPlano}/agendar`, { executarEm: futuro });
  assert.equal(rA.status, 400);
  assert.equal(rA.json?.erro, 'o projeto ainda não tem plano: agende também o planejamento ou espere o plano ficar pronto');

  const salvoSemPlano = JSON.parse(fs.readFileSync(arqSemPlano, 'utf8'));
  assert.equal(salvoSemPlano.agendamento, undefined, 'agendamento não foi salvo no disco');
  const temMsgSalvo = salvoSemPlano.mensagens.some((m) => m.texto && m.texto.includes('Agendamento salvo'));
  assert.equal(temMsgSalvo, false, 'nenhuma mensagem "Agendamento salvo" deve ser registrada');

  // (b) mesmo projeto com planejarEm -> 200
  const rB = await post(`/api/projetos/${idSemPlano}/agendar`, { planejarEm: futuro });
  assert.equal(rB.status, 200);
  assert.equal(rB.json?.agendamento?.ativo, true);
  assert.equal(rB.json?.agendamento?.tipo, 'so_planejar');

  // (c) projeto arquivado com plano -> 400 'o projeto está arquivado...'
  const idArq = '202611180002-arquivado-com-plano';
  const dirArq = path.join(DATA, 'projects', idArq);
  fs.mkdirSync(dirArq, { recursive: true });
  const arqArq = path.join(dirArq, 'project.json');
  const projArq = {
    id: idArq,
    titulo: 'Projeto Arquivado com Plano',
    pedido: 'Criar algo',
    repo: REPO,
    modo: 'padrao',
    velocidade: 'auto',
    supervisao: 'automatico',
    auto: false,
    criado: new Date().toISOString(),
    arquivado: true,
    arquivadoEm: new Date().toISOString(),
    estado: 'plano_pronto',
    mensagens: [],
    plano: {
      resumo: 'Plano teste',
      tarefas: [{ id: 't1', titulo: 'T1', tipo: 'codigo', nivel: 'pesado', depende: [], prompt: 'Fazer t1' }],
    },
    uso: { chamadas: [] },
  };
  fs.writeFileSync(arqArq, JSON.stringify(projArq, null, 2), 'utf8');

  const rC = await post(`/api/projetos/${idArq}/agendar`, { executarEm: futuro });
  assert.equal(rC.status, 400);
  assert.equal(rC.json?.erro, 'o projeto está arquivado: desarquive antes de agendar');
  const salvoArq = JSON.parse(fs.readFileSync(arqArq, 'utf8'));
  assert.equal(salvoArq.arquivado, true, 'projeto não foi desarquivado ao falhar');
  assert.equal(salvoArq.agendamento, undefined, 'agendamento não foi salvo');

  // (d) projeto cancelado com plano, executarEm futuro -> 200, agendamento.ativo true, agendamento.acaoPrevista 'executar_de_novo' e texto começando com 'Vai executar o plano de novo às'
  const idCanc = '202611180003-cancelado-com-plano';
  const dirCanc = path.join(DATA, 'projects', idCanc);
  fs.mkdirSync(dirCanc, { recursive: true });
  const arqCanc = path.join(dirCanc, 'project.json');
  const projCanc = {
    id: idCanc,
    titulo: 'Projeto Cancelado com Plano',
    pedido: 'Criar algo',
    repo: REPO,
    modo: 'padrao',
    velocidade: 'auto',
    supervisao: 'automatico',
    auto: false,
    criado: new Date().toISOString(),
    estado: 'cancelado',
    mensagens: [],
    plano: {
      resumo: 'Plano teste cancelado',
      tarefas: [{ id: 't1', titulo: 'T1', tipo: 'codigo', nivel: 'pesado', depende: [], prompt: 'Fazer t1' }],
    },
    uso: { chamadas: [] },
  };
  fs.writeFileSync(arqCanc, JSON.stringify(projCanc, null, 2), 'utf8');

  const rD = await post(`/api/projetos/${idCanc}/agendar`, { executarEm: futuro });
  assert.equal(rD.status, 200);
  assert.equal(rD.json?.agendamento?.ativo, true);
  assert.equal(rD.json?.agendamento?.acaoPrevista, 'executar_de_novo');
  assert.ok(
    typeof rD.json?.agendamento?.texto === 'string' && rD.json.agendamento.texto.startsWith('Vai executar o plano de novo às'),
    `texto deve começar com 'Vai executar o plano de novo às', recebido: ${rD.json?.agendamento?.texto}`
  );
});
