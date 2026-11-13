#!/usr/bin/env node
// CLI do Delegar. Uso:
//   node cli.mjs iniciar                         sobe o painel (se não estiver no ar) e mostra o endereço
//   node cli.mjs novo --repo <pasta> [--modo padrao|equilibrado|agressivo|desespero|personalizado]
//        [--personalizado modo.json | --perfil <nome>] [--velocidade auto|rapido|medio|demorado] [--acompanhamento automatico|acompanhado|passo] [--auto] [--titulo T] "pedido"
//   node cli.mjs msg <id> "texto"                conversa com o planejador
//   node cli.mjs plano <id>                      pede o plano final
//   node cli.mjs ver <id>                        mostra conversa recente, plano e estado
//   node cli.mjs modo <id> <modo> [--personalizado modo.json]   troca o modo antes de aprovar
//   node cli.mjs modo <id> --perfil <nome>       aplica um perfil salvo ao projeto
//   node cli.mjs perfis                          lista os perfis salvos (nome, primeiro modelo do planejador, data)
//   node cli.mjs perfis salvar <nome> --personalizado modo.json [--sobrescrever]   salva um perfil (nome repetido dá erro sem --sobrescrever)
//   node cli.mjs perfis renomear <de> <para> | perfis excluir <nome>
//   node cli.mjs acompanhamento <id> <automatico|acompanhado|passo>   vale também durante a execução
//   node cli.mjs velocidade <id> <auto|rapido|medio|demorado>   troca a velocidade antes de aprovar
//   node cli.mjs aprovar <id> | retomar <id> | cancelar <id>
//   node cli.mjs confirmar <id> <confirmação> [sim|nao]   responde a uma parada do modo acompanhado
//   node cli.mjs atividade [id]                  quem está fazendo o quê agora e as últimas atualizações
//   node cli.mjs modelos [--atualizar]           provedores instalados, modelos (novos marcados com [novo]) e a ordem do modo desespero;
//                                                --atualizar lê de novo as listas do agy e do opencode agora
//   node cli.mjs cotas [--atualizar]             restante de cada cota (5 h e semanal) e quando renova; --atualizar lê de novo agora (20 a 40 s)
//   node cli.mjs uso [id] [--periodo hoje|7d|30d|tudo]   tokens e custos por modelo e tarefa (ou geral se sem id)
//   node cli.mjs precos [--atualizar]            tabela de preços por milhão de tokens; --atualizar baixa da fonte agora
//   node cli.mjs arquivar <id> | desarquivar <id>   tira o projeto da lista (ou devolve)
//   node cli.mjs excluir <id>                    move a pasta do projeto para a lixeira (DATA/lixeira); não toca no repositório
//   node cli.mjs status [--todos]                lista os projetos; --todos inclui os arquivados
//   node cli.mjs esperar <id> [minutos]          espera o planejador responder, uma confirmação ou o fim da execução
// O pedido também pode vir de um arquivo: --arquivo <caminho>.
// modo.json (personalizado): {"planner":[...],"tiers":{"pesado":[...],"volume":[...],"leve":[...]},"fix":[...],"coord":[...],"maxConcurrent":2}
// Cada modelo é "provedor:modelo[@esforço]", provedor = claude | agy | opencode.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DELEGAR_PORT) || 8790;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = process.env.DELEGAR_DATA || path.join(os.homedir(), '.delegar');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function up() { try { return (await fetch(BASE + '/api/saude')).ok; } catch { return false; } }
async function ensure() {
  if (await up()) return;
  fs.mkdirSync(DATA, { recursive: true });
  const log = fs.openSync(path.join(DATA, 'server.log'), 'a');
  const ch = spawn(process.execPath, [path.join(HERE, 'server.mjs')], { detached: true, stdio: ['ignore', log, log], windowsHide: true });
  ch.unref();
  for (let i = 0; i < 30; i++) {
    await sleep(300);
    if (await up()) {
      if (!process.env.DELEGAR_LANCADOR) console.error('Aviso: o painel foi aberto por este comando. Se ele rodou dentro de uma sessão de agente, o painel cai quando a sessão ou o app fechar. Para ficar no ar, abra pelo atalho "Orquestrador de IA (Delegar)" (iniciar-painel.bat).');
      return;
    }
  }
  throw new Error('o painel não subiu; veja ' + path.join(DATA, 'server.log'));
}
const token = () => fs.readFileSync(path.join(DATA, 'token'), 'utf8').trim();
async function call(method, url, body) {
  await ensure();
  const r = await fetch(BASE + url, { method, headers: { 'X-Delegar-Token': token(), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.erro || r.statusText);
  return j;
}
function opts(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--auto') o.auto = true;
    else if (a === '--todos') o.todos = true;
    else if (a === '--sobrescrever') o.sobrescrever = true;
    else if (a === '--atualizar') o.atualizar = true;
    else if (a.startsWith('--')) o[a.slice(2)] = argv[++i];
    else o._.push(a);
  }
  return o;
}
const lerCustom = (f) => (f ? JSON.parse(fs.readFileSync(f, 'utf8')) : undefined);
const TAREFA = { pending: 'na fila', waiting: 'aguardando confirmação', running: 'rodando', done: 'concluída', failed: 'falhou', skipped: 'pulada' };

function mostrar(p, n = 3) {
  console.log(`${p.titulo}\n  id: ${p.id}\n  estado: ${p.estado}${p.ocupado ? ' (planejador pensando)' : ''} · modo: ${p.modoNome} · velocidade: ${p.velocidade || 'auto'} · acompanhamento: ${p.supervisao}${p.auto ? ' · automático' : ''}${p.run?.desespero ? ' · MODO DESESPERO' : ''}\n  planejador: ${p.planejador || (p.plannerEfetivo || [])[0] || '-'}\n  repo: ${p.repo}\n  painel: ${BASE}/#${p.id}`);
  for (const m of (p.mensagens || []).slice(-n)) console.log(`\n[${m.papel}${m.modelo ? ' ' + m.modelo : ''}] ${m.texto}`);
  if (p.plano) {
    console.log(`\nPlano: ${p.plano.resumo || ''}`);
    for (const t of p.plano.tarefas) {
      const s = p.run?.status?.[t.id];
      console.log(`  - ${t.id} [${t.tipo}/${t.nivel}${t.esforco ? '/' + t.esforco : ''}${t.confirmar ? '/confirmar' : ''}] ${t.titulo || ''} :: ${t.cadeiaEfetiva.join(' > ')}${t.depende.length ? ' :: depende ' + t.depende.join(',') : ''}${s ? ' :: ' + (TAREFA[s.state] || s.state) + (s.model ? ' (' + s.model + ')' : '') : ''}`);
    }
  }
  for (const g of p.run?.gates || []) console.log(`\n>> CONFIRMAÇÃO PENDENTE [${g.gate}]: ${g.motivo}\n   node cli.mjs confirmar ${p.id} ${g.gate} sim|nao`);
  if (p.relatorio) console.log(`\nRelatório no cofre: ${p.relatorio}`);
}
function mostrarAtividade(a) {
  console.log(`\n== ${a.titulo} (${a.id})\n   modo ${a.modo} · acompanhamento ${a.supervisao}${a.desespero ? ' · MODO DESESPERO' : ''}`);
  for (const g of a.gates) console.log(`   >> confirmação pendente [${g.gate}]: ${g.motivo}`);
  if (!a.rodando.length) console.log('   nada rodando agora');
  for (const r of a.rodando) console.log(`   * ${r.id} ${TAREFA[r.estado] || r.estado} ${r.modelo || ''}${r.desde ? ' desde ' + r.desde : ''}${r.agora?.acao ? '\n     -> ' + r.agora.acao : ''}`);
  console.log('   últimas atualizações:');
  for (const e of a.eventos.slice(-12)) console.log(`     ${e.time.slice(11, 19)} ${e.tarefa || ''} ${e.modelo || ''} ${e.texto || e.tipo}`.replace(/\s+/g, ' '));
  if (a.commits.length) { console.log('   commits recentes:'); for (const c of a.commits.slice(0, 4)) console.log(`     ${c.hash} ${c.quando} ${c.assunto}`); }
}

const pad2 = (n) => String(n).padStart(2, '0');
const hora = (iso) => { const x = new Date(iso); return isNaN(x) ? '-' : `${pad2(x.getHours())}:${pad2(x.getMinutes())}`; };
function emQuanto(iso) {
  const ms = new Date(iso) - Date.now();
  if (isNaN(ms)) return '';
  if (ms <= 0) return 'já renovou';
  const min = Math.round(ms / 60000);
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `em ${h} h ${m} min` : `em ${m} min`;
}
// Recebe o corpo de GET /api/cotas ou POST /api/cotas/atualizar e devolve o texto da tabela.
export function formatarCotas(dados) {
  const d = dados || {};
  const out = [];
  if (d.erro) out.push(`Erro: ${d.erro}`);
  out.push(d.lidoEm ? `Última leitura: ${hora(d.lidoEm)}${d.idadeMin != null ? ` (há ${d.idadeMin} min)` : ''}` : 'Nenhuma leitura de cotas ainda.');
  if (d.lendo) out.push('leitura em andamento; rode de novo em ~30 s');
  const linhas = d.linhas || [];
  if (!linhas.length) out.push('Nenhuma cota para mostrar.');
  else {
    const tabela = [['Cota', 'Restante', 'Renova', 'Lida em', 'Fonte/nota']];
    for (const l of linhas) {
      let restante = !l.instalado ? 'não instalado' : l.restante == null ? '-' : `${Math.round(l.restante * 100)}%`;
      if (l.semCota) restante += ' SEM COTA';
      const renova = l.renovaEm ? `${new Date(l.renovaEm).toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} (${emQuanto(l.renovaEm)})` : '-';
      tabela.push([
        l.nome + (l.janela ? ` (${l.janela})` : ''),
        restante,
        renova,
        l.lidoEm ? hora(l.lidoEm) : '-',
        [l.fonte, l.nota].filter(Boolean).join(' · ') || '-',
      ]);
    }
    const larg = tabela[0].map((_, i) => Math.max(...tabela.map((r) => r[i].length)));
    for (const r of tabela) out.push(r.map((c, i) => c.padEnd(larg[i])).join('  ').trimEnd());
  }
  if (d.aviso) out.push(`Aviso: ${d.aviso}`);
  return out.join('\n');
}

const fmtTokens = (n) => (n == null || !Number.isFinite(n) ? '-' : (n).toLocaleString('pt-BR'));
const fmtUsd = (v) => (v == null || !Number.isFinite(v) ? '-' : (v > 0 && v < 0.01 ? v.toLocaleString('pt-BR', { minimumFractionDigits: 4, maximumFractionDigits: 4 }) : v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })));
const fmtBrl = (v) => (v == null || !Number.isFinite(v) ? '-' : (v > 0 && v < 0.01 ? v.toLocaleString('pt-BR', { minimumFractionDigits: 4, maximumFractionDigits: 4 }) : v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })));
const formatarData = (iso) => {
  if (!iso) return '-';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? String(iso) : d.toLocaleDateString('pt-BR');
};
const alinharTabela = (matriz) => {
  if (!matriz.length) return [];
  const larg = matriz[0].map((_, i) => Math.max(...matriz.map((r) => (r[i] != null ? String(r[i]) : '').length)));
  return matriz.map((r) => r.map((c, i) => (c != null ? String(c) : '').padEnd(larg[i])).join('  ').trimEnd());
};
const NOTA_ASSINATURA = 'Claude Code e Antigravity sao assinaturas: valores sao o equivalente em API.';
const TAREFA_NOMES = { pending: 'na fila', waiting: 'aguardando confirmação', running: 'rodando', done: 'concluída', failed: 'falhou', skipped: 'pulada' };

