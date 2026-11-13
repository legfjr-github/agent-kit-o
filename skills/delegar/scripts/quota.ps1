# Reads quota state and recommends how many workers may run at once per provider.
#
# Sources
#   Claude: live reading from a tiny haiku probe (rate_limit_event). Values are USED fractions (0.85 = 85% spent).
#   agy (Gemini, Gemini 4 Argon, Claude/GPT through Antigravity): "agy --p /usage", one line per quota.
#     agy prints what REMAINS (90% = 90% still available). The call takes ~18 s, is limited to 60 s and the
#     whole process tree is killed on timeout. Both output shapes are understood: TAB separated with a UTC ISO
#     time, and the interactive terminal text (spaces, local time like "2026-11-17 11:04 -03").
#   Fallback, used when the real agy reading fails (timeout, empty output, no valid line): the last good reading in
#     state\quota-last.json if it is younger than 6 h (kept with its old readAt and read=false); then the manual
#     file state\gemini.json {"usedPercent": 40, "resetsAt": "2026-11-12T03:00:00-03:00", "updated": "..."}
#     if it is fresh (< 6 h); then the ledger of quota hits written by worker.ps1 (state\quota-ledger.jsonl).
#     An empty agy output is never read as "quota exhausted".
#
# State folder: $env:DELEGAR_DATA\state, or %USERPROFILE%\.delegar\state when DELEGAR_DATA is not set.
#
# Parameters
#   -SkipClaudeProbe       do not call the Claude haiku probe.
#   -SkipAgy               do not call agy (uses the fallback chain above).
#   -AgyUsageFile <path>   read the agy text from this file instead of calling agy; ignores the cache (for tests).
#   -GeminiCooldownHours N hours a ledger quota hit keeps agy at zero workers (default 5).
#   -MaxAgeMinutes N       reuse state\quota-last.json when younger than N minutes (no new probe).
#
# Output: JSON, then a last line "recommendedConcurrent=N".
#   claude        installed, read, fiveHour, sevenDay (used 0..1), fiveHourRemaining, sevenDayRemaining,
#                 fiveHourResets, sevenDayResets, readAt, maxParallel
#   gemini        source (agy|manual|ledger|not installed), read, fiveHour, sevenDay (used 0..1),
#                 fiveHourRemaining, sevenDayRemaining, fiveHourResets, sevenDayResets, exhausted, readAt,
#                 lastQuotaHit, usedPercent, resetsAt, maxParallel
#   argon         read, sevenDay (used), sevenDayRemaining, sevenDayResets, exhausted, readAt
#   agyClaudeGpt  read, fiveHour, sevenDay (used), fiveHourRemaining, sevenDayRemaining, fiveHourResets,
#                 sevenDayResets, exhausted, readAt
#   agy           installed, read, readAt, error (short text or null), seconds, limits (parsed lines:
#                 group, label, window, remaining 0..1, resetsAt)
#   opencode      installed
#   time, recommendedConcurrent
# exhausted = some window of the group has 2% or less remaining. Times are local, format 's'.
# ASCII only (PowerShell 5.1).
param(
  [switch]$SkipClaudeProbe,
  [switch]$SkipAgy,
  [string]$AgyUsageFile = '',
  [int]$GeminiCooldownHours = 5,
  [int]$MaxAgeMinutes = 0
)

[Console]::OutputEncoding = [Text.Encoding]::UTF8
$base = if ($env:DELEGAR_DATA) { $env:DELEGAR_DATA } else { Join-Path $env:USERPROFILE '.delegar' }
$state = Join-Path $base 'state'
New-Item -ItemType Directory -Force $state | Out-Null
$now = Get-Date
$cache = Join-Path $state 'quota-last.json'
$inv = [Globalization.CultureInfo]::InvariantCulture

if ($MaxAgeMinutes -gt 0 -and -not $AgyUsageFile -and (Test-Path $cache)) {
  try {
    $c = Get-Content $cache -Raw -Encoding UTF8 | ConvertFrom-Json
    if (($now - [datetime]$c.time).TotalMinutes -lt $MaxAgeMinutes) {
      $c | ConvertTo-Json -Depth 6
      Write-Output ('recommendedConcurrent=' + $c.recommendedConcurrent)
      exit 0
    }
  } catch {}
}

# Last reading on disk (any age), used only as a fallback source.
$prev = $null
if (Test-Path $cache) { try { $prev = Get-Content $cache -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $prev = $null } }

