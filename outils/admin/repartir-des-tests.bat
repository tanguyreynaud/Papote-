@echo off
rem Remise a zero des essais avant la mise en vente (voir repartir-des-tests.js).
rem   repartir-des-tests.bat                 : montre ce qui serait efface, ne change rien
rem   repartir-des-tests.bat ... --oui       : le fait (IRREVERSIBLE, sauvegarde JSON avant)
cd /d "%~dp0"
if not exist node_modules\firebase-admin (
  echo Installation de firebase-admin...
  call npm install --silent || exit /b 1
)
node repartir-des-tests.js %*
pause
