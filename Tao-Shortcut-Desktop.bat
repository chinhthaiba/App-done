@echo off
chcp 65001 > nul
setlocal

set "APP_DIR=%~dp0"
set "EXE_PATH=%APP_DIR%ThaiAsiaApp.exe"
set "STOP_VBS=%APP_DIR%Dong-App-An.vbs"
set "ICON_PATH=%APP_DIR%icon.ico"
if not exist "%ICON_PATH%" set "ICON_PATH=%EXE_PATH%"
set "WSCRIPT_EXE=%SystemRoot%\System32\wscript.exe"

echo ============================================================
echo      THAIASIA - TAO SHORTCUT RA MAN HINH CHINH (DESKTOP)
echo ============================================================
echo.

powershell -NoProfile -Command "$ws = New-Object -ComObject WScript.Shell; $desktop = [Environment]::GetFolderPath('Desktop'); $scOpen = $ws.CreateShortcut((Join-Path $desktop 'ThaiAsia App.lnk')); $scOpen.TargetPath = '%EXE_PATH%'; $scOpen.WorkingDirectory = '%APP_DIR%'; $scOpen.IconLocation = '%ICON_PATH%,0'; $scOpen.Description = 'ThaiAsia Restaurant Management App'; $scOpen.Save(); $scStop = $ws.CreateShortcut((Join-Path $desktop 'ThaiAsia STOP.lnk')); $scStop.TargetPath = '%WSCRIPT_EXE%'; $scStop.Arguments = '\"%STOP_VBS%\"'; $scStop.WorkingDirectory = '%APP_DIR%'; $scStop.IconLocation = '%SystemRoot%\System32\shell32.dll,27'; $scStop.Description = 'Dong ung dung ThaiAsia va tat ca tien trinh'; $scStop.WindowStyle = 7; $scStop.Save();"

echo.
echo [OK] Da tao thanh cong 2 bieu tuong tren Desktop:
echo   1. [ThaiAsia App]   - Mo ung dung
echo   2. [ThaiAsia STOP]  - Dong ung dung sach se (Icon Dau X Do)
echo.
pause

