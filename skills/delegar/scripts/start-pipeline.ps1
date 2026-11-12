# Starts pipeline.ps1 as a detached hidden process, so it keeps running after the Claude session ends.
# Usage: start-pipeline.ps1 -Plan C:\path\plan.json [-Resume]
param([Parameter(Mandatory=$true)][string]$Plan, [switch]$Resume)
$pipe = Join-Path $PSScriptRoot 'pipeline.ps1'
$argList = "-NoProfile -ExecutionPolicy Bypass -File `"$pipe`" -Plan `"$((Resolve-Path $Plan).Path)`""
if ($Resume) { $argList += ' -Resume' }
$proc = Start-Process powershell -ArgumentList $argList -WindowStyle Hidden -PassThru
Write-Output "pipeline pid=$($proc.Id)"
