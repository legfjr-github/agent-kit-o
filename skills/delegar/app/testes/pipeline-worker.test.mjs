process.env.DELEGAR_SEM_AVISO = '1'; // pipelines de teste não abrem o aviso msg do Windows
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.resolve(aqui, '..', '..', 'scripts');
const WORKER = path.join(SCRIPTS, 'worker.ps1');
const PIPELINE = path.join(SCRIPTS, 'pipeline.ps1');
const QUOTA = path.join(SCRIPTS, 'quota.ps1');

// 1. worker.ps1 pulando agy:claude-* e agy:gpt-* quando agyClaudeGpt esta esgotado
test('worker.ps1 pula agy:claude e agy:gpt quando agyClaudeGpt esta esgotado', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-test-1-'));
  try {
    const stateDir = path.join(dir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });

    // quota-last.json com agyClaudeGpt esgotado e read=false (leitura restaurada)
    const quotaLast = {
      time: new Date().toISOString(),
      claude: { installed: false, read: false },
      gemini: { installed: true, read: true, fiveHourRemaining: 0.8, sevenDayRemaining: 0.8, exhausted: false },
      agyClaudeGpt: { read: false, fiveHourRemaining: 0.01, sevenDayRemaining: 0.01, exhausted: true, readAt: new Date().toISOString() },
      recommendedConcurrent: 2,
    };
    fs.writeFileSync(path.join(stateDir, 'quota-last.json'), JSON.stringify(quotaLast), 'utf8');

    // Mock do agy que responde com sucesso
    const mockAgy = path.join(dir, 'mock-agy.bat');
    fs.writeFileSync(mockAgy, '@echo off\r\necho Resposta do Gemini\r\nexit /b 0\r\n', 'utf8');

    const promptFile = path.join(dir, 'task.md');
    fs.writeFileSync(promptFile, 'Responda ok.', 'utf8');
    const logDir = path.join(dir, 'logs', 'task-1');

    execFileSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WORKER,
      '-PromptFile', promptFile,
      '-Cwd', dir,
      '-LogDir', logDir,
      '-Chain', 'agy:claude-sonnet-5-5-high,agy:gpt-oss-120b-medium,agy:gemini-3.8-flash-high',
    ], {
      env: { ...process.env, DELEGAR_DATA: dir, AGY_BIN: mockAgy },
      encoding: 'utf8',
      timeout: 30000,
    });

    const result = JSON.parse(fs.readFileSync(path.join(logDir, 'result.json'), 'utf8').replace(/^\uFEFF/, ''));
    assert.equal(result.ok, true);
    assert.equal(result.model, 'agy:gemini-3.8-flash-high');
    assert.equal(result.attempts.length, 3);
    assert.equal(result.attempts[0].worker, 'agy:claude-sonnet-5-5-high');
    assert.equal(result.attempts[0].quota, true);
    assert.match(result.attempts[0].skipped, /agyClaudeGpt/);
    assert.equal(result.attempts[1].worker, 'agy:gpt-oss-120b-medium');
    assert.equal(result.attempts[1].quota, true);
    assert.match(result.attempts[1].skipped, /agyClaudeGpt/);
    assert.equal(result.attempts[2].worker, 'agy:gemini-3.8-flash-high');
    assert.equal(result.attempts[2].exitCode, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 2. worker.ps1 -NoFreeFallback removendo modelos gratuitos e marcando quotaExhausted=true
test('worker.ps1 -NoFreeFallback remove modelos gratuitos e marca quotaExhausted quando pagos acabam', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-test-2-'));
  try {
    const stateDir = path.join(dir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });

    // Gemini e Claude esgotados
    const quotaLast = {
      time: new Date().toISOString(),
      claude: { installed: true, read: true, fiveHour: 0.99, sevenDay: 0.99 },
      gemini: { installed: true, read: true, fiveHourRemaining: 0.01, sevenDayRemaining: 0.01, exhausted: true },
      agyClaudeGpt: { read: true, exhausted: true, fiveHourRemaining: 0.01 },
      recommendedConcurrent: 0,
    };
    fs.writeFileSync(path.join(stateDir, 'quota-last.json'), JSON.stringify(quotaLast), 'utf8');

    const promptFile = path.join(dir, 'task.md');
    fs.writeFileSync(promptFile, 'Responda ok.', 'utf8');
    const logDir = path.join(dir, 'logs', 'task-2');

    let erroLancado = false;
    try {
      execFileSync('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WORKER,
        '-PromptFile', promptFile,
        '-Cwd', dir,
        '-LogDir', logDir,
        '-Chain', 'agy:gemini-3.8-flash-high,opencode:opencode/glm-5.3-flash-free,opencode:opencode/big-pickle',
        '-NoFreeFallback',
      ], {
        env: { ...process.env, DELEGAR_DATA: dir },
        encoding: 'utf8',
        timeout: 30000,
      });
    } catch {
      erroLancado = true;
    }

    assert.equal(erroLancado, true, 'worker deve sair com erro pois falhou sem cota');
    const result = JSON.parse(fs.readFileSync(path.join(logDir, 'result.json'), 'utf8').replace(/^\uFEFF/, ''));
    assert.equal(result.ok, false);
    assert.equal(result.quotaExhausted, true);
    // Modelos gratuitos devem ter sido removidos da cadeia
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].worker, 'agy:gemini-3.8-flash-high');
    assert.equal(result.attempts[0].quota, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 3. worker.ps1 -IdleTimeoutSeconds 2 encerra comando travado e grava evento vigia
test('worker.ps1 -IdleTimeoutSeconds (vigia) encerra comando travado e passa para o proximo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-test-3-'));
  try {
    const mockAgy = path.join(dir, 'mock-agy.bat');
    // Mock que trava quando chamado com travado e responde ok quando chamado com rapido
    fs.writeFileSync(mockAgy, [
      '@echo off',
      'echo %2 | findstr "travado" >nul', // só o nome do modelo (%1 = --model): o prompt pode citar o modelo anterior
      'if %errorlevel% equ 0 (',
      '  ping 127.0.0.1 -n 11 >nul',
      '  exit /b 0',
      ')',
      'echo Resposta rapida',
      'exit /b 0',
    ].join('\r\n'), 'utf8');

    const promptFile = path.join(dir, 'task.md');
    fs.writeFileSync(promptFile, 'Responda ok.', 'utf8');
    const logDir = path.join(dir, 'logs', 'task-3');

    execFileSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WORKER,
      '-PromptFile', promptFile,
      '-Cwd', dir,
      '-LogDir', logDir,
      '-Chain', 'agy:modelo-travado,agy:modelo-rapido',
      '-IdleTimeoutSeconds', '2',
    ], {
      env: { ...process.env, DELEGAR_DATA: dir, AGY_BIN: mockAgy },
      encoding: 'utf8',
      timeout: 30000,
    });

    const result = JSON.parse(fs.readFileSync(path.join(logDir, 'result.json'), 'utf8').replace(/^\uFEFF/, ''));
    assert.equal(result.ok, true);
    assert.equal(result.model, 'agy:modelo-rapido');
    assert.equal(result.attempts.length, 2);
    assert.equal(result.attempts[0].stalled, true);

    const eventsFile = path.join(dir, 'logs', 'events.jsonl');
    assert.equal(fs.existsSync(eventsFile), true);
    const eventos = fs.readFileSync(eventsFile, 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l));
    const eventoVigia = eventos.find((e) => e.tipo === 'vigia');
    assert.notEqual(eventoVigia, undefined, 'deve existir evento do tipo vigia');
    assert.match(eventoVigia.texto, /sem saida nem evento/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 3b. opencode:nvidia/* travado sem saida: 1 tentativa + 2 retentativas, depois fallback
test('worker.ps1 retenta opencode:nvidia/* travado 3 vezes (eventos espera) e cai para o proximo modelo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-test-3b-'));
  try {
    const binDir = path.join(dir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    // opencode falso: trava sem escrever nada
    fs.writeFileSync(path.join(binDir, 'opencode.cmd'), '@echo off\r\nping 127.0.0.1 -n 31 >nul\r\nexit /b 0\r\n', 'utf8');
    const mockAgy = path.join(dir, 'mock-agy.bat');
    fs.writeFileSync(mockAgy, '@echo off\r\necho Resposta do agy\r\nexit /b 0\r\n', 'utf8');

    const promptFile = path.join(dir, 'task.md');
    fs.writeFileSync(promptFile, 'Responda ok.', 'utf8');
    const logDir = path.join(dir, 'logs', 'task-3b');

    execFileSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WORKER,
      '-PromptFile', promptFile,
      '-Cwd', dir,
      '-LogDir', logDir,
      '-Chain', 'opencode:nvidia/modelo-mock,agy:modelo-rapido',
      '-IdleTimeoutSeconds', '2',
      '-NvidiaRpmWaitSeconds', '1',
    ], {
      env: { ...process.env, DELEGAR_DATA: dir, AGY_BIN: mockAgy, PATH: binDir + path.delimiter + process.env.PATH },
      encoding: 'utf8',
      timeout: 90000,
    });

    const result = JSON.parse(fs.readFileSync(path.join(logDir, 'result.json'), 'utf8').replace(/^﻿/, ''));
    assert.equal(result.ok, true);
    assert.equal(result.model, 'agy:modelo-rapido');
    assert.equal(result.attempts.length, 4);
    const nv = result.attempts.filter((a) => a.worker === 'opencode:nvidia/modelo-mock');
    assert.equal(nv.length, 3);
    assert.ok(nv.every((a) => a.stalled === true));
    assert.equal(new Set(nv.map((a) => a.out)).size, 3, 'cada tentativa tem seu proprio log');
    assert.match(result.attempts[3].out, /4-modelo-rapido\.out\.log$/);

    const eventos = fs.readFileSync(path.join(dir, 'logs', 'events.jsonl'), 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l));
    const esperas = eventos.filter((e) => e.tipo === 'espera');
    assert.equal(esperas.length, 2);
    assert.match(esperas[0].texto, /1\/2/);
    assert.match(esperas[1].texto, /2\/2/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 4. pipeline.ps1 Verify ignora sujeira preexistente e reprova sujeira nova da tarefa main
test('pipeline.ps1 Verify ignora sujeira preexistente e reprova sujeira nova de tarefa main', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-test-4-'));
  try {
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo, { recursive: true });

    // Inicializa repositorio git
    execSync('git init', { cwd: repo });
    execSync('git config user.email "test@example.com"', { cwd: repo });
    execSync('git config user.name "Test"', { cwd: repo });
    fs.writeFileSync(path.join(repo, 'inicial.txt'), 'base', 'utf8');
    execSync('git add inicial.txt && git commit -m "commit inicial"', { cwd: repo });

    // Arquivo nao rastreado preexistente deixado por outra sessao
    fs.writeFileSync(path.join(repo, 'preexistente.txt'), 'sujeira preexistente', 'utf8');

    // Mock agy que roda no worker
    const mockAgy = path.join(dir, 'mock-agy.bat');
    fs.writeFileSync(mockAgy, [
      '@echo off',
      'echo Tarefa concluiu trabalho',
      'exit /b 0',
    ].join('\r\n'), 'utf8');

    // Teste A: tarefa main nao suja arquivos novos -> pipeline conclui com sucesso
    const planA = {
      name: 'teste-sujeira-a',
      repo,
      tasks: [
        { id: 't1', titulo: 'Integrar limpo', main: true, prompt: 't1.md', chain: ['agy:gemini-mock'] },
      ],
      verify: [],
      maxConcurrent: 1,
    };
    const planFileA = path.join(dir, 'planA.json');
    fs.writeFileSync(planFileA, JSON.stringify(planA), 'utf8');
    fs.writeFileSync(path.join(dir, 't1.md'), 'Faca a tarefa sem sujar.', 'utf8');

    const saidaA = execFileSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PIPELINE,
      '-Plan', planFileA,
      '-QuotaWaitSeconds', '2',
      '-LaunchStaggerSeconds', '0',
      '-LoopSleepSeconds', '1',
    ], {
      env: { ...process.env, DELEGAR_DATA: dir, AGY_BIN: mockAgy },
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.match(saidaA, /pipeline end: failed=0/);
    const summaryA = fs.readFileSync(path.join(dir, 'logs', 'summary.md'), 'utf8');
    assert.match(summaryA, /RESULTADO: CONCLUIDO/);

    // Teste B: tarefa main cria novo arquivo sem commitar -> Verify falha
    // Mock que cria arquivo novo no repositorio
    const mockAgySujo = path.join(dir, 'mock-agy-sujo.bat');
    const arquivoSujo = path.join(repo, 'novo-sem-commit.txt');
    fs.writeFileSync(mockAgySujo, [
      '@echo off',
      `echo sujeira nova da tarefa > "${arquivoSujo}"`,
      'echo Tarefa gerou sujeira',
      'exit /b 0',
    ].join('\r\n'), 'utf8');

    const planB = {
      name: 'teste-sujeira-b',
      repo,
      tasks: [
        { id: 't2', titulo: 'Integrar e sujar', main: true, prompt: 't2.md', chain: ['agy:gemini-mock'] },
      ],
      verify: [],
      maxConcurrent: 1,
      maxRecoveries: 0,
    };
    const planFileB = path.join(dir, 'planB.json');
    fs.writeFileSync(planFileB, JSON.stringify(planB), 'utf8');
    fs.writeFileSync(path.join(dir, 't2.md'), 'Crie arquivo sem commitar.', 'utf8');

    let falhouB = false;
    try {
      execFileSync('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PIPELINE,
        '-Plan', planFileB,
        '-QuotaWaitSeconds', '2',
        '-LaunchStaggerSeconds', '0',
        '-LoopSleepSeconds', '1',
      ], {
        env: { ...process.env, DELEGAR_DATA: dir, AGY_BIN: mockAgySujo },
        encoding: 'utf8',
        timeout: 30000,
      });
    } catch {
      falhouB = true;
    }
    assert.equal(falhouB, true, 'pipeline deve falhar quando tarefa main cria arquivo sem commitar');
    const logPipeB = fs.readFileSync(path.join(dir, 'logs', 'pipeline.log'), 'utf8');
    assert.match(logPipeB, /verify failed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 5. Verificacao de ASCII puro em quota.ps1, worker.ps1 e pipeline.ps1
test('quota.ps1, worker.ps1 e pipeline.ps1 sao 100% ASCII puro', () => {
  for (const scriptPath of [QUOTA, WORKER, PIPELINE]) {
    const bytes = fs.readFileSync(scriptPath);
    const fora = [...bytes].findIndex((b) => b > 127);
    assert.equal(fora, -1, `${path.basename(scriptPath)} contem byte nao ASCII na posicao ${fora}`);
  }
});
