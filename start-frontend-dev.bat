@echo off
setlocal
cd /d "%~dp0frontend"
if errorlevel 1 goto nodir

echo.
echo ============================================
echo   Frontend dev server  [ Vite ]  port 5173
echo ============================================
echo.
echo   Frontend  http://127.0.0.1:5173
echo   Backend   http://127.0.0.1:8011
echo.
echo   Both must run: this window for the frontend,
echo   another window (start-django.bat) for the backend.
echo   Editing files under src\ hot-reloads automatically.
echo   Closing this window stops the server.
echo.

call npm run dev
pause
exit /b 0

:nodir
echo [ERROR] Cannot find the "frontend" folder.
echo Put this .bat in the project root and run it again.
pause
exit /b 1
