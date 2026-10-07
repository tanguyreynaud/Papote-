@echo off
rem Supprime les comptes anonymes Firebase qui ne sont membres d'aucune famille.
rem   nettoyer-comptes-anonymes.bat        : affiche ce qui serait supprimé
rem   nettoyer-comptes-anonymes.bat --oui  : supprime
cd /d "%~dp0"
if not exist node_modules\firebase-admin (
  echo Installation de firebase-admin...
  call npm install --silent || exit /b 1
)
node nettoyer-comptes-anonymes.js %*
pause
