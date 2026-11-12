# Runs a plan of delegated tasks (DAG) without the orchestrator in the loop.
# Usage: pipeline.ps1 -Plan C:\path\plan.json [-Resume]
# - Starts tasks whose dependencies are done, up to min(plan.maxConcurrent, quota recommendation).
# - Tasks with "worktree" run in an isolated git worktree created from the repo HEAD at launch.
# - Tasks with "main": true run in the repo, one at a time, and are verified afterwards
#   (plan.verify commands, clean tree, pushed). A failed verification gets one fix attempt
#   with plan.fixChain; if it still fails a coordinator tries to recover (plan.coordinatorChain).
# - plan.supervision: automatico (never stops), acompanhado (asks before tasks with "confirm",
#   the first main task, recoveries and the switch to free models) or passo (asks before every task).
#   A question is a file logs\gates\<gate>.json; the panel answers with <gate>.ok or <gate>.no.
# - Desperate mode: when no provider has quota, tasks run on plan.desperateChain (free models)
#   instead of waiting; it turns off when quota comes back.
# - State in <logDir>\status.json (use -Resume to continue), events in events.jsonl, summary in summary.md.
# ASCII only (PowerShell 5.1).
param([Parameter(Mandatory=$true)][string]$Plan, [switch]$Resume)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$utf8 = New-Object Text.UTF8Encoding $false
$planDir = Split-Path (Resolve-Path $Plan)
$p = Get-Content $Plan -Raw -Encoding UTF8 | ConvertFrom-Json
$repo = $p.repo
$logRoot = if ($p.logDir) { $p.logDir } else { Join-Path $planDir 'logs' }
$wtRoot = if ($p.worktreeRoot) { $p.worktreeRoot } else { "$repo-wt" }
$chain = if ($p.chain) { @($p.chain) } else { @('agy:gemini-3.8-flash-high','claude:sonnet','claude:haiku') }
$fixChain = if ($p.fixChain) { @($p.fixChain) } else { @('claude:sonnet','agy:gemini-3.8-flash-high') }
$maxConc = if ($p.maxConcurrent) { [int]$p.maxConcurrent } else { 2 }
$coordChain = if ($p.coordinatorChain) { @($p.coordinatorChain) } else { @('agy:gemini-3.8-flash-high','claude:sonnet') }
$despChain = if ($p.desperateChain) { @($p.desperateChain) } else { @() }
$maxRecoveries = if ($null -ne $p.maxRecoveries) { [int]$p.maxRecoveries } else { 2 }
$script:recoveries = 0
$script:desperate = $false
$script:despAsk = 0
$skill = $PSScriptRoot
New-Item -ItemType Directory -Force $logRoot | Out-Null
$gateDir = Join-Path $logRoot 'gates'
New-Item -ItemType Directory -Force $gateDir | Out-Null
$statusFile = Join-Path $logRoot 'status.json'
$logFile = Join-Path $logRoot 'pipeline.log'
$eventsFile = Join-Path $logRoot 'events.jsonl'
function Log($m) { $l = "$((Get-Date).ToString('s')) $m"; Add-Content $logFile $l -Encoding UTF8; Write-Host $l }
function Ev($tipo, $tarefa, $modelo, $texto) {
  $line = [pscustomobject]@{ time = (Get-Date).ToString('s'); tipo = $tipo; tarefa = $tarefa; modelo = $modelo; texto = $texto } | ConvertTo-Json -Compress
  for ($k = 0; $k -lt 5; $k++) { try { [IO.File]::AppendAllText($eventsFile, $line + "`n", $utf8); return } catch { Start-Sleep -Milliseconds 200 } }
}
function Notify($m) { try { msg $env:USERNAME "Delegar $($p.name): $m" 2>$null } catch {} }

# Supervision is re-read every loop, so the panel can change it while the pipeline runs.
function Supervision {
  try { $s = (Get-Content $Plan -Raw -Encoding UTF8 | ConvertFrom-Json).supervision } catch { $s = $null }
  if ($s -in @('automatico','acompanhado','passo')) { return $s } else { return 'automatico' }
}

