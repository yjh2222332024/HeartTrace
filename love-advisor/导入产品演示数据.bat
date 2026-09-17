@echo off
setlocal EnableExtensions

cd /d "%~dp0"
title Import Love Advisor Demo

set "NODE_EXE=%~dp0runtime\node.exe"
set "CHATLAB_CLI=%~dp0node_modules\chatlab-cli\bin\chatlab.mjs"
set "DEMO_FILE=%~dp0examples\恋爱军师-演示聊天记录.json"

if not exist "%NODE_EXE%" goto :runtime_missing
if not exist "%CHATLAB_CLI%" goto :dependencies_missing
if not exist "%DEMO_FILE%" goto :data_missing

echo.
echo [Love Advisor] Importing fictional demo chat data...
"%NODE_EXE%" "%CHATLAB_CLI%" import "%DEMO_FILE%" --format chatlab --session-id love-advisor-demo-lin
if errorlevel 1 goto :import_failed

echo.
echo [Love Advisor] Import complete. Refresh Love Advisor and select 林小雨 from the private chat list.
pause
exit /b 0

:runtime_missing
echo [Love Advisor] The bundled runtime is missing. Please extract the complete Release ZIP again.
pause
exit /b 1

:dependencies_missing
echo [Love Advisor] Bundled components are missing. Please extract the complete Release ZIP again.
pause
exit /b 1

:data_missing
echo [Love Advisor] The demo data file is missing. Please extract the complete Release ZIP again.
pause
exit /b 1

:import_failed
echo [Love Advisor] Import failed. Check the error above, then run this file again.
pause
exit /b 1
