@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   林间小屋 · Forest Cabin
echo   正在启动本地预览服务器...
echo.
start "" http://127.0.0.1:8123/
node serve.mjs 8123
pause
