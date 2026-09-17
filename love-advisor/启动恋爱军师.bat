@echo off
setlocal EnableExtensions

cd /d "%~dp0"
title HeartTrace

set "NODE_EXE=%~dp0runtime\node.exe"

if not exist "%NODE_EXE%" goto :runtime_missing

if not exist "node_modules\express\package.json" goto :dependencies_missing

echo.
echo [HeartTrace] Starting... Your browser will open automatically.
"%NODE_EXE%" bin\cli.js
set "exit_code=%errorlevel%"
echo.
echo [HeartTrace] Service stopped.
pause
exit /b %exit_code%

:runtime_missing
echo.
echo [HeartTrace] The bundled runtime is missing or incomplete.
echo Please download and extract the complete Release ZIP again.
pause
exit /b 1

:dependencies_missing
echo.
echo [HeartTrace] Bundled components are missing or incomplete.
echo Please download and extract the complete Release ZIP again.
pause
exit /b 1
