@echo off
rem Range le mot de passe de la boîte contact@mapapote.fr (OVH) dans Firebase (secret FACTURES_MOT_DE_PASSE),
rem pour que les factures envoyées à factures@mapapote.fr soient lues et rangées automatiquement.
cd /d "%~dp0"
node installer-factures.js %*
pause
