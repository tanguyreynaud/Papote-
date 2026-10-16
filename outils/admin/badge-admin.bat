@echo off
rem Donne le badge administrateur à un compte Google : badge-admin.bat adresse@gmail.com [--retirer]
cd /d "%~dp0"
if not exist node_modules\firebase-admin (
  echo Installation de firebase-admin...
  call npm install --silent || exit /b 1
)
node badge-admin.js %*
pause
