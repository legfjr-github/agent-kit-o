// Perfis personalizados com nome do painel Delegar (DATA/perfis.json).
// Só node:fs e node:path. O servidor é um processo único, então fs síncrono basta.
import fs from 'node:fs';
import path from 'node:path';

export const MAX_PERFIS = 50;
const MAX_BYTES = 1024 * 1024;
const NOME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._()+-]*$/u;
const RESERVADOS = new Set(['constructor', 'prototype', 'hasownproperty', 'tostring', 'valueof', '__proto__']);

export function validarNome(nome) {
  if (typeof nome !== 'string') return { ok: false, erro: 'o nome do perfil precisa ser texto' };
  const n = nome.trim().normalize('NFC');
  const tam = Array.from(n).length;
  if (tam < 1) return { ok: false, erro: 'informe o nome do perfil' };
  if (tam > 60) return { ok: false, erro: 'nome com mais de 60 caracteres' };
  if (!NOME_RE.test(n)) return { ok: false, erro: 'nome com caractere não permitido (use letras, números, espaço e . _ ( ) + -)' };
  if (n.includes('  ')) return { ok: false, erro: 'nome com dois espaços seguidos' };
  if (RESERVADOS.has(n.toLowerCase())) return { ok: false, erro: 'nome reservado, escolha outro' };
  return { ok: true, nome: n };
}

const chave = (n) => n.toLowerCase();
const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const dataOk = (s) => typeof s === 'string' && s.length <= 40 && !Number.isNaN(Date.parse(s));

