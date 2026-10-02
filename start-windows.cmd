@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.6 or later is required. Install Node.js and retry.
  echo For the offline HTML-grid preview, open preview\index.html instead.
  pause
  exit /b 1
)
node scripts\start.mjs
if errorlevel 1 pause
