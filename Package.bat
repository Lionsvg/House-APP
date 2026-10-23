@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js est requis pour fabriquer les paquets & pause & exit /b 1)
if not exist node_modules call npm install --omit=dev --no-fund --no-audit
node scripts\build.js %*
echo.
pause
