// Delegar: painel local para planejar com um modelo e executar com o pipeline (scripts/pipeline.ps1).
// Ouve só em 127.0.0.1. Toda chamada /api (exceto /api/saude) exige o cabeçalho X-Delegar-Token.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { entradaValida, QUOTA_RE, DESESPERO, adaptar, catalogo, detectar, desesperoEfetivo, iniciarDescoberta } from './modelos.mjs';
import { criarPerfis, validarNome } from './perfis.mjs';
import { linhasDeCotas, cotasDoProjeto } from './cotas.mjs';
import { registrarHistoricoCota, lerHistoricoCotas, coletarTentativasUso, estimarTokensPorCota } from './cotas-estimativa.mjs';
import { modeloSemEsforco, usoClaudeJson, usoOpencode, usoAgyStream, estimar, usoDaTentativa, usoAgyBrain, consolidarListaModelos } from './uso.mjs';
import {
  validarAgendamentoInput,
  aplicarAgendamentoNoProjeto,
  podeAgendar,
  avaliarAgendamentoProjeto,
  diagnosticarAgendamentoNaHora,
  marcarExecucaoAgendadaFalhou,
  marcarPlanejamentoAgendadoDisparado,
  marcarExecucaoAgendadaDisparada,
  resumoAgendamento,
} from './agendamento.mjs';
import {
  estimarDemandaPlano,
  recomendarAjusteModelos,
  aplicarPoliticaCotaAoProjeto,
} from './demanda-ajuste.mjs';
import {
  CATEGORIAS_DEMANDA,
  categoriaDemanda,
  cacheHistorico,
  montarHistoricoTarefas,
  linhaEstimativa,
} from './historico-estimativa.mjs';
import { carregarPrecos, custoUsd, assinaturaDe, emBrl, idadeDias, atualizarPrecos, atualizarSeVencido } from './precos.mjs';
import { lerUsoFora, usoForaVencido, usoForaNoPeriodo } from './uso-fora.mjs';
import {
  temRodadaExecutada,
  limparLogsRaiz,
  arquivarRodada,
  contextoRodadasParaPlanejador,
  dadosUsoProjetoComRodadas,
  migrarRodadas,
} from './rodadas.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function ehLoopback(endereco) {
  return typeof endereco === 'string' && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(endereco.trim());
}

export function validarHostEscuta(env = process.env, argv = process.argv) {
  const chavesEnv = ['DELEGAR_HOST', 'HOST', 'BIND_HOST'];
  for (const k of chavesEnv) {
    if (env && env[k] != null && String(env[k]).trim() !== '') {
      const v = String(env[k]).trim();
      if (v !== '127.0.0.1') {
        return { ok: false, erro: 'O painel Delegar só pode escutar em 127.0.0.1 (acesso exclusivo deste computador).' };
      }
    }
  }
  if (Array.isArray(argv)) {
    for (let i = 0; i < argv.length; i++) {
      const arg = String(argv[i]);
      for (const prefix of ['--host=', '--bind=', '-H=']) {
        if (arg.startsWith(prefix)) {
          const v = arg.slice(prefix.length).trim();
          if (v !== '127.0.0.1') {
            return { ok: false, erro: 'O painel Delegar só pode escutar em 127.0.0.1 (acesso exclusivo deste computador).' };
          }
        }
      }
      if (['--host', '--bind', '-H'].includes(arg)) {
        const proximo = argv[i + 1] != null ? String(argv[i + 1]).trim() : '';
        if (proximo !== '127.0.0.1') {
          return { ok: false, erro: 'O painel Delegar só pode escutar em 127.0.0.1 (acesso exclusivo deste computador).' };
        }
      }
    }
  }
  return { ok: true, host: '127.0.0.1' };
}

// server.log com data e hora e com o motivo da saída. Se o painel sumir sem a linha "painel saiu",
// o processo foi encerrado de fora (ex.: fechou a sessão do agente que o abriu).
for (const k of ['log', 'error']) { const orig = console[k].bind(console); console[k] = (...a) => orig(`[${new Date().toLocaleString('sv-SE')}]`, ...a); }
process.on('uncaughtException', (e) => { console.error('erro não tratado, o painel vai fechar:', e); process.exit(1); });
process.on('unhandledRejection', (e) => console.error('promessa rejeitada sem tratamento:', e));
for (const s of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(s, () => { console.log(`painel encerrado pelo sinal ${s}`); process.exit(0); });
process.on('exit', (c) => console.log(`painel saiu (código ${c}, pid ${process.pid})`));
const SCRIPTS = path.join(HERE, '..', 'scripts');
const QUOTA_SCRIPT = process.env.DELEGAR_QUOTA_SCRIPT || path.join(SCRIPTS, 'quota.ps1');
const PUBLIC = path.join(HERE, 'public');
const PORT = Number(process.env.DELEGAR_PORT) || 8790;
const HOME = os.homedir();
const DATA = process.env.DELEGAR_DATA || path.join(HOME, '.delegar');
const PROJ = path.join(DATA, 'projects');
// Cofre: variável de ambiente, depois o ambiente.json gravado pelo install.py, depois o caminho preenchido
// na instalação (String.raw: as barras invertidas do Windows não podem virar escapes de JS).
function cofre() {
  if (process.env.DELEGAR_VAULT) return process.env.DELEGAR_VAULT;
  try { const v = JSON.parse(fs.readFileSync(path.join(DATA, 'ambiente.json'), 'utf8')).vault; if (v && fs.existsSync(v)) return v; } catch {}
  const instalado = String.raw`{{VAULT_PATH}}`;
  return instalado.includes('{{') ? path.join(HOME, 'Documents', 'agent-kit', 'vault') : instalado;
}
const VAULT = cofre();
fs.mkdirSync(PROJ, { recursive: true });
const TOKEN_FILE = path.join(DATA, 'token');
if (!fs.existsSync(TOKEN_FILE)) fs.writeFileSync(TOKEN_FILE, crypto.randomBytes(24).toString('hex'));
const TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
const PLANNER_FILE = path.join(HERE, 'planner.md');
const CUSTOM_FILE = path.join(DATA, 'personalizado.json');
const PERFIS_FILE = path.join(DATA, 'perfis.json');

// ---------- modos ----------
// Modelos do Antigravity (o sufixo de esforço é trocado pela velocidade do projeto).
const H = 'agy:gemini-4-hydrogen-medium', N = 'agy:gemini-4-neon-medium', NH = 'agy:gemini-4-neon-high';
const F = 'agy:gemini-3.8-flash-medium', FL = 'agy:gemini-3.8-flash-low', ARGON = 'agy:gemini-4-argon-high';
const [D1, D2, D3, D4] = DESESPERO; // glm-5.3-flash, big-pickle, minimax-m3.1-flash, iceman (NVIDIA só depois deles)
const OPUS = 'claude:opus@medium', SONNET = 'claude:sonnet@medium', HAIKU = 'claude:haiku';
// Cadeias montadas com o benchmark de 19/11/2026 (mesmo plano, 5 tarefas ao mesmo tempo, esforço low, nota do Haiku):
//   Hydrogen 2 min 47 s nota 6 US$ 0,47 | Opus 3 min 38 s nota 7 US$ 2,37 | Sonnet 3 min 41 s nota 6 US$ 1,00
//   3.8 Flash 5 min 36 s nota 6 US$ 0,48 | Neon 5 min 43 s nota 7 | Argon 6 min 07 s nota 7 US$ 0,93
//   Haiku 6 min 20 s nota 7 (43 testes) US$ 0,27 | Hydrogen medium 9 min 16 s nota 7 | big-pickle 10 min nota 4 | NVIDIA ~10 h 45.
// Rápido põe na frente o mais rápido com nota aceitável (Hydrogen, Opus, Sonnet); demorado, o de melhor resultado
// mesmo que mais lento (Opus, Neon, Haiku); médio e automático ficam no meio. A reserva do Claude é o Gemini
// (Hydrogen, Neon, 3.8 Flash). O Argon tem cota própria e menor: fica no planejador. A NVIDIA grátis só no desespero.
export const MODES = {
  agressivo: {
    nome: 'Agressivo', descricao: 'Claude na frente: Opus planeja, corrige e faz o pesado, Sonnet e Opus executam, Haiku no mecânico; Gemini só de reserva. Mais rápido e mais caro.',
    planner: ['claude:opus@xhigh', NH, ARGON],
    tiers: {
      pesado: ['claude:opus@high', 'claude:sonnet@high', NH],
      volume: [SONNET, OPUS, HAIKU, H],
      leve: [HAIKU, SONNET, H],
    },
    porVelocidade: {
      rapido: { pesado: [OPUS, SONNET, H], volume: [OPUS, SONNET, H], leve: [SONNET, HAIKU, H] },
      demorado: { pesado: [OPUS, SONNET, N], volume: [OPUS, SONNET, N], leve: [HAIKU, SONNET, N] },
    },
    fix: ['claude:opus@high', 'claude:sonnet@high', NH], coord: ['claude:opus@high', 'claude:sonnet@high', NH], maxConcurrent: 3,
  },
  equilibrado: {
    nome: 'Equilibrado', descricao: 'Opus planeja; Sonnet no que pede cuidado; o volume alterna entre Haiku e Gemini Hydrogen, que juntos gastam pouco e repartem a cota; Neon no lugar do Sonnet quando ele falta.',
    planner: ['claude:opus@high', ARGON, NH],
    tiers: {
      pesado: ['claude:sonnet@high', NH, 'claude:opus@high'],
      volume: [[HAIKU, H, SONNET], [H, HAIKU, N]],
      leve: [HAIKU, FL, H],
    },
    porVelocidade: {
      rapido: { pesado: [SONNET, H, OPUS], volume: [[H, SONNET, HAIKU], [SONNET, H, HAIKU]], leve: [H, HAIKU, F] },
      demorado: { pesado: [OPUS, N, SONNET], volume: [[HAIKU, N, SONNET], [N, HAIKU, SONNET]], leve: [HAIKU, N, F] },
    },
    fix: ['claude:sonnet@high', NH], coord: [SONNET, N], maxConcurrent: 3,
  },
  padrao: {
    nome: 'Padrão (econômico)', descricao: 'Opus planeja (Argon na falta); Gemini executa: Hydrogen e 3.8 Flash no volume, Neon no pesado; Haiku e Sonnet só quando a cota do Gemini acaba.',
    planner: ['claude:opus@high', ARGON, NH],
    tiers: {
      pesado: [N, H, SONNET],
      volume: [H, F, HAIKU],
      leve: [F, H, HAIKU],
    },
    porVelocidade: {
      rapido: { pesado: [H, N, SONNET], volume: [H, F, HAIKU], leve: [H, F, HAIKU] },
      demorado: { pesado: [N, SONNET, H], volume: [N, H, HAIKU], leve: [H, F, HAIKU] },
    },
    fix: [SONNET, N], coord: [N, SONNET], maxConcurrent: 3,
  },
  desespero: {
    nome: 'Desespero (gratuitos)', descricao: 'Para quando a cota do Gemini acabou e a do Claude está no fim: tudo vai para os modelos gratuitos do opencode, do melhor para o pior. Eles são lentos (minutos por resposta; a NVIDIA levou horas no teste). O pipeline também entra nele sozinho quando nenhum provedor tem cota.',
    planner: [D1, 'agy:gpt-oss-120b-medium', 'claude:sonnet@medium'],
    tiers: {
      pesado: [D1, D2, D3],
      volume: [[D1, D2, D3], [D2, D1, D4]],
      leve: [D2, DESESPERO[5], D1],
    },
    fix: [D1, D2], coord: [D1, D2], maxConcurrent: 2,
  },
};
// Cadeias do modo na velocidade do projeto (só os modos prontos têm uma ordem por velocidade).
const tiersDe = (m, vel) => (m?.porVelocidade?.[vel] ? { ...m.tiers, ...m.porVelocidade[vel] } : m?.tiers);
const temModo = (k) => typeof k === 'string' && Object.hasOwn(MODES, k);
const LISTAS_TOPO = ['planner', 'fix', 'coord'];
const TIPOS = ['escritor', 'integrador', 'tarefa'];
const NIVEIS = ['pesado', 'volume', 'leve'];
const SUPERVISAO = {
  automatico: 'Automático: roda até o fim sem parar.',
  acompanhado: 'Acompanhado: para e pede confirmação nos momentos importantes (tarefas marcadas pelo planejador, primeira integração, recuperação de falha, troca para os modelos gratuitos).',
  passo: 'Passo a passo: pede confirmação antes de cada tarefa.',
};

const temSup = (k) => typeof k === 'string' && Object.hasOwn(SUPERVISAO, k);

const VELOCIDADE = {
  auto: 'Automático: esforço sugerido pelo planejador por tarefa; integração e verificação em médio (ou alto no modo agressivo). Modelos na ordem padrão do modo.',
  rapido: 'Rápido: na frente os modelos mais rápidos com nota aceitável no benchmark (Gemini Hydrogen, Opus, Sonnet), executores em esforço baixo (low); integração e verificação em médio.',
  medio: 'Médio: ordem padrão do modo, que mistura provedores para poupar tokens e cota; executores, integração e verificação em esforço médio (medium).',
  demorado: 'Demorado: na frente os de melhor resultado no benchmark, mesmo mais lentos (Opus, Gemini Neon, Haiku), em esforço alto (high).',
};

const temVel = (k) => typeof k === 'string' && Object.hasOwn(VELOCIDADE, k);
const velDe = (p) => (temVel(p?.velocidade) ? p.velocidade : 'auto');
// Modo personalizado: mesmas chaves de um modo pronto, com listas planas.
function validarCustom(c) {
  const errs = [];
  if (!c || typeof c !== 'object') return { errs: ['modo personalizado vazio'] };
  const base = temModo(c.base) ? c.base : null;
  const out = { nome: 'Personalizado', descricao: base ? `Personalizado a partir do modo ${MODES[base].nome}.` : 'Definido do zero.', base, tiers: {} };
  for (const k of [...LISTAS_TOPO, ...NIVEIS]) {
    const lista = LISTAS_TOPO.includes(k) ? c[k] : c.tiers?.[k];
    if (!Array.isArray(lista) || !lista.length || lista.length > 8) { errs.push(`${k}: informe de 1 a 8 modelos`); continue; }
    // A mensagem não repete o valor recebido: entrada de fora não volta na resposta.
    if (lista.some((e) => !entradaValida(e))) { errs.push(`${k}: modelo inválido (use provedor:modelo[@esforço], com provedor claude, agy ou opencode)`); continue; }
    if (LISTAS_TOPO.includes(k)) out[k] = [...new Set(lista)]; else out.tiers[k] = [...new Set(lista)];
  }
  const mc = Number(c.maxConcurrent);
  out.maxConcurrent = Number.isInteger(mc) && mc >= 1 && mc <= 8 ? mc : 2;
  // semGratuitos: nenhuma cadeia ganha os modelos gratuitos do opencode, nem o modo desespero automático.
  if (c.semGratuitos === true) out.semGratuitos = true;
  return { errs, custom: out };
}
// Converte um modo pronto em personalizado (volume alternado vira a primeira cadeia).
function modoComoCustom(k) {
  const m = temModo(k) ? MODES[k] : MODES.padrao;
  const flat = (t) => (Array.isArray(t[0]) ? t[0] : t);
  return { base: temModo(k) ? k : 'padrao', planner: [...m.planner], fix: [...m.fix], coord: [...m.coord], maxConcurrent: m.maxConcurrent,
    tiers: { pesado: [...flat(m.tiers.pesado)], volume: [...flat(m.tiers.volume)], leve: [...flat(m.tiers.leve)] } };
}
const cfgDe = (p) => (p.modo === 'personalizado' && p.custom ? p.custom : (temModo(p.modo) ? MODES[p.modo] : MODES.padrao));
const nomeModo = (p) => cfgDe(p).nome;
const supDe = (p) => (temSup(p.supervisao) ? p.supervisao : 'automatico');
// Perfis personalizados com nome (DATA/perfis.json); cada perfil é revalidado por validarCustom ao ler e ao salvar.
const perfis = criarPerfis({ arquivo: PERFIS_FILE, validar: validarCustom });

// ---------- armazenamento ----------
const idOk = (id) => typeof id === 'string' && /^[a-z0-9-]{6,80}$/.test(id);
const pdir = (id) => path.join(PROJ, id);
const now = () => new Date().toISOString();
function load(id) {
  if (!idOk(id)) return null;
  const f = path.join(pdir(id), 'project.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}
function save(p) {
  fs.mkdirSync(pdir(p.id), { recursive: true });
  const f = path.join(pdir(p.id), 'project.json');
  fs.writeFileSync(f + '.tmp', JSON.stringify(p, null, 2));
  fs.renameSync(f + '.tmp', f);
}
function listAll() {
  return fs.readdirSync(PROJ).filter(idOk).map(load).filter(Boolean)
    .sort((a, b) => (b.criado || '').localeCompare(a.criado || ''));
}
export const historicoReal = cacheHistorico(
  () => montarHistoricoTarefas(listAll(), { dataDir: DATA, projDirDe: (p) => pdir(p.id) }),
  60000,
);
function slug(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'projeto';
}

// ---------- cadeias ----------
function comEsforco(entrada, nivel) {
  if (!['low', 'medium', 'high'].includes(nivel)) return entrada;
  if (Array.isArray(entrada)) {
    return [...new Set(entrada.map((e) => comEsforco(e, nivel)))];
  }
  if (typeof entrada !== 'string') return entrada;
  if (entrada.startsWith('claude:')) {
    const semProv = entrada.slice('claude:'.length);
    const [model] = semProv.split('@');
    if (model.toLowerCase().includes('haiku')) return `claude:${model}`;
    return `claude:${model}@${nivel}`;
  }
  const m = entrada.match(/^agy:((?:gemini|claude)(?:-.+)?)-(?:low|medium|high)$/);
  if (m) {
    return `agy:${m[1]}-${nivel}`;
  }
  return entrada;
}

function esforcoIntegracaoVerificacao(p) {
  const vel = velDe(p);
  if (vel === 'rapido' || vel === 'medio') return 'medium';
  if (vel === 'demorado') return 'high';
  return p?.modo === 'agressivo' ? null : 'medium';
}

function esforcoDaTarefa(p, t) {
  if (t?.tipo === 'integrador') return esforcoIntegracaoVerificacao(p);
  const vel = velDe(p);
  if (vel === 'rapido') return 'low';
  if (vel === 'medio') return 'medium';
  if (vel === 'demorado') return 'high';
  if (t?.esforco && ['low', 'medium', 'high'].includes(t.esforco)) return t.esforco;
  return null;
}

// Cadeia do modo para a tarefa, adaptada ao que está instalado e com os dois melhores gratuitos no fim como última reserva.
function chainFor(p, t, idx = 0) {
  const m = cfgDe(p);
  let c;
  if (Array.isArray(t?.cadeia) && t.cadeia.length) c = t.cadeia;
  else {
    const tiers = tiersDe(m, velDe(p)) || {};
    const tier = tiers[t?.nivel] || tiers.volume || [];
    c = Array.isArray(tier[0]) ? tier[idx % tier.length] : tier;
    const esf = esforcoDaTarefa(p, t);
    if (esf) c = comEsforco(c, esf);
  }
  const adaptada = pagoNaFrente(p, t, gratuitosNoFim(p, t, m?.semGratuitos ? adaptar(c) : comReserva(adaptar(c), esforcoDaTarefa(p, t), { semGemini: p?.modo === 'desespero' })));
  return adaptada.length ? adaptada : c;
}
// Teste de 19/11/2026: a NVIDIA grátis derruba sessões de 10 a 45 min; a recuperação levou 3 h e a integração 50 min.
// Fora do desespero, integração, tarefa pesada e coordenação de falhas não começam num gratuito: se a cadeia só
// tem gratuitos na frente, entra antes o primeiro modelo pago do planejador do modo (o usuário já o escolheu).
function pagoNaFrente(p, t, c, { forcar = false } = {}) {
  if (p?.modo === 'desespero' || !Array.isArray(c) || !c.length || !ehGratuito(c[0])) return c;
  if (!forcar && t?.tipo !== 'integrador' && t?.nivel !== 'pesado') return c;
  const pago = adaptar(cfgDe(p)?.planner || []).find((e) => /^(agy|claude):/.test(String(e)));
  return pago && !c.includes(pago) ? [pago, ...c] : c;
}
// Gratuitos (opencode/* e nvidia/*) são lentos (≈44 tokens/s; na NVIDIA cada resposta leva minutos):
// só vão na frente em tarefa leve. Nas pesadas e de volume ficam depois dos pagos, na ordem em que
// estavam. Modo desespero ou cadeia só de gratuitos: nada muda.
const ehGratuito = (e) => /^opencode:(opencode|nvidia)\//.test(String(e));
function gratuitosNoFim(p, t, c) {
  if (p?.modo === 'desespero' || t?.nivel === 'leve') return c;
  return [...c.filter((e) => !ehGratuito(e)), ...c.filter(ehGratuito)];
}
// Reserva no fim da cadeia: primeiro o Gemini (Hydrogen e 3.8 Flash), que é a reserva natural do Claude, e por
// último um gratuito que não seja da NVIDIA (19/11/2026: a NVIDIA grátis levou ~10 h 45 num plano de minutos).
const RESERVA_GEMINI = [H, F];
const familia = (e) => String(e).replace(/@.*$/, '').replace(/-(low|medium|high|xhigh)$/, '');
function comReserva(c, esf = null, { semGemini = false } = {}) {
  const tem = new Set(c.map(familia));
  const gem = semGemini ? [] : RESERVA_GEMINI.map((e) => (esf ? comEsforco(e, esf) : e));
  const gratis = DESESPERO.filter((e) => !String(e).startsWith("opencode:nvidia/")).slice(0, 1);
  const extra = adaptar([...gem, ...gratis], []).filter((e) => !tem.has(familia(e)));
  return [...c, ...extra].slice(0, Math.max(8, c.length));
}
const wtName = (p, t) => `${p.id.slice(-6)}-${t.id}`.replace(/[^a-z0-9_-]/gi, '-');

function arquivarRodadaSePreciso(p, { manterPlano = false } = {}) {
  if (!temRodadaExecutada(p, pdir(p.id))) return null;
  const planoCopia = (manterPlano && p.plano) ? JSON.parse(JSON.stringify(p.plano)) : null;
  const r = arquivarRodada(p, {
    projDir: pdir(p.id),
    dataDir: DATA,
    tabela: carregarPrecos({ dataDir: DATA }),
    chainFor,
    nomeModo,
    velDe,
    supDe,
    resumoFinal,
  });
  if (manterPlano && planoCopia) {
    p.plano = planoCopia;
  }
  save(p);
  return r;
}

// ---------- planejador ----------
function parseEntry(e) {
  const i = e.indexOf(':');
  const [model, effort] = e.slice(i + 1).split('@');
  return { prov: e.slice(0, i), model, effort };
}
function coletar(ch, entrada, limiteMs, onLine) {
  return new Promise((resolve) => {
    let out = '', err = '', buf = '';
    const timer = setTimeout(() => execFile('taskkill', ['/PID', String(ch.pid), '/T', '/F'], () => {}), limiteMs);
    ch.stdout.on('data', (d) => { out += d; buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l && onLine) onLine(l); } });
    ch.stderr.on('data', (d) => (err += d));
    ch.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e) }); });
    ch.on('close', (code) => { clearTimeout(timer); if (buf.trim() && onLine) onLine(buf.trim()); resolve({ code, out, err }); });
    ch.stdin.on('error', () => {});
    ch.stdin.end(entrada, 'utf8');
  });
}
const LIMITE_PLANEJADOR = 40 * 60000;
const instrucoes = () => fs.readFileSync(PLANNER_FILE, 'utf8');

