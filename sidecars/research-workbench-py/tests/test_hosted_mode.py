# -*- coding: utf-8 -*-
"""托管模式（被 Electron 主进程拉起）的启动契约测试。

主进程用于启动侧车的命令是：

    python server.py --port <空闲端口> --no-open
        RESEARCH_WORKBENCH_DATA=<userData>/sidecar-data
        RESEARCH_WORKBENCH_DB=<userData>/sidecar-data/research.sqlite3

这里的四条断言就是主进程所依赖的全部契约，任何一条坏掉都会让内嵌应用打不开：

1. --no-open 必须让进程保持在服务状态，而不是开完窗口就退出；
2. 首次启动必须在指定数据目录里建出数据库（否则用户数据会落到安装目录）；
3. 根路径必须返回 2xx，健康探测才能判定“已就绪”；
4. 结束进程后必须真正退出，否则主进程退出后会残留孤儿进程占住端口和数据库。
"""
from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
APP = HERE.parent
SERVER = APP / "server.py"
START_TIMEOUT_S = 90


def free_port() -> int:
    import socket
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


class HostedModeTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="rw-hosted-")
        self.data = Path(self._tmp.name)
        self.port = free_port()
        env = {k: v for k, v in os.environ.items()
               if k not in ("RESEARCH_WORKBENCH_DATA", "RESEARCH_WORKBENCH_DB")}
        env.update({
            "RESEARCH_WORKBENCH_DATA": str(self.data),
            "RESEARCH_WORKBENCH_DB": str(self.data / "research.sqlite3"),
            "PYTHONIOENCODING": "utf-8",
            "PYTHONUTF8": "1",
        })
        # 拉起之前先记下程序目录 data/ 的内容，用来证明侧车没有往安装目录写东西
        app_data = APP / "data"
        self.app_data_before = sorted(os.listdir(app_data)) if app_data.is_dir() else []
        self.proc = subprocess.Popen(
            [sys.executable, str(SERVER), "--port", str(self.port), "--no-open"],
            cwd=str(APP), env=env,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )

    def tearDown(self) -> None:
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=15)
        for stream in (self.proc.stdout, self.proc.stderr):
            if stream is not None:
                stream.close()
        self._tmp.cleanup()

    def wait_ready(self) -> None:
        deadline = time.time() + START_TIMEOUT_S
        last = ""
        while time.time() < deadline:
            if self.proc.poll() is not None:                 # 提前退出：把真实原因带出来
                err = (self.proc.stderr.read() or b"").decode("utf-8", "replace")
                self.fail(f"--no-open 下进程提前退出（code {self.proc.returncode}）：{err[-2000:]}")
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/", timeout=3) as r:
                    if r.status < 500:
                        return
                    last = f"HTTP {r.status}"
            except urllib.error.HTTPError as exc:
                last = f"HTTP {exc.code}"
                if exc.code < 500:
                    return
            except OSError as exc:
                last = str(exc)
            time.sleep(0.25)
        self.fail(f"侧车在 {START_TIMEOUT_S}s 内未就绪（最后错误：{last}）")

    def test_serves_without_opening_a_window(self) -> None:
        """--no-open 必须常驻服务；主进程自己开 Electron 窗口。"""
        self.wait_ready()
        self.assertIsNone(self.proc.poll(), "就绪后进程不应退出")
        for path in ("/", "/api/state"):
            with urllib.request.urlopen(f"http://127.0.0.1:{self.port}{path}", timeout=5) as r:
                self.assertLess(r.status, 500, f"{path} 返回 {r.status}")
                r.read()

    def test_creates_the_database_under_the_requested_root(self) -> None:
        """用户数据必须落在指定目录，而不是程序目录下的 data/。"""
        self.wait_ready()
        db = self.data / "research.sqlite3"
        deadline = time.time() + 30
        while not db.exists() and time.time() < deadline:
            time.sleep(0.25)
        self.assertTrue(db.exists(), f"未在 {self.data} 建出数据库")
        self.assertGreater(db.stat().st_size, 0)
        # 用户数据必须只落在指定目录：程序目录 data/ 不应多出任何东西
        app_data = APP / "data"
        after = sorted(os.listdir(app_data)) if app_data.is_dir() else []
        self.assertEqual(self.app_data_before, after,
                         f"侧车污染了程序目录 data/：新增 {sorted(set(after) - set(self.app_data_before))}")
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        try:
            tables = {row[0] for row in con.execute(
                "select name from sqlite_master where type='table'")}
        finally:
            con.close()
        self.assertIn("research_tasks", tables, f"数据库结构不完整：{sorted(tables)[:12]}")
        self.assertGreater(len(tables), 10, f"只建出 {len(tables)} 张表")
        self.assertTrue((self.data / "out").is_dir() or (self.data / "notes").is_dir(),
                        "工作流输出目录未在指定数据根下创建")

    def test_terminate_actually_stops_the_process(self) -> None:
        """主进程退出时必须能真正收走子进程。"""
        self.wait_ready()
        self.proc.terminate()
        try:
            self.proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            self.fail("terminate 后 20s 内未退出，主进程退出会残留孤儿进程")


if __name__ == "__main__":
    unittest.main()
