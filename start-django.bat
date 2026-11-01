@echo off
REM ---------------------------------------------------------------
REM  Start the Django development server (port 8011)
REM  Double-click this file, then KEEP THE WINDOW OPEN.
REM  Stop the server with Ctrl + C.
REM ---------------------------------------------------------------
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo [ERROR] .venv not found in this folder.
    echo         Create it first:
    echo             python -m venv .venv
    pause
    exit /b 1
)

echo ==========================================================
echo   Cipher Analysis Platform  -  Django dev server
echo   URL  : http://127.0.0.1:8011/
echo   Stop : Ctrl + C
echo ==========================================================
echo.

".venv\Scripts\python.exe" manage.py runserver 127.0.0.1:8011

echo.
echo [server stopped]
pause