async function runClaude({ cwd, model, effort, prompt, resume, bare, entry }) {
  const args = ['/d', '/c', 'claude', '-p', '--model', model, '--output-format', 'json',
    '--dangerously-skip-permissions', '--disallowedTools', 'Edit,Write,NotebookEdit'];
  if (!bare) args.push('--append-system-prompt-file', PLANNER_FILE);
  if (effort) args.push('--effort', effort);
  if (resume) args.push('--resume', resume);
  const r = await coletar(spawn('cmd.exe', args, { cwd, windowsHide: true }), prompt, LIMITE_PLANEJADOR);
  const line = r.out.trim().split(/\r?\n/).filter((l) => l.startsWith('{')).pop();
  const m = entry || `claude:${model}`;
  try {
    const j = JSON.parse(line);
    const uso = usoClaudeJson(j, m);
    return { ok: !j.is_error, text: j.result || '', session: j.session_id, uso };
  }
  catch {
    const uso = usoClaudeJson(r.out, m);
    return { ok: false, text: (r.err || r.out || 'sem resposta').slice(-3000), uso };
  }
}

// Opencode enxuto, como no worker.ps1 (18/11/2026): sem os servidores MCP do opencode.jsonc e sem as
// skills e o CLAUDE.md do Claude Code. Medido: 149 mil tokens de entrada por requisição caem para 12 mil.
function envOpencodeEnxuto(base = process.env) {
  const mcp = {};
  for (const f of ['opencode.jsonc', 'opencode.json', 'config.json']) {
    try {
      const txt = fs.readFileSync(path.join(HOME, '.config', 'opencode', f), 'utf8').replace(/^\s*\/\/.*$/gm, '');
      for (const n of Object.keys(JSON.parse(txt).mcp || {})) mcp[n] = { enabled: false };
    } catch {}
  }
  return { ...base, OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp }) };
}

// opencode com o agente "plan" (não edita). O planner.md vai no começo do primeiro prompt.
async function runOpencode({ cwd, model, effort, prompt, resume, bare, entry }) {
  const args = ['/d', '/c', 'opencode', 'run', '--pure', '--agent', 'plan', '--model', model, '--format', 'json', '--title', 'Delegar planejamento'];
  if (effort) args.push('--variant', effort);
  if (resume) args.push('--session', resume);
  const parts = []; let session = null; const erros = []; const evs = [];
  const r = await coletar(spawn('cmd.exe', args, { cwd, windowsHide: true, env: envOpencodeEnxuto() }), resume || bare ? prompt : instrucoes() + '\n\n---\n\n' + prompt, LIMITE_PLANEJADOR, (l) => {
    try {
      const e = JSON.parse(l); session = e.sessionID || session;
      evs.push(e);
      if (e.type === 'text' && e.part?.text) parts.push(e.part.text);
      if (e.type === 'error') erros.push(JSON.stringify(e.error || e).slice(0, 1000));
    } catch {}
  });
  const text = parts.join('\n').trim();
  const m = entry || `opencode:${model}`;
  const uso = usoOpencode(evs.length ? evs : r.out, m);
  return text ? { ok: true, text, session, uso } : { ok: false, text: (erros.join(' ') || r.err || r.out || 'sem resposta').slice(-3000), uso };
}

// agy com --dangerously-skip-permissions (o planejador continua proibido de editar pelo planner.md).
async function runAgy({ cwd, model, effort, prompt, bare, entry }) {
  const exe = detectar().agy;
  const args = ['--model', model, '--input-format', 'stream-json', '--output-format', 'stream-json', '--dangerously-skip-permissions', '--disable-slash-commands', '--add-dir', cwd];
  if (fs.existsSync(VAULT)) args.push('--add-dir', VAULT);
  if (effort) args.push('--effort', effort);
  args.push('-p=');
  const buffer = []; let final = {}; const evs = [];
  const promptCompleto = bare ? prompt : instrucoes() + '\n\n---\n\n' + prompt;
  const line = JSON.stringify({ event: 'user', message: { content: promptCompleto } }) + '\n';
  const r = await coletar(spawn(exe, args, { cwd, windowsHide: true }), line, LIMITE_PLANEJADOR, (l) => {
    try {
      const e = JSON.parse(l);
      evs.push(e);
      if (e.event === 'step_update' && e.step_update?.step_type === 'agent_response' && e.step_update.text_delta) buffer.push(e.step_update.text_delta);
      if (e.event === 'result') final = e.result || {};
    } catch {}
  });
  const text = String(final.response || buffer.join('')).trim();
  const m = entry || `agy:${model}`;
  const uso = usoAgyStream(evs.length ? evs : r.out, m, { prompt: promptCompleto });
  return text ? { ok: true, text, uso } : { ok: false, text: (r.err || r.out || 'sem resposta').slice(-3000), uso };
}

function introducao(p) {
  const m = cfgDe(p);
  const vel = velDe(p);
  const velTxt = vel === 'auto'
    ? 'Velocidade: auto (defina o esforço "low", "medium" ou "high" em cada tarefa do plano).'
    : `Velocidade: ${vel} (o esforço da execução já está fixado pelo usuário; o campo esforco nas tarefas será ignorado).`;
  let intro = `Pedido do usuário:\n${p.pedido}\n\nRepositório: ${p.repo} (${isGitRepo(p.repo) ? 'git' : 'não é git: não use escritores'})\n` +
    `Cofre de conhecimento: ${VAULT}\nModo: ${m.nome}. ${m.descricao}\n${velTxt}\nAcompanhamento: ${SUPERVISAO[supDe(p)]}\n` +
    `Provedores instalados neste PC: ${Object.entries(detectar()).filter(([, v]) => v).map(([k]) => k).join(', ') || 'nenhum'}\n` +
    (p.auto ? '\nMODO AUTOMÁTICO: não faça perguntas. Analise o necessário e entregue já nesta resposta o plano final no formato combinado.'
      : '\nConverse para fechar o escopo. Se o pedido já estiver claro, proponha o plano final no formato combinado.');
  if (Array.isArray(p.rodadas) && p.rodadas.length > 0) {
    const ctx = contextoRodadasParaPlanejador(p);
    if (ctx) intro += '\n\n' + ctx;
  }
  return intro;
}
// Prompt com a conversa inteira, para provedor sem sessão retomável ou quando o planejador mudou.
function transcricao(p, novo) {
  const hist = p.mensagens.filter((m) => m.papel !== 'sistema').slice(1, -1)
    .map((m) => `[${m.papel === 'usuario' ? 'Usuário' : (m.papel === 'resumo' ? 'Resumo da execução' : 'Planejador')}]\n${m.texto}`).join('\n\n');
  return `${introducao(p)}\n\n## Conversa até agora\n${hist || '(nenhuma)'}\n\n## Nova mensagem do usuário\n${novo}`;
}

// Falhas do provedor que não dizem nada do pedido: vale tentar o próximo modelo da lista.
const FALHA_PASSAGEIRA_RE = /(ProviderHeaderTimeoutError|ProviderResponseStreamError|headers timed out|timed out after|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|\b50[234]\b|overloaded|service unavailable)/i;
async function chamarPlanejador(p, texto) {
  const cands = adaptar(cfgDe(p).planner);
  const avisos = [];
  if (!cands.length) return { ok: false, text: 'Nenhuma CLI de IA encontrada neste PC (claude, agy ou opencode).', avisos };
  let ultimo;
  for (const entry of cands) {
    const { prov, model, effort } = parseEntry(entry);
    const mesmo = p.sessao && p.sessaoDe === entry && prov !== 'agy';
    const primeiro = !p.mensagens.some((m) => m.papel === 'planejador');
    let prompt = mesmo ? texto : primeiro ? introducao(p) + (texto !== p.pedido ? '\n\n' + texto : '') : transcricao(p, texto);
    if (mesmo && p.contextoRodadaPendente) {
      prompt = p.contextoRodadaPendente + '\n\n## Novo pedido do usuário\n' + texto;
    }
    const run = prov === 'claude' ? runClaude : prov === 'opencode' ? runOpencode : runAgy;
    evento(p, { tipo: 'planejador', modelo: entry, texto: 'planejador pensando' });
    const r = await run({ cwd: p.repo, model, effort, prompt, resume: mesmo ? p.sessao : null, entry });
    if (r.ok && p.contextoRodadaPendente) {
      delete p.contextoRodadaPendente;
    }
    if (!p.uso || typeof p.uso !== 'object') p.uso = { chamadas: [] };
    if (!Array.isArray(p.uso.chamadas)) p.uso.chamadas = [];
    // sessao: o uso-fora.mjs tira esta sessão da conta de fora do orquestrador (ela já conta aqui).
    p.uso.chamadas.push({ quando: horaLocal(), papel: 'planejador', sessao: r.session || null, ...(r.uso || null) });
    save(p);
    ultimo = { ...r, entry, avisos };
    if (r.ok) return ultimo;
    // Troca de modelo por cota e também por falha passageira do provedor (caso real 18/11: a NVIDIA não
    // mandou os cabeçalhos em 30 s e o planejamento parou sem tentar o segundo modelo da lista).
    const semCota = QUOTA_RE.test(r.text);
    if (!semCota && !FALHA_PASSAGEIRA_RE.test(r.text)) return ultimo;
    const porque = semCota ? 'sem cota' : 'com falha do provedor';
    avisos.push(`Planejador ${entry} ${porque}; tentando o próximo modelo.`);
    evento(p, { tipo: 'troca', modelo: entry, texto: `planejador ${porque}, tentando o próximo` });
  }
  return ultimo;
}

// Conserta sem IA os defeitos comuns do JSON escrito por modelo: quebra de linha ou tabulação crua dentro
// de texto (o "Unterminated string"), vírgula antes de } ou ], aspas tipográficas fora de texto e lixo
// antes do primeiro { ou depois do último }. Percorre caractere a caractere sabendo se está dentro de texto.
function repararJson(bruto) {
  let s = String(bruto).replace(/^\uFEFF/, '');
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i >= 0 && j > i) s = s.slice(i, j + 1);
  let out = '', dentro = false, esc = false, tipografica = false, chave = false;
  for (let k = 0; k < s.length; k++) {
    let c = s[k];
    if (dentro) {
      if (esc) { esc = false; if (!'nrt"\\/bfu'.includes(c)) out += '\\'; out += c; continue; } // "\x" inválido vira "\\x"
      if (c === '\\') { esc = true; out += c; continue; }
      if (c === '"' || (tipografica && c === '”')) {
        // Aspas que não fecham de verdade são do texto: escapa. Chave fecha antes de ":"; valor, antes de , } ou ].
        let n = k + 1; while (n < s.length && /\s/.test(s[n])) n++;
        if (n < s.length && !(chave ? ':' : ',}]').includes(s[n])) { out += '\\"'; continue; }
        dentro = false; out += '"'; continue;
      }
      if (c === '\n') { out += '\\n'; continue; }
      if (c === '\r') continue;
      if (c === '\t') { out += '\\t'; continue; }
      if (c < ' ') { out += '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'); continue; }
      out += c; continue;
    }
    tipografica = c === '\u201c';
    if (c === '\u201c' || c === '\u201d') c = '"';
    if (c === '"') { dentro = true; chave = /[{,]$/.test(out.trimEnd()); out += c; continue; }
    if (c === ',') { let n = k + 1; while (n < s.length && /\s/.test(s[n])) n++; if (s[n] === '}' || s[n] === ']') continue; }
    out += c;
  }
  return out;
}

function extractPlan(text) {
  const t = String(text);
  const a = t.lastIndexOf('```json');
  if (a < 0) return { plan: null };
  // O prompt de uma tarefa pode ter ``` dentro; o fecho certo é aquele em que o JSON fecha.
  // Tenta do fecho mais distante para o mais próximo; sem fecho, vai até o fim do texto.
  const fins = []; for (let k = t.indexOf('```', a + 7); k >= 0; k = t.indexOf('```', k + 3)) fins.push(k);
  for (const f of [...fins].reverse()) {
    const b = t.slice(a + 7, f);
    try { return { plan: JSON.parse(b) }; } catch {}
    try { return { plan: JSON.parse(repararJson(b)), reparo: 'local' }; } catch {}
  }
  const bruto = fins.length ? t.slice(a + 7, fins[fins.length - 1]) : t.slice(a + 7);
  try { return { plan: JSON.parse(bruto) }; }
  catch (e) {
    try { return { plan: JSON.parse(repararJson(bruto)), reparo: 'local' }; }
    catch { return { plan: null, bruto, error: 'JSON do plano inválido: ' + e.message }; }
  }
}

// Corretor econômico de JSON: mesmo provedor do planejador, modelo leve, sem o planner.md. Só conserta o
// formato; o conteúdo do plano não muda. Os outros provedores ficam de reserva (no máximo 2 tentativas).
const CORRETORES = { claude: 'claude:haiku', agy: 'agy:gemini-3.8-flash-low', opencode: 'opencode:opencode/big-pickle' };
async function corrigirJson(p, bruto, erro) {
  const prov = p.planejador ? parseEntry(p.planejador).prov : null;
  const ordem = [CORRETORES[prov], ...Object.values(CORRETORES)].filter((v, k, a) => v && a.indexOf(v) === k);
  const prompt = 'Corrija SOMENTE o formato do JSON abaixo, que falhou no JSON.parse com o erro: ' + erro + '.\n' +
    'Causas comuns: quebra de linha crua ou aspas duplas sem escape dentro de texto, vírgula sobrando, chave ou colchete faltando, texto cortado no fim.\n' +
    'Não mude o conteúdo (tarefas, prompts, dependências, níveis): só o necessário para virar JSON válido. ' +
    'Não leia nem altere arquivos. Responda apenas com um único bloco ```json``` contendo o JSON corrigido.\n\n```json\n' + bruto + '\n```';
  for (const entry of adaptar(ordem).slice(0, 2)) {
    const { prov: pv, model, effort } = parseEntry(entry);
    const run = pv === 'claude' ? runClaude : pv === 'opencode' ? runOpencode : runAgy;
    evento(p, { tipo: 'planejador', modelo: entry, texto: 'corrigindo o JSON do plano' });
    try {
      const r = await run({ cwd: p.repo, model, effort, prompt, bare: true, entry });
      if (!p.uso || typeof p.uso !== 'object') p.uso = { chamadas: [] };
      if (!Array.isArray(p.uso.chamadas)) p.uso.chamadas = [];
      p.uso.chamadas.push({ quando: horaLocal(), papel: 'corretor', sessao: r.session || null, ...(r.uso || null) });
      save(p);
      if (!r.ok) continue;
      const x = extractPlan(r.text);
      // O corretor não pode perder tarefas: todo id do plano original tem de continuar lá.
      const idsOrig = [...String(bruto).matchAll(/"id"\s*:\s*"([a-z0-9_-]{1,32})"/g)].map((m) => m[1]);
      const idsNovos = new Set((x.plan?.tarefas || []).map((t) => t?.id));
      const faltam = idsOrig.filter((id) => !idsNovos.has(id));
      if (x.plan && faltam.length) { evento(p, { tipo: 'planejador', modelo: entry, texto: `corretor descartado: sumiram as tarefas ${faltam.join(', ')}` }); continue; }
      if (x.plan) return { plan: x.plan, entry };
    } catch (e) { console.error('corrigirJson', entry, e); }
  }
  return null;
}

