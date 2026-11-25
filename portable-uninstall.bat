@echo off
setlocal EnableExtensions

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

echo [Portable Cleanup] Stopping any node.exe running from this folder...
powershell -NoProfile -Command "Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '%ROOT%\*' } | Stop-Process -Force" >nul 2>&1

if exist "%ROOT%\.portable" (
    echo [Portable Cleanup] Removing .portable\ ...
    rmdir /s /q "%ROOT%\.portable"
)

if exist "%ROOT%\node_modules" (
    echo [Portable Cleanup] Removing node_modules\ ...
    rmdir /s /q "%ROOT%\node_modules"
)

echo [Portable Cleanup] Done. Everything installed by portable-start.bat has been removed.
pause
