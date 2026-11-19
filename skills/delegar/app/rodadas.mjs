// Rodadas: arquivamento da execução concluída de um projeto, migração do formato antigo (pasta
// rodadas/<N>/ na raiz do projeto) e soma do uso de tokens de todas as rodadas (real da CLI ou
// estimado). Módulo standalone ESM puro sem dependências externas.
import fs from 'node:fs';
import path from 'node:path';
import { modeloSemEsforco, usoDaTentativa, estimar, temConsumoReal, chaveAgrupamentoModelo, consolidarListaModelos } from './uso.mjs';
import { carregarPrecos, custoUsd, assinaturaDe, emBrl } from './precos.mjs';

const PROVEDORES = ['claude', 'agy', 'opencode'];
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const numOuNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const arred = (v) => (v === null || v === undefined ? null : Math.round(v * 1e6) / 1e6);
const paraMs = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) { const d = Date.parse(v); if (Number.isFinite(d)) return d; }
  return null;
};

// 'claude:haiku@high' -> {provedor: 'claude', modelo: 'haiku'} (igual ao servidor).
function partesModelo(entry, provPadrao) {
  const s = modeloSemEsforco(entry);
  const i = s.indexOf(':');
  if (i > 0 && PROVEDORES.includes(s.slice(0, i))) return { provedor: s.slice(0, i), modelo: s.slice(i + 1) };
  return { provedor: provPadrao || 'desconhecido', modelo: s };
}

// Quanto pior a origem do custo, mais alto o peso ('desconhecido' vence 'estimado' e assim por diante).
const PESO_ORIGEM = { desconhecido: 5, estimado: 4, aproximado: 3, tabela: 2, gratuito: 1, cli: 0 };
const piorOrigem = (arr) => {
  const lista = Array.isArray(arr) ? arr : [arr];
  if (!lista.length) return 'cli';
  return lista.reduce((p, o) => ((PESO_ORIGEM[o] ?? 2) >= (PESO_ORIGEM[p] ?? 2) ? o : p), 'cli');
};

function lerJson(arquivo) {
  try { return JSON.parse(String(fs.readFileSync(arquivo, 'utf8')).replace(/^\uFEFF/, '')); } catch { return null; }
}

const CACHE_ARQUIVOS = new Map();
function comCacheArquivo(caminho, fn) {
  let chave = null;
  try {
    chave = path.resolve(String(caminho));
    const st = fs.statSync(chave);
    chave = `${chave}|${st.mtimeMs}|${st.size}`;
  } catch { return null; }
  if (CACHE_ARQUIVOS.has(chave)) return CACHE_ARQUIVOS.get(chave);
  let r = null;
  try { r = fn() ?? null; } catch { r = null; }
  if (CACHE_ARQUIVOS.size > 1000) CACHE_ARQUIVOS.clear();
  CACHE_ARQUIVOS.set(chave, r);
  return r;
}

function copyDir(de, para) {
  try {
    fs.mkdirSync(para, { recursive: true });
    for (const e of fs.readdirSync(de, { withFileTypes: true })) {
      const o = path.join(de, e.name);
      const d = path.join(para, e.name);
      if (e.isDirectory()) copyDir(o, d);
      else if (e.isFile()) { try { fs.copyFileSync(o, d); } catch {} }
    }
    return true;
  } catch { return false; }
}

function custoDe(tabela, item) {
  try { return tabela ? custoUsd(tabela, item) : { usd: null, origem: 'desconhecido' }; }
  catch { return { usd: null, origem: 'desconhecido' }; }
}

function resolverCaminhoNoDir(dir, caminho) {
  if (!caminho || typeof caminho !== 'string') return null;
  try {
    const nome = path.basename(caminho);
    const noDir = path.join(dir, nome);
    if (fs.existsSync(noDir)) return noDir;
    const pai = path.dirname(dir);
    const noPai = path.join(pai, nome);
    if (fs.existsSync(noPai)) return noPai;
    if (fs.existsSync(caminho)) return caminho;
  } catch {}
  return String(caminho);
}