export function validatePlan(pl, isGit) {
  const errs = [];
  if (!pl || typeof pl !== 'object') return ['plano vazio'];
  if (!Array.isArray(pl.tarefas) || !pl.tarefas.length) errs.push('sem tarefas');
  if ((pl.tarefas || []).length > 40) errs.push('mais de 40 tarefas');
  if (Array.isArray(pl.tarefas)) {
    const qtdEscritores = pl.tarefas.filter((t) => t && t.tipo === 'escritor').length;
    if (pl.maxConcurrent == null) {
      if (qtdEscritores > 0) pl.maxConcurrent = Math.min(8, Math.max(2, qtdEscritores));
    } else {
      const mc = Number(pl.maxConcurrent);
      if (!Number.isInteger(mc) || mc < 1 || mc > 8) errs.push("maxConcurrent deve ser inteiro de 1 a 8");
      else pl.maxConcurrent = mc;
    }
  }
  const ids = new Set();
  for (const t of pl.tarefas || []) {
    if (typeof t.id !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(t.id)) errs.push(`id inválido: ${t.id}`);
    else if (ids.has(t.id)) errs.push(`id repetido: ${t.id}`);
    ids.add(t.id);
    if (!TIPOS.includes(t.tipo)) errs.push(`${t.id}: tipo inválido`);
    if (!NIVEIS.includes(t.nivel)) errs.push(`${t.id}: nível inválido`);
    if (t.demanda != null && !CATEGORIAS_DEMANDA.includes(t.demanda)) errs.push(`${t.id}: demanda inválida: ${t.demanda}`);
    if (t.esforco != null && !['low', 'medium', 'high'].includes(t.esforco)) errs.push(`${t.id}: esforço inválido`);
    if (typeof t.prompt !== 'string' || t.prompt.length < 20) errs.push(`${t.id}: prompt vazio`);
    else if (t.prompt.length > 25000) errs.push(`${t.id}: prompt longo demais`);
    if (t.tipo === 'escritor' && !isGit) errs.push(`${t.id}: escritor exige repositório git`);
    if (t.cadeia != null && (!Array.isArray(t.cadeia) || t.cadeia.length > 8 || t.cadeia.some((e) => !entradaValida(e)))) errs.push(`${t.id}: cadeia inválida`);
    t.depende = Array.isArray(t.depende) ? t.depende : [];
    t.confirmar = t.confirmar === true;
    t.motivo = t.motivo == null ? '' : String(t.motivo).slice(0, 300);
  }
  for (const t of pl.tarefas || []) for (const d of t.depende) if (!ids.has(d)) errs.push(`${t.id}: depende de ${d}, que não existe`);
  const state = {}; const byId = Object.fromEntries((pl.tarefas || []).map((t) => [t.id, t]));
  const visit = (id) => {
    if (state[id] === 1) return true; if (state[id] === 2) return false;
    state[id] = 1; for (const d of byId[id]?.depende || []) if (visit(d)) return true; state[id] = 2; return false;
  };
  for (const id of ids) if (visit(id)) { errs.push('dependências em ciclo'); break; }
  if (pl.verify && !Array.isArray(pl.verify)) errs.push('verify deve ser lista');
  return errs;
}

const isGitRepo = (repo) => fs.existsSync(path.join(repo, '.git'));

async function plannerTurn(p, userText, { gerar = false } = {}) {
  let texto = userText;
  if (gerar) texto += '\n\nGere agora o plano final no formato combinado, num único bloco ```json```.';
  p.ocupado = true; save(p);
  const r = await chamarPlanejador(p, texto);
  p = load(p.id);
  p.ocupado = false;
  for (const a of r.avisos || []) p.mensagens.push({ papel: 'sistema', texto: a, quando: now() });
  if (r.entry) { if (r.session) { p.sessao = r.session; p.sessaoDe = r.entry; } else if (p.sessaoDe !== r.entry) { p.sessao = null; p.sessaoDe = r.entry; } }
  if (!r.ok) {
    p.mensagens.push({ papel: 'sistema', texto: 'Falha no planejador: ' + r.text, quando: now() });
    save(p); return p;
  }
  p.planejador = r.entry;
  p.mensagens.push({ papel: 'planejador', texto: r.text, quando: now(), modelo: r.entry });
  let { plan, error, bruto, reparo } = extractPlan(r.text);
  if (reparo) p.mensagens.push({ papel: 'sistema', texto: 'O JSON do plano veio com defeito de formato e foi consertado automaticamente (sem IA).', quando: now() });
  if (error) {
    p.mensagens.push({ papel: 'sistema', texto: error + ' Chamando um modelo econômico só para corrigir o formato…', quando: now() });
    p.ocupado = true; save(p);
    const c = await corrigirJson(p, bruto, error.replace(/^JSON do plano inválido: /, ''));
    p = load(p.id); p.ocupado = false;
    if (c) { plan = c.plan; p.mensagens.push({ papel: 'sistema', texto: `JSON do plano corrigido automaticamente por ${c.entry}; o conteúdo é o do planejador.`, quando: now() }); }
    else p.mensagens.push({ papel: 'sistema', texto: 'Não foi possível corrigir o JSON automaticamente. Use "Gerar plano" ou mande uma mensagem ao planejador.', quando: now() });
  }
  if (plan) {
    const errs = validatePlan(plan, isGitRepo(p.repo));
    if (errs.length) {
      p.mensagens.push({ papel: 'sistema', texto: 'Plano recusado: ' + errs.join('; '), quando: now() });
      save(p);
      if ((p.auto || gerar) && !p._corrigido) {
        const pedido = 'O plano foi recusado pela validação: ' + errs.join('; ') + '. Corrija e envie o plano final completo de novo.';
        p._corrigido = true; p.mensagens.push({ papel: 'usuario', texto: '(validação automática) ' + pedido, quando: now() }); save(p);
        return plannerTurn(p, pedido);
      }
      return p;
    }
    if (temRodadaExecutada(p, pdir(p.id))) arquivarRodadaSePreciso(p);
    p.plano = plan; p.estado = 'plano_pronto'; p._corrigido = false;
    if (plan.titulo && !p.tituloFixo) p.titulo = String(plan.titulo).slice(0, 120);
    const dem = calcularDemandaSegura(p);
    p.demanda = dem;
    const baseTexto = `Plano recebido: ${plan.tarefas.length} tarefas.`;
    const textoMsg = dem?.linhaResumo ? `${baseTexto}\n${dem.linhaResumo}` : baseTexto;
    p.mensagens.push({ papel: 'sistema', texto: textoMsg, quando: now() });
    save(p);
    report(p);
    if (p.agendamento?.executarEm && Number(p.agendamento.executarEm) > Date.now() && !p.agendamento?.execucaoDisparadaEm) {
      const resumo = resumoAgendamento(p);
      p.mensagens.push({ papel: 'sistema', texto: `Plano pronto. Aguardando horário agendado (${resumo?.texto || 'execução futura'}).`, quando: now() });
      save(p);
      report(p);
      return p;
    }
    if (p.auto) return startPipeline(p);
    return p;
  }
  if (!p.plano) p.estado = 'conversando';
  save(p); return p;
}

// ---------- execução ----------
// Quantas tarefas ao mesmo tempo. No automático (confiar no orquestrador ou acompanhamento automático) vale o
// número que o planejador pediu, até LIMITE_PARALELO, porque lotes independentes terminam mais cedo; no manual
// fica o limite do modo escolhido. Em todos os casos o pipeline ainda corta pela cota (quota.ps1).
const LIMITE_PARALELO = 8;
function paralelismo(p, m) {
  const pedido = Number(p.plano?.maxConcurrent);
  const modo = Number(m.maxConcurrent) || 2;
  const escritores = Array.isArray(p.plano?.tarefas) ? p.plano.tarefas.filter((t) => t && t.tipo === 'escritor').length : 0;
  if (p.auto || supDe(p) === 'automatico') {
    if (Number.isInteger(pedido) && pedido >= 1) return Math.min(pedido, LIMITE_PARALELO);
    if (escritores >= 2) return Math.min(Math.max(modo, escritores), LIMITE_PARALELO);
    return modo;
  }
  return Math.max(1, Math.min(Number.isInteger(pedido) && pedido >= 1 ? pedido : modo, modo));
}

function semGratuitosReserva(lista, p, explicitos = []) {
  if (!Array.isArray(lista) || p?.modo === 'desespero') return lista;
  const temPago = lista.some((m) => typeof m === 'string' && (m.startsWith('claude:') || m.startsWith('agy:')));
  if (!temPago) return lista;
  const ehGratuito = (m) => {
    if (typeof m !== 'string') return false;
    const semEsf = m.split('@')[0];
    return (semEsf.startsWith('opencode:') && (semEsf.endsWith('-free') || semEsf === 'opencode:opencode/big-pickle'))
      || DESESPERO.includes(semEsf);
  };
  const expSet = new Set((Array.isArray(explicitos) ? explicitos : []).map((m) => (typeof m === 'string' ? m.split('@')[0] : m)));
  const res = [...lista];
  while (res.length > 0) {
    const ult = res[res.length - 1];
    const semEsf = typeof ult === 'string' ? ult.split('@')[0] : ult;
    if (ehGratuito(ult) && !expSet.has(semEsf)) {
      res.pop();
    } else {
      break;
    }
  }
  return res;
}

function buildPlanFile(p) {
  const m = cfgDe(p);
  const dir = pdir(p.id), pr = path.join(dir, 'prompts');
  fs.mkdirSync(pr, { recursive: true });
  const byId = Object.fromEntries(p.plano.tarefas.map((t) => [t.id, t]));
  let vol = 0;
  const tasks = p.plano.tarefas.map((t) => {
    let text = t.prompt;
    const o = { id: t.id, titulo: String(t.titulo || '').slice(0, 120), chain: chainFor(p, t, t.nivel === 'volume' ? vol++ : 0), after: t.depende, confirm: !!t.confirmar, reason: t.motivo || '' };
    if (t.tipo !== 'escritor' && t.nivel !== 'leve') {
      o.chain = semGratuitosReserva(o.chain, p, t.cadeia || []);
    }
    if (t.tipo === 'escritor') {
      o.worktree = wtName(p, t);
    } else {
      o.main = true;
      const ws = t.depende.map((d) => byId[d]).filter((d) => d && d.tipo === 'escritor');
      o.removeWorktrees = ws.map((w) => wtName(p, w));
      if (ws.length) text += '\n\n## Worktrees dos escritores desta integração\n' + ws.map((w) => `- ${w.id}: ${p.repo}-wt\\${wtName(p, w)}`).join('\n');
    }
    text += `\n\n(Projeto Delegar ${p.id}. Execute sem pedir confirmação.)`;
    const f = path.join(pr, `${t.id}.md`);
    fs.writeFileSync(f, text, 'utf8');
    o.prompt = f;
    return o;
  });
  const volT = tiersDe(m, velDe(p)).volume;
  const vol0 = Array.isArray(volT[0]) ? volT[0] : volT;
  const esfIv = esforcoIntegracaoVerificacao(p);

  const tarefasComCadeia = (p.plano?.tarefas || []).filter((t) => Array.isArray(t.cadeia) && t.cadeia.length);
  const tarefasPriorizadas = [
    ...tarefasComCadeia.filter((t) => t.tipo === 'integrador' || t.tipo === 'tarefa'),
    ...tarefasComCadeia.filter((t) => t.tipo === 'escritor'),
  ];
  const modelosEditados = [];
  for (const t of tarefasPriorizadas) {
    for (const mod of t.cadeia) {
      if (!modelosEditados.includes(mod)) modelosEditados.push(mod);
    }
  }

  const modelosEditadosAjustados = esfIv ? comEsforco(modelosEditados, esfIv) : modelosEditados;
  const fixBase = esfIv ? comEsforco(m.fix, esfIv) : m.fix;
  const coordBase = esfIv ? comEsforco(m.coord, esfIv) : m.coord;

  const fixJunto = [...new Set([...modelosEditadosAjustados, ...fixBase])];
  const coordJunto = [...new Set([...modelosEditadosAjustados, ...coordBase])];

  const reservaG = (c) => (m?.semGratuitos ? c : comReserva(c, null, { semGemini: p?.modo === 'desespero' }));
  const fixEfetiva = semGratuitosReserva(reservaG(adaptar(fixJunto)), p, modelosEditados);
  const coordEfetiva = pagoNaFrente(p, null, semGratuitosReserva(reservaG(adaptar(coordJunto)), p, modelosEditados), { forcar: true });

  const vel = velDe(p);
  const esfExec = vel === 'rapido' ? 'low' : (vel === 'medio' ? 'medium' : (vel === 'demorado' ? 'high' : null));
  const chainBase = esfExec ? comEsforco(vol0, esfExec) : vol0;
  const plan = {
    name: p.id, mode: p.modo, repo: p.repo, worktreeRoot: p.repo + '-wt', logDir: path.join(dir, 'logs'),
    chain: reservaG(adaptar(chainBase)), fixChain: fixEfetiva, coordinatorChain: coordEfetiva,
    desperateChain: m?.semGratuitos ? [] : adaptar(desesperoEfetivo(), []), supervision: supDe(p),
    maxConcurrent: paralelismo(p, m),
    maxRecoveries: 2, verify: (p.plano.verify || []).filter((v) => typeof v === 'string' && v.trim()), tasks,
  };
  const pf = path.join(dir, 'plan.json');
  fs.writeFileSync(pf, JSON.stringify(plan, null, 2), 'utf8');
  return pf;
}

