@echo off
setlocal
title Rex - Build

echo ============================================
echo   Rex - Windows build
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on this PC.
  echo.
  echo Install it first - it's free, takes about 30 seconds:
  echo   https://nodejs.org  (choose the LTS version, click through the installer)
  echo Then run this file again.
  echo.
  pause
  exit /b 1
)

echo Found Node.js:
node -v
echo.

echo [1/2] Installing dependencies (first run only - about 1-2 minutes)...
call npm install
if errorlevel 1 (
  echo.
  echo npm install failed - see the errors above.
  pause
  exit /b 1
)

echo.
echo [2/2] Building Rex.exe ...
call npm run dist
if errorlevel 1 (
  echo.
  echo Build failed - see the errors above.
  pause
  exit /b 1
)

echo.
echo ============================================
echo   Done! Find Rex.exe inside the "dist" folder.
echo   Double-click it to run Rex - no install needed.
echo ============================================
echo.
pause
