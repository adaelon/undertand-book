@echo off
setlocal

set "BOOK_MCP_BIN=%UNDERSTAND_BOOK_MCP_BIN%"
if defined BOOK_MCP_BIN goto run

for /f "tokens=2,*" %%A in ('reg.exe query "HKCU\Software\UnderstandBook" /v InstallDir 2^>nul') do (
  if /i "%%A"=="REG_SZ" set "BOOK_MCP_BIN=%%B\book-mcp.exe"
)

:run
if not defined BOOK_MCP_BIN (
  echo Understand Book MCP is unavailable: install Understand Book Setup or set UNDERSTAND_BOOK_MCP_BIN. 1>&2
  exit /b 2
)
if not exist "%BOOK_MCP_BIN%" (
  echo Understand Book MCP executable was not found at "%BOOK_MCP_BIN%". Reinstall Understand Book Setup or set UNDERSTAND_BOOK_MCP_BIN. 1>&2
  exit /b 2
)

"%BOOK_MCP_BIN%" %*
exit /b %ERRORLEVEL%
