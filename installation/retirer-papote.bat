@echo off
rem Retire le mode kiosque, réactive les applis désactivées puis désinstalle Papote
rem de la tablette branchée en USB.
chcp 65001 >nul
echo Retrait de la famille...
adb shell am start -n com.papote.tablette/.MainActivity --ez leave true
timeout /t 5 /nobreak >nul
echo Retrait du mode kiosque...
adb shell am start -n com.papote.tablette/.MainActivity --ez remove_owner true
timeout /t 3 /nobreak >nul
echo Réactivation des applis...
for /f "usebackq eol=# tokens=*" %%p in ("%~dp0applis-inutiles.txt") do adb shell pm enable %%p >nul
adb shell cmd role remove-role-holder android.app.role.CALL_SCREENING com.papote.tablette
echo Désinstallation...
adb uninstall com.papote.tablette
echo.
echo Terminé. La tablette est revenue à la normale.
pause
