@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在啟動 Google 雲端硬碟與 Gmail 空間清理中心...
echo.
python server.py
pause
