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
  [int]$TimeoutSeconds = 0,
  # Handoff: while a Claude model works, read the Claude quota every N minutes; at HandoffAt (5-hour window)
  # or 0.95 (weekly) stop it and pass the task, with a summary of what was done, to the next non-Claude model.
  [double]$HandoffAt = 0.85,
  [int]$QuotaCheckMinutes = 3,
  [switch]$NoFreeFallback,
  [int]$IdleTimeoutMinutes = 20,
  [int]$IdleTimeoutSeconds = 0,
  # Wait before retrying an opencode:nvidia/* model that stalled (possible 40 RPM limit); short values help tests.
  [int]$NvidiaRpmWaitSeconds = 65,
  # Quantos workers usam a NVIDIA gratuita ao mesmo tempo no PC inteiro (todos os projetos).
  # 18/11/2026: um worker faz ~0,3 requisicao/min (cada resposta leva ~3,7 min), longe dos 40 RPM; 5 em teste.
  # DELEGAR_NVIDIA_MAX sobrepoe. O primeiro worker que cria o semaforo fixa o numero ate todos sairem.
  [int]$NvidiaMaxWorkers = 5,
  # Espera antes de repetir o mesmo modelo depois de uma falha passageira do provedor (rede/servidor).
  [int]$TransientWaitSeconds = 15
)
if ($env:DELEGAR_NVIDIA_MAX -match '^\d+$' -and [int]$env:DELEGAR_NVIDIA_MAX -ge 1) { $NvidiaMaxWorkers = [int]$env:DELEGAR_NVIDIA_MAX }

$idleBaseSec = if ($IdleTimeoutSeconds -gt 0) { $IdleTimeoutSeconds } elseif ($IdleTimeoutMinutes -gt 0) { $IdleTimeoutMinutes * 60 } else { 0 }
$idleLimitSec = $idleBaseSec
# 19/11/2026: na NVIDIA gratuita cada resposta pode levar ate 7 min de fila; o vigia de 20 min cortava sessoes vivas.
# Com o limite em minutos (padrao), modelos opencode:nvidia/* ganham pelo menos 30 min. IdleTimeoutSeconds (testes) nao muda.
$NvidiaIdleMinSec = 1800

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
# Falha passageira do provedor (rede ou servidor), diferente de erro da tarefa: vale repetir ou trocar de modelo.
$transienteRe = '(?i)(ECONNRESET|ETIMEDOUT|ECONNREFUSED|Connection reset|socket hang up|ProviderHeaderTimeoutError|ProviderResponseStreamError|headers timed out|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout|overloaded|empty conversation id|failed to start conversation)'
$base = Get-Content $PromptFile -Raw -Encoding UTF8
$resumeNote = "`n`nATENCAO: um modelo anterior comecou esta tarefa e parou antes de terminar (falta de cota, queda de conexao ou falta de resposta). Antes de tudo, rode git status e git log -3, veja o que ja foi feito e continue dali, sem refazer nem apagar o trabalho pronto.`n"

# Last actions of a Claude stream-json log, to brief the next model on a handoff.
function ResumoAcoes($outFile, $max = 40) {
  if (-not (Test-Path $outFile)) { return '' }
  $acoes = New-Object System.Collections.Generic.List[string]
  $ultimoTexto = ''
  foreach ($l in (Get-Content $outFile -Encoding UTF8)) {
    if ($l -notmatch '"type"\s*:\s*"assistant"') { continue }
    try { $j = $l | ConvertFrom-Json } catch { continue }
    foreach ($b in @($j.message.content)) {
      if ($b.type -eq 'tool_use') {
        $alvo = @($b.input.file_path, $b.input.command, $b.input.pattern, $b.input.path) | Where-Object { $_ } | Select-Object -First 1
        $alvo = ([string]$alvo) -replace '\s+', ' '
        if ($alvo.Length -gt 160) { $alvo = $alvo.Substring(0, 160) }
        $acoes.Add("- $($b.name): $alvo")
      } elseif ($b.type -eq 'text' -and $b.text) { $ultimoTexto = [string]$b.text }
    }
  }
  $ini = [Math]::Max(0, $acoes.Count - $max)
  $txt = ($acoes.GetRange($ini, $acoes.Count - $ini) -join "`n")
  if ($ultimoTexto.Length -gt 1500) { $ultimoTexto = $ultimoTexto.Substring($ultimoTexto.Length - 1500) }
  return "Ultimas acoes ($($acoes.Count) no total):`n$txt`n`nUltima mensagem do modelo anterior:`n$ultimoTexto"
}

