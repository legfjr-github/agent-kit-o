// Consumo FORA do orquestrador (19/11/2026): o que o Claude Code e o Antigravity gastaram em sessões que não são
// tarefas do delegar (conversas do usuário, subagentes, planejador). A tabela "Uso e custo" só somava as tarefas.
//
// Sem duplicação:
// - Claude: cada resposta tem um id único (msg_...). O mesmo id aparece no transcript do Claude Code e no .out.log do
//   worker. Tudo o que aparece num .out.log de projeto é do orquestrador e fica fora desta conta. Linhas repetidas do
//   mesmo id no transcript (uma por bloco de conteúdo) trazem o mesmo uso: conta-se uma vez.
// - Antigravity: sai daqui a conversa igual a um .prompt.txt de tentativa, a que tem a marca "(Projeto Delegar <id>."
//   de um projeto que ainda existe, e a do planejador/corretor registrada em p.uso.chamadas. Tarefa de projeto já
//   excluído não está na tabela do orquestrador e continua contando aqui.
// - Planejador do Claude: o transcript tem o nome da sessão guardada no projeto (p.sessao, chamadas[].sessao).
//
// É pesado (varre semanas de transcripts), por isso roda em processo separado e grava um resumo por dia em
// state/uso-fora.json; o painel lê o arquivo e só manda refazer quando ele tem mais de 24 h ou a pessoa pede.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ARQUIVO_USO_FORA = 'uso-fora.json';
export const VALIDADE_USO_FORA_MS = 24 * 3600e3;
const MARCA = '(Projeto Delegar ';
// Planejador e corretor também contam no orquestrador (p.uso.chamadas), mas não têm .out.log.
const ASSINATURAS_PAINEL = ['# Planejador do Delegar', 'Você é o planejador do sistema Delegar', 'Corrija SOMENTE o formato do JSON abaixo'];
const MAX_ARQ = 100 * 1024 * 1024;
const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
const dia = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function* arquivos(dir, filtro, prof = 0) {
  if (prof > 8) return;
  let itens = [];
  try { itens = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const it of itens) {
    const p = path.join(dir, it.name);
    if (it.isDirectory()) yield* arquivos(p, filtro, prof + 1);
    else if (filtro(it.name)) yield p;
  }
}

