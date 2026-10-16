@echo off
rem Copie les données de Papote vers l'Europe (base « europe » et nouveau bucket).
rem   migrer-europe.bat        : compte ce qui serait copié
rem   migrer-europe.bat --oui  : copie (l'ancienne base reste intacte)
cd /d "%~dp0"
if not exist node_modules\firebase-admin (
  echo Installation de firebase-admin...
  call npm install --silent || exit /b 1
)
node migrer-europe.js %*
pause