# ---- gates ----
function GateState($g) {
  if (Test-Path (Join-Path $gateDir "$g.ok")) { return 'ok' }
  if (Test-Path (Join-Path $gateDir "$g.no")) { return 'no' }
  if (Test-Path (Join-Path $gateDir "$g.json")) { return 'pending' }
  return 'none'
}
function AskGate($g, $task, $reason) {
  $o = [pscustomobject]@{ gate = $g; task = $task; reason = $reason; time = (Get-Date).ToString('s') } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText((Join-Path $gateDir "$g.json"), $o, $utf8)
  Log "gate $g waiting: $reason"
  Ev 'aguardando' $task $null "aguardando confirmacao: $reason"
  Notify "aguardando sua confirmacao ($reason). Abra o painel: http://127.0.0.1:8790"
}

# ---- state ----
$st = @{}
if ($Resume -and (Test-Path $statusFile)) {
  (Get-Content $statusFile -Raw -Encoding UTF8 | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $st[$_.Name] = $_.Value }
}
foreach ($t in $p.tasks) {
  if (-not $st.ContainsKey($t.id) -or $st[$t.id].state -in @('running','failed')) {
    # a task that was running when the pipeline stopped resumes knowing it may be half done
    $nota = if ($st.ContainsKey($t.id) -and $st[$t.id].state -eq 'running') { 'interrompida' } else { $null }
    $st[$t.id] = [pscustomobject]@{ state = 'pending'; model = $null; started = $null; finished = $null; note = $nota }
  }
}
function Save { $o = [ordered]@{}; foreach ($t in $p.tasks) { $o[$t.id] = $st[$t.id] }; [pscustomobject]$o | ConvertTo-Json -Depth 4 | Set-Content $statusFile -Encoding UTF8 }
Save

# ---- quota (cached 10 min) ----
$script:quotaAt = [datetime]::MinValue; $script:quotaN = 1
function QuotaN {
  if (((Get-Date) - $script:quotaAt).TotalMinutes -ge 10) {
    $out = & (Join-Path $skill 'quota.ps1') 2>$null | Out-String
    if ($out -match 'recommendedConcurrent=(\d+)') { $script:quotaN = [int]$Matches[1] }
    $script:quotaAt = Get-Date
    Log "quota: recommendedConcurrent=$($script:quotaN)"
  }
  return $script:quotaN
}

function PromptFor($t, $wt) {
  $path = if ([IO.Path]::IsPathRooted($t.prompt)) { $t.prompt } else { Join-Path $planDir $t.prompt }
  $txt = Get-Content $path -Raw -Encoding UTF8
  $txt = $txt.Replace('{REPO}', $repo)
  if ($wt) { $txt = $txt.Replace('{WT}', $wt) }
  if ($st[$t.id].note -eq 'interrompida') {
    $txt += "`n`nATENCAO - TAREFA RETOMADA: esta tarefa estava em andamento quando o processo parou. Antes de tudo rode git status, git diff --stat e git log -3 (e confira os arquivos da worktree, se houver) para ver o que ja foi feito; continue dali, sem refazer nem apagar o que esta pronto.`n"
    $prev = Join-Path (Join-Path $logRoot $t.id) 'current.json'
    if (Test-Path $prev) { try { $c = Get-Content $prev -Raw | ConvertFrom-Json; $txt += "Modelo que estava trabalhando: $($c.worker).`n" } catch {} }
  }
  $out = Join-Path $logRoot "$($t.id).prompt.md"
  [IO.File]::WriteAllText($out, $txt, $utf8)
  return $out
}

function StartWorker($id, $promptFile, $cwd, $ch) {
  $ld = Join-Path $logRoot $id
  $q = { param($s) '"' + $s + '"' }
  $argList = "-NoProfile -ExecutionPolicy Bypass -File $(& $q (Join-Path $skill 'worker.ps1')) -PromptFile $(& $q $promptFile) -Cwd $(& $q $cwd) -LogDir $(& $q $ld) -Chain $(& $q ($ch -join ','))"
  return Start-Process powershell -ArgumentList $argList -WindowStyle Hidden -PassThru
}

function Verify {
  $msgs = @()
  Push-Location $repo
  foreach ($c in @($p.verify)) {
    if (-not $c) { continue }
    $o = cmd /c "$c 2>&1" | Out-String
    if ($LASTEXITCODE -ne 0) { $msgs += "FALHOU: $c`n$o" }
  }
  $dirty = git status --porcelain | Out-String
  if ($dirty.Trim()) { $msgs += "Arvore suja (git status --porcelain):`n$dirty" }
  $sb = git status -sb | Select-Object -First 1
  if ($sb -match 'ahead') { $msgs += "Commits sem push: $sb" }
  Pop-Location
  return ($msgs -join "`n`n")
}