function QuotaAll {
  try {
    & (Join-Path $PSScriptRoot 'quota.ps1') -MaxAgeMinutes ([Math]::Max(1, $QuotaCheckMinutes - 1)) 2>$null | Out-Null
    $dBase = if ($env:DELEGAR_DATA) { $env:DELEGAR_DATA } else { Join-Path $env:USERPROFILE '.delegar' }
    return (Get-Content (Join-Path (Join-Path $dBase 'state') 'quota-last.json') -Raw -Encoding UTF8 | ConvertFrom-Json)
  } catch { return $null }
}
function ClaudeQuota { $q = QuotaAll; if ($q) { return $q.claude } else { return $null } }

function EhGratuito($entry) {
  if ($entry -like 'opencode:*' -and ($entry -match '-free(@|$)' -or $entry -match 'big-pickle(@|$)')) {
    return $true
  }
  return $false
}

# Last quota hit of a provider in the ledger written by this script (any task, any project).
function LastHit($kind, [string]$grp = '') {
  try {
    $dBase = if ($env:DELEGAR_DATA) { $env:DELEGAR_DATA } else { Join-Path $env:USERPROFILE '.delegar' }
    $f = Join-Path (Join-Path $dBase 'state') 'quota-ledger.jsonl'
    if (-not (Test-Path $f)) { return $null }
    $last = $null
    foreach ($l in @(Get-Content $f -Tail 50 -Encoding UTF8)) {
      try { $e = $l | ConvertFrom-Json } catch { continue }
      $match = $false
      if ($kind -eq 'agy' -and $grp) {
        if ($grp -eq 'agyClaudeGpt') { $match = [bool]($e.worker -match '^agy:(claude|gpt)') }
        elseif ($grp -eq 'argon') { $match = [bool]($e.worker -match '^agy:.*argon') }
        elseif ($grp -eq 'gemini') { $match = [bool]($e.worker -like 'agy:*' -and $e.worker -notmatch '^agy:(claude|gpt)' -and $e.worker -notmatch 'argon') }
        else { $match = [bool]($e.worker -like 'agy:*') }
      } else {
        $match = [bool]([string]$e.worker -like "$($kind):*")
      }
      if ($match) { $last = [datetime]$e.time }
    }
    return $last
  } catch { return $null }
}

# Why a provider must be skipped before starting (no quota left or close to the limit), or $null to go ahead.
# Checked before every attempt, so a task never starts on a provider that is already out of quota.
# OPENCODE_CONFIG_CONTENT que desliga todos os servidores MCP do opencode.jsonc do usuario (o worker nao usa).
function OpencodeSemMcp {
  $nomes = @()
  foreach ($f in @('opencode.jsonc', 'opencode.json', 'config.json')) {
    $c = Join-Path $env:USERPROFILE ".config\opencode\$f"
    if (-not (Test-Path $c)) { continue }
    try {
      $txt = [IO.File]::ReadAllText($c) -replace '(?m)^\s*//.*$', ''
      $j = $txt | ConvertFrom-Json
      if ($j.mcp) { $nomes += @($j.mcp.PSObject.Properties | ForEach-Object { $_.Name }) }
    } catch {}
  }
  $mcp = [ordered]@{}
  foreach ($n in ($nomes | Select-Object -Unique)) { $mcp[$n] = @{ enabled = $false } }
  return (@{ mcp = $mcp } | ConvertTo-Json -Compress -Depth 4)
}