// Ids das respostas do Claude e assinaturas dos prompts do agy que pertencem a tentativas do orquestrador.
export function marcasDoOrquestrador(projectsDir) {
  const idsClaude = new Set();
  const promptsAgy = [];
  const sessoes = new Set(); // sessões do planejador e do corretor (nome do transcript do Claude Code)
  const chamadasAgy = [];
  const projetos = new Set();
  for (const f of arquivos(projectsDir, (n) => n === 'project.json')) {
    let p; try { p = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    if (typeof p?.id === 'string') projetos.add(p.id);
    if (typeof p?.sessao === 'string') sessoes.add(p.sessao);
    for (const c of p?.uso?.chamadas || []) {
      if (typeof c?.sessao === 'string') sessoes.add(c.sessao);
      // Chamada do planejador/corretor pelo agy: a conversa começa até 45 min antes do registro (que é no fim).
      const ms = Date.parse(c?.quando || '');
      if (String(c?.modelo || '').startsWith('agy:') && Number.isFinite(ms)) chamadasAgy.push(ms);
    }
    for (const r of Array.isArray(p?.rodadas) ? p.rodadas : []) if (typeof r?.sessao === 'string') sessoes.add(r.sessao);
  }
  for (const f of arquivos(projectsDir, (n) => n.endsWith('.out.log') || n.endsWith('.prompt.txt'))) {
    let st; try { st = fs.statSync(f); } catch { continue; }
    if (st.size > MAX_ARQ) continue;
    let txt; try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (f.endsWith('.out.log')) {
      for (const m of txt.matchAll(/"id"\s*:\s*"(msg_[A-Za-z0-9_-]+)"/g)) idsClaude.add(m[1]);
    } else {
      const a = norm(txt).slice(0, 300);
      if (a.length >= 40) promptsAgy.push({ assinatura: a, ms: st.mtimeMs });
    }
  }
  return { idsClaude, promptsAgy, sessoes, chamadasAgy, projetos };
}

function somar(alvo, chaveDia, modelo, u) {
  const d = (alvo[chaveDia] ||= {});
  const o = (d[modelo] ||= { entrada: 0, saida: 0, cacheLido: 0, cacheGravado: 0, respostas: 0 });
  o.entrada += u.entrada; o.saida += u.saida; o.cacheLido += u.cacheLido; o.cacheGravado += u.cacheGravado; o.respostas += 1;
}

export function montarUsoFora({ claudeDir, brainDir, projectsDir, dias = 35, agoraMs = Date.now() } = {}) {
  const corte = agoraMs - dias * 86400e3;
  const marcas = marcasDoOrquestrador(projectsDir);
  const porDia = {};
  const excluidos = { claude: 0, agy: 0 };
  // Claude Code: ~/.claude/projects/**/*.jsonl
  const vistos = new Set();
  for (const f of arquivos(claudeDir, (n) => n.endsWith('.jsonl'))) {
    let st; try { st = fs.statSync(f); } catch { continue; }
    if (st.mtimeMs < corte || st.size > MAX_ARQ) continue;
    let txt; try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    // Só sai daqui o que a tabela do orquestrador conta: ids dos .out.log e sessões do planejador/corretor dos
    // projetos que existem. Tarefa de projeto já excluído não está lá, então continua contando aqui.
    const doPainel = marcas.sessoes.has(path.basename(f, '.jsonl'));
    for (const l of txt.split(/\r?\n/)) {
      if (!l.startsWith('{') || !l.includes('"usage"')) continue;
      let j; try { j = JSON.parse(l); } catch { continue; }
      if (j.type !== 'assistant' || !j.message?.usage) continue;
      const id = j.message.id;
      if (!id || vistos.has(id)) continue; // mesma resposta em várias linhas ou copiada para outra sessão
      vistos.add(id);
      if (doPainel || marcas.idsClaude.has(id)) { excluidos.claude++; continue; }
      const ms = Date.parse(j.timestamp || '') || st.mtimeMs;
      if (ms < corte) continue;
      const modelo = String(j.message.model || '');
      if (!modelo || modelo.startsWith('<')) continue; // <synthetic>: mensagem do próprio Claude Code, sem consumo
      const u = j.message.usage;
      somar(porDia, dia(ms), `claude:${modelo}`, { entrada: num(u.input_tokens), saida: num(u.output_tokens), cacheLido: num(u.cache_read_input_tokens), cacheGravado: num(u.cache_creation_input_tokens) });
    }
  }
  // Antigravity: <brain>/<sessão>/.system_generated/logs/transcript_full.jsonl
  let sessoes = [];
  try { sessoes = fs.readdirSync(brainDir, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch {}
  for (const s of sessoes) {
    const base = path.join(brainDir, s.name, '.system_generated', 'logs');
    const arq = fs.existsSync(path.join(base, 'transcript_full.jsonl')) ? path.join(base, 'transcript_full.jsonl') : path.join(base, 'transcript.jsonl');
    let st; try { st = fs.statSync(arq); } catch { continue; }
    if (st.mtimeMs < corte || st.size > MAX_ARQ) continue;
    let linhas; try { linhas = fs.readFileSync(arq, 'utf8').split(/\r?\n/).filter(Boolean); } catch { continue; }
    let primeira = null; try { primeira = JSON.parse(linhas[0]); } catch {}
    const conteudo = norm(primeira?.content);
    const criada = Date.parse(primeira?.created_at || '') || st.mtimeMs;
    // Só o que a tabela do orquestrador conta: tentativa cujo .prompt.txt existe num projeto atual, ou chamada do
    // planejador/corretor registrada perto da criação da conversa. A marca "(Projeto Delegar" sozinha não basta:
    // tarefa de projeto já excluído não está na tabela e continua contando aqui.
    // Tarefas de 12-13/11 não têm .prompt.txt por tentativa; a tabela as conta pelo prompts/<tarefa>.md, então
    // a marca com o id de um projeto que existe também tira a conversa daqui.
    const idMarca = conteudo.match(/\(Projeto Delegar ([a-z0-9-]{6,80})\./)?.[1];
    const doOrq = (idMarca && marcas.projetos.has(idMarca))
      || marcas.promptsAgy.some((p) => Math.abs(p.ms - criada) < 2 * 86400e3 && conteudo.includes(p.assinatura))
      || (ASSINATURAS_PAINEL.some((a) => conteudo.includes(a)) && marcas.chamadasAgy.some((ms) => ms >= criada - 60000 && ms <= criada + 45 * 60000));
    if (doOrq) { excluidos.agy++; continue; }
    for (const l of linhas) {
      let e; try { e = JSON.parse(l); } catch { continue; }
      if (e.source !== 'MODEL' || e.input_tokens == null) continue;
      const ms = Date.parse(e.created_at || '') || st.mtimeMs;
      if (ms < corte) continue;
      const modelo = String(e.model || e.model_name || 'modelo-nao-registrado-no-log').toLowerCase();
      somar(porDia, dia(ms), `agy:${modelo}`, { entrada: num(e.input_tokens), saida: num(e.output_tokens), cacheLido: num(e.cache_read_tokens), cacheGravado: num(e.cache_write_tokens) });
    }
  }
  return { versao: 1, atualizado: new Date(agoraMs).toISOString(), dias, porDia, excluidos };
}

export function lerUsoFora(dataDir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dataDir, 'state', ARQUIVO_USO_FORA), 'utf8'));
    return j && typeof j === 'object' && j.porDia && typeof j.porDia === 'object' ? j : null;
  } catch { return null; }
}

