@echo off
chcp 65001 > nul
setlocal

set "APP_DIR=%~dp0"
set "DIST=%APP_DIR%dist\ThaiAsiaApp-win32-x64"

echo [ThaiAsia] Khoi dong app...
start "" "%DIST%\ThaiAsiaApp.exe"
