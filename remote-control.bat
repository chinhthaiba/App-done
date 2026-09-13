@echo off
chcp 65001 > nul
setlocal

title ThaiAsia Remote Control
set "APP_DIR=%~dp0"
cd /d "%APP_DIR%"

node scripts\send-remote-command.js

echo.
pause
