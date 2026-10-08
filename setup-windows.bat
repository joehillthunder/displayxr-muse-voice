@echo off
rem One-command setup for the Windows PC with the 3D display: bridge + display page.
rem
rem   setup-windows.bat              install, configure, start the bridge, open the display
rem   setup-windows.bat -NoBrowser   same, without opening a browser
rem   setup-windows.bat -NoStart     install and configure only
rem
rem Run it as administrator once if you want it to add the firewall rule that lets the
rem Raspberry Pi reach the bridge (Private networks only). Everything else runs as you.

setlocal EnableExtensions
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  if exist "%ProgramFiles%\nodejs\node.exe" (
    set "PATH=%ProgramFiles%\nodejs;%PATH%"
  ) else (
    where winget >nul 2>&1
    if errorlevel 1 (
      echo Node.js is not installed and winget is not available.
      echo Install Node.js LTS from https://nodejs.org and run this again.
      exit /b 1
    )
    echo ==^> Installing Node.js LTS with winget
    winget install --id OpenJS.NodeJS.LTS -e --silent --accept-source-agreements --accept-package-agreements
    if errorlevel 1 (
      echo winget could not install Node.js. Install it from https://nodejs.org and run this again.
      exit /b 1
    )
    set "PATH=%ProgramFiles%\nodejs;%PATH%"
  )
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\setup-windows.ps1" %*
exit /b %errorlevel%
