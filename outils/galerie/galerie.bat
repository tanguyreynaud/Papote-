@echo off
rem Galerie de tous les ecrans (tablette, app famille, site, admin), avec de fausses donnees.
rem   galerie.bat            : tout, depuis les branches publiees
rem   galerie.bat tablette   : seulement la tablette
rem   galerie.bat famille    : seulement l app famille (aussi : vitrine, admin, emails)
rem Rien n est envoye sur Firebase. Resultat : sortie\galerie.html (ouvert a la fin).
cd /d "%~dp0"
if not exist node_modules\playwright (
  echo Installation de Playwright et de son navigateur, une seule fois...
  call npm install --silent || exit /b 1
  call npx playwright install chromium || exit /b 1
)
node galerie.js %*
if exist sortie\galerie.html start "" sortie\galerie.html
pause
