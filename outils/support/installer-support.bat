@echo off
rem Range la clé Anthropic du chat de support de Papote dans Firebase (secret ANTHROPIC_API_KEY).
rem Créez d'abord la clé sur https://console.anthropic.com/settings/keys (après avoir ajouté un peu de crédit).
cd /d "%~dp0"
node installer-support.js %*
pause
