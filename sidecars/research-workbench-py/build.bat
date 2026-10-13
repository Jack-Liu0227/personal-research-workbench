@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem 必须用 3.10：只有它的 site-packages 里有 pywebview（无边框窗口）和 python-docx。
rem 用 3.11 打出来的包缺 pywebview，会静默退回带黑标题栏的 Edge --app 窗口。
set PY=%LOCALAPPDATA%\Programs\Python\Python310\python.exe
if not exist "%PY%" set PY=python
echo 打包用的解释器：%PY%
"%PY%" -m PyInstaller ResearchWorkbench.spec --noconfirm --clean
if errorlevel 1 (echo. & echo 打包失败 & pause & exit /b 1)
echo.
echo 产物：dist\ResearchWorkbench\ResearchWorkbench.exe
echo   · 双击它，确认界面能出来（这一步是「包能不能用」的唯一判据）
echo   · 发给人下载：把 dist\ResearchWorkbench\ 里的内容压成 ResearchWorkbench.zip，
echo     传到 GitHub Releases 当附件；install.ps1 会去 releases/latest/download/ 取它
pause