# ---------------------------------------------------------------- agy output parser
# Converts a time text (ISO with Z/offset, or "yyyy-MM-dd HH:mm -03", -0300, -03:00) to a local 's' string, or $null.
function ConvertTo-LocalTime([string]$s) {
  if (-not $s) { return $null }
  $m = [regex]::Match($s, '(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|[+-]\d{2}(?::?\d{2})?)?')
  if (-not $m.Success) { return $null }
  $off = $m.Groups[3].Value
  if (-not $off -or $off -eq 'Z') { $off = 'Z' }
  else {
    $o = [regex]::Match($off, '^([+-])(\d{2}):?(\d{2})?$')
    if (-not $o.Success) { return $null }
    $mm = if ($o.Groups[3].Success) { $o.Groups[3].Value } else { '00' }
    $off = $o.Groups[1].Value + $o.Groups[2].Value + ':' + $mm
  }
  $txt = $m.Groups[1].Value + 'T' + $m.Groups[2].Value + $off
  $dto = [DateTimeOffset]::MinValue
  if ([DateTimeOffset]::TryParse($txt, $inv, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$dto)) {
    return $dto.LocalDateTime.ToString('s')
  }
  return $null
}

function Parse-AgyUsage([string]$text) {
  $items = New-Object System.Collections.Generic.List[object]
  if (-not $text) { return $items }
  $pctRe = '(?<![\d.])(-?\d+(?:\.\d+)?)\s*%'
  foreach ($raw in ($text -split "`r?`n")) {
    $line = $raw.TrimEnd("`r", "`n")
    if (-not $line.Trim()) { continue }
    if ($line -notmatch '\d\s*%') { continue }
    $groupText = ''; $limitText = ''; $timeText = ''; $pctText = $null
    $done = $false
    if ($line.Contains("`t")) {
      $f = @($line -split "`t" | ForEach-Object { $_.Trim() })
      $idx = -1
      for ($i = 0; $i -lt $f.Count; $i++) { if ($f[$i] -match '^-?\d+(\.\d+)?\s*%$') { $idx = $i; break } }
      if ($idx -ge 0) {
        $pctText = ($f[$idx] -replace '\s*%$', '')
        if ($idx -ge 1) { $groupText = $f[0] }
        if ($idx -ge 2) { $limitText = (($f[1..($idx - 1)]) -join ' ') }
        if ($idx + 1 -lt $f.Count) { $timeText = (($f[($idx + 1)..($f.Count - 1)]) -join ' ') }
        $done = $true
      } else { $line = ($line -replace "`t", ' ') }
    }
    if (-not $done) {
      $m = [regex]::Match($line, $pctRe)
      if (-not $m.Success) { continue }
      $pctText = $m.Groups[1].Value
      $groupText = ($line.Substring(0, $m.Index) -replace '^[^A-Za-z0-9]+', '').Trim()
      $timeText = $line.Substring($m.Index + $m.Length)
    }
    $pct = 0.0
    if (-not [double]::TryParse($pctText, [Globalization.NumberStyles]::Float, $inv, [ref]$pct)) { continue }
    if ($pct -lt 0 -or $pct -gt 100) { continue }
    $whole = ($groupText + ' ' + $limitText).Trim()
    $label = ($whole -replace '\s+', ' ')
    if ($label.Length -gt 80) { $label = $label.Substring(0, 80) }
    $grp = 'other'
    if ($groupText -match 'Argon') { $grp = 'argon' }
    elseif ($groupText -match '^\s*Gemini') { $grp = 'gemini' }
    elseif ($groupText -match 'Claude|GPT') { $grp = 'agyClaudeGpt' }
    $win = 'other'
    if ($whole -match '(?i)five[\s-]*hour|\b5\s*h\b') { $win = 'fiveHour' }
    elseif ($whole -match '(?i)weekly') { $win = 'sevenDay' }
    $items.Add([pscustomobject][ordered]@{
      group = $grp; label = $label; window = $win
      remaining = [Math]::Round($pct / 100, 4); resetsAt = (ConvertTo-LocalTime $timeText)
    })
  }
  return $items
}

