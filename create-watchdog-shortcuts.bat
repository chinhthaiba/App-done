@echo off
chcp 65001 > nul
setlocal

set "APP_DIR=%~dp0"
set "HIDDEN_WATCHDOG=%APP_DIR%run-watchdog-hidden.vbs"
set "HIDDEN_STOP=%APP_DIR%stop-watchdog-hidden.vbs"
set "ICO=%APP_DIR%icon.ico"
set "WSCRIPT_EXE=%SystemRoot%\System32\wscript.exe"
set "LNK=%USERPROFILE%\Desktop\ThaiAsia AllInOne.lnk"
set "LNK_STOP=%USERPROFILE%\Desktop\ThaiAsia STOP AllInOne.lnk"

powershell -NoProfile -Command ^
  "$ws = New-Object -ComObject WScript.Shell; " ^
  "$sc = $ws.CreateShortcut('%LNK%'); " ^
  "$sc.TargetPath = '%WSCRIPT_EXE%'; " ^
  "$sc.Arguments = [char]34 + '%HIDDEN_WATCHDOG%' + [char]34; " ^
  "$sc.IconLocation = '%ICO%'; " ^
  "$sc.WorkingDirectory = '%APP_DIR%'; " ^
  "$sc.Description = 'ThaiAsia All In One - Auto Watchdog'; " ^
  "$sc.WindowStyle = 7; " ^
  "$sc.Save(); " ^
  "$sc2 = $ws.CreateShortcut('%LNK_STOP%'); " ^
  "$sc2.TargetPath = '%WSCRIPT_EXE%'; " ^
  "$sc2.Arguments = [char]34 + '%HIDDEN_STOP%' + [char]34; " ^
  "$sc2.IconLocation = '%ICO%'; " ^
  "$sc2.WorkingDirectory = '%APP_DIR%'; " ^
  "$sc2.Description = 'Stop ThaiAsia watchdog + app'; " ^
  "$sc2.WindowStyle = 7; " ^
  "$sc2.Save()"

echo [ThaiAsia] Da tao/cap nhat:
echo   - ThaiAsia AllInOne
echo   - ThaiAsia STOP AllInOne
pause
