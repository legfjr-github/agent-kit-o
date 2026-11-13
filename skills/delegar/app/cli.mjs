#!/usr/bin/env node
// CLI do Delegar. Uso:
//   node cli.mjs iniciar                         sobe o painel (se não estiver no ar) e mostra o endereço
//   node cli.mjs novo --repo <pasta> [--modo padrao|equilibrado|agressivo|desespero|personalizado]
//        [--personalizado modo.json] [--acompanhamento automatico|acompanhado|passo] [--auto] [--titulo T] "pedido"
//   node cli.mjs msg <id> "texto"                conversa com o planejador
//   node cli.mjs plano <id>                      pede o plano final
//   node cli.mjs ver <id>                        mostra conversa recente, plano e estado
//   node cli.mjs modo <id> <modo> [--personalizado modo.json]   troca o modo antes de aprovar
//   node cli.mjs acompanhamento <id> <automatico|acompanhado|passo>   vale também durante a execução
//   node cli.mjs aprovar <id> | retomar <id> | cancelar <id>
//   node cli.mjs confirmar <id> <confirmação> [sim|nao]   responde a uma parada do modo acompanhado
//   node cli.mjs atividade [id]                  quem está fazendo o quê agora e as últimas atualizações
//   node cli.mjs modelos                         provedores instalados, modelos e a ordem do modo desespero
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
    else if (a.startsWith('--')) o[a.slice(2)] = argv[++i];
    else o._.push(a);
  }
  return o;
}
const lerCustom = (f) => (f ? JSON.parse(fs.readFileSync(f, 'utf8')) : undefined);
const TAREFA = { pending: 'na fila', waiting: 'aguardando confirmação', running: 'rodando', done: 'concluída', failed: 'falhou', skipped: 'pulada' };

function mostrar(p, n = 3) {
  console.log(`${p.titulo}\n  id: ${p.id}\n  estado: ${p.estado}${p.ocupado ? ' (planejador pensando)' : ''} · modo: ${p.modoNome} · acompanhamento: ${p.supervisao}${p.auto ? ' · automático' : ''}${p.run?.desespero ? ' · MODO DESESPERO' : ''}\n  planejador: ${p.planejador || (p.plannerEfetivo || [])[0] || '-'}\n  repo: ${p.repo}\n  painel: ${BASE}/#${p.id}`);
  for (const m of (p.mensagens || []).slice(-n)) console.log(`\n[${m.papel}${m.modelo ? ' ' + m.modelo : ''}] ${m.texto}`);
  if (p.plano) {
    console.log(`\nPlano: ${p.plano.resumo || ''}`);
    for (const t of p.plano.tarefas) {
      const s = p.run?.status?.[t.id];
      console.log(`  - ${t.id} [${t.tipo}/${t.nivel}${t.confirmar ? '/confirmar' : ''}] ${t.titulo || ''} :: ${t.cadeiaEfetiva.join(' > ')}${t.depende.length ? ' :: depende ' + t.depende.join(',') : ''}${s ? ' :: ' + (TAREFA[s.state] || s.state) + (s.model ? ' (' + s.model + ')' : '') : ''}`);
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

const [cmd, ...rest] = process.argv.slice(2);
const o = opts(rest);
try {
  switch (cmd) {
    case 'iniciar': await ensure(); console.log(`Painel no ar: ${BASE}`); break;
    case 'novo': {
      const pedido = o.arquivo ? fs.readFileSync(o.arquivo, 'utf8') : o._.join(' ');
      const custom = lerCustom(o.personalizado);
      const p = await call('POST', '/api/projetos', { repo: o.repo, modo: custom ? 'personalizado' : o.modo || 'padrao', custom, supervisao: o.acompanhamento || 'automatico', auto: !!o.auto, titulo: o.titulo, pedido });
      console.log('Projeto criado e enviado ao planejador.'); mostrar(p, 0); break;
    }
    case 'msg': await call('POST', `/api/projetos/${o._[0]}/mensagem`, { texto: o.arquivo ? fs.readFileSync(o.arquivo, 'utf8') : o._.slice(1).join(' ') }); console.log('Mensagem enviada.'); break;
    case 'plano': await call('POST', `/api/projetos/${o._[0]}/gerar-plano`); console.log('Plano final pedido ao planejador.'); break;
    case 'modo': { const custom = lerCustom(o.personalizado); mostrar(await call('POST', `/api/projetos/${o._[0]}/ajustes`, { modo: custom ? 'personalizado' : o._[1], custom }), 0); break; }
    case 'acompanhamento': mostrar(await call('POST', `/api/projetos/${o._[0]}/ajustes`, { supervisao: o._[1] }), 0); break;
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
    case 'modelos': {
      const c = await call('GET', '/api/modelos');
      console.log('Provedores: ' + Object.entries(c.provedores).map(([k, v]) => `${k} ${v ? 'instalado' : 'ausente'}`).join(' · '));
      console.log('Modo desespero (melhor para o pior): ' + c.desespero.join(' > '));
      for (const m of c.modelos) console.log(`  ${m.instalado ? ' ' : 'x'} ${m.id}${m.dica ? '  - ' + m.dica : ''}`);
      break;
    }
    case 'status': for (const p of (await call('GET', '/api/projetos')).filter((x) => o.todos || !x.arquivado)) console.log(`${p.arquivado ? '[arquivado] ' : ''}${p.id}  ${p.estado}${p.ocupado ? '*' : ''}${p.gates ? ' (confirmação pendente)' : ''}  ${p.modoNome}  ${p.titulo}`); break;
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