// ---------------------------------------------------------------------------------------------
// 1. temRodadaExecutada
// ---------------------------------------------------------------------------------------------
export function temRodadaExecutada(p, projDir) {
  if (!p?.plano || !Array.isArray(p.plano.tarefas) || p.plano.tarefas.length === 0) return false;
  if (Boolean(p.inicio)) return true;
  if (projDir) {
    try { return fs.existsSync(path.join(projDir, 'logs', 'status.json')); } catch { return false; }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// 2. limparLogsRaiz
// ---------------------------------------------------------------------------------------------
export function limparLogsRaiz(logsDir) {
  let entradas = [];
  try { entradas = fs.readdirSync(logsDir, { withFileTypes: true }); } catch { return 0; }
  let n = 0;
  for (const e of entradas) {
    if (/^rodada-\d+$/.test(e.name)) continue;
    try {
      fs.rmSync(path.join(logsDir, e.name), { recursive: true, force: true });
      n++;
    } catch {}
  }
  return n;
}

// ---------------------------------------------------------------------------------------------
// 3. moverLogsParaRodada
// ---------------------------------------------------------------------------------------------
export function moverLogsParaRodada(projDir, numero) {
  const n = Number(numero) || 1;
  const logs = path.join(projDir, 'logs');
  const destino = path.join(logs, `rodada-${n}`);
  fs.mkdirSync(destino, { recursive: true });
  let entradas = [];
  try { entradas = fs.readdirSync(logs, { withFileTypes: true }); } catch { entradas = []; }
  for (const e of entradas) {
    if (/^rodada-\d+$/.test(e.name)) continue;
    const o = path.join(logs, e.name);
    const d = path.join(destino, e.name);
    try {
      fs.renameSync(o, d);
    } catch {
      try {
        if (e.isDirectory()) {
          copyDir(o, d);
          fs.rmSync(o, { recursive: true, force: true });
        } else {
          fs.copyFileSync(o, d);
          fs.unlinkSync(o);
        }
      } catch {}
    }
  }
  try {
    const planFile = path.join(projDir, 'plan.json');
    if (fs.existsSync(planFile)) fs.copyFileSync(planFile, path.join(destino, 'plan.json'));
  } catch {}
  try {
    const promptsDir = path.join(projDir, 'prompts');
    if (fs.existsSync(promptsDir)) copyDir(promptsDir, path.join(destino, 'prompts'));
  } catch {}
  return `logs/rodada-${n}`;
}

// ---------------------------------------------------------------------------------------------
// 4. dadosUsoDaRodada
// ---------------------------------------------------------------------------------------------
export function dadosUsoDaRodada(p, rodadaInfo, tabela, { projDir, usoAgyReal } = {}) {
  const tab = tabela || carregarPrecos();
  const info = rodadaInfo && typeof rodadaInfo === 'object' ? rodadaInfo : {};
  let logsDir = info.logsDir || info.logDir || '';
  if (logsDir && projDir && !path.isAbsolute(logsDir)) {
    logsDir = path.resolve(projDir, logsDir);
  }
  const emAndamento = !!info.emAndamento;
  const numRodada = numOuNull(info.numero);

  // a) Pseudotarefa 'planejador'
  const chamadas = Array.isArray(info.chamadas)
    ? info.chamadas
    : (Array.isArray(p?.uso?.chamadas) ? p.uso.chamadas : []);
  const tentativasPlan = [];
  const planTotal = { entrada: 0, saida: 0, cacheLido: 0, cacheGravado: 0, usd: 0, brl: 0, aproximado: false, origem: 'cli' };
  const planOrigens = [];

  for (const ch of chamadas) {
    if (!ch || typeof ch !== 'object') continue;
    const { provedor: chProv, modelo: chMod } = partesModelo(ch.modelo || 'desconhecido');
    const linhas = Array.isArray(ch.porModelo) && ch.porModelo.length ? ch.porModelo : [{
      provedor: chProv,
      modelo: chMod,
      entrada: num(ch.entrada),
      saida: num(ch.saida),
      cacheLido: num(ch.cacheLido),
      cacheGravado: num(ch.cacheGravado),
      custoCliUsd: numOuNull(ch.custoCliUsd),
    }];

    let chUsd = 0;
    let chTemUsd = false;
    const chOrigens = [];
    const linhasComCusto = [];
    for (const l of linhas) {
      const c = custoDe(tab, l);
      let o = c.origem;
      if (ch.fonte === 'estimado' && o !== 'desconhecido') o = 'estimado';
      chOrigens.push(o);
      if (c.usd !== null) { chUsd += c.usd; chTemUsd = true; }
      linhasComCusto.push({ ...l, usd: c.usd, origem: o });
    }
    const finalOrigem = piorOrigem(chOrigens);
    const finalUsd = chTemUsd ? arred(chUsd) : null;

    tentativasPlan.push({
      modelo: chMod,
      provedor: chProv,
      entrada: num(ch.entrada),
      saida: num(ch.saida),
      cacheLido: num(ch.cacheLido),
      cacheGravado: num(ch.cacheGravado),
      usd: finalUsd,
      origem: finalOrigem,
      fonte: ch.fonte || 'cli',
      inicio: ch.quando || null,
      fim: ch.quando || null,
      porModelo: linhasComCusto,
      ...(numRodada !== null ? { rodada: numRodada } : {}),
    });

    planTotal.entrada += num(ch.entrada);
    planTotal.saida += num(ch.saida);
    planTotal.cacheLido += num(ch.cacheLido);
    planTotal.cacheGravado += num(ch.cacheGravado);
    if (finalUsd !== null) planTotal.usd = (planTotal.usd || 0) + finalUsd;
    planOrigens.push(finalOrigem);
  }

  planTotal.usd = arred(planTotal.usd);
  planTotal.brl = planTotal.usd !== null ? emBrl(tab, planTotal.usd) : null;
  planTotal.origem = piorOrigem(planOrigens);
  planTotal.aproximado = planOrigens.some((o) => o === 'aproximado' || o === 'estimado');

  const planoObj = info.plano && typeof info.plano === 'object' ? info.plano : (p?.plano || null);
  const tarefaPlan = {
    id: 'planejador',
    titulo: 'Planejador',
    estado: planoObj ? 'done' : (emAndamento ? 'running' : 'done'),
    chamadas: tentativasPlan.length,
    total: planTotal,
    tentativas: tentativasPlan,
    ...(numRodada !== null ? { rodada: numRodada } : {}),
  };

  // b) Tarefas de plano.tarefas
  const tarefasPlano = Array.isArray(planoObj?.tarefas) ? planoObj.tarefas : [];
  const st = (logsDir && lerJson(path.join(logsDir, 'status.json'))) || info.status || {};
  const tarefasOut = [tarefaPlan];

  for (const t of tarefasPlano) {
    if (!t || typeof t !== 'object') continue;
    const tState = st[t.id]?.state || (st[t.id] ? (typeof st[t.id] === 'string' ? st[t.id] : 'done') : (emAndamento ? 'running' : 'done'));
    const ld = logsDir ? path.join(logsDir, String(t.id)) : '';
    const ldFix = logsDir ? path.join(logsDir, `${String(t.id)}-fix`) : '';
    const tentativasTarefa = [];
    const tOrigens = [];
    const tTotal = { entrada: 0, saida: 0, cacheLido: 0, cacheGravado: 0, usd: 0, brl: 0, aproximado: false, origem: 'cli' };

    const processarDir = (dir) => {
      const dirExiste = dir && fs.existsSync(dir);
      const resFile = dirExiste ? path.join(dir, 'result.json') : '';
      const res = resFile && fs.existsSync(resFile) ? lerJson(resFile) : null;
      const completedIndices = new Set();

      let attempts = [];
      if (Array.isArray(res?.attempts)) attempts = res.attempts;
      else if (res?.uso && typeof res.uso === 'object') attempts = [res];
      else if (Array.isArray(st?.[t.id])) attempts = st[t.id];

      for (let idx = 0; idx < attempts.length; idx++) {
        const a = attempts[idx];
        if (!a || typeof a !== 'object') continue;
        completedIndices.add(idx + 1);

        const outResolvido = dirExiste ? resolverCaminhoNoDir(dir, a.out) : a.out;
        const textResolvido = dirExiste ? resolverCaminhoNoDir(dir, a.text) : a.text;
        const pfCandidate = a.prompt || a.promptFile || (a.out ? String(a.out).replace(/\.out\.log$/, '.prompt.txt') : null);
        const promptResolvido = dirExiste ? resolverCaminhoNoDir(dir, pfCandidate) : pfCandidate;

        let uso = a.uso || null;
        if (!uso && outResolvido && fs.existsSync(outResolvido)) {
          uso = comCacheArquivo(outResolvido, () => usoDaTentativa({
            tipo: a.worker?.split(':')[0],
            modelo: a.worker,
            out: outResolvido,
            prompt: promptResolvido,
            texto: textResolvido,
          }));
        }
        if (!uso && outResolvido && fs.existsSync(outResolvido)) {
          let pLen = 0; let oLen = 0;
          try { pLen = fs.statSync(promptResolvido).size; } catch {}
          try { oLen = fs.statSync(outResolvido).size; } catch {}
          if (pLen > 0 || oLen > 0) uso = estimar(pLen, oLen, a.worker);
        }
        if (outResolvido && uso?.fonte !== 'cli' && typeof usoAgyReal === 'function') {
          try {
            const real = usoAgyReal(p, path.basename(dir || t.id), a.worker, promptResolvido, Date.parse(a.started), Date.parse(a.finished), false);
            if (real) uso = real;
          } catch {}
        }

        const workerEntry = a.worker || (uso?.modelo) || 'desconhecido';
        const { provedor, modelo } = partesModelo(workerEntry);
        const linhas = Array.isArray(uso?.porModelo) && uso.porModelo.length ? uso.porModelo : [{
          provedor,
          modelo,
          entrada: num(uso?.entrada),
          saida: num(uso?.saida),
          cacheLido: num(uso?.cacheLido),
          cacheGravado: num(uso?.cacheGravado),
          custoCliUsd: numOuNull(uso?.custoCliUsd),
        }];

        let attUsd = 0;
        let attTemUsd = false;
        const attOrigens = [];
        const linhasComCusto = [];
        for (const l of linhas) {
          const c = custoDe(tab, l);
          let o = c.origem;
          if (uso?.fonte === 'estimado' && o !== 'desconhecido') o = 'estimado';
          attOrigens.push(o);
          if (c.usd !== null) { attUsd += c.usd; attTemUsd = true; }
          linhasComCusto.push({ ...l, usd: c.usd, origem: o });
        }
        const finalOrigem = piorOrigem(attOrigens);
        const finalUsd = attTemUsd ? arred(attUsd) : null;

        tentativasTarefa.push({
          modelo,
          provedor,
          entrada: num(uso?.entrada),
          saida: num(uso?.saida),
          cacheLido: num(uso?.cacheLido),
          cacheGravado: num(uso?.cacheGravado),
          usd: finalUsd,
          origem: finalOrigem,
          fonte: uso?.fonte || 'cli',
          inicio: a.started || null,
          fim: a.finished || null,
          porModelo: linhasComCusto,
          ...(numRodada !== null ? { rodada: numRodada } : {}),
        });

        tTotal.entrada += num(uso?.entrada);
        tTotal.saida += num(uso?.saida);
        tTotal.cacheLido += num(uso?.cacheLido);
        tTotal.cacheGravado += num(uso?.cacheGravado);
        if (finalUsd !== null) tTotal.usd = (tTotal.usd || 0) + finalUsd;
        tOrigens.push(finalOrigem);
      }

      // c) Só lê tentativas em andamento (.out.log fora de result.json) quando emAndamento for verdadeiro
      if (emAndamento && dirExiste) {
        let outs = [];
        try {
          outs = fs.readdirSync(dir)
            .filter((f) => f.endsWith('.out.log'))
            .sort((x, y) => parseInt(x) - parseInt(y));
        } catch {}
        for (const f of outs) {
          const numTent = parseInt(f);
          if (completedIndices.has(numTent) || completedIndices.has(f)) continue;
          const outPath = path.join(dir, f);
          const curFile = path.join(dir, 'current.json');
          const cur = fs.existsSync(curFile) ? lerJson(curFile) : null;
          const workerEntry = (cur && cur.attempt === numTent && cur.worker) ? cur.worker : (() => {
            const m = f.match(/^\d+-(.*)\.out\.log$/);
            return m ? m[1].replace(/_/g, '-') : 'desconhecido';
          })();
          const pfPath = path.join(dir, f.replace(/\.out\.log$/, '.prompt.txt'));
          const txtPath = path.join(dir, f.replace(/\.out\.log$/, '.txt'));

          let inicioOut = NaN;
          try { inicioOut = fs.statSync(outPath).birthtimeMs; } catch {}
          let realRodando = null;
          if (typeof usoAgyReal === 'function') {
            try { realRodando = usoAgyReal(p, path.basename(dir), workerEntry, pfPath, inicioOut, NaN, true); } catch {}
          }
          const uso = realRodando || comCacheArquivo(outPath, () => {
            let u = usoDaTentativa({
              tipo: workerEntry.split(':')[0],
              modelo: workerEntry,
              out: outPath,
              prompt: pfPath,
              texto: txtPath,
            });
            if (!u) {
              let pLen = 0; let oLen = 0;
              try { pLen = fs.statSync(pfPath).size; } catch {}
              try { oLen = fs.statSync(outPath).size; } catch {}
              if (pLen > 0 || oLen > 0) u = estimar(pLen, oLen, workerEntry);
            }
            return u;
          });

          const fonteTent = uso?.fonte === 'cli' ? 'cli-parcial' : (uso?.fonte || 'cli-parcial');
          const { provedor, modelo } = partesModelo(workerEntry);
          const linhas = Array.isArray(uso?.porModelo) && uso.porModelo.length ? uso.porModelo : [{
            provedor,
            modelo,
            entrada: num(uso?.entrada),
            saida: num(uso?.saida),
            cacheLido: num(uso?.cacheLido),
            cacheGravado: num(uso?.cacheGravado),
            custoCliUsd: numOuNull(uso?.custoCliUsd),
          }];

          let attUsd = 0;
          let attTemUsd = false;
          const attOrigens = [];
          const linhasComCusto = [];
          for (const l of linhas) {
            const c = custoDe(tab, l);
            let o = c.origem;
            if (fonteTent === 'estimado' && o !== 'desconhecido') o = 'estimado';
            attOrigens.push(o);
            if (c.usd !== null) { attUsd += c.usd; attTemUsd = true; }
            linhasComCusto.push({ ...l, usd: c.usd, origem: o });
          }
          const finalOrigem = piorOrigem(attOrigens);
          const finalUsd = attTemUsd ? arred(attUsd) : null;

          tentativasTarefa.push({
            modelo,
            provedor,
            entrada: num(uso?.entrada),
            saida: num(uso?.saida),
            cacheLido: num(uso?.cacheLido),
            cacheGravado: num(uso?.cacheGravado),
            usd: finalUsd,
            origem: finalOrigem,
            fonte: fonteTent,
            inicio: (cur && cur.started) ? cur.started : (st[t.id]?.started || null),
            fim: null,
            porModelo: linhasComCusto,
            ...(numRodada !== null ? { rodada: numRodada } : {}),
          });

          tTotal.entrada += num(uso?.entrada);
          tTotal.saida += num(uso?.saida);
          tTotal.cacheLido += num(uso?.cacheLido);
          tTotal.cacheGravado += num(uso?.cacheGravado);
          if (finalUsd !== null) tTotal.usd = (tTotal.usd || 0) + finalUsd;
          tOrigens.push(finalOrigem);
        }
      }
    };

    if (ld) processarDir(ld);
    if (ldFix && fs.existsSync(ldFix)) processarDir(ldFix);

    tTotal.usd = arred(tTotal.usd);
    tTotal.brl = tTotal.usd !== null ? emBrl(tab, tTotal.usd) : null;
    tTotal.origem = piorOrigem(tOrigens);
    tTotal.aproximado = tOrigens.some((o) => o === 'aproximado' || o === 'estimado');

    tarefasOut.push({
      id: t.id,
      titulo: t.titulo || '',
      estado: tState,
      total: tTotal,
      tentativas: tentativasTarefa,
      ...(numRodada !== null ? { rodada: numRodada } : {}),
    });
  }

  // d) Agrega total e modelos da rodada
  const rodadaTotal = { entrada: 0, saida: 0, cacheLido: 0, cacheGravado: 0, usd: 0, brl: 0, aproximado: false, origem: 'cli' };
  const rodadaOrigens = [];
  const modelosMap = new Map();

  for (const tf of tarefasOut) {
    rodadaTotal.entrada += tf.total.entrada;
    rodadaTotal.saida += tf.total.saida;
    rodadaTotal.cacheLido += tf.total.cacheLido;
    rodadaTotal.cacheGravado += tf.total.cacheGravado;
    if (tf.total.usd !== null) rodadaTotal.usd = (rodadaTotal.usd || 0) + tf.total.usd;
    if (tf.total.origem) rodadaOrigens.push(tf.total.origem);

    for (const tent of tf.tentativas) {
      const linhas = Array.isArray(tent.porModelo) && tent.porModelo.length ? tent.porModelo : [{
        provedor: tent.provedor,
        modelo: tent.modelo,
        entrada: tent.entrada,
        saida: tent.saida,
        cacheLido: tent.cacheLido,
        cacheGravado: tent.cacheGravado,
        usd: tent.usd,
        origem: tent.origem,
      }];

      for (const l of linhas) {
        if (!temConsumoReal(l)) continue;
        const chave = chaveAgrupamentoModelo(l.provedor, l.modelo);
        let mEntry = modelosMap.get(chave);
        if (!mEntry) {
          mEntry = {
            provedor: l.provedor,
            modelo: l.modelo,
            entrada: 0,
            saida: 0,
            cacheLido: 0,
            cacheGravado: 0,
            usd: 0,
            origens: [],
            fontes: [],
            assinatura: assinaturaDe(l.provedor),
          };
          modelosMap.set(chave, mEntry);
        }
        const canônico = chave.slice(chave.indexOf(':') + 1);
        if (String(l.modelo ?? '').toLowerCase() === canônico.toLowerCase()
          && String(mEntry.modelo ?? '').toLowerCase() !== canônico.toLowerCase()) {
          mEntry.modelo = l.modelo;
        }
        mEntry.entrada += l.entrada;
        mEntry.saida += l.saida;
        mEntry.cacheLido += l.cacheLido;
        mEntry.cacheGravado += l.cacheGravado;
        mEntry.origens.push(l.origem || tent.origem);
        mEntry.fontes.push(tent.fonte);
        if (l.usd !== null) mEntry.usd = (mEntry.usd || 0) + l.usd;
      }
    }
  }

  rodadaTotal.usd = arred(rodadaTotal.usd);
  rodadaTotal.brl = rodadaTotal.usd !== null ? emBrl(tab, rodadaTotal.usd) : null;
  rodadaTotal.origem = piorOrigem(rodadaOrigens);
  rodadaTotal.aproximado = rodadaOrigens.some((o) => o === 'aproximado' || o === 'estimado');

  const modelosOut = consolidarListaModelos(Array.from(modelosMap.values()).map((m) => {
    const usd = arred(m.usd);
    return {
      provedor: m.provedor,
      modelo: m.modelo,
      entrada: m.entrada,
      saida: m.saida,
      cacheLido: m.cacheLido,
      cacheGravado: m.cacheGravado,
      usd,
      brl: usd !== null ? emBrl(tab, usd) : null,
      origem: piorOrigem(m.origens),
      assinatura: m.assinatura,
      estimado: m.origens.some((o) => o === 'estimado') || m.fontes.some((f) => f === 'estimado'),
    };
  }))
    .map((x) => ({ ...x, brl: x.usd !== null ? emBrl(tab, x.usd) : null }))
    .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0) || (b.entrada + b.saida) - (a.entrada + a.saida));

  return {
    emAndamento,
    total: rodadaTotal,
    modelos: modelosOut,
    tarefas: tarefasOut,
  };
}

