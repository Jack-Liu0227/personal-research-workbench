@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem 无控制台启动。**写死 Python 3.10 的绝对路径** —— 别再用 `pyw -3.10`：
rem 本机 py 启动器里还注册着 uv 的 Astral/CPython3.11，踩过「起出来的是 3.11」→ 3.11 没装 pywebview
rem → 静默退回 Edge --app 窗口（带黑标题栏，用户要的就是别带）。3.10 才装了 PyMuPDF/python-docx/pywebview。
set PY310=%LOCALAPPDATA%\Programs\Python\Python310
if exist "%PY310%\pythonw.exe" (
  start "" "%PY310%\pythonw.exe" "%~dp0server.py"
  exit /b
)
rem 兜底：3.10 不在默认位置时退回 pyw -3.10 / pythonw
where pyw >nul 2>nul
if %errorlevel%==0 (
  start "" pyw -3.10 "%~dp0server.py"
  exit /b
)
start "" pythonw "%~dp0server.py"