# Does this task need the user's OK before starting?
function NeedsGate($t) {
  $sup = Supervision
  if ($sup -eq 'passo') { return $true }
  if ($sup -ne 'acompanhado') { return $false }
  if ($t.confirm) { return $true }
  if ($t.main) {
    $mainStarted = @($p.tasks | Where-Object { $_.main -and $st[$_.id].state -in @('running','done','failed') }).Count
    if ($mainStarted -eq 0) { return $true }
  }
  return $false
}
function GateReason($t) {
  if ($t.confirm -and $t.reason) { return "$($t.id): $($t.reason)" }
  if ($t.confirm) { return "$($t.id) ($($t.titulo)) foi marcada como importante pelo planejador" }
  if ($t.main -and (Supervision) -eq 'acompanhado') { return "primeira integracao no repositorio: $($t.id) ($($t.titulo))" }
  return "iniciar $($t.id) ($($t.titulo))"
}

$running = @{}   # id -> @{ proc; main; fix; promptFile }
$halt = $false
Log "pipeline start: $($p.name) resume=$Resume supervision=$(Supervision)"
Ev 'pipeline' $null $null "execucao iniciada (acompanhamento: $(Supervision))"

while ($true) {
  # collect finished
  foreach ($id in @($running.Keys)) {
    $r = $running[$id]
    if (-not $r.proc.HasExited) { continue }
    $running.Remove($id)
    $ld = if ($r.fix) { Join-Path $logRoot "$id-fix" } else { Join-Path $logRoot $id }
    $res = if (Test-Path "$ld\result.json") { Get-Content "$ld\result.json" -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
    $s = $st[$id]
    $s.model = if ($res) { $res.model } else { $null }
    $ok = $res -and $res.ok
    $t = $p.tasks | Where-Object { $_.id -eq $id }
    if ($ok -and $r.main) {
      $v = Verify
      if ($v) {
        if (-not $r.fix) {
          Log "$id verify failed, launching fix"
          Ev 'verificacao' $id $null 'verificacao falhou; mandando correcao'
          $fp = Join-Path $logRoot "$id.fix.md"
          $orig = Get-Content $r.promptFile -Raw -Encoding UTF8
          $fx = "A tarefa abaixo foi executada, mas a verificacao automatica falhou. Corrija o problema no repositorio $repo e conclua o fechamento que a tarefa original pedir (commit, push, deploy, cofre, conforme o caso). Nao refaca o trabalho que ja esta pronto. Nao grave no cofre nada alem do que a tarefa original pedir.`n`n## Falhas`n$v`n`n## Tarefa original`n$orig"
          [IO.File]::WriteAllText($fp, $fx, $utf8)
          $fc = if ($script:desperate -and $despChain.Count) { $despChain } else { $fixChain }
          $running[$id] = @{ proc = (StartWorker "$id-fix" $fp $repo $fc); main = $true; fix = $true; promptFile = $r.promptFile }
          $s.note = 'fixing'; Save; continue
        }
        $ok = $false; $s.note = "verify failed after fix: $($v.Substring(0, [Math]::Min(500, $v.Length)))"
      }
    }
    $s.finished = (Get-Date).ToString('s')
    if ($ok) {
      $s.state = 'done'; Log "$id done ($($s.model))"; Ev 'tarefa' $id $s.model 'tarefa concluida'
      foreach ($w in @($t.removeWorktrees)) {
        if (-not $w) { continue }
        Push-Location $repo; git worktree remove --force (Join-Path $wtRoot $w) 2>$null; git branch -D "wt/$w" 2>$null | Out-Null; Pop-Location
        Log "worktree $w removed"
      }
    } else {
      $s.state = 'failed'; $halt = $true; Log "$id FAILED; halting new launches"; Ev 'tarefa' $id $s.model 'tarefa falhou; novas tarefas suspensas'
    }
    Save
  }

  # tasks blocked by a refused confirmation are skipped too
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($t in $p.tasks) {
      if ($st[$t.id].state -notin @('pending','waiting')) { continue }
      $bad = @($t.after | Where-Object { $_ -and $st[$_].state -eq 'skipped' })
      if ($bad.Count) { $st[$t.id].state = 'skipped'; $st[$t.id].note = "depende de $($bad -join ', '), que foi recusada"; $changed = $true }
    }
  }

  $pending = @($p.tasks | Where-Object { $st[$_.id].state -in @('pending','waiting') })
  if (-not $halt -and $pending.Count -eq 0 -and $running.Count -eq 0) { break }
  if ($halt -and $running.Count -eq 0) {
    # Recovery: a coordinator agent diagnoses and fixes, then failed tasks are retried.
    $failedIds = @($p.tasks | Where-Object { $st[$_.id].state -eq 'failed' } | ForEach-Object { $_.id })
    $next = [int]$script:recoveries + 1
    if ($next -gt $maxRecoveries) { break }
    if ((Supervision) -ne 'automatico') {
      $g = "recuperacao-$next"
      $gs = GateState $g
      if ($gs -eq 'none') { AskGate $g $null "falharam: $($failedIds -join ', '). Chamar o coordenador para corrigir e repetir?"; Start-Sleep 30; continue }
      if ($gs -eq 'pending') { Start-Sleep 30; continue }
      if ($gs -eq 'no') { Log "recovery refused by user"; Ev 'pipeline' $null $null 'recuperacao recusada pelo usuario'; break }
    }
    $script:recoveries = $next
    Log "recovery $($script:recoveries)/$($maxRecoveries) for: $($failedIds -join ', ')"
    Ev 'recuperacao' $null $null "coordenador chamado para: $($failedIds -join ', ')"
    $cp = Join-Path $logRoot "recovery$($script:recoveries).md"
    $ctx = ($failedIds | ForEach-Object { "- $_ : nota=$($st[$_].note); logs em $(Join-Path $logRoot $_) e $(Join-Path $logRoot ($_ + '-fix')); prompt em $(Join-Path $logRoot ($_ + '.prompt.md'))" }) -join "`n"
    $txt = "Voce e o COORDENADOR do pipeline '$($p.name)' (plano: $Plan, estado: $statusFile, log: $logFile). Repositorio: $repo.`nAs tarefas abaixo falharam:`n$ctx`n`nLeia os logs e descubra a causa. Corrija o que impede a tarefa de concluir (no repositorio, nas worktrees em $wtRoot ou no arquivo de prompt da tarefa em $planDir), sem refazer trabalho pronto e sem apagar arquivos de outras tarefas. Se a tarefa ja estiver de fato concluida (commit, push, deploy), apenas confirme. Nao rode o pipeline: ele mesmo vai reler o plano e repetir as tarefas quando voce terminar. Nao grave nada no cofre de conhecimento. Termine com um resumo curto da causa e da correcao."
    [IO.File]::WriteAllText($cp, $txt, $utf8)
    $cc = if ($script:desperate -and $despChain.Count) { $despChain } else { $coordChain }
    $proc = StartWorker "recovery$($script:recoveries)" $cp $repo $cc
    $proc.WaitForExit()
    try { $p = Get-Content $Plan -Raw -Encoding UTF8 | ConvertFrom-Json; Log 'plan reloaded' } catch { Log "plan reload failed: $_" }
    foreach ($id in $failedIds) { $st[$id].state = 'pending'; $st[$id].note = "retry after recovery $($script:recoveries)" }
    $halt = $false; Save; continue
  }

  if (-not $halt) {
    $qn = QuotaN
    if ($qn -gt 0 -and $script:desperate) { $script:desperate = $false; Log 'desperate mode OFF (quota is back)'; Ev 'desespero' $null $null 'cota voltou; saindo do modo desespero' }
    if ($qn -eq 0 -and -not $script:desperate -and $running.Count -eq 0) {
      if ($despChain.Count -eq 0) { Log 'no quota on any provider; waiting 15 min'; Start-Sleep 900; $script:quotaAt = [datetime]::MinValue; continue }
      $go = $true
      if ((Supervision) -ne 'automatico') {
        $g = "desespero-$($script:despAsk)"
        $gs = GateState $g
        if ($gs -eq 'none') { AskGate $g $null 'sem cota no Claude e no Gemini. Continuar com os modelos gratuitos (modo desespero)?'; $go = $false }
        elseif ($gs -eq 'pending') { $go = $false }
        elseif ($gs -eq 'no') { Log 'desperate mode refused; waiting 15 min'; $script:despAsk++; Start-Sleep 900; $script:quotaAt = [datetime]::MinValue; continue }
      }
      if (-not $go) { Start-Sleep 30; continue }
      $script:desperate = $true
      Log "desperate mode ON: $($despChain -join ' > ')"
      Ev 'desespero' $null ($despChain -join ' > ') 'sem cota no Claude e no Gemini; usando os modelos gratuitos'
      Notify 'sem cota no Claude e no Gemini; seguindo com os modelos gratuitos (modo desespero).'
    }
    $limit = if ($script:desperate) { [Math]::Min($maxConc, 2) } else { [Math]::Min($maxConc, $qn) }
    $mainBusy = @($running.Values | Where-Object { $_.main }).Count -gt 0
    foreach ($t in $pending) {
      if ($running.Count -ge $limit) { break }
      $depsOk = $true
      foreach ($d in @($t.after)) { if ($d -and $st[$d].state -ne 'done') { $depsOk = $false } }
      if (-not $depsOk) { continue }
      if ($t.main -and $mainBusy) { continue }
      if (NeedsGate $t) {
        $g = "t-$($t.id)"
        $gs = GateState $g
        if ($gs -eq 'none') { AskGate $g $t.id (GateReason $t); $st[$t.id].state = 'waiting'; $st[$t.id].note = 'aguardando confirmacao'; Save; continue }
        if ($gs -eq 'pending') { continue }
        if ($gs -eq 'no') { $st[$t.id].state = 'skipped'; $st[$t.id].note = 'recusada pelo usuario'; Log "$($t.id) refused by user"; Ev 'tarefa' $t.id $null 'recusada pelo usuario'; Save; continue }
      }
      $cwd = $repo; $wt = $null
      if ($t.worktree) {
        $wt = Join-Path $wtRoot $t.worktree
        if (-not (Test-Path $wt)) {
          New-Item -ItemType Directory -Force $wtRoot | Out-Null
          Push-Location $repo; git worktree add $wt -b "wt/$($t.worktree)" 2>&1 | Out-Null; Pop-Location
        }
        $cwd = $wt
      }
      $pf = PromptFor $t $wt
      $ch = if ($script:desperate -and $despChain.Count) { $despChain } elseif ($t.chain) { @($t.chain) } else { $chain }
      $running[$t.id] = @{ proc = (StartWorker $t.id $pf $cwd $ch); main = [bool]$t.main; fix = $false; promptFile = $pf }
      $st[$t.id].state = 'running'; $st[$t.id].started = (Get-Date).ToString('s'); $st[$t.id].note = $null; Save
      Log "$($t.id) started in $cwd"
      Ev 'inicio' $t.id ($ch -join ' > ') "tarefa iniciada em $cwd"
      if ($t.main) { $mainBusy = $true }
      Start-Sleep 60   # stagger launches
    }
  }
  Start-Sleep 30
}

# ---- summary ----
$lines = @("# Pipeline $($p.name)", "", "Fim: $((Get-Date).ToString('s'))", "", "| Tarefa | Estado | Modelo | Inicio | Fim | Nota |", "|---|---|---|---|---|---|")
foreach ($t in $p.tasks) { $s = $st[$t.id]; $lines += "| $($t.id) | $($s.state) | $($s.model) | $($s.started) | $($s.finished) | $($s.note) |" }
$failed = @($p.tasks | Where-Object { $st[$_.id].state -ne 'done' }).Count
$lines += ""; $lines += $(if ($failed) { "RESULTADO: INCOMPLETO ($failed tarefas nao concluidas)" } else { 'RESULTADO: CONCLUIDO' })
[IO.File]::WriteAllText((Join-Path $logRoot 'summary.md'), ($lines -join "`n"), $utf8)
Log "pipeline end: failed=$failed"
Ev 'pipeline' $null $null $(if ($failed) { "terminou INCOMPLETO ($failed tarefas nao concluidas)" } else { 'terminou CONCLUIDO' })
Notify "$(if ($failed) { 'INCOMPLETO' } else { 'CONCLUIDO' }). Ver $logRoot\summary.md"
if ($failed) { exit 1 } else { exit 0 }
