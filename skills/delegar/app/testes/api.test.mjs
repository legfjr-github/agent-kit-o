// Testes de ataque da API do painel Delegar (perfis e descoberta de modelos).
// Sobe o server.mjs real numa porta de teste, com DATA e cofre temporários e sem nenhum provedor de IA
// (DELEGAR_PROVEDORES=nenhum): nenhuma CLI real é chamada e nenhum planejador roda.
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
const PORT = Number(process.env.DELEGAR_TESTE_PORTA) || 8799;

let raiz, DATA, VAULT, REPO, TOKEN, filho, saida = '';

function req(method, url, { body, token = TOKEN, host = `127.0.0.1:${PORT}`, raw } = {}) {
  return new Promise((resolve, reject) => {
    const dados = raw !== undefined ? raw : body === undefined ? null : JSON.stringify(body);
    const headers = { Host: host };
    if (token !== null) headers['X-Delegar-Token'] = token;
    if (dados !== null) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(dados); }
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: url, headers }, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => {
        const txt = Buffer.concat(partes).toString('utf8');
        let json = null; try { json = JSON.parse(txt); } catch { /* corpo não é JSON */ }
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

const cfg = (extra = {}) => ({
  planner: ['agy:gemini-3.8-flash-high', 'claude:sonnet'],
  fix: ['claude:sonnet'],
  coord: ['claude:sonnet@medium'],
  tiers: { pesado: ['claude:sonnet@high'], volume: ['claude:sonnet', 'claude:haiku'], leve: ['claude:haiku'] },
  maxConcurrent: 2,
  ...extra,
});
const arqPerfis = () => path.join(DATA, 'perfis.json');
const lerPerfis = () => { try { return fs.readFileSync(arqPerfis(), 'utf8'); } catch { return null; } };

function matar() {
  if (!filho || filho.exitCode !== null || !filho.pid) return;
  try { execFileSync('taskkill', ['/PID', String(filho.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { try { filho.kill(); } catch { /* já saiu */ } }
}

before(async () => {
  raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'delegar-api-'));
  DATA = path.join(raiz, 'data'); VAULT = path.join(raiz, 'cofre'); REPO = path.join(raiz, 'repo');
  for (const d of [DATA, VAULT, REPO]) fs.mkdirSync(d, { recursive: true });
  try {
    const ocupada = await fetch(`http://127.0.0.1:${PORT}/api/saude`).then(() => true, () => false);
    assert.ok(!ocupada, `porta ${PORT} já está em uso por outro processo; libere-a ou defina DELEGAR_TESTE_PORTA`);
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

test('sem token ou com token errado: 401 em todas as rotas novas', async () => {
  const rotas = [['GET', '/api/perfis'], ['POST', '/api/perfis'], ['POST', '/api/perfis/renomear'], ['POST', '/api/perfis/excluir'], ['POST', '/api/modelos/atualizar']];
  for (const [m, u] of rotas) {
    for (const token of [null, '', 'errado', TOKEN + 'x', TOKEN.slice(0, -1)]) {
      const r = await req(m, u, { body: m === 'POST' ? { nome: 'x', custom: cfg() } : undefined, token });
      assert.equal(r.status, 401, `${m} ${u} com token ${JSON.stringify(token)}`);
    }
  }
  assert.equal(lerPerfis(), null, 'nada pode ter sido gravado');
});

test('Host diferente: 421', async () => {
  for (const host of ['evil.example', `evil.example:${PORT}`, '127.0.0.1:1', '[::1]:' + PORT]) {
    assert.equal((await get('/api/perfis', { host })).status, 421, host);
  }
});

test('método errado nas rotas novas: 405, depois do token', async () => {
  assert.equal((await req('DELETE', '/api/perfis')).status, 405);
  assert.equal((await req('PUT', '/api/perfis')).status, 405);
  assert.equal((await get('/api/perfis/renomear')).status, 405);
  assert.equal((await get('/api/perfis/excluir')).status, 405);
  assert.equal((await get('/api/modelos/atualizar')).status, 405);
  assert.equal((await req('DELETE', '/api/perfis', { token: null })).status, 401);
});

test('nomes só no corpo: caminho com nome não existe', async () => {
  for (const u of ['/api/perfis/Econ%C3%B4mico', '/api/perfis/..%2Fx', '/api/perfis/renomear/x', '/api/perfis/__proto__']) {
    const r = await post(u, { nome: 'x', custom: cfg() });
    assert.equal(r.status, 404, u);
  }
  assert.equal(lerPerfis(), null);
});

test('nomes maliciosos: 400 e perfis.json inalterado', async () => {
  const antes = lerPerfis();
  const nomes = ['__proto__', 'constructor', 'prototype', '../x', '..\\x', 'a/b', 'a\\b', '<script>alert(1)</script>', 'x'.repeat(61), '', '   ', 'com\u0000nulo', 'a\nb', 'a  b', null, 5, ['a'], { nome: 'a' }];
  for (const nome of nomes) {
    const r = await post('/api/perfis', { nome, custom: cfg() });
    assert.equal(r.status, 400, `nome ${JSON.stringify(nome)}`);
    assert.ok(r.json && typeof r.json.erro === 'string', 'resposta traz { erro }');
    assert.ok(!r.txt.includes('<script>'), 'o nome não é devolvido sem escape');
  }
  for (const [de, para] of [['__proto__', 'ok'], ['ok', '../x'], ['a/b', 'c'], ['', 'c'], ['c', 'x'.repeat(61)]]) {
    assert.equal((await post('/api/perfis/renomear', { de, para })).status, 400, `${de} -> ${para}`);
  }
  for (const nome of ['__proto__', '../x', '', '<b>']) assert.equal((await post('/api/perfis/excluir', { nome })).status, 400, nome);
  assert.equal(lerPerfis(), antes);
  const lista = await get('/api/perfis');
  assert.deepEqual(lista.json.perfis, []);
  assert.equal(Object.getPrototypeOf(lista.json.perfis), Array.prototype);
  assert.equal({}.polluido, undefined, 'o servidor não foi poluído por __proto__ no corpo');
});

test('corpo com __proto__ não polui o servidor', async () => {
  const r = await req('POST', '/api/perfis', { raw: '{"nome":"Poluido","__proto__":{"isAdmin":true},"custom":{"__proto__":{"x":1}}}' });
  assert.equal(r.status, 400);
  assert.equal((await get('/api/perfis')).status, 200);
});

test('cadeia inválida: 400 e nada gravado', async () => {
  const antes = lerPerfis();
  const ruins = [
    cfg({ planner: ['claude:opus; calc'] }),
    cfg({ planner: ['evil:x'] }),
    cfg({ planner: ['claude:a b'] }),
    cfg({ planner: ['claude:../../x'] }),
    cfg({ planner: Array.from({ length: 9 }, (_, i) => `claude:m${i}`) }),
    cfg({ planner: [] }),
    cfg({ planner: 'claude:sonnet' }),
    cfg({ planner: [5] }),
    cfg({ tiers: { pesado: ['claude:sonnet'], volume: [], leve: ['claude:haiku'] } }),
    cfg({ tiers: undefined }),
    [], 'texto', 7, null,
  ];
  for (const custom of ruins) {
    const r = await post('/api/perfis', { nome: 'Ruim', custom });
    assert.equal(r.status, 400, JSON.stringify(custom)?.slice(0, 80));
    assert.ok(typeof r.json.erro === 'string');
  }
  assert.equal((await post('/api/perfis', { nome: 'Sem custom' })).status, 400);
  assert.equal(lerPerfis(), antes);
});

test('perfil válido: 201, duplicado com outra caixa 409, sobrescrever 200', async () => {
  let r = await post('/api/perfis', { nome: 'Econômico barato', custom: cfg() });
  assert.equal(r.status, 201);
  assert.equal(r.json.perfil.nome, 'Econômico barato');
  assert.equal(r.json.perfil.custom.planner[0], 'agy:gemini-3.8-flash-high');

  r = await post('/api/perfis', { nome: 'ECONÔMICO BARATO', custom: cfg() });
  assert.equal(r.status, 409);
  r = await post('/api/perfis', { nome: 'econômico barato', custom: cfg(), sobrescrever: 'true' });
  assert.equal(r.status, 409, 'só true booleano sobrescreve');

  r = await post('/api/perfis', { nome: 'econômico barato', custom: cfg({ planner: ['claude:haiku'] }), sobrescrever: true });
  assert.equal(r.status, 200);
  assert.equal(r.json.perfil.nome, 'econômico barato');
  assert.deepEqual(r.json.perfil.custom.planner, ['claude:haiku']);

  const lista = await get('/api/perfis');
  assert.equal(lista.status, 200);
  assert.equal(lista.json.perfis.length, 1);
  assert.equal(lista.json.aviso, null);
  assert.ok(lerPerfis().includes('"versao": 1'));
});

test('renomear e excluir', async () => {
  assert.equal((await post('/api/perfis', { nome: 'Outro', custom: cfg() })).status, 201);
  assert.equal((await post('/api/perfis/renomear', { de: 'Outro', para: 'ECONÔMICO BARATO' })).status, 409);
  assert.equal((await post('/api/perfis/renomear', { de: 'Inexistente', para: 'Novo' })).status, 404);
  let r = await post('/api/perfis/renomear', { de: 'Outro', para: 'Renomeado' });
  assert.equal(r.status, 200);
  assert.equal(r.json.perfil.nome, 'Renomeado');
  assert.equal((await post('/api/perfis/excluir', { nome: 'Outro' })).status, 404);
  assert.equal((await post('/api/perfis/excluir', { nome: 'renomeado' })).status, 200);
  assert.equal((await post('/api/perfis/excluir', { nome: 'Renomeado' })).status, 404);
  const lista = await get('/api/perfis');
  assert.deepEqual(lista.json.perfis.map((p) => p.nome), ['econômico barato']);
});

test('corpo JSON inválido: 400; corpo grande não derruba o servidor', async () => {
  for (const raw of ['{', '{"nome":', 'não é json', '{"nome":"a",}']) {
    const r = await req('POST', '/api/perfis', { raw });
    assert.equal(r.status, 400, raw);
    assert.ok(typeof r.json.erro === 'string');
  }
  const grande = JSON.stringify({ nome: 'Grande', custom: cfg(), lixo: 'x'.repeat(1.5e6) });
  await req('POST', '/api/perfis', { raw: grande }).then((r) => assert.equal(r.status, 400), () => { /* o servidor pode cortar a conexão */ });
  await req('POST', '/api/perfis/excluir', { raw: grande }).then((r) => assert.equal(r.status, 400), () => {});
  assert.equal((await get('/api/saude', { token: null })).status, 200);
  assert.equal((await get('/api/perfis')).status, 200);
  assert.ok(!(await get('/api/perfis')).json.perfis.some((p) => p.nome === 'Grande'));
});

test('perfis.json corrompido: lista vazia com aviso, sem derrubar', async () => {
  const guardado = fs.readFileSync(arqPerfis(), 'utf8');
  fs.writeFileSync(arqPerfis(), '{ isto não é json');
  let r = await get('/api/perfis');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.perfis, []);
  assert.ok(r.json.aviso);
  fs.writeFileSync(arqPerfis(), guardado);
  r = await get('/api/perfis');
  assert.equal(r.json.perfis.length, 1);
  assert.equal(r.json.aviso, null);
});

test('projeto novo com perfil: inexistente 400, nome inválido 400, válido passa a validação (400 só por falta de CLI)', async () => {
  const base = { repo: REPO, pedido: 'pedido de teste do painel' };
  let r = await post('/api/projetos', { ...base, perfil: 'Não existe' });
  assert.equal(r.status, 400);
  assert.equal(r.json.erro, 'perfil não encontrado');
  r = await post('/api/projetos', { ...base, perfil: '../x' });
  assert.equal(r.status, 400);
  r = await post('/api/projetos', { ...base, perfil: 7 });
  assert.equal(r.status, 400);
  r = await post('/api/projetos', { ...base, perfil: 'Econômico barato' });
  assert.equal(r.status, 400);
  assert.match(r.json.erro, /nenhuma CLI de IA/, 'a validação do perfil passou e o servidor parou antes de chamar o planejador');
  assert.deepEqual(fs.readdirSync(path.join(DATA, 'projects')), [], 'nenhum projeto foi criado');
});

test('ajustes com perfil: aplica, devolve perfil e config; outro modo limpa', async () => {
  const id = '202611131200-teste-ab12';
  const dir = path.join(DATA, 'projects', id);
  fs.mkdirSync(dir, { recursive: true });
  const t = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({
    id, titulo: 'Projeto de teste', tituloFixo: false, pedido: 'pedido de teste', repo: REPO, modo: 'padrao', auto: false, supervisao: 'automatico',
    criado: t, estado: 'conversando', mensagens: [{ papel: 'usuario', texto: 'pedido de teste', quando: t }], sessao: null, plano: null,
  }, null, 2));
  const url = `/api/projetos/${id}/ajustes`;

  let r = await post(url, { perfil: 'Não existe' });
  assert.equal(r.status, 400);
  assert.equal(r.json.erro, 'perfil não encontrado');
  r = await post(url, { perfil: '__proto__' });
  assert.equal(r.status, 400);

  r = await post(url, { perfil: 'ECONÔMICO barato' });
  assert.equal(r.status, 200);
  assert.equal(r.json.modo, 'personalizado');
  assert.equal(r.json.modoNome, 'Perfil: econômico barato');
  assert.equal(r.json.perfil, 'econômico barato');
  assert.deepEqual(r.json.config.planner, ['claude:haiku']);
  const salvo = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  assert.equal(salvo.perfil, 'econômico barato');
  assert.equal(salvo.custom.descricao, 'Perfil salvo econômico barato.');

  r = await get(`/api/projetos/${id}`);
  assert.equal(r.json.perfil, 'econômico barato');
  r = (await get('/api/projetos')).json.find((p) => p.id === id);
  assert.equal(r.perfil, 'econômico barato');

  r = await post(url, { modo: 'personalizado', custom: cfg() });
  assert.equal(r.status, 200);
  assert.equal(r.json.perfil, null, 'personalizado sem perfil desfaz o vínculo');
  await post(url, { perfil: 'econômico barato' });
  r = await post(url, { modo: 'padrao' });
  assert.equal(r.status, 200);
  assert.equal(r.json.perfil, null);
  assert.equal(r.json.modo, 'padrao');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')).perfil, undefined);

  // durante a execução, trocar de perfil é recusado
  const p = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  p.estado = 'executando'; p.pid = 0;
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(p));
  r = await post(url, { perfil: 'econômico barato' });
  assert.equal(r.status, 409);
});

test('POST /api/modelos/atualizar: 200 rápido com resultado; GET /api/modelos continua', async () => {
  const ini = Date.now();
  const r = await post('/api/modelos/atualizar', {});
  assert.equal(r.status, 200);
  assert.ok(Date.now() - ini < 5000, 'sem provedores a descoberta termina na hora');
  assert.ok(r.json.resultado && Array.isArray(r.json.resultado.novos) && typeof r.json.resultado.erros === 'object');
  assert.ok(Array.isArray(r.json.modelos) && Array.isArray(r.json.desespero) && r.json.descoberta);
  const c = await get('/api/modelos');
  assert.equal(c.status, 200);
  assert.ok(Array.isArray(c.json.modelos));
  assert.equal((await post('/api/modelos/atualizar/x', {})).status, 404);
});

test('segurança: URL inválida (//) recebe 400 e não deixa a requisição pendurada', async () => {
  for (const u of ['//', '//a:b', '//[']) {
    const r = await req('GET', u).then((x) => x, (e) => ({ erro: e }));
    assert.ok(!r.erro, `${u}: sem resposta (${r.erro && r.erro.message})`);
    assert.equal(r.status, 400, u);
  }
  assert.equal((await get('/api/perfis')).status, 200);
});

test('segurança: mensagem de erro não devolve o valor enviado', async () => {
  const marca = '<script>alert(7)</script>';
  for (const custom of [cfg({ planner: [`claude:${marca}`] }), cfg({ fix: ['evil:x'] }), cfg({ tiers: { pesado: ['claude:-x'], volume: ['claude:a//b'], leve: ['claude:..'] } })]) {
    const r = await post('/api/perfis', { nome: 'Eco', custom });
    assert.equal(r.status, 400);
    assert.ok(!r.txt.includes('script') && !r.txt.includes('evil') && !r.txt.includes('//b'), r.txt);
  }
  assert.ok(!(await get('/api/perfis')).json.perfis.some((p) => p.nome === 'Eco'));
});

test('segurança: modelo com "-" na frente, "//", "." ou ".." é recusado na cadeia', async () => {
  for (const m of ['claude:-x', 'claude:--model', 'opencode:a//b', 'opencode:a/', 'opencode:./x', 'opencode:a/../b', 'agy:..', 'claude:']) {
    const r = await post('/api/perfis', { nome: 'Ruim', custom: cfg({ planner: [m] }) });
    assert.equal(r.status, 400, m);
  }
});

test('segurança: modelos-descobertos.json com ids maliciosos escritos à mão some do catálogo', async () => {
  const arq = path.join(DATA, 'modelos-descobertos.json');
  const t = '2026-11-01T00:00:00.000Z';
  const ids = ['opencode:opencode/boa-free', 'claude:evil', 'opencode:../../x', 'opencode:-x', 'opencode:a//b', 'opencode:x@high', 'agy:MAIUSCULA',
    'opencode:opencode/a b-free', 'opencode:<img src=x onerror=alert(1)>', 'opencode:__proto__/x', 'evil:modelo', 'opencode:' + 'a'.repeat(200)];
  const modelos = ids.map((id) => ({ id, primeiraVez: t, ultimaVez: t }));
  modelos.push({ id: 5 }, null, 'texto', { id: ['opencode:opencode/lista-free'] });
  const erros = { agy: '\u001b[31mfalha\u001b[0m\u0007 do agy', __proto__: 'x', constructor: 'y', outro: 'z' };
  fs.writeFileSync(arq, JSON.stringify({ versao: 1, atualizado: t, modelos, erros }).replace('"agy":', '"__proto__":"p","agy":'));
  try {
    const r = await post('/api/modelos/atualizar', {});
    assert.equal(r.status, 200);
    const achados = r.json.modelos.map((m) => m.id);
    assert.ok(achados.includes('opencode:opencode/boa-free'), 'o id bom entra');
    for (const ruim of ids.slice(1)) assert.ok(!achados.includes(ruim), `não pode entrar: ${ruim}`);
    assert.ok(!r.txt.includes('onerror') && !r.txt.includes('evil'), 'nada do malicioso na resposta');
    for (const id of r.json.desespero) assert.ok(/^(claude|agy|opencode):[A-Za-z0-9]/.test(id), id);
    assert.deepEqual(r.json.descoberta.novos, ['opencode:opencode/boa-free']);
    assert.deepEqual(Object.keys(r.json.descoberta.erros).sort(), []);
    assert.equal({}.p, undefined);
  } finally {
    fs.rmSync(arq, { force: true });
  }
});

test('segurança: modelos-descobertos.json acima de 1 MB é guardado à parte e ignorado', async () => {
  const arq = path.join(DATA, 'modelos-descobertos.json');
  const lixo = JSON.stringify({ versao: 1, atualizado: '2026-11-01T00:00:00.000Z', erros: {}, modelos: [{ id: 'opencode:opencode/grande-free', primeiraVez: '2026-11-01T00:00:00.000Z' }], lixo: 'x'.repeat(1.2e6) });
  fs.writeFileSync(arq, lixo);
  const r = await post('/api/modelos/atualizar', {});
  assert.equal(r.status, 200);
  assert.ok(!r.json.modelos.some((m) => m.id === 'opencode:opencode/grande-free'));
  const sobras = fs.readdirSync(DATA).filter((f) => f.startsWith('modelos-descobertos.json.corrompido-'));
  assert.equal(sobras.length, 1);
  for (const f of sobras) fs.rmSync(path.join(DATA, f), { force: true });
  assert.equal((await get('/api/saude', { token: null })).status, 200);
});

// ---------- cotas ----------
const arqCotas = () => path.join(DATA, 'state', 'quota-last.json');
const arqContador = () => path.join(DATA, 'state', 'contador.txt');
const execucoes = () => { try { return fs.readFileSync(arqContador(), 'utf8').split(/\r?\n/).filter(Boolean).length; } catch { return 0; } };
const linhaDe = (r, chave) => r.json.linhas.find((l) => l.chave === chave);
async function esperarCotas(url, pronto, ms = 15000) {
  const limite = Date.now() + ms;
  let r;
  do {
    r = await get(url);
    if (pronto(r)) return r;
    await new Promise((x) => setTimeout(x, 300));
  } while (Date.now() < limite);
  throw new Error(`cotas não ficaram prontas: ${r.txt.slice(0, 300)}`);
}

test('cotas: sem token ou com token errado, 401 nas três rotas', async () => {
  const rotas = [['GET', '/api/cotas'], ['POST', '/api/cotas/atualizar'], ['GET', '/api/projetos/qualquer/cotas']];
  for (const [m, u] of rotas) {
    for (const token of [null, '', 'errado', TOKEN + 'x']) {
      assert.equal((await req(m, u, { body: m === 'POST' ? {} : undefined, token })).status, 401, `${m} ${u} ${JSON.stringify(token)}`);
    }
  }
  assert.equal(execucoes(), 0, 'sem token, o script não roda');
});

test('cotas: método errado 405 e subcaminho extra 404', async () => {
  assert.equal((await req('PUT', '/api/cotas')).status, 405);
  assert.equal((await req('DELETE', '/api/cotas')).status, 405);
  assert.equal((await post('/api/cotas', {})).status, 405);
  assert.equal((await get('/api/cotas/atualizar')).status, 405);
  assert.equal((await req('PUT', '/api/cotas/atualizar')).status, 405);
  assert.equal((await get('/api/cotas/x/y')).status, 404);
  assert.equal((await post('/api/cotas/atualizar/x', {})).status, 404);
  assert.equal((await get('/api/cotas/outra')).status, 404);
  assert.equal(execucoes(), 0, 'nenhuma dessas chamadas dispara leitura');
});

test('cotas: GET sem cache responde na hora com lendo:true e depois traz as linhas', async () => {
  const ini = Date.now();
  const r = await get('/api/cotas');
  assert.equal(r.status, 200);
  assert.ok(Date.now() - ini < 1500, 'responde sem esperar o script');
  assert.equal(r.json.lendo, true);
  assert.equal(r.json.erro, null);
  assert.equal(linhaDe(r, 'claude-5h').restante, null);
  const p = await esperarCotas('/api/cotas', (x) => x.json.lendo === false && x.json.lidoEm);
  assert.equal(p.json.erro, null);
  assert.equal(linhaDe(p, 'gemini-5h').restante, 0.9);
  assert.ok(Math.abs(linhaDe(p, 'claude-5h').restante - 0.15) < 1e-9);
  assert.equal(linhaDe(p, 'gemini-semanal').restante, 0.55);
  assert.equal(linhaDe(p, 'argon-semanal').restante, 0.84);
  assert.equal(linhaDe(p, 'agy-claude-gpt-5h').restante, 1);
  assert.deepEqual(p.json.linhas.map((l) => l.chave), ['claude-5h', 'claude-semanal', 'gemini-5h', 'gemini-semanal', 'argon-semanal', 'agy-claude-gpt-5h', 'agy-claude-gpt-semanal', 'opencode']);
  assert.ok(p.json.idadeMin <= 1);
  for (const v of Object.values(p.json.provedores)) assert.equal(typeof v, 'boolean', 'provedores só dizem se existe, sem caminho');
  assert.equal(execucoes(), 1, 'uma só leitura');
  await get('/api/cotas'); // cache fresco: não dispara outra leitura
  await new Promise((x) => setTimeout(x, 400));
  assert.equal(execucoes(), 1);
});

test('cotas: rota do projeto usa o cache e marca o modelo em uso', async () => {
  const id = '202611131300-cotas-cd34';
  const dir = path.join(DATA, 'projects', id);
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  const t = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({
    id, titulo: 'Projeto de cotas', pedido: 'pedido de teste', repo: REPO, modo: 'padrao', auto: false, supervisao: 'automatico',
    criado: t, estado: 'executando', pid: 0, mensagens: [], sessao: null,
    plano: { tarefas: [{ id: 't1', titulo: 'Tarefa', tipo: 'codigo', nivel: 'volume', depende: [] }] },
  }));
  fs.writeFileSync(path.join(dir, 'logs', 'status.json'), JSON.stringify({ t1: { state: 'running', model: 'agy:gemini-3.8-flash-high', started: t } }));
  try {
    const r = await get(`/api/projetos/${id}/cotas`);
    assert.equal(r.status, 200);
    assert.equal(r.json.lendo, false);
    const gem = r.json.linhas.filter((l) => l.grupo === 'gemini');
    assert.equal(gem.length, 2);
    assert.ok(gem.every((l) => l.atual === true && l.modelosAtuais[0].tarefa === 't1'));
    const cla = r.json.linhas.filter((l) => l.grupo === 'claude');
    assert.ok(cla.length === 2 && cla.every((l) => l.atual === false && l.modelosAtuais.length === 0));
    assert.equal((await post(`/api/projetos/${id}/cotas`, {})).status, 405);
    assert.equal((await get(`/api/projetos/${id}/cotas/x`)).status, 404);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cotas: dois POST simultâneos rodam uma leitura só; o seguinte, em menos de 30 s, recebe o aviso', async () => {
  const antes = execucoes();
  const velho = JSON.parse(fs.readFileSync(arqCotas(), 'utf8'));
  await new Promise((x) => setTimeout(x, 1100)); // o campo time muda a cada segundo
  const [a, b] = await Promise.all([post('/api/cotas/atualizar', {}), post('/api/cotas/atualizar', {})]);
  for (const r of [a, b]) {
    assert.equal(r.status, 200);
    assert.equal(r.json.lendo, false);
    assert.equal(r.json.erro, null);
    assert.equal(r.json.aviso, null);
    assert.equal(linhaDe(r, 'gemini-5h').restante, 0.9);
  }
  assert.equal(execucoes(), antes + 1, 'uma única leitura para os dois pedidos');
  assert.notEqual(JSON.parse(fs.readFileSync(arqCotas(), 'utf8')).time, velho.time, 'o arquivo foi regravado');
  const c = await post('/api/cotas/atualizar', {});
  assert.equal(c.status, 200);
  assert.equal(c.json.aviso, 'leitura recente; aguarde');
  assert.equal(c.json.linhas.length, 8);
  assert.equal(execucoes(), antes + 1, 'o terceiro não rodou o script');
});

test('cotas: falha do script devolve erro genérico, sem texto do script, e o servidor continua de pé', async () => {
  const j = JSON.parse(fs.readFileSync(arqCotas(), 'utf8'));
  j.time = new Date(Date.now() - 3600e3).toLocaleString('sv-SE').replace(' ', 'T'); // cache com 1 h, em hora local como o quota.ps1 grava
  fs.writeFileSync(arqCotas(), JSON.stringify(j));
  fs.writeFileSync(path.join(DATA, 'state', 'falhar'), '');
  try {
    const r = await get('/api/cotas');
    assert.equal(r.json.lendo, true);
    const p = await esperarCotas('/api/cotas', (x) => x.json.lendo === false);
    assert.equal(p.json.erro, 'falha ao ler as cotas');
    assert.ok(!p.txt.includes('SEGREDO') && !p.txt.includes('simulada'), p.txt);
    assert.equal(p.json.linhas.length, 8, 'as linhas do cache antigo continuam');
    const n = execucoes();
    await get('/api/cotas');
    await new Promise((x) => setTimeout(x, 400));
    assert.equal(execucoes(), n, 'depois de uma falha, não tenta de novo a cada GET');
  } finally {
    fs.rmSync(path.join(DATA, 'state', 'falhar'), { force: true });
  }
  assert.equal(filho.exitCode, null);
  assert.equal((await get('/api/saude', { token: null })).status, 200);
});

test('cotas: GET /api/projetos/<inexistente>/cotas é 404, também com id malformado', async () => {
  const r = await get('/api/projetos/202611130000-nada-0000/cotas');
  assert.equal(r.status, 404);
  assert.equal(r.json.erro, 'projeto não encontrado');
  assert.equal((await get('/api/projetos/..%2Fx/cotas')).status, 404);
});

test('painel segue de pé no fim', async () => {
  assert.equal((await get('/api/saude', { token: null })).status, 200);
  assert.equal(filho.exitCode, null, 'o processo do servidor continua rodando');
});
