@echo off
rem Range le mot de passe d'envoi des e-mails de Papote dans Firebase (secret MAIL_MOT_DE_PASSE).
rem Gmail : créez d'abord un mot de passe d'application sur https://myaccount.google.com/apppasswords
cd /d "%~dp0"
node installer-mail.js %*
pause
