@echo off
chcp 65001 > nul
setlocal

set "APP_DIR=%~dp0"
cd /d "%APP_DIR%"

set "CURRENT_VERSION=khong ro"
set "SUGGESTED_VERSION="
for /f "delims=" %%V in ('node -p "require('./package.json').version"') do set "CURRENT_VERSION=%%V"
for /f "delims=" %%V in ('node -e "const p=require('./package.json').version.split('.').map(Number); p[2]+=1; console.log(p.join('.'));"') do set "SUGGESTED_VERSION=%%V"

set "UPDATE_VERSION=%~1"
if "%UPDATE_VERSION%"=="" (
  echo [ThaiAsia] Phien ban hien tai: %CURRENT_VERSION%
  set /p "UPDATE_VERSION=Nhap version moi (goi y %SUGGESTED_VERSION%): "
)

if "%UPDATE_VERSION%"=="" (
  echo [ThaiAsia] Chua nhap version.
  exit /b 1
)

echo [ThaiAsia] Kiem tra updater...
node scripts\test-auto-update.js
if errorlevel 1 goto failed
node scripts\test-takeaway-customer-name.js
if errorlevel 1 goto failed

echo [ThaiAsia] Tao goi update v%UPDATE_VERSION%...
node scripts\prepare-update-release.js "%UPDATE_VERSION%"
if errorlevel 1 goto failed

echo [ThaiAsia] Dong bo dist cuc bo...
node scripts\sync-dist-app.js
if errorlevel 1 goto failed

echo [ThaiAsia] Kiem tra chu ky va bundle...
node scripts\test-auto-update.js
if errorlevel 1 goto failed

echo [ThaiAsia] Upload va phat hanh v%UPDATE_VERSION% len GitHub...
echo [ThaiAsia] Sau khi publish thanh cong se tu don release cu tren GitHub va release-output local, giu 3 ban gan nhat.
node scripts\publish-update-release.js "%UPDATE_VERSION%"
if errorlevel 1 goto publish_failed

echo.
echo [ThaiAsia] HOAN TAT. v%UPDATE_VERSION% da duoc phat hanh len GitHub.
exit /b 0

:failed
echo [ThaiAsia] Tao goi update that bai. Khong publish release.
exit /b 1

:publish_failed
echo.
echo [ThaiAsia] Goi update da tao xong nhung upload GitHub that bai.
echo [ThaiAsia] Neu GitHub da tao Release nhap, ban nhap van an toan va app se khong tai.
echo [ThaiAsia] Chay lai cung version de tiep tuc upload:
echo   node scripts\publish-update-release.js "%UPDATE_VERSION%"
exit /b 1
