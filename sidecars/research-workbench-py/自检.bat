@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem 科研工作 1.0 一条命令自检：Python 自检（含「主脚本必须过 node --check」）+ 前端主题配色
set PY=%LOCALAPPDATA%\Programs\Python\Python310\python.exe
if not exist "%PY%" set PY=python
echo === 1/2 Python 自检（tests/ 全量）===
"%PY%" -m unittest discover -s tests -t .
if errorlevel 1 (echo. & echo [X] Python 自检没过 & pause & exit /b 1)
echo.
echo === 2/2 前端主题配色自检 ===
node "web\theme.test.mjs"
if errorlevel 1 (echo. & echo [X] 主题自检没过 & pause & exit /b 1)
echo.
echo [OK] 全绿。
pause
