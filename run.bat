@echo off
setlocal
rem ---------------------------------------------------------------------------
rem  Twin-Brain - start the local backend on Windows.
rem  First run: creates .venv and installs requirements (needs internet once).
rem  Then:      starts the server on http://127.0.0.1:8765  (token is printed)
rem  Keep this window open while you use Twin-Brain.
rem ---------------------------------------------------------------------------
cd /d "%~dp0"
title Twin-Brain backend

set "VPY=.venv\Scripts\python.exe"

if exist "%VPY%" goto start

echo [Twin-Brain] First run: creating a virtual environment...
call :try_venv py -3
if not exist "%VPY%" call :try_venv python
if not exist "%VPY%" call :try_venv python3
if not exist "%VPY%" goto no_python

:start
"%VPY%" -c "import flask" >nul 2>nul
if errorlevel 1 (
  echo [Twin-Brain] Installing requirements into .venv ...
  "%VPY%" -m pip install -r requirements.txt
  "%VPY%" -c "import flask" >nul 2>nul
  if errorlevel 1 (
    echo.
    echo [Twin-Brain] ERROR: Flask could not be installed into .venv.
    echo                Check your internet connection and run run.bat again.
    echo                (If it keeps failing, delete the .venv folder and retry.)
    pause
    exit /b 1
  )
)

echo [Twin-Brain] Starting the backend. Keep this window open.
echo.
"%VPY%" -m server.app %*
set "RC=%ERRORLEVEL%"
echo.
echo [Twin-Brain] The server stopped (exit code %RC%).
echo                If the port was already in use, close the other Twin-Brain
echo                window first, or set TWINBRAIN_PORT=8766 and run again.
pause
exit /b %RC%

rem ---------------------------------------------------------------------------
:try_venv
rem   %* = interpreter command to try, e.g. "py -3" or "python"
where %1 >nul 2>nul
if errorlevel 1 exit /b 1
echo [Twin-Brain] Trying interpreter: %*
%* -m venv .venv
if errorlevel 1 exit /b 1
if not exist "%VPY%" exit /b 1
echo [Twin-Brain] Installing requirements (flask, sqlite-vec, numpy)...
"%VPY%" -m pip install --upgrade pip
"%VPY%" -m pip install -r requirements.txt
if errorlevel 1 (
  echo [Twin-Brain] WARNING: pip install reported errors; re-checking at start.
)
exit /b 0

rem ---------------------------------------------------------------------------
:no_python
echo.
echo [Twin-Brain] ERROR: no usable Python interpreter was found.
echo.
echo   1. Install Python 3.9 or newer from  https://www.python.org/downloads/
echo   2. During setup tick "Add python.exe to PATH"
echo   3. Double-click run.bat again
echo.
echo   (If Python is installed but only as "py", that is tried first already.)
pause
exit /b 1
