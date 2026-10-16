@echo off
rem Vide l'ancienne base (États-Unis) et l'ancien bucket, une fois la bascule en Europe validée.
rem   vider-ancienne-base.bat        : montre ce qui serait effacé
rem   vider-ancienne-base.bat --oui  : efface (IRRÉVERSIBLE), sauf config/base
cd /d "%~dp0"
if not exist node_modules\firebase-admin (
  echo Installation de firebase-admin...
  call npm install --silent || exit /b 1
)
node vider-ancienne-base.js %*
pause