// powershell.exe iniciado como "detached" pelo Node fica sem console e morre; o start-pipeline.ps1
// usa Start-Process, que cria um processo independente e devolve o pid.
function spawnPipeline(planFile, resume) {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(SCRIPTS, 'start-pipeline.ps1'), '-Plan', planFile];
  if (resume) args.push('-Resume');
  const out = execFileSync('powershell.exe', args, { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  const m = out.match(/pipeline pid=(\d+)/);
  if (!m) throw new Error('não foi possível iniciar o pipeline: ' + out.slice(-500));
  return Number(m[1]);
}
function gravarSupervisao(p) {
  const pf = path.join(pdir(p.id), 'plan.json');
  try { const j = JSON.parse(fs.readFileSync(pf, 'utf8')); j.supervision = supDe(p); fs.writeFileSync(pf, JSON.stringify(j, null, 2)); } catch {}
}

export function calcularDemandaEAjuste(p, { forcarEstrategia = null, comSugestao = false } = {}) {
  if (!p?.plano) return null;
  try {
    const tabela = carregarPrecos({ dataDir: DATA });
    const hist = historicoReal();
    const c = lerCache() || {};
    const cotasCache = { dados: c };
    const linhas = linhasDeCotas(c, detectar());
    const historicoCotas = lerHistoricoCotas(DATA);
    const projetos = listAll();
    const tentativas = coletarTentativasUso(projetos, { dataDir: DATA, dadosUsoProjeto: (proj) => dadosUsoDoProjeto(proj, tabela) });
    const estimativas = estimarTokensPorCota(historicoCotas, tentativas);
    const par = paralelismo(p, cfgDe(p));
    const chainForFn = (proj, t, idx) => chainFor(proj, t, idx);
    const demanda = estimarDemandaPlano(p, {
      historico: hist,
      dadosCotas: cotasCache?.dados,
      esforcoFn: esforcoDaTarefa,
      paralelismo: par,
      chainForFn,
      tabelaPrecos: tabela,
      estimativasCota: estimativas,
      linhasCotas: linhas,
    });
    const recomendacao = recomendarAjusteModelos(p, {
      demanda,
      linhasCotas: linhas,
      provedores: detectar(),
      historico: hist,
      dadosCotas: cotasCache?.dados,
      esforcoFn: esforcoDaTarefa,
      paralelismo: par,
      chainForFn,
      tabelaPrecos: tabela,
      estimativasCota: estimativas,
      forcarEstrategia,
    });
    // A simulação da sugestão só interessa à prévia; não vai para o project.json.
    const { demandaSugerida, ...recSemSim } = recomendacao || {};
    return comSugestao ? { ...demanda, recomendacao: recSemSim, demandaSugerida } : { ...demanda, recomendacao: recSemSim };
  } catch (err) {
    console.error('calcularDemandaEAjuste erro:', err);
    return null;
  }
}

// ---- Ajuste por cota: prévia, aplicação e desfazer (19/11/2026) ----
// Antes, os botões só gravavam p.politicaCota: o plano ajustado que aplicarPoliticaCotaAoProjeto devolvia era
// descartado e nenhum modelo mudava. Agora a prévia mostra antes x depois sem gravar; aplicar troca as cadeias das
// tarefas e guarda as originais em p.ajusteCota.anterior; "Ignorar / manter originais" volta a elas.
const NOMES_POLITICA = { auto: 'ajuste recomendado', economizar: 'economizar ao máximo', usar_melhor: 'melhores modelos', ignorar: 'manter originais', personalizado: 'personalizado' };
const POLITICA_PARA_ESTRATEGIA = { auto: null, economizar: 'economizar_maximo', usar_melhor: 'usar_melhor' };
function resumoDemanda(d) {
  if (!d) return null;
  return {
    tempoSeg: d.tempo?.totalSeg ?? null, faixaTempoSeg: d.tempo?.faixaSeg || null,
    entrada: d.total?.entrada ?? null, cacheLido: d.total?.cacheLido ?? 0, saida: d.total?.saida ?? null, usd: d.total?.usd ?? null,
    porGrupo: Object.fromEntries(Object.entries(d.porGrupo || {}).filter(([, v]) => v?.tarefas).map(([g, v]) => [g, { pct5h: v.pct5hEstimado ?? null, pctSemanal: v.pctSemanalEstimado ?? null }])),
    tarefas: (d.tarefas || []).map((x) => ({ id: x.id, modelo: x.modeloAssumido || x.modeloPrincipal || null, esforco: x.esforcoEfetivo || x.esforco || null, duracaoSeg: x.duracaoSegEstimada ?? null, usd: x.custoUsdEstimado ?? null })),
  };
}
function tarefasComAjusteAnterior(p) {
  const ant = new Map((p.ajusteCota?.anterior || []).map((a) => [a.id, a]));
  return (p.plano?.tarefas || []).map((t) => {
    const a = ant.get(t.id);
    if (!a) return t;
    const n = { ...t };
    if (a.cadeia) n.cadeia = [...a.cadeia]; else delete n.cadeia;
    if (a.esforco) n.esforco = a.esforco; else delete n.esforco;
    delete n.cadeiaEfetiva;
    return n;
  });
}
// Escolhas da prévia personalizada: { idTarefa: 'provedor:modelo' }. null quando não veio nada; false se inválido.
function escolhasPersonalizadas(c) {
  if (c == null) return null;
  if (typeof c !== 'object' || Array.isArray(c)) return false;
  const out = {};
  for (const [k, v] of Object.entries(c)) {
    if (typeof k !== 'string' || k.length > 40 || typeof v !== 'string' || !entradaValida(v)) return false;
    out[k] = v;
  }
  return out;
}
export function previaAjusteCota(p, politica, { cadeias = null } = {}) {
  if (!p?.plano) return null;
  const atual = calcularDemandaEAjuste(p, { comSugestao: false });
  let depoisProj; let rec = null; let cadPers = {};
  if (politica === 'personalizado') {
    // Modelo escolhido pela pessoa em cada tarefa; o resto da cadeia atual fica como reserva.
    let idxVol = 0;
    for (const t of p.plano.tarefas) {
      const idx = (t.nivel || 'volume') === 'volume' ? idxVol++ : 0;
      const esc = cadeias && typeof cadeias[t.id] === 'string' ? cadeias[t.id] : null;
      if (!esc || !entradaValida(esc)) continue;
      const atualCad = chainFor(p, t, idx);
      if (atualCad[0] === esc) continue;
      cadPers[t.id] = [esc, ...atualCad.filter((e) => e !== esc)].slice(0, 8);
    }
    depoisProj = { ...p, plano: { ...p.plano, tarefas: p.plano.tarefas.map((t) => (cadPers[t.id] ? { ...t, cadeia: cadPers[t.id] } : t)) } };
  } else if (politica === 'ignorar') {
    depoisProj = p.ajusteCota ? { ...p, plano: { ...p.plano, tarefas: tarefasComAjusteAnterior(p) } } : p;
  } else {
    const calc = calcularDemandaEAjuste(p, { forcarEstrategia: POLITICA_PARA_ESTRATEGIA[politica] ?? null, comSugestao: true });
    rec = calc?.recomendacao || null;
    const cad = rec?.cadeiasSugeridas || {}; const esf = rec?.esforcosSugeridos || {};
    depoisProj = { ...p, plano: { ...p.plano, tarefas: p.plano.tarefas.map((t) => ({ ...t, ...(cad[t.id] ? { cadeia: cad[t.id] } : {}), ...(esf[t.id] ? { esforco: esf[t.id] } : {}) })) } };
  }
  const depois = depoisProj === p ? atual : calcularDemandaEAjuste(depoisProj, { comSugestao: false });
  const antesR = resumoDemanda(atual); const depoisR = resumoDemanda(depois);
  const porId = (r) => new Map((r?.tarefas || []).map((x) => [x.id, x]));
  const a = porId(antesR); const d = porId(depoisR);
  const mudancas = []; const tarefas = [];
  for (const t of p.plano.tarefas) {
    const x = a.get(t.id) || {}; const y = d.get(t.id) || {};
    const item = { id: t.id, titulo: t.titulo, de: x.modelo, para: y.modelo, esforcoDe: x.esforco, esforcoPara: y.esforco, duracaoDe: x.duracaoSeg, duracaoPara: y.duracaoSeg, escolhido: cadPers[t.id]?.[0] || null };
    item.mudou = x.modelo !== y.modelo || x.esforco !== y.esforco || !!item.escolhido;
    tarefas.push(item);
    if (item.mudou) mudancas.push(item);
  }
  return {
    politica, estrategia: rec?.estrategia || (politica === 'ignorar' ? 'originais' : (politica === 'personalizado' ? 'personalizado' : 'manter')),
    motivo: politica === 'ignorar'
      ? (p.ajusteCota ? `Volta aos modelos de antes do ajuste "${NOMES_POLITICA[p.ajusteCota.politica] || p.ajusteCota.politica}".` : 'Nenhum ajuste foi aplicado; o plano já está com os modelos originais.')
      : (politica === 'personalizado' ? 'Escolha o modelo de cada tarefa na última coluna; a estimativa é refeita a cada troca.' : (rec?.motivo || '')),
    mudancas, tarefas, antes: antesR, depois: depoisR, ajusteAplicado: p.ajusteCota ? { politica: p.ajusteCota.politica, quando: p.ajusteCota.quando } : null,
    _cadeias: politica === 'personalizado' ? cadPers : (rec?.cadeiasSugeridas || {}), _esforcos: rec?.esforcosSugeridos || {},
  };
}
export function aplicarAjusteCotaNoPlano(p, politica, opcoes = {}) {
  if (!p?.plano) return { mudou: 0, texto: 'sem plano' };
  if (politica === 'ignorar') {
    p.politicaCota = 'ignorar';
    if (!p.ajusteCota) return { mudou: 0, texto: 'nada a desfazer; o plano já está com os modelos originais' };
    const n = (p.ajusteCota.anterior || []).length;
    const de = p.ajusteCota.politica;
    p.plano.tarefas = tarefasComAjusteAnterior(p);
    delete p.ajusteCota;
    p.demanda = calcularDemandaSegura(p);
    return { mudou: n, texto: `ajuste "${de}" desfeito; ${n} tarefa(s) voltaram aos modelos originais` };
  }
  const pv = previaAjusteCota(p, politica, opcoes);
  p.politicaCota = politica === 'personalizado' ? 'ignorar' : politica;
  const ids = new Set([...Object.keys(pv?._cadeias || {}), ...Object.keys(pv?._esforcos || {})]);
  if (!ids.size) return { mudou: 0, texto: pv?.motivo ? `nada muda (${pv.motivo})` : 'nada muda' };
  // Guarda as cadeias de antes do PRIMEIRO ajuste, para "manter originais" voltar ao plano do planejador.
  const anterior = p.ajusteCota?.anterior ? [...p.ajusteCota.anterior] : [];
  const jaSalvas = new Set(anterior.map((a) => a.id));
  for (const t of p.plano.tarefas) {
    if (!ids.has(t.id)) continue;
    if (!jaSalvas.has(t.id)) anterior.push({ id: t.id, cadeia: Array.isArray(t.cadeia) ? [...t.cadeia] : null, esforco: t.esforco || null });
    if (pv._cadeias[t.id]) t.cadeia = [...pv._cadeias[t.id]];
    if (pv._esforcos[t.id]) t.esforco = pv._esforcos[t.id];
    delete t.cadeiaEfetiva;
  }
  p.ajusteCota = { politica, quando: now(), anterior, mudancas: pv.mudancas };
  p.demanda = calcularDemandaSegura(p);
  return { mudou: ids.size, texto: `${ids.size} tarefa(s) com modelo ou esforço trocado. ${pv.motivo || ''}`.trim() };
}

export function calcularDemandaSegura(p) {
  if (!p?.plano) return null;
  try {
    const t0 = Date.now();
    const d = calcularDemandaEAjuste(p);
    if (Date.now() - t0 > 1000) return null;
    return d;
  } catch {
    return null;
  }
}

export function atualizarMensagemPlanoRecebido(p) {
  if (!p?.plano) return;
  const dem = calcularDemandaSegura(p);
  p.demanda = dem;
  const base = `Plano recebido: ${p.plano.tarefas.length} tarefas.`;
  const novoTexto = dem?.linhaResumo ? `${base}\n${dem.linhaResumo}` : base;
  if (Array.isArray(p.mensagens)) {
    for (let i = p.mensagens.length - 1; i >= 0; i--) {
      const m = p.mensagens[i];
      if (m && m.papel === 'sistema' && typeof m.texto === 'string' && m.texto.startsWith('Plano recebido:')) {
        m.texto = novoTexto;
        break;
      }
    }
  }
}

function startPipeline(p, resume = false) {
  if (!p.plano) return p;
  // Execução iniciada à mão (aprovar, retomar, executar de novo) cumpre a execução agendada pendente:
  // sem isso, o horário antigo dispara uma rodada nova depois (caso real 18/11, projeto Startup).
  if (p.agendamento?.executarEm && !p.agendamento.execucaoDisparadaEm) marcarExecucaoAgendadaDisparada(p);
  // Rodada nova ou retomada: a comparação estimado x real da rodada anterior deixa de valer (caso de
  // 18/11: a de uma rodada cancelada ficou na tela durante as seguintes). No fim ela é montada de novo.
  delete p.comparacaoEstimativa;
  if (!resume && temRodadaExecutada(p, pdir(p.id))) arquivarRodadaSePreciso(p, { manterPlano: true });
  // O ajuste por cota é aplicado no plano quando o usuário escolhe (aplicarAjusteCotaNoPlano), com prévia e
  // desfazer. Aqui não se troca modelo por conta própria: o bloco antigo dizia "aplicada" sem mudar nada.
  const pf = resume ? path.join(pdir(p.id), 'plan.json') : buildPlanFile(p);
  if (!resume) limparLogsRaiz(path.join(pdir(p.id), 'logs'));
  else {
    gravarSupervisao(p);
    // Resumo da execução anterior sairia como "terminou" logo depois de retomar.
    try { fs.rmSync(path.join(pdir(p.id), 'logs', 'summary.md'), { force: true }); } catch { /* sem resumo antigo */ }
  }
  try { p.pid = spawnPipeline(pf, resume); }
  catch (e) {
    p.estado = 'interrompido'; p.mensagens.push({ papel: 'sistema', texto: 'Falha ao iniciar o pipeline: ' + e.message, quando: now() });
    save(p); return p;
  }
  p.estado = 'executando';
  if (!resume) {
    p.inicio = now();
    const demAtual = calcularDemandaEAjuste(p) || p.demanda;
    if (demAtual && Array.isArray(demAtual.tarefas)) {
      const tarefasObj = {};
      for (const t of demAtual.tarefas) {
        if (!t || t.id == null) continue;
        tarefasObj[t.id] = {
          entrada: t.entradaEstimada ?? t.entrada ?? 0,
          saida: t.saidaEstimada ?? t.saida ?? 0,
          cacheLido: t.cacheLidoEstimado ?? t.cacheLido ?? 0,
          cacheGravado: t.cacheGravadoEstimado ?? t.cacheGravado ?? 0,
          duracaoSeg: t.duracaoSegEstimada ?? t.duracaoSeg ?? 0,
          modeloAssumido: t.modeloAssumido || null,
          demanda: t.demanda || null,
        };
      }
      p.estimativaInicial = {
        quando: now(),
        tarefas: tarefasObj,
        total: demAtual.total || null,
        tempo: demAtual.tempo || null,
      };
    }
  }
  p.fim = null;
  let msgExec = resume ? 'Execução retomada.' : `Execução iniciada (modo ${nomeModo(p)}, velocidade ${velDe(p)}, acompanhamento ${supDe(p)}, até ${paralelismo(p, cfgDe(p))} tarefas ao mesmo tempo, conforme a cota).`;
  if (!resume && p.auto) {
    const dem = p.demanda || calcularDemandaSegura(p);
    if (dem?.linhaResumo) {
      msgExec += `\n${dem.linhaResumo}`;
    }
  }
  p.mensagens.push({ papel: 'sistema', texto: msgExec, quando: now() });
  save(p);
  report(p);
  if (!resume) logDiario(p, 'Iniciado', [`**Iniciado:** execução do plano (${p.plano.tarefas.length} tarefas, modo ${nomeModo(p)}, velocidade ${velDe(p)}) em \`${p.repo}\`.`]);
  return p;
}

function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

function lerJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch { return null; } }
function cauda(f, bytes = 65536) {
  try {
    const st = fs.statSync(f); const fd = fs.openSync(f, 'r');
    const bom = Buffer.alloc(2); fs.readSync(fd, bom, 0, 2, 0);
    const utf16 = bom[0] === 0xff && bom[1] === 0xfe; // log antigo gravado pelo PowerShell 5.1
    let n = Math.min(bytes, st.size); if (utf16 && (st.size - n) % 2) n--;
    const b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, st.size - n); fs.closeSync(fd);
    return b.toString(utf16 ? 'utf16le' : 'utf8').replace(/^﻿/, '');
  } catch { return ''; }
}

function readRun(p) {
  const logs = path.join(pdir(p.id), 'logs');
  const r = { status: lerJson(path.join(logs, 'status.json')) || {}, log: '', summary: '', gates: gatesPendentes(p), desespero: false };
  const linhas = cauda(path.join(logs, 'pipeline.log'), 30000).split(/\r?\n/);
  r.log = linhas.slice(-60).join('\n');
  const ultimaDesp = linhas.filter((l) => /desperate mode (ON|OFF)/.test(l)).pop();
  r.desespero = !!ultimaDesp && /ON/.test(ultimaDesp);
  try { r.summary = fs.readFileSync(path.join(logs, 'summary.md'), 'utf8'); } catch {}
  return r;
}

// ---------- confirmações (gates) ----------
// O pipeline grava logs/gates/<gate>.json e espera <gate>.ok ou <gate>.no.
const gateOk = (g) => typeof g === 'string' && /^[a-z0-9_-]{1,40}$/.test(g);
function gatesPendentes(p) {
  const d = path.join(pdir(p.id), 'logs', 'gates');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => {
    const g = f.slice(0, -5);
    if (fs.existsSync(path.join(d, g + '.ok')) || fs.existsSync(path.join(d, g + '.no'))) return null;
    const j = lerJson(path.join(d, f)) || {};
    return { gate: g, motivo: String(j.reason || ''), tarefa: j.task || null, desde: j.time || null };
  }).filter(Boolean);
}
function decidirGate(p, g, sim) {
  const d = path.join(pdir(p.id), 'logs', 'gates');
  if (!gateOk(g) || !fs.existsSync(path.join(d, g + '.json'))) return false;
  if (fs.existsSync(path.join(d, g + '.ok')) || fs.existsSync(path.join(d, g + '.no'))) return false;
  fs.writeFileSync(path.join(d, g + (sim ? '.ok' : '.no')), now());
  evento(p, { tipo: 'confirmacao', tarefa: g, texto: sim ? 'confirmado pelo usuário' : 'recusado pelo usuário' });
  return true;
}

// ---------- atividade ----------
function evento(p, e) {
  try {
    const d = path.join(pdir(p.id), 'logs'); fs.mkdirSync(d, { recursive: true });
    fs.appendFileSync(path.join(d, 'events.jsonl'), JSON.stringify({ time: horaLocal(), ...e }) + '\n');
  } catch {}
}
// Mesmo formato do pipeline (PowerShell 'Get-Date -Format s'): hora local, sem fuso.
function horaLocal() { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19); }
function eventos(p, n = 40) {
  return cauda(path.join(pdir(p.id), 'logs', 'events.jsonl'), 48000).split(/\r?\n/).filter(Boolean)
    .map((l) => { try { return JSON.parse(l.replace(/^﻿/, '')); } catch { return null; } }).filter(Boolean).slice(-n);
}
// Última ação legível de um log de trabalhador (stream-json do Claude, json do opencode ou texto do agy).
function ultimaAcao(texto) {
  const linhas = texto.split(/\r?\n/).filter((l) => l.trim());
  let espera = '';
  const com = (x) => (espera ? `${x} · ${espera}` : x);
  for (let i = linhas.length - 1; i >= 0 && i >= linhas.length - 200; i--) {
    const l = linhas[i].trim();
    if (l.startsWith('{')) {
      try {
        const e = JSON.parse(l);
        const blocos = e.message?.content;
        if (e.type === 'assistant' && Array.isArray(blocos)) {
          const tu = [...blocos].reverse().find((b) => b.type === 'tool_use');
          if (tu) return com(resumoFerramenta(tu.name, tu.input));
          const tx = [...blocos].reverse().find((b) => b.type === 'text' && b.text?.trim());
          if (tx) return com(tx.text.trim().slice(0, 200));
        }
        if (e.type === 'tool_use' && e.part) return com(resumoFerramenta(e.part.tool, e.part.state?.input));
        // opencode entre passos (o mais recente vence): guarda a espera e continua procurando a última ação,
        // para mostrar as duas juntas ("bash: ... · esperando o modelo há 40 s").
        if ((e.type === 'step_start' || e.type === 'step_finish') && Number.isFinite(e.timestamp)) {
          if (!espera) {
            const s = Math.max(0, Math.round((Date.now() - e.timestamp) / 1000));
            espera = `esperando o modelo há ${s < 90 ? `${s} s` : `${Math.round(s / 60)} min`}`;
          }
          continue;
        }
        if (e.type === 'text' && e.part?.text) return com(e.part.text.trim().slice(0, 200));
        if (e.type === 'result' && e.result) return 'terminou: ' + String(e.result).trim().slice(0, 160);
      } catch {}
      continue;
    }
    return com(l.slice(0, 200));
  }
  return espera;
}
function resumoFerramenta(nome, inp = {}) {
  const alvo = inp?.file_path || inp?.filePath || inp?.path || inp?.command || inp?.pattern || inp?.url || inp?.description || '';
  return `${nome}${alvo ? ': ' + String(alvo).replace(/\s+/g, ' ').slice(0, 160) : ''}`;
}
export function agoraNaTarefa(p, id) {
  const ld = path.join(pdir(p.id), 'logs', id);
  if (!fs.existsSync(ld)) return null;
  // O log da tentativa atual é o mais recente (não o de maior número: uma rodada nova ou retomada recomeça
  // a numeração em 1 e os logs da rodada anterior continuam na pasta; caso de 18/11, painel mostrava a
  // última ação de uma tentativa parada havia 30 min).
  const outs = fs.readdirSync(ld).filter((f) => /^\d+-.*\.out\.log$/.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(ld, f)).mtimeMs })).sort((a, b) => a.t - b.t).map((x) => x.f);
  if (!outs.length) return null;
  const cur = lerJson(path.join(ld, 'current.json')) || {};
  const doAtual = cur.attempt ? outs.filter((x) => parseInt(x) === Number(cur.attempt)) : [];
  const f = doAtual.length ? doAtual[doAtual.length - 1] : outs[outs.length - 1];
  const st = fs.statSync(path.join(ld, f));
  const fim = cur.worker ? null : lerJson(path.join(ld, 'result.json'));
  let acao = ultimaAcao(cauda(path.join(ld, f)));
  let atualizado = st.mtime;
  if (!acao) {
    const errFile = path.join(ld, f.replace(/\.out\.log$/, '.err.log'));
    // .err.log ausente, vazio ou ilegível não pode derrubar o painel: cauda() já devolve '' em falha de leitura.
    const errAcao = ultimaAcao(cauda(errFile));
    if (errAcao) {
      acao = 'erro: ' + errAcao;
      try { const errSt = fs.statSync(errFile); if (errSt.mtime > atualizado) atualizado = errSt.mtime; } catch {}
    }
  }
  return { tentativa: parseInt(f), modelo: cur.worker || fim?.model || null, verificando: !!fim, arquivo: f, acao, atualizado: atualizado.toISOString() };
}
function commitsRecentes(repo) {
  return new Promise((resolve) => {
    if (!isGitRepo(repo)) return resolve([]);
    execFile('git', ['-C', repo, 'log', '-6', '--format=%h%x09%ad%x09%an%x09%s', '--date=format:%d/%m %H:%M'], { encoding: 'utf8', windowsHide: true, timeout: 8000 },
      (e, out) => resolve(e ? [] : out.split(/\r?\n/).filter(Boolean).map((l) => { const [h, d, a, s] = l.split('\t'); return { hash: h, quando: d, autor: a, assunto: s }; })));
  });
}
async function atividade(p) {
  const run = readRun(p);
  const tarefas = Object.fromEntries((p.plano?.tarefas || []).map((t) => [t.id, t]));
  const rodando = Object.entries(run.status).filter(([, v]) => v && (v.state === 'running' || v.state === 'waiting'))
    .map(([id, v]) => {
      const agora = v.state === 'running' ? agoraNaTarefa(p, v.note === 'fixing' ? id + '-fix' : id) : null;
      return { id, titulo: tarefas[id]?.titulo || '', estado: v.state, modelo: agora?.modelo || v.model || null, desde: v.started, nota: v.note, agora };
    });
  return { id: p.id, titulo: p.titulo, estado: p.estado, ocupado: !!p.ocupado, modo: nomeModo(p), velocidade: velDe(p), supervisao: supDe(p), desespero: run.desespero,
    rodando, gates: run.gates, eventos: eventos(p), commits: await commitsRecentes(p.repo) };
}

function poll() {
  for (const p of listAll()) {
    const acaoAg = avaliarAgendamentoProjeto(p);
    if (acaoAg.acao === 'planejar') {
      marcarPlanejamentoAgendadoDisparado(p);
      if (acaoAg.autoExecutarDepois) p.auto = true;
      p.mensagens.push({ papel: 'sistema', texto: 'Horário agendado atingido: iniciando planejamento.', quando: now() });
      save(p);
      plannerTurn(p, p.pedido).catch((e) => console.error(e));
      continue;
    }
    if (acaoAg.acao === 'executar') {
      marcarExecucaoAgendadaDisparada(p);
      const msgTexto = acaoAg.reexecutar
        ? 'Horário agendado atingido: executando o plano de novo (rodada nova).'
        : 'Horário agendado atingido: iniciando execução.';
      p.mensagens.push({ papel: 'sistema', texto: msgTexto, quando: now() });
      evento(p, { tipo: 'agendamento', texto: msgTexto });
      save(p);
      startPipeline(p);
      continue;
    }
    const diagAg = diagnosticarAgendamentoNaHora(p);
    if (diagAg) {
      marcarExecucaoAgendadaFalhou(p, diagAg.motivo);
      const pendenciaTexto = diagAg.tipoPendencia === 'planejar' ? 'o planejamento' : 'a execução';
      const textoFalha = `Horário agendado atingido, mas ${pendenciaTexto} não pôde começar: ${diagAg.motivo}`;
      p.mensagens.push({ papel: 'sistema', texto: textoFalha, quando: now() });
      evento(p, { tipo: 'agendamento', texto: textoFalha });
      save(p);
      report(p);
    }
    if (p.estado !== 'executando') continue;
    const r = readRun(p);
    const h = crypto.createHash('md5').update(JSON.stringify(r.status)).digest('hex');
    // Retomar reaproveita o pipeline.log: só termina se o último "pipeline end" vier depois do último "pipeline start".
    const ended = r.summary && r.log.lastIndexOf('pipeline end') > r.log.lastIndexOf('pipeline start');
    if (ended) {
      p.estado = /RESULTADO: CONCLUIDO/.test(r.summary) ? 'concluido' : 'incompleto';
      p.fim = now();
      montarComparacaoEstimativa(p, r);
      p.mensagens.push({ papel: 'sistema', texto: `Execução terminou: ${p.estado}.`, quando: now() });
      p.retomadasAuto = 0;
      try { p.resumoFinal = resumoFinal(p, r); p.mensagens.push({ papel: 'resumo', texto: p.resumoFinal, quando: now() }); } catch (e) { console.error('resumo', e); }
      save(p); report(p, r);
      const st = Object.entries(r.status).map(([k, v]) => `${k} ${v.state}${v.model ? ' (' + v.model + ')' : ''}`).join(', ');
      logDiario(p, p.estado === 'concluido' ? 'Concluído' : 'Incompleto', [
        `**${p.estado === 'concluido' ? 'Concluído' : 'Incompleto'}:** ${st}.`,
        `**Relatório:** [[orquestracao/${p.id}]]; logs em \`${path.join(pdir(p.id), 'logs')}\`.`,
        ...(p.estado === 'concluido' ? [] : ['**Pendências:** ver tarefas não concluídas no relatório; retomar pelo painel ou `cli.mjs retomar`.']),
      ]);
    } else if (!alive(p.pid)) {
      // Pipeline caiu (PC reiniciou, processo encerrado): retoma sozinho até 3 vezes; depois, só manual.
      const n = (p.retomadasAuto || 0) + 1;
      if (n <= 3) {
        p.retomadasAuto = n;
        p.mensagens.push({ papel: 'sistema', texto: `O processo do pipeline parou sem terminar; retomando sozinho (tentativa ${n} de 3). As tarefas concluídas não são refeitas e a que estava no meio continua de onde parou.`, quando: now() });
        save(p); evento(p, { tipo: 'pipeline', texto: `retomada automática ${n}/3` });
        startPipeline(load(p.id), true);
      } else {
        p.estado = 'interrompido';
        montarComparacaoEstimativa(p, r);
        p.mensagens.push({ papel: 'sistema', texto: 'O processo do pipeline parou de novo depois de 3 retomadas automáticas. Veja o log e use Retomar.', quando: now() });
        save(p); report(p, r);
      }
    } else if (h !== p.statusHash) {
      p.statusHash = h; save(p); report(p, r);
    }
  }
}

