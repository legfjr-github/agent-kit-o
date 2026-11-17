# Chama o agy DIRETO pelo PowerShell, lendo o prompt de um arquivo (regra do usuario, 17/11/2026).
# Motivo: passar o prompt pela linha de comando do "cmd /c" estoura o limite de ~8 mil caracteres do cmd.exe e
# quebra com aspas e & | < >; o agy saia com codigo 1 sem resposta em toda tarefa real. Este script e iniciado
# pelo worker.ps1 com Start-Process (sem cmd) e vigiado pelo mesmo laco de inatividade dos outros provedores.
# NAO trocar por cmd /c nem achatar o prompt. O teste testes/worker-agy-direto.test.mjs barra a regressao.
param(
  [Parameter(Mandatory = $true)][string]$Agy,
  [Parameter(Mandatory = $true)][string]$PromptFile,
  [Parameter(Mandatory = $true)][string]$Model,
  [Parameter(Mandatory = $true)][string]$Cwd,
  [Parameter(Mandatory = $true)][string]$OutFile,
  [Parameter(Mandatory = $true)][string]$ErrFile,
  [string]$Effort = '',
  [int]$TimeoutSeconds = 0
)
$prompt = [IO.File]::ReadAllText($PromptFile, [Text.Encoding]::UTF8)
$effArgs = if ($Effort) { @('--effort', $Effort) } else { @() }
$toArgs = if ($TimeoutSeconds -gt 0) { @('--print-timeout', "$($TimeoutSeconds)s") } else { @() }
$arg = '--print=' + $prompt.Replace('"', '\"')
& $Agy --model $Model @effArgs --dangerously-skip-permissions @toArgs --add-dir $Cwd $arg 1> $OutFile 2> $ErrFile
exit $LASTEXITCODE
