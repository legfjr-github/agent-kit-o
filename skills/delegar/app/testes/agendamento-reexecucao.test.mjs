// Testes de reexecução e diagnóstico de agendamento do Delegar.
// Unitários puros: sem servidor, sem arquivos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ESTADOS_REEXECUCAO,
  podeAgendar,
  avaliarAgendamentoProjeto,
  diagnosticarAgendamentoNaHora,
  marcarExecucaoAgendadaFalhou,
  marcarExecucaoAgendadaDisparada,
  resumoAgendamento,
} from '../agendamento.mjs';

// Agora fixo em hora local de 17/11/2026 ao meio-dia (independente de fuso).
const AGORA = new Date(2026, 10, 17, 12, 0, 0, 0).getTime();

function projeto(plano = null, estado = null) {
  return {
    id: 'x1',
    criado: AGORA,
    estado: estado || (plano ? 'plano_pronto' : 'planejando'),
    mensagens: [],
    plano,
    agendamento: undefined,
  };
}

test('(a) execução agendada a partir de estados de reexecução devolve { acao: "executar", reexecutar: true } na hora e aguardar antes', () => {
  assert.ok(Object.isFrozen(ESTADOS_REEXECUCAO));
  assert.deepEqual(ESTADOS_REEXECUCAO, ['cancelado', 'incompleto', 'interrompido', 'concluido']);

  const execMs = AGORA + 3600000;
  for (const estado of ESTADOS_REEXECUCAO) {
    const p = projeto({ etapas: [] }, estado);
    p.agendamento = {
      planejarEm: null,
      executarEm: new Date(execMs).toISOString(),
      executarAposPlanejar: false,
      planejadoDisparadoEm: null,
      execucaoDisparadaEm: null,
    };

    // Antes da hora: aguardar
    const antes = avaliarAgendamentoProjeto(p, AGORA);
    assert.deepEqual(antes, { acao: 'aguardar', proximoDisparoMs: execMs, tipoPendencia: 'executar' });

    // Na hora: executar com reexecutar: true
    const naHora = avaliarAgendamentoProjeto(p, execMs);
    assert.deepEqual(naHora, { acao: 'executar', reexecutar: true });
  }
});

const agCancelado = (execMs) => ({
  planejarEm: null,
  executarEm: new Date(execMs).toISOString(),
  executarAposPlanejar: false,
  planejadoDisparadoEm: null,
  execucaoDisparadaEm: null,
});

test('(b) projeto cancelado com executarEm vencido há pouco dispara uma única vez', () => {
  const p = projeto({ etapas: [] }, 'cancelado');
  p.agendamento = agCancelado(AGORA - 5 * 60000);
  assert.deepEqual(avaliarAgendamentoProjeto(p, AGORA), { acao: 'executar', reexecutar: true });
  marcarExecucaoAgendadaDisparada(p, AGORA);
  assert.deepEqual(avaliarAgendamentoProjeto(p, AGORA + 1000), { acao: 'nenhuma' });
  assert.equal(diagnosticarAgendamentoNaHora(p, AGORA + 1000), null);
});

test('(b2) caso real 18/11: rodada nova com horário vencido há 8 h não dispara e o motivo é registrado', () => {
  for (const estado of ESTADOS_REEXECUCAO) {
    const p = projeto({ etapas: [] }, estado);
    p.agendamento = agCancelado(AGORA - 8 * 3600000);
    assert.deepEqual(avaliarAgendamentoProjeto(p, AGORA), { acao: 'nenhuma' }, estado);
    const d = diagnosticarAgendamentoNaHora(p, AGORA);
    assert.equal(d?.tipoPendencia, 'executar', estado);
    assert.match(d.motivo, /mais de 2 h/);
    marcarExecucaoAgendadaFalhou(p, d.motivo, AGORA);
    assert.equal(diagnosticarAgendamentoNaHora(p, AGORA + 1000), null, 'registra uma vez só');
  }
});

test('(b3) plano pronto com horário vencido há 8 h ainda dispara (primeira execução, não é rodada nova)', () => {
  const p = projeto({ etapas: [] }, 'plano_pronto');
  p.agendamento = agCancelado(AGORA - 8 * 3600000);
  assert.deepEqual(avaliarAgendamentoProjeto(p, AGORA), { acao: 'executar' });
});

