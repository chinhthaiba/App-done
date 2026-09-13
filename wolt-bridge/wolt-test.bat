@echo off
setlocal
cd /d "%~dp0\.."
echo [Wolt Bridge] Dang doc man hinh Android qua ADB...
node "wolt-bridge\wolt-adb-reader.js" dump
echo.
pause
