// Testes da descoberta de modelos. Sempre com dataDir temporário e CLIs injetadas: nunca chama as CLIs reais.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  analisarSaida, iniciarDescoberta, ehNovo, desesperoEfetivo, estadoDescoberta, catalogo,
  _reiniciarDescoberta, DESESPERO, ENTRY_RE, entradaValida,
} from '../modelos.mjs';

let dir;
const ARQ = () => path.join(dir, 'modelos-descobertos.json');
const lerArq = () => JSON.parse(fs.readFileSync(ARQ(), 'utf8'));
const PROV = { agy: 'agy-falso.exe', opencode: 'opencode-falso' };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  _reiniciarDescoberta();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegar-desc-'));
});
afterEach(() => {
  _reiniciarDescoberta();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('opencode: ANSI, cabeçalho, linha vazia e duplicatas', () => {
  const texto = [
    '\x1b[32mopencode/zeta-free\x1b[0m',
    'Available models:',
    '',
    'opencode/zeta-free',
    '  opencode/alfa-free  ',
    'nvidia/z-ai/glm-5.3-flash',
    'models',
  ].join('\r\n');
  assert.deepEqual(analisarSaida('opencode', texto), [
    'opencode:opencode/zeta-free', 'opencode:opencode/alfa-free', 'opencode:nvidia/z-ai/glm-5.3-flash',
  ]);
});

test('linhas maliciosas são descartadas', () => {
  const texto = [
    'opencode/x & calc', 'opencode/$(whoami)', '../../etc/passwd', `opencode/${'a'.repeat(200)}`, 'opencode/a b',
    'opencode/../x', 'opencode/ok-free',
  ].join('\n');
  const r = analisarSaida('opencode', texto);
  assert.deepEqual(r, ['opencode:opencode/ok-free']);
  assert.ok(r.every((id) => ENTRY_RE.test(id)));
});

test('agy: primeiro token da linha; claude devolve vazio', () => {
  const texto = 'gemini-9-teste-high   Gemini 9 (alto)\nGPT-Maiusculo x\n\nfoo$bar y\nmodelo-b.2\n';
  assert.deepEqual(analisarSaida('agy', texto), ['agy:gemini-9-teste-high', 'agy:modelo-b.2']);
  assert.deepEqual(analisarSaida('claude', 'opus\nsonnet'), []);
});

test('no máximo 400 ids', () => {
  const texto = Array.from({ length: 600 }, (_, i) => `opencode/m${i}-free`).join('\n');
  assert.equal(analisarSaida('opencode', texto).length, 400);
});

test('agy falha e opencode responde: erro só do agy', async () => {
  const executar = async (prov) => {
    if (prov === 'agy') throw new Error('agy quebrou\nlinha 2');
    return 'opencode/nova-free\n';
  };
  const r = await iniciarDescoberta({ dataDir: dir, provedores: PROV, executar });
  assert.equal(r.erros.agy, 'agy quebrou');
  assert.equal(r.erros.opencode, undefined);
  assert.deepEqual(r.novos, ['opencode:opencode/nova-free']);
  assert.deepEqual(lerArq().modelos.map((m) => m.id), ['opencode:opencode/nova-free']);
  assert.equal(lerArq().erros.agy, 'agy quebrou');
});

test('executar que nunca resolve: resolve com "tempo esgotado" dentro do limite', async () => {
  const t0 = Date.now();
  const r = await iniciarDescoberta({ dataDir: dir, timeoutMs: 300, provedores: PROV, executar: () => new Promise(() => {}) });
  assert.ok(Date.now() - t0 < 300 + 2000);
  assert.equal(r.erros.agy, 'tempo esgotado');
  assert.equal(r.erros.opencode, 'tempo esgotado');
  assert.deepEqual(r.novos, []);
});

test('segunda descoberta mantém primeiraVez e atualiza ultimaVez; antigos permanecem', async () => {
  await iniciarDescoberta({ dataDir: dir, provedores: PROV, executar: async (p) => (p === 'opencode' ? 'opencode/a-free\nopencode/b-free' : '') });
  const antes = Object.fromEntries(lerArq().modelos.map((m) => [m.id, m]));
  await espera(15);
  _reiniciarDescoberta(); // como um novo início do painel: só o arquivo restou
  const r = await iniciarDescoberta({ dataDir: dir, provedores: PROV, executar: async (p) => (p === 'opencode' ? 'opencode/a-free\nopencode/c-free' : '') });
  assert.deepEqual(r.novos, ['opencode:opencode/c-free']);
  const depois = Object.fromEntries(lerArq().modelos.map((m) => [m.id, m]));
  assert.equal(depois['opencode:opencode/a-free'].primeiraVez, antes['opencode:opencode/a-free'].primeiraVez);
  assert.ok(depois['opencode:opencode/a-free'].ultimaVez > antes['opencode:opencode/a-free'].ultimaVez);
  assert.deepEqual(depois['opencode:opencode/b-free'], antes['opencode:opencode/b-free']);
  assert.ok(depois['opencode:opencode/c-free']);
  assert.equal(lerArq().versao, 1);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
});

test('leitura síncrona no início mostra descobertas anteriores antes de terminar', async () => {
  fs.writeFileSync(ARQ(), JSON.stringify({
    versao: 1, atualizado: '2026-11-01T00:00:00.000Z', erros: {},
    modelos: [
      { id: 'opencode:opencode/velha-free', primeiraVez: '2026-11-01T00:00:00.000Z', ultimaVez: '2026-11-01T00:00:00.000Z' },
      { id: 'opencode:../../x', primeiraVez: '2026-11-01T00:00:00.000Z', ultimaVez: '2026-11-01T00:00:00.000Z' },
    ],
  }));
  let liberar;
  const trava = new Promise((r) => { liberar = r; });
  const p = iniciarDescoberta({ dataDir: dir, provedores: { opencode: 'x' }, executar: () => trava.then(() => '') });
  assert.equal(estadoDescoberta().emAndamento, true);
  const c = catalogo();
  const velha = c.modelos.find((m) => m.id === 'opencode:opencode/velha-free');
  assert.ok(velha && velha.novo === true && velha.descoberto === '2026-11-01T00:00:00.000Z');
  assert.ok(!c.modelos.some((m) => m.id.includes('..')));
  liberar();
  await p;
  assert.equal(estadoDescoberta().emAndamento, false);
  assert.ok(lerArq().modelos.some((m) => m.id === 'opencode:opencode/velha-free'));
});

test('arquivo corrompido é preservado e recomeça vazio', async () => {
  fs.writeFileSync(ARQ(), '{ isto não é json');
  const r = await iniciarDescoberta({ dataDir: dir, provedores: PROV, executar: async (p) => (p === 'opencode' ? 'opencode/n-free' : '') });
  const arquivos = fs.readdirSync(dir);
  const guardado = arquivos.find((f) => /^modelos-descobertos\.json\.corrompido-\d{14}$/.test(f));
  assert.ok(guardado, `esperava arquivo .corrompido-*, havia ${arquivos}`);
  assert.equal(fs.readFileSync(path.join(dir, guardado), 'utf8'), '{ isto não é json');
  assert.deepEqual(r.novos, ['opencode:opencode/n-free']);
  assert.deepEqual(lerArq().modelos.map((m) => m.id), ['opencode:opencode/n-free']);
});

test('desesperoEfetivo: começa com DESESPERO, só -free novos do opencode, sem duplicar', async () => {
  assert.deepEqual(desesperoEfetivo(), DESESPERO);
  const saidaOpencode = [
    'opencode/zeta-free', 'opencode/alfa-free', 'opencode/big-pickle', 'opencode/flint-40b-free',
    'opencode/pago-modelo', 'nvidia/z-ai/glm-5.3-flash',
  ].join('\n');
  await iniciarDescoberta({ dataDir: dir, provedores: PROV, executar: async (p) => (p === 'opencode' ? saidaOpencode : 'modelo-novo-free x') });
  const ef = desesperoEfetivo();
  assert.deepEqual(ef.slice(0, DESESPERO.length), DESESPERO);
  assert.deepEqual(ef.slice(DESESPERO.length), ['opencode:opencode/alfa-free', 'opencode:opencode/zeta-free']);
  assert.equal(new Set(ef).size, ef.length);
});

test('modelo de FIXOS ou das dicas não sai como novo', async () => {
  assert.equal(ehNovo('opencode:opencode/big-pickle'), false);
  assert.equal(ehNovo('agy:gemini-4-argon-high@high'), false);
  assert.equal(ehNovo('opencode:nvidia/z-ai/glm-5.3-flash'), false);
  assert.equal(ehNovo('agy:gemini-9-novo'), true);
  const r = await iniciarDescoberta({
    dataDir: dir, provedores: PROV,
    executar: async (p) => (p === 'agy' ? 'gemini-3.8-flash-high\ngemini-9-novo' : 'opencode/glm-5.3-flash-free\nopencode/outro-free'),
  });
  assert.deepEqual([...r.novos].sort(), ['agy:gemini-9-novo', 'opencode:opencode/outro-free']);
  assert.deepEqual([...estadoDescoberta().novos].sort(), ['agy:gemini-9-novo', 'opencode:opencode/outro-free']);
});

test('chamadas simultâneas chamam executar uma vez por provedor', async () => {
  const chamadas = [];
  const executar = async (prov) => { chamadas.push(prov); await espera(30); return prov === 'agy' ? 'gemini-9-x' : 'opencode/x-free'; };
  const a = iniciarDescoberta({ dataDir: dir, provedores: PROV, executar });
  const b = iniciarDescoberta({ dataDir: dir, provedores: PROV, executar });
  assert.equal(a, b);
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra, rb);
  assert.deepEqual(chamadas.sort(), ['agy', 'opencode']);
  // depois de terminar, uma nova descoberta volta a executar
  await iniciarDescoberta({ dataDir: dir, provedores: PROV, executar });
  assert.equal(chamadas.length, 4);
});

test('provedor ausente não é executado', async () => {
  const chamadas = [];
  await iniciarDescoberta({ dataDir: dir, provedores: { claude: 'c', agy: null, opencode: 'o' }, executar: async (p) => { chamadas.push(p); return ''; } });
  assert.deepEqual(chamadas, ['opencode']);
});

test('catalogo traz novo, descoberto, desespero e descoberta', async () => {
  await iniciarDescoberta({
    dataDir: dir, provedores: PROV,
    executar: async (p) => (p === 'agy' ? 'gemini-9-novo' : 'opencode/nova-free\nopencode/big-pickle'),
  });
  const c = catalogo();
  const nova = c.modelos.find((m) => m.id === 'opencode:opencode/nova-free');
  assert.equal(nova.novo, true);
  assert.equal(typeof nova.descoberto, 'string');
  assert.equal(nova.desespero, DESESPERO.length + 1);
  const fixo = c.modelos.find((m) => m.id === 'opencode:opencode/big-pickle');
  assert.equal(fixo.novo, false);
  assert.equal(fixo.descoberto !== null, true); // descoberto mas conhecido
  assert.equal(fixo.desespero, 2);
  assert.equal(c.modelos.filter((m) => m.id === 'opencode:opencode/big-pickle').length, 1);
  const semDescoberta = c.modelos.find((m) => m.id === 'claude:opus');
  assert.equal(semDescoberta.descoberto, null);
  assert.equal(semDescoberta.novo, false);
  assert.deepEqual(c.desespero, desesperoEfetivo());
  assert.equal(c.descoberta.emAndamento, false);
  assert.deepEqual([...c.descoberta.novos].sort(), ['agy:gemini-9-novo', 'opencode:opencode/nova-free']);
  // descobertos entram depois dos fixos do provedor
  const ids = c.modelos.filter((m) => m.provedor === 'opencode').map((m) => m.id);
  assert.ok(ids.indexOf('opencode:opencode/nova-free') > ids.indexOf('opencode:nvidia/z-ai/glm-5.3-flash'));
});

test('entradaValida: recusa "-" na frente, segmento vazio, "." e ".."; aceita os ids do kit', () => {
  for (const ruim of ['claude:-x', 'opencode:a//b', 'opencode:a/', 'opencode:./x', 'opencode:a/../b', 'agy:..', 'claude:', 'claude:a b', 'evil:x', 5, null, undefined, ['claude:opus']]) {
    assert.equal(entradaValida(ruim), false, String(ruim));
  }
  for (const bom of [...DESESPERO, 'claude:opus@xhigh', 'claude:claude-sonnet-5-5', 'agy:gemini-3.8-flash-high', 'opencode:nvidia/z-ai/glm-5.3-flash']) {
    assert.equal(entradaValida(bom), true, bom);
  }
});

test('arquivo escrito à mão: só ids que a descoberta aceitaria; erros só nas chaves conhecidas e sem escapes', async () => {
  const t = '2026-11-01T00:00:00.000Z';
  const ids = ['claude:evil', 'opencode:../../x', 'opencode:-x', 'opencode:a//b', 'opencode:x@high', 'agy:MAIUSCULA', 'opencode:<b>', 'evil:x'];
  fs.writeFileSync(ARQ(), JSON.stringify({
    versao: 1, atualizado: t,
    modelos: [{ id: 'opencode:opencode/ok-free', primeiraVez: t }, ...ids.map((id) => ({ id, primeiraVez: t })), { id: 7 }, null],
    erros: { agy: '\u001b[31mfalha\u001b[0m\u0007\u0000 ruim', opencode: 5, constructor: 'x', qualquer: 'y' },
  }));
  let liberar;
  const trava = new Promise((r) => { liberar = r; });
  const p = iniciarDescoberta({ dataDir: dir, provedores: { opencode: 'x' }, executar: () => trava.then(() => '') });
  const e = estadoDescoberta();
  assert.deepEqual(e.novos, ['opencode:opencode/ok-free']);
  assert.deepEqual(e.erros, { agy: 'falha ruim' });
  assert.deepEqual(catalogo().modelos.filter((m) => m.descoberto).map((m) => m.id), ['opencode:opencode/ok-free']);
  liberar();
  await p;
  assert.deepEqual(lerArq().modelos.map((m) => m.id), ['opencode:opencode/ok-free']);
});

test('arquivo acima de 1 MB é guardado à parte, sem ler e sem travar', async () => {
  fs.writeFileSync(ARQ(), JSON.stringify({ versao: 1, modelos: [{ id: 'opencode:opencode/grande-free' }], lixo: 'x'.repeat(1.2e6) }));
  const r = await iniciarDescoberta({ dataDir: dir, provedores: PROV, executar: async () => '' });
  assert.deepEqual(r.novos, []);
  assert.ok(fs.readdirSync(dir).some((f) => /\.corrompido-\d{14}$/.test(f)));
  assert.ok(!catalogo().modelos.some((m) => m.id.includes('grande-free')));
});

test('mensagem de erro da CLI sai sem escapes ANSI nem caracteres de controle', async () => {
  const r = await iniciarDescoberta({ dataDir: dir, provedores: { opencode: 'x' }, executar: async () => { throw new Error('\u001b[2J\u001b]0;titulo\u0007Falhou\u0000 feio\r\nsegunda linha'); } });
  assert.equal(r.erros.opencode, 'Falhou feio');
});

test('gratuitos descobertos entram no fim do desespero em no máximo 10', async () => {
  const lista = Array.from({ length: 30 }, (_, i) => `opencode/nova${String(i).padStart(2, '0')}-free`).join('\n');
  await iniciarDescoberta({ dataDir: dir, provedores: { opencode: 'x' }, executar: async () => lista });
  const ef = desesperoEfetivo();
  assert.equal(ef.length, DESESPERO.length + 10);
  assert.deepEqual(ef.slice(0, DESESPERO.length), DESESPERO);
});
