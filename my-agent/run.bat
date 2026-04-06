@echo off
cd /d "%~dp0"
echo Initializing package.json if not present...
if not exist package.json (
    call npm init -y
    if %errorlevel% neq 0 (
        echo.
        echo npm init failed!
        pause
        exit /b 1
    )
)
echo Installing dependencies...
call npm install express
if %errorlevel% neq 0 (
    echo.
    echo npm install failed!
    pause
    exit /b 1
)
echo.
echo Starting server...
node server.js
if %errorlevel% neq 0 (
    echo.
    echo Server exited with an error.
    pause
)
