// Delegar: painel local para planejar com um modelo e executar com o pipeline (scripts/pipeline.ps1).
// Ouve só em 127.0.0.1. Toda chamada /api (exceto /api/saude) exige o cabeçalho X-Delegar-Token.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ENTRY_RE, QUOTA_RE, DESESPERO, adaptar, catalogo, detectar, atualizarListas } from './modelos.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(HERE, '..', 'scripts');
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

// ---------- modos ----------
const GH = 'agy:gemini-3.8-flash-high', GM = 'agy:gemini-3.8-flash-medium', GL = 'agy:gemini-3.8-flash-low', ARGON = 'agy:gemini-4-argon-high';
const [D1, D2, D3, D4] = DESESPERO; // glm-5.3-flash, big-pickle, minimax-m3.1-flash, iceman (ordem do teste de 12/11)
export const MODES = {
  agressivo: {
    nome: 'Agressivo', descricao: 'Só Claude, esforço alto: Opus planeja e corrige, Sonnet executa, Haiku no mecânico. Mais rápido e mais caro.',
    planner: ['claude:opus@xhigh', ARGON, D1],
    tiers: {
      pesado: ['claude:opus@high', 'claude:sonnet@high'],
      volume: ['claude:sonnet@high', 'claude:opus@medium', 'claude:haiku'],
      leve: ['claude:haiku', 'claude:sonnet@medium'],
    },
    fix: ['claude:opus@high', 'claude:sonnet@high'], coord: ['claude:opus@high', 'claude:sonnet@high'], maxConcurrent: 3,
  },
  equilibrado: {
    nome: 'Equilibrado', descricao: 'Opus planeja; Sonnet no que pede cuidado, volume dividido entre Sonnet e Gemini; Haiku, Gemini low e o melhor gratuito no mecânico.',
    planner: ['claude:opus@high', ARGON, D1],
    tiers: {
      pesado: ['claude:sonnet@high', GH, 'claude:haiku'],
      volume: [['claude:sonnet@medium', GH, 'claude:haiku'], [GH, 'claude:sonnet@medium', 'claude:haiku']],
      leve: ['claude:haiku', GL, D1],
    },
    fix: ['claude:sonnet@high', GH], coord: ['claude:sonnet@medium', GH], maxConcurrent: 2,
  },
  padrao: {
    nome: 'Padrão (econômico)', descricao: 'Opus planeja; Gemini 3.8 Flash executa; tarefa simples vai primeiro para o melhor modelo gratuito; Sonnet e Haiku só na falta de cota.',
    planner: ['claude:opus@high', ARGON, D1],
    tiers: {
      pesado: [GH, 'claude:sonnet', 'claude:haiku'],
      volume: [GH, 'claude:sonnet', 'claude:haiku'],
      leve: [D1, GL, GM, 'claude:haiku'],
    },
    fix: ['claude:sonnet', GH], coord: [GH, 'claude:sonnet'], maxConcurrent: 2,
  },
  desespero: {
    nome: 'Desespero (gratuitos)', descricao: 'Para quando a cota do Gemini acabou e a do Claude está no fim: tudo vai para os modelos gratuitos do opencode, do melhor para o pior. O pipeline também entra nele sozinho quando nenhum provedor tem cota.',
    planner: [D1, 'agy:gpt-oss-120b-medium', 'claude:sonnet@medium'],
    tiers: {
      pesado: [D1, D2, D3],
      volume: [[D1, D2, D3], [D2, D1, D4]],
      leve: [D2, DESESPERO[5], D1],
    },
    fix: [D1, D2], coord: [D1, D2], maxConcurrent: 2,
  },
};
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
// Modo personalizado: mesmas chaves de um modo pronto, com listas planas.
function validarCustom(c) {
  const errs = [];
  if (!c || typeof c !== 'object') return { errs: ['modo personalizado vazio'] };
  const base = temModo(c.base) ? c.base : null;
  const out = { nome: 'Personalizado', descricao: base ? `Personalizado a partir do modo ${MODES[base].nome}.` : 'Definido do zero.', base, tiers: {} };
  for (const k of [...LISTAS_TOPO, ...NIVEIS]) {
    const lista = LISTAS_TOPO.includes(k) ? c[k] : c.tiers?.[k];
    if (!Array.isArray(lista) || !lista.length || lista.length > 8) { errs.push(`${k}: informe de 1 a 8 modelos`); continue; }
    const ruins = lista.filter((e) => typeof e !== 'string' || !ENTRY_RE.test(e));
    if (ruins.length) { errs.push(`${k}: modelo inválido (${ruins.slice(0, 2).map(String).join(', ').slice(0, 120)})`); continue; }
    if (LISTAS_TOPO.includes(k)) out[k] = [...new Set(lista)]; else out.tiers[k] = [...new Set(lista)];
  }
  const mc = Number(c.maxConcurrent);
  out.maxConcurrent = Number.isInteger(mc) && mc >= 1 && mc <= 4 ? mc : 2;
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
function slug(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'projeto';
}

// ---------- cadeias ----------
// Cadeia do modo para a tarefa, adaptada ao que está instalado e com os dois melhores gratuitos no fim como última reserva.
function chainFor(p, t, idx) {
  const m = cfgDe(p);
  let c;
  if (Array.isArray(t.cadeia) && t.cadeia.length) c = t.cadeia;
  else { const tier = m.tiers[t.nivel] || m.tiers.volume; c = Array.isArray(tier[0]) ? tier[idx % tier.length] : tier; }
  return comReserva(adaptar(c));
}
function comReserva(c) {
  const extra = adaptar(DESESPERO.slice(0, 2), []).filter((e) => !c.includes(e));
  return [...c, ...extra].slice(0, Math.max(8, c.length));
}
const wtName = (p, t) => `${p.id.slice(-6)}-${t.id}`.replace(/[^a-z0-9_-]/gi, '-');

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

async function runClaude({ cwd, model, effort, prompt, resume }) {
  const args = ['/d', '/c', 'claude', '-p', '--model', model, '--output-format', 'json',
    '--dangerously-skip-permissions', '--disallowedTools', 'Edit,Write,NotebookEdit',
    '--append-system-prompt-file', PLANNER_FILE];
  if (effort) args.push('--effort', effort);
  if (resume) args.push('--resume', resume);
  const r = await coletar(spawn('cmd.exe', args, { cwd, windowsHide: true }), prompt, LIMITE_PLANEJADOR);
  const line = r.out.trim().split(/\r?\n/).filter((l) => l.startsWith('{')).pop();
  try { const j = JSON.parse(line); return { ok: !j.is_error, text: j.result || '', session: j.session_id }; }
  catch { return { ok: false, text: (r.err || r.out || 'sem resposta').slice(-3000) }; }
}

// opencode com o agente "plan" (não edita). O planner.md vai no começo do primeiro prompt.
async function runOpencode({ cwd, model, effort, prompt, resume }) {
  const args = ['/d', '/c', 'opencode', 'run', '--pure', '--agent', 'plan', '--model', model, '--format', 'json', '--title', 'Delegar planejamento'];
  if (effort) args.push('--variant', effort);
  if (resume) args.push('--session', resume);
  const parts = []; let session = null; const erros = [];
  const r = await coletar(spawn('cmd.exe', args, { cwd, windowsHide: true }), resume ? prompt : instrucoes() + '\n\n---\n\n' + prompt, LIMITE_PLANEJADOR, (l) => {
    try {
      const e = JSON.parse(l); session = e.sessionID || session;
      if (e.type === 'text' && e.part?.text) parts.push(e.part.text);
      if (e.type === 'error') erros.push(JSON.stringify(e.error || e).slice(0, 1000));
    } catch {}
  });
  const text = parts.join('\n').trim();
  return text ? { ok: true, text, session } : { ok: false, text: (erros.join(' ') || r.err || r.out || 'sem resposta').slice(-3000) };
}

// agy com --dangerously-skip-permissions (o planejador continua proibido de editar pelo planner.md).
async function runAgy({ cwd, model, effort, prompt }) {
  const exe = detectar().agy;
  const args = ['--model', model, '--input-format', 'stream-json', '--output-format', 'stream-json', '--dangerously-skip-permissions', '--disable-slash-commands', '--add-dir', cwd];
  if (fs.existsSync(VAULT)) args.push('--add-dir', VAULT);
  if (effort) args.push('--effort', effort);
  args.push('-p=');
  const buffer = []; let final = {};
  const line = JSON.stringify({ event: 'user', message: { content: instrucoes() + '\n\n---\n\n' + prompt } }) + '\n';
  const r = await coletar(spawn(exe, args, { cwd, windowsHide: true }), line, LIMITE_PLANEJADOR, (l) => {
    try {
      const e = JSON.parse(l);
      if (e.event === 'step_update' && e.step_update?.step_type === 'agent_response' && e.step_update.text_delta) buffer.push(e.step_update.text_delta);
      if (e.event === 'result') final = e.result || {};
    } catch {}
  });
  const text = String(final.response || buffer.join('')).trim();
  return text ? { ok: true, text } : { ok: false, text: (r.err || r.out || 'sem resposta').slice(-3000) };
}

function introducao(p) {
  const m = cfgDe(p);
  return `Pedido do usuário:\n${p.pedido}\n\nRepositório: ${p.repo} (${isGitRepo(p.repo) ? 'git' : 'não é git: não use escritores'})\n` +
    `Cofre de conhecimento: ${VAULT}\nModo: ${m.nome}. ${m.descricao}\nAcompanhamento: ${SUPERVISAO[supDe(p)]}\n` +
    `Provedores instalados neste PC: ${Object.entries(detectar()).filter(([, v]) => v).map(([k]) => k).join(', ') || 'nenhum'}\n` +
    (p.auto ? '\nMODO AUTOMÁTICO: não faça perguntas. Analise o necessário e entregue já nesta resposta o plano final no formato combinado.'
      : '\nConverse para fechar o escopo. Se o pedido já estiver claro, proponha o plano final no formato combinado.');
}
// Prompt com a conversa inteira, para provedor sem sessão retomável ou quando o planejador mudou.
function transcricao(p, novo) {
  const hist = p.mensagens.filter((m) => m.papel !== 'sistema').slice(1, -1)
    .map((m) => `[${m.papel === 'usuario' ? 'Usuário' : 'Planejador'}]\n${m.texto}`).join('\n\n');
  return `${introducao(p)}\n\n## Conversa até agora\n${hist || '(nenhuma)'}\n\n## Nova mensagem do usuário\n${novo}`;
}

async function chamarPlanejador(p, texto) {
  const cands = adaptar(cfgDe(p).planner);
  const avisos = [];
  if (!cands.length) return { ok: false, text: 'Nenhuma CLI de IA encontrada neste PC (claude, agy ou opencode).', avisos };
  let ultimo;
  for (const entry of cands) {
    const { prov, model, effort } = parseEntry(entry);
    const mesmo = p.sessao && p.sessaoDe === entry && prov !== 'agy';
    const primeiro = !p.mensagens.some((m) => m.papel === 'planejador');
    const prompt = mesmo ? texto : primeiro ? introducao(p) + (texto !== p.pedido ? '\n\n' + texto : '') : transcricao(p, texto);
    const run = prov === 'claude' ? runClaude : prov === 'opencode' ? runOpencode : runAgy;
    evento(p, { tipo: 'planejador', modelo: entry, texto: 'planejador pensando' });
    const r = await run({ cwd: p.repo, model, effort, prompt, resume: mesmo ? p.sessao : null });
    ultimo = { ...r, entry, avisos };
    if (r.ok || !QUOTA_RE.test(r.text)) return ultimo;
    avisos.push(`Planejador ${entry} sem cota; tentando o próximo modelo.`);
    evento(p, { tipo: 'troca', modelo: entry, texto: 'planejador sem cota, tentando o próximo' });
  }
  return ultimo;
}

function extractPlan(text) {
  const blocks = [...String(text).matchAll(/```json\s*([\s\S]*?)```/g)];
  if (!blocks.length) return { plan: null };
  try { return { plan: JSON.parse(blocks[blocks.length - 1][1]) }; }
  catch (e) { return { plan: null, error: 'JSON do plano inválido: ' + e.message }; }
}

function validatePlan(pl, isGit) {
  const errs = [];
  if (!pl || typeof pl !== 'object') return ['plano vazio'];
  if (!Array.isArray(pl.tarefas) || !pl.tarefas.length) errs.push('sem tarefas');
  if ((pl.tarefas || []).length > 40) errs.push('mais de 40 tarefas');
  const ids = new Set();
  for (const t of pl.tarefas || []) {
    if (typeof t.id !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(t.id)) errs.push(`id inválido: ${t.id}`);
    else if (ids.has(t.id)) errs.push(`id repetido: ${t.id}`);
    ids.add(t.id);
    if (!TIPOS.includes(t.tipo)) errs.push(`${t.id}: tipo inválido`);
    if (!NIVEIS.includes(t.nivel)) errs.push(`${t.id}: nível inválido`);
    if (typeof t.prompt !== 'string' || t.prompt.length < 20) errs.push(`${t.id}: prompt vazio`);
    else if (t.prompt.length > 25000) errs.push(`${t.id}: prompt longo demais`);
    if (t.tipo === 'escritor' && !isGit) errs.push(`${t.id}: escritor exige repositório git`);
    if (t.cadeia != null && (!Array.isArray(t.cadeia) || t.cadeia.some((e) => typeof e !== 'string' || !ENTRY_RE.test(e)))) errs.push(`${t.id}: cadeia inválida`);
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
  const { plan, error } = extractPlan(r.text);
  if (error) p.mensagens.push({ papel: 'sistema', texto: error, quando: now() });
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
    p.plano = plan; p.estado = 'plano_pronto'; p._corrigido = false;
    if (plan.titulo && !p.tituloFixo) p.titulo = String(plan.titulo).slice(0, 120);
    p.mensagens.push({ papel: 'sistema', texto: `Plano recebido: ${plan.tarefas.length} tarefas.`, quando: now() });
    save(p);
    report(p);
    if (p.auto) return startPipeline(p);
    return p;
  }
  if (!p.plano) p.estado = 'conversando';
  save(p); return p;
}

// ---------- execução ----------
function buildPlanFile(p) {
  const m = cfgDe(p);
  const dir = pdir(p.id), pr = path.join(dir, 'prompts');
  fs.mkdirSync(pr, { recursive: true });
  const byId = Object.fromEntries(p.plano.tarefas.map((t) => [t.id, t]));
  let vol = 0;
  const tasks = p.plano.tarefas.map((t) => {
    let text = t.prompt;
    const o = { id: t.id, titulo: String(t.titulo || '').slice(0, 120), chain: chainFor(p, t, t.nivel === 'volume' ? vol++ : 0), after: t.depende, confirm: !!t.confirmar, reason: t.motivo || '' };
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
  const vol0 = Array.isArray(m.tiers.volume[0]) ? m.tiers.volume[0] : m.tiers.volume;
  const plan = {
    name: p.id, repo: p.repo, worktreeRoot: p.repo + '-wt', logDir: path.join(dir, 'logs'),
    chain: comReserva(adaptar(vol0)), fixChain: comReserva(adaptar(m.fix)), coordinatorChain: comReserva(adaptar(m.coord)),
    desperateChain: adaptar(DESESPERO, []), supervision: supDe(p),
    maxConcurrent: Math.max(1, Math.min(Number(p.plano.maxConcurrent) || m.maxConcurrent, m.maxConcurrent)),
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

function startPipeline(p, resume = false) {
  if (!p.plano) return p;
  const pf = resume ? path.join(pdir(p.id), 'plan.json') : buildPlanFile(p);
  if (!resume) fs.rmSync(path.join(pdir(p.id), 'logs'), { recursive: true, force: true });
  else gravarSupervisao(p);
  try { p.pid = spawnPipeline(pf, resume); }
  catch (e) {
    p.estado = 'interrompido'; p.mensagens.push({ papel: 'sistema', texto: 'Falha ao iniciar o pipeline: ' + e.message, quando: now() });
    save(p); return p;
  }
  p.estado = 'executando';
  if (!resume) p.inicio = now();
  p.fim = null;
  p.mensagens.push({ papel: 'sistema', texto: resume ? 'Execução retomada.' : `Execução iniciada (modo ${nomeModo(p)}, acompanhamento ${supDe(p)}).`, quando: now() });
  save(p);
  report(p);
  if (!resume) logDiario(p, 'Iniciado', [`**Iniciado:** execução do plano (${p.plano.tarefas.length} tarefas, modo ${nomeModo(p)}) em \`${p.repo}\`.`]);
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
  for (let i = linhas.length - 1; i >= 0 && i >= linhas.length - 200; i--) {
    const l = linhas[i].trim();
    if (l.startsWith('{')) {
      try {
        const e = JSON.parse(l);
        const blocos = e.message?.content;
        if (e.type === 'assistant' && Array.isArray(blocos)) {
          const tu = [...blocos].reverse().find((b) => b.type === 'tool_use');
          if (tu) return resumoFerramenta(tu.name, tu.input);
          const tx = [...blocos].reverse().find((b) => b.type === 'text' && b.text?.trim());
          if (tx) return tx.text.trim().slice(0, 200);
        }
        if (e.type === 'tool_use' && e.part) return resumoFerramenta(e.part.tool, e.part.state?.input);
        if (e.type === 'text' && e.part?.text) return e.part.text.trim().slice(0, 200);
        if (e.type === 'result' && e.result) return 'terminou: ' + String(e.result).trim().slice(0, 160);
      } catch {}
      continue;
    }
    return l.slice(0, 200);
  }
  return '';
}
function resumoFerramenta(nome, inp = {}) {
  const alvo = inp?.file_path || inp?.filePath || inp?.path || inp?.command || inp?.pattern || inp?.url || inp?.description || '';
  return `${nome}${alvo ? ': ' + String(alvo).replace(/\s+/g, ' ').slice(0, 160) : ''}`;
}
function agoraNaTarefa(p, id) {
  const ld = path.join(pdir(p.id), 'logs', id);
  if (!fs.existsSync(ld)) return null;
  const outs = fs.readdirSync(ld).filter((f) => /^\d+-.*\.out\.log$/.test(f)).sort((a, b) => parseInt(a) - parseInt(b));
  if (!outs.length) return null;
  const f = outs[outs.length - 1];
  const st = fs.statSync(path.join(ld, f));
  const cur = lerJson(path.join(ld, 'current.json')) || {};
  const fim = cur.worker ? null : lerJson(path.join(ld, 'result.json'));
  return { tentativa: parseInt(f), modelo: cur.worker || fim?.model || null, verificando: !!fim, arquivo: f, acao: ultimaAcao(cauda(path.join(ld, f))), atualizado: st.mtime.toISOString() };
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
  return { id: p.id, titulo: p.titulo, estado: p.estado, ocupado: !!p.ocupado, modo: nomeModo(p), supervisao: supDe(p), desespero: run.desespero,
    rodando, gates: run.gates, eventos: eventos(p), commits: await commitsRecentes(p.repo) };
}

function poll() {
  for (const p of listAll()) {
    if (p.estado !== 'executando') continue;
    const r = readRun(p);
    const h = crypto.createHash('md5').update(JSON.stringify(r.status)).digest('hex');
    const ended = /pipeline end/.test(r.log) && r.summary;
    if (ended) {
      p.estado = /RESULTADO: CONCLUIDO/.test(r.summary) ? 'concluido' : 'incompleto';
      p.fim = now();
      p.mensagens.push({ papel: 'sistema', texto: `Execução terminou: ${p.estado}.`, quando: now() });
      save(p); report(p, r);
      const st = Object.entries(r.status).map(([k, v]) => `${k} ${v.state}${v.model ? ' (' + v.model + ')' : ''}`).join(', ');
      logDiario(p, p.estado === 'concluido' ? 'Concluído' : 'Incompleto', [
        `**${p.estado === 'concluido' ? 'Concluído' : 'Incompleto'}:** ${st}.`,
        `**Relatório:** [[orquestracao/${p.id}]]; logs em \`${path.join(pdir(p.id), 'logs')}\`.`,
        ...(p.estado === 'concluido' ? [] : ['**Pendências:** ver tarefas não concluídas no relatório; retomar pelo painel ou `cli.mjs retomar`.']),
      ]);
    } else if (!alive(p.pid)) {
      p.estado = 'interrompido'; p.mensagens.push({ papel: 'sistema', texto: 'O processo do pipeline não está mais rodando. Use Retomar.', quando: now() });
      save(p); report(p, r);
    } else if (h !== p.statusHash) {
      p.statusHash = h; save(p); report(p, r);
    }
  }
}

// ---------- cofre ----------
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
function report(p, run) {
  try {
    if (!fs.existsSync(VAULT)) return;
    run = run || readRun(p);
    const dir = path.join(VAULT, 'orquestracao'); fs.mkdirSync(dir, { recursive: true });
    const L = [`# Orquestração: ${p.titulo}`, '',
      `- **Projeto Delegar:** \`${p.id}\` · **Modo:** ${nomeModo(p)} · **Acompanhamento:** ${supDe(p)} · **Estado:** ${p.estado}`,
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
const readBody = (req) => new Promise((resolve, reject) => {
  let n = 0; const chunks = [];
  req.on('data', (c) => { n += c.length; if (n > 1e6) { reject(new Error('corpo grande demais')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => { try { const j = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; resolve(j && typeof j === 'object' ? j : {}); } catch { reject(new Error('JSON inválido')); } });
});
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function modoPublico(p) {
  const m = cfgDe(p);
  return { planner: m.planner, tiers: m.tiers, fix: m.fix, coord: m.coord, maxConcurrent: m.maxConcurrent, base: m.base || null };
}
function publicView(p, full) {
  const v = { id: p.id, titulo: p.titulo, modo: p.modo, modoNome: nomeModo(p), supervisao: supDe(p), estado: p.estado, auto: p.auto, repo: p.repo, criado: p.criado, inicio: p.inicio, fim: p.fim, ocupado: !!p.ocupado };
  if (!full) { v.gates = p.estado === 'executando' ? gatesPendentes(p).length : 0; return v; }
  v.pedido = p.pedido; v.mensagens = p.mensagens; v.planejador = p.planejador || null;
  v.config = modoPublico(p); v.plannerEfetivo = adaptar(cfgDe(p).planner);
  if (p.plano) {
    let vol = 0;
    v.plano = { ...p.plano, tarefas: p.plano.tarefas.map((t) => ({ ...t, cadeiaEfetiva: chainFor(p, t, t.nivel === 'volume' ? vol++ : 0) })) };
  }
  v.run = readRun(p);
  v.relatorio = path.join(VAULT, 'orquestracao', `${p.id}.md`);
  return v;
}

// Aplica o modo pedido ao projeto. "personalizado" sem configuração copia o modo atual. Devolve o erro ou null.
function aplicarModo(p, b) {
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

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // api, recurso, id, acao
  if (parts[1] === 'saude') return send(res, 200, { ok: true });
  if (!safeEq(req.headers['x-delegar-token'] || '', TOKEN)) return send(res, 401, { erro: 'token inválido' });
  if (req.method === 'GET' && parts[1] === 'modos') {
    const modos = Object.fromEntries(Object.entries(MODES).map(([k, m]) => [k, { nome: m.nome, descricao: m.descricao, tiers: m.tiers, planner: m.planner, fix: m.fix, coord: m.coord, maxConcurrent: m.maxConcurrent, plannerEfetivo: adaptar(m.planner) }]));
    return send(res, 200, { modos, supervisao: SUPERVISAO, ultimoPersonalizado: lerJson(CUSTOM_FILE), padraoPersonalizado: modoComoCustom('padrao') });
  }
  if (req.method === 'GET' && parts[1] === 'modelos') return send(res, 200, catalogo());
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
    const titulo = String(b.titulo || pedido.split('\n')[0]).slice(0, 120);
    const d = new Date(); const z = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}${z(d.getHours())}${z(d.getMinutes())}`;
    const p = { id: `${stamp}-${slug(titulo)}-${crypto.randomBytes(2).toString('hex')}`, titulo, tituloFixo: !!b.titulo, pedido, repo, modo: 'padrao', auto: !!b.auto,
      supervisao: temSup(b.supervisao) ? b.supervisao : 'automatico',
      criado: now(), estado: 'planejando', mensagens: [{ papel: 'usuario', texto: pedido, quando: now() }], sessao: null, plano: null };
    const erro = aplicarModo(p, { modo: b.modo || 'padrao', custom: b.custom });
    if (erro) return send(res, 400, { erro });
    if (!adaptar(cfgDe(p).planner).length) return send(res, 400, { erro: 'nenhuma CLI de IA (claude, agy ou opencode) encontrada neste PC' });
    save(p);
    plannerTurn(p, pedido).catch((e) => console.error(e));
    return send(res, 201, publicView(p, true));
  }
  const p = load(parts[2]);
  if (!p) return send(res, 404, { erro: 'projeto não encontrado' });
  if (req.method === 'GET' && !parts[3]) return send(res, 200, publicView(p, true));
  if (req.method === 'GET' && parts[3] === 'atividade') return send(res, 200, await atividade(p));
  if (req.method !== 'POST') return send(res, 405, { erro: 'método não permitido' });
  const b = await readBody(req);
  const busy = () => send(res, 409, { erro: 'o planejador ainda está respondendo' });
  const running = p.estado === 'executando';
  switch (parts[3]) {
    case 'mensagem': {
      const t = String(b.texto || '').trim();
      if (!t || t.length > 50000) return send(res, 400, { erro: 'mensagem vazia' });
      if (p.ocupado) return busy();
      if (running) return send(res, 409, { erro: 'execução em andamento' });
      p.mensagens.push({ papel: 'usuario', texto: t, quando: now() }); save(p);
      plannerTurn(p, t).catch((e) => console.error(e));
      return send(res, 202, { ok: true });
    }
    case 'gerar-plano': {
      if (p.ocupado) return busy();
      if (running) return send(res, 409, { erro: 'execução em andamento' });
      p.mensagens.push({ papel: 'usuario', texto: '(pediu o plano final)', quando: now() }); save(p);
      plannerTurn(p, 'Gere o plano final.', { gerar: true }).catch((e) => console.error(e));
      return send(res, 202, { ok: true });
    }
    case 'ajustes': {
      if (running && (b.modo != null || b.niveis != null || typeof b.auto === 'boolean')) return send(res, 409, { erro: 'execução em andamento' });
      if (b.supervisao != null) {
        if (!temSup(b.supervisao)) return send(res, 400, { erro: 'acompanhamento desconhecido' });
        p.supervisao = b.supervisao; // vale também durante a execução, nas próximas confirmações
        if (running) gravarSupervisao(p);
      }
      if (b.modo != null) { const erro = aplicarModo(p, b); if (erro) return send(res, 400, { erro }); }
      if (typeof b.auto === 'boolean') p.auto = b.auto;
      if (p.plano && b.niveis && typeof b.niveis === 'object') for (const t of p.plano.tarefas) if (NIVEIS.includes(b.niveis[t.id])) t.nivel = b.niveis[t.id];
      save(p); report(p);
      return send(res, 200, publicView(p, true));
    }
    case 'confirmar': {
      if (!running) return send(res, 409, { erro: 'nada em execução' });
      if (!decidirGate(p, String(b.gate || ''), b.decisao !== 'nao')) return send(res, 400, { erro: 'confirmação não encontrada ou já decidida' });
      return send(res, 200, publicView(p, true));
    }
    case 'aprovar': {
      if (!p.plano) return send(res, 400, { erro: 'sem plano' });
      if (running) return send(res, 409, { erro: 'já está executando' });
      return send(res, 200, publicView(startPipeline(p), true));
    }
    case 'retomar': {
      if (!fs.existsSync(path.join(pdir(p.id), 'plan.json'))) return send(res, 400, { erro: 'nada para retomar' });
      if (running && alive(p.pid)) return send(res, 409, { erro: 'já está executando' });
      return send(res, 200, publicView(startPipeline(p, true), true));
    }
    case 'cancelar': {
      if (p.pid && alive(p.pid)) await new Promise((r) => execFile('taskkill', ['/PID', String(p.pid), '/T', '/F'], () => r()));
      p.estado = 'cancelado'; p.fim = now(); p.mensagens.push({ papel: 'sistema', texto: 'Execução cancelada pelo usuário.', quando: now() });
      save(p); report(p); logDiario(p, 'Cancelado', ['**Cancelado:** execução interrompida pelo usuário.']);
      evento(p, { tipo: 'cancelado', texto: 'execução cancelada pelo usuário' });
      return send(res, 200, publicView(p, true));
    }
  }
  return send(res, 404, { erro: 'ação desconhecida' });
}

const STATIC = { '/': 'index.html', '/painel.js': 'painel.js', '/style.css': 'style.css' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const server = http.createServer(async (req, res) => {
  const host = String(req.headers.host || '');
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return send(res, 421, { erro: 'host não permitido' });
  const url = new URL(req.url, `http://${host}`);
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const f = STATIC[url.pathname];
    if (req.method !== 'GET' || !f) return send(res, 404, 'não encontrado', 'text/plain; charset=utf-8');
    let body = fs.readFileSync(path.join(PUBLIC, f), 'utf8');
    if (f === 'index.html') body = body.replace('__TOKEN__', TOKEN);
    return send(res, 200, body, TYPES[path.extname(f)]);
  } catch (e) {
    console.error(e);
    return send(res, 400, { erro: e.message || 'erro' });
  }
});

// Projetos que ficaram "planejando" quando o servidor caiu
for (const p of listAll()) if (p.ocupado) { p.ocupado = false; p.mensagens.push({ papel: 'sistema', texto: 'O servidor reiniciou durante a resposta do planejador. Envie a mensagem de novo.', quando: now() }); save(p); }
detectar(); atualizarListas();
setInterval(poll, 10000);
server.listen(PORT, '127.0.0.1', () => console.log(`Delegar em http://127.0.0.1:${PORT} · provedores: ${Object.entries(detectar()).filter(([, v]) => v).map(([k]) => k).join(', ') || 'nenhum'}`));
