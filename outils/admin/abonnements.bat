@echo off
rem Abonnements des familles.
rem   abonnements.bat                    : liste les familles et leur abonnement
rem   abonnements.bat offert "Mamie"     : famille offerte, jamais suspendue (nom ou identifiant)
rem   abonnements.bat aucun "Test"       : retire l'accès gratuit (la famille devra s'abonner)
rem   abonnements.bat rendue client@mail : tablette incluse revenue, pas de pénalité de 120 €
cd /d "%~dp0"
if not exist node_modules\firebase-admin (
  echo Installation de firebase-admin...
  call npm install --silent || exit /b 1
)
node abonnements.js %*
pause
