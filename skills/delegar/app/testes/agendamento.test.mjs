// Testes do módulo de agendamento. Unitários puros: sem servidor, sem arquivos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDataHoraAgendamento,
  validarAgendamentoInput,
  aplicarAgendamentoNoProjeto,
  avaliarAgendamentoProjeto,
  marcarPlanejamentoAgendadoDisparado,
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

function projetoComConversa(plano = null) {
  const p = projeto(plano);
  p.estado = plano ? 'plano_pronto' : 'conversando';
  p.mensagens = [{ papel: 'usuario', texto: 'oi', quando: AGORA }, { papel: 'planejador', texto: 'perguntando', quando: AGORA }];
  return p;
}

test('parseDataHoraAgendamento aceita ISO local, com espaço e com fuso', () => {
  const localEsperado = new Date(2026, 10, 17, 14, 30, 0, 0).getTime();
  const a = parseDataHoraAgendamento('2026-11-17T14:30', AGORA);
  assert.deepEqual(a, { ok: true, iso: new Date(localEsperado).toISOString(), ms: localEsperado });
  const b = parseDataHoraAgendamento('2026-11-17 14:30', AGORA);
  assert.equal(b.ok, true);
  assert.equal(b.ms, localEsperado);
  const fuso = parseDataHoraAgendamento('2026-11-17T14:30:00Z', Date.parse('2026-11-17T14:00:00Z'));
  assert.equal(fuso.ok, true);
  assert.equal(fuso.ms, Date.parse('2026-11-17T14:30:00Z'));
  const num = parseDataHoraAgendamento(AGORA + 3600000, AGORA);
  assert.equal(num.ok, true);
  assert.equal(num.ms, AGORA + 3600000);
});

test('parseDataHoraAgendamento rejeita tipos e strings maliciosos', () => {
  for (const v of [null, undefined, {}, [], true, false, '<script>', '__proto__', 'banana', '2026-13-40T99:99', '2026-11-17T25:00', -5]) {
    const r = parseDataHoraAgendamento(v, AGORA);
    assert.equal(r.ok, false, `deveria recusar: ${String(v)}`);
    assert.equal(r.erro, 'data ou hora inválida');
    assert.ok(!('ms' in r) && !('iso' in r));
  }
});

test('parseDataHoraAgendamento rejeita passado e futuro longe demais', () => {
  const r1 = parseDataHoraAgendamento(AGORA - 70000, AGORA);
  assert.equal(r1.ok, false);
  assert.equal(r1.erro, 'a data está no passado');
  const r2 = parseDataHoraAgendamento(AGORA - 30000, AGORA); // dentro da tolerância de 60s
  assert.equal(r2.ok, true);
  const r3 = parseDataHoraAgendamento(AGORA - 70000, AGORA, { permitirPassado: true });
  assert.equal(r3.ok, true);
  const diaMs = 24 * 60 * 60 * 1000;
  const r4 = parseDataHoraAgendamento(AGORA + 366 * diaMs, AGORA);
  assert.equal(r4.ok, false);
  assert.equal(r4.erro, 'a data está longe demais no futuro');
  const r5 = parseDataHoraAgendamento(AGORA + 364 * diaMs, AGORA);
  assert.equal(r5.ok, true);
});

test('validarAgendamentoInput com cancelar devolve agendamento nulo', () => {
  const r = validarAgendamentoInput({ cancelar: true }, { agoraMs: AGORA });
  assert.deepEqual(r, { ok: true, cancelar: true, agendamento: null });
});