// ---------- uso de tokens e custos ----------
const PROVEDORES_USO = ['claude', 'agy', 'opencode'];
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const numOuNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const arred = (v) => (v === null ? null : Math.round(v * 1e6) / 1e6);

function partesModelo(entry, provPadrao) {
  const s = modeloSemEsforco(entry);
  const i = s.indexOf(':');
  if (i > 0 && PROVEDORES_USO.includes(s.slice(0, i))) return { provedor: s.slice(0, i), modelo: s.slice(i + 1) };
  return { provedor: provPadrao || 'desconhecido', modelo: s };
}

const PESO_ORIGEM = { desconhecido: 5, estimado: 4, aproximado: 3, tabela: 2, gratuito: 1, cli: 0 };
function piorOrigem(origens) {
  let pior = 'cli';
  let maxPeso = -1;
  for (const o of origens) {
    if (!o) continue;
    const p = PESO_ORIGEM[o] ?? 2;
    if (p > maxPeso) {
      maxPeso = p;
      pior = o;
    }
  }
  return pior;
}

const cacheArquivosUso = new Map();
// Tokens reais de uma tentativa do agy pelos logs locais (brain), quando a saída da CLI não trouxe contagem
// (tentativas antigas, ou o prompt da tentativa não foi guardado). O prompt vem do .prompt.txt da tentativa ou,
// na falta dele, do prompt da tarefa com {WT} trocado pela worktree. Cache de 30 s para tentativa em andamento.
const cacheBrain = new Map();
function usoAgyReal(p, taskId, entry, pf, inicioMs, fimMs, rodando) {
  if (!String(entry || '').startsWith('agy:') || !Number.isFinite(inicioMs)) return null;
  const chave = `${p.id}/${taskId}/${entry}/${inicioMs}`;
  const c = cacheBrain.get(chave);
  if (c && (!rodando || Date.now() - c.t < 30000)) return c.v;
  let prompt = '';
  try { prompt = fs.readFileSync(pf, 'utf8'); } catch {
    try {
      prompt = fs.readFileSync(path.join(pdir(p.id), 'prompts', `${taskId}.md`), 'utf8');
      const pl = lerJson(path.join(pdir(p.id), 'plan.json'));
      const tk = (pl?.tasks || []).find((x) => x.id === taskId);
      if (tk?.worktree && pl.worktreeRoot) prompt = prompt.split('{WT}').join(path.join(pl.worktreeRoot, tk.worktree));
    } catch {}
  }
  const v = prompt ? usoAgyBrain(prompt, inicioMs, rodando ? Date.now() : fimMs, entry) : null;
  if (cacheBrain.size > 500) cacheBrain.clear();
  cacheBrain.set(chave, { t: Date.now(), v });
  return v;
}

function comCacheArquivo(caminho, fn) {
  if (!caminho) return null;
  try {
    const st = fs.statSync(caminho);
    const chave = `${path.resolve(caminho)}:${st.mtimeMs}:${st.size}`;
    if (cacheArquivosUso.has(chave)) return cacheArquivosUso.get(chave);
    const val = fn(caminho, st);
    if (cacheArquivosUso.size > 2000) cacheArquivosUso.clear();
    cacheArquivosUso.set(chave, val);
    return val;
  } catch (e) {
    console.error('calcularDemandaEAjuste:', e?.message || e);
    return null;
  }
}

function lerResultJsonComCache(arquivo) {
  return comCacheArquivo(arquivo, () => lerJson(arquivo));
}

function dadosUsoDoProjeto(p, tabela) {
  return dadosUsoProjetoComRodadas(p, {
    projDir: pdir(p.id),
    dataDir: DATA,
    tabela: tabela || carregarPrecos({ dataDir: DATA }),
    usoAgyReal: (proj, taskId, entry, pf, ini, fim, rod) => usoAgyReal(proj, taskId, entry, pf, ini, fim, rod)
  });
}

function dadosUsoPublico(p, tabela) {
  const dados = dadosUsoDoProjeto(p, tabela);
  const tarefas = dados.tarefas.map((tf) => ({
    id: tf.id,
    titulo: tf.titulo,
    estado: tf.estado,
    ...(tf.rodada ? { rodada: tf.rodada } : {}),
    total: tf.total,
    tentativas: tf.tentativas.map(({ porModelo: _pm, ...rest }) => rest)
  }));
  const rodadas = (dados.rodadas || []).map((r) => ({
    ...r,
    tarefas: (r.tarefas || []).map(({ tentativas, ...rest }) => ({
      ...rest,
      tentativas: (tentativas || []).map(({ porModelo: _pm, ...tRest }) => tRest)
    }))
  }));
  return {
    emAndamento: dados.emAndamento,
    total: dados.total,
    modelos: dados.modelos,
    tarefas,
    rodadas
  };
}

export function parseFiltroUso(searchParams, agora = new Date()) {
  if (!searchParams || typeof searchParams.has !== 'function') {
    return { ok: false, erro: 'período inválido' };
  }

  const hasMes = searchParams.has('mes');
  const hasDe = searchParams.has('de');
  const hasAte = searchParams.has('ate');

  if (hasMes) {
    if (hasDe || hasAte) return { ok: false, erro: 'período inválido' };
    const mesStr = searchParams.get('mes');
    if (!mesStr || !/^\d{4}-(0[1-9]|1[0-2])$/.test(mesStr)) {
      return { ok: false, erro: 'período inválido' };
    }
    const [anoStr, mesNumStr] = mesStr.split('-');
    const ano = Number(anoStr);
    const mes = Number(mesNumStr);
    const inicioMs = new Date(ano, mes - 1, 1, 0, 0, 0, 0).getTime();
    const fimMs = new Date(ano, mes, 1, 0, 0, 0, 0).getTime() - 1;
    return { ok: true, tipo: 'mes', rotulo: mesStr, inicioMs, fimMs };
  }

  if (hasDe || hasAte) {
    const de = searchParams.has('de') ? searchParams.get('de') : null;
    const ate = searchParams.has('ate') ? searchParams.get('ate') : null;

    const validarData = (str) => {
      if (!str || typeof str !== 'string') return null;
      if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(str)) return null;
      const [y, m, d] = str.split('-').map(Number);
      const dt = new Date(y, m - 1, d);
      if (dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d) {
        return { y, m, d };
      }
      return null;
    };

    let inicioMs = -Infinity;
    let fimMs = Infinity;

    if (de !== null) {
      const v = validarData(de);
      if (!v) return { ok: false, erro: 'período inválido' };
      inicioMs = new Date(v.y, v.m - 1, v.d, 0, 0, 0, 0).getTime();
    }
    if (ate !== null) {
      const v = validarData(ate);
      if (!v) return { ok: false, erro: 'período inválido' };
      fimMs = new Date(v.y, v.m - 1, v.d, 23, 59, 59, 999).getTime();
    }

    if (de !== null && ate !== null && inicioMs > fimMs) {
      return { ok: false, erro: 'período inválido' };
    }

    const rotulo = de && ate ? `${de} a ${ate}` : (de ? `desde ${de}` : `até ${ate}`);
    return { ok: true, tipo: 'intervalo', rotulo, inicioMs, fimMs };
  }

  const periodo = searchParams.has('periodo') ? searchParams.get('periodo') : '30d';
  if (!['hoje', '7d', '30d', 'tudo'].includes(periodo)) {
    return { ok: false, erro: 'período inválido' };
  }
  return { ok: true, tipo: 'predefinido', rotulo: periodo, periodo };
}

export function noPeriodo(dtStr, filtroOuPeriodo, agora = new Date()) {
  const per = typeof filtroOuPeriodo === 'string' ? filtroOuPeriodo : filtroOuPeriodo?.periodo;
  if (per === 'tudo') return true;
  if (!dtStr) return false;
  const t = new Date(dtStr).getTime();
  if (Number.isNaN(t)) return false;

  if (typeof filtroOuPeriodo === 'object' && filtroOuPeriodo !== null) {
    if (filtroOuPeriodo.inicioMs !== undefined && filtroOuPeriodo.fimMs !== undefined) {
      return t >= filtroOuPeriodo.inicioMs && t <= filtroOuPeriodo.fimMs;
    }
  }

  if (per === 'hoje') {
    const inicioHoje = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate()).getTime();
    return t >= inicioHoje;
  }
  if (per === '7d') {
    return t >= agora.getTime() - 7 * 86400000;
  }
  if (per === '30d') {
    return t >= agora.getTime() - 30 * 86400000;
  }
  return false;
}

export function respostaUsoGeral(filtroOuPeriodo, tabela) {
  tabela = tabela || carregarPrecos({ dataDir: DATA });
  const todos = listAll();
  const modelosMap = new Map();
  const totGeral = { entrada: 0, saida: 0, cacheLido: 0, cacheGravado: 0, usd: 0, brl: 0, aproximado: false };
  const origensGerais = [];
  const projetosNoPeriodo = new Set();
  const agora = new Date();

  for (const p of todos) {
    const dados = dadosUsoDoProjeto(p, tabela);
    let projetoTeveNoPeriodo = false;

    for (const tf of dados.tarefas) {
      for (const tent of tf.tentativas) {
        const dataRef = tent.fim || tent.inicio;
        if (!noPeriodo(dataRef, filtroOuPeriodo, agora)) continue;
        projetoTeveNoPeriodo = true;

        totGeral.entrada += tent.entrada;
        totGeral.saida += tent.saida;
        totGeral.cacheLido += tent.cacheLido;
        totGeral.cacheGravado += tent.cacheGravado;
        if (tent.usd !== null) totGeral.usd = (totGeral.usd || 0) + tent.usd;
        if (tent.origem) origensGerais.push(tent.origem);

        const linhas = Array.isArray(tent.porModelo) && tent.porModelo.length ? tent.porModelo : [{
          provedor: tent.provedor,
          modelo: tent.modelo,
          entrada: tent.entrada,
          saida: tent.saida,
          cacheLido: tent.cacheLido,
          cacheGravado: tent.cacheGravado,
          usd: tent.usd,
          origem: tent.origem
        }];

        for (const l of linhas) {
          const chave = `${l.provedor}:${l.modelo}`;
          let m = modelosMap.get(chave);
          if (!m) {
            m = {
              provedor: l.provedor,
              modelo: l.modelo,
              entrada: 0,
              saida: 0,
              cacheLido: 0,
              cacheGravado: 0,
              usd: 0,
              origens: [],
              fontes: [],
              assinatura: assinaturaDe(l.provedor)
            };
            modelosMap.set(chave, m);
          }
          m.entrada += l.entrada;
          m.saida += l.saida;
          m.cacheLido += l.cacheLido;
          m.cacheGravado += l.cacheGravado;
          if (l.usd !== null) m.usd = (m.usd || 0) + l.usd;
          m.origens.push(l.origem || tent.origem);
          m.fontes.push(tent.fonte);
        }
      }
    }
    if (projetoTeveNoPeriodo) projetosNoPeriodo.add(p.id);
  }

  totGeral.usd = arred(totGeral.usd);
  totGeral.brl = totGeral.usd !== null ? emBrl(tabela, totGeral.usd) : null;
  totGeral.aproximado = origensGerais.some((o) => o === 'aproximado' || o === 'estimado');

  const modelos = Array.from(modelosMap.values()).map((m) => {
    const usd = arred(m.usd);
    return {
      provedor: m.provedor,
      modelo: m.modelo,
      entrada: m.entrada,
      saida: m.saida,
      cacheLido: m.cacheLido,
      cacheGravado: m.cacheGravado,
      usd,
      brl: usd !== null ? emBrl(tabela, usd) : null,
      origem: piorOrigem(m.origens),
      assinatura: m.assinatura,
      estimado: m.origens.some((o) => o === 'estimado') || m.fontes.some((f) => f === 'estimado')
    };
  }).sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0) || (b.entrada + b.saida) - (a.entrada + a.saida));

  const modelosConsolidados = consolidarListaModelos(modelos, { removerZerados: true });

  const rotuloPeriodo = typeof filtroOuPeriodo === 'object' && filtroOuPeriodo !== null
    ? (filtroOuPeriodo.rotulo ?? filtroOuPeriodo.periodo)
    : filtroOuPeriodo;

  // Consumo fora do orquestrador (Claude Code e Antigravity usados à parte). Vem de state/uso-fora.json, refeito no
  // máximo 1x por dia em processo separado; as respostas que são de tarefas do orquestrador já saíram de lá.
  const snap = lerUsoFora(DATA);
  if (usoForaVencido(snap)) atualizarUsoForaEmSegundoPlano();
  const porModeloFora = usoForaNoPeriodo(snap, (d) => noPeriodo(`${d}T12:00:00`, filtroOuPeriodo, agora));
  const totFora = { entrada: 0, saida: 0, cacheLido: 0, cacheGravado: 0, usd: 0, brl: null };
  const modelosFora = Object.entries(porModeloFora).map(([chave, u]) => {
    const [provedor, ...resto] = chave.split(':');
    const modelo = resto.join(':');
    const c = /nao-registrado|desconhecido/.test(modelo) ? { usd: null } : custoUsd(tabela, { modelo: chave, ...u });
    for (const k of ['entrada', 'saida', 'cacheLido', 'cacheGravado']) totFora[k] += u[k];
    if (c.usd != null) totFora.usd += c.usd;
    return { provedor, modelo, ...u, usd: c.usd != null ? arred(c.usd) : null, brl: c.usd != null ? emBrl(tabela, c.usd) : null, assinatura: assinaturaDe(provedor) };
  }).filter((m) => m.entrada + m.saida + m.cacheLido + m.cacheGravado > 0)
    .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0) || (b.saida - a.saida));
  totFora.usd = arred(totFora.usd);
  totFora.brl = emBrl(tabela, totFora.usd);
  const somaGeral = { ...totGeral };
  for (const k of ['entrada', 'saida', 'cacheLido', 'cacheGravado']) somaGeral[k] = (totGeral[k] || 0) + totFora[k];
  somaGeral.usd = arred((totGeral.usd || 0) + (totFora.usd || 0));
  somaGeral.brl = emBrl(tabela, somaGeral.usd);

  return {
    periodo: rotuloPeriodo,
    precosAtualizados: tabela.atualizado || null,
    usdBrl: tabela.usdBrl ?? null,
    modelos: modelosConsolidados,
    total: totGeral,
    projetos: projetosNoPeriodo.size,
    foraOrquestrador: {
      atualizado: snap?.atualizado || null,
      emAtualizacao: !!usoForaRodando,
      excluidos: snap?.excluidos || null,
      modelos: modelosFora,
      total: totFora,
    },
    totalGeral: somaGeral,
    aviso: 'Claude Code e Antigravity são assinaturas: o custo é o equivalente em API.'
  };
}

// Refaz state/uso-fora.json em outro processo (varrer semanas de transcripts trava o painel se for aqui dentro).
let usoForaRodando = null;
export function atualizarUsoForaEmSegundoPlano({ forcar = false } = {}) {
  if (usoForaRodando) return usoForaRodando;
  if (!forcar && !usoForaVencido(lerUsoFora(DATA))) return null;
  if (process.env.DELEGAR_SEM_USO_FORA === '1' || process.env.DELEGAR_PROVEDORES === 'nenhum') return null; // testes
  usoForaRodando = new Promise((resolve) => {
    const filho = spawn(process.execPath, [fileURLToPath(new URL('./uso-fora.mjs', import.meta.url)), DATA], { windowsHide: true, stdio: 'ignore' });
    const fim = () => { usoForaRodando = null; resolve(); };
    filho.on('exit', fim); filho.on('error', fim);
  });
  return usoForaRodando;
}

