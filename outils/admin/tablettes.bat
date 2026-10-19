@echo off
rem Tablettes de toutes les familles : version et derniere activité (lecture seule).
rem   tablettes.bat         : signale les tablettes sous 2.74
rem   tablettes.bat 2.78    : signale les tablettes sous 2.78
cd /d "%~dp0"
if not exist node_modules\firebase-admin (
  echo Installation de firebase-admin...
  call npm install --silent || exit /b 1
)
node tablettes.js %*
pause
