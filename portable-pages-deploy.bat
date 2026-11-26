@echo off
setlocal EnableExtensions

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "NODE_DIR=%ROOT%\.portable\node"

if not exist "%NODE_DIR%\node.exe" (
    echo [Error] Portable Node not found in .portable\node. Run portable-start.bat first.
    pause
    exit /b 1
)

set "PATH=%NODE_DIR%;%PATH%"
set "npm_config_cache=%ROOT%\.portable\npm-cache"
cd /d "%ROOT%"

echo [Cloudflare Pages] Checking Wrangler authentication...
"%NODE_DIR%\npx.cmd" wrangler whoami 2>&1 | findstr /i "not authenticated" >nul
if not errorlevel 1 (
    echo.
    echo [Cloudflare Pages] Not logged in yet.
    echo Tip: If browser OAuth fails on localhost:8976, create a Cloudflare API Token
    echo ^(Cloudflare Dashboard ^> My Profile ^> API Tokens ^> Edit Cloudflare Workers / Pages^)
    echo and paste it below, OR press Enter to try browser login again.
    echo.
    set /p "CF_TOKEN=Cloudflare API Token (or press Enter for browser login): "
    if not "%CF_TOKEN%"=="" (
        set "CLOUDFLARE_API_TOKEN=%CF_TOKEN%"
    ) else (
        call "%NODE_DIR%\npx.cmd" wrangler login
        if errorlevel 1 (
            echo [Error] Cloudflare login failed.
            pause
            exit /b 1
        )
    )
)

set "PAGES_PROJECT=aizerkb"
set /p "INPUT_NAME=Cloudflare Pages project name [%PAGES_PROJECT%]: "
if not "%INPUT_NAME%"=="" set "PAGES_PROJECT=%INPUT_NAME%"

echo.
echo [Cloudflare Pages] Deploying public/ + functions/ to project "%PAGES_PROJECT%"...
call "%NODE_DIR%\npx.cmd" wrangler pages deploy public --project-name="%PAGES_PROJECT%"
if errorlevel 1 (
    echo.
    echo [Info] If "%PAGES_PROJECT%" does not exist yet, creating it now...
    call "%NODE_DIR%\npx.cmd" wrangler pages project create "%PAGES_PROJECT%" --production-branch=main
    if not errorlevel 1 (
        call "%NODE_DIR%\npx.cmd" wrangler pages deploy public --project-name="%PAGES_PROJECT%"
    )
)

echo.
echo [Cloudflare Pages] Done!
echo Reminder: Set these in Cloudflare Dashboard ^> Workers ^& Pages ^> %PAGES_PROJECT% ^> Settings ^> Environment variables:
echo   - CF_WORKER_URL
echo   - WORKER_API_KEY
echo   - ADMIN_SECRET
pause
