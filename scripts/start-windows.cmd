@echo off
rem Starts Forge Neo Client from this checkout without pnpm: builds the current code (a few seconds),
rem then opens the app. If the build fails, the last good build is started.
rem Make a desktop shortcut to this file to start the app with a double click.
cd /d "%~dp0.." || (echo Project folder not found. & pause & exit /b 1)

if not exist "node_modules\.bin\electron-vite.cmd" (
  echo Dependencies are missing. Run "pnpm install" in this folder first.
  pause
  exit /b 1
)

echo Building Forge Neo Client...
call "node_modules\.bin\electron-vite.cmd" build >"%TEMP%\forge-neo-client-build.log" 2>&1
if errorlevel 1 (
  echo Build failed - starting the last good build. Details: %TEMP%\forge-neo-client-build.log
  timeout /t 3 >nul
)

if not exist "out\main\index.js" (echo No build to start. See %TEMP%\forge-neo-client-build.log & pause & exit /b 1)
start "" "node_modules\electron\dist\electron.exe" .
