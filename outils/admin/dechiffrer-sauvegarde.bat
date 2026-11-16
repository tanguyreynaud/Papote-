@echo off
rem Remet en clair une copie chiffree (dossier papote-date ou fichiers, ancien .json.enc). Usage : dechiffrer-sauvegarde.bat <dossier ou fichier> [destination]
cd /d "%~dp0"
node dechiffrer-sauvegarde.js %*
pause
