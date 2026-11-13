import { test } from 'node:test';
import assert from 'node:assert'; // modo legado: deepEqual ignora o protótipo (arrays vêm de outro realm do vm)
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const aqui = dirname(fileURLToPath(import.meta.url));
const codigo = readFileSync(join(aqui, '..', 'public', 'fluxo.js'), 'utf8');
const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(codigo, ctx);
const F = ctx.window.DelegarFluxo;

const cfg = {
  planner: ['opus', 'sonnet'],
  tiers: { pesado: ['opus'], volume: ['sonnet', 'haiku'], leve: ['haiku'] },
  fix: ['sonnet'],
  coord: ['opus'],
};
const T = (id, tipo, nivel, depende = [], extra = {}) => ({ id, titulo: 'Título ' + id, tipo, nivel, depende, cadeiaEfetiva: ['m-' + id], ...extra });
const arestasDe = (g, tipo = 'normal') => g.arestas.filter((a) => a.tipo === tipo).map((a) => `${a.de}>${a.para}`);
const no = (g, id) => g.nos.find((n) => n.id === id);

test('expõe a API', () => {
  assert.deepEqual(Object.keys(F).sort(), ['assinatura', 'desenhar', 'montar', 'posicionar']);
});

test('sem plano: planner, três escritores, integrador, correção, coordenador e fim', () => {
  const g = F.montar({ cfg, plano: null, status: null });
  assert.deepEqual(g.nos.map((n) => n.rotulo).sort(),
    ['Coordenador de falhas', 'Correção', 'Escritores leve', 'Escritores pesado', 'Escritores volume', 'Fim', 'Integrador', 'Planejador']);
  const plan = g.nos.find((n) => n.rotulo === 'Planejador');
  assert.deepEqual(plan.modelos, ['opus', 'sonnet']);
  assert.equal(plan.camada, 0);
  const escritores = g.nos.filter((n) => n.rotulo.startsWith('Escritores'));
  assert.equal(escritores.length, 3);
  assert.ok(escritores.every((n) => n.camada === 1));
  assert.deepEqual(g.nos.find((n) => n.rotulo === 'Escritores pesado').modelos, ['opus']);
  assert.match(g.nos.find((n) => n.rotulo === 'Integrador').sub, /um por vez/);
  const corr = g.nos.find((n) => n.rotulo === 'Correção');
  const coord = g.nos.find((n) => n.rotulo === 'Coordenador de falhas');
  assert.ok(corr.lateral && coord.lateral);
  assert.deepEqual(corr.modelos, ['sonnet']);
  assert.deepEqual(coord.modelos, ['opus']);
  assert.equal(g.arestas.filter((a) => a.tipo === 'falha').length, 2);
  assert.ok(g.arestas.some((a) => a.para === g.nos.find((n) => n.rotulo === 'Fim').id));
});

test('volume alternado mostra as duas cadeias como alterna', () => {
  const g = F.montar({ cfg: { ...cfg, tiers: { ...cfg.tiers, volume: [['a', 'b'], ['c']] } }, plano: null, status: null });
  const v = g.nos.find((n) => n.rotulo === 'Escritores volume');
  assert.equal(v.sub, 'alterna');
  assert.equal(v.modelos.length, 2);
  assert.match(v.modelos[0], /a/);
  assert.match(v.modelos[1], /c/);
});

test('estado do planejador sem plano', () => {
  const est = (e) => F.montar({ cfg, plano: null, status: null, planejadorEstado: e }).nos[0].estado;
  assert.equal(est('pendente'), 'pendente');
  assert.equal(est('rodando'), 'rodando');
  assert.equal(est('concluido'), 'ok');
  assert.equal(est(undefined), 'neutro');
});

const plano3 = {
  tarefas: [T('w1', 'escritor', 'leve'), T('w2', 'escritor', 'volume'), T('w3', 'escritor', 'pesado'),
    T('i1', 'integrador', 'pesado', ['w1', 'w2']), T('i2', 'integrador', 'pesado', ['i1', 'w3'])],
};

