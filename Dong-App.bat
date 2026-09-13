@echo off
chcp 65001 > nul
setlocal

set "APP_DIR=%~dp0"
set "STATE_DIR=%APP_DIR%watchdog-state"
set "STOP_FLAG=%STATE_DIR%\watchdog.stop"
set "LOCK_DIR=%STATE_DIR%\watchdog.lock"
set "HEARTBEAT_FILE=%STATE_DIR%\watchdog.heartbeat"
set "APP_HEARTBEAT=%APPDATA%\ThaiAsiaAllinOne\app.heartbeat"

if not exist "%STATE_DIR%" mkdir "%STATE_DIR%" > nul 2>&1
echo stop > "%STOP_FLAG%"

taskkill /F /IM ThaiAsiaApp.exe > nul 2>&1
taskkill /F /IM electron.exe > nul 2>&1
taskkill /F /FI "WINDOWTITLE eq ThaiAsiaWatchdog*" /IM cmd.exe > nul 2>&1

rd /s /q "%LOCK_DIR%" > nul 2>&1
del /f /q "%HEARTBEAT_FILE%" > nul 2>&1
del /f /q "%APP_HEARTBEAT%" > nul 2>&1

exit /b 0
