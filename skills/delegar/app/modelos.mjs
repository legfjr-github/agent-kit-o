// Catálogo de modelos, detecção dos provedores instalados e adaptação das cadeias ao PC.
// Entrada de cadeia: "<provedor>:<modelo>[@esforço]", provedor = claude | agy | opencode.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, execFileSync } from 'node:child_process';

// O modelo começa por letra ou número (nunca por "-", que a CLI leria como opção).
export const ENTRY_RE = /^(claude|agy|opencode):[A-Za-z0-9][A-Za-z0-9._/~-]{0,99}(@(low|medium|high|xhigh|max))?$/;
// ENTRY_RE aceita "." e "/" (ids como opencode/glm-5.3-flash-free). Segmento vazio, "." ou ".." é caminho, não modelo.
export function entradaValida(e) {
  return typeof e === 'string' && ENTRY_RE.test(e) && !e.split(/[:/@]/).some((s) => s === '' || s === '.' || s === '..');
}
export const QUOTA_RE = /(quota|rate[ _-]?limit|RESOURCE_EXHAUSTED|\b429\b|usage limit|limit reached|out of credits|exceeded your|hit your|try again (later|in))/i;

// Modo desespero: ordem do melhor para o pior. Medido em 12/11/2026 no opencode em modo agente com
// duas tarefas: (1) escrever 4 funções, 20 testes ocultos; (2) corrigir bugs num módulo existente,
// rodando os testes, 10 testes ocultos. Desempate: resultados anteriores e tempo.
// Detalhes em vault/guias_e_comandos/skill_delegar_orquestracao.md, seção "Modelos gratuitos".
export const DESESPERO = [
  'opencode:opencode/glm-5.3-flash-free',      // 20/20 e 10/10
  'opencode:opencode/big-pickle',               // 20/20 e 10/10; o mais rápido (17 a 22 s)
  'opencode:opencode/minimax-m3.1-flash-free',  // 10/10 (a falha da tarefa 1 foi de caminho curto do Windows)
  'opencode:opencode/iceman-free',              // 20/20 e 10/10
  'opencode:opencode/beam-free',                // 20/20 e 10/10
  'opencode:opencode/inkling-2-small-free',     // 20/20 e 10/10; modelo pequeno
  'opencode:opencode/longcat-2.5-free',         // 20/20 e 10/10; lento
  'agy:gpt-oss-120b-medium',                    // fora da cota do Gemini no Antigravity
  'opencode:opencode/deepseek-v4.1-flash-free', // 20/20 e 9/10
];

// Notas de cada modelo para a tela. 
export const DICAS = {
  'claude:opus': 'Melhor raciocínio; consome mais cota.',
  'claude:sonnet': 'Equilíbrio entre qualidade e cota.',
  'claude:haiku': 'Rápido e barato; tarefa simples.',
  'agy:gemini-4-argon-high': 'Gemini 4 Argon: o mais forte do Antigravity.',
  'agy:gemini-3.8-flash-high': 'Padrão de volume no modo econômico.',
  'agy:gemini-3.8-flash-medium': 'Bom equilíbrio entre custo e qualidade.',
  'agy:gemini-3.8-flash-low': 'Mecânico e barato.',
  'agy:gpt-oss-120b-medium': 'Fora da cota do Gemini; reserva do modo desespero.',
  'opencode:opencode/glm-5.3-flash-free': 'Gratuito. 1º no teste de 12/11 (30/30).',
  'opencode:opencode/big-pickle': 'Gratuito. 30/30 no teste de 12/11; o mais rápido.',
  'opencode:opencode/minimax-m3.1-flash-free': 'Gratuito. Acertou a correção de bugs; errou caminho curto do Windows na outra tarefa.',
  'opencode:opencode/iceman-free': 'Gratuito. 30/30 no teste de 12/11.',
  'opencode:opencode/beam-free': 'Gratuito. 30/30 no teste de 12/11.',
  'opencode:opencode/inkling-2-small-free': 'Gratuito. 30/30 no teste de 12/11; modelo pequeno, rápido.',
  'opencode:opencode/longcat-2.5-free': 'Gratuito. 30/30 no teste de 12/11; lento.',
  'opencode:opencode/deepseek-v4.1-flash-free': 'Gratuito. 29/30 no teste de 12/11; bom em texto técnico.',
  'opencode:opencode/nemotron-3.5-super-vl-free': 'Gratuito. Multimodal; gravou fora da pasta numa das tarefas.',
  'opencode:opencode/mimo-v2.6-flash-free': 'Gratuito. 29/30, mas muito lento (até 7 min).',
  'opencode:opencode/nemotron-3.5-lightning-free': 'Gratuito. Gravou fora da pasta na correção de bugs; evitar.',
  'opencode:opencode/flint-40b-free': 'Gratuito. Falhou nas duas tarefas; não usar.',
  'opencode:nvidia/z-ai/glm-5.3-flash': 'GLM 5.3 pela NVIDIA (precisa da chave NVIDIA no opencode).',
};