// gravar: false monta a comparação ao vivo (execução em andamento): não grava estimativas.jsonl e conta
// o tempo das tarefas que ainda estão rodando até agora.
export function montarComparacaoEstimativa(p, run, { dataDir = DATA, projDir = null, gravar = true } = {}) {
  if (!p?.estimativaInicial?.tarefas) return null;
  try {
    const estIni = p.estimativaInicial;
    const estTarefas = estIni.tarefas || {};
    const tabela = carregarPrecos({ dataDir });
    const dirDoProj = projDir || pdir(p.id);
    const usoProj = dadosUsoProjetoComRodadas(p, {
      projDir: dirDoProj,
      dataDir,
      tabela,
      usoAgyReal: (proj, taskId, entry, pf, ini, fim, rod) => usoAgyReal(proj, taskId, entry, pf, ini, fim, rod),
    });
    const rodadaAtual = usoProj.rodadas?.[usoProj.rodadas.length - 1];
    const mapaTarefasUso = Object.fromEntries((rodadaAtual?.tarefas || usoProj.tarefas).map((t) => [t.id, t]));
    const logs = path.join(dirDoProj, 'logs');

    const tarefasComp = [];
    const listaTarefasPlano = Array.isArray(p.plano?.tarefas) ? p.plano.tarefas : [];

    const calcErro = (real, est) => {
      const r = Number(real) || 0;
      const e = Number(est) || 0;
      if (e > 0) return Math.round(((r - e) / e) * 10000) / 10000;
      return null;
    };

    let somaEstEntrada = 0, somaRealEntrada = 0;
    let somaEstSaida = 0, somaRealSaida = 0;
    let somaEstCacheLido = 0, somaRealCacheLido = 0;
    let somaEstCacheGravado = 0, somaRealCacheGravado = 0;
    let somaEstDuracao = 0, somaRealDuracao = 0;
    // Tempo total = do primeiro início ao último fim (com workers simultâneos, a soma das tarefas não é o tempo total).
    let iniRun = Infinity, fimRun = -Infinity;

    for (const t of listaTarefasPlano) {
      const tid = String(t.id);
      const est = estTarefas[tid] || {};
      const tUso = mapaTarefasUso[tid]?.total || {};
      const resPath = path.join(logs, tid, 'result.json');
      const res = lerJson(resPath) || {};
      const attempts = Array.isArray(res.attempts) ? res.attempts : [];

      let realDuracaoSeg = 0;
      let temHorarios = false;
      if (attempts.length > 0) {
        for (const a of attempts) {
          if (a && a.started && a.finished) {
            const ini = Date.parse(a.started);
            const fim = Date.parse(a.finished);
            if (Number.isFinite(ini) && Number.isFinite(fim) && fim >= ini) {
              realDuracaoSeg += (fim - ini) / 1000;
              temHorarios = true;
            }
          }
        }
      }
      const emAndamento = !gravar && run?.status?.[tid]?.state === 'running';
      if (!temHorarios || emAndamento) {
        const ini = Date.parse(run?.status?.[tid]?.started || res.started || res.inicio || '');
        const fim = emAndamento ? Date.now() : Date.parse(res.finished || res.fim || run?.status?.[tid]?.finished || '');
        realDuracaoSeg = 0;
        if (Number.isFinite(ini) && Number.isFinite(fim) && fim >= ini) {
          realDuracaoSeg = (fim - ini) / 1000;
        }
      }
      realDuracaoSeg = Math.max(0, Math.round(realDuracaoSeg));
      {
        const inis = attempts.map((a) => Date.parse(a?.started || '')).filter(Number.isFinite);
        const fins = attempts.map((a) => Date.parse(a?.finished || '')).filter(Number.isFinite);
        const i0 = inis.length ? Math.min(...inis) : Date.parse(run?.status?.[tid]?.started || res.started || '');
        const f0 = emAndamento ? Date.now() : (fins.length ? Math.max(...fins) : Date.parse(run?.status?.[tid]?.finished || res.finished || ''));
        if (Number.isFinite(i0)) iniRun = Math.min(iniRun, i0);
        if (Number.isFinite(f0)) fimRun = Math.max(fimRun, f0);
      }

      const tentSucesso = attempts.slice().reverse().find(
        (a) => a && (a.ok === true || a.failed === false || a.code === 0)
      );
      const tentEscolhida = tentSucesso || attempts[attempts.length - 1] || res;
      const modeloReal = String(
        tentEscolhida?.worker || tentEscolhida?.modelo || tentEscolhida?.model || res.model || run?.status?.[tid]?.model || ''
      );

      const estEntrada = Number(est.entrada) || 0;
      const estSaida = Number(est.saida) || 0;
      const estCacheLido = Number(est.cacheLido) || 0;
      const estCacheGravado = Number(est.cacheGravado) || 0;
      const estDuracaoSeg = Number(est.duracaoSeg) || 0;

      const realEntrada = Number(tUso.entrada) || 0;
      const realSaida = Number(tUso.saida) || 0;
      const realCacheLido = Number(tUso.cacheLido) || 0;
      const realCacheGravado = Number(tUso.cacheGravado) || 0;

      somaEstEntrada += estEntrada;
      somaRealEntrada += realEntrada;
      somaEstSaida += estSaida;
      somaRealSaida += realSaida;
      somaEstCacheLido += estCacheLido;
      somaRealCacheLido += realCacheLido;
      somaEstCacheGravado += estCacheGravado;
      somaRealCacheGravado += realCacheGravado;
      somaEstDuracao += estDuracaoSeg;
      somaRealDuracao += realDuracaoSeg;

      const estimadoObj = {
        entrada: estEntrada,
        saida: estSaida,
        cacheLido: estCacheLido,
        cacheGravado: estCacheGravado,
        duracaoSeg: estDuracaoSeg,
      };

      const realObj = {
        entrada: realEntrada,
        saida: realSaida,
        cacheLido: realCacheLido,
        cacheGravado: realCacheGravado,
        duracaoSeg: realDuracaoSeg,
      };

      const erroRelObj = {
        entrada: calcErro(realEntrada, estEntrada),
        saida: calcErro(realSaida, estSaida),
        cacheLido: calcErro(realCacheLido, estCacheLido),
        cacheGravado: calcErro(realCacheGravado, estCacheGravado),
        duracaoSeg: calcErro(realDuracaoSeg, estDuracaoSeg),
      };

      tarefasComp.push({
        id: tid,
        demanda: est.demanda || categoriaDemanda(t),
        modeloAssumido: est.modeloAssumido || null,
        modeloReal: modeloReal || null,
        estimado: estimadoObj,
        real: realObj,
        erroRel: erroRelObj,
      });
    }

    const totEstimado = {
      entrada: somaEstEntrada,
      saida: somaEstSaida,
      cacheLido: somaEstCacheLido,
      cacheGravado: somaEstCacheGravado,
      duracaoSeg: Number(estIni.tempo?.totalSeg) > 0 ? Math.round(Number(estIni.tempo.totalSeg)) : somaEstDuracao,
      duracaoSomadaSeg: somaEstDuracao,
    };
    const totReal = {
      entrada: somaRealEntrada,
      saida: somaRealSaida,
      cacheLido: somaRealCacheLido,
      cacheGravado: somaRealCacheGravado,
      duracaoSeg: Number.isFinite(iniRun) && fimRun >= iniRun ? Math.round((fimRun - iniRun) / 1000) : somaRealDuracao,
      duracaoSomadaSeg: somaRealDuracao,
    };
    const totErroRel = {
      entrada: calcErro(somaRealEntrada, somaEstEntrada),
      saida: calcErro(somaRealSaida, somaEstSaida),
      cacheLido: calcErro(somaRealCacheLido, somaEstCacheLido),
      cacheGravado: calcErro(somaRealCacheGravado, somaEstCacheGravado),
      duracaoSeg: null,
    };
    totErroRel.duracaoSeg = calcErro(totReal.duracaoSeg, totEstimado.duracaoSeg);

    const comp = {
      quando: now(),
      tarefas: tarefasComp,
      total: {
        estimado: totEstimado,
        real: totReal,
        erroRel: totErroRel,
      },
      gravadoEm: p.comparacaoEstimativa?.gravadoEm || null,
    };

    if (!gravar) { comp.aoVivo = true; return comp; }
    if (!comp.gravadoEm) {
      try {
        const stateDir = path.join(dataDir, 'state');
        fs.mkdirSync(stateDir, { recursive: true });
        const jsonlPath = path.join(stateDir, 'estimativas.jsonl');
        const linhas = tarefasComp.map((tc) => JSON.stringify({
          projeto: p.id,
          tarefa: tc.id,
          quando: comp.quando,
          modeloAssumido: tc.modeloAssumido,
          modeloReal: tc.modeloReal,
          demanda: tc.demanda,
          estimado: tc.estimado,
          real: tc.real,
          erroRel: tc.erroRel,
        }));
        if (linhas.length) {
          fs.appendFileSync(jsonlPath, linhas.join('\n') + '\n', 'utf8');
        }
        comp.gravadoEm = comp.quando;
      } catch (e) {
        console.error('erro ao gravar estimativas.jsonl:', e);
      }
    }

    p.comparacaoEstimativa = comp;
    return comp;
  } catch (err) {
    console.error('montarComparacaoEstimativa falhou:', err);
    return null;
  }
}

const cacheComparacao = new Map();
function comparacaoAoVivo(p) {
  const c = cacheComparacao.get(p.id);
  if (c && Date.now() - c.t < 20000) return c.v;
  const v = montarComparacaoEstimativa({ ...p, comparacaoEstimativa: null }, readRun(p), { gravar: false });
  if (cacheComparacao.size > 200) cacheComparacao.clear();
  cacheComparacao.set(p.id, { t: Date.now(), v });
  return v;
}

// ---------- resumo final ----------
// Texto para a conversa e o relatório: o que cada tarefa entregou, com qual modelo, trocas, falhas e commits.
function resumoFinal(p, run) {
  run = run || readRun(p);
  if (!p.comparacaoEstimativa) montarComparacaoEstimativa(p, run);
  const L = [`Resumo da execução (${p.estado === 'concluido' ? 'concluída' : 'incompleta'}):`];
  const logs = path.join(pdir(p.id), 'logs');
  const tabela = carregarPrecos({ dataDir: DATA });
  const usoProj = dadosUsoDoProjeto(p, tabela);
  const rodadaAtual = usoProj.rodadas?.[usoProj.rodadas.length - 1];
  const mapaTarefas = Object.fromEntries((rodadaAtual?.tarefas || usoProj.tarefas).map((t) => [t.id, t]));

  for (const t of p.plano?.tarefas || []) {
    const st = run.status?.[t.id] || {};
    const res = lerJson(path.join(logs, t.id, 'result.json')) || {};
    const tent = res.attempts || [];
    const trocas = tent.filter((a) => a.handoff || a.quota).map((a) => `${a.worker}${a.handoff ? ' (' + a.handoff + ')' : ' (sem cota)'}`);
    L.push('', `• ${t.id}${t.titulo ? ' – ' + t.titulo : ''}: ${st.state || '-'}${st.model ? ' com ' + st.model : ''}${st.note ? ' · ' + st.note : ''}`);
    if (trocas.length) L.push(`  trocas de modelo: ${trocas.join(' → ')}`);

    const tUso = mapaTarefas[t.id];
    if (tUso) {
      const u = tUso.total;
      const usdStr = u.usd !== null ? u.usd.toFixed(4) : '-';
      L.push(`  tokens: entrada ${u.entrada}, saida ${u.saida}, cache lido ${u.cacheLido}, cache gravado ${u.cacheGravado} · ~US$ ${usdStr} (${u.origem})`);
    }

    const ultimo = tent.length ? tent[tent.length - 1].text : null;
    let txt = '';
    try {
      if (ultimo) {
        const arq = fs.existsSync(ultimo) ? ultimo : path.join(logs, t.id, path.basename(ultimo));
        if (fs.existsSync(arq)) txt = fs.readFileSync(arq, 'utf8').trim();
      }
    } catch {}
    if (txt) L.push('  ' + (txt.length > 700 ? txt.slice(0, 700) + '…' : txt).replace(/\n+/g, '\n  '));
  }
  if (isGitRepo(p.repo) && p.inicio) {
    try {
      const out = execFileSync('git', ['-C', p.repo, 'log', `--since=${p.inicio}`, '--format=%h %s', '-15'], { encoding: 'utf8', windowsHide: true, timeout: 8000 }).trim();
      L.push('', 'Commits desta execução:', out ? out.split('\n').map((l) => '  ' + l).join('\n') : '  nenhum');
    } catch {}
  }

  const planUso = mapaTarefas['planejador'];
  if (planUso) {
    const u = planUso.total;
    const usdStr = u.usd !== null ? u.usd.toFixed(4) : '-';
    const brlStr = u.brl !== null ? ` (R$ ${u.brl.toFixed(2)})` : '';
    L.push('', `Planejador: tokens: entrada ${u.entrada}, saida ${u.saida}, cache lido ${u.cacheLido}, cache gravado ${u.cacheGravado} · ~US$ ${usdStr}${brlStr} (${u.origem})`);
  }

  const totAtual = rodadaAtual?.total || usoProj.total;
  const totAtualUsdStr = totAtual.usd !== null ? totAtual.usd.toFixed(4) : '-';
  const totAtualBrlStr = totAtual.brl !== null ? ` (R$ ${totAtual.brl.toFixed(2)})` : '';
  const rotuloExec = (usoProj.rodadas?.length || 0) > 1 ? `Total da execucao (rodada ${rodadaAtual?.numero || usoProj.rodadas.length})` : 'Total da execucao';
  L.push(`${rotuloExec}: tokens: entrada ${totAtual.entrada}, saida ${totAtual.saida}, cache lido ${totAtual.cacheLido}, cache gravado ${totAtual.cacheGravado} · ~US$ ${totAtualUsdStr}${totAtualBrlStr} (${totAtual.origem})`);

  if (p.comparacaoEstimativa?.total) {
    const tot = p.comparacaoEstimativa.total;
    const fmtErro = (val) => {
      if (val == null || !Number.isFinite(val)) return '-';
      const pct = Math.round(val * 100);
      return `${pct >= 0 ? '+' : ''}${pct}%`;
    };
    const errEnt = fmtErro(tot.erroRel?.entrada);
    const errTempo = fmtErro(tot.erroRel?.duracaoSeg);
    L.push(`Estimativa x real: erro total de tokens ${errEnt}, tempo ${errTempo}.`);
  }

  if ((usoProj.rodadas?.length || 0) > 1) {
    L.push('', 'Totais por rodada:');
    for (const r of usoProj.rodadas) {
      const u = r.total;
      const uUsd = u.usd !== null ? u.usd.toFixed(4) : '-';
      const uBrl = u.brl !== null ? ` (R$ ${u.brl.toFixed(2)})` : '';
      L.push(`  Rodada ${r.numero}: entrada ${u.entrada}, saida ${u.saida}, cache lido ${u.cacheLido}, cache gravado ${u.cacheGravado} · ~US$ ${uUsd}${uBrl} (${u.origem})`);
    }
    const tot = usoProj.total;
    const totUsdStr = tot.usd !== null ? tot.usd.toFixed(4) : '-';
    const totBrlStr = tot.brl !== null ? ` (R$ ${tot.brl.toFixed(2)})` : '';
    L.push('', `Total acumulado do projeto (${usoProj.rodadas.length} rodadas): tokens: entrada ${tot.entrada}, saida ${tot.saida}, cache lido ${tot.cacheLido}, cache gravado ${tot.cacheGravado} · ~US$ ${totUsdStr}${totBrlStr} (${tot.origem})`);
  }

  L.push('Claude Code e Antigravity sao assinaturas: o custo e o equivalente em API.');

  return L.join('\n');
}

// ---------- cofre ----------
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
function report(p, run) {
  try {
    if (!fs.existsSync(VAULT)) return;
    run = run || readRun(p);
    const dir = path.join(VAULT, 'orquestracao'); fs.mkdirSync(dir, { recursive: true });
    const L = [`# Orquestração: ${p.titulo}`, '',
      `- **Projeto Delegar:** \`${p.id}\` · **Modo:** ${nomeModo(p)} · **Velocidade:** ${velDe(p)} · **Acompanhamento:** ${supDe(p)} · **Estado:** ${p.estado}`,
      `- **Planejador:** ${p.planejador || '-'}`,
      `- **Repositório:** \`${p.repo}\``,
      `- **Criado:** ${p.criado} · **Início:** ${p.inicio || '-'} · **Fim:** ${p.fim || '-'}`, '',
      '## Pedido', '', p.pedido, ''];
    if (p.plano) {
      L.push('## Plano', '', p.plano.resumo || '', '', '| Tarefa | Tipo | Nível | Modelos (ordem de reserva) | Depende de | Confirmar |', '|---|---|---|---|---|---|');
      let vol = 0;
      for (const t of p.plano.tarefas) L.push(`| ${esc(t.id)}: ${esc(t.titulo)} | ${t.tipo} | ${t.nivel} | ${chainFor(p, t, t.nivel === 'volume' ? vol++ : 0).join(' → ')} | ${t.depende.join(', ') || '-'} | ${t.confirmar ? 'sim' : '-'} |`);
      if ((p.plano.verify || []).length) L.push('', 'Verificação após cada integração: ' + p.plano.verify.map((v) => '`' + v + '`').join(', '));
      L.push('');
    }
    const st = Object.entries(run.status || {});
    if (st.length) {
      L.push('## Execução', '', '| Tarefa | Estado | Modelo usado | Início | Fim | Nota |', '|---|---|---|---|---|---|');
      for (const [k, v] of st) L.push(`| ${esc(k)} | ${esc(v.state)} | ${esc(v.model)} | ${esc(v.started)} | ${esc(v.finished)} | ${esc(v.note)} |`);
      L.push('');
    }
    if (run.summary) L.push('## Resultado', '', run.summary.split('\n').filter((l) => /^RESULTADO/.test(l)).join('\n'), '');

    const tabela = carregarPrecos({ dataDir: DATA });
    const dadosUso = dadosUsoDoProjeto(p, tabela);
    L.push('## Tokens e custo', '');
    if ((dadosUso.rodadas?.length || 0) > 1) {
      L.push('### Por rodada', '',
        '| Rodada | Estado | Entrada | Saída | Cache lido | Cache gravado | Custo (US$) | Custo (R$) | Origem |',
        '|---|---|---|---|---|---|---|---|---|');
      for (const r of dadosUso.rodadas) {
        const u = r.total.usd !== null ? r.total.usd.toFixed(4) : '-';
        const b = r.total.brl !== null ? r.total.brl.toFixed(2) : '-';
        L.push(`| Rodada ${r.numero} | ${esc(r.estado || '-')} | ${r.total.entrada} | ${r.total.saida} | ${r.total.cacheLido} | ${r.total.cacheGravado} | ${esc(u)} | ${esc(b)} | ${esc(r.total.origem)} |`);
      }
      const t = dadosUso.total;
      const tu = t.usd !== null ? t.usd.toFixed(4) : '-';
      const tb = t.brl !== null ? t.brl.toFixed(2) : '-';
      L.push(`| **Total** | - | **${t.entrada}** | **${t.saida}** | **${t.cacheLido}** | **${t.cacheGravado}** | **${esc(tu)}** | **${esc(tb)}** | **${esc(t.origem || '-')}** |`, '');
    }
    if (dadosUso.modelos.length) {
      L.push('### Por modelo', '',
        '| Modelo | Provedor | Entrada | Saída | Cache lido | Cache gravado | Custo (US$) | Custo (R$) | Origem | Assinatura |',
        '|---|---|---|---|---|---|---|---|---|---|');
      for (const m of dadosUso.modelos) {
        const u = m.usd !== null ? m.usd.toFixed(4) : '-';
        const b = m.brl !== null ? m.brl.toFixed(2) : '-';
        L.push(`| ${esc(m.modelo)} | ${esc(m.provedor)} | ${m.entrada} | ${m.saida} | ${m.cacheLido} | ${m.cacheGravado} | ${esc(u)} | ${esc(b)} | ${esc(m.origem)} | ${esc(m.assinatura || '-')} |`);
      }
      const t = dadosUso.total;
      const tu = t.usd !== null ? t.usd.toFixed(4) : '-';
      const tb = t.brl !== null ? t.brl.toFixed(2) : '-';
      L.push(`| **Total** | - | **${t.entrada}** | **${t.saida}** | **${t.cacheLido}** | **${t.cacheGravado}** | **${esc(tu)}** | **${esc(tb)}** | **${esc(t.origem || '-')}** | - |`, '');
    }
    if (dadosUso.tarefas.length) {
      L.push('### Por tarefa', '',
        '| Tarefa | Entrada | Saída | Cache lido | Cache gravado | Custo (US$) | Custo (R$) | Origem |',
        '|---|---|---|---|---|---|---|---|');
      for (const tf of dadosUso.tarefas) {
        const u = tf.total.usd !== null ? tf.total.usd.toFixed(4) : '-';
        const b = tf.total.brl !== null ? tf.total.brl.toFixed(2) : '-';
        const pref = tf.rodada ? `R${tf.rodada} · ` : '';
        const tit = tf.titulo ? `: ${esc(tf.titulo)}` : '';
        L.push(`| ${esc(pref + tf.id)}${tit} | ${tf.total.entrada} | ${tf.total.saida} | ${tf.total.cacheLido} | ${tf.total.cacheGravado} | ${esc(u)} | ${esc(b)} | ${esc(tf.total.origem)} |`);
      }
      L.push('', '*Claude Code e Antigravity são assinaturas: o custo é o equivalente em API.*', '');
    }

    if (Array.isArray(p.rodadas) && p.rodadas.length > 0) {
      L.push('## Rodadas anteriores', '');
      for (const r of p.rodadas) {
        L.push(`### Rodada ${r.numero}: ${esc(r.titulo || 'Sem título')}`);
        L.push(`- **Estado:** ${r.estado || '-'} · **Início:** ${r.inicio || '-'} · **Fim:** ${r.fim || '-'}`);
        if (r.plano?.resumo) L.push(`- **Resumo do plano:** ${r.plano.resumo}`);
        const stEntries = Object.entries(r.status || {});
        if (stEntries.length) {
          L.push('', '| Tarefa | Estado | Modelo usado | Nota |', '|---|---|---|---|');
          for (const [k, v] of stEntries) {
            L.push(`| ${esc(k)} | ${esc(v?.state || '-')} | ${esc(v?.model || '-')} | ${esc(v?.note || '-')} |`);
          }
          L.push('');
        }
        if (r.resumoFinal) {
          L.push('**Resumo da rodada:**', '```', r.resumoFinal, '```', '');
        }
      }
    }

    if (p.resumoFinal) L.push('## Resumo', '', '```', p.resumoFinal, '```', '');
    L.push(`Logs: \`${path.join(pdir(p.id), 'logs')}\``, '', 'Ver também [[guias_e_comandos/skill_delegar_orquestracao]].', '');
    fs.writeFileSync(path.join(dir, `${p.id}.md`), L.join('\n'), 'utf8');
    indexLine(p);
  } catch (e) { console.error('report', e); }
}

function indexLine(p) {
  const f = path.join(VAULT, '00_INDICE.md'); if (!fs.existsSync(f)) return;
  let s = fs.readFileSync(f, 'utf8');
  const head = '## 🤖 Orquestração de agentes (skill delegar)';
  const line = `- [[orquestracao/${p.id}]]: **${p.titulo.replace(/\r?\n/g, ' ')}** · modo ${nomeModo(p)} · ${p.estado}`;
  const re = new RegExp(`^- \\[\\[orquestracao/${p.id}\\]\\].*$`, 'm');
  if (re.test(s)) s = s.replace(re, () => line);
  else if (s.includes(head)) s = s.replace(head + '\n', () => head + '\n' + line + '\n');
  else s = s.replace(/\s*$/, '') + `\n\n${head}\n${line}\n`;
  fs.writeFileSync(f, s, 'utf8');
}

