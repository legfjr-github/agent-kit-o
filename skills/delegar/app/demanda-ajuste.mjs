// Estimativa determinística de demanda de tokens/cota e política de ajuste de modelos
// conforme cota semanal restante e dias até o reset.
// Módulo ESM puro e determinístico.

import { grupoDoModelo } from './cotas.mjs';
import { carregarPrecos, custoUsd, emBrl } from './precos.mjs';
import {
  categoriaDemanda,
  modeloProvavel,
  estimarTarefaPorHistorico,
  simularTempoPlano,
  linhaEstimativa,
  montarHistoricoTarefas,
} from './historico-estimativa.mjs';

const GRUPOS_PAGOS = ['claude', 'gemini', 'argon', 'agy-claude-gpt'];
const TODOS_GRUPOS = [...GRUPOS_PAGOS, 'opencode'];
const ARQUIVO_RE = /[A-Za-z0-9_./\\-]+\.(?:mjs|js|ps1|py|html|css|md|json)\b/gi;

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

function estimarPctCota(grupo, modeloPrincipal, entrada, saida, custoUsdEst, estimativasCota) {
  if (!grupo || grupo === 'opencode') return { pct5h: 0, pctSemanal: 0 };

  const calcJanela = (chave, fallbackUsdPorPct) => {
    const est = estimativasCota?.[chave];
    if (est?.disponivel) {
      const sub = modeloPrincipal ? est.porModelo?.[modeloPrincipal] : null;
      const entPorPct = sub?.entradaPorPct > 0 ? sub.entradaPorPct : est.entradaPorPct;
      const saiPorPct = sub?.saidaPorPct > 0 ? sub.saidaPorPct : est.saidaPorPct;
      if (entPorPct > 0 && saiPorPct > 0) {
        return round2(((entrada / entPorPct) + (saida / saiPorPct)) / 2);
      }
      if (entPorPct > 0) return round2(entrada / entPorPct);
      if (saiPorPct > 0) return round2(saida / saiPorPct);
    }
    const usd = Number(custoUsdEst) || 0;
    if (usd > 0) return round2(usd / fallbackUsdPorPct);
    return round2((entrada + saida) / (fallbackUsdPorPct * 150000));
  };

  const fb5h = grupo === 'claude' ? 0.35 : 0.25;
  const fbSem = grupo === 'claude' ? 2.0 : 1.5;
  return {
    pct5h: calcJanela(`${grupo}-5h`, fb5h),
    pctSemanal: calcJanela(`${grupo}-semanal`, fbSem),
  };
}

