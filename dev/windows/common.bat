@echo off
REM Tigerest Theater - Common variables
REM Sourced by other scripts

set QT_VERSION=6.9.3
set MPV_RELEASE=20260809
set MPV_VERSION=20260809-git-dd5d17d328
set SCRIPT_DIR=%~dp0
for %%i in ("%SCRIPT_DIR%\..\..") do set "PROJECT_ROOT=%%~fi"
set DEPS_DIR=%SCRIPT_DIR%deps
if defined TIGEREST_DEPS_DIR set "DEPS_DIR=%TIGEREST_DEPS_DIR%"
set BUILD_DIR=%PROJECT_ROOT%\build
set EXE_NAME=Tigerest Theater.exe

REM Portable CMake/Ninja/aqt tools. setup.bat keeps these project-local even
REM when the large Qt/mpv dependencies live in TIGEREST_DEPS_DIR.
set "PATH=%SCRIPT_DIR%deps\tools-venv\Scripts;%PATH%"
if exist "%DEPS_DIR%\tools-venv\Scripts" set "PATH=%DEPS_DIR%\tools-venv\Scripts;%PATH%"

REM === Find Visual Studio ===
set VCVARS=
set "VS_BT=C:\Program Files\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
set "VS_CM=C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
set "VS_PR=C:\Program Files\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvars64.bat"
set "VS_EN=C:\Program Files\Microsoft Visual Studio\2022\Enterprise\VC\Auxiliary\Build\vcvars64.bat"
set "VS_BT86=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"

REM A portable MSVC root may be supplied without installing Visual Studio.
if defined TIGEREST_MSVC_ROOT if exist "%TIGEREST_MSVC_ROOT%\setup_x64.bat" set "VCVARS=%TIGEREST_MSVC_ROOT%\setup_x64.bat"

REM setup.bat may keep the portable compiler beside an external deps folder.
if not defined VCVARS for %%i in ("%DEPS_DIR%\..\portable-msvc-source\msvc") do if exist "%%~fi\setup_x64.bat" set "VCVARS=%%~fi\setup_x64.bat"

if not defined VCVARS if exist "%VS_BT%" set "VCVARS=%VS_BT%"
if not defined VCVARS if exist "%VS_CM%" set "VCVARS=%VS_CM%"
if not defined VCVARS if exist "%VS_PR%" set "VCVARS=%VS_PR%"
if not defined VCVARS if exist "%VS_EN%" set "VCVARS=%VS_EN%"
if not defined VCVARS if exist "%VS_BT86%" set "VCVARS=%VS_BT86%"

if "%~1"=="" goto :eof
goto %~1

REM === Setup runtime PATH for DLLs ===
REM Call with: call "%~dp0common.bat" :setup_runtime
:setup_runtime
if not exist "%BUILD_DIR%" (
    echo ERROR: Build not found. Run build.bat first
    exit /b 1
)
set "PATH=%DEPS_DIR%\mpv;%PATH%"
set "PATH=%DEPS_DIR%\qt\%QT_VERSION%\msvc2022_64\bin;%PATH%"
goto :eof
