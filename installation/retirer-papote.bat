@echo off
rem Retire le mode kiosque puis désinstalle Papote de la tablette branchée en USB.
chcp 65001 >nul
echo Retrait du mode kiosque...
adb shell am start -n com.papote.tablette/.MainActivity --ez remove_owner true
timeout /t 3 /nobreak >nul
echo Désinstallation...
adb uninstall com.papote.tablette
echo.
echo Terminé. La tablette est revenue à la normale.
pause
