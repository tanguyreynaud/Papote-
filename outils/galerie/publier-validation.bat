@echo off
rem Espace Validation de l'admin : refait toutes les captures (environ 10 minutes) puis les met en ligne.
rem   publier-validation.bat          : tout (tablette, app famille, site, admin, e-mails)
rem   publier-validation.bat admin    : seulement l admin (les autres parties gardent leurs captures)
rem Les captures vont sur le site Firebase papote-validation (gratuit), visibles dans admin > Validation.
cd /d "%~dp0"
if not exist node_modules\playwright (
  echo Installation de Playwright et de son navigateur, une seule fois...
  call npm install --silent || exit /b 1
  call npx playwright install chromium || exit /b 1
)
node galerie.js %* || exit /b 1
node publier-validation.mjs
