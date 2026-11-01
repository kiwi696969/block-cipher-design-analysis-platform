@echo off
REM ---------------------------------------------------------------
REM  Activate this project's virtual environment (.venv)
REM  Double-click -> opens a new cmd window with the venv activated
REM ---------------------------------------------------------------
setlocal
set "VENV=%~dp0.venv"

if not exist "%VENV%\Scripts\activate.bat" (
    echo [ERROR] venv not found at "%VENV%"
    echo Create it with:
    echo     python -m venv "%VENV%"
    pause
    exit /b 1
)

cmd /k ""%VENV%\Scripts\activate.bat""
endlocal