function SemCota($kind, $model) {
  if ($kind -eq 'opencode') { return $null }
  $q = QuotaAll
  if ($kind -eq 'claude') {
    $hit = LastHit $kind
    $c = if ($q) { $q.claude } else { $null }
    if ($c -and $c.read) {
      if ([double]$c.fiveHour -ge $HandoffAt) { return "cota do Claude em $([Math]::Round([double]$c.fiveHour * 100))% na janela de 5 h (renova $($c.fiveHourResets))" }
      if ([double]$c.sevenDay -ge 0.95) { return "cota semanal do Claude em $([Math]::Round([double]$c.sevenDay * 100))%" }
      # a quota hit inside the current 5-hour window still counts while the window has not renewed
      if ($hit -and $c.fiveHourResets -and ([datetime]$c.fiveHourResets) -gt (Get-Date) -and $hit -gt ([datetime]$c.fiveHourResets).AddHours(-5) -and ($c.readAt -and $hit -gt [datetime]$c.readAt)) { return "Claude estourou a cota as $($hit.ToString('HH:mm'))" }
      return $null
    }
    if ($hit -and ((Get-Date) - $hit).TotalMinutes -lt 60) { return "Claude estourou a cota as $($hit.ToString('HH:mm')) (sem leitura nova)" }
    return $null
  }
  if ($kind -eq 'agy') {
    $grp = if ($model -match 'argon') { 'argon' } elseif ($model -match '^(claude|gpt)') { 'agyClaudeGpt' } else { 'gemini' }
    $hit = LastHit $kind $grp
    $g = if ($q) { $q.$grp } else { $null }
    $hasReading = $g -and ($g.read -or $g.exhausted -or $null -ne $g.fiveHourRemaining -or $null -ne $g.sevenDayRemaining)
    if ($hasReading) {
      if ($g.exhausted) { return "cota de $grp no Antigravity esgotada" }
      $r5 = if ($null -ne $g.fiveHourRemaining) { [double]$g.fiveHourRemaining } else { 1 }
      $r7 = if ($null -ne $g.sevenDayRemaining) { [double]$g.sevenDayRemaining } else { 1 }
      if ($r5 -le 0.03) { return "cota de $grp no Antigravity com $([Math]::Round($r5 * 100))% restante na janela de 5 h" }
      if ($r7 -le 0.03) { return "cota semanal de $grp no Antigravity com $([Math]::Round($r7 * 100))% restante" }
      if ($hit -and $g.fiveHourResets -and ([datetime]$g.fiveHourResets) -gt (Get-Date) -and $hit -gt ([datetime]$g.fiveHourResets).AddHours(-5) -and ($g.readAt -and $hit -gt [datetime]$g.readAt)) {
        return "Antigravity ($grp) estourou a cota as $($hit.ToString('HH:mm'))"
      }
      if ($hit -and ((Get-Date) - $hit).TotalMinutes -lt 60 -and (-not $g.readAt -or $hit -gt [datetime]$g.readAt)) {
        return "Antigravity ($grp) estourou a cota as $($hit.ToString('HH:mm'))"
      }
      return $null
    }
    if ($hit -and ((Get-Date) - $hit).TotalMinutes -lt 60) { return "Antigravity ($grp) estourou a cota as $($hit.ToString('HH:mm'))" }
  }
  return $null
}

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

# Real token usage of one attempt (see app\uso.mjs): the object printed by node, or $null when node or the data is missing.
function UsoTentativa($kind, $entry, $outFile, $promptFile, $txtFile) {
  try {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { return $null }
    $usoMjs = Join-Path $PSScriptRoot '..\app\uso.mjs'
    if (-not (Test-Path $usoMjs)) { return $null }
    $saida = & $node.Source $usoMjs extrair --tipo $kind --modelo $entry --out $outFile --prompt $promptFile --texto $txtFile 2>$null
    $linha = @($saida | Where-Object { $_ -match '^\s*\{' }) | Select-Object -Last 1
    if (-not $linha) { return $null }
    return ($linha | ConvertFrom-Json)
  } catch { return $null }
}