function logDiario(p, tipo, linhas) {
  try {
    const f = path.join(VAULT, '01_LOG_DIARIO.md'); if (!fs.existsSync(f)) return;
    let s = fs.readFileSync(f, 'utf8');
    const d = new Date(); const hoje = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
    const head = `## 📅 ${hoje}`;
    const entry = `### 📌 Delegar: ${p.titulo} (${tipo})\n- **Projeto:** [[orquestracao/${p.id}]], modo ${nomeModo(p)}.\n${linhas.map((l) => '- ' + l).join('\n')}\n\n`;
    const i = s.indexOf(head);
    if (i >= 0) { const j = i + head.length; const k = s.slice(j).match(/^\s*/)[0].length; s = s.slice(0, j) + '\n\n' + entry + s.slice(j + k); }
    else {
      const sep = s.indexOf('\n---\n');
      if (sep >= 0) s = s.slice(0, sep + 5) + `\n${head}\n\n${entry}` + s.slice(sep + 5).replace(/^\s*/, '');
      else s = `${head}\n\n${entry}` + s;
    }
    fs.writeFileSync(f, s, 'utf8');
  } catch (e) { console.error('log', e); }
}

// ---------- HTTP ----------
function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, {
    'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
const publico = (msg) => Object.assign(new Error(msg), { publico: true });
const readBody = (req) => new Promise((resolve, reject) => {
  let n = 0; const chunks = [];
  req.on('data', (c) => { n += c.length; if (n > 1e6) { reject(publico('corpo grande demais')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => { try { const j = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; resolve(j && typeof j === 'object' ? j : {}); } catch { reject(publico('JSON inválido')); } });
});
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function modoPublico(p) {
  const m = cfgDe(p);
  return { planner: m.planner, tiers: tiersDe(m, velDe(p)), fix: m.fix, coord: m.coord, maxConcurrent: m.maxConcurrent, base: m.base || null, semGratuitos: !!m.semGratuitos };
}
// Projeto que roda ou cujo planejador responde não pode ser arquivado nem excluído.
function ocupadoDemais(p) { return p.estado === 'executando' || !!p.ocupado || !!(p.pid && alive(p.pid)); }
function desarquivarSePreciso(p) {
  if (!p.arquivado) return;
  p.arquivado = false; delete p.arquivadoEm; save(p);
  evento(p, { tipo: 'projeto', texto: 'desarquivado' });
}
function publicView(p, full) {
  if ((!Array.isArray(p.rodadas) || !p.rodadas.length) && fs.existsSync(path.join(pdir(p.id), 'rodadas'))) {
    migrarRodadas(p, { projDir: pdir(p.id), dataDir: DATA, gravar: !ocupadoDemais(p) });
  }
  const v = { id: p.id, titulo: p.titulo, modo: p.modo, modoNome: nomeModo(p), velocidade: velDe(p), supervisao: supDe(p), estado: p.estado, auto: p.auto, repo: p.repo, criado: p.criado, inicio: p.inicio, fim: p.fim, ocupado: !!p.ocupado, arquivado: !!p.arquivado, perfil: p.perfil || null, rodadas: Array.isArray(p.rodadas) ? p.rodadas.length : 0, agendamento: resumoAgendamento(p), politicaCota: p.politicaCota || (p.auto ? 'auto' : 'ignorar'), ajusteCota: p.ajusteCota ? { politica: p.ajusteCota.politica, nome: NOMES_POLITICA[p.ajusteCota.politica] || p.ajusteCota.politica, quando: p.ajusteCota.quando, mudancas: p.ajusteCota.mudancas || [] } : null };
  if (!full) { v.gates = p.estado === 'executando' ? gatesPendentes(p).length : 0; return v; }
  v.pedido = p.pedido; v.mensagens = p.mensagens; v.planejador = p.planejador || null;
  v.config = modoPublico(p); v.plannerEfetivo = adaptar(cfgDe(p).planner);
  if (p.plano) {
    let vol = 0;
    v.plano = { ...p.plano, tarefas: p.plano.tarefas.map((t) => ({ ...t, cadeiaEfetiva: chainFor(p, t, t.nivel === 'volume' ? vol++ : 0) })) };
    v.demanda = p.demanda || calcularDemandaEAjuste(p);
  }
  // Em execução, a comparação é ao vivo (cópia do projeto, nada gravado; cache de 20 s por projeto).
  v.comparacaoEstimativa = p.estado === 'executando' ? comparacaoAoVivo(p) : (p.comparacaoEstimativa || null);
  v.run = readRun(p);
  v.relatorio = path.join(VAULT, 'orquestracao', `${p.id}.md`);
  if (Array.isArray(p.rodadas) && p.rodadas.length > 0) {
    const dadosUso = dadosUsoDoProjeto(p);
    const mapaUso = Object.fromEntries((dadosUso.rodadas || []).map((r) => [r.numero, r]));
    v.rodadas = p.rodadas.map((r) => {
      const u = mapaUso[r.numero];
      return {
        ...r,
        uso: u ? { total: u.total, modelos: u.modelos, tarefas: u.tarefas } : (r.uso || null),
      };
    });
  } else {
    v.rodadas = [];
  }
  return v;
}

// Aplica o modo pedido ao projeto. "personalizado" sem configuração copia o modo atual. Devolve o erro ou null.
function aplicarModo(p, b) {
  if (b.perfil != null) {
    if (typeof b.perfil !== 'string') return 'perfil inválido';
    const vn = validarNome(b.perfil);
    if (!vn.ok) return vn.erro;
    const salvo = perfis.obter(vn.nome);
    if (!salvo) return 'perfil não encontrado';
    const { errs, custom } = validarCustom(salvo.custom);
    if (errs.length) return errs.join('; ');
    p.modo = 'personalizado';
    p.custom = { ...custom, nome: 'Perfil: ' + salvo.nome, descricao: 'Perfil salvo ' + salvo.nome + '.' };
    p.perfil = salvo.nome;
    return null;
  }
  delete p.perfil; // qualquer outro modo desfaz o vínculo com o perfil
  if (b.modo === 'personalizado') {
    const { errs, custom } = validarCustom(b.custom || p.custom || modoComoCustom(p.modo));
    if (errs.length) return errs.join('; ');
    p.modo = 'personalizado'; p.custom = custom;
    try { fs.writeFileSync(CUSTOM_FILE, JSON.stringify(custom, null, 2)); } catch {}
    return null;
  }
  if (temModo(b.modo)) { p.modo = b.modo; return null; }
  return 'modo desconhecido';
}

// Rotas de perfis. Nomes vão só no corpo, nunca no caminho. Já chega depois da checagem do token.
async function rotaPerfis(req, res, parts) {
  const sub = parts[2];
  if (parts.length > 3 || (sub && !['renomear', 'excluir'].includes(sub))) return send(res, 404, { erro: 'não encontrado' });
  if (!sub) {
    if (req.method === 'GET') return send(res, 200, { perfis: perfis.listar(), aviso: perfis.aviso() });
    if (req.method !== 'POST') return send(res, 405, { erro: 'método não permitido' });
  } else if (req.method !== 'POST') return send(res, 405, { erro: 'método não permitido' });
  const b = await readBody(req);
  let r;
  try {
    if (!sub) r = perfis.salvar(b.nome, b.custom, { sobrescrever: b.sobrescrever === true });
    else if (sub === 'renomear') r = perfis.renomear(b.de, b.para);
    else r = perfis.excluir(b.nome);
  } catch (e) {
    console.error('falha ao gravar perfis:', e);
    return send(res, 500, { erro: 'não foi possível gravar os perfis' });
  }
  if (!r.ok) return send(res, r.status || 400, { erro: r.erro });
  if (!sub) return send(res, r.criado ? 201 : 200, { perfil: r.perfil });
  if (sub === 'renomear') return send(res, 200, { perfil: r.perfil });
  return send(res, 200, { ok: true });
}

// ---------- cotas ----------
// O quota.ps1 grava DATA/state/quota-last.json. Só uma leitura roda por vez; quem chega durante ela espera a mesma.
// Nada do cliente entra nos argumentos e nenhuma saída do script volta para o cliente: o detalhe fica só no console.
const COTAS_FRESCO_MIN = 10;
const COTAS_FORCADA_INTERVALO_MS = 30000;
const COTAS_RETENTATIVA_MS = 60000;
let leituraAtual = null, leituraForcada = false, proximaForcada = null;
let erroLeitura = null, fimUltimaLeitura = 0, fimUltimaForcada = 0;

function lerCache() {
  const c = lerJson(path.join(DATA, 'state', 'quota-last.json'));
  return c && typeof c === 'object' && !Array.isArray(c) ? c : null;
}
function idadeCacheMin(c) {
  const t = c && typeof c.time === 'string' ? new Date(c.time).getTime() : NaN;
  return Number.isNaN(t) ? null : Math.max(0, (Date.now() - t) / 60000);
}
function iniciarLeituraCotas(forcar) {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', QUOTA_SCRIPT, '-MaxAgeMinutes', String(forcar ? 0 : COTAS_FRESCO_MIN)];
  if (process.env.DELEGAR_PROVEDORES === 'nenhum') args.push('-SkipClaudeProbe', '-SkipAgy');
  leituraForcada = forcar;
  const p = new Promise((resolve) => {
    try {
      execFile('powershell.exe', args, { windowsHide: true, timeout: 120000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, DELEGAR_DATA: DATA } }, (e, out, err) => {
        if (e) {
          console.error('leitura das cotas falhou:', e.message, String(err || '').slice(0, 500));
          erroLeitura = e.killed || e.signal ? 'tempo esgotado' : 'falha ao ler as cotas';
        } else if (!lerCache()) erroLeitura = 'falha ao ler as cotas';
        else erroLeitura = null;
        fimUltimaLeitura = Date.now();
        if (forcar) fimUltimaForcada = fimUltimaLeitura;
        resolve();
      });
    } catch (e) {
      console.error('leitura das cotas não iniciou:', e.message);
      erroLeitura = 'falha ao ler as cotas'; fimUltimaLeitura = Date.now();
      if (forcar) fimUltimaForcada = fimUltimaLeitura;
      resolve();
    }
  });
  leituraAtual = p;
  p.then(() => { if (leituraAtual === p) leituraAtual = null; });
  return p;
}
// Nunca rejeita. Pedido forçado durante uma leitura comum espera ela acabar e roda uma só leitura forçada, compartilhada.
function lerCotas(forcar) {
  if (leituraAtual && (leituraForcada || !forcar)) return leituraAtual;
  if (leituraAtual) {
    if (!proximaForcada) proximaForcada = leituraAtual.then(() => { proximaForcada = null; return iniciarLeituraCotas(true); });
    return proximaForcada;
  }
  return iniciarLeituraCotas(forcar);
}
const lendoCotas = () => !!(leituraAtual || proximaForcada);
// Cache velho ou ausente dispara leitura em segundo plano; depois de uma falha, espera um tempo antes de tentar de novo.
function atualizarCotasSePreciso() {
  const c = lerCache();
  const idade = idadeCacheMin(c);
  const velho = idade === null || idade > COTAS_FRESCO_MIN;
  if (velho && !lendoCotas() && !(erroLeitura && Date.now() - fimUltimaLeitura < COTAS_RETENTATIVA_MS)) lerCotas(false);
}
function respostaCotas(aviso = null) {
  const c = lerCache();
  if (c) registrarHistoricoCota(DATA, c);
  const idade = idadeCacheMin(c);
  const prov = Object.fromEntries(Object.entries(detectar()).map(([k, v]) => [k, !!v])); // só se existe, nunca o caminho da CLI
  const t = c && typeof c.time === 'string' ? new Date(c.time) : null;
  const historico = lerHistoricoCotas(DATA);
  const tentativas = coletarTentativasUso(listAll(), { dataDir: DATA, dadosUsoProjeto: (proj) => dadosUsoDoProjeto(proj) });
  const estimativas = estimarTokensPorCota(historico, tentativas);
  const linhas = linhasDeCotas(c, prov).map((l) => ({
    ...l,
    estimativa: l.chave === 'opencode' ? null : (estimativas[l.chave] || null),
  }));
  return {
    lidoEm: t && !Number.isNaN(t.getTime()) ? t.toISOString() : null,
    idadeMin: idade === null ? null : Math.round(idade),
    lendo: lendoCotas(), erro: erroLeitura, aviso,
    linhas, provedores: prov,
  };
}
async function rotaCotas(req, res, parts) {
  const sub = parts[2];
  if (parts.length > 3 || (sub && sub !== 'atualizar')) return send(res, 404, { erro: 'não encontrado' });
  if (req.method !== (sub ? 'POST' : 'GET')) return send(res, 405, { erro: 'método não permitido' });
  if (!sub) { atualizarCotasSePreciso(); return send(res, 200, respostaCotas()); }
  const forcadaEmCurso = (leituraAtual && leituraForcada) || proximaForcada;
  if (!forcadaEmCurso && Date.now() - fimUltimaForcada < COTAS_FORCADA_INTERVALO_MS) return send(res, 200, respostaCotas('leitura recente; aguarde'));
  await lerCotas(true);
  return send(res, 200, respostaCotas());
}
// Cotas dos grupos de modelos que o projeto usa (planejador, correção, coordenação e cadeias das tarefas) e dos que rodam agora.
function cotasDoProjetoView(p) {
  const m = cfgDe(p);
  const entradas = [...(m.planner || []), ...(m.fix || []), ...(m.coord || [])];
  let vol = 0;
  for (const t of p.plano?.tarefas || []) entradas.push(...chainFor(p, t, t.nivel === 'volume' ? vol++ : 0));
  const atuais = [];
  const run = readRun(p);
  for (const [id, v] of Object.entries(run.status)) {
    if (!v || v.state !== 'running') continue;
    const agora = agoraNaTarefa(p, v.note === 'fixing' ? id + '-fix' : id);
    const modelo = agora?.modelo || v.model || null;
    if (modelo) atuais.push({ tarefa: id, modelo });
  }
  atualizarCotasSePreciso();
  const c = lerCache();
  if (c) registrarHistoricoCota(DATA, c);
  const t = c && typeof c.time === 'string' ? new Date(c.time) : null;
  const historico = lerHistoricoCotas(DATA);
  const tentativas = coletarTentativasUso(listAll(), { dataDir: DATA, dadosUsoProjeto: (proj) => dadosUsoDoProjeto(proj) });
  const estimativas = estimarTokensPorCota(historico, tentativas);
  const linhas = cotasDoProjeto(linhasDeCotas(c, detectar()), entradas, atuais).map((l) => ({
    ...l,
    estimativa: l.chave === 'opencode' ? null : (estimativas[l.chave] || null),
  }));
  return {
    lidoEm: t && !Number.isNaN(t.getTime()) ? t.toISOString() : null,
    lendo: lendoCotas(), erro: erroLeitura,
    linhas,
  };
}

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // api, recurso, id, acao
  if (parts[1] === 'saude') return send(res, 200, { ok: true });
  if (!safeEq(req.headers['x-delegar-token'] || '', TOKEN)) return send(res, 401, { erro: 'token inválido' });
  if (req.method === 'GET' && parts[1] === 'modos') {
    const modos = Object.fromEntries(Object.entries(MODES).map(([k, m]) => [k, { nome: m.nome, descricao: m.descricao, tiers: m.tiers, porVelocidade: m.porVelocidade || null, planner: m.planner, fix: m.fix, coord: m.coord, maxConcurrent: m.maxConcurrent, plannerEfetivo: adaptar(m.planner) }]));
    return send(res, 200, { modos, supervisao: SUPERVISAO, velocidade: VELOCIDADE, ultimoPersonalizado: lerJson(CUSTOM_FILE), padraoPersonalizado: modoComoCustom('padrao') });
  }
  if (parts[1] === 'perfis') return await rotaPerfis(req, res, parts);
  if (parts[1] === 'cotas') return await rotaCotas(req, res, parts);
  if (parts[1] === 'uso') {
    if (parts[2] === 'atualizar-fora' && parts.length === 3) {
      if (req.method !== 'POST') return send(res, 405, { erro: 'método não permitido' });
      await atualizarUsoForaEmSegundoPlano({ forcar: true });
      const snapF = lerUsoFora(DATA);
      return send(res, 200, { atualizado: snapF?.atualizado || null, excluidos: snapF?.excluidos || null });
    }
    if (parts.length > 2) return send(res, 404, { erro: 'não encontrado' });
    if (req.method !== 'GET') return send(res, 405, { erro: 'método não permitido' });
    const filtro = parseFiltroUso(url.searchParams);
    if (!filtro.ok) return send(res, 400, { erro: 'período inválido' });
    const tabela = carregarPrecos({ dataDir: DATA });
    return send(res, 200, respostaUsoGeral(filtro, tabela));
  }
  if (parts[1] === 'precos') {
    const sub = parts[2];
    if (parts.length > 3 || (sub && sub !== 'atualizar')) return send(res, 404, { erro: 'não encontrado' });
    if (sub === 'atualizar') {
      if (req.method !== 'POST') return send(res, 405, { erro: 'método não permitido' });
      const r = await atualizarPrecos({ dataDir: DATA });
      const tabela = r.tabela || carregarPrecos({ dataDir: DATA });
      return send(res, 200, {
        ok: r.ok,
        atualizados: r.atualizados,
        aviso: r.aviso,
        atualizado: tabela.atualizado || null,
        idadeDias: idadeDias(tabela),
        fonte: tabela.fonte || null,
        usdBrl: tabela.usdBrl ?? null,
        modelos: tabela.modelos || {}
      });
    }
    if (req.method !== 'GET') return send(res, 405, { erro: 'método não permitido' });
    const tabela = carregarPrecos({ dataDir: DATA });
    return send(res, 200, {
      atualizado: tabela.atualizado || null,
      idadeDias: idadeDias(tabela),
      fonte: tabela.fonte || null,
      usdBrl: tabela.usdBrl ?? null,
      modelos: tabela.modelos || {}
    });
  }
  if (parts[1] === 'modelos' && parts[2] === 'atualizar') {
    if (parts.length > 3) return send(res, 404, { erro: 'não encontrado' });
    if (req.method !== 'POST') return send(res, 405, { erro: 'método não permitido' });
    const resultado = await iniciarDescoberta({ dataDir: DATA });
    return send(res, 200, { ...catalogo(), resultado });
  }
  if (req.method === 'GET' && parts[1] === 'modelos' && !parts[2]) return send(res, 200, catalogo());
  if (req.method === 'GET' && parts[1] === 'atividade') {
    const ativos = listAll().filter((p) => p.estado === 'executando' || p.ocupado);
    return send(res, 200, await Promise.all(ativos.map(atividade)));
  }
  if (parts[1] !== 'projetos') return send(res, 404, { erro: 'não encontrado' });
  if (req.method === 'GET' && !parts[2]) return send(res, 200, listAll().map((p) => publicView(p, false)));
  if (req.method === 'POST' && !parts[2]) {
    const b = await readBody(req);
    const pedido = String(b.pedido || '').trim(); const repo = path.resolve(String(b.repo || ''));
    if (pedido.length < 5 || pedido.length > 50000) return send(res, 400, { erro: 'pedido vazio ou longo demais' });
    if (!b.repo || !fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) return send(res, 400, { erro: 'repositório não encontrado' });
    if (b.velocidade != null && !temVel(b.velocidade)) return send(res, 400, { erro: 'velocidade inválida' });
    const politicasValidas = new Set(['ignorar', 'auto', 'economizar', 'usar_melhor']);
    if (b.politicaCota != null && !politicasValidas.has(String(b.politicaCota))) return send(res, 400, { erro: 'política de cota inválida' });
    const agInput = b.agendamento && typeof b.agendamento === 'object'
      ? b.agendamento
      : (b.planejarEm != null || b.executarEm != null || b.executarAposPlanejar != null
          ? { planejarEm: b.planejarEm, executarEm: b.executarEm, executarAposPlanejar: b.executarAposPlanejar }
          : null);
    let agValidado = null;
    if (agInput) {
      const valAg = validarAgendamentoInput(agInput);
      if (!valAg.ok) return send(res, 400, { erro: valAg.erro || 'agendamento inválido' });
      agValidado = valAg.agendamento;
    }
    const titulo = String(b.titulo || pedido.split('\n')[0]).slice(0, 120);
    const d = new Date(); const z = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}${z(d.getHours())}${z(d.getMinutes())}`;
    const p = { id: `${stamp}-${slug(titulo)}-${crypto.randomBytes(2).toString('hex')}`, titulo, tituloFixo: !!b.titulo, pedido, repo, modo: 'padrao', auto: !!b.auto,
      velocidade: temVel(b.velocidade) ? b.velocidade : 'auto',
      supervisao: temSup(b.supervisao) ? b.supervisao : 'automatico',
      politicaCota: b.politicaCota != null ? String(b.politicaCota) : (b.auto ? 'auto' : 'ignorar'),
      criado: now(), estado: 'planejando', mensagens: [{ papel: 'usuario', texto: pedido, quando: now() }], sessao: null, plano: null, uso: { chamadas: [] } };
    const erro = aplicarModo(p, { modo: b.modo || 'padrao', custom: b.custom, perfil: b.perfil });
    if (erro) return send(res, 400, { erro });
    if (!adaptar(cfgDe(p).planner).length) return send(res, 400, { erro: 'nenhuma CLI de IA (claude, agy ou opencode) encontrada neste PC' });
    if (agValidado) {
      aplicarAgendamentoNoProjeto(p, agValidado);
      if (agValidado.planejarEm && Number(agValidado.planejarEm) > Date.now()) {
        const resumo = resumoAgendamento(p);
        p.mensagens.push({ papel: 'sistema', texto: `Planejamento agendado (${resumo?.texto || 'horário futuro'}).`, quando: now() });
        save(p);
        return send(res, 201, publicView(p, true));
      }
    }
    save(p);
    plannerTurn(p, pedido).catch((e) => console.error(e));
    return send(res, 201, publicView(p, true));
  }
  const p = load(parts[2]);
  if (!p) return send(res, 404, { erro: 'projeto não encontrado' });
  if (req.method === 'GET' && !parts[3]) return send(res, 200, publicView(p, true));
  if (req.method === 'GET' && parts[3] === 'atividade') return send(res, 200, await atividade(p));
  if (parts[3] === 'cotas') {
    if (parts.length > 4) return send(res, 404, { erro: 'não encontrado' });
    if (req.method !== 'GET') return send(res, 405, { erro: 'método não permitido' });
    return send(res, 200, cotasDoProjetoView(p));
  }
  if (parts[3] === 'uso') {
    if (parts.length > 4) return send(res, 404, { erro: 'não encontrado' });
    if (req.method !== 'GET') return send(res, 405, { erro: 'método não permitido' });
    const tabela = carregarPrecos({ dataDir: DATA });
    return send(res, 200, dadosUsoPublico(p, tabela));
  }
  if (req.method !== 'POST') return send(res, 405, { erro: 'método não permitido' });
  const b = await readBody(req);
  const busy = () => send(res, 409, { erro: 'o planejador ainda está respondendo' });
  const running = p.estado === 'executando';
  switch (parts[3]) {
    case 'mensagem': {
      desarquivarSePreciso(p);
      const t = String(b.texto || '').trim();
      if (!t || t.length > 50000) return send(res, 400, { erro: 'mensagem vazia' });
      if (p.ocupado) return busy();
      if (running) return send(res, 409, { erro: 'execução em andamento' });
      if (['concluido', 'cancelado'].includes(p.estado) || temRodadaExecutada(p, pdir(p.id))) arquivarRodadaSePreciso(p);
      p.mensagens.push({ papel: 'usuario', texto: t, quando: now() }); save(p);
      plannerTurn(p, t).catch((e) => console.error(e));
      return send(res, 202, { ok: true });
    }
    case 'gerar-plano': {
      desarquivarSePreciso(p);
      if (p.ocupado) return busy();
      if (running) return send(res, 409, { erro: 'execução em andamento' });
      if (['concluido', 'cancelado'].includes(p.estado) || temRodadaExecutada(p, pdir(p.id))) arquivarRodadaSePreciso(p);
      p.mensagens.push({ papel: 'usuario', texto: '(pediu o plano final)', quando: now() }); save(p);
      plannerTurn(p, 'Gere o plano final.', { gerar: true }).catch((e) => console.error(e));
      return send(res, 202, { ok: true });
    }
    case 'plano': {
      desarquivarSePreciso(p);
      if (running) return send(res, 409, { erro: 'execução em andamento' });
      const plan = b.plano || b;
      const errs = validatePlan(plan, isGitRepo(p.repo));
      if (errs.length) return send(res, 400, { erro: 'Plano recusado: ' + errs.join('; ') });
      if (temRodadaExecutada(p, pdir(p.id))) arquivarRodadaSePreciso(p);
      p.plano = plan; p.estado = 'plano_pronto'; p._corrigido = false;
      if (plan.titulo && !p.tituloFixo) p.titulo = String(plan.titulo).slice(0, 120);
      const dem = calcularDemandaSegura(p);
      p.demanda = dem;
      const baseTexto = `Plano recebido: ${plan.tarefas.length} tarefas.`;
      const textoMsg = dem?.linhaResumo ? `${baseTexto}\n${dem.linhaResumo}` : baseTexto;
      p.mensagens.push({ papel: 'sistema', texto: textoMsg, quando: now() });
      save(p);
      report(p);
      if (p.agendamento?.executarEm && Number(p.agendamento.executarEm) > Date.now() && !p.agendamento?.execucaoDisparadaEm) {
        const resumo = resumoAgendamento(p);
        p.mensagens.push({ papel: 'sistema', texto: `Plano pronto. Aguardando horário agendado (${resumo?.texto || 'execução futura'}).`, quando: now() });
        save(p);
        report(p);
        return send(res, 200, publicView(p, true));
      }
      if (p.auto) {
        startPipeline(p);
        return send(res, 200, publicView(p, true));
      }
      return send(res, 200, publicView(p, true));
    }
    case 'ajustes': {
      if (running && (b.modo != null || b.perfil != null || b.niveis != null || b.esforcos != null || typeof b.auto === 'boolean' || b.velocidade != null || b.cadeias != null || b.agendamento !== undefined || b.politicaCota != null || b.aplicarAjusteCota != null)) return send(res, 409, { erro: 'execução em andamento' });
      if (b.politicaCota != null) {
        if (!['ignorar', 'auto', 'economizar', 'usar_melhor'].includes(String(b.politicaCota))) return send(res, 400, { erro: 'política de cota inválida' });
        p.politicaCota = String(b.politicaCota);
      }
      if (b.agendamento !== undefined) {
        const valAg = validarAgendamentoInput(b.agendamento === null ? { cancelar: true } : b.agendamento);
        if (!valAg.ok) return send(res, 400, { erro: valAg.erro || 'agendamento inválido' });
        if (!valAg.cancelar) {
          const checagem = podeAgendar(p, valAg.agendamento);
          if (!checagem.ok) return send(res, 400, { erro: checagem.erro });
        }
        aplicarAgendamentoNoProjeto(p, valAg.cancelar ? null : valAg.agendamento);
        p.mensagens.push({ papel: 'sistema', texto: valAg.cancelar ? 'Agendamento cancelado.' : `Agendamento atualizado (${resumoAgendamento(p)?.texto || 'ativo'}).`, quando: now() });
      }
      if (b.cadeias != null) {
        if (!b.cadeias || typeof b.cadeias !== 'object' || Array.isArray(b.cadeias)) return send(res, 400, { erro: 'cadeia inválida' });
        for (const [, cad] of Object.entries(b.cadeias)) {
          const limpar = cad === null || (Array.isArray(cad) && cad.length === 0);
          if (!limpar) {
            if (!Array.isArray(cad) || cad.length < 1 || cad.length > 8 || !cad.every(entradaValida)) {
              return send(res, 400, { erro: 'cadeia inválida' });
            }
          }
        }
        if (p.plano && Array.isArray(p.plano.tarefas)) {
          for (const [tid, cad] of Object.entries(b.cadeias)) {
            const t = p.plano.tarefas.find((item) => item.id === tid);
            if (!t) continue;
            const limpar = cad === null || (Array.isArray(cad) && cad.length === 0);
            if (limpar) {
              delete t.cadeia;
            } else {
              t.cadeia = [...cad];
            }
            // Cadeia efetiva antiga ganharia da nova na estimativa (estimarDemandaPlano a lê primeiro).
            delete t.cadeiaEfetiva;
          }
        }
      }
      if (b.velocidade != null) {
        if (!temVel(b.velocidade)) return send(res, 400, { erro: 'velocidade inválida' });
        p.velocidade = b.velocidade;
      }
      if (b.supervisao != null) {
        if (!temSup(b.supervisao)) return send(res, 400, { erro: 'acompanhamento desconhecido' });
        p.supervisao = b.supervisao; // vale também durante a execução, nas próximas confirmações
        if (running) gravarSupervisao(p);
      }
      if (b.modo != null || b.perfil != null) { const erro = aplicarModo(p, b); if (erro) return send(res, 400, { erro }); }
      if (typeof b.auto === 'boolean') p.auto = b.auto;
      if (p.plano && b.niveis && typeof b.niveis === 'object') for (const t of p.plano.tarefas) if (NIVEIS.includes(b.niveis[t.id])) t.nivel = b.niveis[t.id];
      if (p.plano && b.esforcos && typeof b.esforcos === 'object') for (const t of p.plano.tarefas) if (['low', 'medium', 'high'].includes(b.esforcos[t.id])) t.esforco = b.esforcos[t.id];
      if (p.plano && !running && (b.modo != null || b.perfil != null || b.velocidade != null || b.niveis != null || b.esforcos != null || b.cadeias != null)) {
        atualizarMensagemPlanoRecebido(p);
      }
      if (b.aplicarAjusteCota != null) {
        const modoPol = String(b.aplicarAjusteCota);
        if (!['auto', 'economizar', 'usar_melhor', 'ignorar'].includes(modoPol)) return send(res, 400, { erro: 'política de cota inválida' });
        p.politicaCota = modoPol;
        if (p.plano) {
          const resAj = aplicarAjusteCotaNoPlano(p, modoPol);
          p.mensagens.push({ papel: 'sistema', texto: `Ajuste por cota (${NOMES_POLITICA[modoPol] || modoPol}): ${resAj.texto}.`, quando: now() });
        }
      }
      save(p); report(p);
      return send(res, 200, publicView(p, true));
    }
    case 'agendar': {
      if (running) return send(res, 409, { erro: 'execução em andamento' });
      const valAg = validarAgendamentoInput(b);
      if (!valAg.ok) return send(res, 400, { erro: valAg.erro || 'agendamento inválido' });
      if (!valAg.cancelar) {
        const checagem = podeAgendar(p, valAg.agendamento);
        if (!checagem.ok) return send(res, 400, { erro: checagem.erro });
      }
      desarquivarSePreciso(p);
      aplicarAgendamentoNoProjeto(p, valAg.cancelar ? null : valAg.agendamento);
      const resumo = resumoAgendamento(p);
      p.mensagens.push({
        papel: 'sistema',
        texto: valAg.cancelar ? 'Agendamento cancelado.' : `Agendamento salvo (${resumo?.texto || 'ativo'}).`,
        quando: now(),
      });
      save(p); report(p);
      return send(res, 200, publicView(p, true));
    }
    case 'aplicar-ajuste-cota': {
      desarquivarSePreciso(p);
      if (running) return send(res, 409, { erro: 'execução em andamento' });
      if (!p.plano) return send(res, 400, { erro: 'sem plano' });
      const modoPol = String(b.politica || b.modo || 'auto');
      if (!['auto', 'economizar', 'usar_melhor', 'ignorar', 'personalizado'].includes(modoPol)) return send(res, 400, { erro: 'política de cota inválida' });
      const escolhas = escolhasPersonalizadas(b.cadeias);
      if (escolhas === false) return send(res, 400, { erro: 'modelo inválido na escolha personalizada' });
      const resAj = aplicarAjusteCotaNoPlano(p, modoPol, { cadeias: escolhas });
      p.mensagens.push({ papel: 'sistema', texto: `Ajuste por cota (${NOMES_POLITICA[modoPol] || modoPol}): ${resAj.texto}.`, quando: now() });
      save(p); report(p);
      return send(res, 200, publicView(p, true));
    }
    case 'previa-ajuste-cota': {
      if (!p.plano) return send(res, 400, { erro: 'sem plano' });
      const modoPol = String(b.politica || 'auto');
      if (!['auto', 'economizar', 'usar_melhor', 'ignorar', 'personalizado'].includes(modoPol)) return send(res, 400, { erro: 'política de cota inválida' });
      const escolhas = escolhasPersonalizadas(b.cadeias);
      if (escolhas === false) return send(res, 400, { erro: 'modelo inválido na escolha personalizada' });
      const { _cadeias, _esforcos, ...pv } = previaAjusteCota(p, modoPol, { cadeias: escolhas }) || {};
      return send(res, 200, pv);
    }
    case 'confirmar': {
      if (!running) return send(res, 409, { erro: 'nada em execução' });
      if (!decidirGate(p, String(b.gate || ''), b.decisao !== 'nao')) return send(res, 400, { erro: 'confirmação não encontrada ou já decidida' });
      return send(res, 200, publicView(p, true));
    }
    case 'aprovar': {
      desarquivarSePreciso(p);
      if (!p.plano) return send(res, 400, { erro: 'sem plano' });
      if (running) return send(res, 409, { erro: 'já está executando' });
      return send(res, 200, publicView(startPipeline(p), true));
    }
    case 'retomar': {
      desarquivarSePreciso(p);
      if (!fs.existsSync(path.join(pdir(p.id), 'plan.json'))) return send(res, 400, { erro: 'nada para retomar' });
      if (running && alive(p.pid)) return send(res, 409, { erro: 'já está executando' });
      return send(res, 200, publicView(startPipeline(p, true), true));
    }
    case 'arquivar': {
      const arq = b.arquivar === true;
      if (arq && ocupadoDemais(p)) return send(res, 409, { erro: 'não dá para arquivar enquanto roda ou o planejador responde' });
      p.arquivado = arq;
      if (arq) p.arquivadoEm = now(); else delete p.arquivadoEm;
      save(p); evento(p, { tipo: 'projeto', texto: arq ? 'arquivado' : 'desarquivado' });
      return send(res, 200, publicView(p, true));
    }
    case 'excluir': {
      if (b.confirmar !== p.id) return send(res, 400, { erro: 'confirmação inválida' });
      if (ocupadoDemais(p)) return send(res, 409, { erro: 'não dá para excluir enquanto roda ou o planejador responde' });
      const origem = path.resolve(pdir(p.id));
      if (!origem.startsWith(path.resolve(PROJ) + path.sep)) return send(res, 400, { erro: 'caminho inválido' });
      const lixeira = path.join(DATA, 'lixeira'); fs.mkdirSync(lixeira, { recursive: true });
      const destino = path.join(lixeira, `${p.id}-${Date.now()}`);
      fs.renameSync(origem, destino);
      console.log(`projeto ${p.id} movido para ${destino}`);
      return send(res, 200, { ok: true, lixeira: destino });
    }
    case 'cancelar': {
      if (p.pid && alive(p.pid)) await new Promise((r) => execFile('taskkill', ['/PID', String(p.pid), '/T', '/F'], () => r()));
      p.estado = 'cancelado'; p.fim = now(); p.mensagens.push({ papel: 'sistema', texto: 'Execução cancelada pelo usuário.', quando: now() });
      save(p); report(p); logDiario(p, 'Cancelado', ['**Cancelado:** execução interrompida pelo usuário.']);
      evento(p, { tipo: 'cancelado', texto: 'execução cancelada pelo usuário' });
      return send(res, 200, publicView(p, true));
    }
    case 'migrar-rodadas': {
      if (running || ocupadoDemais(p)) return send(res, 409, { erro: 'execução em andamento; aguarde terminar para migrar as rodadas' });
      const r = migrarRodadas(p, { projDir: pdir(p.id), dataDir: DATA, tabela: carregarPrecos({ dataDir: DATA }), gravar: true });
      if (r.migrado) { save(p); report(p); }
      return send(res, 200, publicView(p, true));
    }
  }
  return send(res, 404, { erro: 'ação desconhecida' });
}

const STATIC = { '/': 'index.html', '/painel.js': 'painel.js', '/style.css': 'style.css', '/fluxo.js': 'fluxo.js', '/fluxo.css': 'fluxo.css' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const server = http.createServer(async (req, res) => {
  if (!ehLoopback(req.socket?.remoteAddress)) return send(res, 403, { erro: 'acesso só deste computador' });
  const host = String(req.headers.host || '');
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return send(res, 421, { erro: 'host não permitido' });
  try {
    let url;
    try { url = new URL(req.url, `http://${host}`); } catch { return send(res, 400, { erro: 'endereço inválido' }); } // ex.: "//" não é URL e não pode deixar a requisição pendurada
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const f = STATIC[url.pathname];
    if (req.method !== 'GET' || !f) return send(res, 404, 'não encontrado', 'text/plain; charset=utf-8');
    let body = fs.readFileSync(path.join(PUBLIC, f), 'utf8');
    if (f === 'index.html') body = body.replace('__TOKEN__', TOKEN);
    return send(res, 200, body, TYPES[path.extname(f)]);
  } catch (e) {
    // Só mensagens nossas (corpo grande, JSON inválido) vão para o cliente; erro inesperado fica no log, sem caminho nem detalhe.
    if (e && e.publico) return send(res, 400, { erro: e.message });
    console.error(e);
    return send(res, 500, { erro: 'erro interno do painel' });
  }
});