test('plano: camadas topológicas e arestas', () => {
  const g = F.montar({ cfg, plano: plano3, status: null });
  assert.equal(no(g, 'w1').camada, 1);
  assert.equal(no(g, 'w2').camada, 1);
  assert.equal(no(g, 'w3').camada, 1);
  assert.equal(no(g, 'i1').camada, 2);
  assert.equal(no(g, 'i2').camada, 3);
  const normais = arestasDe(g);
  for (const e of ['w1>i1', 'w2>i1', 'i1>i2', 'w3>i2']) assert.ok(normais.includes(e), e);
  assert.ok(!normais.includes('w3>i1'));
  for (const id of ['w1', 'w2', 'w3']) assert.ok(normais.includes('_planejador>' + id));
  assert.ok(normais.includes('i2>_fim'));
  assert.equal(no(g, '_planejador').estado, 'ok');
  assert.equal(no(g, '_fim').camada, 4);
  assert.equal(no(g, 'i1').sub, 'integrador/pesado');
  assert.deepEqual(no(g, 'i1').modelos, ['m-i1']);
});

test('plano: modelo do status vence a cadeia efetiva', () => {
  const g = F.montar({ cfg, plano: plano3, status: { w1: { state: 'running', model: 'gemini-x' } } });
  assert.deepEqual(no(g, 'w1').modelos, ['gemini-x']);
  assert.equal(no(g, 'w1').estado, 'rodando');
});

test('ciclo não trava e vai para camada final', () => {
  const plano = { tarefas: [T('a', 'tarefa', 'leve'), T('b', 'tarefa', 'leve', ['c']), T('c', 'tarefa', 'leve', ['b']), T('d', 'tarefa', 'leve', ['a'])] };
  const g = F.montar({ cfg, plano, status: null });
  assert.equal(no(g, 'a').camada, 1);
  assert.equal(no(g, 'd').camada, 2);
  assert.equal(no(g, 'b').camada, 3);
  assert.equal(no(g, 'c').camada, 3);
  const p = F.posicionar(g, 800);
  assert.equal(p.nos.length, g.nos.length);
  const auto = { tarefas: [T('x', 'tarefa', 'leve', ['x'])] };
  assert.equal(no(F.montar({ cfg, plano: auto, status: null }), 'x').camada, 1);
});

test('dependência desconhecida é ignorada', () => {
  const g = F.montar({ cfg, plano: { tarefas: [T('a', 'tarefa', 'leve', ['fantasma'])] }, status: null });
  assert.equal(no(g, 'a').camada, 1);
  assert.ok(!g.arestas.some((a) => a.de === 'fantasma' || a.para === 'fantasma'));
  assert.ok(arestasDe(g).includes('_planejador>a'));
});

test('estados mapeados', () => {
  const plano = { tarefas: ['a', 'b', 'c', 'd', 'e', 'f'].map((i) => T(i, 'tarefa', 'leve')) };
  const status = { a: { state: 'pending' }, b: { state: 'waiting' }, c: { state: 'running' }, d: { state: 'done' }, e: { state: 'failed' }, f: { state: 'skipped' } };
  const g = F.montar({ cfg, plano, status });
  assert.deepEqual(['a', 'b', 'c', 'd', 'e', 'f'].map((i) => no(g, i).estado), ['pendente', 'aguardando', 'rodando', 'ok', 'falhou', 'pulada']);
  assert.equal(no(g, '_fim').estado, 'pendente');
  assert.equal(no(g, '_correcao').estado, 'neutro');
});

test('estado do fim e dos laterais', () => {
  const plano = { tarefas: [T('a', 'tarefa', 'leve'), T('b', 'tarefa', 'leve')] };
  const fim = (status) => no(F.montar({ cfg, plano, status }), '_fim').estado;
  assert.equal(fim({ a: { state: 'done' }, b: { state: 'skipped' } }), 'ok');
  assert.equal(fim({ a: { state: 'failed' }, b: { state: 'done' } }), 'falhou');
  assert.equal(fim({ a: { state: 'failed' }, b: { state: 'running' } }), 'pendente');
  const g = F.montar({ cfg, plano, status: { a: { state: 'running', note: 'fixing' } } });
  assert.equal(no(g, '_correcao').estado, 'rodando');
  assert.equal(no(g, '_coord').estado, 'rodando');
});

