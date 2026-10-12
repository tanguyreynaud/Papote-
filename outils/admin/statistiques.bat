@echo off
rem Statistiques du site (visites, commandes, taux de conversion).
rem   statistiques.bat      : 30 derniers jours
rem   statistiques.bat 7    : 7 derniers jours
cd /d "%~dp0"
if not exist node_modules\firebase-admin (
  echo Installation de firebase-admin...
  call npm install --silent || exit /b 1
)
node statistiques.js %*
pause