// ---------------------------------------------------------------------------------------------
// 5. arquivarRodada
// ---------------------------------------------------------------------------------------------
export function arquivarRodada(p, { projDir, dataDir, tabela, chainFor, nomeModo, velDe, supDe, resumoFinal } = {}) {
  if (!temRodadaExecutada(p, projDir)) return null;

  const tab = tabela || carregarPrecos({ dataDir });
  const numero = (Array.isArray(p.rodadas) ? p.rodadas.length : 0) + 1;
  const logsRaiz = projDir ? path.join(projDir, 'logs') : '';

  let status = {};
  try { status = (logsRaiz && lerJson(path.join(logsRaiz, 'status.json'))) || {}; } catch { status = {}; }
  let summary = '';
  try { summary = logsRaiz ? fs.readFileSync(path.join(logsRaiz, 'summary.md'), 'utf8') : ''; } catch { summary = ''; }

  const resumoTxt = p.resumoFinal || (typeof resumoFinal === 'function' ? resumoFinal(p, { status, summary }) : '');

  const logDir = projDir ? moverLogsParaRodada(projDir, numero) : `logs/rodada-${numero}`;

  const planoSalvo = p.plano ? JSON.parse(JSON.stringify(p.plano)) : null;
  if (planoSalvo && Array.isArray(planoSalvo.tarefas) && typeof chainFor === 'function') {
    for (const t of planoSalvo.tarefas) {
      try { t.cadeiaEfetiva = chainFor(p, t) || []; } catch { t.cadeiaEfetiva = []; }
    }
  }

  const chamadas = Array.isArray(p.uso?.chamadas) ? [...p.uso.chamadas] : [];
  const logsDirAbs = projDir ? path.join(projDir, logDir) : '';

  const usoRodada = dadosUsoDaRodada(p, {
    numero,
    titulo: p.plano?.titulo || p.titulo,
    estado: p.estado,
    inicio: p.inicio,
    fim: p.fim || new Date().toISOString(),
    plano: planoSalvo,
    status,
    chamadas,
    logsDir: logsDirAbs,
    emAndamento: false,
  }, tab, { projDir });

  const estado = /RESULTADO:\s*CONCLUIDO/i.test(summary) ? 'concluido' : (p.estado || 'concluido');

  const rodada = {
    numero,
    titulo: p.plano?.titulo || p.titulo,
    estado,
    modo: p.modo,
    modoNome: nomeModo ? nomeModo(p) : p.modo,
    velocidade: velDe ? velDe(p) : (p.velocidade || 'auto'),
    supervisao: supDe ? supDe(p) : (p.supervisao || 'automatico'),
    planejador: p.planejador || null,
    inicio: p.inicio || null,
    fim: p.fim || new Date().toISOString(),
    plano: planoSalvo,
    status,
    resumoFinal: resumoTxt,
    summary,
    logDir,
    chamadas,
    uso: {
      total: usoRodada.total,
      modelos: usoRodada.modelos,
      tarefas: usoRodada.tarefas,
    },
  };

  if (!Array.isArray(p.rodadas)) p.rodadas = [];
  p.rodadas.push(rodada);

  p.contextoRodadaPendente = contextoRodadasParaPlanejador(p);

  p.plano = null;
  p.inicio = null;
  p.fim = null;
  p.resumoFinal = null;
  p.statusHash = null;
  p.pid = null;
  p.retomadasAuto = 0;
  p.uso = { chamadas: [] };

  return rodada;
}

