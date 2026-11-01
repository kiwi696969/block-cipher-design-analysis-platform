@echo off
setlocal
cd /d "%~dp0frontend"
if errorlevel 1 goto nodir

echo.
echo ============================================
echo   Build frontend  [ Vue + Vite ]
echo ============================================
echo.

call npm run build
if errorlevel 1 goto buildfail

echo.
echo Build finished. Output written to static\dist\
echo Reload http://127.0.0.1:8011/ to see the changes.
echo.
pause
exit /b 0

:nodir
echo [ERROR] Cannot find the "frontend" folder.
echo Put this .bat in the project root and run it again.
pause
exit /b 1

:buildfail
echo.
echo [ERROR] Build failed. See the output above.
echo Common cause: "npm install" has never been run in frontend\.
pause
exit /b 1
