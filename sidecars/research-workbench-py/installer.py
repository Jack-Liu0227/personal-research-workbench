# -*- coding: utf-8 -*-
"""科研工作 1.0 安装程序（单文件 exe）

用户双击即装：把打包进来的 ResearchWorkbench/ 复制到
    %LOCALAPPDATA%\\Programs\\ResearchWorkbench
再建桌面快捷方式、启动程序。数据目录 data/ 不覆盖，重装不丢资料。

重新打包（改完程序代码后，在仓库根目录跑）：
    "%LOCALAPPDATA%\\Programs\\Python\\Python310\\python.exe" -m PyInstaller --noconfirm --clean \
        --onefile --console --name ResearchWorkbench-Setup --icon build\\icon.ico \
        --add-data "dist\\ResearchWorkbench;ResearchWorkbench" \
        --hidden-import win32com.client installer.py
生成 dist\\ResearchWorkbench-Setup.exe，改名成「科研工作1.0-安装程序.exe」发人即可。
"""
import os
import shutil
import subprocess
import sys
import time

APP = "ResearchWorkbench"
TITLE = "科研工作 1.0"


def say(msg=""):
    print(msg, flush=True)


def main():
    # 用户机器的控制台默认 GBK，不设一下中文会花
    if os.name == "nt":
        os.system("chcp 65001 >nul")
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    here = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    src = os.path.join(here, APP)
    if not os.path.isfile(os.path.join(src, APP + ".exe")):
        say("包里没有 %s.exe，安装包损坏。" % APP)
        return 1

    root = os.path.join(os.environ["LOCALAPPDATA"], "Programs", APP)
    exe = os.path.join(root, APP + ".exe")

    say("=" * 46)
    say("  %s 安装程序" % TITLE)
    say("=" * 46)
    say("安装到：%s" % root)
    say()

    # 关掉正在运行的旧版本，否则文件被占用
    subprocess.run(["taskkill", "/F", "/IM", APP + ".exe"], capture_output=True)
    time.sleep(0.5)

    # 复制：跳过 data/（用户资料）与被占用的失败项
    os.makedirs(root, exist_ok=True)
    n = skipped = 0
    for dirpath, dirnames, filenames in os.walk(src):
        rel = os.path.relpath(dirpath, src)
        if rel != "." and rel.split(os.sep)[0] == "data":
            dirnames[:] = []
            continue
        target_dir = root if rel == "." else os.path.join(root, rel)
        os.makedirs(target_dir, exist_ok=True)
        for name in filenames:
            try:
                shutil.copy2(os.path.join(dirpath, name), os.path.join(target_dir, name))
                n += 1
            except Exception:
                skipped += 1
            if n % 25 == 0:
                print("\r  正在复制 ... %d 个文件" % n, end="", flush=True)
    say("\r  已复制 %d 个文件%s" % (n, "，%d 个跳过" % skipped if skipped else "  "))

    # 桌面快捷方式：优先 pywin32；没有就退回 PowerShell（两者任一都能成）
    lnk = os.path.join(os.path.expanduser("~"), "Desktop", TITLE + ".lnk")
    icon = os.path.join(root, "build", "icon.ico")
    try:
        import win32com.client  # noqa: F401  pywin32
        sh = win32com.client.Dispatch("WScript.Shell")
        sc = sh.CreateShortcut(lnk)
        sc.TargetPath = exe
        sc.WorkingDirectory = root
        if os.path.isfile(icon):
            sc.IconLocation = icon
        sc.Description = TITLE
        sc.Save()
    except Exception:
        ps = (
            "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%s');"
            "$s.TargetPath='%s';$s.WorkingDirectory='%s';$s.Description='%s';$s.Save()"
            % (lnk, exe, root, TITLE)
        )
        subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True)
    say("  桌面快捷方式：%s" % ("已创建" if os.path.isfile(lnk) else "创建失败（可手动从安装目录启动）"))
    say()

    # 启动
    try:
        subprocess.Popen([exe], cwd=root)
        say("装好了！桌面上的「%s」双击就能用。" % TITLE)
    except Exception as e:
        say("启动失败：%s（可从 %s 手动双击）" % (e, root))
    say()
    say("提醒：第一次打开要去「模型」页填自己的 API key。")
    say()
    input("按回车关闭本窗口 ...")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # 双击出错时别闪退，让人看见原因
        print("\n安装出错：%r" % exc)
        input("按回车关闭 ...")
        sys.exit(1)