export function gravarUsoFora(dataDir, dados) {
  const dir = path.join(dataDir, 'state');
  fs.mkdirSync(dir, { recursive: true });
  const arq = path.join(dir, ARQUIVO_USO_FORA);
  fs.writeFileSync(`${arq}.tmp`, JSON.stringify(dados));
  fs.renameSync(`${arq}.tmp`, arq);
}

export const usoForaVencido = (dados, agoraMs = Date.now()) => !dados?.atualizado || agoraMs - Date.parse(dados.atualizado) > VALIDADE_USO_FORA_MS;

// Soma por modelo dos dias que caem no período (testarDia: 'AAAA-MM-DD' -> boolean).
export function usoForaNoPeriodo(dados, testarDia) {
  const porModelo = {};
  for (const [d, mods] of Object.entries(dados?.porDia || {})) {
    if (!testarDia(d)) continue;
    for (const [m, u] of Object.entries(mods)) {
      const o = (porModelo[m] ||= { entrada: 0, saida: 0, cacheLido: 0, cacheGravado: 0, respostas: 0 });
      for (const k of Object.keys(o)) o[k] += num(u[k]);
    }
  }
  return porModelo;
}

// Execução direta (processo separado do painel): node uso-fora.mjs <dataDir>
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dataDir = process.argv[2] || process.env.DELEGAR_DATA || path.join(os.homedir(), '.delegar');
  const dados = montarUsoFora({
    claudeDir: process.env.DELEGAR_CLAUDE_PROJECTS || path.join(os.homedir(), '.claude', 'projects'),
    brainDir: process.env.DELEGAR_AGY_BRAIN || path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain'),
    projectsDir: path.join(dataDir, 'projects'),
  });
  gravarUsoFora(dataDir, dados);
  console.log(`uso-fora: ${Object.keys(dados.porDia).length} dias; excluídos do orquestrador: claude ${dados.excluidos.claude}, agy ${dados.excluidos.agy}`);
}
