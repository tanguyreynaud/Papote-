@echo off
chcp 65001 >nul
rem Passage de tous les ecrans sur la tablette branchee (fausse famille, rien n est envoye).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0passage-ecrans.ps1" %*
pause