# Watched process: monitors file changes and kills hung process on timeout or Claude handoff.
function RunWatchedProcess($fileName, $argString, $stdinFile, $outFile, $errFile, $checkClaudeHandoff, $proximoIdx) {
  $redir = if ($stdinFile) { "< `"$stdinFile`" > `"$outFile`" 2> `"$errFile`"" } else { "> `"$outFile`" 2> `"$errFile`"" }
  $linha = "call `"$fileName`" $argString $redir"
  $proc = Start-Process cmd.exe -ArgumentList "/d /s /c `"$linha`"" -WindowStyle Hidden -PassThru
  return WatchProcess $proc $outFile $errFile $checkClaudeHandoff $proximoIdx
}

# Laco de vigia comum (inatividade e troca por cota do Claude) para um processo ja iniciado.
function WatchProcess($proc, $outFile, $errFile, $checkClaudeHandoff, $proximoIdx) {
  $null = $proc.Handle

  $pollMs = if ($idleLimitSec -gt 0) { [Math]::Min(5000, [Math]::Max(200, [int]($idleLimitSec * 250))) } else { 5000 }
  $lastActivity = Get-Date

  function Stat-File($p) {
    if (-not $p -or -not (Test-Path -LiteralPath $p)) { return $null }
    try {
      $fi = New-Object IO.FileInfo($p)
      return @{ len = $fi.Length; time = $fi.LastWriteTimeUtc.Ticks }
    } catch { return $null }
  }

  $stOut = Stat-File $outFile
  $stErr = Stat-File $errFile
  $stEvt = Stat-File $eventsFile

  $ultimaLeitura = Get-Date
  $handoff = $null

  while (-not $proc.WaitForExit($pollMs)) {
    $curOut = Stat-File $outFile
    $curErr = Stat-File $errFile
    $curEvt = Stat-File $eventsFile
    $changed = $false

    if ($curOut -and (-not $stOut -or $curOut.len -ne $stOut.len -or $curOut.time -ne $stOut.time)) { $stOut = $curOut; $changed = $true }
    if ($curErr -and (-not $stErr -or $curErr.len -ne $stErr.len -or $curErr.time -ne $stErr.time)) { $stErr = $curErr; $changed = $true }
    if ($curEvt -and (-not $stEvt -or $curEvt.len -ne $stEvt.len -or $curEvt.time -ne $stEvt.time)) { $stEvt = $curEvt; $changed = $true }
    if ($changed) { $lastActivity = Get-Date }

    if ($idleLimitSec -gt 0 -and ((Get-Date) - $lastActivity).TotalSeconds -ge $idleLimitSec) {
      & taskkill.exe /PID $proc.Id /T /F 2>$null | Out-Null
      Start-Sleep -Milliseconds 500
      try { [void]$proc.WaitForExit(2000) } catch {}
      return @{ code = -1; stalled = $true; handoff = $null }
    }

    if ($checkClaudeHandoff -and $proximoIdx -gt 0 -and ((Get-Date) - $ultimaLeitura).TotalMinutes -ge $QuotaCheckMinutes) {
      $ultimaLeitura = Get-Date
      $cq = ClaudeQuota
      if ($cq -and $cq.read -and ([double]$cq.fiveHour -ge $HandoffAt -or [double]$cq.sevenDay -ge 0.95)) {
        $handoff = "cota do Claude em $([Math]::Round([double]$cq.fiveHour * 100))% (5 h) / $([Math]::Round([double]$cq.sevenDay * 100))% (semana)"
        & taskkill.exe /PID $proc.Id /T /F 2>$null | Out-Null
        Start-Sleep -Milliseconds 500
        try { [void]$proc.WaitForExit(2000) } catch {}
        return @{ code = $null; stalled = $false; handoff = $handoff }
      }
    }
  }

  $proc.WaitForExit()
  return @{ code = $proc.ExitCode; stalled = $false; handoff = $null }
}

if ($NoFreeFallback -and @($Chain | Where-Object { -not (EhGratuito $_) }).Count -gt 0) {
  $Chain = @($Chain | Where-Object { -not (EhGratuito $_) })
}

$attempts = @()
$ok = $false
$i = 0               # attempt counter (log file numbering); a retry of the same model gets a new number
$pularAte = 0        # after a handoff, skip the remaining Claude entries
$notaHandoff = $null
$nvidiaRpmRetries = @{}
$transientRetries = @{}
for ($chainIdx = 0; $chainIdx -lt $Chain.Count; $chainIdx++) {
  $entry = $Chain[$chainIdx]
  $pos = $chainIdx + 1   # 1-based position of the entry in the chain
  $i++
  if ($pos -lt $pularAte) { continue }
  $kind, $model = $entry.Split(':', 2)
  $effort = $null
  if ($model -match '^(.+)@(low|medium|high|xhigh|max)$') { $model = $Matches[1]; $effort = $Matches[2] }
  # Skip a provider that is out of (or close to the end of) its quota; the last entry always runs unless NoFreeFallback.
  if ($NoFreeFallback -or $pos -lt $Chain.Count) {
    $motivo = SemCota $kind $model
    if ($motivo) {
      Ev 'troca' $entry "pulado antes de comecar: $motivo"
      $attempts += [pscustomobject]@{ worker = $entry; exitCode = $null; quota = $true; skipped = $motivo; emptyOutput = $false
        started = (Get-Date).ToString('s'); finished = (Get-Date).ToString('s'); out = $null; err = $null; text = $null; uso = $null }
      continue
    }
  }
  # NVIDIA gratuita: no maximo $NvidiaMaxWorkers ao mesmo tempo no PC inteiro, entre todos os projetos.
  # Lotada: pula para o proximo modelo; se esta for a ultima opcao da cadeia, espera uma vaga (ate 3 h).
  $nvSem = $null
  if ($entry -like 'opencode:nvidia/*') {
    # Uma pasta de dados (DELEGAR_DATA, usada pelos testes) tem semaforo proprio; os workers reais dividem um so.
    $semNome = 'Local\delegar-nvidia-workers'
    if ($env:DELEGAR_DATA) {
      $h = [BitConverter]::ToString([Security.Cryptography.SHA1]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($env:DELEGAR_DATA.ToLower()))).Replace('-', '').Substring(0, 12)
      $semNome += "-$h"
    }
    $nvSem = New-Object System.Threading.Semaphore($NvidiaMaxWorkers, $NvidiaMaxWorkers, $semNome)
    $ultima = (-not $NoFreeFallback) -and ($pos -ge $Chain.Count)
    $espera = if ($ultima) { 3 * 3600 * 1000 } else { 0 }
    if ($ultima) { Ev 'espera' $entry "aguardando vaga na NVIDIA (ate $NvidiaMaxWorkers ao mesmo tempo)" }
    if (-not $nvSem.WaitOne($espera)) {
      $nvSem.Dispose(); $nvSem = $null
      $motivo = "NVIDIA lotada (ja ha $NvidiaMaxWorkers workers usando)"
      Ev 'troca' $entry "pulado antes de comecar: $motivo"
      $attempts += [pscustomobject]@{ worker = $entry; exitCode = $null; quota = $false; skipped = $motivo; emptyOutput = $false
        started = (Get-Date).ToString('s'); finished = (Get-Date).ToString('s'); out = $null; err = $null; text = $null; uso = $null }
      continue
    }
  }
  $prompt = if ($notaHandoff) { $base + $notaHandoff } elseif ($i -gt 1) { $base + $resumeNote } else { $base }
  $tag = ($model -replace '[^A-Za-z0-9.-]', '_')
  $out = Join-Path $LogDir "$i-$tag.out.log"
  $err = Join-Path $LogDir "$i-$tag.err.log"
  $txt = Join-Path $LogDir "$i-$tag.txt"
  $pf = Join-Path $LogDir "$i-$tag.prompt.txt"
  $start = Get-Date
  [IO.File]::WriteAllText((Join-Path $LogDir 'current.json'), ([pscustomobject]@{ worker = $entry; attempt = $i; started = $start.ToString('s') } | ConvertTo-Json -Compress), $utf8)
  Ev 'tentativa' $entry "comecou (tentativa $i de $($Chain.Count))"

  $idleLimitSec = if ($IdleTimeoutSeconds -le 0 -and $idleBaseSec -gt 0 -and $entry -like 'opencode:nvidia/*') { [Math]::Max($idleBaseSec, $NvidiaIdleMinSec) } else { $idleBaseSec }
  $runRes = $null
  if ($kind -eq 'agy') {
    [IO.File]::WriteAllText($pf, $prompt, $utf8)    # o agy-runner.ps1 le o prompt deste arquivo
    # NAO MUDAR (regra do usuario, 17/11/2026): o agy roda DIRETO pelo PowerShell (agy-runner.ps1 faz & $agy),
    # com o prompt lido de arquivo e quebras de linha preservadas. Nada de "cmd /c" (limite de ~8 mil caracteres,
    # quebra com aspas e & | < >: o agy saia com codigo 1 sem resposta). Teste: testes/worker-agy-direto.test.mjs.
    $runner = Join-Path $PSScriptRoot 'agy-runner.ps1'
    $q = { param($s) '"' + ([string]$s).Replace('"', '\"') + '"' }
    $rArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (& $q $runner), '-Agy', (& $q $agy), '-PromptFile', (& $q $pf),
      '-Model', (& $q $model), '-Cwd', (& $q $Cwd), '-OutFile', (& $q $out), '-ErrFile', (& $q $err), '-TimeoutSeconds', [string]$TimeoutSeconds)
    if ($effort) { $rArgs += @('-Effort', (& $q $effort)) }
    $procAgy = Start-Process powershell.exe -ArgumentList ($rArgs -join ' ') -WindowStyle Hidden -PassThru
    $runRes = WatchProcess $procAgy $out $err $false 0
  } elseif ($kind -eq 'claude') {
    # Watched process (not a blocking pipe) so the quota can be read while it works.
    [IO.File]::WriteAllText($pf, $prompt, $utf8)
    $eff = if ($effort) { "--effort $effort" } else { '' }
    $proximo = 0
    for ($k = $pos; $k -lt $Chain.Count; $k++) { if (-not $Chain[$k].StartsWith('claude:')) { $proximo = $k + 1; break } }
    $runRes = RunWatchedProcess 'claude' "-p --model $model $eff --dangerously-skip-permissions --output-format stream-json --verbose" $pf $out $err $true $proximo
  } elseif ($kind -eq 'opencode') {
    # --auto: same trust level as the other providers (they run with --dangerously-skip-permissions).
    $eff = if ($effort) { "--variant $effort" } else { '' }
    [IO.File]::WriteAllText($pf, $prompt, $utf8)    # kept only so the usage can be estimated afterwards
    # Opencode enxuto (18/11/2026): sem os servidores MCP do opencode.jsonc e sem as skills e o CLAUDE.md
    # do Claude Code. Medido: 149 mil tokens de entrada por requisicao caem para 12 mil; na fila gratuita
    # da NVIDIA isso era a diferenca entre minutos e segundos por resposta. As instrucoes do kit continuam.
    $env:OPENCODE_DISABLE_CLAUDE_CODE = '1'
    $env:OPENCODE_DISABLE_EXTERNAL_SKILLS = '1'
    $env:OPENCODE_CONFIG_CONTENT = (OpencodeSemMcp)
    $runRes = RunWatchedProcess 'opencode' "run --pure --auto --model $model $eff --format json --title `"delegar $taskId`"" $pf $out $err $false 0
  } else {
    Ev 'erro' $entry "provedor desconhecido: $kind"
    continue
  }
  if ($nvSem) { try { [void]$nvSem.Release() } catch {}; $nvSem.Dispose(); $nvSem = $null }

  if ($runRes.stalled) {
    Ev 'vigia' $entry "sem saida nem evento por $([Math]::Round($idleLimitSec / 60, 2)) min; encerrando e passando para o proximo modelo"
    $attempts += [pscustomobject]@{
      worker = $entry; exitCode = -1; quota = $false; stalled = $true; emptyOutput = $true
      started = $start.ToString('s'); finished = (Get-Date).ToString('s'); out = $out; err = $err; text = $txt
      uso = $null
    }
    if ($entry -like 'opencode:nvidia/*' -and ([int]$nvidiaRpmRetries[$entry]) -lt 2) {
      $nvidiaRpmRetries[$entry] = ([int]$nvidiaRpmRetries[$entry]) + 1
      Ev 'espera' $entry "sem saida (possivel 40 RPM da NVIDIA); aguardando $NvidiaRpmWaitSeconds s para retentar ($($nvidiaRpmRetries[$entry])/2)"
      Start-Sleep -Seconds $NvidiaRpmWaitSeconds
      $chainIdx--
    }
    continue
  }

  if ($runRes.handoff) {
    $resumo = ResumoAcoes $out
    $notaHandoff = "`n`nATENCAO - CONTINUACAO DE TAREFA: o modelo anterior ($entry) estava fazendo esta tarefa e foi interrompido de proposito porque a $($runRes.handoff), perto do limite. Voce assume daqui. Antes de tudo rode git status, git diff --stat e git log -3 para ver o que ja foi feito; continue do ponto em que ele parou, sem refazer nem apagar o que esta pronto, e faca o fechamento que a tarefa pede.`n`n$resumo`n"
    $attempts += [pscustomobject]@{
      worker = $entry; exitCode = $null; quota = $true; handoff = $runRes.handoff; emptyOutput = $false
      started = $start.ToString('s'); finished = (Get-Date).ToString('s'); out = $out; err = $err; text = $txt
      uso = (UsoTentativa $kind $entry $out $pf $txt)
    }
    Ev 'troca' $entry "$($runRes.handoff); passando a tarefa para $($Chain[$proximo - 1]) com o resumo do que ja foi feito"
    $pularAte = $proximo
    continue
  }

  $code = $runRes.code

  $fin = FinalText $kind $out
  $finText = [string]$fin.text
  [IO.File]::WriteAllText($txt, $finText, $utf8)
  # ReadAllText respeita o BOM: o agy-runner grava o .err.log em UTF-16 (19/11/2026: com -Encoding UTF8 o texto
  # vinha com um nulo entre cada letra e nem a checagem de cota nem a de falha passageira enxergavam o erro).
  $errText = if (Test-Path $err) { [string][IO.File]::ReadAllText($err) } else { '' }
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
    uso = (UsoTentativa $kind $entry $out $pf $txt)
  }

  if ($quota) {
    $dBase = if ($env:DELEGAR_DATA) { $env:DELEGAR_DATA } else { Join-Path $env:USERPROFILE '.delegar' }
    $ledgerDir = Join-Path $dBase 'state'
    New-Item -ItemType Directory -Force $ledgerDir | Out-Null
    $evt = [pscustomobject]@{ time = (Get-Date).ToString('s'); worker = $entry; logDir = $LogDir } | ConvertTo-Json -Compress
    Add-Content (Join-Path $ledgerDir 'quota-ledger.jsonl') $evt -Encoding UTF8
  }

  if (-not $failed) { $ok = $true; Ev 'concluiu' $entry 'terminou a tarefa'; break }
  if ($quota) { Ev 'troca' $entry 'sem cota; passando para o proximo modelo'; continue }
  # Falha passageira do provedor (18/11/2026: a NVIDIA derrubou a conexao, ECONNRESET, e a tarefa inteira
  # falhava sem tentar de novo nem passar ao proximo modelo). Repete o mesmo modelo ate 2 vezes, com 15 s
  # de intervalo; depois segue a cadeia. O novo prompt traz o aviso de continuacao ($resumeNote).
  if (($probe + "`n" + $errTail) -match $transienteRe) {
    $n = ([int]$transientRetries[$entry]) + 1; $transientRetries[$entry] = $n
    if ($n -le 2) {
      Ev 'espera' $entry "falha passageira do provedor; repetindo em $TransientWaitSeconds s ($n/2)"
      Start-Sleep -Seconds $TransientWaitSeconds
      $chainIdx--
      continue
    }
    Ev 'troca' $entry 'falha passageira repetida; passando para o proximo modelo'
    continue
  }
  if ($empty) { Ev 'troca' $entry 'terminou sem resposta; passando para o proximo modelo'; continue }
  Ev 'falhou' $entry "falhou (codigo $code)"
  break                                  # real failure: let the orchestrator decide
}

