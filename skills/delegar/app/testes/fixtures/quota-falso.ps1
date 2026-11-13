# Falso quota.ps1 para os testes do painel: ignora todos os parametros, espera 1 s e grava um JSON fixo.
# Se existir state\falhar, sai com codigo 1 sem JSON. Cada execucao acrescenta uma linha em state\contador.txt.
$dataDir = $env:DELEGAR_DATA
if (-not $dataDir) { $dataDir = Join-Path $env:USERPROFILE '.delegar' }
$state = Join-Path $dataDir 'state'
New-Item -ItemType Directory -Force -Path $state | Out-Null
Add-Content -Path (Join-Path $state 'contador.txt') -Value ([string](Get-Date).Ticks)
Start-Sleep -Seconds 1
if (Test-Path (Join-Path $state 'falhar')) {
  [Console]::Error.WriteLine('SEGREDO-DO-SCRIPT: falha simulada')
  Write-Output 'SEGREDO-DO-SCRIPT'
  exit 1
}
$agora = Get-Date
$time = $agora.ToString('s')
$r5 = $agora.AddHours(3).ToString('s')
$r7 = $agora.AddDays(4).ToString('s')
$json = @"
{
  "time": "$time",
  "claude": { "installed": true, "read": true, "fiveHour": 0.85, "sevenDay": 0.40, "fiveHourRemaining": 0.15, "sevenDayRemaining": 0.60, "fiveHourResets": "$r5", "sevenDayResets": "$r7", "readAt": "$time", "maxParallel": 2 },
  "gemini": { "source": "agy", "read": true, "fiveHour": 0.10, "sevenDay": 0.45, "fiveHourRemaining": 0.90, "sevenDayRemaining": 0.55, "fiveHourResets": "$r5", "sevenDayResets": "$r7", "exhausted": false, "readAt": "$time", "lastQuotaHit": null, "maxParallel": 3 },
  "argon": { "read": true, "sevenDay": 0.16, "sevenDayRemaining": 0.84, "sevenDayResets": "$r7", "exhausted": false, "readAt": "$time" },
  "agyClaudeGpt": { "read": true, "fiveHour": 0, "sevenDay": 0, "fiveHourRemaining": 1, "sevenDayRemaining": 1, "fiveHourResets": "$r5", "sevenDayResets": "$r7", "exhausted": false, "readAt": "$time" },
  "agy": { "installed": true, "read": true, "readAt": "$time", "error": null, "seconds": 1, "limits": [] },
  "opencode": { "installed": true },
  "recommendedConcurrent": 2
}
"@
[System.IO.File]::WriteAllText((Join-Path $state 'quota-last.json'), $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Output $json
Write-Output 'recommendedConcurrent=2'
exit 0
