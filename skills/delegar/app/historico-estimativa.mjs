// Histórico de estimativa e calibração de demanda de tarefas do Delegar.
// Módulo ESM puro sem efeitos colaterais.

import fs from 'node:fs';
import path from 'node:path';
import { grupoDoModelo } from './cotas.mjs';

export const CATEGORIAS_DEMANDA = Object.freeze(['leitura', 'geracao', 'codigo', 'integracao']);
export const HANDOFF_AT = 0.85;

export const ARQUIVO_RE = /[A-Za-z0-9_./\\-]+\.(?:mjs|js|ps1|py|html|css|md|json)\b/gi;

function normalizarTexto(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

const REGEX_CATEGORIAS = {
  leitura: /\b(auditar|revisar|revisao|conferir|diagnosticar|investigar|analisar\s+codigo)\b/g,
  geracao: /\b(gerar|licoes|questoes|analisar\s+lotes|traduzir|redigir|escrever\s+texto)\b/g,
  codigo: /\b(implementar|corrigir|refatorar|testes?|funcao|funcoes|bugs?)\b/g,
  integracao: /\b(deploy|commit\s+e\s+push|publicar)\b/g,
};

// ---------------------------------------------------------------------------------------------
// 1. categoriaDemanda
// ---------------------------------------------------------------------------------------------
export function categoriaDemanda(tarefa) {
  if (!tarefa || typeof tarefa !== 'object') return 'codigo';
  if (CATEGORIAS_DEMANDA.includes(tarefa.demanda)) return tarefa.demanda;
  if (tarefa.tipo === 'integrador') return 'integracao';

  const texto = normalizarTexto(`${tarefa.titulo || ''} ${tarefa.prompt || ''}`);
  let maxCount = 0;
  let melhorCat = null;
  let empate = false;

  for (const cat of CATEGORIAS_DEMANDA) {
    const re = REGEX_CATEGORIAS[cat];
    const matches = texto.match(re);
    const count = matches ? matches.length : 0;
    if (count > maxCount) {
      maxCount = count;
      melhorCat = cat;
      empate = false;
    } else if (count > 0 && count === maxCount) {
      empate = true;
    }
  }

  if (maxCount > 0 && !empate) {
    return melhorCat;
  }

  // Em empate ou nada encontrado:
  // codigo para tipo tarefa, geracao para escritor de nível volume ou leve, codigo nos demais
  const tipo = tarefa.tipo || 'tarefa';
  const nivel = tarefa.nivel || 'volume';
  if (tipo === 'tarefa') return 'codigo';
  if (tipo === 'escritor' && (nivel === 'volume' || nivel === 'leve')) return 'geracao';
  return 'codigo';
}

export function fatorEsforcoDe(esforco) {
  if (esforco === 'low') return 0.7;
  if (esforco === 'high') return 1.45;
  if (esforco === 'xhigh' || esforco === 'max') return 1.7;
  return 1.0;
}

export function modeloSemEsforco(entry) {
  if (typeof entry !== 'string') return '';
  return entry.replace(/@[A-Za-z]+$/, '');
}

function mediana(arr) {
  if (!arr || !arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 !== 0 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function percentil(arr, p) {
  if (!arr || !arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const idx = (s.length - 1) * p;
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return s[lower];
  return Math.round(s[lower] + (s[upper] - s[lower]) * (idx - lower));
}

function lerJsonSeguro(arquivo) {
  try {
    return JSON.parse(fs.readFileSync(arquivo, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// 4. Baseline recalibrado
// Calibração realizada em 18/11/2026 com base em 146 tarefas coletadas em %USERPROFILE%/.delegar/projects
// Amostras com tokens por categoria: leitura (8 amostras), geracao (42 amostras), codigo (29 amostras), integracao (25 amostras).
// Amostras com duração: leitura (8), geracao (53), codigo (51), integracao (32).
// Todas as categorias possuem amostras reais coletadas.
// ---------------------------------------------------------------------------------------------
export const BASELINE_POR_CATEGORIA = Object.freeze({
  leitura: Object.freeze({
    amostras: 8,
    entrada: 17530,
    saida: 17160,
    cacheLido: 935986,
    cacheGravado: 21474,
    duracaoSeg: 262,
    faixa: Object.freeze({
      entrada: [26, 113744],
      saida: [10544, 32128],
      cacheLido: [590851, 1313157],
      cacheGravado: [0, 70687],
      duracaoSeg: [89, 299],
    }),
  }),
  geracao: Object.freeze({
    amostras: 42,
    entrada: 287650,
    saida: 56297,
    cacheLido: 5332418,
    cacheGravado: 0,
    duracaoSeg: 667,
    faixa: Object.freeze({
      entrada: [159471, 378178],
      saida: [44425, 78628],
      cacheLido: [1865835, 10007703],
      cacheGravado: [0, 0],
      duracaoSeg: [373, 1239],
    }),
  }),
  codigo: Object.freeze({
    amostras: 29,
    entrada: 118707,
    saida: 29095,
    cacheLido: 1716305,
    cacheGravado: 0,
    duracaoSeg: 284,
    faixa: Object.freeze({
      entrada: [32, 199522],
      saida: [6860, 46419],
      cacheLido: [305155, 2705152],
      cacheGravado: [0, 31707],
      duracaoSeg: [121, 479],
    }),
  }),
  integracao: Object.freeze({
    amostras: 25,
    entrada: 110,
    saida: 20494,
    cacheLido: 2559715,
    cacheGravado: 33910,
    duracaoSeg: 446,
    faixa: Object.freeze({
      entrada: [48, 242201],
      saida: [8125, 41496],
      cacheLido: [816239, 6384139],
      cacheGravado: [0, 48994],
      duracaoSeg: [183, 695],
    }),
  }),
});

// ---------------------------------------------------------------------------------------------
// 2. montarHistoricoTarefas
// ---------------------------------------------------------------------------------------------
export function montarHistoricoTarefas(projetos, { dataDir, projDirDe } = {}) {
  const lista = [];
  if (!Array.isArray(projetos)) return lista;

  const resolverProjDir = typeof projDirDe === 'function'
    ? projDirDe
    : (p) => path.join(dataDir || process.env.DELEGAR_DATA || '', 'projects', p.id);

  for (const p of projetos) {
    if (!p || typeof p !== 'object' || !p.id) continue;
    const projDir = resolverProjDir(p);

    const processarLoteTarefas = (tarefas, baseLogsDir) => {
      if (!Array.isArray(tarefas)) return;
      for (const t of tarefas) {
        if (!t || t.id == null) continue;
        const resPath = path.join(baseLogsDir, String(t.id), 'result.json');
        if (!fs.existsSync(resPath)) continue;

        const res = lerJsonSeguro(resPath);
        if (!res || typeof res !== 'object') continue;

        let entrada = Number(res.uso?.entrada) || 0;
        let saida = Number(res.uso?.saida) || 0;
        let cacheLido = Number(res.uso?.cacheLido) || 0;
        let cacheGravado = Number(res.uso?.cacheGravado) || 0;

        const attempts = Array.isArray(res.attempts) ? res.attempts : [];
        if (entrada === 0 && saida === 0 && attempts.length > 0) {
          for (const a of attempts) {
            if (!a || typeof a !== 'object') continue;
            entrada += Number(a.uso?.entrada) || Number(a.entrada) || 0;
            saida += Number(a.uso?.saida) || Number(a.saida) || 0;
            cacheLido += Number(a.uso?.cacheLido) || Number(a.cacheLido) || 0;
            cacheGravado += Number(a.uso?.cacheGravado) || Number(a.cacheGravado) || 0;
          }
        }

        let duracaoSeg = 0;
        let temHorarios = false;
        if (attempts.length > 0) {
          for (const a of attempts) {
            if (a && a.started && a.finished) {
              const ini = Date.parse(a.started);
              const fim = Date.parse(a.finished);
              if (Number.isFinite(ini) && Number.isFinite(fim) && fim >= ini) {
                duracaoSeg += (fim - ini) / 1000;
                temHorarios = true;
              }
            }
          }
        }

        if (!temHorarios) {
          const ini = Date.parse(res.started || res.inicio || t.started || '');
          const fim = Date.parse(res.finished || res.fim || t.finished || '');
          if (Number.isFinite(ini) && Number.isFinite(fim) && fim >= ini) {
            duracaoSeg = (fim - ini) / 1000;
          }
        }
        duracaoSeg = Math.max(0, Math.round(duracaoSeg));

        // Escolha da tentativa de sucesso ou última
        const tentSucesso = attempts.slice().reverse().find(
          (a) => a && (a.ok === true || a.failed === false || a.code === 0)
        );
        const tentEscolhida = tentSucesso || attempts[attempts.length - 1] || res;

        const modeloBruto = String(
          tentEscolhida?.worker || tentEscolhida?.modelo || tentEscolhida?.model || res.model || ''
        );

        let esforco = t.esforco || 'medium';
        if (modeloBruto.includes('@')) {
          const suf = modeloBruto.split('@')[1].trim();
          if (suf) esforco = suf;
        }

        const promptTxt = String(t.prompt || '');
        const semTokens = entrada === 0 && saida === 0;

        lista.push({
          projeto: String(p.id),
          tarefa: String(t.id),
          tipo: t.tipo || 'tarefa',
          nivel: t.nivel || 'volume',
          esforco,
          modelo: modeloBruto,
          familia: grupoDoModelo(modeloBruto),
          demanda: categoriaDemanda(t),
          charsPrompt: promptTxt.length,
          arquivosCitados: (promptTxt.match(ARQUIVO_RE) || []).length,
          entrada: semTokens ? 0 : entrada,
          saida: semTokens ? 0 : saida,
          cacheLido: semTokens ? 0 : cacheLido,
          cacheGravado: semTokens ? 0 : cacheGravado,
          duracaoSeg,
          ...(semTokens ? { semTokens: true } : {}),
        });
      }
    };

    // 1) Tarefas atuais do projeto
    processarLoteTarefas(p.plano?.tarefas, path.join(projDir, 'logs'));

    // 2) Rodadas arquivadas em p.rodadas
    const rodadasArr = Array.isArray(p.rodadas) ? p.rodadas : [];
    for (const r of rodadasArr) {
      if (!r || typeof r !== 'object') continue;
      const relLog = r.logDir || `logs/rodada-${r.numero}`;
      const absLog = path.isAbsolute(relLog) ? relLog : path.resolve(projDir, relLog);
      let rTarefas = Array.isArray(r.plano?.tarefas) ? r.plano.tarefas : [];
      if (!rTarefas.length) {
        const pj = lerJsonSeguro(path.join(absLog, 'plan.json'));
        if (Array.isArray(pj?.tasks)) rTarefas = pj.tasks;
        else if (Array.isArray(pj?.tarefas)) rTarefas = pj.tarefas;
      }
      processarLoteTarefas(rTarefas, absLog);
    }

    // 3) Rodadas arquivadas na pasta legada rodadas/<N>
    const pastaRodadas = path.join(projDir, 'rodadas');
    if (fs.existsSync(pastaRodadas)) {
      try {
        const dirs = fs.readdirSync(pastaRodadas, { withFileTypes: true })
          .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
          .sort((a, b) => Number(a.name) - Number(b.name));
        for (const d of dirs) {
          const num = Number(d.name);
          // Se já foi processada via p.rodadas, evita duplicação
          if (rodadasArr.some((r) => r && r.numero === num)) continue;
          const rDir = path.join(pastaRodadas, d.name);
          const rProj = lerJsonSeguro(path.join(rDir, 'project.json'));
          const rPlan = lerJsonSeguro(path.join(rDir, 'plan.json'));
          const rTarefas = Array.isArray(rProj?.plano?.tarefas)
            ? rProj.plano.tarefas
            : Array.isArray(rPlan?.tasks)
            ? rPlan.tasks
            : [];
          processarLoteTarefas(rTarefas, path.join(rDir, 'logs'));
        }
      } catch {}
    }
  }

  return lista;
}

export function cacheHistorico(fn, ttlMs = 60000) {
  let cache = new Map();
  return function memoizada(...args) {
    const agora = Date.now();
    let chave = '__empty__';
    try {
      chave = JSON.stringify(args);
    } catch {
      chave = String(args[0] || '__unserializable__');
    }
    const hit = cache.get(chave);
    if (hit && agora - hit.timestamp < ttlMs) {
      return hit.valor;
    }
    const valor = fn(...args);
    cache.set(chave, { timestamp: agora, valor });
    return valor;
  };
}

// ---------------------------------------------------------------------------------------------
// 3. estimarTarefaPorHistorico
// ---------------------------------------------------------------------------------------------
export function estimarTarefaPorHistorico(tarefa, { historico = [], modelo = null, esforco = null } = {}) {
  const cat = categoriaDemanda(tarefa);
  const modAlvo = modelo || tarefa?.modelo || (Array.isArray(tarefa?.cadeia) ? tarefa.cadeia[0] : null) || '';
  const modAlvoSemEsforco = modeloSemEsforco(modAlvo);
  const famAlvo = grupoDoModelo(modAlvo);
  const nivAlvo = tarefa?.nivel || 'volume';
  const esfAlvo = esforco || tarefa?.esforco || (modAlvo.includes('@') ? modAlvo.split('@')[1] : 'medium');
  const charsAlvo = String(tarefa?.prompt || '').length;

  const fatorEsforcoAlvo = fatorEsforcoDe(esfAlvo);

  // Amostras válidas com consumo de tokens
  const histComTokens = (Array.isArray(historico) ? historico : []).filter(
    (h) => h && !h.semTokens && (Number(h.entrada) > 0 || Number(h.saida) > 0)
  );

  let similares = [];
  let similaridade = 'baseline';

  // 1) categoria + modelo
  if (modAlvoSemEsforco) {
    const s1 = histComTokens.filter(
      (h) => h.demanda === cat && modeloSemEsforco(h.modelo) === modAlvoSemEsforco
    );
    if (s1.length >= 3) {
      similares = s1;
      similaridade = 'categoria+modelo';
    }
  }

  // 2) categoria + família
  if (similares.length < 3 && famAlvo) {
    const s2 = histComTokens.filter((h) => h.demanda === cat && h.familia === famAlvo);
    if (s2.length >= 3) {
      similares = s2;
      similaridade = 'categoria+familia';
    }
  }

  // 3) categoria
  if (similares.length < 3) {
    const s3 = histComTokens.filter((h) => h.demanda === cat);
    if (s3.length >= 3) {
      similares = s3;
      similaridade = 'categoria';
    }
  }

  // 4) nivel
  if (similares.length < 3) {
    const s4 = histComTokens.filter((h) => h.nivel === nivAlvo);
    if (s4.length >= 3) {
      similares = s4;
      similaridade = 'nivel';
    }
  }

  if (similares.length >= 3) {
    const medChars = mediana(similares.map((h) => h.charsPrompt));
    const razaoTamanho = charsAlvo > 0 && medChars > 0 ? charsAlvo / medChars : 1.0;
    const fatorTamanho = Math.min(2.5, Math.max(0.5, razaoTamanho));

    const medFatorEsforco = mediana(similares.map((h) => fatorEsforcoDe(h.esforco))) || 1.0;
    const razaoEsforco = fatorEsforcoAlvo / medFatorEsforco;
    const escala = fatorTamanho * razaoEsforco;

    // Amostras para duração (inclui registros com duração válida mesmo semTokens)
    // A duração depende muito do modelo (19/11/2026: NVIDIA grátis levou 12 a 72 min por tarefa, Claude e Gemini
    // poucos minutos). Por isso procura primeiro o mesmo modelo, depois a família, e só então categoria ou nível.
    const comDur = (Array.isArray(historico) ? historico : []).filter((h) => h && h.duracaoSeg > 0);
    const mesmoModelo = (h) => modAlvoSemEsforco && modeloSemEsforco(h.modelo) === modAlvoSemEsforco;
    let durSimilares = [];
    for (const filtro of [
      (h) => mesmoModelo(h) && h.demanda === cat,
      mesmoModelo,
      (h) => famAlvo && h.familia === famAlvo && h.demanda === cat,
      (h) => famAlvo && h.familia === famAlvo,
      (h) => h.demanda === cat || h.nivel === nivAlvo,
    ]) {
      durSimilares = comDur.filter(filtro);
      if (durSimilares.length >= 3) break;
    }
    if (durSimilares.length < 3) {
      durSimilares = similares;
    }

    const calcMetrica = (arr, fn) => Math.round(fn(arr) * escala);

    const entrada = calcMetrica(similares.map((h) => h.entrada), mediana);
    const saida = calcMetrica(similares.map((h) => h.saida), mediana);
    const cacheLido = calcMetrica(similares.map((h) => h.cacheLido), mediana);
    const cacheGravado = calcMetrica(similares.map((h) => h.cacheGravado), mediana);
    const duracaoSeg = calcMetrica(durSimilares.map((h) => h.duracaoSeg), mediana);

    return {
      entrada,
      saida,
      cacheLido,
      cacheGravado,
      duracaoSeg,
      faixa: {
        entrada: [
          calcMetrica(similares.map((h) => h.entrada), (a) => percentil(a, 0.25)),
          calcMetrica(similares.map((h) => h.entrada), (a) => percentil(a, 0.75)),
        ],
        saida: [
          calcMetrica(similares.map((h) => h.saida), (a) => percentil(a, 0.25)),
          calcMetrica(similares.map((h) => h.saida), (a) => percentil(a, 0.75)),
        ],
        cacheLido: [
          calcMetrica(similares.map((h) => h.cacheLido), (a) => percentil(a, 0.25)),
          calcMetrica(similares.map((h) => h.cacheLido), (a) => percentil(a, 0.75)),
        ],
        cacheGravado: [
          calcMetrica(similares.map((h) => h.cacheGravado), (a) => percentil(a, 0.25)),
          calcMetrica(similares.map((h) => h.cacheGravado), (a) => percentil(a, 0.75)),
        ],
        duracaoSeg: [
          calcMetrica(durSimilares.map((h) => h.duracaoSeg), (a) => percentil(a, 0.25)),
          calcMetrica(durSimilares.map((h) => h.duracaoSeg), (a) => percentil(a, 0.75)),
        ],
      },
      amostras: similares.length,
      similaridade,
      aproximado: similaridade !== 'categoria+modelo',
      fonte: 'historico',
    };
  }

  // Baseline
  const base = BASELINE_POR_CATEGORIA[cat] || BASELINE_POR_CATEGORIA.codigo;
  const escalaBase = fatorEsforcoAlvo;

  const esc = (v) => Math.round((Number(v) || 0) * escalaBase);

  return {
    entrada: esc(base.entrada),
    saida: esc(base.saida),
    cacheLido: esc(base.cacheLido),
    cacheGravado: esc(base.cacheGravado),
    duracaoSeg: esc(base.duracaoSeg),
    faixa: {
      entrada: [esc(base.faixa.entrada[0]), esc(base.faixa.entrada[1])],
      saida: [esc(base.faixa.saida[0]), esc(base.faixa.saida[1])],
      cacheLido: [esc(base.faixa.cacheLido[0]), esc(base.faixa.cacheLido[1])],
      cacheGravado: [esc(base.faixa.cacheGravado[0]), esc(base.faixa.cacheGravado[1])],
      duracaoSeg: [esc(base.faixa.duracaoSeg[0]), esc(base.faixa.duracaoSeg[1])],
    },
    amostras: 0,
    similaridade: 'baseline',
    aproximado: true,
    fonte: 'baseline',
  };
}

// ---------------------------------------------------------------------------------------------
// 5. semCota
// ---------------------------------------------------------------------------------------------
// Leitura de cota cuja janela já renovou não vale mais (19/11/2026: o Claude lido em 108% antes da renovação das
// 13:20 fez a estimativa supor o NVIDIA grátis num plano que rodou no Haiku e no Sonnet).
function janelaRenovada(resets, agora) {
  if (!resets) return false;
  const t = new Date(resets).getTime();
  return Number.isFinite(t) && t <= agora.getTime();
}

export function semCota(kind, modelo, dadosCotas, agoraMs = Date.now(), ultimosEstouros = null) {
  if (kind === 'opencode') return null;

  const agora = typeof agoraMs === 'number' && Number.isFinite(agoraMs) ? new Date(agoraMs) : new Date();
  const q = dadosCotas && typeof dadosCotas === 'object' ? dadosCotas : null;

  if (kind === 'claude') {
    const c = q?.claude || null;
    const hitRaw = ultimosEstouros && typeof ultimosEstouros === 'object'
      ? (ultimosEstouros.claude ?? null)
      : null;
    const hit = hitRaw ? new Date(hitRaw) : null;
    const hitValido = hit && !Number.isNaN(hit.getTime());

    if (c && c.read) {
      const fiveHour = janelaRenovada(c.fiveHourResets, agora) ? 0 : (Number(c.fiveHour) || 0);
      if (fiveHour >= HANDOFF_AT) {
        const renova = c.fiveHourResets ? ` (renova ${c.fiveHourResets})` : '';
        return `cota do Claude em ${Math.round(fiveHour * 100)}% na janela de 5 h${renova}`;
      }
      const sevenDay = janelaRenovada(c.sevenDayResets, agora) ? 0 : (Number(c.sevenDay) || 0);
      if (sevenDay >= 0.95) {
        return `cota semanal do Claude em ${Math.round(sevenDay * 100)}%`;
      }
      if (hitValido && c.fiveHourResets) {
        const resets = new Date(c.fiveHourResets);
        if (resets > agora && hit > new Date(resets.getTime() - 5 * 3600000)) {
          if (c.readAt && hit > new Date(c.readAt)) {
            const hh = String(hit.getHours()).padStart(2, '0');
            const mm = String(hit.getMinutes()).padStart(2, '0');
            return `Claude estourou a cota as ${hh}:${mm}`;
          }
        }
      }
      return null;
    }

    if (hitValido && (agora - hit) / 60000 < 60) {
      const hh = String(hit.getHours()).padStart(2, '0');
      const mm = String(hit.getMinutes()).padStart(2, '0');
      return `Claude estourou a cota as ${hh}:${mm} (sem leitura nova)`;
    }
    return null;
  }

  if (kind === 'agy') {
    const mSemProv = String(modelo || '').toLowerCase().replace(/^agy:/, '');
    let grp = 'gemini';
    if (mSemProv.includes('argon')) grp = 'argon';
    else if (/^(claude|gpt)/i.test(mSemProv) || mSemProv.includes('claude') || mSemProv.includes('gpt')) {
      grp = 'agyClaudeGpt';
    }

    const g = q ? q[grp] : null;
    const hitRaw = ultimosEstouros && typeof ultimosEstouros === 'object'
      ? (ultimosEstouros[`agy:${grp}`] ?? ultimosEstouros[grp] ?? ultimosEstouros.agy ?? null)
      : null;
    const hit = hitRaw ? new Date(hitRaw) : null;
    const hitValido = hit && !Number.isNaN(hit.getTime());

    const hasReading = Boolean(
      g && (g.read || g.exhausted || g.fiveHourRemaining != null || g.sevenDayRemaining != null)
    );

    if (hasReading) {
      const renov5 = janelaRenovada(g.fiveHourResets, agora);
      const renov7 = janelaRenovada(g.sevenDayResets, agora);
      if (g.exhausted && !renov5 && !renov7) {
        return `cota de ${grp} no Antigravity esgotada`;
      }
      const r5 = g.fiveHourRemaining != null && !renov5 ? Number(g.fiveHourRemaining) : 1;
      const r7 = g.sevenDayRemaining != null && !renov7 ? Number(g.sevenDayRemaining) : 1;
      if (r5 <= 0.03) {
        return `cota de ${grp} no Antigravity com ${Math.round(r5 * 100)}% restante na janela de 5 h`;
      }
      if (r7 <= 0.03) {
        return `cota semanal de ${grp} no Antigravity com ${Math.round(r7 * 100)}% restante`;
      }
      if (hitValido && g.fiveHourResets) {
        const resets = new Date(g.fiveHourResets);
        if (resets > agora && hit > new Date(resets.getTime() - 5 * 3600000)) {
          if (!g.readAt || hit > new Date(g.readAt)) {
            const hh = String(hit.getHours()).padStart(2, '0');
            const mm = String(hit.getMinutes()).padStart(2, '0');
            return `Antigravity (${grp}) estourou a cota as ${hh}:${mm}`;
          }
        }
      }
      if (hitValido && (agora - hit) / 60000 < 60 && (!g.readAt || hit > new Date(g.readAt))) {
        const hh = String(hit.getHours()).padStart(2, '0');
        const mm = String(hit.getMinutes()).padStart(2, '0');
        return `Antigravity (${grp}) estourou a cota as ${hh}:${mm}`;
      }
      return null;
    }

    if (hitValido && (agora - hit) / 60000 < 60) {
      const hh = String(hit.getHours()).padStart(2, '0');
      const mm = String(hit.getMinutes()).padStart(2, '0');
      return `Antigravity (${grp}) estourou a cota as ${hh}:${mm}`;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------------------------
// 6. modeloProvavel
// ---------------------------------------------------------------------------------------------
export function modeloProvavel(cadeia, { dadosCotas, agoraMs = Date.now(), ultimosEstouros = null } = {}) {
  const pulados = [];
  if (!Array.isArray(cadeia) || cadeia.length === 0) {
    return { modelo: null, esforco: 'medium', pulados };
  }

  const decompor = (entry) => {
    const raw = String(entry || '').trim();
    const idx = raw.indexOf(':');
    const prov = idx > 0 ? raw.slice(0, idx) : 'desconhecido';
    const resto = idx > 0 ? raw.slice(idx + 1) : raw;
    const [model, effort] = resto.split('@');
    return {
      prov,
      model,
      effort: effort || 'medium',
      modeloBase: idx > 0 ? `${prov}:${model}` : model,
      entry: raw,
    };
  };

  for (const entry of cadeia) {
    const d = decompor(entry);
    const motivo = semCota(d.prov, d.model, dadosCotas, agoraMs, ultimosEstouros);
    if (motivo) {
      pulados.push({ modelo: d.entry, motivo });
    } else {
      return {
        modelo: d.modeloBase,
        esforco: d.effort,
        pulados,
      };
    }
  }

  const ult = decompor(cadeia[cadeia.length - 1]);
  return {
    modelo: ult.modeloBase,
    esforco: ult.effort,
    pulados,
  };
}

// ---------------------------------------------------------------------------------------------
// 7. simularTempoPlano
// ---------------------------------------------------------------------------------------------
export function simularTempoPlano(tarefas, { duracaoSeg = {}, paralelismo = 2, intervaloSeg = 60 } = {}) {
  const listaTarefas = Array.isArray(tarefas) ? tarefas : [];
  const maxSlots = Math.max(1, Number(paralelismo) || 1);
  const interMin = Math.max(0, Number(intervaloSeg) || 0);

  // Mapeia duração para valor escalar e faixa [min, max]
  const durMapa = {};
  const faixaMapa = {};
  for (const t of listaTarefas) {
    if (!t || t.id == null) continue;
    const tid = String(t.id);
    const val = duracaoSeg?.[tid] ?? duracaoSeg?.[t.id] ?? 0;
    if (Array.isArray(val) && val.length === 2) {
      durMapa[tid] = Math.max(0, Math.round(((Number(val[0]) || 0) + (Number(val[1]) || 0)) / 2));
      faixaMapa[tid] = [Math.max(0, Number(val[0]) || 0), Math.max(0, Number(val[1]) || 0)];
    } else {
      const n = Math.max(0, Number(val) || 0);
      durMapa[tid] = n;
      faixaMapa[tid] = [n, n];
    }
  }

  const simularInstancia = (duracaoFn) => {
    const idsValidos = new Set(listaTarefas.map((t) => String(t.id)));
    const dependencias = new Map();
    for (const t of listaTarefas) {
      const tid = String(t.id);
      const deps = (Array.isArray(t.depende) ? t.depende : [])
        .map(String)
        .filter((d) => idsValidos.has(d) && d !== tid);
      dependencias.set(tid, new Set(deps));
    }

    const concluidos = new Set();
    const emExecucao = new Map(); // tid -> terminoSeg
    const inicioSeg = {};
    const naoIniciados = new Set(idsValidos);

    let tempoAtual = 0;
    let ultimoDisparo = -Infinity;

    while (naoIniciados.size > 0 || emExecucao.size > 0) {
      // 1. Conclui tarefas prontas no tempo atual
      for (const [tid, termino] of [...emExecucao.entries()]) {
        if (termino <= tempoAtual) {
          concluidos.add(tid);
          emExecucao.delete(tid);
        }
      }

      // 2. Dispara tarefas aptas
      let disparou = false;
      for (const tid of [...naoIniciados]) {
        if (emExecucao.size >= maxSlots) break;

        const deps = dependencias.get(tid);
        const depsOk = [...deps].every((d) => concluidos.has(d));
        if (depsOk) {
          const tempoApto = Math.max(tempoAtual, ultimoDisparo + interMin);
          if (tempoApto === tempoAtual) {
            naoIniciados.delete(tid);
            inicioSeg[tid] = tempoAtual;
            const dur = Math.max(0, Number(duracaoFn(tid)) || 0);
            emExecucao.set(tid, tempoAtual + dur);
            ultimoDisparo = tempoAtual;
            disparou = true;
          }
        }
      }

      if (naoIniciados.size === 0 && emExecucao.size === 0) break;

      // 3. Avança o tempo para o próximo evento relevante
      const proximosTempos = [];
      for (const termino of emExecucao.values()) {
        if (termino > tempoAtual) proximosTempos.push(termino);
      }
      if (naoIniciados.size > 0 && emExecucao.size < maxSlots) {
        const proxDisparo = ultimoDisparo + interMin;
        if (proxDisparo > tempoAtual) proximosTempos.push(proxDisparo);
      }

      // Quebra ciclos/deadlocks caso não haja eventos futuros
      if (proximosTempos.length === 0) {
        if (naoIniciados.size > 0) {
          // Remove dependências não resolvidas para destravar
          for (const tid of naoIniciados) {
            dependencias.set(tid, new Set());
          }
          continue;
        }
        break;
      }

      tempoAtual = Math.min(...proximosTempos);
    }

    return { totalSeg: tempoAtual, inicioSeg };
  };

  const simPrincipal = simularInstancia((tid) => durMapa[tid]);
  const simMin = simularInstancia((tid) => faixaMapa[tid][0]);
  const simMax = simularInstancia((tid) => faixaMapa[tid][1]);

  return {
    totalSeg: simPrincipal.totalSeg,
    faixaSeg: [simMin.totalSeg, simMax.totalSeg],
    inicioSeg: simPrincipal.inicioSeg,
  };
}

// ---------------------------------------------------------------------------------------------
// 8. formatarDuracao e linhaEstimativa
// ---------------------------------------------------------------------------------------------
export function formatarDuracao(seg, { semTilde = false } = {}) {
  const s = Math.max(0, Math.round(Number(seg) || 0));
  if (s < 60) {
    return `${s} s`;
  }
  const minTotais = Math.round(s / 60);
  if (minTotais < 60) {
    return `${minTotais} min`;
  }
  const h = Math.floor(minTotais / 60);
  const m = minTotais % 60;
  const texto = m > 0 ? `${h} h ${m} min` : `${h} h`;
  return semTilde ? texto : `~${texto}`;
}

export function linhaEstimativa(resumo) {
  if (!resumo || typeof resumo !== 'object') return '';

  const totalSeg = Number(resumo.tempo?.totalSeg) || 0;
  const faixaSeg = Array.isArray(resumo.tempo?.faixaSeg) ? resumo.tempo.faixaSeg : null;

  let tempoStr = formatarDuracao(totalSeg);
  if (!tempoStr.startsWith('~')) tempoStr = `~${tempoStr}`;

  if (faixaSeg && faixaSeg.length === 2 && (faixaSeg[0] !== totalSeg || faixaSeg[1] !== totalSeg)) {
    const minStr = formatarDuracao(faixaSeg[0], { semTilde: true });
    const maxStr = formatarDuracao(faixaSeg[1], { semTilde: true });
    tempoStr += ` (entre ${minStr} e ${maxStr})`;
  }

  // Tokens de entrada formatados com vírgula pt-BR
  const entrada = Number(resumo.total?.entrada) || 0;
  let tokensStr = '';
  if (entrada >= 1e6) {
    const mi = (entrada / 1e6).toFixed(1).replace(/\.0$/, '').replace('.', ',');
    tokensStr = `~${mi} mi tokens de entrada`;
  } else if (entrada >= 1e3) {
    const mil = Math.round(entrada / 1e3);
    tokensStr = `~${mil} mil tokens de entrada`;
  } else {
    tokensStr = `~${entrada} tokens de entrada`;
  }

  // Custo em USD formatado pt-BR
  const usd = Number(resumo.total?.usd) || 0;
  const usdStr = `~US$ ${usd.toFixed(2).replace('.', ',')}`;

  let texto = `Estimativa: ${tempoStr}, ${tokensStr}, ${usdStr}`;

  // Grupos de cota com pct5h > 0
  const gruposNomes = {
    gemini: 'Gemini',
    claude: 'Claude',
    argon: 'Gemini 4 Argon',
    'agy-claude-gpt': 'Claude e GPT (Antigravity)',
    opencode: 'opencode',
  };

  const partesGrupos = [];
  const porGrupo = resumo.porGrupo && typeof resumo.porGrupo === 'object' ? resumo.porGrupo : {};
  for (const [grp, info] of Object.entries(porGrupo)) {
    const pct = Number(info?.pct5hEstimado) || 0;
    if (pct > 0) {
      const nomeExibicao = gruposNomes[grp] || grp;
      const pctFormatado = String(pct).includes('.')
        ? pct.toFixed(1).replace(/\.0$/, '').replace('.', ',')
        : String(Math.round(pct));
      partesGrupos.push(`${nomeExibicao} ~${pctFormatado}% da janela de 5 h`);
    }
  }

  if (partesGrupos.length > 0) {
    texto += `; ${partesGrupos.join(', ')}`;
  }

  return texto;
}
