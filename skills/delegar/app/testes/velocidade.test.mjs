// Testes unitários para velocidade do projeto e esforço por tarefa.
// As funções são recortadas de server.mjs e avaliadas isoladas via new Function.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { entradaValida } from '../modelos.mjs';

let src = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
if (!src.includes('function comEsforco(')) {
  const fallback = new URL('../../../../../a-a722-w1-servidor/skills/delegar/app/server.mjs', import.meta.url);
  if (fs.existsSync(fallback)) src = fs.readFileSync(fallback, 'utf8');
}

const corte = (nome) => {
  const i = src.indexOf(`function ${nome}(`);
  assert.ok(i >= 0, `função ${nome} não encontrada`);
  const k = src.indexOf('\n}', i);
  return src.slice(i, k + 2);
};

const VELOCIDADE = {
  auto: 'Automático: esforço sugerido pelo planejador por tarefa; integração e verificação em médio (ou alto no modo agressivo).',
  rapido: 'Rápido: executores em esforço baixo (low); integração e verificação em médio (medium).',
  medio: 'Médio: executores, integração e verificação em esforço médio (medium).',
  demorado: 'Demorado: executores, integração e verificação em esforço alto (high).',
};

const temVel = (k) => typeof k === 'string' && Object.hasOwn(VELOCIDADE, k);
const velDe = (p) => (temVel(p?.velocidade) ? p.velocidade : 'auto');
const TIPOS = ['escritor', 'integrador', 'tarefa'];
const NIVEIS = ['pesado', 'volume', 'leve'];
const SUPERVISAO = {
  automatico: 'Automático: roda até o fim sem parar.',
  acompanhado: 'Acompanhado: para e pede confirmação nos momentos importantes (tarefas marcadas pelo planejador, primeira integração, recuperação de falha, troca para os modelos gratuitos).',
  passo: 'Passo a passo: pede confirmação antes de cada tarefa.',
};
const temSup = (k) => typeof k === 'string' && Object.hasOwn(SUPERVISAO, k);
const supDe = (p) => (temSup(p?.supervisao) ? p.supervisao : 'automatico');
const VAULT = 'C:\\cofre';
const isGitRepo = (repo) => repo === '/repo/git';
const detectar = () => ({ claude: true, agy: true, opencode: true });
const adaptar = (c) => [...new Set(c)];
const comReserva = (c) => [...new Set([...c, 'opencode:opencode/glm-5.3-flash-free', 'opencode:opencode/big-pickle'])];

const GH = 'agy:gemini-3.8-flash-high', GM = 'agy:gemini-3.8-flash-medium', GL = 'agy:gemini-3.8-flash-low', ARGON = 'agy:gemini-4-argon-high';
const D1 = 'opencode:opencode/glm-5.3-flash-free', D2 = 'opencode:opencode/big-pickle', D3 = 'opencode:opencode/minimax-m3.1-flash-free', D4 = 'opencode:opencode/iceman-free';

const MODES = {
  agressivo: {
    nome: 'Agressivo', descricao: 'Só Claude, esforço alto.',
    planner: ['claude:opus@xhigh', ARGON, D1],
    tiers: {
      pesado: ['claude:opus@high', 'claude:sonnet@high'],
      volume: ['claude:sonnet@high', 'claude:opus@medium', 'claude:haiku'],
      leve: ['claude:haiku', 'claude:sonnet@medium'],
    },
    fix: ['claude:opus@high', 'claude:sonnet@high'], coord: ['claude:opus@high', 'claude:sonnet@high'], maxConcurrent: 3,
  },
  equilibrado: {
    nome: 'Equilibrado', descricao: 'Opus planeja; Sonnet no que pede cuidado.',
    planner: ['claude:opus@high', ARGON, D1],
    tiers: {
      pesado: ['claude:sonnet@high', GH, 'claude:haiku'],
      volume: [['claude:sonnet@medium', GH, 'claude:haiku'], [GH, 'claude:sonnet@medium', 'claude:haiku']],
      leve: ['claude:haiku', GL, D1],
    },
    fix: ['claude:sonnet@high', GH], coord: ['claude:sonnet@medium', GH], maxConcurrent: 2,
  },
  padrao: {
    nome: 'Padrão (econômico)', descricao: 'Opus planeja; Gemini 3.8 Flash executa.',
    planner: ['claude:opus@high', ARGON, D1],
    tiers: {
      pesado: [GH, 'claude:sonnet', 'claude:haiku'],
      volume: [GH, 'claude:sonnet', 'claude:haiku'],
      leve: [D1, GL, GM, 'claude:haiku'],
    },
    fix: ['claude:sonnet', GH], coord: [GH, 'claude:sonnet'], maxConcurrent: 2,
  },
  desespero: {
    nome: 'Desespero (gratuitos)', descricao: 'Para quando a cota acabou.',
    planner: [D1, 'agy:gpt-oss-120b-medium', 'claude:sonnet@medium'],
    tiers: {
      pesado: [D1, D2, D3],
      volume: [[D1, D2, D3], [D2, D1, D4]],
      leve: [D2, D1],
    },
    fix: [D1, D2], coord: [D1, D2], maxConcurrent: 2,
  },
};

