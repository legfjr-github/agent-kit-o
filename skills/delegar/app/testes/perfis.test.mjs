import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ENTRY_RE } from '../modelos.mjs';
import { criarPerfis, validarNome, MAX_PERFIS } from '../perfis.mjs';

const LISTAS_TOPO = ['planner', 'fix', 'coord'];
const NIVEIS = ['pesado', 'volume', 'leve'];

// Imita o validarCustom do server.mjs.
function validar(c) {
  const errs = [];
  if (!c || typeof c !== 'object') return { errs: ['modo personalizado vazio'] };
  const out = { nome: 'Personalizado', tiers: {} };
  for (const k of [...LISTAS_TOPO, ...NIVEIS]) {
    const lista = LISTAS_TOPO.includes(k) ? c[k] : c.tiers?.[k];
    if (!Array.isArray(lista) || !lista.length || lista.length > 8) { errs.push(`${k}: informe de 1 a 8 modelos`); continue; }
    const ruins = lista.filter((e) => typeof e !== 'string' || !ENTRY_RE.test(e));
    if (ruins.length) { errs.push(`${k}: modelo inválido`); continue; }
    if (LISTAS_TOPO.includes(k)) out[k] = [...new Set(lista)]; else out.tiers[k] = [...new Set(lista)];
  }
  return { errs, custom: out };
}

const cfg = (extra = {}) => ({
  planner: ['claude:opus@high', 'agy:gemini-3.8-flash-high'],
  fix: ['claude:sonnet'],
  coord: ['claude:sonnet@medium'],
  tiers: { pesado: ['claude:sonnet@high'], volume: ['claude:sonnet', 'claude:haiku'], leve: ['claude:haiku'] },
  ...extra,
});

let raiz;
let n = 0;
before(() => { raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'delegar-perfis-')); });
after(() => { fs.rmSync(raiz, { recursive: true, force: true }); });

function novo() {
  const dir = path.join(raiz, `t${++n}`, 'DATA'); // pasta ainda não existe: a gravação precisa criá-la
  const arquivo = path.join(dir, 'perfis.json');
  return { dir, arquivo, p: criarPerfis({ arquivo, validar }) };
}
const sobras = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);

test('nomes válidos', () => {
  for (const nome of ['Econômico barato', 'Deploy seguro', 'A', 'x'.repeat(60), '  Com espaços nas pontas  ', 'v1.2_(teste)+a-b']) {
    const r = validarNome(nome);
    assert.equal(r.ok, true, nome);
    assert.equal(r.nome, nome.trim());
  }
  assert.equal(validarNome('Café').nome, 'Café'); // NFC
});

test('nomes inválidos', () => {
  const ruins = ['', '   ', 'x'.repeat(61), '__proto__', 'constructor', 'Prototype', 'hasOwnProperty', 'toString', 'valueOf',
    '../x', 'a/b', 'a\\b', '<script>alert(1)</script>', 'a\u0000b', 'a\tb', 'a\nb', 'a\r\nb', 'a  b', '.oculto', '-x', 123, null, undefined, {}, []];
  for (const nome of ruins) {
    const r = validarNome(nome);
    assert.equal(r.ok, false, String(JSON.stringify(nome)));
    assert.equal(typeof r.erro, 'string');
    if (typeof nome === 'string' && nome.length > 3) assert.ok(!r.erro.includes(nome), 'a mensagem não ecoa o nome');
  }
});

test('salvar, obter, listar e arquivo no formato esperado', () => {
  const { p, arquivo, dir } = novo();
  assert.deepEqual(p.listar(), []);
  assert.equal(p.aviso(), null);
  const r = p.salvar('Zebra', cfg());
  assert.equal(r.ok, true);
  assert.equal(r.criado, true);
  assert.equal(p.salvar('árvore', cfg()).ok, true);
  assert.equal(p.salvar('Abacate', cfg()).ok, true);
  assert.deepEqual(p.listar().map((x) => x.nome), ['Abacate', 'árvore', 'Zebra']);
  assert.equal(p.obter('zEBRA').nome, 'Zebra');
  assert.equal(p.obter('nao existe'), null);
  assert.equal(p.obter('__proto__'), null);
  const bruto = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  assert.equal(bruto.versao, 1);
  assert.ok(Array.isArray(bruto.perfis));
  assert.deepEqual(Object.keys(bruto.perfis[0]).sort(), ['atualizado', 'criado', 'custom', 'nome']);
  assert.ok(!Number.isNaN(Date.parse(bruto.perfis[0].criado)));
  assert.deepEqual(sobras(dir).filter((f) => f.includes('.tmp')), []);
});