// ---------------------------------------------------------------------------------------------
// 6. contextoRodadasParaPlanejador
// ---------------------------------------------------------------------------------------------
export function contextoRodadasParaPlanejador(p) {
  if (!Array.isArray(p?.rodadas) || !p.rodadas.length) return '';
  const linhas = ['=== Histórico de rodadas anteriores já executadas neste projeto ==='];
  for (const r of p.rodadas) {
    if (!r || typeof r !== 'object') continue;
    const numRod = r.numero;
    const tit = r.titulo || '(sem título)';
    const est = r.estado || 'desconhecido';
    const datas = [r.inicio ? `início: ${r.inicio}` : null, r.fim ? `fim: ${r.fim}` : null].filter(Boolean).join(', ');
    linhas.push(`\n## Rodada ${numRod}: ${tit} [Estado: ${est}${datas ? ` | ${datas}` : ''}]`);

    const tarefas = Array.isArray(r.plano?.tarefas) ? r.plano.tarefas : [];
    if (tarefas.length > 0) {
      const st = r.status || {};
      const tfsInfo = tarefas.map((t) => {
        const rawState = st[t.id]?.state || (st[t.id] ? 'done' : 'pendente');
        const state = rawState === 'done' ? 'concluída' : rawState;
        return `${t.id} (${t.titulo || t.id}): ${state}`;
      });
      linhas.push(`Tarefas: ${tfsInfo.join('; ')}`);
    }

    if (r.resumoFinal) {
      linhas.push(`Resumo da entrega:\n${String(r.resumoFinal).trim()}`);
    } else if (r.summary) {
      linhas.push(`Resumo da execução:\n${String(r.summary).trim()}`);
    }
  }
  linhas.push('\nAs rodadas acima já foram executadas no repositório. Planeje apenas o que falta para atender à nova mensagem do usuário, sem refazer o que já foi entregue.');
  return linhas.join('\n');
}