const cfgDe = (p) => (p?.modo && MODES[p.modo] ? MODES[p.modo] : MODES.padrao);

const {
  comEsforco,
  esforcoIntegracaoVerificacao,
  esforcoDaTarefa,
  chainFor,
  validatePlan,
  introducao,
} = new Function(
  'VELOCIDADE', 'temVel', 'velDe', 'TIPOS', 'NIVEIS', 'MODES', 'cfgDe', 'supDe', 'SUPERVISAO', 'VAULT', 'isGitRepo', 'detectar', 'entradaValida', 'adaptar', 'comReserva',
  `
  ${corte('comEsforco')}
  ${corte('esforcoIntegracaoVerificacao')}
  ${corte('esforcoDaTarefa')}
  ${corte('chainFor')}
  ${corte('validatePlan')}
  ${corte('introducao')}
  return { comEsforco, esforcoIntegracaoVerificacao, esforcoDaTarefa, chainFor, validatePlan, introducao };
  `
)(
  VELOCIDADE, temVel, velDe, TIPOS, NIVEIS, MODES, cfgDe, supDe, SUPERVISAO, VAULT, isGitRepo, detectar, entradaValida, adaptar, comReserva
);

test('comEsforco: modelos claude recebem sufixo de esforco', () => {
  assert.equal(comEsforco('claude:sonnet', 'low'), 'claude:sonnet@low');
  assert.equal(comEsforco('claude:opus@xhigh', 'medium'), 'claude:opus@medium');
  assert.equal(comEsforco('claude:opus@low', 'high'), 'claude:opus@high');
});

test('comEsforco: variantes de Haiku permanecem sem arroba de esforco', () => {
  assert.equal(comEsforco('claude:haiku', 'high'), 'claude:haiku');
  assert.equal(comEsforco('claude:claude-haiku-5-5', 'low'), 'claude:claude-haiku-5-5');
  assert.equal(comEsforco('claude:haiku@high', 'low'), 'claude:haiku');
  assert.equal(comEsforco('claude:haiku-3-5@medium', 'high'), 'claude:haiku-3-5');
});

test('comEsforco: modelos agy gemini e claude com esforco trocam o sufixo', () => {
  assert.equal(comEsforco('agy:gemini-3.8-flash-high', 'low'), 'agy:gemini-3.8-flash-low');
  assert.equal(comEsforco('agy:gemini-4-argon-low', 'high'), 'agy:gemini-4-argon-high');
  assert.equal(comEsforco('agy:claude-sonnet-5-5-high', 'medium'), 'agy:claude-sonnet-5-5-medium');
});

test('comEsforco: agy gpt-oss e opencode ficam como estao', () => {
  assert.equal(comEsforco('agy:gpt-oss-120b-medium', 'high'), 'agy:gpt-oss-120b-medium');
  assert.equal(comEsforco('agy:gpt-oss-120b-medium', 'low'), 'agy:gpt-oss-120b-medium');
  assert.equal(comEsforco('opencode:opencode/glm-5.3-flash-free', 'high'), 'opencode:opencode/glm-5.3-flash-free');
  assert.equal(comEsforco('opencode:opencode/big-pickle', 'low'), 'opencode:opencode/big-pickle');
});

