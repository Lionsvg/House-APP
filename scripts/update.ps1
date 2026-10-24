<#
  HouseApp - mise a jour sous Windows.
  Telecharge le paquet de la nouvelle version, verifie son empreinte SHA-256, puis ne remplace
  QUE les fichiers qui ont change. Le dossier data\ et config.bat ne sont jamais touches.

  Dans le dossier HouseApp : double-clic sur Update.bat
  Depuis PowerShell, dans le dossier HouseApp :
    irm https://raw.githubusercontent.com/Lionsvg/House-APP/main/scripts/update.ps1 | iex
#>
param(
  [string]$Dir = '',
  [string]$Version = '',
  [switch]$Check,
  [switch]$Force,
  [string]$From = ''   # tests : URL locale contenant les paquets, a la place de GitHub
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest est tres lent avec la barre de progression
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Repo = 'Lionsvg/House-APP'
$Manifest = '.houseapp-files'
$Protected = '^(data/|config\.bat$)'      # jamais ecrases ni supprimes

function Info($m) { Write-Host "  $m" }
function Ok($m) { Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!]  $m" -ForegroundColor Yellow }
function Die($m) { throw $m }   # pas de "exit" : avec "irm | iex" il fermerait la fenetre PowerShell

try {
# Dossier d'installation : -Dir, sinon le dossier parent de ce script, sinon le dossier courant
if (-not $Dir) {
  if ($PSCommandPath -and (Test-Path (Join-Path (Split-Path (Split-Path $PSCommandPath)) 'server.js'))) { $Dir = Split-Path (Split-Path $PSCommandPath) }
  else { $Dir = (Get-Location).Path }
}
$Dir = (Resolve-Path $Dir).Path
if (-not (Test-Path (Join-Path $Dir 'server.js'))) { Die "HouseApp introuvable dans $Dir (lancez la commande depuis le dossier HouseApp, ou -Dir C:\chemin\HouseApp)" }

$current = (Get-Content (Join-Path $Dir 'package.json') -Raw | ConvertFrom-Json).version
if (-not $Version) {
  try { $Version = (Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest" -UseBasicParsing).tag_name }
  catch { Die "Impossible de lire la derniere version sur GitHub : $($_.Exception.Message)" }
}
$Version = $Version -replace '^v', ''
Write-Host ""
Write-Host "HouseApp : version installee $current, version disponible $Version" -ForegroundColor Cyan
if ($current -eq $Version -and -not $Force) { Ok 'Deja a jour'; return }
if ($Check) { Info 'Une mise a jour est disponible : double-cliquez sur Update.bat'; return }

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("houseapp-update-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  $base = if ($From) { $From.TrimEnd('/') } else { "https://github.com/$Repo/releases/download/v$Version" }
  $asset = 'HouseApp-windows-x64.zip'
  Info "Telechargement de $asset"
  try {
    Invoke-WebRequest "$base/$asset" -OutFile (Join-Path $tmp $asset) -UseBasicParsing
    Invoke-WebRequest "$base/SHA256SUMS.txt" -OutFile (Join-Path $tmp 'SHA256SUMS.txt') -UseBasicParsing
  } catch { Die "Telechargement impossible : $($_.Exception.Message)" }
  $line = Get-Content (Join-Path $tmp 'SHA256SUMS.txt') | Where-Object { $_ -match "\s$([regex]::Escape($asset))$" } | Select-Object -First 1
  $expected = if ($line) { ($line -split '\s+')[0].ToLower() } else { '' }
  $got = (Get-FileHash (Join-Path $tmp $asset) -Algorithm SHA256).Hash.ToLower()
  if (-not $expected -or $expected -ne $got) { Die "Empreinte SHA-256 incorrecte : fichier corrompu ou modifie, rien n'a ete change" }
  Ok 'Empreinte SHA-256 verifiee'
  Expand-Archive (Join-Path $tmp $asset) -DestinationPath (Join-Path $tmp 'x') -Force
  $new = Join-Path $tmp 'x\HouseApp'
  if (-not (Test-Path (Join-Path $new 'server.js'))) { Die 'Paquet invalide' }

  $newFiles = Get-ChildItem $new -Recurse -File | ForEach-Object { $_.FullName.Substring($new.Length + 1).Replace('\', '/') } |
    Where-Object { $_ -notmatch $Protected } | Sort-Object
  $changed = @(); $added = @(); $removed = @()
  foreach ($f in $newFiles) {
    $dst = Join-Path $Dir $f
    if (-not (Test-Path -LiteralPath $dst)) { $added += $f }
    elseif ((Get-FileHash -LiteralPath (Join-Path $new $f) -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash) { $changed += $f }
  }
  # Fichiers de l'ancienne version qui n'existent plus (seulement si on connait la liste precedente)
  $mf = Join-Path $Dir $Manifest
  if (Test-Path $mf) {
    $set = @{}; foreach ($f in $newFiles) { $set[$f] = $true }
    foreach ($f in (Get-Content $mf | Where-Object { $_ -and -not $_.StartsWith('#') })) {
      if (-not $set.ContainsKey($f) -and $f -notmatch $Protected -and (Test-Path -LiteralPath (Join-Path $Dir $f))) { $removed += $f }
    }
  }
  Info "$($newFiles.Count) fichiers dans la version ${Version} : $($changed.Count) modifies, $($added.Count) nouveaux, $($removed.Count) supprimes"

  # HouseApp tourne ? On l'arrete le temps de copier (node.exe et les modules sont verrouilles sinon)
  $running = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$Dir*server.js*" })
  $stopped = $false
  if ($changed.Count + $added.Count + $removed.Count -gt 0) {
    if ($running.Count) { $running | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Start-Sleep -Seconds 1; $stopped = $true; Info 'HouseApp arrete pendant la mise a jour' }
    foreach ($f in ($changed + $added)) {
      $dst = Join-Path $Dir $f
      New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
      Copy-Item -LiteralPath (Join-Path $new $f) -Destination $dst -Force
    }
    foreach ($f in $removed) { Remove-Item -LiteralPath (Join-Path $Dir $f) -Force }
  }
  @("# HouseApp $Version : fichiers installes (utilise par update.ps1)") + $newFiles | Set-Content -Path $mf -Encoding UTF8

  foreach ($pair in @(@('~', $changed), @('+', $added), @('-', $removed))) {
    $list = $pair[1]
    $list | Select-Object -First 15 | ForEach-Object { Info "  $($pair[0]) $_" }
    if ($list.Count -gt 15) { Info "  ... et $($list.Count - 15) autres" }
  }
  if ($stopped) {   # on ne relance que ce qu'on a arrete (sinon : deux HouseApp sur le meme port)
    Start-Process -FilePath (Join-Path $Dir 'start.bat') -WorkingDirectory $Dir
    Ok 'HouseApp redemarre'
  }
  Write-Host ""
  Ok "HouseApp $current -> $Version (donnees et configuration conservees)"
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
} catch {
  Write-Host "  [X]  $($_.Exception.Message)" -ForegroundColor Red
  if ($PSCommandPath) { exit 1 }
}
