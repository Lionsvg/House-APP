param(
  [ValidateSet(0, 1, 2, 3)][int]$Mode = 0,
  [int]$Port = 0,
  [switch]$NoFirewall,
  [switch]$NoAutostart,
  [switch]$NoLaunch,
  [switch]$Yes,
  [switch]$FirewallOnly
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Info($t) { Write-Host "  $t" }
function Ok($t) { Write-Host "  [OK] $t" -ForegroundColor Green }
function Warn($t) { Write-Host "  [!]  $t" -ForegroundColor Yellow }
function Fail($t) { Write-Host "  [X]  $t" -ForegroundColor Red; exit 1 }
function Step($t) { Write-Host ""; Write-Host $t -ForegroundColor Cyan }
function Ask($question, [bool]$default = $true) {
  if ($Yes) { return $default }
  $hint = if ($default) { '[O/n]' } else { '[o/N]' }
  $r = Read-Host "  $question $hint"
  if ([string]::IsNullOrWhiteSpace($r)) { return $default }
  return $r -match '^[oOyY]'
}

if ($FirewallOnly) {
  $remote = if ($Mode -eq 2) { @('LocalSubnet', '100.64.0.0/10') } else { @('100.64.0.0/10') }
  Get-NetFirewallRule -DisplayName 'HouseApp' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName 'HouseApp' -Direction Inbound -Protocol TCP -LocalPort $Port -RemoteAddress $remote -Action Allow | Out-Null
  exit 0
}

Write-Host ""
Write-Host "  HouseApp - installation" -ForegroundColor White
Write-Host "  Dossier : $Root"

Step "1/6  Node.js"
$bundled = Join-Path $Root 'node\node.exe'
if (Test-Path $bundled) {
  Ok "Node.js intégré $((& $bundled -v).Trim())"
} else {
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Warn "Node.js n'est pas installé."
  if ((Get-Command winget -ErrorAction SilentlyContinue) -and (Ask "L'installer maintenant avec winget ?")) {
    winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    Warn "Node.js est installé : fermez cette fenêtre et relancez Setup.bat (le PATH doit être rechargé)."
    exit 0
  }
  Fail "Installez Node.js 20 ou plus récent depuis https://nodejs.org puis relancez Setup.bat."
}
$nodeVersion = (& node -v).Trim()
if ([int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 20) { Fail "Node.js $nodeVersion est trop ancien : version 20 minimum." }
Ok "Node.js $nodeVersion"
}

Step "2/6  Docker"
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Warn "Docker n'est pas installé : HouseApp démarrera, mais sans pouvoir installer d'applications."
  if ((Get-Command winget -ErrorAction SilentlyContinue) -and (Ask "Installer Docker Desktop avec winget ?" $false)) {
    winget install -e --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements
    Warn "Docker Desktop installé : redémarrez Windows puis lancez Docker Desktop une première fois."
  }
} else {
  $dv = & docker version --format '{{.Server.Version}}' 2>$null
  if ($LASTEXITCODE -eq 0 -and $dv) { Ok "Docker $dv" }
  else { Warn "Docker est installé mais ne répond pas : lancez Docker Desktop (et activez 'Démarrer avec Windows')." }
}
if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) { Ok "GPU NVIDIA détecté" } else { Info "Pas de GPU NVIDIA détecté (optionnel)" }
$ts = 'C:\Program Files\Tailscale\tailscale.exe'
$tsIp = if (Test-Path $ts) { (& $ts ip -4 2>$null | Select-Object -First 1) } else { $null }
if ($tsIp) { Ok "Tailscale connecté ($tsIp)" } else { Warn "Tailscale non détecté ou non connecté (https://tailscale.com/download)" }

Step "3/6  Dépendances"
if (Test-Path (Join-Path $Root 'node_modules\express')) {
  Ok "Dépendances incluses dans le paquet"
} else {
  & npm.cmd install --omit=dev --no-fund --no-audit
  if ($LASTEXITCODE -ne 0) { Fail "npm install a échoué (voir ci-dessus)." }
  Ok "Dépendances installées"
}

Step "4/6  Accès"
if ($Mode -eq 0) {
  Info "Qui peut ouvrir HouseApp ?"
  Info "  1. Ce PC + vos appareils Tailscale   (recommandé)"
  Info "  2. Tout le réseau local + Tailscale"
  Info "  3. Ce PC uniquement"
  $Mode = 1
  if (-not $Yes) {
    $r = Read-Host "  Votre choix [1]"
    if ($r -match '^[123]$') { $Mode = [int]$r }
  }
}
if ($Port -eq 0) {
  $Port = 8800
  if (-not $Yes) {
    $r = Read-Host "  Port [8800]"
    if ($r -match '^\d+$' -and [int]$r -ge 1024 -and [int]$r -le 65535) { $Port = [int]$r }
  }
}
$hostSetting = switch ($Mode) { 1 { '127.0.0.1,tailscale' } 2 { '0.0.0.0' } 3 { '127.0.0.1' } }
@(
  '@echo off'
  "set HOST=$hostSetting"
  "set PORT=$Port"
) | Set-Content -Path (Join-Path $Root 'config.bat') -Encoding ASCII
Ok "config.bat : HOST=$hostSetting  PORT=$Port"

Step "5/6  Pare-feu Windows"
if ($Mode -eq 3) { Info "Accès local uniquement : aucune règle nécessaire" }
elseif ($NoFirewall) { Info "Ignoré (-NoFirewall)" }
elseif (Ask "Autoriser le port $Port pour $(if ($Mode -eq 1) { 'Tailscale' } else { 'le réseau local et Tailscale' }) ? (demande les droits administrateur)") {
  $p = Start-Process powershell -Verb RunAs -Wait -PassThru -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-FirewallOnly', '-Port', $Port, '-Mode', $Mode)
  if ($p.ExitCode -eq 0) { Ok "Règle de pare-feu 'HouseApp' créée" } else { Warn "La règle n'a pas pu être créée (code $($p.ExitCode))" }
}

Step "6/6  Démarrage avec Windows"
$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'HouseApp.lnk'
if ($NoAutostart) { Info "Ignoré (-NoAutostart)" }
elseif (Ask "Lancer HouseApp automatiquement à l'ouverture de session ?") {
  $sh = New-Object -ComObject WScript.Shell
  $s = $sh.CreateShortcut($lnk)
  $s.TargetPath = Join-Path $Root 'start.bat'
  $s.Arguments = '/silent'
  $s.WorkingDirectory = $Root
  $s.WindowStyle = 7
  $s.Save()
  Ok "Raccourci créé : $lnk"
} elseif (Test-Path $lnk) {
  Remove-Item $lnk -Force
  Info "Démarrage automatique retiré"
}

Write-Host ""
Write-Host "  Installation terminée." -ForegroundColor Green
Info "Ouvrir : http://localhost:$Port"
if ($Mode -ne 3 -and $tsIp) { Info "Depuis Tailscale : http://${tsIp}:$Port" }
if (-not $NoLaunch -and (Ask "Démarrer HouseApp maintenant ?")) {
  Start-Process -FilePath (Join-Path $Root 'start.bat') -WorkingDirectory $Root
}
