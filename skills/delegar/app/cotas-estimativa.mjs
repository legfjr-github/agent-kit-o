// Estimativa de tokens por 1% de cota a partir do histórico de leituras (state/quota-historico.jsonl)
// e dos logs locais de consumo (Claude Code, Antigravity brain e tentativas do Delegar).
// Puro e testável.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { grupoDoModelo } from './cotas.mjs';
import { carregarPrecos, precoDe, custoUsd } from './precos.mjs';

export function fmtMil(n) {
  if (n == null || !Number.isFinite(n)) return '-';
  const v = Math.round(n);
  if (v >= 1e6) {
    const mi = (v / 1e6).toFixed(1).replace(/\.0$/, '').replace('.', ',');
    return `${mi} mi`;
  }
  if (v >= 1e3) {
    const mil = Math.round(v / 1e3);
    return `${mil} mil`;
  }
  return String(v);
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function mediana(arr) {
  if (!arr || !arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 !== 0 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ---------------------------------------------------------------------------------------------
// 1. Histórico de leituras (quota-historico.jsonl)
// ---------------------------------------------------------------------------------------------

export function registrarHistoricoCota(dataDir, leitura, { maxBytes = 2 * 1024 * 1024, manterLinhas = 1000 } = {}) {
  try {
    if (!dataDir || !leitura || typeof leitura !== 'object' || !leitura.time) return false;
    const temLeitura = leitura.claude?.read === true ||
      leitura.gemini?.read === true ||
      leitura.argon?.read === true ||
      leitura.agyClaudeGpt?.read === true;
    if (!temLeitura) return false;

    const histFile = path.join(dataDir, 'state', 'quota-historico.jsonl');
    fs.mkdirSync(path.dirname(histFile), { recursive: true });

    if (fs.existsSync(histFile)) {
      try {
        const conteudo = fs.readFileSync(histFile, 'utf8').trim();
        if (conteudo) {
          const ultQuebra = conteudo.lastIndexOf('\n');
          const ultLinha = ultQuebra >= 0 ? conteudo.slice(ultQuebra + 1).trim() : conteudo;
          if (ultLinha) {
            const parsed = JSON.parse(ultLinha);
            if (parsed.time === leitura.time) return false; // já gravado
          }
        }
      } catch {}
    }

    const entrada = {
      time: leitura.time,
      claude: leitura.claude || null,
      gemini: leitura.gemini || null,
      argon: leitura.argon || null,
      agyClaudeGpt: leitura.agyClaudeGpt || null,
    };
    fs.appendFileSync(histFile, JSON.stringify(entrada) + '\n', 'utf8');

    try {
      const st = fs.statSync(histFile);
      if (st.size > maxBytes) {
        const texto = fs.readFileSync(histFile, 'utf8');
        const linhas = texto.split(/\r?\n/).filter((l) => l.trim().length > 0);
        if (linhas.length > manterLinhas) {
          const mantidas = linhas.slice(-manterLinhas);
          const tmp = `${histFile}.${process.pid}.${Date.now()}.tmp`;
          fs.writeFileSync(tmp, mantidas.join('\n') + '\n', 'utf8');
          fs.renameSync(tmp, histFile);
        }
      }
    } catch {}

    return true;
  } catch {
    return false;
  }
}

export function lerHistoricoCotas(dataDir) {
  try {
    if (!dataDir) return [];
    const histFile = path.join(dataDir, 'state', 'quota-historico.jsonl');
    if (!fs.existsSync(histFile)) return [];
    const txt = fs.readFileSync(histFile, 'utf8');
    const linhas = txt.split(/\r?\n/).filter(Boolean);
    const resultado = [];
    for (const l of linhas) {
      const linha = l.trim();
      if (!linha.startsWith('{')) continue;
      try {
        const item = JSON.parse(linha);
        if (item && typeof item === 'object' && item.time) resultado.push(item);
      } catch {}
    }
    return resultado;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------------------------
// 2. Coleta de consumo das tentativas do Delegar
// ---------------------------------------------------------------------------------------------

export function coletarTentativasUso(projetos, { dataDir, dadosUsoProjeto } = {}) {
  const lista = [];
  try {
    const projs = Array.isArray(projetos) ? projetos : [];
    for (const p of projs) {
      if (!p || typeof p !== 'object') continue;
      const dados = dadosUsoProjeto ? dadosUsoProjeto(p) : p.uso;
      if (!dados || typeof dados !== 'object') continue;
      const tarefas = Array.isArray(dados.tarefas) ? dados.tarefas : [];
      for (const tf of tarefas) {
        if (!tf || !Array.isArray(tf.tentativas)) continue;
        for (const tent of tf.tentativas) {
          if (!tent || typeof tent !== 'object') continue;
          const inicioMs = tent.inicio ? Date.parse(tent.inicio) : null;
          const fimMs = tent.fim ? Date.parse(tent.fim) : null;
          const linhas = Array.isArray(tent.porModelo) && tent.porModelo.length ? tent.porModelo : null;
          if (linhas) {
            for (const m of linhas) {
              const prov = m.provedor || tent.provedor || 'desconhecido';
              const mod = m.modelo || tent.modelo || '';
              const modeloCompleto = mod.includes(':') ? mod : `${prov}:${mod}`;
              const grupo = grupoDoModelo(modeloCompleto);
              lista.push({
                modelo: modeloCompleto,
                provedor: prov,
                grupo,
                inicioMs: Number.isFinite(inicioMs) ? inicioMs : null,
                fimMs: Number.isFinite(fimMs) ? fimMs : null,
                entrada: Number(m.entrada) || 0,
                saida: Number(m.saida) || 0,
                cacheLido: Number(m.cacheLido) || 0,
                cacheGravado: Number(m.cacheGravado) || 0,
              });
            }
          } else {
            const prov = tent.provedor || 'desconhecido';
            const mod = tent.modelo || '';
            const modeloCompleto = mod.includes(':') ? mod : `${prov}:${mod}`;
            const grupo = grupoDoModelo(modeloCompleto);
            lista.push({
              modelo: modeloCompleto,
              provedor: prov,
              grupo,
              inicioMs: Number.isFinite(inicioMs) ? inicioMs : null,
              fimMs: Number.isFinite(fimMs) ? fimMs : null,
              entrada: Number(tent.entrada) || 0,
              saida: Number(tent.saida) || 0,
              cacheLido: Number(tent.cacheLido) || 0,
              cacheGravado: Number(tent.cacheGravado) || 0,
            });
          }
        }
      }
    }
  } catch {}
  return lista;
}

// ---------------------------------------------------------------------------------------------
// 3. Leitura com cache do consumo da máquina (Claude Code e Antigravity Brain)
// ---------------------------------------------------------------------------------------------

const CACHE_ARQUIVOS_LOCAIS = new Map(); // caminho -> { mtimeMs, size, eventos: [...] }

export function lerLogsClaudeCode(claudeDir, { maxAgeMs = 15 * 86400e3, inicioMs = 0 } = {}) {
  const eventos = [];
  const base = claudeDir || process.env.DELEGAR_CLAUDE_PROJECTS || path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(base)) return eventos;

  const agora = Date.now();
  const cutoff = inicioMs > 0 ? inicioMs : agora - maxAgeMs;
  const vistosMsgIds = new Set();

  function varrer(dir) {
    let itens = [];
    try { itens = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const item of itens) {
      const p = path.join(dir, item.name);
      if (item.isDirectory()) {
        varrer(p);
      } else if (item.name.endsWith('.jsonl')) {
        let st;
        try { st = fs.statSync(p); } catch { continue; }
        if (st.mtimeMs < cutoff) continue; // muito antigo para o histórico
        if (st.size > 100 * 1024 * 1024) continue; // pula arquivos gigantescos

        const emCache = CACHE_ARQUIVOS_LOCAIS.get(p);
        if (emCache && emCache.mtimeMs === st.mtimeMs && emCache.size === st.size) {
          for (const ev of emCache.eventos) {
            if (!vistosMsgIds.has(ev.id)) {
              vistosMsgIds.add(ev.id);
              eventos.push(ev);
            }
          }
          continue;
        }

        const evsArquivo = [];
        try {
          const txt = fs.readFileSync(p, 'utf8');
          const linhas = txt.split(/\r?\n/).filter(Boolean);
          for (const l of linhas) {
            const linha = l.trim();
            if (!linha.startsWith('{')) continue;
            let j;
            try { j = JSON.parse(linha); } catch { continue; }
            if (j.type === 'assistant' && j.message?.usage) {
              const msgId = j.message.id || j.requestId || `${p}#${evsArquivo.length}`;
              const tIso = j.timestamp || j.message.timestamp;
              const tMs = tIso ? Date.parse(tIso) : st.mtimeMs;
              const u = j.message.usage;
              const ev = {
                id: msgId,
                modelo: `claude:${j.message.model || 'sonnet'}`,
                provedor: 'claude',
                grupo: 'claude',
                inicioMs: tMs,
                fimMs: tMs,
                timestampMs: tMs,
                entrada: num(u.input_tokens),
                saida: num(u.output_tokens),
                cacheLido: num(u.cache_read_input_tokens),
                cacheGravado: num(u.cache_creation_input_tokens),
              };
              evsArquivo.push(ev);
              if (!vistosMsgIds.has(msgId)) {
                vistosMsgIds.add(msgId);
                eventos.push(ev);
              }
            }
          }
          CACHE_ARQUIVOS_LOCAIS.set(p, { mtimeMs: st.mtimeMs, size: st.size, eventos: evsArquivo });
        } catch {}
      }
    }
  }

  varrer(base);
  return eventos;
}

export function lerLogsAntigravityBrain(brainDir, { maxAgeMs = 15 * 86400e3, inicioMs = 0 } = {}) {
  const eventos = [];
  const base = brainDir || process.env.DELEGAR_AGY_BRAIN || path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain');
  if (!fs.existsSync(base)) return eventos;

  const agora = Date.now();
  const cutoff = inicioMs > 0 ? inicioMs : agora - maxAgeMs;
  let sessões = [];
  try { sessões = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return eventos; }

  for (const s of sessões) {
    const pastaSessao = path.join(base, s.name);
    let st;
    try { st = fs.statSync(pastaSessao); } catch { continue; }
    if (st.mtimeMs < cutoff) continue;

    const arqFull = path.join(pastaSessao, '.system_generated', 'logs', 'transcript_full.jsonl');
    const arqCompact = path.join(pastaSessao, '.system_generated', 'logs', 'transcript.jsonl');
    const arq = fs.existsSync(arqFull) ? arqFull : (fs.existsSync(arqCompact) ? arqCompact : null);
    if (!arq) continue;

    let stArq;
    try { stArq = fs.statSync(arq); } catch { continue; }
    if (stArq.size > 100 * 1024 * 1024) continue;

    const emCache = CACHE_ARQUIVOS_LOCAIS.get(arq);
    if (emCache && emCache.mtimeMs === stArq.mtimeMs && emCache.size === stArq.size) {
      eventos.push(...emCache.eventos);
      continue;
    }

    const evsArquivo = [];
    try {
      const txt = fs.readFileSync(arq, 'utf8');
      const linhas = txt.split(/\r?\n/).filter(Boolean);
      let idx = 0;
      for (const l of linhas) {
        const linha = l.trim();
        if (!linha.startsWith('{')) continue;
        let j;
        try { j = JSON.parse(linha); } catch { continue; }
        if (j.source === 'MODEL' && j.input_tokens != null) {
          const tIso = j.created_at;
          const tMs = tIso ? Date.parse(tIso) : stArq.mtimeMs;
          const mNome = (j.model || j.model_name || 'gemini-3.8-flash').toLowerCase();
          let grp = 'gemini';
          if (mNome.includes('argon')) grp = 'argon';
          else if (mNome.includes('claude') || mNome.includes('gpt')) grp = 'agy-claude-gpt';

          const ev = {
            id: `${s.name}#${j.step_index ?? idx++}`,
            modelo: `agy:${mNome}`,
            provedor: 'agy',
            grupo: grp,
            inicioMs: tMs,
            fimMs: tMs,
            timestampMs: tMs,
            entrada: num(j.input_tokens),
            saida: num(j.output_tokens),
            cacheLido: num(j.cache_read_tokens),
            cacheGravado: num(j.cache_write_tokens),
          };
          evsArquivo.push(ev);
          eventos.push(ev);
        }
      }
      CACHE_ARQUIVOS_LOCAIS.set(arq, { mtimeMs: stArq.mtimeMs, size: stArq.size, eventos: evsArquivo });
    } catch {}
  }

  return eventos;
}

export function coletarConsumoLocal(opcoes = {}) {
  const claude = lerLogsClaudeCode(opcoes.claudeDir, opcoes);
  const brain = lerLogsAntigravityBrain(opcoes.brainDir, opcoes);
  return [...claude, ...brain];
}

// ---------------------------------------------------------------------------------------------
// 4. Mapeamento de janelas e chaves de cota
// ---------------------------------------------------------------------------------------------

const CONFIG_CHAVES = {
  'claude-5h': { prop: 'claude', grupo: 'claude', janela: 'fiveHour', duracaoMaxMs: 5.5 * 3600e3 },
  'claude-semanal': { prop: 'claude', grupo: 'claude', janela: 'sevenDay', duracaoMaxMs: 7.5 * 86400e3 },
  'gemini-5h': { prop: 'gemini', grupo: 'gemini', janela: 'fiveHour', duracaoMaxMs: 5.5 * 3600e3 },
  'gemini-semanal': { prop: 'gemini', grupo: 'gemini', janela: 'sevenDay', duracaoMaxMs: 7.5 * 86400e3 },
  'argon-semanal': { prop: 'argon', grupo: 'argon', janela: 'sevenDay', duracaoMaxMs: 7.5 * 86400e3 },
  'agy-claude-gpt-5h': { prop: 'agyClaudeGpt', grupo: 'agy-claude-gpt', janela: 'fiveHour', duracaoMaxMs: 5.5 * 3600e3 },
  'agy-claude-gpt-semanal': { prop: 'agyClaudeGpt', grupo: 'agy-claude-gpt', janela: 'sevenDay', duracaoMaxMs: 7.5 * 86400e3 },
};

// ---------------------------------------------------------------------------------------------
// 5. Normalização de submodelos, pesos de preço e estimativa por modelo
// ---------------------------------------------------------------------------------------------

const PRECO_PADRAO_GRUPO = {
  claude: { entrada: 2, saida: 10, cacheLido: 0.1, cacheGravado: 2.5 },
  gemini: { entrada: 0.75, saida: 3.75, cacheLido: 0.075, cacheGravado: 0.75 },
  argon: { entrada: 0.75, saida: 3.75, cacheLido: 0.075, cacheGravado: 0.75 },
  'agy-claude-gpt': { entrada: 2, saida: 10, cacheLido: 0.1, cacheGravado: 2.5 },
};

const MODELO_REF_GRUPO = {
  claude: 'claude-sonnet-5-5',
  gemini: 'gemini-3.8-flash',
  argon: 'gemini-4-argon',
  'agy-claude-gpt': 'claude-sonnet-5-5',
};

const SUBMODELOS_GRUPO = {
  claude: ['claude:haiku', 'claude:sonnet', 'claude:opus'],
  gemini: ['agy:gemini-3.8-flash', 'agy:gemini-4-hydrogen', 'agy:gemini-4-carbon', 'agy:gemini-4-neon', 'agy:gemini-3.1-pro-preview'],
  argon: ['agy:gemini-4-argon'],
  'agy-claude-gpt': ['agy:claude-sonnet-5-5', 'agy:claude-opus-5-5', 'agy:gpt-oss-120b'],
};

export function normalizarSubmodelo(modelo, grupo) {
  const raw = String(modelo ?? '').trim().toLowerCase();
  if (!raw) return grupo === 'claude' ? 'claude:sonnet' : 'agy:padrao';

  let prov = '';
  let nome = raw;
  const idx = raw.indexOf(':');
  if (idx > 0) {
    prov = raw.slice(0, idx);
    nome = raw.slice(idx + 1);
  } else {
    prov = grupo === 'claude' ? 'claude' : 'agy';
  }

  nome = nome
    .replace(/\[[^\]]*\]$/, '')
    .replace(/@(low|medium|high|xhigh|max)$/, '')
    .replace(/-(low|medium|high|xhigh|max)$/, '');

  if (prov === 'claude' || (!idx && grupo === 'claude')) {
    if (nome.includes('haiku')) return 'claude:haiku';
    if (nome.includes('opus')) return 'claude:opus';
    if (nome.includes('fable')) return 'claude:fable';
    if (nome.includes('sonnet')) return 'claude:sonnet';
    return `claude:${nome}`;
  }

  if (nome.startsWith('gemini-3.8-flash')) return 'agy:gemini-3.8-flash';
  if (nome.startsWith('gemini-4-hydrogen')) return 'agy:gemini-4-hydrogen';
  if (nome.startsWith('gemini-4-argon')) return 'agy:gemini-4-argon';
  if (nome.startsWith('gemini-4-carbon')) return 'agy:gemini-4-carbon';
  if (nome.startsWith('gemini-4-neon')) return 'agy:gemini-4-neon';
  if (nome.startsWith('gemini-3.1-pro-preview')) return 'agy:gemini-3.1-pro-preview';
  if (nome.startsWith('claude-sonnet-')) return 'agy:claude-sonnet-5-5';
  if (nome.startsWith('claude-opus-')) return 'agy:claude-opus-5-5';
  if (nome.startsWith('gpt-oss-')) return 'agy:gpt-oss-120b';

  return `${prov || 'agy'}:${nome}`;
}

export function pesosDePrecoDoModelo(modelo, { tabelaPrecos, grupo, razaoSaidaEntrada: razaoOverride } = {}) {
  const tabela = tabelaPrecos || carregarPrecos();
  const canonico = normalizarSubmodelo(modelo, grupo);
  const semPrefixo = canonico.replace(/^[^:]+:/, '');
  const pTabela = precoDe(tabela, semPrefixo) || precoDe(tabela, String(modelo || '').replace(/^[^:]+:/, ''));
  const fallback = PRECO_PADRAO_GRUPO[grupo] || PRECO_PADRAO_GRUPO.claude;
  const preco = pTabela && pTabela.entrada > 0 && pTabela.saida > 0
    ? {
        entrada: pTabela.entrada,
        saida: pTabela.saida,
        cacheLido: pTabela.cacheLido ?? 0,
        cacheGravado: pTabela.cacheGravado ?? pTabela.entrada,
      }
    : { ...fallback };

  const razaoSaidaEntrada = typeof razaoOverride === 'number' && razaoOverride > 0
    ? razaoOverride
    : preco.saida / preco.entrada;
  const razaoCacheLido = (preco.cacheLido ?? 0) / preco.entrada;
  const razaoCacheGravado = (preco.cacheGravado ?? preco.entrada) / preco.entrada;

  return {
    modelo: canonico,
    preco,
    razaoSaidaEntrada,
    razaoCacheLido,
    razaoCacheGravado,
  };
}

function calcularConsumoEquivalente(ev, tabela, grupo, opcoes = {}) {
  const pesos = pesosDePrecoDoModelo(ev.modelo, { tabelaPrecos: tabela, grupo, razaoSaidaEntrada: opcoes.razaoSaidaEntrada });
  const ent = num(ev.entrada);
  const sai = num(ev.saida);
  const cl = num(ev.cacheLido);
  const cg = num(ev.cacheGravado);
  const eqEntrada = ent + sai * pesos.razaoSaidaEntrada + cl * pesos.razaoCacheLido + cg * pesos.razaoCacheGravado;
  const usdEq = (
    ent * pesos.preco.entrada +
    sai * pesos.preco.saida +
    cl * (pesos.preco.cacheLido ?? 0) +
    cg * (pesos.preco.cacheGravado ?? pesos.preco.entrada)
  ) / 1e6;
  return { eqEntrada, usdEq, pesos };
}

export function analisarTrabalhosComParalelos(pontos, eventosGrupo, tabela, opcoes = {}) {
  const pts = Array.isArray(pontos) ? pontos : [];
  const evs = Array.isArray(eventosGrupo) ? eventosGrupo : [];
  const duracaoMaxMs = opcoes.duracaoMaxMs ?? 5.5 * 3600e3;
  const minDeltaPct = opcoes.minDeltaPct ?? 1;
  const grupo = opcoes.grupo || 'claude';

  const amostrasTrabalhos = [];
  let trabalhosAnalisados = 0;
  let paralelosDetectados = 0;

  if (pts.length < 2 || evs.length === 0) {
    return { amostrasTrabalhos, trabalhosAnalisados, paralelosDetectados };
  }

  for (const trab of evs) {
    if (!Number.isFinite(trab.inicioMs) || !Number.isFinite(trab.fimMs) || trab.fimMs <= trab.inicioMs) continue;

    let A = null;
    for (let i = pts.length - 1; i >= 0; i--) {
      if (pts[i].tMs <= trab.inicioMs) { A = pts[i]; break; }
    }
    let B = null;
    for (let i = 0; i < pts.length; i++) {
      if (pts[i].tMs >= trab.fimMs) { B = pts[i]; break; }
    }
    if (!A || !B || B.tMs <= A.tMs) continue;
    if (B.tMs - A.tMs > duracaoMaxMs) continue;
    if (B.restante > A.restante + 0.002) continue;
    if (Number.isFinite(A.renovaMs) && B.tMs >= A.renovaMs - 60000) continue;
    if (Number.isFinite(A.renovaMs) && Number.isFinite(B.renovaMs) && Math.abs(B.renovaMs - A.renovaMs) > 15 * 60000) continue;

    const deltaPctJanela = (A.restante - B.restante) * 100;
    if (deltaPctJanela < minDeltaPct) continue;

    let usdTotalParalelos = 0;
    let usdTrabalho = 0;
    let paralelosNoPeriodo = 0;

    for (const ev of evs) {
      let frac = 0;
      if (Number.isFinite(ev.inicioMs) && Number.isFinite(ev.fimMs) && ev.fimMs > ev.inicioMs) {
        const interIni = Math.max(ev.inicioMs, A.tMs);
        const interFim = Math.min(ev.fimMs, B.tMs);
        const overlap = Math.max(0, interFim - interIni);
        frac = overlap / (ev.fimMs - ev.inicioMs);
      } else {
        const t = Number.isFinite(ev.fimMs) ? ev.fimMs : Number.isFinite(ev.inicioMs) ? ev.inicioMs : ev.timestampMs;
        frac = (Number.isFinite(t) && t >= A.tMs && t <= B.tMs) ? 1 : 0;
      }
      if (frac <= 0) continue;

      const { usdEq } = calcularConsumoEquivalente(ev, tabela, grupo, opcoes);
      const usdFrac = usdEq * frac;
      usdTotalParalelos += usdFrac;
      if (ev === trab) usdTrabalho = usdFrac;
      paralelosNoPeriodo++;
    }

    if (usdTrabalho <= 0 || usdTotalParalelos <= 0) continue;
    trabalhosAnalisados++;
    if (paralelosNoPeriodo > 1) paralelosDetectados++;

    const deltaPctAtribuido = deltaPctJanela * (usdTrabalho / usdTotalParalelos);
    if (deltaPctAtribuido <= 0) continue;

    amostrasTrabalhos.push({
      modelo: normalizarSubmodelo(trab.modelo, grupo),
      deltaPct: deltaPctAtribuido,
      deltaPctJanela,
      paralelosNoPeriodo,
      entrada: num(trab.entrada),
      saida: num(trab.saida),
      cacheLido: num(trab.cacheLido),
      cacheGravado: num(trab.cacheGravado),
      usdTrabalho,
      usdPorPct: usdTrabalho / deltaPctAtribuido,
      A,
      B,
    });
  }

  return { amostrasTrabalhos, trabalhosAnalisados, paralelosDetectados };
}

function estimarPorModelo(amostras, grupo, opcoes = {}) {
  const porModelo = {};
  const submodelos = [];
  if (!amostras || !amostras.length) return { porModelo, submodelos };

  const tabela = opcoes.tabelaPrecos || carregarPrecos();
  const usdPorPctGeral = mediana(amostras.map((a) => a.usdPorPct).filter((v) => v > 0));
  const modelosUsados = new Set(SUBMODELOS_GRUPO[grupo] || []);

  for (const a of amostras) {
    if (a.porModelo) {
      for (const m of Object.keys(a.porModelo)) {
        modelosUsados.add(normalizarSubmodelo(m, grupo));
      }
    }
  }

  for (const mod of modelosUsados) {
    const pesos = pesosDePrecoDoModelo(mod, { tabelaPrecos: tabela, grupo, razaoSaidaEntrada: opcoes.razaoSaidaEntrada });
    const amostrasDoMod = [];

    for (const a of amostras) {
      const pm = a.porModelo?.[mod];
      if (!pm) continue;
      const totMod = pm.entrada + pm.saida + pm.cacheLido + pm.cacheGravado;
      const totAmostra = a.entrada + a.saida + a.cache;
      if (totAmostra > 0 && totMod / totAmostra >= 0.7) {
        const saidaPct = pm.saida / a.deltaPct;
        const entBrutaPct = pm.entrada / a.deltaPct;
        const clPct = pm.cacheLido / a.deltaPct;
        const cgPct = pm.cacheGravado / a.deltaPct;
        let entPct = entBrutaPct;
        if (entBrutaPct < saidaPct || entBrutaPct < saidaPct * pesos.razaoSaidaEntrada * 0.5) {
          entPct = Math.max(
            Math.round(saidaPct * pesos.razaoSaidaEntrada + clPct * pesos.razaoCacheLido + cgPct * pesos.razaoCacheGravado),
            Math.round(saidaPct * pesos.razaoSaidaEntrada * 0.5),
          );
        }
        amostrasDoMod.push({
          deltaPct: a.deltaPct,
          entradaPorPct: entPct,
          saidaPorPct: saidaPct,
          usdPorPct: pm.usd / a.deltaPct,
        });
      }
    }

    let entry;
    if (amostrasDoMod.length >= 1) {
      const ent = Math.round(mediana(amostrasDoMod.map((x) => x.entradaPorPct)));
      const sai = Math.round(mediana(amostrasDoMod.map((x) => x.saidaPorPct)));
      const usdPct = mediana(amostrasDoMod.map((x) => x.usdPorPct));
      entry = {
        modelo: mod,
        disponivel: true,
        amostras: amostrasDoMod.length,
        entradaPorPct: ent,
        saidaPorPct: sai,
        usdPorPct: usdPct,
        texto: `1% ≈ ${fmtMil(ent)} tokens de entrada / ${fmtMil(sai)} de saída (${amostrasDoMod.length} ${amostrasDoMod.length === 1 ? 'amostra' : 'amostras'})`,
      };
    } else if (usdPorPctGeral > 0 && pesos.preco.entrada > 0 && pesos.preco.saida > 0) {
      const ent = Math.round((usdPorPctGeral * 1e6) / pesos.preco.entrada);
      const sai = Math.round((usdPorPctGeral * 1e6) / pesos.preco.saida);
      entry = {
        modelo: mod,
        disponivel: true,
        amostras: 0,
        entradaPorPct: ent,
        saidaPorPct: sai,
        usdPorPct: usdPorPctGeral,
        texto: `1% ≈ ${fmtMil(ent)} tokens de entrada / ${fmtMil(sai)} de saída (hipótese de preço)`,
      };
    } else {
      entry = { modelo: mod, disponivel: false, texto: 'dados insuficientes' };
    }

    porModelo[mod] = entry;
    submodelos.push(entry);
  }

  return { porModelo, submodelos };
}

// ---------------------------------------------------------------------------------------------
// 6. Função principal: estimarTokensPorCota
// ---------------------------------------------------------------------------------------------

export function estimarTokensPorCota(historico, tentativas, opcoes = {}) {
  const resultado = {};
  const hist = Array.isArray(historico) ? historico : [];
  const tents = Array.isArray(tentativas) ? tentativas : [];

  const tabela = opcoes.tabelaPrecos || carregarPrecos();

  if (hist.length < 2) {
    for (const chave of Object.keys(CONFIG_CHAVES)) {
      resultado[chave] = {
        disponivel: false,
        amostras: 0,
        descartadosExterno: 0,
        entradaPorPct: null,
        saidaPorPct: null,
        cachePorPct: null,
        usdPorPct: null,
        entradaEquivalentePorPct: null,
        saidaEquivalentePorPct: null,
        proporcaoSaidaEntrada: null,
        faixaEntrada: null,
        faixaSaida: null,
        confianca: null,
        texto: 'dados insuficientes',
        porModelo: {},
        submodelos: [],
        trabalhosAnalisados: 0,
        paralelosDetectados: 0,
      };
    }
    return resultado;
  }

  const temposHist = hist.map((q) => Date.parse(q.time)).filter(Number.isFinite);
  const minHist = temposHist.length ? Math.min(...temposHist) : Date.now() - 7 * 86400e3;

  // Consumo local da máquina (a menos que explicitamente desativado ou testes puros)
  let eventosLocais = [];
  if (opcoes.tentativasApenas !== true) {
    try {
      eventosLocais = coletarConsumoLocal({ ...opcoes, inicioMs: minHist - 60000 });
    } catch {}
  }

  // Prepara lista consolidada de eventos
  // Se houver eventos locais para um grupo cobrindo as janelas, eles têm prioridade
  // Se não houver, ou como complemento, usa as tentativas
  function obterEventosDoGrupo(grupo) {
    const loc = eventosLocais.filter((e) => e.grupo === grupo);
    const ten = tents.filter((e) => e.grupo === grupo);
    if (!loc.length) return ten;
    if (!ten.length) return loc;
    // Une sem duplicar: tentativas que caem fora dos logs locais ou que trazem tarefas específicas
    const temposLoc = loc.map((l) => l.timestampMs).filter(Number.isFinite);
    const minLoc = temposLoc.length ? Math.min(...temposLoc) : Infinity;
    const maxLoc = temposLoc.length ? Math.max(...temposLoc) : -Infinity;

    const extras = ten.filter((t) => {
      const ini = t.inicioMs || t.fimMs;
      return !ini || ini < minLoc - 60000 || ini > maxLoc + 60000;
    });
    return [...loc, ...extras];
  }

  for (const [chave, cfg] of Object.entries(CONFIG_CHAVES)) {
    const { prop, grupo, janela, duracaoMaxMs } = cfg;
    const eventosGrupo = obterEventosDoGrupo(grupo);

    // a) Filtra pontos de leitura real
    const pontos = [];
    for (const q of hist) {
      if (!q || typeof q !== 'object') continue;
      const g = q[prop];
      if (!g || g.read !== true) continue;
      const tMs = Date.parse(g.readAt || q.time);
      if (!Number.isFinite(tMs)) continue;

      let restante = null;
      if (janela === 'fiveHour') {
        if (typeof g.fiveHourRemaining === 'number' && Number.isFinite(g.fiveHourRemaining)) restante = g.fiveHourRemaining;
        else if (typeof g.fiveHour === 'number' && Number.isFinite(g.fiveHour)) restante = 1 - g.fiveHour;
      } else {
        if (typeof g.sevenDayRemaining === 'number' && Number.isFinite(g.sevenDayRemaining)) restante = g.sevenDayRemaining;
        else if (typeof g.sevenDay === 'number' && Number.isFinite(g.sevenDay)) restante = 1 - g.sevenDay;
      }
      if (restante === null || !Number.isFinite(restante)) continue;
      restante = Math.max(0, Math.min(1, restante));

      const renovaStr = janela === 'fiveHour' ? g.fiveHourResets : g.sevenDayResets;
      const renovaMs = renovaStr ? Date.parse(renovaStr) : NaN;

      pontos.push({ tMs, restante, renovaMs });
    }

    pontos.sort((a, b) => a.tMs - b.tMs);
    const pontosUnicos = [];
    for (const p of pontos) {
      if (!pontosUnicos.length || pontosUnicos[pontosUnicos.length - 1].tMs !== p.tMs) {
        pontosUnicos.push(p);
      }
    }

    // b) Examina pares consecutivos (A, B)
    let descartadosExterno = 0;
    let amostras = [];

    for (let i = 0; i < pontosUnicos.length - 1; i++) {
      const A = pontosUnicos[i];
      const B = pontosUnicos[i + 1];
      if (B.tMs <= A.tMs) continue;

      // Descarta se B.tMs - A.tMs > duracaoMaxMs
      if (B.tMs - A.tMs > duracaoMaxMs) continue;

      // Descarta se houve renovação no meio
      if (B.restante > A.restante + 0.002) continue;
      if (Number.isFinite(A.renovaMs) && B.tMs >= A.renovaMs - 60000) continue;
      if (Number.isFinite(A.renovaMs) && Number.isFinite(B.renovaMs) && Math.abs(B.renovaMs - A.renovaMs) > 15 * 60000) continue;

      const deltaPct = (A.restante - B.restante) * 100;
      if (deltaPct < (opcoes.minDeltaPct ?? 1)) continue;

      // Soma tokens no intervalo [A.tMs, B.tMs]
      let entrada = 0, saida = 0, cacheLido = 0, cacheGravado = 0, usdAmostra = 0;
      const porModelo = {};

      for (const ev of eventosGrupo) {
        let frac = 0;
        if (Number.isFinite(ev.inicioMs) && Number.isFinite(ev.fimMs) && ev.fimMs > ev.inicioMs) {
          const interIni = Math.max(ev.inicioMs, A.tMs);
          const interFim = Math.min(ev.fimMs, B.tMs);
          const overlap = Math.max(0, interFim - interIni);
          frac = overlap / (ev.fimMs - ev.inicioMs);
        } else {
          const t = Number.isFinite(ev.fimMs) ? ev.fimMs : Number.isFinite(ev.inicioMs) ? ev.inicioMs : ev.timestampMs;
          frac = (Number.isFinite(t) && t >= A.tMs && t <= B.tMs) ? 1 : 0;
        }

        if (frac <= 0) continue;
        const e = (ev.entrada || 0) * frac;
        const s = (ev.saida || 0) * frac;
        const cl = (ev.cacheLido || 0) * frac;
        const cg = (ev.cacheGravado || 0) * frac;
        const { usdEq } = calcularConsumoEquivalente(ev, tabela, grupo, opcoes);
        const usd = usdEq * frac;

        entrada += e;
        saida += s;
        cacheLido += cl;
        cacheGravado += cg;
        usdAmostra += usd;

        const mNome = normalizarSubmodelo(ev.modelo || 'padrao', grupo);
        const mod = porModelo[mNome] || (porModelo[mNome] = { entrada: 0, saida: 0, cacheLido: 0, cacheGravado: 0, usd: 0 });
        mod.entrada += e;
        mod.saida += s;
        mod.cacheLido += cl;
        mod.cacheGravado += cg;
        mod.usd += usd;
      }

      // Descarta intervalo com uso externo suspeito
      const totalTokens = entrada + saida + cacheLido + cacheGravado;
      const minTokens = (opcoes.minTokensPorPct ?? 200) * deltaPct;
      if (deltaPct >= 1 && totalTokens < minTokens) {
        descartadosExterno++;
        continue;
      }

      // Peso da amostra (janelas zeradas ou completas)
      let peso = 1;
      const zerou = B.restante <= 0.02;
      const comecouAlta = A.restante >= 0.95;
      if (zerou && comecouAlta) peso = 3;
      else if (zerou || comecouAlta) peso = 2;

      const pesosRef = pesosDePrecoDoModelo(MODELO_REF_GRUPO[grupo] || 'padrao', {
        tabelaPrecos: tabela,
        grupo,
        razaoSaidaEntrada: opcoes.razaoSaidaEntrada,
      });
      const usdPorPctAmostra = usdAmostra / deltaPct;
      const entradaBrutaPorPct = entrada / deltaPct;
      const saidaBrutaPorPct = saida / deltaPct;
      const cacheLidoPorPct = cacheLido / deltaPct;
      const cacheGravadoPorPct = cacheGravado / deltaPct;

      let entradaPorPctAmostra = entradaBrutaPorPct;
      if (entradaBrutaPorPct < saidaBrutaPorPct || entradaBrutaPorPct < saidaBrutaPorPct * pesosRef.razaoSaidaEntrada * 0.5) {
        entradaPorPctAmostra = Math.max(
          Math.round(saidaBrutaPorPct * pesosRef.razaoSaidaEntrada + cacheLidoPorPct * pesosRef.razaoCacheLido + cacheGravadoPorPct * pesosRef.razaoCacheGravado),
          Math.round(saidaBrutaPorPct * pesosRef.razaoSaidaEntrada * 0.5),
        );
      }

      amostras.push({
        deltaPct,
        entrada,
        saida,
        cache: cacheLido + cacheGravado,
        usdAmostra,
        usdPorPct: usdPorPctAmostra,
        entradaPorPct: entradaPorPctAmostra,
        saidaPorPct: saidaBrutaPorPct,
        cachePorPct: (cacheLido + cacheGravado) / deltaPct,
        ativoPorPct: (entradaPorPctAmostra + saidaBrutaPorPct),
        peso,
        porModelo,
        A, B,
      });
    }

    const analiseTrabalhos = analisarTrabalhosComParalelos(pontosUnicos, eventosGrupo, tabela, {
      duracaoMaxMs,
      minDeltaPct: opcoes.minDeltaPct ?? 1,
      grupo,
      razaoSaidaEntrada: opcoes.razaoSaidaEntrada,
    });

    // c) Segunda filtragem de outliers se >= 3 amostras
    if (amostras.length >= 3) {
      const medAtivo = mediana(amostras.map((x) => x.ativoPorPct));
      const validas = [];
      for (const a of amostras) {
        if (a.ativoPorPct < 0.15 * medAtivo) {
          descartadosExterno++;
        } else {
          validas.push(a);
        }
      }
      amostras = validas;
    }

    // d) Sem amostras válidas
    if (amostras.length === 0) {
      resultado[chave] = {
        disponivel: false,
        amostras: 0,
        descartadosExterno,
        entradaPorPct: null,
        saidaPorPct: null,
        cachePorPct: null,
        usdPorPct: null,
        entradaEquivalentePorPct: null,
        saidaEquivalentePorPct: null,
        proporcaoSaidaEntrada: null,
        faixaEntrada: null,
        faixaSaida: null,
        confianca: null,
        texto: 'dados insuficientes',
        porModelo: {},
        submodelos: [],
        trabalhosAnalisados: analiseTrabalhos.trabalhosAnalisados,
        paralelosDetectados: analiseTrabalhos.paralelosDetectados,
      };
      continue;
    }

    // e) Agregação quando há amostras válidas
    const n = amostras.length;
    let entradaPorPct, saidaPorPct, cachePorPct, usdPorPct;

    if (n <= 2) {
      let somaPeso = 0, somaEnt = 0, somaSaida = 0, somaCache = 0, somaUsd = 0;
      for (const a of amostras) {
        const w = a.deltaPct * a.peso;
        somaPeso += w;
        somaEnt += a.entradaPorPct * w;
        somaSaida += a.saidaPorPct * w;
        somaCache += a.cache * a.peso;
        somaUsd += a.usdAmostra * a.peso;
      }
      entradaPorPct = Math.round(somaEnt / (somaPeso || 1));
      saidaPorPct = Math.round(somaSaida / (somaPeso || 1));
      cachePorPct = Math.round(somaCache / (somaPeso || 1));
      usdPorPct = somaUsd / (somaPeso || 1);
    } else {
      entradaPorPct = Math.round(mediana(amostras.map((x) => x.entradaPorPct)));
      saidaPorPct = Math.round(mediana(amostras.map((x) => x.saidaPorPct)));
      cachePorPct = Math.round(mediana(amostras.map((x) => x.cachePorPct)));
      usdPorPct = mediana(amostras.map((x) => x.usdPorPct));
    }

    const pesosGrupo = pesosDePrecoDoModelo(MODELO_REF_GRUPO[grupo] || 'padrao', {
      tabelaPrecos: tabela,
      grupo,
      razaoSaidaEntrada: opcoes.razaoSaidaEntrada,
    });
    const entradaEquivalentePorPct = usdPorPct > 0 ? Math.round((usdPorPct * 1e6) / pesosGrupo.preco.entrada) : entradaPorPct;
    const saidaEquivalentePorPct = usdPorPct > 0 ? Math.round((usdPorPct * 1e6) / pesosGrupo.preco.saida) : saidaPorPct;
    const proporcaoSaidaEntrada = pesosGrupo.razaoSaidaEntrada;

    const faixaEntrada = [
      Math.round(Math.min(...amostras.map((x) => x.entradaPorPct))),
      Math.round(Math.max(...amostras.map((x) => x.entradaPorPct))),
    ];
    const faixaSaida = [
      Math.round(Math.min(...amostras.map((x) => x.saidaPorPct))),
      Math.round(Math.max(...amostras.map((x) => x.saidaPorPct))),
    ];
    const confianca = n >= 5 ? 'alta' : (n >= 2 ? 'media' : 'baixa');
    const texto = '1% ≈ ' + fmtMil(entradaPorPct) + ' tokens de entrada / ' + fmtMil(saidaPorPct) + ' de saída'
      + (cachePorPct > 0 ? ' (+ ' + fmtMil(cachePorPct) + ' cache)' : '')
      + ' (' + n + (n === 1 ? ' amostra' : ' amostras') + ' · confiança ' + confianca + ')';

    const { porModelo, submodelos } = estimarPorModelo(amostras, grupo, { ...opcoes, tabelaPrecos: tabela });

    resultado[chave] = {
      disponivel: true,
      amostras: n,
      descartadosExterno,
      entradaPorPct,
      saidaPorPct,
      cachePorPct,
      usdPorPct,
      entradaEquivalentePorPct,
      saidaEquivalentePorPct,
      proporcaoSaidaEntrada,
      faixaEntrada,
      faixaSaida,
      confianca,
      texto,
      porModelo,
      submodelos,
      janelasCompletas: amostras.filter((x) => x.peso > 1).length,
      trabalhosAnalisados: analiseTrabalhos.trabalhosAnalisados,
      paralelosDetectados: analiseTrabalhos.paralelosDetectados,
    };
  }

  // Relação 5h -> semanal para grupos com as duas janelas
  for (const grp of ['claude', 'gemini', 'agy-claude-gpt']) {
    const ch5 = `${grp}-5h`;
    const chSem = `${grp}-semanal`;
    if (resultado[ch5]?.disponivel && resultado[chSem]?.disponivel) {
      const e5 = resultado[ch5].entradaPorPct;
      const eSem = resultado[chSem].entradaPorPct;
      if (e5 > 0 && eSem > 0) {
        resultado[chSem].relacao5h = {
          fatorSemanalPor5hCheia: Math.round((100 * e5) / eSem),
          textoRelacao: `100% de 5 h ≈ ${Math.round((100 * e5) / eSem)}% da cota semanal`,
        };
      }
    }
  }

  return resultado;
}