# One group's reading from the parsed items. Windows use the lowest remaining when a window repeats.
function New-GroupReading([string]$g, $items) {
  $r = [ordered]@{
    read = $false; fiveHour = $null; sevenDay = $null; fiveHourRemaining = $null; sevenDayRemaining = $null
    fiveHourResets = $null; sevenDayResets = $null; exhausted = $false; readAt = $null
  }
  $mine = @($items | Where-Object { $_.group -eq $g })
  if ($mine.Count -eq 0) { return $r }
  $r.read = $true
  $r.readAt = (Get-Date).ToString('s')
  foreach ($w in 'fiveHour', 'sevenDay') {
    $best = @($mine | Where-Object { $_.window -eq $w } | Sort-Object remaining) | Select-Object -First 1
    if ($best) {
      $r[$w + 'Remaining'] = $best.remaining
      $r[$w] = [Math]::Round(1 - $best.remaining, 4)
      $r[$w + 'Resets'] = $best.resetsAt
    }
  }
  if (@($mine | Where-Object { $_.remaining -le 0.02 }).Count -gt 0) { $r.exhausted = $true }
  return $r
}

# ---------------------------------------------------------------- which CLIs exist on this PC
$hasClaude = [bool](Get-Command claude -ErrorAction SilentlyContinue)
$agyExe = $env:AGY_BIN
if (-not $agyExe) { $cmd = Get-Command agy -ErrorAction SilentlyContinue; if ($cmd) { $agyExe = $cmd.Source } }
if (-not $agyExe) { $agyExe = Join-Path $env:USERPROFILE '.gemini\bin\agy.exe' }
$hasAgy = [bool]($env:AGY_BIN -or (Get-Command agy -ErrorAction SilentlyContinue) -or (Test-Path (Join-Path $env:USERPROFILE '.gemini\bin\agy.exe')))
if ($AgyUsageFile) { $hasAgy = $true }
$hasOpencode = [bool](Get-Command opencode -ErrorAction SilentlyContinue)

# --- Claude ---
$claude = [ordered]@{
  installed = $hasClaude; read = $false; fiveHour = $null; sevenDay = $null
  fiveHourRemaining = $null; sevenDayRemaining = $null; fiveHourResets = $null; sevenDayResets = $null
  readAt = $null; maxParallel = $(if ($hasClaude) { 1 } else { 0 })
}
if ($hasClaude -and -not $SkipClaudeProbe) {
  $line = 'Responda OK.' | & claude -p --model haiku --output-format stream-json --verbose 2>$null | Select-String 'rate_limit_event' | Select-Object -First 1
  if ($line) {
    $ev = ($line.Line | ConvertFrom-Json).rate_limit_info.unifiedWindows
    $epoch = [DateTimeOffset]::FromUnixTimeSeconds
    $claude.read = $true
    $claude.readAt = $now.ToString('s')
    $claude.fiveHour = [double]$ev.five_hour.utilization
    $claude.sevenDay = [double]$ev.seven_day.utilization
    $claude.fiveHourRemaining = [Math]::Round(1 - $claude.fiveHour, 4)
    $claude.sevenDayRemaining = [Math]::Round(1 - $claude.sevenDay, 4)
    $claude.fiveHourResets = $epoch.Invoke([long]$ev.five_hour.resetsAt).LocalDateTime.ToString('s')
    $claude.sevenDayResets = $epoch.Invoke([long]$ev.seven_day.resetsAt).LocalDateTime.ToString('s')
    $h5 = ([datetime]$claude.fiveHourResets - $now).TotalHours
    if ($claude.fiveHour -ge 0.9 -or $claude.sevenDay -ge 0.95) { $claude.maxParallel = 0 }
    elseif (($claude.fiveHour -lt 0.5 -and $claude.sevenDay -lt 0.7) -or ($h5 -lt 1 -and $claude.fiveHour -lt 0.8)) { $claude.maxParallel = 2 }
    else { $claude.maxParallel = 1 }
  }
}

# --- agy /usage (real reading) ---
$agyInfo = [ordered]@{ installed = $hasAgy; read = $false; readAt = $null; error = $null; seconds = 0; limits = @() }
$agyText = ''
if ($AgyUsageFile) {
  try { $agyText = [IO.File]::ReadAllText($AgyUsageFile, [Text.Encoding]::UTF8) } catch { $agyInfo.error = 'usage file unreadable' }
} elseif ($hasAgy -and -not $SkipAgy) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $p = $null
  try {
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $agyExe
    $psi.Arguments = '--p /usage'
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
    $p = [Diagnostics.Process]::Start($psi)
    $p.StandardInput.Close()
    $outTask = $p.StandardOutput.ReadToEndAsync()
    $errTask = $p.StandardError.ReadToEndAsync()
    if ($p.WaitForExit(60000)) {
      $p.WaitForExit()
      $agyText = [string]$outTask.Result
    } else {
      $agyInfo.error = 'timeout'
      & taskkill.exe /PID $p.Id /T /F 2>&1 | Out-Null
      [void]$p.WaitForExit(3000)
    }
  } catch {
    $msg = [string]$_.Exception.Message
    if ($msg.Length -gt 100) { $msg = $msg.Substring(0, 100) }
    $agyInfo.error = 'start failed: ' + $msg
  } finally {
    if ($p) { $p.Dispose() }
  }
  $agyInfo.seconds = [Math]::Round($sw.Elapsed.TotalSeconds, 1)
}

