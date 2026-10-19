@echo off
rem Clés App Check des tablettes : cle-tablette.bat --liste ^| --retirer SERIE ^| --serie SERIE
cd /d "%~dp0"
if not exist node_modules\firebase-admin (
  echo Installation de firebase-admin...
  call npm install --silent || exit /b 1
)
node cle-tablette.js %*
pause