test('grava o custom devolvido por validar, não o cfg recebido', () => {
  const { p } = novo();
  const r = p.salvar('Limpo', cfg({ lixo: 'x', __proto__: { y: 1 }, fix: ['claude:sonnet', 'claude:sonnet'] }));
  assert.equal(r.ok, true);
  assert.equal(p.obter('Limpo').custom.lixo, undefined);
  assert.deepEqual(p.obter('Limpo').custom.fix, ['claude:sonnet']);
});

test('duplicado com outra caixa: 409 sem sobrescrever, ok com sobrescrever', () => {
  const { p } = novo();
  const a = p.salvar('Deploy seguro', cfg());
  const r409 = p.salvar('deploy SEGURO', cfg({ fix: ['claude:haiku'] }));
  assert.equal(r409.ok, false);
  assert.equal(r409.status, 409);
  assert.deepEqual(p.obter('Deploy seguro').custom.fix, ['claude:sonnet']);
  const r = p.salvar('deploy SEGURO', cfg({ fix: ['claude:haiku'] }), { sobrescrever: true });
  assert.equal(r.ok, true);
  assert.equal(r.criado, false);
  assert.equal(p.listar().length, 1);
  assert.deepEqual(p.obter('Deploy seguro').custom.fix, ['claude:haiku']);
  assert.equal(p.obter('Deploy seguro').criado, a.perfil.criado);
});

test('renomear', () => {
  const { p } = novo();
  p.salvar('Um', cfg());
  p.salvar('Dois', cfg());
  const conflito = p.renomear('Um', 'dois');
  assert.deepEqual([conflito.ok, conflito.status], [false, 409]);
  const ausente = p.renomear('Tres', 'Quatro');
  assert.deepEqual([ausente.ok, ausente.status], [false, 404]);
  const ruim = p.renomear('Um', '../x');
  assert.deepEqual([ruim.ok, ruim.status], [false, 400]);
  const caixa = p.renomear('Um', 'UM');
  assert.equal(caixa.ok, true);
  assert.equal(caixa.perfil.nome, 'UM');
  const novoNome = p.renomear('uM', 'Cinco');
  assert.equal(novoNome.ok, true);
  assert.deepEqual(p.listar().map((x) => x.nome), ['Cinco', 'Dois']);
});

test('excluir e excluir de novo', () => {
  const { p } = novo();
  p.salvar('Apagar', cfg());
  assert.deepEqual(p.excluir('apagar'), { ok: true });
  const de_novo = p.excluir('Apagar');
  assert.deepEqual([de_novo.ok, de_novo.status], [false, 404]);
  assert.equal(p.excluir('a/b').status, 400);
  assert.deepEqual(p.listar(), []);
});

test('limite de 50 perfis', () => {
  const { p } = novo();
  for (let i = 0; i < MAX_PERFIS; i++) assert.equal(p.salvar(`Perfil ${i}`, cfg()).ok, true, String(i));
  const r = p.salvar('Perfil extra', cfg());
  assert.deepEqual([r.ok, r.status, r.erro], [false, 400, 'limite de 50 perfis']);
  assert.equal(p.salvar('perfil 7', cfg(), { sobrescrever: true }).ok, true);
  assert.equal(p.listar().length, MAX_PERFIS);
});

test('cadeia inválida: 400 e arquivo intacto', () => {
  const { p, arquivo } = novo();
  p.salvar('Base', cfg());
  const antes = fs.readFileSync(arquivo, 'utf8');
  const invalidas = [
    cfg({ fix: ['claude:opus; calc'] }),
    cfg({ fix: ['evil:x'] }),
    cfg({ planner: Array.from({ length: 9 }, () => 'claude:haiku') }),
    cfg({ coord: [] }),
    cfg({ planner: 'claude:haiku' }),
    cfg({ tiers: { pesado: { 0: 'claude:haiku' }, volume: ['claude:haiku'], leve: ['claude:haiku'] } }),
    null, 'texto', [],
  ];
  for (const c of invalidas) {
    for (const opcoes of [{}, { sobrescrever: true }]) {
      const r = p.salvar('Novo', c, opcoes);
      assert.equal(r.ok, false);
      assert.equal(r.status, 400);
      assert.equal(typeof r.erro, 'string');
      assert.equal(p.salvar('Base', c, { sobrescrever: true }).status, 400);
    }
  }
  assert.ok(p.salvar('Novo', cfg({ fix: ['claude:opus; calc'], coord: [] })).erro.includes('; '), 'erros juntados por "; "');
  assert.equal(fs.readFileSync(arquivo, 'utf8'), antes);
  assert.equal(p.obter('Novo'), null);
});

