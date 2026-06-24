@echo off
setlocal
title understand-book

rem ============================================================
rem  understand-book launcher (dev mode).
rem  Starts: backend server (tiny_http :8787) + Vite dev (:5173).
rem  Usage:  start.bat [book_dir]
rem  Default book_dir = .understand-book\game-programming-patterns
rem  Close either window (or Ctrl+C) to stop that process.
rem ============================================================

cd /d "%~dp0"

set "BOOK=%~1"
if "%BOOK%"=="" set "BOOK=.understand-book\game-programming-patterns"

where cargo >nul 2>nul
if errorlevel 1 (
  echo [ERROR] cargo not found on PATH. Install Rust ^(rustup^) first.
  pause
  exit /b 1
)

where pnpm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] pnpm not found on PATH. Install pnpm / Node first.
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

if not exist ".env" (
  echo [WARN] .env not found - book.query / agent will return PROVIDER_ERROR.
  echo        Reading / scroll / highlight still work without it.
  echo.
)

echo Starting backend server  ^(book = %BOOK%^)  http://127.0.0.1:8787
start "understand-book server" cmd /k cargo run -p server -- "%BOOK%"

echo Starting frontend vite dev  http://localhost:5173  ^(proxy /api -^> :8787^)
call pnpm -C packages\web exec vite --open

echo.
echo Vite stopped. The server window stays open; close it to stop the backend.
pause
endlocal