export function estimarDemandaPlano(
  projeto,
  {
    historico = null,
    projetosHistorico = null,
    dataDir = null,
    estimativasCota = {},
    linhasCotas = [],
    tabelaPrecos = null,
    chainForFn = null,
    dadosCotas = null,
    esforcoFn = null,
    paralelismo = null,
    agoraMs = Date.now(),
  } = {},
) {
  const tarefas = Array.isArray(projeto?.plano?.tarefas) ? projeto.plano.tarefas : [];
  let hist = historico;
  if (!hist && projetosHistorico) {
    hist = dataDir ? montarHistoricoTarefas(projetosHistorico, { dataDir }) : [];
  }
  if (!Array.isArray(hist)) hist = [];

  const tabela = tabelaPrecos || carregarPrecos();

  const porGrupo = Object.fromEntries(
    TODOS_GRUPOS.map((g) => [
      g,
      { tarefas: 0, entrada: 0, saida: 0, cacheLido: 0, cacheGravado: 0, usd: 0, brl: 0, pct5hEstimado: 0, pctSemanalEstimado: 0 },
    ]),
  );

  const total = { entrada: 0, saida: 0, cacheLido: 0, cacheGravado: 0, usd: 0, brl: 0 };
  const detalhadas = [];

  for (let idx = 0; idx < tarefas.length; idx++) {
    const t = tarefas[idx];
    const prompt = String(t.prompt || '');
    const charsPrompt = prompt.length;
    const tipo = t.tipo || 'tarefa';
    const nivel = t.nivel || 'volume';
    const qtdArquivosCitados = (prompt.match(ARQUIVO_RE) || []).length;

    const cadeia = Array.isArray(t.cadeiaEfetiva) && t.cadeiaEfetiva.length
      ? t.cadeiaEfetiva
      : (typeof chainForFn === 'function' ? chainForFn(projeto, t, idx) : (Array.isArray(t.cadeia) ? t.cadeia : []));

    const prov = modeloProvavel(cadeia, { dadosCotas, agoraMs });
    const modeloAssumido = prov.modelo;
    const modeloPrincipal = modeloAssumido;
    const pulados = prov.pulados || [];

    let sufixoArroba = null;
    if (Array.isArray(cadeia)) {
      const entradaEscolhida = cadeia.find((e) => {
        const raw = String(e || '').trim();
        const semProv = raw.replace(/^[^:]+:/, '');
        const semEsf = semProv.replace(/@[A-Za-z]+$/, '');
        const modSemProv = String(modeloAssumido || '').replace(/^[^:]+:/, '');
        return semEsf === modSemProv || raw === modeloAssumido || raw.startsWith(`${modeloAssumido}@`);
      });
      if (entradaEscolhida && entradaEscolhida.includes('@')) {
        sufixoArroba = entradaEscolhida.split('@')[1].trim();
      }
    }

    let esforcoEfetivo = sufixoArroba;
    if (!esforcoEfetivo && typeof esforcoFn === 'function') {
      esforcoEfetivo = esforcoFn(projeto, t);
    }
    if (!esforcoEfetivo && t.esforco) {
      esforcoEfetivo = t.esforco;
    }
    if (!esforcoEfetivo) {
      esforcoEfetivo = 'medium';
    }

    const catDemanda = categoriaDemanda(t);

    const est = estimarTarefaPorHistorico(t, {
      historico: hist,
      modelo: modeloAssumido,
      esforco: esforcoEfetivo,
    });

    const entradaEstimada = est.entrada;
    const saidaEstimada = est.saida;
    const cacheLidoEstimado = est.cacheLido;
    const cacheGravadoEstimado = est.cacheGravado;
    const duracaoSegEstimada = est.duracaoSeg;
    const faixa = est.faixa;
    const amostras = est.amostras;
    const similaridade = est.similaridade;
    const aproximado = est.aproximado;
    const fonteEstimativa = est.fonte;

    const grupo = modeloAssumido ? (grupoDoModelo(modeloAssumido) || 'opencode') : 'opencode';
    const modeloSemProv = modeloAssumido ? String(modeloAssumido).replace(/^[^:]+:/, '') : '';
    const custo = modeloAssumido
      ? custoUsd(tabela, {
          modelo: modeloSemProv,
          entrada: entradaEstimada,
          saida: saidaEstimada,
          cacheLido: cacheLidoEstimado,
          cacheGravado: cacheGravadoEstimado,
        })
      : { usd: 0 };
    const custoUsdEstimado = round2(custo.usd ?? 0);
    const custoBrlEstimado = round2(emBrl(tabela, custoUsdEstimado) ?? 0);

    const { pct5h, pctSemanal } = estimarPctCota(
      grupo,
      modeloAssumido,
      entradaEstimada,
      saidaEstimada,
      custoUsdEstimado,
      estimativasCota,
    );

    const g = porGrupo[grupo] || porGrupo.opencode;
    g.tarefas += 1;
    g.entrada += entradaEstimada;
    g.saida += saidaEstimada;
    g.cacheLido += cacheLidoEstimado;
    g.cacheGravado += cacheGravadoEstimado;
    g.usd = round2(g.usd + custoUsdEstimado);
    g.brl = round2(g.brl + custoBrlEstimado);
    g.pct5hEstimado = round2(g.pct5hEstimado + pct5h);
    g.pctSemanalEstimado = round2(g.pctSemanalEstimado + pctSemanal);

    total.entrada += entradaEstimada;
    total.saida += saidaEstimada;
    total.cacheLido += cacheLidoEstimado;
    total.cacheGravado += cacheGravadoEstimado;
    total.usd = round2(total.usd + custoUsdEstimado);
    total.brl = round2(total.brl + custoBrlEstimado);

    detalhadas.push({
      id: t.id,
      demanda: catDemanda,
      tipo,
      nivel,
      esforco: t.esforco || 'medium',
      esforcoEfetivo,
      charsPrompt,
      qtdArquivosCitados,
      modeloAssumido,
      modeloPrincipal,
      pulados,
      grupo,
      fonteEstimativa,
      aproximado,
      amostras,
      similaridade,
      faixa,
      duracaoSegEstimada,
      entradaEstimada,
      saidaEstimada,
      cacheLidoEstimado,
      cacheGravadoEstimado,
      custoUsdEstimado,
      custoBrlEstimado,
      pct5hEstimado: pct5h,
      pctSemanalEstimado: pctSemanal,
    });
  }

  let somaP25Ent = 0;
  let somaP75Ent = 0;
  let somaP25Sai = 0;
  let somaP75Sai = 0;
  let somaAmostras = 0;
  for (const d of detalhadas) {
    if (Array.isArray(d.faixa?.entrada)) {
      somaP25Ent += Number(d.faixa.entrada[0]) || 0;
      somaP75Ent += Number(d.faixa.entrada[1]) || 0;
    }
    if (Array.isArray(d.faixa?.saida)) {
      somaP25Sai += Number(d.faixa.saida[0]) || 0;
      somaP75Sai += Number(d.faixa.saida[1]) || 0;
    }
    somaAmostras += Number(d.amostras) || 0;
  }
  total.faixaEntrada = [somaP25Ent, somaP75Ent];
  total.faixaSaida = [somaP25Sai, somaP75Sai];
  total.amostras = somaAmostras;

  const duracaoMapa = {};
  for (const d of detalhadas) {
    duracaoMapa[d.id] = d.faixa?.duracaoSeg || d.duracaoSegEstimada;
  }
  const parEfetivo = Math.max(1, Number(paralelismo) || Number(projeto?.plano?.maxConcurrent) || 2);
  // Intervalo entre disparos igual ao do pipeline.ps1 (18/11/2026): 10 s para gratuitos e NVIDIA; nos pagos,
  // 0 quando a cota comporta todos de uma vez (o caso comum). Antes era 60 s fixos.
  const gratuitoNaFrente = detalhadas.filter((d) => /^opencode:(opencode|nvidia)\//.test(String(d.modeloAssumido || ''))).length;
  const intervaloSeg = gratuitoNaFrente > detalhadas.length / 2 ? 10 : 0;
  const tempo = simularTempoPlano(tarefas, {
    duracaoSeg: duracaoMapa,
    paralelismo: parEfetivo,
    intervaloSeg,
  });
  tempo.paralelismo = parEfetivo;

  const linhaResumo = linhaEstimativa({ tempo, total, porGrupo });

  return { tarefas: detalhadas, porGrupo, total, tempo, linhaResumo };
}

function diagnosticarGrupos(demanda, linhasCotas, agoraMs) {
  const linhas = Array.isArray(linhasCotas) ? linhasCotas : [];
  const porGrupo = {};

  for (const grupo of GRUPOS_PAGOS) {
    const linhaSem = linhas.find((l) => l.grupo === grupo && l.janela === 'semanal');
    const linha5h = linhas.find((l) => l.grupo === grupo && l.janela === '5 h');
    const demandaPct = round2(demanda?.porGrupo?.[grupo]?.pctSemanalEstimado || 0);

    if (!linhaSem || typeof linhaSem.restante !== 'number') {
      porGrupo[grupo] = {
        disponivel: false,
        restantePct: null,
        restante5hPct: typeof linha5h?.restante === 'number' ? round2(linha5h.restante * 100) : null,
        diasAteReset: null,
        folgaSemanal: null,
        demandaPct,
        statusGrupo: 'manter',
      };
      continue;
    }

    const restanteSemanal = clamp(linhaSem.restante, 0, 1);
    const restante5h = typeof linha5h?.restante === 'number' ? clamp(linha5h.restante, 0, 1) : 1;
    const renovaMs = linhaSem.renovaEm ? Date.parse(linhaSem.renovaEm) : NaN;
    const diasAteReset = Number.isFinite(renovaMs)
      ? round2(clamp((renovaMs - agoraMs) / 86400000, 0.05, 7))
      : 3.5;

    const cotaEsperada = diasAteReset / 7;
    const folgaSemanal = round2(restanteSemanal - cotaEsperada);
    const demandaSemanalFrac = demandaPct / 100;

    let statusGrupo = 'manter';
    if (
      (restanteSemanal <= 0.25 && diasAteReset >= 1.5) ||
      folgaSemanal < -0.12 ||
      (restanteSemanal > 0 && demandaSemanalFrac > restanteSemanal * 0.6) ||
      restante5h <= 0.15
    ) {
      statusGrupo = 'economizar_maximo';
    } else if (
      (restanteSemanal >= 0.5 && diasAteReset <= 2.0) ||
      (restanteSemanal >= 0.35 && diasAteReset <= 1.0) ||
      folgaSemanal >= 0.25
    ) {
      statusGrupo = 'usar_melhor';
    }

    porGrupo[grupo] = {
      disponivel: true,
      restantePct: round2(restanteSemanal * 100),
      restante5hPct: round2(restante5h * 100),
      diasAteReset,
      folgaSemanal,
      demandaPct,
      statusGrupo,
    };
  }

  return porGrupo;
}

function sugerirCadeiaEconomica(cadeia, t, diagGrupos) {
  const nivel = t.nivel || 'volume';
  const tipo = t.tipo || 'tarefa';
  const principal = cadeia[0] || '';
  const folgaGemini = diagGrupos.gemini?.disponivel ? (diagGrupos.gemini.folgaSemanal ?? 0) : -1;
  const folgaClaude = diagGrupos.claude?.disponivel ? (diagGrupos.claude.folgaSemanal ?? 0) : -1;
  const geminiMaisFolgada = folgaGemini > folgaClaude + 0.05;

  if (tipo === 'integrador') {
    if (principal.startsWith('claude:opus')) {
      return ['claude:sonnet@medium', ...cadeia.filter((m) => m !== 'claude:sonnet@medium' && m !== principal)];
    }
    return cadeia;
  }

  const nova = [...cadeia];
  if (principal.startsWith('claude:opus')) {
    const subst = geminiMaisFolgada ? 'agy:gemini-3.8-flash-medium' : 'claude:sonnet@medium';
    nova[0] = subst;
  } else if (principal.startsWith('claude:sonnet')) {
    if (nivel === 'leve') {
      nova[0] = 'claude:haiku';
    } else if (geminiMaisFolgada) {
      nova[0] = 'agy:gemini-3.8-flash-medium';
    }
  } else if (principal.includes('argon')) {
    nova[0] = nivel === 'pesado' ? 'agy:gemini-4-hydrogen-medium' : 'agy:gemini-3.8-flash-high';
  }

  return [...new Set(nova)];
}

function sugerirCadeiaMelhor(cadeia, t, diagGrupos) {
  const nivel = t.nivel || 'volume';
  const tipo = t.tipo || 'tarefa';
  const claudeFolgada = !diagGrupos.claude?.disponivel || diagGrupos.claude.statusGrupo !== 'economizar_maximo';

  let alvo = null;
  if (tipo === 'integrador' || nivel === 'pesado') {
    alvo = claudeFolgada ? 'claude:opus@high' : 'agy:gemini-4-argon-high';
  } else if (nivel === 'volume') {
    alvo = claudeFolgada ? 'claude:sonnet@high' : 'agy:gemini-4-hydrogen-medium';
  }

  if (!alvo || cadeia[0] === alvo) return cadeia;
  return [alvo, ...cadeia.filter((m) => m !== alvo)];
}

function arraysIguais(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function recomendarAjusteModelos(
  projeto,
  {
    demanda = null,
    linhasCotas = [],
    agoraMs = Date.now(),
    provedores = {},
    preservarExplicitas = false,
    forcarEstrategia = null,
    historico = null,
    projetosHistorico = null,
    dataDir = null,
    estimativasCota = {},
    tabelaPrecos = null,
    chainForFn = null,
    dadosCotas = null,
    esforcoFn = null,
    paralelismo = null,
  } = {},
) {
  const opcoesEstimativa = {
    historico,
    projetosHistorico,
    dataDir,
    estimativasCota,
    linhasCotas,
    tabelaPrecos,
    chainForFn,
    dadosCotas,
    esforcoFn,
    paralelismo,
    agoraMs,
  };

  const dem = demanda || estimarDemandaPlano(projeto, opcoesEstimativa);
  const porGrupo = diagnosticarGrupos(dem, linhasCotas, agoraMs);

  let estrategia = forcarEstrategia || 'manter';
  let grupoDet = null;

  if (!forcarEstrategia) {
    const eco = GRUPOS_PAGOS.find((g) => porGrupo[g]?.disponivel && porGrupo[g].statusGrupo === 'economizar_maximo');
    const mel = GRUPOS_PAGOS.find((g) => porGrupo[g]?.disponivel && porGrupo[g].statusGrupo === 'usar_melhor');
    if (eco) {
      estrategia = 'economizar_maximo';
      grupoDet = eco;
    } else if (mel) {
      estrategia = 'usar_melhor';
      grupoDet = mel;
    }
  }

  const cadeiasSugeridas = {};
  const esforcosSugeridos = {};
  const tarefas = Array.isArray(projeto?.plano?.tarefas) ? projeto.plano.tarefas : [];

  if (estrategia !== 'manter') {
    let idxVol = 0;
    for (const t of tarefas) {
      const idx = (t.nivel || 'volume') === 'volume' ? idxVol++ : 0;
      if (preservarExplicitas && Array.isArray(t.cadeia) && t.cadeia.length > 0) continue;
      // Sem cadeia própria, a tarefa usa a do modo (chainForFn); antes ficava de fora e a sugestão saía vazia.
      const cadeiaAtual = Array.isArray(t.cadeiaEfetiva) && t.cadeiaEfetiva.length
        ? t.cadeiaEfetiva
        : (Array.isArray(t.cadeia) && t.cadeia.length ? t.cadeia
          : (typeof chainForFn === 'function' ? (chainForFn(projeto, t, idx) || []) : []));
      if (!cadeiaAtual.length) continue;

      if (estrategia === 'economizar_maximo') {
        const nova = sugerirCadeiaEconomica(cadeiaAtual, t, porGrupo);
        if (!arraysIguais(nova, cadeiaAtual)) cadeiasSugeridas[t.id] = nova;
        const esfAtual = t.esforco || 'medium';
        if (esfAtual === 'high') esforcosSugeridos[t.id] = 'medium';
        else if (esfAtual === 'medium' && (t.nivel || 'volume') === 'leve') esforcosSugeridos[t.id] = 'low';
      } else if (estrategia === 'usar_melhor') {
        const nova = sugerirCadeiaMelhor(cadeiaAtual, t, porGrupo);
        if (!arraysIguais(nova, cadeiaAtual)) cadeiasSugeridas[t.id] = nova;
      }
    }
  }

  let motivo = 'Cota equilibrada com os dias restantes até o reset.';
  if (estrategia === 'economizar_maximo') {
    const d = grupoDet ? porGrupo[grupoDet] : null;
    motivo = d
      ? `${grupoDet} semanal em ${d.restantePct}% restante faltando ${String(d.diasAteReset).replace('.', ',')} dias para o reset (demanda estimada: ~${d.demandaPct}%). Recomendado economizar ao máximo.`
      : 'Cota apertada até o reset. Recomendado economizar ao máximo.';
  } else if (estrategia === 'usar_melhor') {
    const d = grupoDet ? porGrupo[grupoDet] : null;
    motivo = d
      ? `${grupoDet} semanal em ${d.restantePct}% restante faltando ${String(d.diasAteReset).replace('.', ',')} dia(s) para o reset. Recomendado usar modelos mais fortes antes da renovação.`
      : 'Cota com folga próxima ao reset. Recomendado usar modelos mais fortes.';
  }

  let economiaEstimadaUsd = 0;
  let economiaEstimadaPct = 0;
  let demandaSugerida = null;
  if (Object.keys(cadeiasSugeridas).length > 0 || Object.keys(esforcosSugeridos).length > 0) {
    const projSim = {
      ...projeto,
      plano: {
        ...projeto.plano,
        tarefas: tarefas.map((t) => ({
          ...t,
          cadeiaEfetiva: cadeiasSugeridas[t.id] || t.cadeiaEfetiva || t.cadeia,
          esforco: esforcosSugeridos[t.id] || t.esforco,
        })),
      },
    };
    const demSim = estimarDemandaPlano(projSim, opcoesEstimativa);
    demandaSugerida = demSim;
    economiaEstimadaUsd = round2((dem.total?.usd || 0) - (demSim.total?.usd || 0));
    if (dem.total?.usd > 0) {
      economiaEstimadaPct = round2((economiaEstimadaUsd / dem.total.usd) * 100);
    }
  }

  return {
    estrategia,
    motivo,
    porGrupo,
    cadeiasSugeridas,
    esforcosSugeridos,
    economiaEstimadaUsd,
    economiaEstimadaPct,
    demandaSugerida,
  };
}

export function aplicarPoliticaCotaAoProjeto(projeto, modoPolitica = 'auto', contexto = {}) {
  if (modoPolitica === 'ignorar') {
    return { projeto, alterado: false, recomendacao: null };
  }

  const forcarEstrategia = modoPolitica === 'economizar'
    ? 'economizar_maximo'
    : (modoPolitica === 'usar_melhor' ? 'usar_melhor' : null);

  const rec = recomendarAjusteModelos(projeto, { ...contexto, forcarEstrategia });
  if (rec.estrategia === 'manter') {
    return { projeto, alterado: false, recomendacao: rec };
  }

  const temMudanca = Object.keys(rec.cadeiasSugeridas).length > 0 || Object.keys(rec.esforcosSugeridos).length > 0;
  if (!temMudanca) {
    return { projeto, alterado: false, recomendacao: rec };
  }

  const tarefas = (projeto?.plano?.tarefas || []).map((t) => {
    const novaCadeia = rec.cadeiasSugeridas[t.id];
    const novoEsforco = rec.esforcosSugeridos[t.id];
    if (!novaCadeia && !novoEsforco) return t;
    return {
      ...t,
      ...(novaCadeia ? { cadeia: novaCadeia, cadeiaEfetiva: novaCadeia } : {}),
      ...(novoEsforco ? { esforco: novoEsforco } : {}),
    };
  });

  return {
    projeto: { ...projeto, plano: { ...projeto.plano, tarefas } },
    alterado: true,
    recomendacao: rec,
  };
}
