// Estimativa de tokens por 1% de cota a partir do histórico de leituras (state/quota-historico.jsonl)
// e dos logs locais de consumo (Claude Code, Antigravity brain e tentativas do Delegar).
// Puro e testável.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { grupoDoModelo } from './cotas.mjs';
import { carregarPrecos, precoDe } from './precos.mjs';

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
// 5. Estimativa por modelo e regressão
// ---------------------------------------------------------------------------------------------

function estimarPorModelo(amostras, grupo, opcoes = {}) {
  const porModelo = {};
  if (!amostras || !amostras.length) return porModelo;

  const tabela = opcoes.tabelaPrecos || carregarPrecos();
  const modelosUsados = new Set();
  for (const a of amostras) {
    if (a.porModelo) {
      for (const m of Object.keys(a.porModelo)) modelosUsados.add(m);
    }
  }

  for (const mod of modelosUsados) {
    const amostrasDoMod = [];
    for (const a of amostras) {
      const pm = a.porModelo?.[mod];
      if (!pm) continue;
      const totMod = pm.entrada + pm.saida;
      const totAmostra = a.entrada + a.saida;
      if (totAmostra > 0 && totMod / totAmostra >= 0.7) {
        // Amostra dominante deste modelo
        amostrasDoMod.push({
          deltaPct: a.deltaPct,
          entradaPorPct: pm.entrada / a.deltaPct,
          saidaPorPct: pm.saida / a.deltaPct,
          cachePorPct: (pm.cacheLido + pm.cacheGravado) / a.deltaPct,
        });
      }
    }

    if (amostrasDoMod.length >= 1) {
      const ent = Math.round(mediana(amostrasDoMod.map((x) => x.entradaPorPct)));
      const sai = Math.round(mediana(amostrasDoMod.map((x) => x.saidaPorPct)));
      porModelo[mod] = {
        disponivel: true,
        amostras: amostrasDoMod.length,
        entradaPorPct: ent,
        saidaPorPct: sai,
        texto: `1% ≈ ${fmtMil(ent)} tokens de entrada / ${fmtMil(sai)} de saída (${amostrasDoMod.length} ${amostrasDoMod.length === 1 ? 'amostra' : 'amostras'})`,
      };
    } else {
      // Hipótese pelo preço de API
      const pMod = precoDe(tabela, mod.replace(/^[^:]+:/, ''));
      if (pMod && pMod.entrada > 0 && pMod.saida > 0) {
        // Mediana geral de entrada e saída
        const entGeral = mediana(amostras.map((x) => x.entradaPorPct));
        const saiGeral = mediana(amostras.map((x) => x.saidaPorPct));
        porModelo[mod] = {
          disponivel: true,
          amostras: amostras.length,
          entradaPorPct: Math.round(entGeral),
          saidaPorPct: Math.round(saiGeral),
          texto: `1% ≈ ${fmtMil(entGeral)} tokens de entrada / ${fmtMil(saiGeral)} de saída (hipótese de preço)`,
        };
      } else {
        porModelo[mod] = { disponivel: false, texto: 'dados insuficientes' };
      }
    }
  }

  return porModelo;
}

// ---------------------------------------------------------------------------------------------
// 6. Função principal: estimarTokensPorCota
// ---------------------------------------------------------------------------------------------

export function estimarTokensPorCota(historico, tentativas, opcoes = {}) {
  const resultado = {};
  const hist = Array.isArray(historico) ? historico : [];
  const tents = Array.isArray(tentativas) ? tentativas : [];

  if (hist.length < 2) {
    for (const chave of Object.keys(CONFIG_CHAVES)) {
      resultado[chave] = {
        disponivel: false,
        amostras: 0,
        descartadosExterno: 0,
        entradaPorPct: null,
        saidaPorPct: null,
        cachePorPct: null,
        faixaEntrada: null,
        faixaSaida: null,
        confianca: null,
        texto: 'dados insuficientes',
        porModelo: {},
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
      let entrada = 0, saida = 0, cacheLido = 0, cacheGravado = 0;
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

        entrada += e;
        saida += s;
        cacheLido += cl;
        cacheGravado += cg;

        const mNome = ev.modelo || 'padrao';
        const mod = porModelo[mNome] || (porModelo[mNome] = { entrada: 0, saida: 0, cacheLido: 0, cacheGravado: 0 });
        mod.entrada += e;
        mod.saida += s;
        mod.cacheLido += cl;
        mod.cacheGravado += cg;
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

      amostras.push({
        deltaPct,
        entrada,
        saida,
        cache: cacheLido + cacheGravado,
        entradaPorPct: entrada / deltaPct,
        saidaPorPct: saida / deltaPct,
        cachePorPct: (cacheLido + cacheGravado) / deltaPct,
        ativoPorPct: (entrada + saida) / deltaPct,
        peso,
        porModelo,
        A, B,
      });
    }

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
        faixaEntrada: null,
        faixaSaida: null,
        confianca: null,
        texto: 'dados insuficientes',
        porModelo: {},
      };
      continue;
    }

    // e) Agregação quando há amostras válidas
    const n = amostras.length;
    let entradaPorPct, saidaPorPct, cachePorPct;

    if (n <= 2) {
      let somaPeso = 0, somaEnt = 0, somaSaida = 0, somaCache = 0;
      for (const a of amostras) {
        const w = a.deltaPct * a.peso;
        somaPeso += w;
        somaEnt += a.entrada * a.peso;
        somaSaida += a.saida * a.peso;
        somaCache += a.cache * a.peso;
      }
      entradaPorPct = Math.round(somaEnt / (somaPeso || 1));
      saidaPorPct = Math.round(somaSaida / (somaPeso || 1));
      cachePorPct = Math.round(somaCache / (somaPeso || 1));
    } else {
      entradaPorPct = Math.round(mediana(amostras.map((x) => x.entradaPorPct)));
      saidaPorPct = Math.round(mediana(amostras.map((x) => x.saidaPorPct)));
      cachePorPct = Math.round(mediana(amostras.map((x) => x.cachePorPct)));
    }

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

    const porModelo = estimarPorModelo(amostras, grupo, opcoes);

    resultado[chave] = {
      disponivel: true,
      amostras: n,
      descartadosExterno,
      entradaPorPct,
      saidaPorPct,
      cachePorPct,
      faixaEntrada,
      faixaSaida,
      confianca,
      texto,
      porModelo,
      janelasCompletas: amostras.filter((x) => x.peso > 1).length,
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
