@echo off
rem Sauvegarde de la base dans sauvegardes\papote-<date>.json (a copier hors du PC).
cd /d "%~dp0"
if not exist node_modules\firebase-admin (
  echo Installation de firebase-admin...
  call npm install --silent || exit /b 1
)
node sauvegarder.js %*
pause
