// Agendamento de planejamento/execução do Delegar.
// Módulo puro: só calcula sobre os objetos do projeto; quem grava e quem chama
// o planejador ou o pipeline é o servidor. Novo estado de projeto: 'agendado'.

export const ESTADOS_REEXECUCAO = Object.freeze(['cancelado', 'incompleto', 'interrompido', 'concluido']);

const LIMITE_PASSADO_MS = 60 * 1000; // tolerância de 60s para "no passado"
// Rodada nova (projeto cancelado, incompleto, interrompido ou concluído) com horário vencido há mais
// que isto não dispara sozinha: o painel pode ter ficado fora do ar e o projeto ter sido rodado à mão
// nesse meio-tempo (caso real 18/11: Startup concluído rodou de novo ao reiniciar o painel).
export const ATRASO_MAX_REEXECUCAO_MS = 2 * 60 * 60 * 1000;
const LIMITE_FUTURO_MS = 365 * 24 * 60 * 60 * 1000; // até 365 dias à frente

// Formas aceitas em texto: "2026-11-17T14:30", "2026-11-17 14:30", com segundos opcionais.
const RE_LOCAL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
// ISO completo com fuso explícito: "2026-11-17T14:30:00Z", "2026-11-17T14:30-03:00".
const RE_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

// Converte o campo de data agendada em ms (número) ou null quando não dá para confiar no valor.
function quandoMs(iso) {
  if (typeof iso !== 'string' || iso.length > 64) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function ehFuturo(iso, agoraMs) {
  const t = quandoMs(iso);
  return t != null && t > agoraMs;
}

/**
 * Interpreta uma data/hora de agendamento. Aceita número em ms ou texto nos
 * formatos "2026-11-17T14:30", "2026-11-17 14:30" (hora local) e ISO completo
 * com fuso. Recusa datas mais de 60s no passado (a menos que
 * opcoes.permitirPassado) e mais de 365 dias no futuro. As mensagens de erro
 * são fixas e nunca ecoam a entrada do usuário.
 * @returns {{ok: true, iso: string, ms: number} | {ok: false, erro: string}}
 */
export function parseDataHoraAgendamento(valor, agoraMs = Date.now(), opcoes = {}) {
  if (!Number.isFinite(agoraMs)) agoraMs = Date.now();
  let ms = null;
  if (typeof valor === 'number' && Number.isFinite(valor) && valor >= 0) {
    ms = valor;
  } else if (typeof valor === 'string' && valor.length <= 64) {
    const m = RE_LOCAL.exec(valor);
    if (m) {
      const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), m[6] ? Number(m[6]) : 0);
      const roundtrip = dt.getFullYear() === Number(m[1]) && dt.getMonth() === Number(m[2]) - 1 && dt.getDate() === Number(m[3]) && dt.getHours() === Number(m[4]) && dt.getMinutes() === Number(m[5]) && dt.getSeconds() === (m[6] ? Number(m[6]) : 0);
      if (roundtrip) ms = dt.getTime();
    } else if (RE_ISO.test(valor)) {
      const t = Date.parse(valor);
      if (Number.isFinite(t)) ms = t;
    }
  }
  if (ms == null) return { ok: false, erro: 'data ou hora inválida' };
  if (ms < agoraMs - LIMITE_PASSADO_MS && opcoes.permitirPassado !== true) return { ok: false, erro: 'a data está no passado' };
  if (ms > agoraMs + LIMITE_FUTURO_MS) return { ok: false, erro: 'a data está longe demais no futuro' };
  return { ok: true, iso: new Date(ms).toISOString(), ms };
}

/**
 * Valida o corpo de agendamento vindo da API
 * ({ planejarEm, executarEm, executarAposPlanejar, cancelar }).
 * cancelar === true devolve { ok, cancelar: true, agendamento: null }.
 * Em sucesso devolve o objeto completo para guardar em p.agendamento,
 * com os carimbos de disparo ainda vazios. opcoes.agoraMs fixa o "agora"
 * (usado nos testes); opcoes.permitirPassado é repassado à leitura das datas.
 * @returns {{ok: true, cancelar?: boolean, agendamento?: object} | {ok: false, erro: string}}
 */
