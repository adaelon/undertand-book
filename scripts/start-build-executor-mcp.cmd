@echo off
setlocal

set "BUILD_EXECUTOR_BIN=%UNDERSTAND_BOOK_BUILD_EXE%"
if defined BUILD_EXECUTOR_BIN goto run

for /f "tokens=2,*" %%A in ('reg.exe query "HKCU\Software\UnderstandBook" /v InstallDir 2^>nul') do (
  if /i "%%A"=="REG_SZ" set "BUILD_EXECUTOR_BIN=%%B\understand-book-build.exe"
)

:run
if not defined BUILD_EXECUTOR_BIN goto unavailable
if not exist "%BUILD_EXECUTOR_BIN%" goto unavailable

"%BUILD_EXECUTOR_BIN%" executor.mcp --bootstrap-version automatic_build_executor_bootstrap.v3 --protocol-generation automatic_build_executor_session.v3
exit /b %ERRORLEVEL%

:unavailable
1>&2 echo Understand Book Build Executor MCP is unavailable. Install Understand Book Setup or set UNDERSTAND_BOOK_BUILD_EXE.
exit /b 2
