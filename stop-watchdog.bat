@echo off
chcp 65001 > nul
setlocal

if /I not "%~1"=="STOP" (
  echo [ThaiAsia] De dung app/watchdog, chay: stop-watchdog.bat STOP
  exit /b 1
)

set "APP_DIR=%~dp0"
set "DIST=%APP_DIR%dist\ThaiAsiaApp-win32-x64"
set "STATE_DIR=%DIST%\watchdog-state"
set "STOP_FLAG=%STATE_DIR%\watchdog.stop"
set "LOCK_DIR=%STATE_DIR%\watchdog.lock"
set "HEARTBEAT_FILE=%STATE_DIR%\watchdog.heartbeat"
set "APP_HEARTBEAT=%APPDATA%\ThaiAsiaAllinOne\app.heartbeat"

if not exist "%STATE_DIR%" mkdir "%STATE_DIR%" > nul 2>&1
echo stop > "%STOP_FLAG%"

taskkill /F /IM ThaiAsiaApp.exe > nul 2>&1
rem Cho watchdog an toi da 4 giay de doc stop flag va thoat sach.
timeout /t 4 /nobreak > nul
rem Fallback cho watchdog cu dang chay voi cua so console hien.
taskkill /F /FI "WINDOWTITLE eq ThaiAsiaWatchdog*" /IM cmd.exe > nul 2>&1

rd /s /q "%LOCK_DIR%" > nul 2>&1
del /f /q "%HEARTBEAT_FILE%" > nul 2>&1
del /f /q "%APP_HEARTBEAT%" > nul 2>&1

echo [ThaiAsia] Da dung app va watchdog.
exit /b 0
