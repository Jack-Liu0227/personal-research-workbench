# -*- mode: python ; coding: utf-8 -*-
# 打包：build.bat（或 python -m PyInstaller ResearchWorkbench.spec --noconfirm --clean）
# 关键三条（少一条打出来的包就是坏的）：
#   1) datas 必须带 web/（界面）和 build/icon.ico（窗口图标），否则界面对了图标也缺
#   2) contents_directory='.' 让 web/ 与 exe 同目录 —— server.py 用 HERE/web、workflow.py 用
#      __file__ 的 parent 找 providers_catalog.json，两种写法都指向 exe 所在目录才对得上
#   3) upx=False：UPX 压缩是杀软误报的主要来源

a = Analysis(
    ['server.py'],
    pathex=[],
    binaries=[],
    datas=[
        ('web', 'web'),
        ('build/icon.ico', 'build'),
        ('providers_catalog.json', '.'),
    ],
    hiddenimports=['pdfplumber', 'pypdf', 'cryptography', 'PIL', 'pypdfium2', 'webview'],
    # 说明：pdfminer.six / pdfplumber 里有条件导入（cryptography 处理加密 PDF、PIL/pypdfium2 渲染），
    # 静态分析看不到，必须显式列出；PyMuPDF(AGPL) 已弃用，见 pdfio.py。
   # cryptography: pdfminer.six 里是条件导入，静态分析看不到   # PyMuPDF(AGPL) 已弃用，见 pdfio.py / requirements.txt
    hookspath=['hooks'],       # hooks/hook-workflow.py 用来顶掉同名 contrib 钩子（见该文件注释）
    hooksconfig={},
    runtime_hooks=[],
    # 应用一行都没用到下面这些；它们是被 3.10 里别的包连带拖进来的（torch 还是 CUDA 版）。
    # 不排除的话包 3.1GB —— 没法发给别人下载。将来真要加 OCR/机器学习功能，把对应项去掉即可。
    excludes=[
        'torch', 'torchvision', 'torchaudio',
        'onnxruntime', 'rapidocr_onnxruntime', 'cv2', 'shapely', 'pyclipper',
        'numba', 'llvmlite', 'h5py', 'pandas', 'matplotlib', 'scipy', 'sklearn',
        'google', 'pyreadline3', 'win32com',
        # 注意：cryptography（pdfminer.six 加密 PDF）和 yaml（server.py 读配置）不能排，
        # excludes 优先级高于 hiddenimports，排了就是 Startup 崩溃（已踩）。
    ],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='ResearchWorkbench',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon='build/icon.ico',
    contents_directory='.',
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='ResearchWorkbench',
)
