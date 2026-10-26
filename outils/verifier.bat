@echo off
rem Verifie tout avant une publication (tests, regles, galerie). Voir verifier.ps1.
rem   verifier.bat            : tout
rem   verifier.bat fonctions  : avant de publier les fonctions
rem   verifier.bat site       : avant de publier l app famille et les regles
rem   verifier.bat tablette   : avant de publier une version de la tablette
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0verifier.ps1" %*
exit /b %errorlevel%