const ehPrincipal = (() => {
  try {
    const a = path.resolve(process.argv[1] || '').toLowerCase();
    const b = fileURLToPath(import.meta.url).toLowerCase();
    return a === b;
  } catch {
    return false;
  }
})();

if (ehPrincipal) {
  // Primeiro as checagens que podem encerrar o processo; só depois mexe nos projetos.
  const checagemHost = validarHostEscuta();
  if (!checagemHost.ok) {
    console.error(checagemHost.erro);
    process.exit(1);
  }
  server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `porta ${PORT} já em uso; outro painel está no ar` : e); process.exit(1); });
  server.listen(PORT, '127.0.0.1', () => {
    // Projetos que ficaram "planejando" quando o servidor caiu. Só depois de a porta abrir: um segundo
    // servidor (porta ocupada) sai sem tocar no planejador que o painel no ar ainda está rodando.
    for (const p of listAll()) if (p.ocupado) { p.ocupado = false; p.mensagens.push({ papel: 'sistema', texto: 'O servidor reiniciou durante a resposta do planejador. Envie a mensagem de novo.', quando: now() }); save(p); }
    detectar();
    setInterval(poll, 10000);
    // Consumo fora do orquestrador: confere 1x por hora se o resumo passou de 24 h (a leitura em si roda à parte).
    setTimeout(() => atualizarUsoForaEmSegundoPlano(), 60000);
    setInterval(() => atualizarUsoForaEmSegundoPlano(), 3600e3).unref?.();
    console.log(`Delegar em http://127.0.0.1:${PORT} (pid ${process.pid}) · provedores: ${Object.entries(detectar()).filter(([, v]) => v).map(([k]) => k).join(', ') || 'nenhum'}`);
    // Descoberta de modelos em segundo plano: o painel já responde enquanto ela roda.
    iniciarDescoberta({ dataDir: DATA }).then((r) => console.log(`descoberta de modelos: ${r.novos.length} novos; erros: ${Object.keys(r.erros).length ? Object.entries(r.erros).map(([k, v]) => k + ': ' + v).join('; ') : 'nenhum'}`)).catch((e) => console.error('descoberta de modelos falhou:', e));
    // Atualização de preços se vencidos (> 30 dias) em segundo plano
    atualizarSeVencido({ dataDir: DATA }).then((r) => {
      if (r.pulou) console.log(`preços: tabela em dia (${idadeDias(r.tabela)} dias).`);
      else if (r.ok) console.log(`preços atualizados: ${r.atualizados} modelos${r.aviso ? ' (' + r.aviso + ')' : ''}.`);
      else console.error(`atualização de preços: ${r.aviso || 'falha'}`);
    }).catch((e) => console.error('atualização de preços falhou:', e));
  });
}