$parsed = @(Parse-AgyUsage $agyText)
$gem = New-GroupReading 'gemini' $parsed
$arg = New-GroupReading 'argon' $parsed
$acg = New-GroupReading 'agyClaudeGpt' $parsed
if ($parsed.Count -gt 0) {
  $agyInfo.read = $true
  $agyInfo.readAt = $now.ToString('s')
  $agyInfo.limits = @($parsed)
} elseif (-not $agyInfo.error -and -not $SkipAgy -and $hasAgy) {
  $agyInfo.error = $(if ($agyText.Trim()) { 'no valid line' } else { 'empty output' })
}

# Reading failed: reuse the last good reading (younger than 6 h), keeping its old readAt and read=false.
function Restore-Previous($cur, [string]$name) {
  if (-not $prev) { return }
  $o = $prev.$name
  if (-not $o -or -not $o.readAt) { return }
  try { if (($now - [datetime]$o.readAt).TotalHours -ge 6) { return } } catch { return }
  if ($null -eq $o.fiveHourRemaining -and $null -eq $o.sevenDayRemaining) { return }
  foreach ($k in @($cur.Keys)) {
    if ($k -eq 'read') { continue }
    if ($o.PSObject.Properties[$k]) { $cur[$k] = $o.$k }
  }
  $cur.read = $false
}
if (-not $agyInfo.read) {
  Restore-Previous $gem 'gemini'
  Restore-Previous $arg 'argon'
  Restore-Previous $acg 'agyClaudeGpt'
}

$argon = [ordered]@{
  read = $arg.read; sevenDay = $arg.sevenDay; sevenDayRemaining = $arg.sevenDayRemaining
  sevenDayResets = $arg.sevenDayResets; exhausted = $arg.exhausted; readAt = $arg.readAt
}

# --- Gemini ---
$gemini = [ordered]@{ source = 'ledger' }
foreach ($k in $gem.Keys) { $gemini[$k] = $gem[$k] }
$gemini.lastQuotaHit = $null; $gemini.usedPercent = $null; $gemini.resetsAt = $null; $gemini.maxParallel = 1
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
# Real reading wins over manual and ledger.
if ($gemini.read) {
  $gemini.source = 'agy'
  $usedAll = @($parsed | Where-Object { $_.group -eq 'gemini' } | ForEach-Object { 1 - $_.remaining })
  $maxUsed = ($usedAll | Measure-Object -Maximum).Maximum
  $hrs5 = if ($gemini.fiveHourResets) { ([datetime]$gemini.fiveHourResets - $now).TotalHours } else { 999 }
  if ($gemini.exhausted) { $gemini.maxParallel = 0 }
  elseif ($maxUsed -lt 0.5 -or ($hrs5 -lt 3 -and $maxUsed -lt 0.8)) { $gemini.maxParallel = 2 }
  else { $gemini.maxParallel = 1 }
}
if (-not $hasAgy) { $gemini.source = 'not installed'; $gemini.maxParallel = 0 }

$total = [Math]::Min(3, $gemini.maxParallel + $claude.maxParallel)
# PC with only the free models (opencode): they are the normal chain there, not a "desperate" fallback.
if (-not $hasClaude -and -not $hasAgy -and $hasOpencode) { $total = 2 }
$leitura = [pscustomobject]@{
  time = $now.ToString('s'); claude = $claude; gemini = $gemini; argon = $argon; agyClaudeGpt = $acg
  agy = $agyInfo; opencode = [ordered]@{ installed = $hasOpencode }; recommendedConcurrent = $total
}
$json = $leitura | ConvertTo-Json -Depth 6
# Write to a temp file and replace, so pipeline, worker and panel never read a half-written file.
$tmp = $cache + '.' + $PID + '.tmp'
try {
  [IO.File]::WriteAllText($tmp, $json, (New-Object Text.UTF8Encoding $false))
  Move-Item -Force -LiteralPath $tmp -Destination $cache
} catch {
  if (Test-Path $tmp) { Remove-Item -Force -LiteralPath $tmp -ErrorAction SilentlyContinue }
}
$json
Write-Output ('recommendedConcurrent=' + $total)
exit 0
