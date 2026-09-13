@echo off
chcp 65001 > nul
setlocal

title ThaiAsia Live Report Sync
set "APP_DIR=%~dp0"
cd /d "%APP_DIR%"

echo ============================================================
echo      THAIASIA - DONG BO BAO CAO 24H LIVE VE MAY CHINH
echo ============================================================
echo.
echo Che do:
echo   [1] Dong bo LIVE lien tuc (Tu dong cap nhat moi 60 giay)
echo   [2] Dong bo 1 lan duy nhat roi mo file bao cao
echo   [3] Go bo thong tin mot may test khoi Live Report
echo.
set /p "CHOICE=Nhap lua chon cua ban [1, 2 hoac 3, mac dinh 1]: "

if "%CHOICE%"=="3" (
  echo.
  set "THAIASIA_REMOVE_MACHINE="
  set /p "THAIASIA_REMOVE_MACHINE=Nhap ten may can go bo, vi du Nhung-Beo: "
  echo.
  node scripts\remove-live-machine.js
  set "THAIASIA_REMOVE_MACHINE="
  pause
  exit /b 0
)

if "%CHOICE%"=="2" (
  echo.
  echo [ThaiAsia] Dang lay bao cao tu GitHub...
  node scripts\pull-live-reports.js
  if exist "%APP_DIR%reports\status\ThaiAsia-trang-thai-may.txt" (
    start "" notepad "%APP_DIR%reports\status\ThaiAsia-trang-thai-may.txt"
  )
  pause
  exit /b 0
)

echo.
echo [ThaiAsia] Dang bat che do Live Sync...
node scripts\pull-live-reports.js --watch
pause