export function criarPerfis({ arquivo, validar }) {
  // Lê o arquivo do disco a cada chamada. Devolve { perfis, aviso, ruim }.
  function carregar() {
    let st;
    try { st = fs.statSync(arquivo); } catch (e) {
      if (e && e.code === 'ENOENT') return { perfis: [], aviso: null, ruim: false };
      return { perfis: [], aviso: 'não foi possível ler perfis.json', ruim: false };
    }
    if (!st.isFile()) return { perfis: [], aviso: 'perfis.json não é um arquivo regular', ruim: true };
    if (st.size > MAX_BYTES) return { perfis: [], aviso: 'perfis.json maior que 1 MB foi ignorado', ruim: true };
    let dados;
    try { dados = JSON.parse(fs.readFileSync(arquivo, 'utf8')); } catch {
      return { perfis: [], aviso: 'perfis.json ilegível (JSON inválido) foi ignorado', ruim: true };
    }
    if (!ehObjeto(dados) || dados.versao !== 1 || !Array.isArray(dados.perfis)) {
      return { perfis: [], aviso: 'perfis.json com formato desconhecido foi ignorado', ruim: true };
    }
    const agora = new Date().toISOString();
    const vistos = new Set();
    const perfis = [];
    let ignoradas = 0;
    for (const e of dados.perfis) {
      if (!ehObjeto(e) || perfis.length >= MAX_PERFIS) { ignoradas++; continue; }
      const vn = validarNome(e.nome);
      if (!vn.ok || vistos.has(chave(vn.nome))) { ignoradas++; continue; }
      let r;
      try { r = validar(e.custom); } catch { r = null; }
      if (!r || !Array.isArray(r.errs) || r.errs.length || !ehObjeto(r.custom)) { ignoradas++; continue; }
      vistos.add(chave(vn.nome));
      const criado = dataOk(e.criado) ? e.criado : (dataOk(e.atualizado) ? e.atualizado : agora);
      const atualizado = dataOk(e.atualizado) ? e.atualizado : criado;
      perfis.push({ nome: vn.nome, custom: r.custom, criado, atualizado });
    }
    const aviso = ignoradas ? `${ignoradas} perfil(is) inválido(s) em perfis.json ${ignoradas === 1 ? 'foi ignorado' : 'foram ignorados'}` : null;
    return { perfis, aviso, ruim: false };
  }

  function preservarRuim() {
    const ts = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const base = `${arquivo}.corrompido-${ts}`;
    let destino = base;
    for (let i = 1; fs.existsSync(destino); i++) destino = `${base}-${i}`;
    fs.renameSync(arquivo, destino);
  }

  function gravar(estado, perfis) {
    fs.mkdirSync(path.dirname(arquivo), { recursive: true });
    if (estado.ruim) preservarRuim();
    const tmp = `${arquivo}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ versao: 1, perfis }, null, 2), 'utf8');
      fs.renameSync(tmp, arquivo);
    } finally {
      try { fs.rmSync(tmp, { force: true }); } catch { /* nada a limpar */ }
    }
  }

  const copia = (p) => structuredClone(p);

  return {
    listar() {
      return carregar().perfis
        .map(({ nome, custom, criado, atualizado }) => copia({ nome, custom, criado, atualizado }))
        .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    },
    obter(nome) {
      const vn = validarNome(nome);
      if (!vn.ok) return null;
      const p = carregar().perfis.find((x) => chave(x.nome) === chave(vn.nome));
      return p ? copia(p) : null;
    },
    salvar(nome, cfg, { sobrescrever = false } = {}) {
      const vn = validarNome(nome);
      if (!vn.ok) return { ok: false, status: 400, erro: vn.erro };
      let r;
      try { r = validar(cfg); } catch { r = { errs: ['configuração inválida'] }; }
      if (!r || !Array.isArray(r.errs)) return { ok: false, status: 400, erro: 'configuração inválida' };
      if (r.errs.length) return { ok: false, status: 400, erro: r.errs.join('; ') };
      if (!ehObjeto(r.custom)) return { ok: false, status: 400, erro: 'configuração inválida' };
      const estado = carregar();
      const idx = estado.perfis.findIndex((x) => chave(x.nome) === chave(vn.nome));
      const agora = new Date().toISOString();
      if (idx >= 0) {
        if (!sobrescrever) return { ok: false, status: 409, erro: 'já existe um perfil com esse nome' };
        const perfil = { nome: vn.nome, custom: r.custom, criado: estado.perfis[idx].criado, atualizado: agora };
        estado.perfis[idx] = perfil;
        gravar(estado, estado.perfis);
        return { ok: true, perfil: copia(perfil), criado: false };
      }
      if (estado.perfis.length >= MAX_PERFIS) return { ok: false, status: 400, erro: `limite de ${MAX_PERFIS} perfis` };
      const perfil = { nome: vn.nome, custom: r.custom, criado: agora, atualizado: agora };
      gravar(estado, [...estado.perfis, perfil]);
      return { ok: true, perfil: copia(perfil), criado: true };
    },
    renomear(de, para) {
      const a = validarNome(de);
      if (!a.ok) return { ok: false, status: 400, erro: a.erro };
      const b = validarNome(para);
      if (!b.ok) return { ok: false, status: 400, erro: b.erro };
      const estado = carregar();
      const idx = estado.perfis.findIndex((x) => chave(x.nome) === chave(a.nome));
      if (idx < 0) return { ok: false, status: 404, erro: 'perfil não encontrado' };
      if (chave(a.nome) !== chave(b.nome) && estado.perfis.some((x) => chave(x.nome) === chave(b.nome))) {
        return { ok: false, status: 409, erro: 'já existe um perfil com esse nome' };
      }
      const perfil = { ...estado.perfis[idx], nome: b.nome, atualizado: new Date().toISOString() };
      estado.perfis[idx] = perfil;
      gravar(estado, estado.perfis);
      return { ok: true, perfil: copia(perfil) };
    },
    excluir(nome) {
      const vn = validarNome(nome);
      if (!vn.ok) return { ok: false, status: 400, erro: vn.erro };
      const estado = carregar();
      const idx = estado.perfis.findIndex((x) => chave(x.nome) === chave(vn.nome));
      if (idx < 0) return { ok: false, status: 404, erro: 'perfil não encontrado' };
      gravar(estado, estado.perfis.filter((_, i) => i !== idx));
      return { ok: true };
    },
    aviso() {
      return carregar().aviso;
    },
  };
}
