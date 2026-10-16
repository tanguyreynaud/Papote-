@echo off
rem Double-cliquer pour installer Papote sur la tablette branchée en USB.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer-tablette.ps1" %*