test('comEsforco: array troca esforco e remove repetidos mantendo a ordem', () => {
  const lista = ['claude:sonnet', 'claude:sonnet@high', 'claude:haiku'];
  assert.deepEqual(comEsforco(lista, 'low'), ['claude:sonnet@low', 'claude:haiku']);

  const gemini = ['agy:gemini-3.8-flash-high', 'agy:gemini-3.8-flash-low'];
  assert.deepEqual(comEsforco(gemini, 'medium'), ['agy:gemini-3.8-flash-medium']);
});

test('comEsforco: nivel invalido devolve a entrada sem alteracao', () => {
  assert.equal(comEsforco('claude:sonnet', 'xhigh'), 'claude:sonnet');
  assert.equal(comEsforco('claude:sonnet', 'max'), 'claude:sonnet');
  assert.equal(comEsforco('claude:sonnet', ''), 'claude:sonnet');
  assert.equal(comEsforco('claude:sonnet', null), 'claude:sonnet');
});

test('velocidade rapido: escritor e tarefa ficam em low e integrador fica em medium', () => {
  const p = { velocidade: 'rapido' };
  assert.equal(esforcoDaTarefa(p, { tipo: 'escritor', esforco: 'high' }), 'low');
  assert.equal(esforcoDaTarefa(p, { tipo: 'tarefa', esforco: 'high' }), 'low');
  assert.equal(esforcoIntegracaoVerificacao(p), 'medium');
  assert.equal(esforcoDaTarefa(p, { tipo: 'integrador', esforco: 'high' }), 'medium');

  const cEscritor = chainFor(p, { tipo: 'escritor', nivel: 'volume' });
  assert.ok(cEscritor.includes('agy:gemini-3.8-flash-low'));
  assert.ok(cEscritor.includes('claude:sonnet@low'));
  assert.ok(cEscritor.includes('claude:haiku'));

  const cIntegrador = chainFor(p, { tipo: 'integrador', nivel: 'pesado' });
  assert.ok(cIntegrador.includes('agy:gemini-3.8-flash-medium'));
  assert.ok(cIntegrador.includes('claude:sonnet@medium'));
});

test('velocidade medio: escritor, tarefa e integrador ficam em medium', () => {
  const p = { velocidade: 'medio' };
  assert.equal(esforcoDaTarefa(p, { tipo: 'escritor', esforco: 'low' }), 'medium');
  assert.equal(esforcoDaTarefa(p, { tipo: 'tarefa', esforco: 'high' }), 'medium');
  assert.equal(esforcoIntegracaoVerificacao(p), 'medium');
  assert.equal(esforcoDaTarefa(p, { tipo: 'integrador', esforco: 'low' }), 'medium');
  assert.equal(esforcoDaTarefa(p, { tipo: 'integrador', esforco: 'high' }), 'medium');

  const cTarefa = chainFor(p, { tipo: 'tarefa', nivel: 'volume', esforco: 'high' });
  assert.ok(cTarefa.includes('agy:gemini-3.8-flash-medium'));
  assert.ok(cTarefa.includes('claude:sonnet@medium'));
});

test('velocidade demorado: escritor, tarefa e integrador ficam em high', () => {
  const p = { velocidade: 'demorado' };
  assert.equal(esforcoDaTarefa(p, { tipo: 'escritor', esforco: 'low' }), 'high');
  assert.equal(esforcoDaTarefa(p, { tipo: 'tarefa', esforco: 'low' }), 'high');
  assert.equal(esforcoIntegracaoVerificacao(p), 'high');
  assert.equal(esforcoDaTarefa(p, { tipo: 'integrador', esforco: 'low' }), 'high');

  const cTarefa = chainFor(p, { tipo: 'tarefa', nivel: 'volume', esforco: 'low' });
  assert.ok(cTarefa.includes('agy:gemini-3.8-flash-high'));
  assert.ok(cTarefa.includes('claude:sonnet@high'));
});