export function validarAgendamentoInput(body, opcoes = {}) {
  const agoraMs = Number.isFinite(opcoes.agoraMs) ? opcoes.agoraMs : Date.now();
  const parseOpcoes = { agoraMs, permitirPassado: opcoes.permitirPassado === true };
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, erro: 'corpo inválido' };
  if (body.cancelar === true) return { ok: true, cancelar: true, agendamento: null };
  if (body.cancelar != null && body.cancelar !== false) return { ok: false, erro: 'cancelar deve ser verdadeiro ou falso' };
  if (body.executarAposPlanejar != null && typeof body.executarAposPlanejar !== 'boolean') return { ok: false, erro: 'executarAposPlanejar deve ser verdadeiro ou falso' };
  let planejar = null;
  let executar = null;
  if (body.planejarEm != null) {
    planejar = parseDataHoraAgendamento(body.planejarEm, agoraMs, parseOpcoes);
    if (!planejar.ok) return { ok: false, erro: planejar.erro };
  }
  if (body.executarEm != null) {
    executar = parseDataHoraAgendamento(body.executarEm, agoraMs, parseOpcoes);
    if (!executar.ok) return { ok: false, erro: executar.erro };
  }
  if (body.executarAposPlanejar === true && !planejar) return { ok: false, erro: 'executarAposPlanejar exige planejarEm' };
  if (!planejar && !executar) return { ok: false, erro: 'informe planejarEm ou executarEm' };
  if (planejar && executar && executar.ms < planejar.ms) return { ok: false, erro: 'a execução deve ser depois do planejamento' };
  return {
    ok: true,
    cancelar: false,
    agendamento: {
      planejarEm: planejar ? planejar.iso : null,
      executarEm: executar ? executar.iso : null,
      executarAposPlanejar: body.executarAposPlanejar === true,
      criadoEm: new Date(agoraMs).toISOString(),
      planejadoDisparadoEm: null,
      execucaoDisparadaEm: null,
      execucaoFalhouEm: null,
    },
  };
}

// Estado a que o projeto volta quando o agendamento sai: com plano vira
// 'plano_pronto'; sem plano, conversa com o planejador já em andamento vira
// 'conversando'; do contrário, 'planejando'.
function estadoBase(p) {
  if (p.plano) return 'plano_pronto';
  if (Array.isArray(p.mensagens) && p.mensagens.some((m) => m && m.papel === 'planejador')) return 'conversando';
  return 'planejando';
}

/**
 * Aplica (ou remove, com agendamento null) o agendamento no projeto p.
 * Ao remover, se p.estado era 'agendado', devolve o estado natural do
 * projeto (plano_pronto / conversando / planejando). Ao aplicar, com
 * planejarEm futuro e sem plano, o projeto fica em 'agendado'; com só
 * executarEm e plano já pronto, o estado atual se mantém. Não grava nada.
 */
export function aplicarAgendamentoNoProjeto(p, agendamento, agoraMs = Date.now()) {
  if (!p || typeof p !== 'object') return p;
  if (agendamento == null) {
    delete p.agendamento;
    if (p.estado === 'agendado') p.estado = estadoBase(p);
    return p;
  }
  p.agendamento = { ...agendamento };
  if (ehFuturo(p.agendamento.planejarEm, agoraMs) && !p.plano) p.estado = 'agendado';
  return p;
}

/**
 * Valida se o projeto pode receber o agendamento na rota que salva o agendamento.
 * Não usada na criação do projeto.
 * Regras em ordem:
 * 1. cancelar (null) sempre { ok: true };
 * 2. projeto arquivado: { ok: false, erro: 'o projeto está arquivado: desarquive antes de agendar' };
 * 3. estado 'executando': { ok: false, erro: 'execução em andamento' };
 * 4. agendamento com planejarEm: ok;
 * 5. com p.plano: ok se o estado estiver no conjunto executável, senão { ok: false, erro: 'o estado atual do projeto não permite executar o plano' };
 * 6. sem plano mas com p.ocupado === true: ok;
 * 7. sem plano e sem planejarEm: { ok: false, erro: 'o projeto ainda não tem plano: agende também o planejamento ou espere o plano ficar pronto' }.
 * @param {object} p
 * @param {object|null} agendamento
 * @returns {{ok: true} | {ok: false, erro: string}}
 */