export function formatarPrecos(dados) {
  const d = dados || {};
  const out = [];
  const atualizado = formatarData(d.atualizado);
  const idade = d.idadeDias != null ? ` (há ${d.idadeDias} dias)` : '';
  const fonte = d.fonte ? ` · fonte: ${d.fonte}` : '';
  const usdBrl = d.usdBrl != null ? ` · US$ 1 = R$ ${fmtBrl(d.usdBrl)}` : '';
  out.push(`Tabela de preços: ${atualizado}${idade}${fonte}${usdBrl}`);

  const modelos = Object.entries(d.modelos || {});
  if (!modelos.length) {
    out.push('Nenhum preço para mostrar.');
  } else {
    const cabecalho = ['Modelo', 'US$/M entrada', 'Saída', 'Cache lido', 'Cache gravado', 'Aprox.'];
    const linhas = [cabecalho];
    for (const [chave, m] of modelos) {
      linhas.push([
        chave,
        fmtUsd(m.entrada),
        fmtUsd(m.saida),
        fmtUsd(m.cacheLido),
        fmtUsd(m.cacheGravado),
        m.aproximado ? 'sim' : '-'
      ]);
    }
    out.push(...alinharTabela(linhas));
  }
  if (d.aviso) out.push(`Aviso: ${d.aviso}`);
  return out.join('\n');
}

