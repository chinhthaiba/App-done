@echo off
chcp 65001 > nul
setlocal EnableDelayedExpansion

title ThaiAsiaWatchdog

set "APP_DIR=%~dp0"
set "DIST=%APP_DIR%dist\ThaiAsiaApp-win32-x64"
set "RES=%DIST%\resources\app"
set "APP_EXE=%DIST%\ThaiAsiaApp.exe"
set "LOG=%DIST%\watchdog-log.txt"
set "STATE_DIR=%DIST%\watchdog-state"
set "STOP_FLAG=%STATE_DIR%\watchdog.stop"
set "LOCK_DIR=%STATE_DIR%\watchdog.lock"
set "HEARTBEAT_FILE=%STATE_DIR%\watchdog.heartbeat"
set "APP_HEARTBEAT=%APPDATA%\ThaiAsiaAllinOne\app.heartbeat"
set "UPDATE_LOCK=%STATE_DIR%\update.lock"
set "RUNTIME_VERSION_FILE=%DIST%\version"
set "EXPECTED_ELECTRON_MAJOR=22"
set "LOCK_HELD=0"

if not exist "%STATE_DIR%" mkdir "%STATE_DIR%" > nul 2>&1

if exist "%LOCK_DIR%" (
  set "APP_RUNNING=0"
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$p='%APP_HEARTBEAT%'; if(Test-Path -LiteralPath $p){$age=((Get-Date)-(Get-Item -LiteralPath $p).LastWriteTime).TotalSeconds; if($age -lt 20){exit 0}}; exit 1" > nul 2>&1
  if not errorlevel 1 set "APP_RUNNING=1"
  if "!APP_RUNNING!"=="1" (
    echo [ThaiAsia] Watchdog da dang chay. Thu dua app len truoc...
    if exist "%APP_EXE%" (
      start "" "%APP_EXE%"
    )
    exit /b 0
  )
  echo [ThaiAsia] Phat hien lock cu. Dang don lock stale...
  taskkill /F /IM ThaiAsiaApp.exe > nul 2>&1
  rd /s /q "%LOCK_DIR%" > nul 2>&1
  if exist "%LOCK_DIR%" (
    echo [ThaiAsia] Khong xoa duoc stale lock. Tiep tuc chay watchdog khong lock.
    echo [%DATE% %TIME%] ERROR stale lock remove failed>> "%LOG%"
  )
)
mkdir "%LOCK_DIR%" > nul 2>&1
if errorlevel 1 (
  echo [ThaiAsia] Khong tao duoc lock watchdog. Tiep tuc chay khong lock.
  echo [%DATE% %TIME%] WARN lock create failed, continue without lock>> "%LOG%"
) else (
  set "LOCK_HELD=1"
)

if exist "%STOP_FLAG%" del /f /q "%STOP_FLAG%" > nul 2>&1

if not exist "%APP_EXE%" (
  echo [ThaiAsia] Khong tim thay file: %APP_EXE%
  echo [%DATE% %TIME%] ERROR missing exe: %APP_EXE%>> "%LOG%"
  rd /s /q "%LOCK_DIR%" > nul 2>&1
  pause
  exit /b 1
)

if not exist "%RUNTIME_VERSION_FILE%" (
  echo [ThaiAsia] Runtime version file not found: %RUNTIME_VERSION_FILE%
  echo [%DATE% %TIME%] ERROR runtime version file missing>> "%LOG%"
) else (
  set /p ELECTRON_RUNTIME_VERSION=<"%RUNTIME_VERSION_FILE%"
  echo [ThaiAsia] Runtime version: !ELECTRON_RUNTIME_VERSION!
  echo [%DATE% %TIME%] Runtime version: !ELECTRON_RUNTIME_VERSION!>> "%LOG%"
  for /f "tokens=1 delims=." %%V in ("!ELECTRON_RUNTIME_VERSION!") do set "RUNTIME_MAJOR=%%V"
  if not "!RUNTIME_MAJOR!"=="%EXPECTED_ELECTRON_MAJOR%" (
    echo [ThaiAsia] WARN: Dist runtime major !RUNTIME_MAJOR! khac %EXPECTED_ELECTRON_MAJOR% (Win7 can Electron 22)
    echo [%DATE% %TIME%] WARN runtime major !RUNTIME_MAJOR! not-eq %EXPECTED_ELECTRON_MAJOR%>> "%LOG%"
  )
)

echo [ThaiAsia] Watchdog dang chay. Dung bang lenh stop-watchdog.bat STOP
echo ========================================================>> "%LOG%"
echo [%DATE% %TIME%] Watchdog started>> "%LOG%"

:loop
if exist "%STOP_FLAG%" goto stop_requested
echo %DATE% %TIME%> "%HEARTBEAT_FILE%"

if exist "%UPDATE_LOCK%" (
  set "UPDATE_ACTIVE=0"
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$p='%UPDATE_LOCK%'; if(Test-Path -LiteralPath $p){$age=((Get-Date)-(Get-Item -LiteralPath $p).LastWriteTime).TotalMinutes; if($age -lt 15){exit 0}}; exit 1" > nul 2>&1
  if not errorlevel 1 set "UPDATE_ACTIVE=1"
  if "!UPDATE_ACTIVE!"=="1" (
    timeout /t 3 /nobreak > nul
    goto :loop
  )
  echo [ThaiAsia] Phat hien update lock cu. Dang xoa lock stale...
  echo [%DATE% %TIME%] WARN stale update lock removed>> "%LOG%"
  del /f /q "%UPDATE_LOCK%" > nul 2>&1
)

set "APP_RUNNING=0"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p='%APP_HEARTBEAT%'; if(Test-Path -LiteralPath $p){$age=((Get-Date)-(Get-Item -LiteralPath $p).LastWriteTime).TotalSeconds; if($age -lt 20){exit 0}}; exit 1" > nul 2>&1
if not errorlevel 1 set "APP_RUNNING=1"
if "!APP_RUNNING!"=="0" (
  echo [ThaiAsia] App dang tat - khoi dong lai...
  echo [%DATE% %TIME%] ThaiAsiaApp.exe not running -^> starting...>> "%LOG%"
  start "" "%APP_EXE%"
  timeout /t 8 /nobreak > nul
  set "APP_RUNNING=0"
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$p='%APP_HEARTBEAT%'; if(Test-Path -LiteralPath $p){$age=((Get-Date)-(Get-Item -LiteralPath $p).LastWriteTime).TotalSeconds; if($age -lt 20){exit 0}}; exit 1" > nul 2>&1
  if not errorlevel 1 set "APP_RUNNING=1"
  if "!APP_RUNNING!"=="0" (
    echo [ThaiAsia] App start fail - chua thay heartbeat trong "%APPDATA%\ThaiAsiaAllinOne\app.heartbeat"
    echo [%DATE% %TIME%] ERROR ThaiAsiaApp.exe started but not detected after 8s>> "%LOG%"
  )
) else (
  timeout /t 3 /nobreak > nul
)
goto :loop

:stop_requested
echo [ThaiAsia] Nhan stop signal. Dang dung watchdog va app...
echo [%DATE% %TIME%] Stop signal received>> "%LOG%"
taskkill /F /IM ThaiAsiaApp.exe > nul 2>&1
del /f /q "%STOP_FLAG%" > nul 2>&1
del /f /q "%HEARTBEAT_FILE%" > nul 2>&1
if "%LOCK_HELD%"=="1" rd /s /q "%LOCK_DIR%" > nul 2>&1
exit /b 0