test('(c) podeAgendar valida regras na ordem esperada', () => {
  const execFuturo = { executarEm: new Date(AGORA + 3600000).toISOString() };
  const planFuturo = { planejarEm: new Date(AGORA + 1800000).toISOString() };

  // 1. Cancelar (null) sempre ok
  assert.deepEqual(podeAgendar(projeto(null, 'planejando'), null), { ok: true });
  assert.deepEqual(podeAgendar({ arquivado: true, estado: 'executando' }, null), { ok: true });

  // 2. Projeto arquivado recusa
  const pArq = projeto({ etapas: [] }, 'plano_pronto');
  pArq.arquivado = true;
  assert.deepEqual(podeAgendar(pArq, execFuturo), {
    ok: false,
    erro: 'o projeto está arquivado: desarquive antes de agendar',
  });

  // 3. Estado executando recusa
  const pExec = projeto({ etapas: [] }, 'executando');
  assert.deepEqual(podeAgendar(pExec, execFuturo), {
    ok: false,
    erro: 'execução em andamento',
  });

  // 4. Agendamento com planejarEm aceita mesmo sem plano
  const pSemPlano = projeto(null, 'planejando');
  assert.deepEqual(podeAgendar(pSemPlano, planFuturo), { ok: true });

  // 5. Com plano: aceita estados executáveis e de reexecução, recusa estados fora do conjunto
  const pCancelado = projeto({ etapas: [] }, 'cancelado');
  assert.deepEqual(podeAgendar(pCancelado, execFuturo), { ok: true });
  const pConcluido = projeto({ etapas: [] }, 'concluido');
  assert.deepEqual(podeAgendar(pConcluido, execFuturo), { ok: true });

  const pEstadoInvalido = projeto({ etapas: [] }, 'rascunho_desconhecido');
  assert.deepEqual(podeAgendar(pEstadoInvalido, execFuturo), {
    ok: false,
    erro: 'o estado atual do projeto não permite executar o plano',
  });

  // 6. Sem plano mas com ocupado === true (planejador respondendo agora): aceita
  const pOcupado = projeto(null, 'planejando');
  pOcupado.ocupado = true;
  assert.deepEqual(podeAgendar(pOcupado, execFuturo), { ok: true });

  // 7. Sem plano e sem planejarEm: recusa
  assert.deepEqual(podeAgendar(pSemPlano, execFuturo), {
    ok: false,
    erro: 'o projeto ainda não tem plano: agende também o planejamento ou espere o plano ficar pronto',
  });
});

test('(d) arquivado com executarEm vencido diagnostica e registra falha com resumo inativo', () => {
  const execPassado = AGORA - 3600000;
  const p = projeto({ etapas: [] }, 'plano_pronto');
  p.arquivado = true;
  p.agendamento = {
    planejarEm: null,
    executarEm: new Date(execPassado).toISOString(),
    executarAposPlanejar: false,
    planejadoDisparadoEm: null,
    execucaoDisparadaEm: null,
  };

  assert.deepEqual(avaliarAgendamentoProjeto(p, AGORA), { acao: 'nenhuma' });
  const diag = diagnosticarAgendamentoNaHora(p, AGORA);
  assert.deepEqual(diag, { tipoPendencia: 'executar', motivo: 'o projeto está arquivado' });

  marcarExecucaoAgendadaFalhou(p, diag.motivo, AGORA);
  assert.equal(diagnosticarAgendamentoNaHora(p, AGORA), null);
  assert.deepEqual(avaliarAgendamentoProjeto(p, AGORA), { acao: 'nenhuma' });

  const res = resumoAgendamento(p, AGORA);
  assert.equal(res.ativo, false);
  assert.equal(res.execucaoFalhouEm, new Date(AGORA).toISOString());
  assert.equal(res.motivo, 'o projeto está arquivado');
  assert.equal(res.acaoPrevista, null);
  assert.equal(res.texto, 'Horário agendado (17/11 11:00) atingido, mas a execução não pôde começar: o projeto está arquivado');
});

test('(e) executando e ocupado na hora: avaliar nenhuma; executando diagnostica motivo e ocupado dá null', () => {
  const execPassado = AGORA - 1000;

  const pExec = projeto({ etapas: [] }, 'executando');
  pExec.agendamento = {
    planejarEm: null,
    executarEm: new Date(execPassado).toISOString(),
    executarAposPlanejar: false,
    planejadoDisparadoEm: null,
    execucaoDisparadaEm: null,
  };
  assert.deepEqual(avaliarAgendamentoProjeto(pExec, AGORA), { acao: 'nenhuma' });
  assert.deepEqual(diagnosticarAgendamentoNaHora(pExec, AGORA), {
    tipoPendencia: 'executar',
    motivo: 'já havia uma execução em andamento no horário',
  });

  const pOcup = projeto({ etapas: [] }, 'plano_pronto');
  pOcup.ocupado = true;
  pOcup.agendamento = {
    planejarEm: null,
    executarEm: new Date(execPassado).toISOString(),
    executarAposPlanejar: false,
    planejadoDisparadoEm: null,
    execucaoDisparadaEm: null,
  };
  assert.deepEqual(avaliarAgendamentoProjeto(pOcup, AGORA), { acao: 'nenhuma' });
  assert.equal(diagnosticarAgendamentoNaHora(pOcup, AGORA), null);
});

