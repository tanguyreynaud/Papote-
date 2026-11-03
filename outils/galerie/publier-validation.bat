@echo off
rem Espace Validation de l'admin : refait toutes les captures (environ 10 minutes) puis les met en ligne.
rem   publier-validation.bat          : tout (tablette, app famille, site, admin, e-mails)
rem   publier-validation.bat admin    : seulement l admin (les autres parties gardent leurs captures)
rem Les captures vont dans le stockage Firebase, visibles seulement dans admin > Validation (cle admin du PC).
cd /d "%~dp0"
if not exist node_modules\playwright (
  echo Installation de Playwright et de son navigateur, une seule fois...
  call npm install --silent || exit /b 1
  call npx playwright install chromium || exit /b 1
)
rem La galerie finit en erreur dès qu'un souci est trouvé (pour GitHub) : les captures sont publiées quand même,
rem c'est justement là qu'on regarde les soucis.
node galerie.js %*
if errorlevel 1 echo Des soucis ont ete trouves (voir ci-dessus) : les captures sont publiees quand meme.
if not exist ..\admin\node_modules\firebase-admin (
  echo Installation de firebase-admin, une seule fois...
  pushd ..\admin
  call npm install --silent || (popd & exit /b 1)
  popd
)
node publier-validation.mjs
