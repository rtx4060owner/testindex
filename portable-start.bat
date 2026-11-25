@echo off
setlocal EnableExtensions

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

set "PORTABLE_DIR=%ROOT%\.portable"
set "NODE_DIR=%PORTABLE_DIR%\node"
set "NODE_VER=v24.22.3"
set "NODE_ZIP_NAME=node-%NODE_VER%-win-x64.zip"
set "NODE_URL=https://nodejs.org/dist/%NODE_VER%/%NODE_ZIP_NAME%"
set "NODE_ZIP=%PORTABLE_DIR%\%NODE_ZIP_NAME%"

if not exist "%PORTABLE_DIR%" mkdir "%PORTABLE_DIR%"

if not exist "%NODE_DIR%\node.exe" (
    echo [Portable Setup] Downloading Node.js %NODE_VER% ^(win-x64 zip^)...
    curl.exe -fL "%NODE_URL%" -o "%NODE_ZIP%"
    if errorlevel 1 (
        echo [Error] Failed to download Node.js from %NODE_URL%
        pause
        exit /b 1
    )

    echo [Portable Setup] Extracting Node.js into .portable\node...
    tar.exe -xf "%NODE_ZIP%" -C "%PORTABLE_DIR%"
    if errorlevel 1 (
        echo [Error] Failed to extract %NODE_ZIP%
        pause
        exit /b 1
    )

    if exist "%NODE_DIR%" rmdir /s /q "%NODE_DIR%"
    move "%PORTABLE_DIR%\node-%NODE_VER%-win-x64" "%NODE_DIR%" >nul
    del /f /q "%NODE_ZIP%" >nul 2>&1
)

rem Scope PATH and all caches strictly to this process and .portable\
set "PATH=%NODE_DIR%;%PATH%"
set "npm_config_cache=%PORTABLE_DIR%\npm-cache"
set "npm_config_update_notifier=false"
set "HF_HOME=%PORTABLE_DIR%\hf-cache"
set "TRANSFORMERS_CACHE=%PORTABLE_DIR%\hf-cache"
set "XDG_CACHE_HOME=%PORTABLE_DIR%\hf-cache"

cd /d "%ROOT%"

if not exist "%ROOT%\node_modules" (
    echo [Portable Setup] Installing npm dependencies...
    if exist "%ROOT%\package-lock.json" (
        call "%NODE_DIR%\npm.cmd" ci
    ) else (
        call "%NODE_DIR%\npm.cmd" install
    )
    if errorlevel 1 (
        echo [Error] npm install failed.
        pause
        exit /b 1
    )
)

echo [Portable Start] Starting app on http://localhost:8000 ...
call "%NODE_DIR%\npm.cmd" start