// ---------------------------------------------------------------------------------------------
// 7. migrarRodadas
// ---------------------------------------------------------------------------------------------
function promptMigrado(logDirOrigem, id, tk) {
  let txt = null;
  try { txt = fs.readFileSync(path.join(logDirOrigem, `${id}.prompt.md`), 'utf8'); } catch { txt = null; }
  if (typeof txt === 'string' && txt.trim()) {
    const linhas = txt.replace(/\r\n/g, '\n').split('\n');
    while (linhas.length && !linhas[linhas.length - 1].trim()) linhas.pop();
    const ultima = (linhas[linhas.length - 1] || '').trim();
    if (/^\(Projeto Delegar/.test(ultima)) linhas.pop();
    while (linhas.length && !linhas[linhas.length - 1].trim()) linhas.pop();
    return linhas.join('\n').trim();
  }
  return typeof tk?.prompt === 'string' ? tk.prompt : '';
}

export function migrarRodadas(p, { projDir, dataDir, tabela, gravar = true } = {}) {
  if (Array.isArray(p?.rodadas) && p.rodadas.length > 0) {
    return { migrado: false, gravado: false, rodadas: p.rodadas };
  }
  const pastaRodadas = projDir ? path.join(projDir, 'rodadas') : null;
  let dirs = [];
  if (pastaRodadas && fs.existsSync(pastaRodadas)) {
    try {
      dirs = fs.readdirSync(pastaRodadas, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
        .map((d) => ({ numero: Number(d.name), caminho: path.join(pastaRodadas, d.name) }))
        .sort((a, b) => a.numero - b.numero);
    } catch { dirs = []; }
  }
  if (!dirs.length) {
    return { migrado: false, gravado: false, rodadas: [] };
  }

  const tab = tabela || carregarPrecos({ dataDir });
  const podeGravar = !!gravar && p.estado !== 'executando' && !p.ocupado;
  const criadas = [];

  let poolChamadas = Array.isArray(p.uso?.chamadas) && p.uso.chamadas.length > 0
    ? [...p.uso.chamadas]
    : null;

  for (const dirInfo of dirs) {
    const numero = dirInfo.numero;
    const projSnap = lerJson(path.join(dirInfo.caminho, 'project.json')) || {};
    const planSnap = lerJson(path.join(dirInfo.caminho, 'plan.json')) || {};
    const statusSnap = lerJson(path.join(dirInfo.caminho, 'logs', 'status.json')) || {};
    let summarySnap = '';
    try { summarySnap = fs.readFileSync(path.join(dirInfo.caminho, 'logs', 'summary.md'), 'utf8'); } catch { summarySnap = ''; }

    const snapTarefas = Array.isArray(projSnap?.plano?.tarefas) ? projSnap.plano.tarefas : [];
    const planTasks = Array.isArray(planSnap?.tasks) ? planSnap.tasks : [];
    const snapIds = snapTarefas.map((t) => String(t.id));
    const planIds = planTasks.map((t) => String(t.id));
    const idsBatem = snapIds.length === planIds.length && snapIds.every((id, idx) => id === planIds[idx]);

    let plano = null;
    let titulo = projSnap.titulo || `Rodada ${numero}`;
    let resumo = projSnap.resumoFinal || '';

    const fimMs = projSnap.fim ? paraMs(projSnap.fim) : null;

    if (idsBatem && snapTarefas.length > 0) {
      plano = JSON.parse(JSON.stringify(projSnap.plano));
      for (const t of plano.tarefas) {
        const tk = planTasks.find((x) => String(x.id) === String(t.id));
        t.cadeiaEfetiva = Array.isArray(tk?.chain) ? tk.chain : (Array.isArray(t.chain) ? t.chain : []);
      }
    } else {
      const tarefas = [];
      for (let i = 0; i < planTasks.length; i++) {
        const tk = planTasks[i];
        if (!tk || typeof tk !== 'object') continue;
        const id = tk.id != null ? String(tk.id) : String(i + 1);
        tarefas.push({
          id,
          titulo: tk.titulo || '',
          tipo: tk.worktree ? 'escritor' : (((Array.isArray(tk.after) && tk.after.length) || (Array.isArray(tk.removeWorktrees) && tk.removeWorktrees.length)) ? 'integrador' : 'tarefa'),
          nivel: tk.main ? 'pesado' : 'volume',
          cadeiaEfetiva: Array.isArray(tk.chain) ? tk.chain : [],
          depende: Array.isArray(tk.after) ? tk.after : [],
          confirmar: !!tk.confirm,
          motivo: typeof tk.reason === 'string' ? tk.reason : '',
          prompt: promptMigrado(path.join(dirInfo.caminho, 'logs'), id, tk),
        });
      }
      plano = {
        name: planSnap.name || String(projSnap.id || ''),
        repo: projSnap.repo || '',
        tarefas,
        verify: Array.isArray(planSnap.verify) ? planSnap.verify : [],
        maxConcurrent: planSnap.maxConcurrent || 2,
      };

      const msgs = Array.isArray(projSnap.mensagens) ? projSnap.mensagens : [];
      const primeiraPlan = msgs.find((m) => m && m.papel === 'planejador' && typeof m.texto === 'string' && m.texto.trim() && (m.quando && fimMs !== null ? paraMs(m.quando) <= fimMs : true));
      if (primeiraPlan) {
        // o título fica o do projeto: a primeira fala do planejador é conversa, não título
        resumo = primeiraPlan.texto.trim();
      }
    }

    const inicio = projSnap.inicio || null;
    const fim = projSnap.fim || null;
    const estado = /RESULTADO:\s*CONCLUIDO/i.test(summarySnap) ? 'concluido'
      : (projSnap.estado && projSnap.estado !== 'plano_pronto' ? projSnap.estado : 'concluido');
    const resumoFinal = projSnap.resumoFinal || '';

    const chamadasFonte = (Array.isArray(poolChamadas) && poolChamadas.length > 0)
      ? poolChamadas
      : (Array.isArray(projSnap?.uso?.chamadas) ? projSnap.uso.chamadas : []);

    const chamadasRodada = [];
    const chamadasRestantes = [];
    for (const ch of chamadasFonte) {
      if (!ch || typeof ch !== 'object') continue;
      const q = paraMs(ch.quando);
      if (q !== null && fimMs !== null) {
        if (q <= fimMs + 60000) chamadasRodada.push({ ...ch, rodada: numero });
        else chamadasRestantes.push(ch);
      } else {
        chamadasRodada.push({ ...ch, rodada: numero });
      }
    }
    poolChamadas = chamadasRestantes;

    let logDir = '';
    let logsDirParaUso = '';
    if (podeGravar) {
      logDir = `logs/rodada-${numero}`;
      const dest = path.join(projDir, 'logs', `rodada-${numero}`);
      copyDir(path.join(dirInfo.caminho, 'logs'), dest);
      try {
        if (fs.existsSync(path.join(dirInfo.caminho, 'plan.json'))) {
          fs.copyFileSync(path.join(dirInfo.caminho, 'plan.json'), path.join(dest, 'plan.json'));
        }
      } catch {}
      logsDirParaUso = dest;
    } else {
      logDir = `rodadas/${numero}/logs`;
      logsDirParaUso = path.join(dirInfo.caminho, 'logs');
    }

    const usoRodada = dadosUsoDaRodada(p, {
      numero,
      titulo,
      estado,
      inicio,
      fim,
      plano,
      status: statusSnap,
      chamadas: chamadasRodada,
      logsDir: logsDirParaUso,
      emAndamento: false,
    }, tab, { projDir });

    criadas.push({
      numero,
      titulo,
      estado,
      resumo,
      modo: projSnap.modo,
      modoNome: projSnap.modoNome || projSnap.modo,
      velocidade: projSnap.velocidade || null,
      supervisao: projSnap.supervisao || null,
      planejador: projSnap.planejador || null,
      inicio,
      fim,
      plano,
      status: statusSnap || {},
      resumoFinal,
      summary: summarySnap,
      logDir,
      chamadas: chamadasRodada,
      uso: {
        total: usoRodada.total,
        modelos: usoRodada.modelos,
        tarefas: usoRodada.tarefas,
      },
    });
  }

  if (podeGravar) {
    if (!Array.isArray(p.rodadas)) p.rodadas = [];
    p.rodadas.push(...criadas);
    p.uso = { chamadas: poolChamadas || [] };
    try {
      const arquivo = path.join(projDir, 'project.json');
      const tmp = `${arquivo}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(p, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, arquivo);
    } catch {}
    return { migrado: true, gravado: true, rodadas: p.rodadas };
  } else {
    if (!Array.isArray(p.rodadas)) p.rodadas = [];
    p.rodadas.push(...criadas);
    p.uso = { chamadas: poolChamadas || [] };
    return {
      migrado: true,
      gravado: false,
      motivo: p.estado === 'executando' ? 'execução em andamento' : 'somente leitura',
      rodadas: p.rodadas,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// 8. dadosUsoProjetoComRodadas
// ---------------------------------------------------------------------------------------------
export function dadosUsoProjetoComRodadas(p, { projDir, dataDir, tabela, usoAgyReal } = {}) {
  const tab = tabela || carregarPrecos({ dataDir });

  if ((!Array.isArray(p?.rodadas) || !p.rodadas.length) && projDir) {
    try {
      if (fs.existsSync(path.join(projDir, 'rodadas'))) {
        migrarRodadas(p, { projDir, dataDir, tabela: tab, gravar: p.estado !== 'executando' && !p.ocupado });
      }
    } catch {}
  }

  const rodadasCalculadas = [];
  for (const r of Array.isArray(p?.rodadas) ? p.rodadas : []) {
    if (!r || typeof r !== 'object') continue;
    const logPathRel = r.logDir || ('logs/rodada-' + r.numero);
    const logPathAbs = projDir ? path.resolve(projDir, logPathRel) : logPathRel;
    if (logPathAbs && fs.existsSync(logPathAbs)) {
      const u = dadosUsoDaRodada(p, {
        numero: r.numero,
        titulo: r.titulo,
        estado: r.estado,
        inicio: r.inicio,
        fim: r.fim,
        plano: r.plano,
        status: r.status,
        chamadas: Array.isArray(r.chamadas) ? r.chamadas : [],
        logsDir: logPathAbs,
        emAndamento: false,
      }, tab, { projDir, usoAgyReal });
      rodadasCalculadas.push({
        numero: r.numero,
        titulo: r.titulo,
        estado: r.estado,
        inicio: r.inicio,
        fim: r.fim,
        emAndamento: false,
        total: u.total,
        modelos: u.modelos,
        tarefas: u.tarefas,
      });
    } else if (r.uso && typeof r.uso === 'object') {
      rodadasCalculadas.push({
        numero: r.numero,
        titulo: r.titulo,
        estado: r.estado,
        inicio: r.inicio,
        fim: r.fim,
        emAndamento: false,
        total: r.uso.total || { entrada: 0, saida: 0, cacheLido: 0, cacheGravado: 0, usd: 0, brl: 0, aproximado: false, origem: 'cli' },
        modelos: Array.isArray(r.uso.modelos) ? r.uso.modelos : [],
        tarefas: Array.isArray(r.uso.tarefas) ? r.uso.tarefas : [],
      });
    }
  }

  const temRodadaAtual = Boolean(p?.plano) ||
    (Array.isArray(p?.uso?.chamadas) && p.uso.chamadas.length > 0) ||
    p?.estado === 'executando' ||
    (!Array.isArray(p?.rodadas) || p.rodadas.length === 0);

  if (temRodadaAtual) {
    const numAtual = rodadasCalculadas.length + 1;
    const logsAtual = projDir ? path.join(projDir, 'logs') : '';
    let stAtual = {};
    if (logsAtual && fs.existsSync(path.join(logsAtual, 'status.json'))) {
      stAtual = lerJson(path.join(logsAtual, 'status.json')) || {};
    }
    const uAtual = dadosUsoDaRodada(p, {
      numero: numAtual,
      titulo: p?.plano?.titulo || p?.titulo,
      estado: p?.estado,
      inicio: p?.inicio,
      fim: p?.fim,
      plano: p?.plano || null,
      status: stAtual,
      chamadas: Array.isArray(p?.uso?.chamadas) ? p.uso.chamadas : [],
      logsDir: logsAtual,
      emAndamento: p?.estado === 'executando',
    }, tab, { projDir, usoAgyReal });

    rodadasCalculadas.push({
      numero: numAtual,
      titulo: p?.plano?.titulo || p?.titulo,
      estado: p?.estado,
      inicio: p?.inicio,
      fim: p?.fim,
      emAndamento: p?.estado === 'executando',
      total: uAtual.total,
      modelos: uAtual.modelos,
      tarefas: uAtual.tarefas,
    });
  }

  const projTotal = { entrada: 0, saida: 0, cacheLido: 0, cacheGravado: 0, usd: 0, brl: 0, aproximado: false, origem: 'cli' };
  const projOrigens = [];
  const modelosMap = new Map();

  for (const rc of rodadasCalculadas) {
    projTotal.entrada += rc.total.entrada || 0;
    projTotal.saida += rc.total.saida || 0;
    projTotal.cacheLido += rc.total.cacheLido || 0;
    projTotal.cacheGravado += rc.total.cacheGravado || 0;
    if (rc.total.usd !== null && rc.total.usd !== undefined) projTotal.usd += rc.total.usd;
    if (rc.total.origem) projOrigens.push(rc.total.origem);

    for (const tf of rc.tarefas) {
      for (const tent of tf.tentativas || []) {
        const linhas = Array.isArray(tent.porModelo) && tent.porModelo.length ? tent.porModelo : [{
          provedor: tent.provedor,
          modelo: tent.modelo,
          entrada: tent.entrada,
          saida: tent.saida,
          cacheLido: tent.cacheLido,
          cacheGravado: tent.cacheGravado,
          usd: tent.usd,
          origem: tent.origem,
        }];
        for (const l of linhas) {
          if (!temConsumoReal(l)) continue;
          const chave = chaveAgrupamentoModelo(l.provedor, l.modelo);
          let mEntry = modelosMap.get(chave);
          if (!mEntry) {
            mEntry = {
              provedor: l.provedor,
              modelo: l.modelo,
              entrada: 0,
              saida: 0,
              cacheLido: 0,
              cacheGravado: 0,
              usd: 0,
              origens: [],
              fontes: [],
              assinatura: assinaturaDe(l.provedor),
            };
            modelosMap.set(chave, mEntry);
          }
          const canônico = chave.slice(chave.indexOf(':') + 1);
          if (String(l.modelo ?? '').toLowerCase() === canônico.toLowerCase()
            && String(mEntry.modelo ?? '').toLowerCase() !== canônico.toLowerCase()) {
            mEntry.modelo = l.modelo;
          }
          mEntry.entrada += l.entrada || 0;
          mEntry.saida += l.saida || 0;
          mEntry.cacheLido += l.cacheLido || 0;
          mEntry.cacheGravado += l.cacheGravado || 0;
          mEntry.origens.push(l.origem || tent.origem);
          mEntry.fontes.push(tent.fonte);
          if (l.usd !== null && l.usd !== undefined) mEntry.usd += l.usd;
        }
      }
    }

    if (rc.tarefas.length === 0 || !rc.tarefas.some((tf) => tf.tentativas?.length > 0)) {
      for (const m of rc.modelos || []) {
        if (!temConsumoReal(m)) continue;
        const chave = chaveAgrupamentoModelo(m.provedor, m.modelo);
        let mEntry = modelosMap.get(chave);
        if (!mEntry) {
          mEntry = {
            provedor: m.provedor,
            modelo: m.modelo,
            entrada: 0,
            saida: 0,
            cacheLido: 0,
            cacheGravado: 0,
            usd: 0,
            origens: [],
            fontes: [],
            assinatura: assinaturaDe(m.provedor),
          };
          modelosMap.set(chave, mEntry);
        }
        const canônico = chave.slice(chave.indexOf(':') + 1);
        if (String(m.modelo ?? '').toLowerCase() === canônico.toLowerCase()
          && String(mEntry.modelo ?? '').toLowerCase() !== canônico.toLowerCase()) {
          mEntry.modelo = m.modelo;
        }
        mEntry.entrada += m.entrada || 0;
        mEntry.saida += m.saida || 0;
        mEntry.cacheLido += m.cacheLido || 0;
        mEntry.cacheGravado += m.cacheGravado || 0;
        if (m.origem) mEntry.origens.push(m.origem);
        if (m.usd !== null && m.usd !== undefined) mEntry.usd += m.usd;
      }
    }
  }

  projTotal.usd = arred(projTotal.usd);
  projTotal.brl = projTotal.usd !== null ? emBrl(tab, projTotal.usd) : null;
  projTotal.origem = piorOrigem(projOrigens);
  projTotal.aproximado = projOrigens.some((o) => o === 'aproximado' || o === 'estimado');

  const modelosOut = consolidarListaModelos(Array.from(modelosMap.values()).map((m) => {
    const usd = arred(m.usd);
    return {
      provedor: m.provedor,
      modelo: m.modelo,
      entrada: m.entrada,
      saida: m.saida,
      cacheLido: m.cacheLido,
      cacheGravado: m.cacheGravado,
      usd,
      brl: usd !== null ? emBrl(tab, usd) : null,
      origem: piorOrigem(m.origens),
      assinatura: m.assinatura,
      estimado: m.origens.some((o) => o === 'estimado') || m.fontes.some((f) => f === 'estimado'),
    };
  }))
    .map((x) => ({ ...x, brl: x.usd !== null ? emBrl(tab, x.usd) : null }))
    .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0) || (b.entrada + b.saida) - (a.entrada + a.saida));

  const tarefasOut = rodadasCalculadas.length === 1
    ? rodadasCalculadas[0].tarefas
    : rodadasCalculadas.flatMap((r) => r.tarefas.map((tf) => ({ ...tf, rodada: r.numero })));

  return {
    emAndamento: rodadasCalculadas.some((r) => r.emAndamento),
    total: projTotal,
    modelos: modelosOut,
    tarefas: tarefasOut,
    rodadas: rodadasCalculadas.map((r) => ({
      numero: r.numero,
      titulo: r.titulo,
      estado: r.estado,
      inicio: r.inicio,
      fim: r.fim,
      emAndamento: r.emAndamento,
      total: r.total,
      modelos: r.modelos,
      tarefas: r.tarefas,
    })),
  };
}
