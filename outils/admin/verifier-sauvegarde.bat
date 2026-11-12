@echo off
rem Verifie qu'une sauvegarde se restaure vraiment (dans l'emulateur Firestore, rien ne touche la vraie base). Java requis.
rem Utilisation : .\verifier-sauvegarde.bat sauvegardes\papote-<date>
cd /d "%~dp0"
if "%~1"=="" ( echo Usage : verifier-sauvegarde.bat ^<sauvegarde.json^> & pause & exit /b 1 )
if not exist node_modules\firebase-admin (
  echo Installation de firebase-admin...
  call npm install --silent || exit /b 1
)
npx --yes firebase-tools@14 emulators:exec --only firestore --project demo-papote --config emulateur.json "node verifier-sauvegarde.js \"%~f1\""
pause
