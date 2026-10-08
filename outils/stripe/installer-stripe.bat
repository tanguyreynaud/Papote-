@echo off
rem Prépare Stripe pour Papote : tarifs, portail client, webhook, et clés dans Firebase.
rem   installer-stripe.bat           : demande la clé secrète Stripe (sk_test_... ou sk_live_...)
rem Sans danger à relancer : les tarifs existants sont gardés, le webhook est recréé.
cd /d "%~dp0"
if not exist node_modules\stripe (
  echo Installation de stripe...
  call npm install --silent || exit /b 1
)
node installer-stripe.js %*
pause
