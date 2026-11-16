@echo off
rem Sauvegarde de la base, des comptes et du dossier gestion/ dans sauvegardes\papote-date (4 gardees). --photos : aussi les photos. --auto : sans pause.
cd /d "%~dp0"
if not exist node_modules\firebase-admin (
  echo Installation de firebase-admin...
  call npm install --silent || exit /b 1
)
node sauvegarder.js %*
set CODE=%ERRORLEVEL%
echo %* | find "--auto" >nul || pause
exit /b %CODE%