test('arquivo corrompido: lista vazia, aviso e cópia .corrompido-* na próxima gravação', () => {
  const { p, arquivo, dir } = novo();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(arquivo, '{ isto não é json');
  assert.deepEqual(p.listar(), []);
  assert.equal(typeof p.aviso(), 'string');
  assert.ok(p.aviso().length > 0);
  assert.deepEqual(sobras(dir), ['perfis.json']); // leitura não mexe em nada
  assert.equal(p.salvar('Depois', cfg()).ok, true);
  const copias = sobras(dir).filter((f) => /^perfis\.json\.corrompido-\d{14}/.test(f));
  assert.equal(copias.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, copias[0]), 'utf8'), '{ isto não é json');
  assert.equal(p.aviso(), null);
  assert.deepEqual(p.listar().map((x) => x.nome), ['Depois']);
  assert.deepEqual(sobras(dir).filter((f) => f.endsWith('.tmp')), []);
});

test('formato errado (objeto indexado ou versão diferente) vira vazio com aviso', () => {
  for (const conteudo of ['[]', '{"versao":2,"perfis":[]}', '{"perfis":{"a":{}}}', 'null', '"x"']) {
    const { p, arquivo, dir } = novo();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(arquivo, conteudo);
    assert.deepEqual(p.listar(), [], conteudo);
    assert.ok(p.aviso(), conteudo);
  }
});

test('__proto__ no arquivo não polui nada e a entrada é ignorada', () => {
  const { p, arquivo, dir } = novo();
  fs.mkdirSync(dir, { recursive: true });
  const ok = { nome: 'Bom', custom: cfg(), criado: '2026-01-01T00:00:00.000Z', atualizado: '2026-01-02T00:00:00.000Z' };
  fs.writeFileSync(arquivo, `{ "__proto__": { "x": 1 }, "versao": 1, "perfis": [
    { "nome": "__proto__", "custom": ${JSON.stringify(cfg())} },
    { "nome": "constructor", "custom": ${JSON.stringify(cfg())} },
    { "nome": "Ruim", "custom": { "planner": ["evil:x"] } },
    ${JSON.stringify(ok)}
  ] }`);
  const lista = p.listar();
  assert.deepEqual(lista.map((x) => x.nome), ['Bom']);
  assert.equal(lista[0].criado, ok.criado);
  assert.equal(({}).x, undefined);
  assert.equal(Object.prototype.x, undefined);
  assert.match(p.aviso(), /3/);
  assert.equal(p.obter('__proto__'), null);
  assert.equal(p.salvar('Outro', cfg()).ok, true);
  assert.equal(({}).x, undefined);
  assert.deepEqual(p.listar().map((x) => x.nome), ['Bom', 'Outro']);
});

test('arquivo maior que 1 MB é ignorado com aviso', () => {
  const { p, arquivo, dir } = novo();
  fs.mkdirSync(dir, { recursive: true });
  const grande = JSON.stringify({ versao: 1, perfis: [{ nome: 'Bom', custom: cfg() }], enchimento: 'x'.repeat(1024 * 1024) });
  fs.writeFileSync(arquivo, grande);
  assert.deepEqual(p.listar(), []);
  assert.ok(p.aviso());
  assert.equal(p.salvar('Novo', cfg()).ok, true);
  assert.equal(sobras(dir).filter((f) => f.startsWith('perfis.json.corrompido-')).length, 1);
});

test('nenhum .tmp sobra e a pasta é criada na primeira gravação', () => {
  const { p, dir } = novo();
  assert.equal(fs.existsSync(dir), false);
  p.salvar('A', cfg());
  p.salvar('B', cfg());
  p.renomear('A', 'C');
  p.excluir('B');
  assert.deepEqual(sobras(dir), ['perfis.json']);
});
