@echo off
rem Relit une copie chiffree (.json.enc) et ecrit le .json en clair a cote. Usage : dechiffrer-sauvegarde.bat <fichier.json.enc>
cd /d "%~dp0"
node dechiffrer-sauvegarde.js %*
pause
