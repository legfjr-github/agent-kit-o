# Runs one delegated task through a chain of models, falling back when a model is out of quota.
# Usage: worker.ps1 -PromptFile task.md -Cwd C:\repo -LogDir C:\tmp\task -Chain 'agy:gemini-3.8-flash-high','claude:sonnet','opencode:opencode/glm-5.3-flash-free'
# Providers: claude (Claude Code CLI), agy (Antigravity CLI), opencode (opencode CLI). "@effort" suffix is optional.
# Writes <LogDir>\result.json, <LogDir>\current.json (model running now), one .out.log/.err.log/.txt per attempt,
# and appends activity events to <LogDir>\..\events.jsonl. ASCII only (PowerShell 5.1).
param(
  [Parameter(Mandatory=$true)][string]$PromptFile,
  [Parameter(Mandatory=$true)][string]$Cwd,
  [Parameter(Mandatory=$true)][string]$LogDir,
  [string[]]$Chain = @('agy:gemini-3.8-flash-high','claude:sonnet','claude:haiku'),
  [int]$TimeoutSeconds = 0
)

$ErrorActionPreference = 'Continue'
$Chain = @($Chain | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8
# In PowerShell 5.1 the ">" redirection is Out-File, which defaults to UTF-16; the panel reads these logs as UTF-8.
$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'
New-Item -ItemType Directory -Force $LogDir | Out-Null
Set-Location $Cwd
$utf8 = New-Object Text.UTF8Encoding $false
$taskId = Split-Path $LogDir -Leaf
$eventsFile = Join-Path (Split-Path $LogDir) 'events.jsonl'

function Ev($tipo, $modelo, $texto) {
  $line = [pscustomobject]@{ time = (Get-Date).ToString('s'); tipo = $tipo; tarefa = $taskId; modelo = $modelo; texto = $texto } | ConvertTo-Json -Compress
  for ($k = 0; $k -lt 5; $k++) { try { [IO.File]::AppendAllText($eventsFile, $line + "`n", $utf8); return } catch { Start-Sleep -Milliseconds 200 } }
}

$agy = $env:AGY_BIN
if (-not $agy) { $c = Get-Command agy -ErrorAction SilentlyContinue; if ($c) { $agy = $c.Source } }
if (-not $agy) { $agy = Join-Path $env:USERPROFILE '.gemini\bin\agy.exe' }
$quotaRe = '(?i)(quota|rate[ _-]?limit|RESOURCE_EXHAUSTED|\b429\b|usage limit|limit reached|out of credits|exceeded your|hit your|try again (later|in))'
$base = Get-Content $PromptFile -Raw -Encoding UTF8
$resumeNote = "`n`nATENCAO: um modelo anterior comecou esta tarefa e parou por falta de cota. Antes de tudo, rode git status e git log -3, veja o que ja foi feito e continue dali, sem refazer nem apagar o trabalho pronto.`n"

# Final answer of a JSON-lines log: Claude stream-json ("result" event) or opencode json ("text" parts).
function FinalText($kind, $outFile) {
  if (-not (Test-Path $outFile)) { return @{ text = ''; isError = $false } }
  $lines = @(Get-Content $outFile -Encoding UTF8)
  if ($kind -eq 'claude') {
    $r = $lines | Where-Object { $_ -match '"type"\s*:\s*"result"' } | Select-Object -Last 1
    if ($r) { try { $j = $r | ConvertFrom-Json; return @{ text = [string]$j.result; isError = [bool]$j.is_error } } catch {} }
    return @{ text = ''; isError = $true }
  }
  if ($kind -eq 'opencode') {
    $parts = @(); $err = $false
    foreach ($l in $lines) {
      if ($l -notmatch '^\s*\{') { continue }
      try { $j = $l | ConvertFrom-Json } catch { continue }
      if ($j.type -eq 'text' -and $j.part.text) { $parts += [string]$j.part.text }
      if ($j.type -eq 'error') { $err = $true; $parts += ('ERRO: ' + ($j.error | ConvertTo-Json -Compress -Depth 4)) }
    }
    return @{ text = ($parts -join "`n"); isError = ($err -and $parts.Count -le 1) }
  }
  return @{ text = ($lines -join "`n"); isError = $false }
}

$attempts = @()
$ok = $false
$i = 0
foreach ($entry in $Chain) {
  $i++
  $kind, $model = $entry.Split(':', 2)
  $effort = $null
  if ($model -match '^(.+)@(low|medium|high|xhigh|max)$') { $model = $Matches[1]; $effort = $Matches[2] }
  $prompt = if ($i -gt 1) { $base + $resumeNote } else { $base }
  $tag = ($model -replace '[^A-Za-z0-9.-]', '_')
  $out = Join-Path $LogDir "$i-$tag.out.log"
  $err = Join-Path $LogDir "$i-$tag.err.log"
  $txt = Join-Path $LogDir "$i-$tag.txt"
  $start = Get-Date
  [IO.File]::WriteAllText((Join-Path $LogDir 'current.json'), ([pscustomobject]@{ worker = $entry; attempt = $i; started = $start.ToString('s') } | ConvertTo-Json -Compress), $utf8)
  Ev 'tentativa' $entry "comecou (tentativa $i de $($Chain.Count))"

  $effArgs = @()
  if ($kind -eq 'agy') {
    if ($effort) { $effArgs = @('--effort', $effort) }
    $arg = '--print=' + $prompt.Replace('"', '\"')
    & $agy --model $model @effArgs --dangerously-skip-permissions --print-timeout "$($TimeoutSeconds)s" --add-dir $Cwd $arg 1> $out 2> $err
  } elseif ($kind -eq 'claude') {
    if ($effort) { $effArgs = @('--effort', $effort) }
    $prompt | & claude -p --model $model @effArgs --dangerously-skip-permissions --output-format stream-json --verbose 1> $out 2> $err
  } elseif ($kind -eq 'opencode') {
    # --auto: same trust level as the other providers (they run with --dangerously-skip-permissions).
    if ($effort) { $effArgs = @('--variant', $effort) }
    $prompt | & opencode run --pure --auto --model $model @effArgs --format json --title "delegar $taskId" 1> $out 2> $err
  } else {
    Ev 'erro' $entry "provedor desconhecido: $kind"
    continue
  }
  $code = $LASTEXITCODE

  $fin = FinalText $kind $out
  $finText = [string]$fin.text
  [IO.File]::WriteAllText($txt, $finText, $utf8)
  $errText = if (Test-Path $err) { [string](Get-Content $err -Raw -Encoding UTF8) } else { '' }
  $empty = [string]::IsNullOrWhiteSpace($finText)
  $failed = ($code -ne 0) -or $fin.isError -or $empty
  # Quota is only checked on failures, on the final answer and stderr, so code that mentions "quota" is not a false alarm.
  $probe = $finText; if ($probe.Length -gt 3000) { $probe = $probe.Substring($probe.Length - 3000) }
  $errTail = $errText; if ($errTail.Length -gt 3000) { $errTail = $errTail.Substring($errTail.Length - 3000) }
  $quota = $failed -and (($probe + "`n" + $errTail) -match $quotaRe)
  if (-not $failed -and $finText.Length -lt 600 -and $finText -match $quotaRe) { $quota = $true; $failed = $true }

  $attempts += [pscustomobject]@{
    worker = $entry; exitCode = $code; quota = $quota; emptyOutput = $empty
    started = $start.ToString('s'); finished = (Get-Date).ToString('s'); out = $out; err = $err; text = $txt
  }

  if ($quota) {
    $ledgerDir = Join-Path $env:USERPROFILE '.delegar\state'
    New-Item -ItemType Directory -Force $ledgerDir | Out-Null
    $evt = [pscustomobject]@{ time = (Get-Date).ToString('s'); worker = $entry; logDir = $LogDir } | ConvertTo-Json -Compress
    Add-Content (Join-Path $ledgerDir 'quota-ledger.jsonl') $evt -Encoding UTF8
  }

  if (-not $failed) { $ok = $true; Ev 'concluiu' $entry 'terminou a tarefa'; break }
  if ($quota) { Ev 'troca' $entry 'sem cota; passando para o proximo modelo'; continue }
  if ($empty) { Ev 'troca' $entry 'terminou sem resposta; passando para o proximo modelo'; continue }
  Ev 'falhou' $entry "falhou (codigo $code)"
  break                                  # real failure: let the orchestrator decide
}

$result = [pscustomobject]@{
  ok = $ok
  model = if ($ok) { $attempts[-1].worker } else { $null }
  promptFile = $PromptFile
  attempts = $attempts
}
$result | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $LogDir 'result.json') -Encoding UTF8
Remove-Item (Join-Path $LogDir 'current.json') -ErrorAction SilentlyContinue
$result | ConvertTo-Json -Depth 4
if ($ok) { exit 0 } else { exit 1 }