test('validarAgendamentoInput valida campos, ordem das datas e plano automático', () => {
  const r1 = validarAgendamentoInput({ executarEm: '2026-11-17T22:00' }, { agoraMs: AGORA });
  assert.equal(r1.ok, true);
  assert.equal(r1.cancelar, false);
  assert.equal(r1.agendamento.executarAposPlanejar, false);
  assert.equal(r1.agendamento.planejarEm, null);
  assert.equal(r1.agendamento.executarEm, new Date(2026, 10, 17, 22, 0, 0, 0).toISOString());
  assert.equal(r1.agendamento.criadoEm, new Date(AGORA).toISOString());
  assert.equal(r1.agendamento.planejadoDisparadoEm, null);
  assert.equal(r1.agendamento.execucaoDisparadaEm, null);

  const r2 = validarAgendamentoInput({ planejarEm: '2026-11-17T14:00', executarEm: '2026-11-17T15:00' }, { agoraMs: AGORA });
  assert.equal(r2.ok, true);
  assert.equal(r2.agendamento.executarEm, new Date(2026, 10, 17, 15, 0, 0, 0).toISOString());

  const r3 = validarAgendamentoInput({ planejarEm: '2026-11-17T15:00', executarEm: '2026-11-17T14:00' }, { agoraMs: AGORA });
  assert.equal(r3.ok, false);
  assert.equal(r3.erro, 'a execução deve ser depois do planejamento');

  const r4 = validarAgendamentoInput({ executarAposPlanejar: true }, { agoraMs: AGORA });
  assert.equal(r4.ok, false);
  assert.equal(r4.erro, 'executarAposPlanejar exige planejarEm');

  const r5 = validarAgendamentoInput({ planejarEm: '2026-11-17T14:00', executarAposPlanejar: true }, { agoraMs: AGORA });
  assert.equal(r5.ok, true);
  assert.equal(r5.agendamento.executarAposPlanejar, true);

  const r6 = validarAgendamentoInput({}, { agoraMs: AGORA });
  assert.equal(r6.ok, false);
  assert.equal(r6.erro, 'informe planejarEm ou executarEm');

  const r7 = validarAgendamentoInput({ planejarEm: '2026-11-17T14:00', executarAposPlanejar: 'sim' }, { agoraMs: AGORA });
  assert.equal(r7.ok, false);
  assert.equal(r7.erro, 'executarAposPlanejar deve ser verdadeiro ou falso');
});

test('validarAgendamentoInput recusa corpo e datas maliciosos sem ecoar a entrada', () => {
  for (const body of [null, undefined, 'x', 42, ['executarEm'], { executarEm: { aninhado: true } }, { executarEm: '<script>alert(1)</script>' }, { executarEm: '__proto__' }]) {
    const r = validarAgendamentoInput(body, { agoraMs: AGORA });
    assert.equal(r.ok, false, `deveria recusar: ${JSON.stringify(body)}`);
    assert.ok(!JSON.stringify(r).includes('script'));
    assert.ok(!JSON.stringify(r).includes('proto'));
  }
});

test('aplicarAgendamentoNoProjeto define agendado e restaura o estado ao cancelar', () => {
  const p1 = projeto(null);
  const r1 = aplicarAgendamentoNoProjeto(p1, { planejarEm: new Date(AGORA + 60000).toISOString(), executarEm: null, executarAposPlanejar: false }, AGORA);
  assert.equal(r1, p1);
  assert.equal(p1.estado, 'agendado');
  assert.equal(typeof p1.agendamento.planejarEm, 'string');

  const cancelado = validarAgendamentoInput({ cancelar: true }, { agoraMs: AGORA });
  aplicarAgendamentoNoProjeto(p1, cancelado.agendamento, AGORA);
  assert.equal(p1.agendamento, undefined);
  assert.equal(p1.estado, 'planejando');

  const p2 = projetoComConversa(null);
  p2.estado = 'agendado';
  aplicarAgendamentoNoProjeto(p2, null, AGORA);
  assert.equal(p2.estado, 'conversando');

  const p3 = projeto({ etapas: [] }, 'agendado');
  aplicarAgendamentoNoProjeto(p3, null, AGORA);
  assert.equal(p3.estado, 'plano_pronto');
});

test('aplicarAgendamentoNoProjeto: execução futura com plano mantém plano_pronto', () => {
  const p = projeto({ etapas: [] });
  aplicarAgendamentoNoProjeto(p, { planejarEm: null, executarEm: new Date(AGORA + 3600000).toISOString(), executarAposPlanejar: false }, AGORA);
  assert.equal(p.estado, 'plano_pronto');
  assert.ok(p.agendamento.executarEm);
});

test('avaliarAgendamentoProjeto ignora projeto arquivado, executando ou ocupado', () => {
  const quando = new Date(AGORA - 60000).toISOString();
  const p1 = projeto({ etapas: [] });
  p1.agendamento = { planejarEm: null, executarEm: quando, executarAposPlanejar: false, planejadoDisparadoEm: null, execucaoDisparadaEm: null };
  p1.arquivado = true;
  assert.deepEqual(avaliarAgendamentoProjeto(p1, AGORA), { acao: 'nenhuma' });
  p1.arquivado = false;
  p1.estado = 'executando';
  assert.deepEqual(avaliarAgendamentoProjeto(p1, AGORA), { acao: 'nenhuma' });
  p1.estado = 'plano_pronto';
  p1.ocupado = true;
  assert.deepEqual(avaliarAgendamentoProjeto(p1, AGORA), { acao: 'nenhuma' });
  assert.deepEqual(avaliarAgendamentoProjeto(projeto(null), AGORA), { acao: 'nenhuma' });
});

