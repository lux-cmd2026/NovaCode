@echo off
chcp 65001 >nul
rem NovaCode - build Windows installers (NSIS: x64 + arm64). Run on Windows 10/11.
rem NovaCode - 构建 Windows 安装包(x64 + arm64),在 Windows 10/11 上运行。
setlocal
cd /d "%~dp0"
if exist "..\source\package.json" ( cd /d "..\source" ) else if exist "..\package.json" ( cd /d ".." )
where node >nul 2>nul || ( echo Node.js 20+ required: https://nodejs.org ^| 需要 Node.js 20+ & pause & exit /b 1 )
set CSC_IDENTITY_AUTO_DISCOVERY=false
call npm ci || goto :fail
call npm run build || goto :fail
call npx electron-builder --win --x64 --arm64 --publish never || goto :fail
echo.
echo Done. Output / 完成,产物:
dir /b release\*.exe
echo Unsigned: SmartScreen may warn - click "More info" then "Run anyway".
echo 未签名:SmartScreen 若拦截,点“更多信息”再点“仍要运行”。
pause
exit /b 0
:fail
echo Build failed / 构建失败
pause
exit /b 1