test('largura 360: nenhum nó passa da largura', () => {
  const plano = { tarefas: Array.from({ length: 9 }, (_, i) => T('t' + i, 'escritor', 'leve')).concat([T('i', 'integrador', 'pesado', ['t0', 't1'])]) };
  for (const larg of [360, 320, 200]) {
    const p = F.posicionar(F.montar({ cfg, plano, status: null }), larg);
    for (const n of p.nos) {
      assert.ok(n.x >= 0, `x>=0 em ${larg}`);
      assert.ok(n.x + n.w <= larg, `${n.id} passa de ${larg}: ${n.x + n.w}`);
    }
    assert.ok(p.largura >= larg);
  }
  const p = F.posicionar(F.montar({ cfg, plano, status: null }), 360);
  const porLinha = {};
  for (const n of p.nos) porLinha[n.y] = (porLinha[n.y] || 0) + 1;
  assert.ok(Object.values(porLinha).every((q) => q <= 2), 'no máximo 2 nós por linha abaixo de 480 px');
});

test('sem sobreposição de nós e altura cobre todos', () => {
  const p = F.posicionar(F.montar({ cfg, plano: plano3, status: null }), 900);
  for (const a of p.nos) {
    assert.ok(a.y + a.h <= p.altura);
    for (const b of p.nos) {
      if (a === b) continue;
      const sobrepoe = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert.ok(!sobrepoe, `${a.id} sobrepõe ${b.id}`);
    }
  }
  for (const ar of p.arestas) assert.equal(ar.pontos.length, 4);
});

test('12 escritores em 1280 px quebram em mais de uma linha', () => {
  const plano = { tarefas: Array.from({ length: 12 }, (_, i) => T('e' + i, 'escritor', 'leve')) };
  const p = F.posicionar(F.montar({ cfg, plano, status: null }), 1280);
  const escritores = p.nos.filter((n) => n.camada === 1);
  assert.equal(escritores.length, 12);
  assert.ok(new Set(escritores.map((n) => n.y)).size > 1);
  assert.ok(escritores.every((n) => n.x + n.w <= 1280));
});

test('título com <script> continua texto literal no rótulo', () => {
  const g = F.montar({ cfg, plano: { tarefas: [{ id: 'x1', titulo: '<script>alert(1)</script>', tipo: 'tarefa', nivel: 'leve', depende: [] }] }, status: null });
  assert.equal(no(g, 'x1').rotulo, 'x1 <script>alert(1)</script>');
});

test('título longo é cortado em 28 caracteres', () => {
  const g = F.montar({ cfg, plano: { tarefas: [T('x1', 'tarefa', 'leve', [], { titulo: 'a'.repeat(80) })] }, status: null });
  assert.equal(no(g, 'x1').rotulo.length, 'x1 '.length + 28);
});

test('assinatura estável e sensível ao que é desenhado', () => {
  const base = () => ({ cfg, plano: plano3, status: { w1: { state: 'running' } } });
  assert.equal(F.assinatura(base()), F.assinatura(base()));
  const outro = base(); outro.status.w1.state = 'done';
  assert.notEqual(F.assinatura(base()), F.assinatura(outro));
  const modelo = base(); modelo.status.w1.model = 'x';
  assert.notEqual(F.assinatura(base()), F.assinatura(modelo));
  const dep = base(); dep.plano = { tarefas: plano3.tarefas.map((t) => (t.id === 'i2' ? { ...t, depende: ['i1'] } : t)) };
  assert.notEqual(F.assinatura(base()), F.assinatura(dep));
  const cadeia = base(); cadeia.cfg = { ...cfg, fix: ['outro'] };
  assert.notEqual(F.assinatura(base()), F.assinatura(cadeia));
  assert.ok(F.assinatura(base()).length < 40);
  assert.notEqual(F.assinatura({ cfg, plano: null, status: null }), F.assinatura(base()));
});

test('dados vazios não quebram', () => {
  assert.doesNotThrow(() => F.posicionar(F.montar({}), 500));
  assert.doesNotThrow(() => F.assinatura(undefined));
});