export function formatarUso(dados, { projeto = false } = {}) {
  const d = dados || {};
  const out = [];

  const temBrl = (d.usdBrl != null && Number.isFinite(d.usdBrl)) ||
    (d.total && d.total.brl != null && Number.isFinite(d.total.brl)) ||
    (Array.isArray(d.modelos) && d.modelos.some((m) => m.brl != null && Number.isFinite(m.brl))) ||
    (Array.isArray(d.tarefas) && d.tarefas.some((t) => t.total && t.total.brl != null && Number.isFinite(t.total.brl)));

  if (projeto) {
    if (d.emAndamento) out.push('Execução em andamento.');
    const t = d.total || {};
    let totStr = `Total do projeto: ${fmtTokens(t.entrada)} entrada · ${fmtTokens(t.saida)} saída · ${fmtTokens(t.cacheLido)} cache lido · ${fmtTokens(t.cacheGravado)} cache gravado · US$ ${fmtUsd(t.usd)}`;
    if (temBrl) totStr += ` · R$ ${fmtBrl(t.brl)}`;
    if (t.origem && t.origem !== 'cli' && t.origem !== 'tabela') totStr += ` (${t.origem})`;
    out.push(totStr);
    out.push('');

    out.push('Modelos:');
    const cabMod = ['Modelo', 'Entrada', 'Saída', 'Cache lido', 'Cache gravado', 'US$'];
    if (temBrl) cabMod.push('R$');
    cabMod.push('Origem');
    const linMod = [cabMod];
    for (const m of (d.modelos || [])) {
      const row = [
        (m.provedor ? m.provedor + ':' : '') + (m.modelo || '-'),
        fmtTokens(m.entrada),
        fmtTokens(m.saida),
        fmtTokens(m.cacheLido),
        fmtTokens(m.cacheGravado),
        fmtUsd(m.usd),
      ];
      if (temBrl) row.push(fmtBrl(m.brl));
      row.push(m.origem && m.origem !== 'cli' && m.origem !== 'tabela' ? `(${m.origem})` : (m.origem || '-'));
      linMod.push(row);
    }
    out.push(...alinharTabela(linMod));
    out.push('');

    out.push('Tarefas:');
    const cabTar = ['Tarefa', 'Estado', 'Entrada', 'Saída', 'Cache lido', 'Cache gravado', 'US$'];
    if (temBrl) cabTar.push('R$');
    cabTar.push('Origem');
    const linTar = [cabTar];

    const tarefas = [...(d.tarefas || [])].sort((a, b) => {
      if (a.id === 'planejador') return -1;
      if (b.id === 'planejador') return 1;
      return 0;
    });

    for (const tf of tarefas) {
      const u = tf.total || {};
      const nome = tf.titulo ? `${tf.id} (${tf.titulo})` : tf.id;
      const estadoFormatado = TAREFA_NOMES[tf.estado] || tf.estado || '-';
      const row = [
        nome,
        estadoFormatado,
        fmtTokens(u.entrada),
        fmtTokens(u.saida),
        fmtTokens(u.cacheLido),
        fmtTokens(u.cacheGravado),
        fmtUsd(u.usd),
      ];
      if (temBrl) row.push(fmtBrl(u.brl));
      row.push(u.origem && u.origem !== 'cli' && u.origem !== 'tabela' ? `(${u.origem})` : (u.origem || '-'));
      linTar.push(row);
    }
    out.push(...alinharTabela(linTar));
  } else {
    const periodo = d.periodo ? `Período: ${d.periodo}` : 'Uso geral:';
    const projetos = d.projetos != null ? ` (${d.projetos} projeto${d.projetos !== 1 ? 's' : ''})` : '';
    out.push(periodo + projetos);

    const t = d.total || {};
    let totStr = `Total: ${fmtTokens(t.entrada)} entrada · ${fmtTokens(t.saida)} saída · ${fmtTokens(t.cacheLido)} cache lido · ${fmtTokens(t.cacheGravado)} cache gravado · US$ ${fmtUsd(t.usd)}`;
    if (temBrl) totStr += ` · R$ ${fmtBrl(t.brl)}`;
    if (t.origem && t.origem !== 'cli' && t.origem !== 'tabela') totStr += ` (${t.origem})`;
    out.push(totStr);
    out.push('');

    const cabMod = ['Modelo', 'Entrada', 'Saída', 'Cache lido', 'Cache gravado', 'US$'];
    if (temBrl) cabMod.push('R$');
    cabMod.push('Origem');
    const linMod = [cabMod];
    for (const m of (d.modelos || [])) {
      const row = [
        (m.provedor ? m.provedor + ':' : '') + (m.modelo || '-'),
        fmtTokens(m.entrada),
        fmtTokens(m.saida),
        fmtTokens(m.cacheLido),
        fmtTokens(m.cacheGravado),
        fmtUsd(m.usd),
      ];
      if (temBrl) row.push(fmtBrl(m.brl));
      row.push(m.origem && m.origem !== 'cli' && m.origem !== 'tabela' ? `(${m.origem})` : (m.origem || '-'));
      linMod.push(row);
    }
    out.push(...alinharTabela(linMod));
  }

  out.push('');
  out.push(NOTA_ASSINATURA);
  if (d.aviso && d.aviso !== NOTA_ASSINATURA) out.push(`Aviso: ${d.aviso}`);
  return out.join('\n');
}