# Total usage of the whole task (optional field; $null when no attempt has usage).
$usoTotal = $null
try {
  $lista = @($attempts | Where-Object { $_.uso } | ForEach-Object { $_.uso })
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if ($lista.Count -gt 0 -and $nodeCmd) {
    $somado = (ConvertTo-Json -InputObject $lista -Depth 8 -Compress) | & $nodeCmd.Source (Join-Path $PSScriptRoot '..\app\uso.mjs') somar 2>$null
    $linhaTotal = @($somado | Where-Object { $_ -match '^\s*\{' }) | Select-Object -Last 1
    if ($linhaTotal) { $usoTotal = $linhaTotal | ConvertFrom-Json }
  }
} catch { $usoTotal = $null }
$quotaExhausted = (-not $ok) -and ($attempts.Count -gt 0) -and (@($attempts | Where-Object { -not $_.quota }).Count -eq 0)
$result = [pscustomobject]@{
  ok = $ok
  quotaExhausted = [bool]$quotaExhausted
  model = if ($ok) { $attempts[-1].worker } else { $null }
  promptFile = $PromptFile
  attempts = $attempts
  uso = $usoTotal
}
[IO.File]::WriteAllText((Join-Path $LogDir 'result.json'), ($result | ConvertTo-Json -Depth 8), $utf8)
Remove-Item (Join-Path $LogDir 'current.json') -ErrorAction SilentlyContinue
$result | ConvertTo-Json -Depth 8
if ($ok) { exit 0 } else { exit 1 }
