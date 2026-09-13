@echo off
setlocal
cd /d "%~dp0\.."
node "wolt-bridge\wolt-adb-reader.js" devices
echo.
pause