const FIXOS = {
  claude: ['opus', 'sonnet', 'haiku', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'],
  agy: ['gemini-4-argon-high', 'gemini-4-argon-medium', 'gemini-4-argon-low', 'gemini-3.8-flash-high', 'gemini-3.8-flash-medium',
    'gemini-3.8-flash-low', 'claude-opus-5-5-high', 'claude-sonnet-5-5-high', 'claude-sonnet-5-5-medium', 'gpt-oss-120b-medium'],
  opencode: ['opencode/glm-5.3-flash-free', 'opencode/deepseek-v4.1-flash-free', 'opencode/minimax-m3.1-flash-free',
    'opencode/mimo-v2.6-flash-free', 'opencode/big-pickle', 'opencode/longcat-2.5-free', 'opencode/nemotron-3.5-super-vl-free',
    'opencode/nemotron-3.5-lightning-free', 'opencode/iceman-free', 'opencode/inkling-2-small-free', 'opencode/beam-free',
    'opencode/flint-40b-free', 'nvidia/z-ai/glm-5.3-flash'],
};

function onde(cmd) {
  try { return execFileSync('where', [cmd], { encoding: 'utf8', windowsHide: true, timeout: 10000 }).split(/\r?\n/).find(Boolean) || null; }
  catch { return null; }
}

let PROV = null;
// Quais CLIs existem neste PC. DELEGAR_PROVEDORES=claude,opencode força uma lista (útil em teste).
export function detectar(forcar = false) {
  if (PROV && !forcar) return PROV;
  const lista = (process.env.DELEGAR_PROVEDORES || '').split(',').map((s) => s.trim()).filter(Boolean);
  const agyPadrao = path.join(os.homedir(), '.gemini', 'bin', 'agy.exe');
  const achado = {
    claude: onde('claude'),
    agy: process.env.AGY_BIN || onde('agy') || (fs.existsSync(agyPadrao) ? agyPadrao : null),
    opencode: onde('opencode'),
  };
  PROV = Object.fromEntries(Object.entries(achado).map(([k, v]) => [k, lista.length ? (lista.includes(k) ? v || k : null) : v]));
  return PROV;
}

export const provedorDe = (entry) => String(entry).split(':')[0];
export const disponivel = (entry) => !!detectar()[provedorDe(entry)];

// ---------------------------------------------------------------------------------------------
// Descoberta de modelos: lê `agy models` e `opencode models`, acumula o resultado em
// dataDir/modelos-descobertos.json e marca como "novo" o que ainda não é conhecido no catálogo.
// ---------------------------------------------------------------------------------------------
const MAX_DESCOBERTOS = 400;
const ARQUIVO = 'modelos-descobertos.json';
const ANSI_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;
const SEG_OPENCODE_RE = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const TOKEN_AGY_RE = /^[a-z0-9][a-z0-9.-]+$/;

// Estado em memória: id -> { primeiraVez, ultimaVez }.
let DESCOBERTOS = new Map();
let ESTADO = { emAndamento: false, quando: null, erros: {}, promessa: null };

// Transforma a saída de texto de uma CLI em ids 'prov:modelo' válidos. O que não casar é descartado.
export function analisarSaida(prov, texto) {
  if (prov !== 'opencode' && prov !== 'agy') return [];
  const saida = new Set();
  for (const bruta of String(texto ?? '').replace(ANSI_RE, '').split(/\r?\n/)) {
    if (saida.size >= MAX_DESCOBERTOS) break;
    const linha = bruta.trim();
    if (!linha) continue;
    let id = null;
    if (prov === 'opencode') {
      // provedor/modelo; cada segmento começa por letra ou número (barra '.', '..' e caminhos relativos)
      const partes = linha.split('/');
      if (partes.length >= 2 && partes.every((x) => SEG_OPENCODE_RE.test(x))) id = `opencode:${linha}`;
    } else {
      const token = linha.split(/\s+/)[0];
      if (TOKEN_AGY_RE.test(token)) id = `agy:${token}`;
    }
    if (id && entradaValida(id)) saida.add(id);
  }
  return [...saida];
}

// Id lido de modelos-descobertos.json: só passa o que a própria descoberta teria aceitado (provedor agy ou opencode, sem @esforço).
function idDescobertoOk(id) {
  if (!entradaValida(id)) return false;
  const prov = id.split(':')[0];
  if (prov !== 'agy' && prov !== 'opencode') return false;
  return analisarSaida(prov, id.slice(prov.length + 1))[0] === id;
}
const CHAVES_ERRO = ['agy', 'opencode', 'gravacao', 'descoberta'];
const MAX_ARQUIVO = 1024 * 1024;

const semEsforco = (id) => String(id).replace(/@(low|medium|high|xhigh|max)$/, '');

// true se o modelo (sem @esforço) não está na lista fixa do provedor nem nas dicas.
export function ehNovo(id) {
  const limpo = semEsforco(id);
  const prov = provedorDe(limpo);
  const modelo = limpo.slice(prov.length + 1);
  return !(FIXOS[prov] || []).includes(modelo) && !Object.prototype.hasOwnProperty.call(DICAS, limpo);
}

function ordenados() {
  return [...DESCOBERTOS.entries()]
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => (a.primeiraVez < b.primeiraVez ? -1 : a.primeiraVez > b.primeiraVez ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const MAX_EXTRAS_DESESPERO = 10; // a cadeia do worker não cresce sem limite se a CLI listar dezenas de gratuitos
// DESESPERO fixo seguido dos gratuitos do opencode descobertos que ainda não são conhecidos.
export function desesperoEfetivo() {
  const base = new Set(DESESPERO);
  const extras = ordenados()
    .filter((d) => ehNovo(d.id) && provedorDe(d.id) === 'opencode' && semEsforco(d.id).endsWith('-free') && !base.has(d.id))
    .map((d) => d.id)
    .slice(0, MAX_EXTRAS_DESESPERO);
  return [...DESESPERO, ...extras];
}

export function estadoDescoberta() {
  return {
    emAndamento: ESTADO.emAndamento,
    quando: ESTADO.quando,
    erros: { ...ESTADO.erros },
    novos: ordenados().filter((d) => ehNovo(d.id)).map((d) => d.id),
  };
}

const dataValida = (v, padrao) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : padrao);

function carimbo(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Lê o arquivo de forma síncrona. Arquivo corrompido é renomeado e o estado recomeça vazio.
function carregar(dataDir) {
  const arq = path.join(dataDir, ARQUIVO);
  let st;
  try { st = fs.statSync(arq); }
  catch { return { mapa: new Map(), quando: null, erros: {} }; }
  try {
    if (!st.isFile() || st.size > MAX_ARQUIVO) throw new Error('arquivo grande demais ou irregular');
    const dados = JSON.parse(fs.readFileSync(arq, 'utf8'));
    if (!dados || typeof dados !== 'object' || !Array.isArray(dados.modelos)) throw new Error('formato inválido');
    const mapa = new Map();
    const agora = new Date().toISOString();
    for (const m of dados.modelos) {
      if (mapa.size >= MAX_DESCOBERTOS) break;
      if (!m || typeof m.id !== 'string' || !idDescobertoOk(m.id)) continue;
      const primeiraVez = dataValida(m.primeiraVez, agora);
      mapa.set(m.id, { primeiraVez, ultimaVez: dataValida(m.ultimaVez, primeiraVez) });
    }
    const erros = {};
    if (dados.erros && typeof dados.erros === 'object' && !Array.isArray(dados.erros)) {
      for (const k of CHAVES_ERRO) {
        const v = Object.hasOwn(dados.erros, k) ? dados.erros[k] : null;
        if (typeof v === 'string') erros[k] = limparTexto(v);
      }
    }
    return { mapa, quando: dataValida(dados.atualizado, null), erros };
  } catch {
    try { fs.renameSync(arq, `${arq}.corrompido-${carimbo()}`); } catch { /* sem permissão: segue vazio */ }
    return { mapa: new Map(), quando: null, erros: {} };
  }
}

function gravar(dataDir, atualizado, erros) {
  fs.mkdirSync(dataDir, { recursive: true });
  const arq = path.join(dataDir, ARQUIVO);
  const tmp = `${arq}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ versao: 1, atualizado, modelos: ordenados(), erros }, null, 2), 'utf8');
  fs.renameSync(tmp, arq);
}

// Texto de erro vindo de CLI ou do disco: sem escapes ANSI nem caracteres de controle (a CLI do painel o imprime no terminal).
function limparTexto(v) {
  return String(v).replace(ANSI_RE, '').replace(/[\x00-\x1f\x7f-\x9f\s]+/g, ' ').trim().slice(0, 300);
}
function mensagemDe(e) {
  const linha = String((e && e.message) || e || 'erro').split(/\r?\n/).map((l) => limparTexto(l)).find(Boolean);
  return linha || 'erro';
}

// Executa a listagem de uma CLI. Sem shell com texto interpolado; no timeout mata a árvore de processos.
export function executarPadrao(prov, exe, timeoutMs) {
  return new Promise((resolve, reject) => {
    const [bin, args] = prov === 'opencode' ? ['cmd.exe', ['/d', '/c', 'opencode', 'models']] : [exe, ['models']];
    let fim = false;
    let timer = null;
    const concluir = (fn, v) => { if (fim) return; fim = true; clearTimeout(timer); fn(v); };
    let filho;
    try {
      filho = execFile(bin, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (e, out) => {
        if (e) concluir(reject, new Error(mensagemDe(e)));
        else concluir(resolve, String(out));
      });
    } catch (e) { concluir(reject, new Error(mensagemDe(e))); return; }
    timer = setTimeout(() => {
      if (filho && filho.pid) {
        try { execFile('taskkill', ['/PID', String(filho.pid), '/T', '/F'], { windowsHide: true }, () => {}); } catch { /* ignora */ }
      }
      concluir(reject, new Error('tempo esgotado'));
    }, timeoutMs);
  });
}

function comLimite(promessa, ms) {
  let timer;
  const limite = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('tempo esgotado')), ms); });
  return Promise.race([promessa, limite]).finally(() => clearTimeout(timer));
}

// Lê as listagens dos provedores presentes (agy e opencode) e acumula no arquivo. Nunca rejeita.
export function iniciarDescoberta({ dataDir, timeoutMs = 45000, provedores = detectar(), executar = executarPadrao } = {}) {
  if (ESTADO.promessa) return ESTADO.promessa;
  let lido = { mapa: new Map(), quando: null, erros: {} };
  try { if (dataDir) lido = carregar(dataDir); } catch { /* segue vazio */ }
  DESCOBERTOS = lido.mapa;
  ESTADO = { emAndamento: true, quando: lido.quando, erros: lido.erros, promessa: null };

  const rodar = async () => {
    const erros = {};
    const novos = [];
    try {
      const alvos = ['agy', 'opencode'].filter((p) => provedores && provedores[p]);
      const resultados = await Promise.allSettled(alvos.map((prov) => {
        let p;
        try { p = Promise.resolve(executar(prov, provedores[prov], timeoutMs)); } catch (e) { p = Promise.reject(e); }
        return comLimite(p, timeoutMs);
      }));
      const agora = new Date().toISOString();
      resultados.forEach((r, i) => {
        const prov = alvos[i];
        if (r.status === 'rejected') { erros[prov] = mensagemDe(r.reason); return; }
        for (const id of analisarSaida(prov, r.value)) {
          const antigo = DESCOBERTOS.get(id);
          if (antigo) antigo.ultimaVez = agora;
          else {
            DESCOBERTOS.set(id, { primeiraVez: agora, ultimaVez: agora });
            if (ehNovo(id)) novos.push(id);
          }
        }
      });
      if (DESCOBERTOS.size > MAX_DESCOBERTOS) {
        const mantidos = ordenados().sort((a, b) => (a.ultimaVez < b.ultimaVez ? 1 : a.ultimaVez > b.ultimaVez ? -1 : 0)).slice(0, MAX_DESCOBERTOS);
        DESCOBERTOS = new Map(mantidos.map((d) => [d.id, { primeiraVez: d.primeiraVez, ultimaVez: d.ultimaVez }]));
      }
      if (alvos.length && dataDir) {
        try { gravar(dataDir, agora, erros); } catch (e) { erros.gravacao = mensagemDe(e); }
      }
      ESTADO = { emAndamento: false, quando: agora, erros, promessa: null };
      return { quando: agora, novos, erros };
    } catch (e) {
      erros.descoberta = mensagemDe(e);
      const agora = new Date().toISOString();
      ESTADO = { emAndamento: false, quando: agora, erros, promessa: null };
      return { quando: agora, novos, erros };
    }
  };
  ESTADO.promessa = rodar();
  return ESTADO.promessa;
}

// Compatibilidade com o server.mjs atual: dispara a descoberta em segundo plano.
export function atualizarListas() {
  iniciarDescoberta({ dataDir: process.env.DELEGAR_DATA || path.join(os.homedir(), '.delegar') });
}

// Só para testes: zera o estado em memória.
export function _reiniciarDescoberta() {
  DESCOBERTOS = new Map();
  ESTADO = { emAndamento: false, quando: null, erros: {}, promessa: null };
}

// Remove da cadeia o que não está instalado. Se nada sobrar, usa a cadeia do desespero e,
// em último caso, qualquer modelo de um provedor presente.
export function adaptar(chain, reserva = DESESPERO) {
  const ok = (chain || []).filter((e) => entradaValida(e) && disponivel(e));
  if (ok.length) return [...new Set(ok)];
  const r = reserva.filter(disponivel);
  if (r.length) return r.slice(0, 3);
  const p = detectar();
  if (p.claude) return ['claude:sonnet', 'claude:haiku'];
  if (p.agy) return ['agy:gemini-3.8-flash-high'];
  if (p.opencode) return ['opencode:opencode/glm-5.3-flash-free'];
  return [];
}

export function catalogo() {
  const p = detectar();
  const efetivo = desesperoEfetivo();
  const modelos = [];
  for (const prov of ['claude', 'agy', 'opencode']) {
    const achados = ordenados().filter((d) => provedorDe(d.id) === prov).map((d) => d.id.slice(prov.length + 1));
    const ids = [...new Set([...(FIXOS[prov] || []), ...achados])];
    for (const m of ids) {
      const id = `${prov}:${m}`;
      const rank = efetivo.indexOf(id);
      modelos.push({
        id, provedor: prov, instalado: !!p[prov], dica: DICAS[id] || '', desespero: rank >= 0 ? rank + 1 : null,
        novo: ehNovo(id), descoberto: DESCOBERTOS.get(id)?.primeiraVez ?? null,
      });
    }
  }
  return {
    provedores: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, !!v])),
    modelos, desespero: efetivo, descoberta: estadoDescoberta(),
  };
}
