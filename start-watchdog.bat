@echo off
chcp 65001 > nul
setlocal

set "APP_DIR=%~dp0"
set "HIDDEN_LAUNCHER=%APP_DIR%run-watchdog-hidden.vbs"

if not exist "%HIDDEN_LAUNCHER%" (
  echo [ThaiAsia] Khong tim thay hidden launcher: %HIDDEN_LAUNCHER%
  exit /b 1
)

start "" /b wscript.exe "%HIDDEN_LAUNCHER%"
exit /b 0
