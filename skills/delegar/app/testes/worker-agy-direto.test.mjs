// Regressão (17/11/2026): o worker passou a chamar o agy por "cmd /c" (RunWatchedProcess) e a achatar o
// prompt numa linha só. O cmd.exe tem limite de ~8 mil caracteres e quebra com aspas e & | < >, então o agy
// saía com código 1 sem resposta em toda tarefa real e tudo caía nos modelos gratuitos. Duas sessões de IA
// "otimizaram" de volta para o jeito errado; este teste barra isso.
// Jeito certo: worker.ps1 inicia scripts/agy-runner.ps1 com Start-Process powershell (sem cmd), o runner lê o
// prompt de arquivo e chama "& $Agy" direto, e o worker vigia o processo (inatividade).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.resolve(aqui, '..', '..', 'scripts');
const semComentarios = (s) => s.split(/\r?\n/).filter((l) => !l.trim().startsWith('#')).map((l) => l.replace(/\s+#\s.*$/, '')).join('\n');

function blocoAgyDoWorker() {
  const src = fs.readFileSync(path.join(SCRIPTS, 'worker.ps1'), 'utf8');
  const ini = src.indexOf("if ($kind -eq 'agy') {", src.indexOf('$runRes = $null'));
  const fim = src.indexOf("} elseif ($kind -eq 'claude')", ini);
  assert.ok(ini > 0 && fim > ini, 'bloco do agy não encontrado no worker.ps1');
  return semComentarios(src.slice(ini, fim));
}

test('worker.ps1 não passa o agy por cmd /c', () => {
  const b = blocoAgyDoWorker();
  assert.doesNotMatch(b, /RunWatchedProcess/, 'não usar RunWatchedProcess (cmd /c) para o agy');
  assert.doesNotMatch(b, /cmd(\.exe)?\b/i, 'não usar cmd.exe para o agy');
  assert.match(b, /agy-runner\.ps1/, 'o agy roda pelo agy-runner.ps1');
  assert.match(b, /WatchProcess/, 'o processo do agy continua vigiado');
});

test('agy-runner.ps1 chama o agy direto com o prompt inteiro lido de arquivo', () => {
  const r = semComentarios(fs.readFileSync(path.join(SCRIPTS, 'agy-runner.ps1'), 'utf8'));
  assert.match(r, /&\s*\$Agy\s+--model/, 'chamada direta & $Agy');
  assert.match(r, /ReadAllText\(\$PromptFile/, 'prompt lido do arquivo, não da linha de comando');
  assert.match(r, /--print='\s*\+\s*\$prompt\./, 'o --print recebe o $prompt inteiro');
  assert.doesNotMatch(r, /-replace\s+["']\[\\r\\n\]/, 'não trocar quebras de linha por espaço');
  assert.doesNotMatch(r, /cmd(\.exe)?\b/i, 'sem cmd.exe');
});
