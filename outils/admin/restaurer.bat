@echo off
rem Restauration d'une sauvegarde : restaurer.bat <fichier.json> [--oui] [--effacer] [--comptes]
cd /d "%~dp0"
if not exist node_modules\firebase-admin (
  echo Installation de firebase-admin...
  call npm install --silent || exit /b 1
)
node restaurer.js %*
pause
