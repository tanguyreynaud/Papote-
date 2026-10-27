@echo off
rem Commande de bout en bout sur le site en ligne, cartes de test Stripe (voir commande-test.js).
rem   commande-test.bat              : tous les scenarios, verifications puis nettoyage
rem   commande-test.bat --garder     : garde les commandes TEST (pour les voir dans l admin)
rem   commande-test.bat --nettoyer   : supprime les commandes TEST restantes
cd /d "%~dp0"
if not exist node_modules\playwright (
  echo Installation...
  call npm install --silent || exit /b 1
  call npx playwright install chromium || exit /b 1
)
node commande-test.js %*