test('velocidade auto: tarefas respeitam esforco e integracao depende do modo', () => {
  const pPadrao = { modo: 'padrao', velocidade: 'auto' };
  assert.equal(esforcoDaTarefa(pPadrao, { tipo: 'escritor', esforco: 'high' }), 'high');
  assert.equal(esforcoDaTarefa(pPadrao, { tipo: 'tarefa', esforco: 'low' }), 'low');
  assert.equal(esforcoDaTarefa(pPadrao, { tipo: 'tarefa', esforco: 'medium' }), 'medium');
  assert.equal(esforcoDaTarefa(pPadrao, { tipo: 'tarefa' }), null);

  assert.equal(esforcoIntegracaoVerificacao(pPadrao), 'medium');
  assert.equal(esforcoDaTarefa(pPadrao, { tipo: 'integrador' }), 'medium');

  const pEquilibrado = { modo: 'equilibrado', velocidade: 'auto' };
  assert.equal(esforcoIntegracaoVerificacao(pEquilibrado), 'medium');

  const pAgressivo = { modo: 'agressivo', velocidade: 'auto' };
  assert.equal(esforcoIntegracaoVerificacao(pAgressivo), null);
  assert.equal(esforcoDaTarefa(pAgressivo, { tipo: 'integrador' }), null);
});

test('tarefa com cadeia explicita nao eh alterada em nenhuma velocidade', () => {
  const explicita = ['claude:opus@high', 'agy:gemini-3.8-flash-high'];
  for (const vel of ['rapido', 'medio', 'demorado', 'auto']) {
    const c = chainFor({ modo: 'padrao', velocidade: vel }, { cadeia: explicita, tipo: 'tarefa', esforco: 'low' });
    assert.deepEqual(c.slice(0, 2), explicita, `cadeia mantida na velocidade ${vel}`);
  }
});

test('chainFor: remocao de duplicados mantendo a ordem com reducao de esforco', () => {
  // No modo padrao, o tier leve eh [D1, GL, GM, 'claude:haiku'].
  // Em esforco low, GL (gemini-low) e GM (gemini-medium) viram ambos GL.
  const p = { modo: 'padrao', velocidade: 'rapido' };
  const c = chainFor(p, { tipo: 'tarefa', nivel: 'leve' });
  const ocorrenciasGL = c.filter((m) => m === 'agy:gemini-3.8-flash-low');
  assert.equal(ocorrenciasGL.length, 1, 'duplicado de gemini low removido');
  assert.equal(c[0], D1, 'ordem inicial preservada');
  assert.equal(c[1], 'agy:gemini-3.8-flash-low');
  assert.equal(c[2], 'claude:haiku');
});

test('validatePlan: aceita esforco valido ou ausente', () => {
  const base = {
    tarefas: [
      { id: 'w1', tipo: 'tarefa', nivel: 'volume', prompt: 'prompt com tamanho suficiente para passar' },
    ],
  };

  assert.deepEqual(validatePlan(base, true), []);
  assert.deepEqual(validatePlan({ tarefas: [{ ...base.tarefas[0], esforco: 'low' }] }, true), []);
  assert.deepEqual(validatePlan({ tarefas: [{ ...base.tarefas[0], esforco: 'medium' }] }, true), []);
  assert.deepEqual(validatePlan({ tarefas: [{ ...base.tarefas[0], esforco: 'high' }] }, true), []);
});

test('validatePlan: recusa esforco invalido com mensagem explicita', () => {
  const base = {
    tarefas: [
      { id: 'w1', tipo: 'tarefa', nivel: 'volume', prompt: 'prompt com tamanho suficiente para passar' },
    ],
  };

  for (const inv of ['xhigh', 'max', 'alto', '', 123, true, false, {}]) {
    const errs = validatePlan({ tarefas: [{ ...base.tarefas[0], esforco: inv }] }, true);
    assert.ok(errs.some((e) => e.includes('esforço inválido')), `recusa esforço ${JSON.stringify(inv)}`);
  }
});

test('introducao: exibe velocidade e orientacao correta', () => {
  const pAuto = { pedido: 'fazer x', repo: '/repo/git', modo: 'padrao', auto: false, velocidade: 'auto' };
  const txtAuto = introducao(pAuto);
  assert.ok(txtAuto.includes('Velocidade: auto (defina o esforço "low", "medium" ou "high" em cada tarefa do plano).'));

  for (const vel of ['rapido', 'medio', 'demorado']) {
    const pFixo = { pedido: 'fazer x', repo: '/repo/git', modo: 'padrao', auto: false, velocidade: vel };
    const txtFixo = introducao(pFixo);
    assert.ok(txtFixo.includes(`Velocidade: ${vel} (o esforço da execução já está fixado pelo usuário; o campo esforco nas tarefas será ignorado).`));
  }
});