test('fluxo 1: plano pronto com execução agendada dispara uma única vez', () => {
  const execMs = AGORA + 3600000;
  const p = projeto({ etapas: [] });
  aplicarAgendamentoNoProjeto(p, { planejarEm: null, executarEm: new Date(execMs).toISOString(), executarAposPlanejar: false }, AGORA);
  assert.deepEqual(avaliarAgendamentoProjeto(p, AGORA), { acao: 'aguardar', proximoDisparoMs: execMs, tipoPendencia: 'executar' });
  assert.deepEqual(avaliarAgendamentoProjeto(p, execMs), { acao: 'executar' });
  assert.deepEqual(avaliarAgendamentoProjeto(p, execMs + 5), { acao: 'executar' }); // ainda não marcada, segue pendente
  marcarExecucaoAgendadaDisparada(p, execMs + 10);
  assert.deepEqual(avaliarAgendamentoProjeto(p, execMs + 20), { acao: 'nenhuma' }); // sem duplo disparo
});

test('fluxo 2: planejamento agendado dispara e depois a execução automática', () => {
  const planejarMs = AGORA + 60000;
  const p = projeto(null);
  p.estado = 'planejando';
  aplicarAgendamentoNoProjeto(p, { planejarEm: new Date(planejarMs).toISOString(), executarEm: null, executarAposPlanejar: true }, AGORA);
  assert.equal(p.estado, 'agendado');
  assert.deepEqual(avaliarAgendamentoProjeto(p, AGORA), { acao: 'aguardar', proximoDisparoMs: planejarMs, tipoPendencia: 'planejar' });
  assert.deepEqual(avaliarAgendamentoProjeto(p, planejarMs), { acao: 'planejar', autoExecutarDepois: true });
  marcarPlanejamentoAgendadoDisparado(p, planejarMs + 10);
  assert.ok(p.agendamento.planejadoDisparadoEm); // agendamento fica pendente da execução
  // sem plano ainda, aguarda
  assert.deepEqual(avaliarAgendamentoProjeto(p, planejarMs + 100), { acao: 'aguardar', proximoDisparoMs: null, tipoPendencia: 'executar' });
  // planejador entregou o plano
  p.plano = { etapas: [] };
  p.estado = 'plano_pronto';
  assert.deepEqual(avaliarAgendamentoProjeto(p, planejarMs + 200), { acao: 'executar' });
  marcarExecucaoAgendadaDisparada(p, planejarMs + 300);
  assert.deepEqual(avaliarAgendamentoProjeto(p, planejarMs + 400), { acao: 'nenhuma' });
});

test('fluxo 2 com executarEm depois do planejamento espera a hora da execução', () => {
  const planejarMs = AGORA + 60000;
  const execMs = AGORA + 2 * 3600000;
  const p = projeto(null);
  aplicarAgendamentoNoProjeto(p, { planejarEm: new Date(planejarMs).toISOString(), executarEm: new Date(execMs).toISOString(), executarAposPlanejar: true }, AGORA);
  assert.deepEqual(avaliarAgendamentoProjeto(p, AGORA), { acao: 'aguardar', proximoDisparoMs: planejarMs, tipoPendencia: 'planejar' });
  assert.deepEqual(avaliarAgendamentoProjeto(p, planejarMs), { acao: 'planejar', autoExecutarDepois: false });
  marcarPlanejamentoAgendadoDisparado(p, planejarMs);
  p.plano = { etapas: [] };
  p.estado = 'plano_pronto';
  assert.deepEqual(avaliarAgendamentoProjeto(p, planejarMs + 100), { acao: 'aguardar', proximoDisparoMs: execMs, tipoPendencia: 'executar' });
  assert.deepEqual(avaliarAgendamentoProjeto(p, execMs), { acao: 'executar' });
  marcarExecucaoAgendadaDisparada(p, execMs);
  assert.deepEqual(avaliarAgendamentoProjeto(p, execMs + 100), { acao: 'nenhuma' });
});

