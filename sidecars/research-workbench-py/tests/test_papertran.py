# -*- coding: utf-8 -*-
"""papertran._spawn 自检：子进程不弹黑窗、非零退出能拿到、卡死会被看门狗终止。

    python -m unittest test_papertran -v
"""
from __future__ import annotations

import io
import os
import sys
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import papertran  # noqa: E402


class SpawnTest(unittest.TestCase):
    def _run(self, code: str) -> tuple[int, str]:
        fh = io.StringIO()
        rc = papertran._spawn("t", [sys.executable, "-c", code], os.environ.copy(), fh, 1, 1)
        return rc, fh.getvalue()

    def test_01_正常子进程拿到输出与退出码(self):
        rc, out = self._run("print('ok')")
        self.assertEqual(rc, 0)
        self.assertIn("ok", out)

    def test_02_非零退出码传得回来(self):
        rc, out = self._run("print('boom'); raise SystemExit(3)")
        self.assertEqual(rc, 3)
        self.assertIn("boom", out)

    def test_03_没有输出超时会被杀掉(self):
        old = papertran.STALL_SECONDS
        papertran.STALL_SECONDS = 1                      # 别真等 15 分钟
        try:
            t0 = time.monotonic()
            rc, out = self._run("import time; print('started', flush=True); time.sleep(30)")
            self.assertLess(time.monotonic() - t0, 20, "看门狗没生效（孩子还在睡）")
            self.assertNotEqual(rc, 0)
            self.assertIn("判定卡死", out)
        finally:
            papertran.STALL_SECONDS = old

    def test_04_子进程不创建控制台(self):
        if os.name != "nt":
            self.skipTest("仅 Windows")
        self.assertEqual(papertran._CREATE_NO_WINDOW, 0x08000000)
        # 真起一次，确认没报错（窗口有没有弹出来人眼可验，这里保证参数被接受）
        rc, _ = self._run("print('no console')")
        self.assertEqual(rc, 0)
        self.assertIn("控制台事件中断", papertran._why(3221225786))


if __name__ == "__main__":
    unittest.main()
