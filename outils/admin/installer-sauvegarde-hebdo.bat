@echo off
rem Installe la sauvegarde automatique hebdomadaire (dimanche 3 h). Argument : dossier de destination (ou -Retirer).
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer-sauvegarde-hebdo.ps1" %*
pause
