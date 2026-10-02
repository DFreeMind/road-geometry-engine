@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch.ps1" %*
set "launch_exit_code=%errorlevel%"
if not "%launch_exit_code%"=="0" pause
exit /b %launch_exit_code%

