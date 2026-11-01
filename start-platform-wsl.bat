@echo off
REM ---------------------------------------------------------------
REM  Start the platform WITH the backend search feature enabled.
REM
REM  Django runs INSIDE WSL, not on Windows. Two reasons:
REM    - the backend search needs BCA_Light, whose bca/solver.py calls
REM      libc PR_SET_PDEATHSIG through ctypes (Linux only) and whose
REM      SAT solver (kissat) is an ELF binary;
REM    - keeping Django in the same system turns that call into a plain
REM      local subprocess instead of crossing the wsl.exe boundary.
REM
REM  The source code is NOT duplicated. WSL reads this very folder
REM  through /mnt/c, so the frontend build under static\dist is reused
REM  as-is and Node is not needed inside WSL.
REM
REM  Double-click this file, then KEEP THE WINDOW OPEN.
REM  Stop the server with Ctrl + C.
REM  All details (environment checks, URLs, fallback address) are
REM  printed by scripts/wsl-server.sh on the Linux side.
REM ---------------------------------------------------------------
setlocal enabledelayedexpansion

set "DISTRO=Ubuntu-24.04"
set "WSLUSER=kiwi"

REM Switch the console to UTF-8 so the Chinese output coming from the
REM Linux side renders correctly. Harmless if the console ignores it.
chcp 65001 >nul 2>&1

REM wsl.exe inherits the current Windows directory and maps it to the
REM matching /mnt/c path -- so this file needs no path translation and
REM can stay pure ASCII even though the folder name is not.
cd /d "%~dp0"

where wsl.exe >nul 2>&1
if errorlevel 1 (
    echo.
    echo [ERROR] wsl.exe not found. Install WSL first:
    echo             wsl --install -d %DISTRO%
    echo.
    pause
    exit /b 1
)

REM ---------------------------------------------------------------
REM Port guard (Windows side).
REM
REM The Linux side binds 0.0.0.0:8011 inside WSL and relies on WSL2's
REM transparent localhost forwarding. That forwarding DOES show up on the
REM Windows side, as a LISTENING socket owned by wslrelay.exe -- so an
REM occupied 8011 has two very different meanings:
REM
REM   owner is wslrelay.exe / wslhost.exe
REM       - the WSL backend is ALREADY running. Nothing is broken; just
REM         open the browser. A second instance could not bind anyway.
REM
REM   owner is anything else (typically python.exe)
REM       - a genuine WINDOWS-side shadow. Windows wins the address, the
REM         browser reaches that process instead, and the backend search
REM         page keeps reporting "needs_linux" even though WSL is
REM         perfectly healthy. Completely silent, so refuse to start
REM         rather than hand the user a phantom.
REM ---------------------------------------------------------------
set "PORT=8011"
set "OWNERPID="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /C:":%PORT% " ^| findstr /C:"LISTENING"') do (
    if not defined OWNERPID set "OWNERPID=%%P"
)

if defined OWNERPID (
    set "ISRELAY=0"
    tasklist /FI "PID eq !OWNERPID!" /NH 2>nul | findstr /I /C:"wslrelay" /C:"wslhost" >nul 2>&1 && set "ISRELAY=1"
    if "!ISRELAY!"=="1" (
        echo.
        echo [INFO] Port %PORT% is already served by WSL.
        echo        The listener found above is WSL2's own localhost relay,
        echo        so the backend looks like it is ALREADY RUNNING.
        echo.
        echo        Just open:  http://127.0.0.1:8011/
        echo        Close this window. To stop the server, press Ctrl + C
        echo        in the window that is already running it.
        echo.
        pause
        exit /b 0
    )
    echo.
    echo [ERROR] Port %PORT% is held by a WINDOWS-side process ^(PID !OWNERPID!^).
    echo.
    echo         It SHADOWS the WSL server: Windows wins the address, your
    echo         browser reaches that process instead, and the backend
    echo         search page keeps reporting "needs_linux" even though WSL
    echo         itself is perfectly healthy.
    echo.
    echo         Usual culprit: a leftover "manage.py runserver" on Windows.
    echo.
    echo         See who holds it:
    echo             netstat -ano ^| findstr :%PORT%
    echo         Stop that PID:
    echo             taskkill /PID !OWNERPID! /F
    echo.
    pause
    exit /b 1
)

echo.
echo   Starting Django inside WSL (%DISTRO%)...
echo   If WSL is not running yet this takes a few seconds.
echo.

wsl.exe -d %DISTRO% -u %WSLUSER% -- bash -c "bash scripts/wsl-server.sh"
set "RC=%ERRORLEVEL%"

REM Nothing is echoed after this point on purpose. When stdout is redirected,
REM cmd.exe and wsl.exe each keep their own file position, so a late write from
REM cmd overwrites the diagnostics the Linux side just printed. The Linux side
REM owns all of that output, including the "server stopped" line.
REM `pause` still waits for a key; only its prompt is silenced.
pause >nul
exit /b %RC%
