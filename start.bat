@echo off
setlocal
title HouseApp
set "APPDIR=%~dp0"
pushd "%APPDIR%"

set "NODE=%APPDIR%node\node.exe"
if not exist "%NODE%" (
  where node >nul 2>nul || (echo Node.js est introuvable : lancez Setup.bat & pause & exit /b 1)
  set "NODE=node"
)
if not exist "%APPDIR%node_modules" (echo Installation des dependances... & call npm install --omit=dev --no-fund --no-audit)

set HOST=127.0.0.1,tailscale
set PORT=8800
if exist "%APPDIR%config.bat" call "%APPDIR%config.bat"

if /i not "%~1"=="/silent" start "" http://localhost:%PORT%
"%NODE%" "%APPDIR%server.js"
if /i not "%~1"=="/silent" pause
popd
