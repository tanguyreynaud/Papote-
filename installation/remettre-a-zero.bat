@echo off
rem Double-cliquer pour remettre la tablette branchée en USB à l'état usine (retour au fournisseur).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0remettre-a-zero.ps1" %*
