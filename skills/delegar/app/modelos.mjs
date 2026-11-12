// Catálogo de modelos, detecção dos provedores instalados e adaptação das cadeias ao PC.
// Entrada de cadeia: "<provedor>:<modelo>[@esforço]", provedor = claude | agy | opencode.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, execFileSync } from 'node:child_process';

export const ENTRY_RE = /^(claude|agy|opencode):[A-Za-z0-9._/~-]{1,100}(@(low|medium|high|xhigh|max))?$/;
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

const DINAMICOS = { agy: null, opencode: null };
// Lê `agy models` e `opencode models` em segundo plano; a tela usa a lista fixa até a leitura terminar.
export function atualizarListas() {
  const p = detectar();
  if (p.agy) execFile(p.agy, ['models'], { encoding: 'utf8', windowsHide: true, timeout: 60000 }, (e, out) => {
    if (!e) DINAMICOS.agy = out.split(/\r?\n/).map((l) => l.split(/\s+/)[0]).filter((m) => /^[a-z0-9][a-z0-9.-]+$/.test(m));
  });
  if (p.opencode) execFile('cmd.exe', ['/d', '/c', 'opencode', 'models'], { encoding: 'utf8', windowsHide: true, timeout: 60000 }, (e, out) => {
    if (!e) DINAMICOS.opencode = out.split(/\r?\n/).map((l) => l.trim()).filter((m) => /-free$/.test(m) || m === 'opencode/big-pickle');
  });
}

export const provedorDe = (entry) => String(entry).split(':')[0];
export const disponivel = (entry) => !!detectar()[provedorDe(entry)];

// Remove da cadeia o que não está instalado. Se nada sobrar, usa a cadeia do desespero e,
// em último caso, qualquer modelo de um provedor presente.
export function adaptar(chain, reserva = DESESPERO) {
  const ok = (chain || []).filter((e) => ENTRY_RE.test(e) && disponivel(e));
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
  const modelos = [];
  for (const prov of ['claude', 'agy', 'opencode']) {
    const ids = [...new Set([...(FIXOS[prov] || []), ...(DINAMICOS[prov] || [])])];
    for (const m of ids) {
      const id = `${prov}:${m}`;
      const rank = DESESPERO.indexOf(id);
      modelos.push({ id, provedor: prov, instalado: !!p[prov], dica: DICAS[id] || '', desespero: rank >= 0 ? rank + 1 : null });
    }
  }
  return { provedores: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, !!v])), modelos, desespero: DESESPERO };
}
