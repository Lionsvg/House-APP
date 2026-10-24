@echo off
rem HouseApp - mise a jour : seuls les fichiers modifies sont remplaces (data\ et config.bat conserves).
rem Tout sur une ligne : cmd la lit en entier, donc remplacer ce fichier pendant la mise a jour est sans risque.
cd /d "%~dp0" & powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\update.ps1" -Dir "%~dp0." %* & echo. & pause & exit /b
