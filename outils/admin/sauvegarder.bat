@echo off
rem Sauvegarde de la base et des comptes dans sauvegardes\ (4 dernieres gardees). --photos : aussi les fichiers. --auto : sans pause (tache planifiee).
cd /d "%~dp0"
if not exist node_modules\firebase-admin (
  echo Installation de firebase-admin...
  call npm install --silent || exit /b 1
)
node sauvegarder.js %*
set CODE=%ERRORLEVEL%
echo %* | find "--auto" >nul || pause
exit /b %CODE%