test('(f) resumoAgendamento para projeto concluído gera texto de reexecução e acaoPrevista executar_de_novo', () => {
  const execFuturo = AGORA + 2 * 3600000;
  const p = projeto({ etapas: [] }, 'concluido');
  p.agendamento = {
    planejarEm: null,
    executarEm: new Date(execFuturo).toISOString(),
    executarAposPlanejar: false,
    planejadoDisparadoEm: null,
    execucaoDisparadaEm: null,
  };

  const resAntes = resumoAgendamento(p, AGORA);
  assert.equal(resAntes.ativo, true);
  assert.equal(resAntes.acaoPrevista, 'executar_de_novo');
  assert.equal(resAntes.texto, 'Vai executar o plano de novo às 17/11 14:00 (em 2 h)');

  // Quando vencido (sem "(em X)"):
  const resDepois = resumoAgendamento(p, execFuturo + 1000);
  assert.equal(resDepois.ativo, true);
  assert.equal(resDepois.acaoPrevista, 'executar_de_novo');
  assert.equal(resDepois.texto, 'Vai executar o plano de novo às 17/11 14:00');
});

test('(g) marcarExecucaoAgendadaFalhou armazena motivo malicioso como texto cortado em 200 caracteres', () => {
  const p = projeto({ etapas: [] }, 'cancelado');
  p.agendamento = {
    planejarEm: null,
    executarEm: new Date(AGORA - 1000).toISOString(),
    executarAposPlanejar: false,
    planejadoDisparadoEm: null,
    execucaoDisparadaEm: null,
  };

  const malicioso = '<script>alert("xss")</script>' + 'B'.repeat(300);
  marcarExecucaoAgendadaFalhou(p, malicioso, AGORA);

  assert.equal(typeof p.agendamento.motivo, 'string');
  assert.equal(p.agendamento.motivo.length, 200);
  assert.ok(p.agendamento.motivo.startsWith('<script>alert("xss")</script>'));
  assert.equal(p.agendamento.execucaoFalhouEm, new Date(AGORA).toISOString());
});

test('diagnosticarAgendamentoNaHora: casos adicionais (sem plano, estado inválido sanitizado, sem vencimento)', () => {
  const execPassado = AGORA - 5000;

  // Sem plano e sem planejamento pendente
  const pSemPlano = projeto(null, 'planejando');
  pSemPlano.agendamento = {
    planejarEm: null,
    executarEm: new Date(execPassado).toISOString(),
    executarAposPlanejar: false,
    planejadoDisparadoEm: null,
    execucaoDisparadaEm: null,
  };
  assert.deepEqual(diagnosticarAgendamentoNaHora(pSemPlano, AGORA), {
    tipoPendencia: 'executar',
    motivo: 'o projeto não tem plano',
  });

  // Com plano em estado fora do conjunto executável (sanitização e corte em 40 chars)
  const pInvalido = projeto({ etapas: [] }, 'estado!_estranho#@com-muito-texto-que-ultrapassa-quarenta-caracteres');
  pInvalido.agendamento = {
    planejarEm: null,
    executarEm: new Date(execPassado).toISOString(),
    executarAposPlanejar: false,
    planejadoDisparadoEm: null,
    execucaoDisparadaEm: null,
  };
  const diagInv = diagnosticarAgendamentoNaHora(pInvalido, AGORA);
  assert.equal(diagInv.tipoPendencia, 'executar');
  // estadoLimpo: 'estado__estranhocommuitotextoqueultrapas' (40 chars alfanuméricos e _)
  assert.ok(diagInv.motivo.startsWith("o estado '"));
  assert.ok(diagInv.motivo.endsWith("' não permite executar o plano"));
  assert.ok(!diagInv.motivo.includes('!'));
  assert.ok(!diagInv.motivo.includes('#'));
  assert.ok(!diagInv.motivo.includes('@'));

  // Sem vencimento (futuro) devolve null
  const pFuturo = projeto({ etapas: [] }, 'cancelado');
  pFuturo.agendamento = {
    planejarEm: null,
    executarEm: new Date(AGORA + 3600000).toISOString(),
    executarAposPlanejar: false,
    planejadoDisparadoEm: null,
    execucaoDisparadaEm: null,
  };
  assert.equal(diagnosticarAgendamentoNaHora(pFuturo, AGORA), null);

  // Sem agendamento devolve null
  assert.equal(diagnosticarAgendamentoNaHora(projeto({ etapas: [] }, 'plano_pronto'), AGORA), null);
});