export function podeAgendar(p, agendamento) {
  if (agendamento == null) return { ok: true };
  if (p?.arquivado === true) {
    return { ok: false, erro: 'o projeto está arquivado: desarquive antes de agendar' };
  }
  if (p?.estado === 'executando') {
    return { ok: false, erro: 'execução em andamento' };
  }
  if (agendamento.planejarEm != null) {
    return { ok: true };
  }
  const estadosExecutaveis = ['plano_pronto', 'agendado', 'conversando', ...ESTADOS_REEXECUCAO];
  if (p?.plano) {
    if (estadosExecutaveis.includes(p.estado)) return { ok: true };
    return { ok: false, erro: 'o estado atual do projeto não permite executar o plano' };
  }
  if (p?.ocupado === true) {
    return { ok: true };
  }
  return { ok: false, erro: 'o projeto ainda não tem plano: agende também o planejamento ou espere o plano ficar pronto' };
}

/**
 * Decide o que o relógio do servidor deve fazer com o agendamento do
 * projeto p neste instante. Determinístico e sem efeitos colaterais:
 * - 'nenhuma': sem agendamento, arquivado, executando, ocupado, falhou ou tudo já disparado;
 * - 'planejar' (com autoExecutarDepois): planejarEm chegou e ainda não disparou;
 * - 'executar' (com reexecutar se aplicável): há plano e a hora da execução chegou
 *   (ou a execução automática após o planejamento está liberada);
 * - 'aguardar' (com proximoDisparoMs e tipoPendencia 'planejar' | 'executar').
 */
export function avaliarAgendamentoProjeto(p, agoraMs = Date.now()) {
  const nenhuma = { acao: 'nenhuma' };
  if (!p || typeof p !== 'object') return nenhuma;
  const a = p.agendamento;
  if (!a || typeof a !== 'object') return nenhuma;
  if (p.arquivado === true) return nenhuma;
  if (p.estado === 'executando') return nenhuma;
  if (p.ocupado === true) return nenhuma;
  if (a.execucaoFalhouEm != null) return nenhuma;
  const pl = quandoMs(a.planejarEm);
  const ex = quandoMs(a.executarEm);
  const planejarPendente = a.planejarEm != null && a.planejadoDisparadoEm == null && pl != null;
  if (planejarPendente && pl <= agoraMs) {
    return { acao: 'planejar', autoExecutarDepois: a.executarAposPlanejar === true && a.executarEm == null };
  }
  const ehReexecucao = ESTADOS_REEXECUCAO.includes(p.estado);
  const podeExecutar = !!p.plano && (['plano_pronto', 'agendado', 'conversando'].includes(p.estado) || ehReexecucao);
  const execPorHora = a.executarEm != null && a.execucaoDisparadaEm == null && ex != null && ex <= agoraMs;
  const execAuto = a.planejadoDisparadoEm != null && a.executarAposPlanejar === true && a.executarEm == null && a.execucaoDisparadaEm == null;
  const reexecVencida = ehReexecucao && execPorHora && agoraMs - ex > ATRASO_MAX_REEXECUCAO_MS;
  if (podeExecutar && (execPorHora || execAuto) && !reexecVencida) {
    return ehReexecucao ? { acao: 'executar', reexecutar: true } : { acao: 'executar' };
  }
  if (planejarPendente) return { acao: 'aguardar', proximoDisparoMs: pl, tipoPendencia: 'planejar' };
  // Execução por hora agendada: aguarda tanto sem plano (o plano vem depois)
  // quanto com plano num estado executável; sem plano e sem estado
  // executável ao mesmo tempo, não há o que fazer.
  if (a.executarEm != null && a.execucaoDisparadaEm == null && ex != null && !reexecVencida) {
    if (!p.plano || podeExecutar) return { acao: 'aguardar', proximoDisparoMs: ex, tipoPendencia: 'executar' };
  }
  if (execAuto && !p.plano) {
    return { acao: 'aguardar', proximoDisparoMs: null, tipoPendencia: 'executar' }; // planejador falhou: aguarda plano
  }
  return nenhuma;
}

/**
 * Diagnostica se um agendamento com horário vencido não pôde ser disparado.
 * Pura e determinística. Devolve null quando não há falha a registrar ou bloqueio passageiro,
 * ou { tipoPendencia: 'planejar' | 'executar', motivo } com motivo fixo.
 */
