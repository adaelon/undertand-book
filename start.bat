@echo off
setlocal
title understand-book

rem ============================================================
rem  understand-book launcher (packaged S10e mode).
rem  Starts one localhost server: packaged Vue SPA + REST API on the same port.
rem  Usage:  start.bat [book_dir]
rem  Default book_dir = .understand-book\game-programming-patterns
rem  Default URL      = http://127.0.0.1:8787
rem ============================================================

cd /d "%~dp0"

set "BOOK=%~1"
if "%BOOK%"=="" set "BOOK=.understand-book\game-programming-patterns"

if "%UNDERSTAND_BOOK_ADDR%"=="" set "UNDERSTAND_BOOK_ADDR=127.0.0.1:8787"
if "%UNDERSTAND_BOOK_WEB_DIST%"=="" set "UNDERSTAND_BOOK_WEB_DIST=%CD%\packages\web\dist"
set "URL=http://%UNDERSTAND_BOOK_ADDR%"

where cargo >nul 2>nul
if errorlevel 1 (
  echo [ERROR] cargo not found on PATH. Install Rust ^(rustup^) first.
  pause
  exit /b 1
)

if not exist "%BOOK%\base.json" (
  echo [ERROR] book dir missing base.json: %BOOK%
  echo         Available built books under .understand-book:
  dir /b /ad ".understand-book" 2>nul
  echo         ^(if empty, run /understand-book:build to build one^)
  echo.
  echo Usage: start.bat [book_dir]
  pause
  exit /b 1
)

if not exist "%UNDERSTAND_BOOK_WEB_DIST%\index.html" (
  echo [INFO] packaged web dist not found: %UNDERSTAND_BOOK_WEB_DIST%
  echo [INFO] building packages\web now...
  where pnpm >nul 2>nul
  if errorlevel 1 (
    echo [ERROR] pnpm not found on PATH, and packages\web\dist is missing.
    echo         Install pnpm / Node or run pnpm -C packages\web build on a machine that has it.
    pause
    exit /b 1
  )
  call pnpm -C packages\web build
  if errorlevel 1 (
    echo [ERROR] web build failed.
    pause
    exit /b 1
  )
)

if not exist "%UNDERSTAND_BOOK_WEB_DIST%\index.html" (
  echo [ERROR] web dist still missing index.html: %UNDERSTAND_BOOK_WEB_DIST%
  pause
  exit /b 1
)

if not exist ".env" (
  echo [WARN] .env not found - book.query / agent will return PROVIDER_ERROR.
  echo        Reading / scroll / highlight still work without it.
  echo.
)

echo Starting understand-book packaged reader
echo   book = %BOOK%
echo   web  = %UNDERSTAND_BOOK_WEB_DIST%
echo   url  = %URL%
echo.
echo Close the server window to stop understand-book.

start "understand-book server" cmd /k cargo run -p server -- "%BOOK%"
timeout /t 2 /nobreak >nul
start "" "%URL%"

endlocal