# Reads quota state and recommends how many workers may run at once per provider.
# Claude: live reading from a tiny haiku probe (rate_limit_event). Gemini/agy: no CLI reading exists,
# so it uses the ledger of quota hits written by worker.ps1 plus an optional manual file
# state\gemini.json  {"usedPercent": 40, "resetsAt": "2026-11-12T03:00:00-03:00", "updated": "..."}
# Output: JSON with claude/gemini readings and maxParallel. ASCII only (PowerShell 5.1).
param([switch]$SkipClaudeProbe, [int]$GeminiCooldownHours = 5)

[Console]::OutputEncoding = [Text.Encoding]::UTF8
$state = Join-Path $env:USERPROFILE '.delegar\state'
New-Item -ItemType Directory -Force $state | Out-Null
$now = Get-Date
# Which CLIs exist on this PC (a missing provider counts as zero workers).
$hasClaude = [bool](Get-Command claude -ErrorAction SilentlyContinue)
$hasAgy = [bool]($env:AGY_BIN -or (Get-Command agy -ErrorAction SilentlyContinue) -or (Test-Path (Join-Path $env:USERPROFILE '.gemini\bin\agy.exe')))
$hasOpencode = [bool](Get-Command opencode -ErrorAction SilentlyContinue)

# --- Claude ---
$claude = [ordered]@{ installed = $hasClaude; read = $false; fiveHour = $null; sevenDay = $null; fiveHourResets = $null; sevenDayResets = $null; maxParallel = $(if ($hasClaude) { 1 } else { 0 }) }
if ($hasClaude -and -not $SkipClaudeProbe) {
  $line = 'Responda OK.' | & claude -p --model haiku --output-format stream-json --verbose 2>$null | Select-String 'rate_limit_event' | Select-Object -First 1
  if ($line) {
    $ev = ($line.Line | ConvertFrom-Json).rate_limit_info.unifiedWindows
    $epoch = [DateTimeOffset]::FromUnixTimeSeconds
    $claude.read = $true
    $claude.fiveHour = [double]$ev.five_hour.utilization
    $claude.sevenDay = [double]$ev.seven_day.utilization
    $claude.fiveHourResets = $epoch.Invoke([long]$ev.five_hour.resetsAt).LocalDateTime.ToString('s')
    $claude.sevenDayResets = $epoch.Invoke([long]$ev.seven_day.resetsAt).LocalDateTime.ToString('s')
    $h5 = ([datetime]$claude.fiveHourResets - $now).TotalHours
    if ($claude.fiveHour -ge 0.9 -or $claude.sevenDay -ge 0.95) { $claude.maxParallel = 0 }
    elseif (($claude.fiveHour -lt 0.5 -and $claude.sevenDay -lt 0.7) -or ($h5 -lt 1 -and $claude.fiveHour -lt 0.8)) { $claude.maxParallel = 2 }
    else { $claude.maxParallel = 1 }
  }
}

# --- Gemini ---
$gemini = [ordered]@{ source = 'ledger'; lastQuotaHit = $null; usedPercent = $null; resetsAt = $null; maxParallel = 1 }
$ledger = Join-Path $state 'quota-ledger.jsonl'
if (Test-Path $ledger) {
  $hit = Get-Content $ledger -Encoding UTF8 | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.worker -like 'agy:*' } | Select-Object -Last 1
  if ($hit) {
    $gemini.lastQuotaHit = $hit.time
    $age = ($now - [datetime]$hit.time).TotalHours
    if ($age -lt $GeminiCooldownHours) { $gemini.maxParallel = 0 } elseif ($age -lt 24) { $gemini.maxParallel = 1 }
  }
}
$manual = Join-Path $state 'gemini.json'
if (Test-Path $manual) {
  $m = Get-Content $manual -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($m.updated -and ($now - [datetime]$m.updated).TotalHours -lt 6) {
    $gemini.source = 'manual'
    $gemini.usedPercent = $m.usedPercent; $gemini.resetsAt = $m.resetsAt
    $hrs = if ($m.resetsAt) { ([datetime]$m.resetsAt - $now).TotalHours } else { 999 }
    if ($m.usedPercent -ge 90) { $gemini.maxParallel = 0 }
    elseif ($m.usedPercent -lt 50 -or ($hrs -lt 3 -and $m.usedPercent -lt 80)) { $gemini.maxParallel = 2 }
    else { $gemini.maxParallel = 1 }
  }
}

if (-not $hasAgy) { $gemini.source = 'not installed'; $gemini.maxParallel = 0 }

[pscustomobject]@{ time = $now.ToString('s'); claude = $claude; gemini = $gemini; opencode = [ordered]@{ installed = $hasOpencode } } | ConvertTo-Json -Depth 4

$total = [Math]::Min(3, $gemini.maxParallel + $claude.maxParallel)
# PC with only the free models (opencode): they are the normal chain there, not a "desperate" fallback.
if (-not $hasClaude -and -not $hasAgy -and $hasOpencode) { $total = 2 }
Write-Output ('recommendedConcurrent=' + $total)
exit 0