const [cmd, ...rest] = process.argv.slice(2);
const o = opts(rest);
try {
  switch (cmd) {
    case 'iniciar': await ensure(); console.log(`Painel no ar: ${BASE}`); break;
    case 'novo': {
      const pedido = o.arquivo ? fs.readFileSync(o.arquivo, 'utf8') : o._.join(' ');
      const custom = lerCustom(o.personalizado);
      const p = await call('POST', '/api/projetos', { repo: o.repo, modo: custom || o.perfil ? 'personalizado' : o.modo || 'padrao', custom: o.perfil ? undefined : custom, perfil: o.perfil, velocidade: o.velocidade || 'auto', supervisao: o.acompanhamento || 'automatico', auto: !!o.auto, titulo: o.titulo, pedido });
      console.log('Projeto criado e enviado ao planejador.'); mostrar(p, 0); break;
    }
    case 'msg': await call('POST', `/api/projetos/${o._[0]}/mensagem`, { texto: o.arquivo ? fs.readFileSync(o.arquivo, 'utf8') : o._.slice(1).join(' ') }); console.log('Mensagem enviada.'); break;
    case 'plano': await call('POST', `/api/projetos/${o._[0]}/gerar-plano`); console.log('Plano final pedido ao planejador.'); break;
    case 'modo': {
      if (o.perfil) { mostrar(await call('POST', `/api/projetos/${o._[0]}/ajustes`, { perfil: o.perfil }), 0); break; }
      const custom = lerCustom(o.personalizado);
      mostrar(await call('POST', `/api/projetos/${o._[0]}/ajustes`, { modo: custom ? 'personalizado' : o._[1], custom }), 0); break;
    }
    case 'perfis': {
      const [sub, a, b] = o._;
      if (!sub) {
        const r = await call('GET', '/api/perfis');
        if (r.aviso) console.log('Aviso: ' + r.aviso);
        if (!r.perfis.length) console.log('Nenhum perfil salvo.');
        for (const x of r.perfis) console.log(`  ${x.nome}  -  ${x.custom.planner[0]}  -  ${(x.atualizado || x.criado || '').slice(0, 10)}`);
      } else if (sub === 'salvar') {
        if (!a || !o.personalizado) throw new Error('uso: perfis salvar <nome> --personalizado modo.json [--sobrescrever]');
        const r = await call('POST', '/api/perfis', { nome: a, custom: lerCustom(o.personalizado), sobrescrever: !!o.sobrescrever });
        console.log(`Perfil "${r.perfil.nome}" salvo.`);
      } else if (sub === 'renomear') {
        if (!a || !b) throw new Error('uso: perfis renomear <de> <para>');
        const r = await call('POST', '/api/perfis/renomear', { de: a, para: b });
        console.log(`Perfil renomeado para "${r.perfil.nome}".`);
      } else if (sub === 'excluir') {
        if (!a) throw new Error('uso: perfis excluir <nome>');
        await call('POST', '/api/perfis/excluir', { nome: a });
        console.log(`Perfil "${a}" excluído.`);
      } else throw new Error('subcomando de perfis desconhecido: ' + sub);
      break;
    }
    case 'acompanhamento': mostrar(await call('POST', `/api/projetos/${o._[0]}/ajustes`, { supervisao: o._[1] }), 0); break;
    case 'velocidade': mostrar(await call('POST', `/api/projetos/${o._[0]}/ajustes`, { velocidade: o._[1] }), 0); break;
    case 'confirmar': mostrar(await call('POST', `/api/projetos/${o._[0]}/confirmar`, { gate: o._[1], decisao: o._[2] === 'nao' ? 'nao' : 'sim' }), 0); break;
    case 'aprovar': case 'retomar': case 'cancelar': mostrar(await call('POST', `/api/projetos/${o._[0]}/${cmd}`), 1); break;
    case 'arquivar': case 'desarquivar': { const p = await call('POST', `/api/projetos/${o._[0]}/arquivar`, { arquivar: cmd === 'arquivar' }); console.log(`Projeto ${p.id} ${p.arquivado ? 'arquivado' : 'desarquivado'}.`); break; }
    case 'excluir': { const r = await call('POST', `/api/projetos/${o._[0]}/excluir`, { confirmar: o._[0] }); console.log(`Projeto movido para a lixeira: ${r.lixeira}`); break; }
    case 'ver': mostrar(await call('GET', `/api/projetos/${o._[0]}`), Number(o.n) || 3); break;
    case 'atividade': {
      const as = o._[0] ? [await call('GET', `/api/projetos/${o._[0]}/atividade`)] : await call('GET', '/api/atividade');
      if (!as.length) console.log('Nada em andamento.');
      as.forEach(mostrarAtividade); break;
    }
    case 'cotas': {
      if (o.atualizar) console.log('lendo as cotas (20 a 40 s)...');
      const d = o.atualizar ? await call('POST', '/api/cotas/atualizar') : await call('GET', '/api/cotas');
      console.log(formatarCotas(d)); break;
    }
    case 'uso': {
      const id = o._[0];
      const periodo = o.periodo || '30d';
      if (!['hoje', '7d', '30d', 'tudo'].includes(periodo)) {
        throw new Error('período inválido: use hoje, 7d, 30d ou tudo');
      }
      if (id) {
        const d = await call('GET', `/api/projetos/${encodeURIComponent(id)}/uso`);
        console.log(formatarUso(d, { projeto: true }));
      } else {
        const d = await call('GET', `/api/uso?periodo=${encodeURIComponent(periodo)}`);
        console.log(formatarUso(d, { projeto: false }));
      }
      break;
    }
    case 'precos': {
      if (o.atualizar) {
        const r = await call('POST', '/api/precos/atualizar');
        if (r.aviso) console.log('Aviso: ' + r.aviso);
        else console.log(`Preços atualizados (${r.atualizados ?? 0} modelos).`);
      } else {
        const d = await call('GET', '/api/precos');
        console.log(formatarPrecos(d));
      }
      break;
    }
    case 'modelos': {
      const c = o.atualizar ? await call('POST', '/api/modelos/atualizar') : await call('GET', '/api/modelos');
      if (o.atualizar) {
        const r = c.resultado || { novos: [], erros: {} };
        const mostra = r.novos.slice(0, 10);
        console.log(`Atualizado agora: ${r.novos.length} novo(s)${mostra.length ? ': ' + mostra.join(', ') + (r.novos.length > mostra.length ? ` e mais ${r.novos.length - mostra.length}` : '') : ''}`);
        for (const [k, v] of Object.entries(r.erros || {})) console.log(`  erro em ${k}: ${v}`);
      }
      console.log('Provedores: ' + Object.entries(c.provedores).map(([k, v]) => `${k} ${v ? 'instalado' : 'ausente'}`).join(' · '));
      console.log('Modo desespero (melhor para o pior): ' + c.desespero.join(' > '));
      for (const m of c.modelos) console.log(`  ${m.instalado ? ' ' : 'x'} ${m.id}${m.novo ? ' [novo]' : ''}${m.dica ? '  - ' + m.dica : ''}`);
      break;
    }
    case 'status': for (const p of (await call('GET', '/api/projetos')).filter((x) => o.todos || !x.arquivado)) console.log(`${p.arquivado ? '[arquivado] ' : ''}${p.id}  ${p.estado}${p.ocupado ? '*' : ''}${p.gates ? ' (confirmação pendente)' : ''}  ${p.modoNome} (${p.velocidade || 'auto'})  ${p.titulo}`); break;
    case 'esperar': {
      const lim = Date.now() + (Number(o._[1]) || 60) * 60000; let p;
      do {
        p = await call('GET', `/api/projetos/${o._[0]}`);
        if (p.run?.gates?.length) break;
        if (!p.ocupado && p.estado !== 'executando' && p.estado !== 'planejando') break;
        await sleep(15000);
      } while (Date.now() < lim);
      mostrar(p, 2); break;
    }
    default: {
      const linhas = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1);
      console.log(linhas.slice(0, linhas.findIndex((l) => !l.startsWith('//'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    }
  }
} catch (e) { console.error('Erro:', e.message); process.exit(1); }