test('planejamento sem execução pendente termina o agendamento ao disparar', () => {
  const planejarMs = AGORA + 60000;
  const p = projeto(null);
  aplicarAgendamentoNoProjeto(p, { planejarEm: new Date(planejarMs).toISOString(), executarEm: null, executarAposPlanejar: false }, AGORA);
  marcarPlanejamentoAgendadoDisparado(p, planejarMs);
  assert.equal(p.agendamento, undefined); // nada pendente: limpa
  assert.deepEqual(avaliarAgendamentoProjeto(p, planejarMs + 100), { acao: 'nenhuma' });
});

test('resumoAgendamento formata texto com data e restante', () => {
  const sem = resumoAgendamento(projeto(null), AGORA);
  assert.equal(sem.ativo, false);
  assert.equal(sem.tipo, null);
  assert.equal(sem.texto, null);

  const agoraResumo = new Date(2026, 10, 17, 19, 45, 0, 0).getTime();
  const execMs = new Date(2026, 10, 17, 22, 0, 0, 0).getTime();
  const p1 = projeto({ etapas: [] });
  p1.agendamento = { planejarEm: null, executarEm: new Date(execMs).toISOString(), executarAposPlanejar: false, planejadoDisparadoEm: null, execucaoDisparadaEm: null };
  const r1 = resumoAgendamento(p1, agoraResumo);
  assert.equal(r1.ativo, true);
  assert.equal(r1.tipo, 'executar');
  assert.equal(r1.restanteMin, 135);
  assert.equal(r1.texto, 'Execução agendada para 17/11 22:00 (em 2 h 15 min)');

  const planejarMs = new Date(2026, 10, 18, 8, 0, 0, 0).getTime();
  const execMs2 = new Date(2026, 10, 18, 10, 0, 0, 0).getTime();
  const p2 = projeto(null);
  p2.agendamento = { planejarEm: new Date(planejarMs).toISOString(), executarEm: new Date(execMs2).toISOString(), executarAposPlanejar: true, planejadoDisparadoEm: null, execucaoDisparadaEm: null };
  const r2 = resumoAgendamento(p2, agoraResumo);
  assert.equal(r2.tipo, 'planejar_e_executar');
  assert.equal(r2.texto, 'Planejamento e execução agendados para 18/11 08:00');

  const p3 = projeto(null);
  p3.agendamento = { planejarEm: new Date(planejarMs).toISOString(), executarEm: null, executarAposPlanejar: false, planejadoDisparadoEm: null, execucaoDisparadaEm: null };
  const r3 = resumoAgendamento(p3, agoraResumo);
  assert.equal(r3.tipo, 'so_planejar');
  assert.equal(r3.texto, 'Planejamento agendado para 18/11 08:00');

  const p4 = projeto(null);
  p4.agendamento = { planejarEm: new Date(agoraResumo - 60000).toISOString(), executarEm: null, executarAposPlanejar: false, planejadoDisparadoEm: null, execucaoDisparadaEm: null };
  const r4 = resumoAgendamento(p4, agoraResumo);
  assert.equal(r4.texto, 'Planejamento agendado para 17/11 19:44'); // já venceu: sem "(em ...)"
});

test('resumoAgendamento expõe carimbos e agendamento concluído', () => {
  const planejarMs = AGORA + 60000;
  const p = projeto(null);
  aplicarAgendamentoNoProjeto(p, { planejarEm: new Date(planejarMs).toISOString(), executarEm: null, executarAposPlanejar: true }, AGORA);
  let r = resumoAgendamento(p, AGORA);
  assert.equal(r.ativo, true);
  assert.equal(r.comPlano, false);
  assert.equal(r.planejadoDisparadoEm, null);
  marcarPlanejamentoAgendadoDisparado(p, planejarMs);
  r = resumoAgendamento(p, planejarMs + 10);
  assert.equal(r.ativo, true);
  assert.equal(r.planejadoDisparadoEm, new Date(planejarMs).toISOString());
  assert.equal(r.tipo, 'planejar_e_executar');
  assert.equal(r.texto, 'Execução agendada para quando o plano estiver pronto');
  marcarExecucaoAgendadaDisparada(p, planejarMs + 100);
  r = resumoAgendamento(p, planejarMs + 200);
  assert.equal(r.ativo, false);
  assert.equal(r.execucaoDisparadaEm, new Date(planejarMs + 100).toISOString());
  assert.equal(r.texto, 'Agendamento concluído');
});
