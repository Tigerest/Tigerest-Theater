@echo off
REM Tigerest Theater - Run unit tests
REM Run build.bat first

setlocal
call "%~dp0common.bat"
call "%~dp0common.bat" :setup_runtime || exit /b 1

REM === Run tests ===
cd /d "%BUILD_DIR%"
ctest --output-on-failure %*
set EXIT_CODE=%ERRORLEVEL%

endlocal & exit /b %EXIT_CODE%
