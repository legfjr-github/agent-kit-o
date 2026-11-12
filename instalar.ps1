# instalar.ps1 - instala o agent-kit num PC Windows (Claude Code, Antigravity, opencode, Gemini CLI).
#
# O que faz:
#   1. Confere Python 3.10+, Git e Node.js. O que faltar e baixado em versao portatil (zip oficial)
#      para %USERPROFILE%\agent-kit-tools, sem administrador. Cada download tem a assinatura digital
#      do executavel conferida (e o SHA-256, quando o fornecedor publica) antes de ser usado.
#   2. Poe essas pastas no PATH do usuario.
#   3. Clona o kit (se preciso) e roda install.py, que instala skills, regras e o orquestrador,
#      ajusta os caminhos do cofre para esta maquina e pergunta se deve mapear os projetos do PC.
#
# Uso (PowerShell do usuario):
#   Set-ExecutionPolicy -Scope Process Bypass -Force
#   .\instalar.ps1 -Repo https://github.com/<usuario>/<repo>.git          # clona em ~\agent-kit
#   .\instalar.ps1                                                        # dentro de um clone existente
#   .\instalar.ps1 -SoFerramentas                                         # so Python/Git/Node
#   .\instalar.ps1 -Mapear                                                # mapeia os projetos sem perguntar
# ASCII only (PowerShell 5.1).
[CmdletBinding()]
param(
  [string]$Repo = 'https://github.com/legfjr-github/agent-kit-o.git',
  [string]$Dir = '',
  [switch]$SoFerramentas,
  [switch]$Mapear
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'
$T = Join-Path $env:USERPROFILE 'agent-kit-tools'
New-Item -ItemType Directory -Force $T | Out-Null
$UA = @{ 'User-Agent' = 'agent-kit-installer' }

function Info($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Aviso($m) { Write-Host "[AVISO] $m" -ForegroundColor Yellow }

function Add-UserPath([string]$dir) {
  if (-not (Test-Path $dir)) { return }
  $cur = [Environment]::GetEnvironmentVariable('Path', 'User'); if (-not $cur) { $cur = '' }
  $items = $cur.Split(';') | Where-Object { $_ }
  if (-not ($items | Where-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') -ieq $dir.TrimEnd('\') })) {
    [Environment]::SetEnvironmentVariable('Path', (($items + $dir) -join ';'), 'User')
    Info "PATH do usuario: + $dir"
  }
  if (-not (($env:Path.Split(';')) -contains $dir)) { $env:Path = "$dir;$env:Path" }
}

# Download + checks. $Sha256: expected hash or $null. $Signer: text that must appear in the Authenticode signer.
function Get-Verified([string]$Url, [string]$Out, [string]$Sha256) {
  if (-not $Url.StartsWith('https://')) { throw "URL sem HTTPS: $Url" }
  Info "Baixando $Url"
  Invoke-WebRequest -Uri $Url -OutFile $Out -Headers $UA -UseBasicParsing
  if ($Sha256) {
    $h = (Get-FileHash $Out -Algorithm SHA256).Hash
    if ($h -ne $Sha256.ToUpper()) { Remove-Item $Out -Force; throw "SHA-256 nao confere para $Url" }
    Write-Host "    SHA-256 conferido"
  }
}
function Assert-Signed([string]$Exe, [string]$Signer) {
  $s = Get-AuthenticodeSignature $Exe
  if ($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch [regex]::Escape($Signer)) {
    throw "Assinatura invalida em $Exe (status $($s.Status), assinante '$($s.SignerCertificate.Subject)'). Instalacao interrompida."
  }
  Write-Host "    assinatura digital ok: $Signer"
}
function Expand-Fresh([string]$Zip, [string]$Dest) {
  if (Test-Path $Dest) { Remove-Item $Dest -Recurse -Force }
  Expand-Archive -Path $Zip -DestinationPath $Dest -Force
  Remove-Item $Zip -Force
}

function Test-Python {
  foreach ($c in @('python', 'py', 'python3')) {
    $cmd = Get-Command $c -ErrorAction SilentlyContinue
    if (-not $cmd) { continue }
    try { $v = & $cmd.Source -c "import sys;print('%d.%d' % sys.version_info[:2])" 2>$null } catch { continue }
    if ($v -match '^3\.(\d+)$' -and [int]$Matches[1] -ge 10) { return $cmd.Source }
  }
  $p = Join-Path $T 'python\python.exe'
  if (Test-Path $p) { return $p }
  return $null
}

function Install-Python {
  Info 'Python nao encontrado: instalando a versao portatil (embeddable) do python.org'
  $idx = (Invoke-WebRequest 'https://www.python.org/ftp/python/' -Headers $UA -UseBasicParsing).Content
  $vers = [regex]::Matches($idx, 'href="(3\.(1[2-3])\.(\d+))/"') | ForEach-Object { $_.Groups[1].Value } |
    Sort-Object { [version]$_ } -Descending
  foreach ($v in $vers) {
    $url = "https://www.python.org/ftp/python/$v/python-$v-embed-amd64.zip"
    try { Invoke-WebRequest $url -Method Head -Headers $UA -UseBasicParsing | Out-Null } catch { continue }
    $zip = Join-Path $env:TEMP "python-$v-embed.zip"
    Get-Verified $url $zip $null
    $dest = Join-Path $T 'python'
    Expand-Fresh $zip $dest
    Assert-Signed (Join-Path $dest 'python.exe') 'Python Software Foundation'
    # The embeddable package has no pip: enable site-packages and bootstrap pip (needed for undetected-chromedriver).
    Get-ChildItem $dest -Filter 'python*._pth' | ForEach-Object {
      (Get-Content $_.FullName) -replace '^#\s*import site', 'import site' | Set-Content $_.FullName -Encoding ascii
    }
    $gp = Join-Path $env:TEMP 'get-pip.py'
    Get-Verified 'https://bootstrap.pypa.io/get-pip.py' $gp $null
    & (Join-Path $dest 'python.exe') $gp --no-warn-script-location
    Remove-Item $gp -Force
    Add-UserPath (Join-Path $dest 'Scripts')
    return (Join-Path $dest 'python.exe')
  }
  throw 'Nao achei um Python 3.12/3.13 portatil no python.org.'
}

function Install-Git {
  Info 'Git nao encontrado: instalando o MinGit portatil (Git for Windows)'
  $rel = Invoke-RestMethod 'https://api.github.com/repos/git-for-windows/git/releases/latest' -Headers $UA
  $a = $rel.assets | Where-Object { $_.name -match '^MinGit-[\d.]+(\.windows\.\d+)?-64-bit\.zip$' } | Select-Object -First 1
  if (-not $a) { throw 'MinGit nao encontrado no ultimo release do Git for Windows.' }
  $sha = $null; if ($a.digest -match '^sha256:([0-9a-f]{64})$') { $sha = $Matches[1] }
  $zip = Join-Path $env:TEMP $a.name
  Get-Verified $a.browser_download_url $zip $sha
  $dest = Join-Path $T 'git'
  Expand-Fresh $zip $dest
  Assert-Signed (Join-Path $dest 'cmd\git.exe') 'Johannes Schindelin'
  Add-UserPath (Join-Path $dest 'cmd')
}

function Install-Node {
  Info 'Node.js nao encontrado: instalando a versao LTS portatil (zip oficial)'
  $lts = (Invoke-RestMethod 'https://nodejs.org/dist/index.json' -Headers $UA) | Where-Object { $_.lts } | Select-Object -First 1
  $v = $lts.version; $name = "node-$v-win-x64.zip"
  $sums = (Invoke-WebRequest "https://nodejs.org/dist/$v/SHASUMS256.txt" -Headers $UA -UseBasicParsing).Content
  $line = ($sums -split "`n") | Where-Object { $_ -match "\s$([regex]::Escape($name))$" } | Select-Object -First 1
  if (-not $line) { throw "Hash de $name nao publicado." }
  $zip = Join-Path $env:TEMP $name
  Get-Verified "https://nodejs.org/dist/$v/$name" $zip ($line -split '\s+')[0]
  $tmp = Join-Path $T 'node-tmp'
  Expand-Fresh $zip $tmp
  $dest = Join-Path $T 'node'
  if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
  Move-Item (Join-Path $tmp "node-$v-win-x64") $dest
  Remove-Item $tmp -Recurse -Force
  Assert-Signed (Join-Path $dest 'node.exe') 'OpenJS Foundation'
  Add-UserPath $dest
}

# ---- ferramentas ----
$py = Test-Python
if (-not $py) { $py = Install-Python; Add-UserPath (Split-Path $py) } else { Write-Host "    Python: $py" }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  if (Test-Path (Join-Path $T 'git\cmd\git.exe')) { Add-UserPath (Join-Path $T 'git\cmd') } else { Install-Git }
} else { Write-Host "    Git: $((Get-Command git).Source)" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  if (Test-Path (Join-Path $T 'node\node.exe')) { Add-UserPath (Join-Path $T 'node') } else { Install-Node }
} else { Write-Host "    Node: $((Get-Command node).Source)" }
Add-UserPath (Join-Path $env:APPDATA 'npm')   # onde o npm -g poe claude, opencode e gemini
if (Test-Path (Join-Path $env:USERPROFILE '.gemini\bin')) { Add-UserPath (Join-Path $env:USERPROFILE '.gemini\bin') }
if ($SoFerramentas) { Info 'Ferramentas prontas.'; exit 0 }

# ---- kit ----
$here = $PSScriptRoot
if (-not $Dir) { $Dir = if ($here -and (Test-Path (Join-Path $here 'install.py'))) { $here } else { Join-Path $env:USERPROFILE 'agent-kit' } }
if (-not (Test-Path (Join-Path $Dir 'install.py'))) {
  if (-not $Repo) { throw "Informe -Repo <url do agent-kit> para clonar em $Dir." }
  if (-not $Repo.StartsWith('https://')) { throw 'Use uma URL https do repositorio.' }
  Info "Clonando $Repo em $Dir"
  git clone $Repo $Dir
  if ($LASTEXITCODE -ne 0) { throw 'git clone falhou.' }
}
$argsPy = @((Join-Path $Dir 'install.py'), '--dir', $Dir)
if ($Mapear) { $argsPy += '--mapear' }
$ErrorActionPreference = 'Continue'
& $py @argsPy
exit $LASTEXITCODE