export function diagnosticarAgendamentoNaHora(p, agoraMs = Date.now()) {
  if (!p || typeof p !== 'object') return null;
  const a = p.agendamento;
  if (!a || typeof a !== 'object') return null;
  if (a.execucaoFalhouEm != null) return null;
  if (p.ocupado === true) return null;

  const pl = quandoMs(a.planejarEm);
  const ex = quandoMs(a.executarEm);
  const planejarPendente = a.planejarEm != null && a.planejadoDisparadoEm == null && pl != null;
  const execPorHoraPendente = a.executarEm != null && a.execucaoDisparadaEm == null && ex != null;

  const planejarVenceu = planejarPendente && pl <= agoraMs;
  const executarVenceu = execPorHoraPendente && ex <= agoraMs;

  if (!planejarVenceu && !executarVenceu) return null;

  const aval = avaliarAgendamentoProjeto(p, agoraMs);
  if (aval.acao === 'planejar' || aval.acao === 'executar') return null;

  const tipoPendencia = planejarVenceu ? 'planejar' : 'executar';

  let motivo = null;
  if (tipoPendencia === 'executar' && p.plano && ESTADOS_REEXECUCAO.includes(p.estado) && agoraMs - ex > ATRASO_MAX_REEXECUCAO_MS) {
    motivo = 'o horário passou há mais de 2 h (o painel estava fora do ar?); para rodar de novo, execute à mão ou agende outro horário';
  } else if (p.arquivado === true) {
    motivo = 'o projeto está arquivado';
  } else if (p.estado === 'executando') {
    motivo = 'já havia uma execução em andamento no horário';
  } else if (tipoPendencia === 'executar' && !p.plano && !planejarPendente) {
    motivo = 'o projeto não tem plano';
  } else if (p.plano) {
    const estadosExecutaveis = ['plano_pronto', 'agendado', 'conversando', ...ESTADOS_REEXECUCAO];
    if (!estadosExecutaveis.includes(p.estado)) {
      const st = String(p.estado || '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 40);
      motivo = `o estado '${st}' não permite executar o plano`;
    }
  }

  if (!motivo) return null;
  return { tipoPendencia, motivo };
}

/**
 * Registra que a execução agendada falhou ao tentar iniciar no horário.
 * Guarda o carimbo ISO e o motivo (cortado em 200 caracteres).
 * Não grava arquivo.
 */
export function marcarExecucaoAgendadaFalhou(p, motivo, agoraMs = Date.now()) {
  if (!p || typeof p !== 'object') return p;
  const a = p.agendamento;
  if (!a || typeof a !== 'object') return p;
  a.execucaoFalhouEm = new Date(agoraMs).toISOString();
  a.motivo = typeof motivo === 'string' ? motivo.slice(0, 200) : String(motivo ?? '').slice(0, 200);
  return p;
}

/**
 * Registra que o planejamento agendado disparou (carimbo ISO) e, quando
 * não sobra pendência de execução (nem executarEm nem executarAposPlanejar),
 * limpa o agendamento concluído. Não grava nada.
 */
export function marcarPlanejamentoAgendadoDisparado(p, agoraMs = Date.now()) {
  if (!p || typeof p !== 'object') return p;
  const a = p.agendamento;
  if (!a || typeof a !== 'object') return p;
  a.planejadoDisparadoEm = new Date(agoraMs).toISOString();
  if (a.executarEm == null && a.executarAposPlanejar !== true) delete p.agendamento;
  return p;
}

/**
 * Registra que a execução agendada disparou (carimbo ISO). O agendamento
 * fica guardado para exibição; avaliarAgendamentoProjeto passa a devolver
 * 'nenhuma' porque não resta pendência. Não grava nada.
 */
export function marcarExecucaoAgendadaDisparada(p, agoraMs = Date.now()) {
  if (!p || typeof p !== 'object') return p;
  const a = p.agendamento;
  if (!a || typeof a !== 'object') return p;
  a.execucaoDisparadaEm = new Date(agoraMs).toISOString();
  return p;
}

// "17/11 22:00", horário local, sempre com dois dígitos.
function formatarQuando(ms) {
  const d = new Date(ms);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${dd}/${mm} ${hh}:${mi}`;
}

// "2 h 15 min", "45 min", "1 h" ou "menos de 1 min".
function formatarRestante(msDelta) {
  const totalMin = Math.floor(msDelta / 60000);
  if (totalMin < 1) return 'menos de 1 min';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${m} min`;
}

/**
 * Resumo para o painel e para a API: { ativo, tipo ('planejar_e_executar' |
 * 'so_planejar' | 'executar' | null), planejarEm, executarEm,
 * executarAposPlanejar, planejadoDisparadoEm, execucaoDisparadaEm,
 * execucaoFalhouEm, motivo, acaoPrevista ('executar_de_novo' | 'executar' |
 * 'planejar' | 'planejar_e_executar' | null), comPlano, restanteMin,
 * proximoDisparoMs, texto }. texto é legível, ex.:
 * 'Execução agendada para 17/11 22:00 (em 2 h 15 min)' ou
 * 'Vai executar o plano de novo às 17/11 22:00 (em 2 h 15 min)'.
 */
export function resumoAgendamento(p, agoraMs = Date.now()) {
  const a = p && typeof p === 'object' ? p.agendamento : null;
  if (!a || typeof a !== 'object') {
    return {
      ativo: false,
      tipo: null,
      planejarEm: null,
      executarEm: null,
      executarAposPlanejar: false,
      planejadoDisparadoEm: null,
      execucaoDisparadaEm: null,
      execucaoFalhouEm: null,
      motivo: null,
      acaoPrevista: null,
      comPlano: false,
      restanteMin: null,
      proximoDisparoMs: null,
      texto: null,
    };
  }
  const pl = quandoMs(a.planejarEm);
  const ex = quandoMs(a.executarEm);
  const tipo = a.planejarEm != null ? (a.executarEm != null || a.executarAposPlanejar === true ? 'planejar_e_executar' : 'so_planejar') : (a.executarEm != null || a.executarAposPlanejar === true ? 'executar' : null);
  const temFalha = a.execucaoFalhouEm != null;
  const planejarPendente = !temFalha && a.planejarEm != null && a.planejadoDisparadoEm == null && pl != null;
  const execPorHoraPendente = !temFalha && a.executarEm != null && a.execucaoDisparadaEm == null && ex != null;
  const execAutoPendente = !temFalha && a.planejadoDisparadoEm != null && a.executarAposPlanejar === true && a.executarEm == null && a.execucaoDisparadaEm == null;
  const execPendente = execPorHoraPendente || execAutoPendente;
  const ativo = !temFalha && (planejarPendente || execPendente);

  let acaoPrevista = null;
  if (ativo) {
    if (planejarPendente) {
      acaoPrevista = tipo === 'planejar_e_executar' ? 'planejar_e_executar' : 'planejar';
    } else if (execPendente) {
      acaoPrevista = ESTADOS_REEXECUCAO.includes(p?.estado) ? 'executar_de_novo' : 'executar';
    }
  }

  let proximoDisparoMs = null;
  let restanteMin = null;
  if (planejarPendente) {
    proximoDisparoMs = pl;
  } else if (execPorHoraPendente) {
    proximoDisparoMs = ex;
  }
  if (proximoDisparoMs != null) restanteMin = Math.max(0, Math.ceil((proximoDisparoMs - agoraMs) / 60000));

  let texto;
  if (temFalha) {
    const falhaMs = ex ?? pl ?? quandoMs(a.execucaoFalhouEm) ?? agoraMs;
    texto = `Horário agendado (${formatarQuando(falhaMs)}) atingido, mas a execução não pôde começar: ${a.motivo || ''}`;
  } else if (ativo && planejarPendente) {
    texto = tipo === 'so_planejar' ? `Planejamento agendado para ${formatarQuando(pl)}` : `Planejamento e execução agendados para ${formatarQuando(pl)}`;
  } else if (ativo && ex != null) {
    const restante = ex > agoraMs ? ` (em ${formatarRestante(ex - agoraMs)})` : '';
    if (ESTADOS_REEXECUCAO.includes(p?.estado)) {
      texto = `Vai executar o plano de novo às ${formatarQuando(ex)}${restante}`;
    } else {
      texto = `Execução agendada para ${formatarQuando(ex)}${restante}`;
    }
  } else if (ativo) {
    texto = 'Execução agendada para quando o plano estiver pronto';
  } else {
    texto = 'Agendamento concluído';
  }

  return {
    ativo,
    tipo,
    planejarEm: a.planejarEm || null,
    executarEm: a.executarEm || null,
    executarAposPlanejar: a.executarAposPlanejar === true,
    planejadoDisparadoEm: a.planejadoDisparadoEm || null,
    execucaoDisparadaEm: a.execucaoDisparadaEm || null,
    execucaoFalhouEm: a.execucaoFalhouEm || null,
    motivo: a.motivo || null,
    acaoPrevista,
    comPlano: !!p?.plano,
    restanteMin,
    proximoDisparoMs,
    texto,
  };
}
