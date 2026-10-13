@echo off
rem Range les clés de l'intégration Sendcloud « Papote étiquettes » dans Firebase (secret SENDCLOUD_API),
rem pour créer les étiquettes Mondial Relay d'envoi et de retour depuis l'espace admin.
cd /d "%~dp0"
node installer-sendcloud.js %*
pause
