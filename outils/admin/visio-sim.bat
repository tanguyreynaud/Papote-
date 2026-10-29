@echo off
rem Essai de qualite de l'appel video sur SIM, pour une famille (sa tablette).
rem   visio-sim.bat T-003            : reglage en cours
rem   visio-sim.bat T-003 300 100    : image recue 300 kbit/s, Mamie envoyee 100 kbit/s
rem   visio-sim.bat T-003 normal     : retour au reglage normal (500 / 120)
cd /d "%~dp0"
if not exist node_modules\firebase-admin (
  echo Installation de firebase-admin...
  call npm install --silent || exit /b 1
)
node visio-sim.js %*
pause
