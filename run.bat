@echo off
rem Twin-Brain — start the local backend on Windows (creates the venv on first run).
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo creating .venv and installing requirements (first run only)...
  python -m venv .venv
  ".venv\Scripts\pip.exe" install --upgrade pip
  ".venv\Scripts\pip.exe" install -r requirements.txt
)

".venv\Scripts\python.exe" -m server.app %*
