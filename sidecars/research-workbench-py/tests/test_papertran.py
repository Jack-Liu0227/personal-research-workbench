# papertran._spawn 自检：子进程不弹黑窗、非零退出能拿到、卡死会被看门狗终止。
# 
# python -m unittest test_papertran -v
from __future__ import annotations
import io
import os
import sys
import time
import unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import papertran  # noqa: E402
# _splice 自检：第一段只取请求区间、第二段能把文档撑长、乱序并行缺页补空白。
import pathlib
import tempfile
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
import pdfio
from _pdf_fixture import write_text_pdf
# _trim_tail 自检：超出已翻页数的尾部原页要删；范围内的页（哪怕是 fallback 的原文）不许动。


# ---------------- 来自 test_papertran.py ----------------
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


# ---------------- 来自 test_papertran_splice.py ----------------
class SpliceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.td = pathlib.Path(tempfile.mkdtemp())

    def test_第一段只取请求区间(self) -> None:
        """要 1-2 页，part 带 3 页（版式上下文多给的），产物只能有 2 页。"""
        part = write_text_pdf(self.td / "part.pdf", ["P1", "P2", "P3"])
        dest = self.td / "mono.pdf"
        papertran._splice(dest, part, 1, 2)
        self.assertEqual(pdfio.page_count(dest), 2)
        self.assertEqual(pdfio.page_texts(dest), ["P1", "P2"])

    def test_第二段把文档撑长(self) -> None:
        """先 1-1 再 2-3：产物必须长到 3 页（这是出过 bug 的地方）。"""
        part1 = write_text_pdf(self.td / "p1.pdf", ["P1"])
        part2 = write_text_pdf(self.td / "p23.pdf", ["P1", "P2", "P3"])
        dest = self.td / "mono.pdf"
        papertran._splice(dest, part1, 1, 1)
        self.assertEqual(pdfio.page_count(dest), 1)
        papertran._splice(dest, part2, 2, 3)
        self.assertEqual(pdfio.page_count(dest), 3)
        self.assertEqual(pdfio.page_texts(dest), ["P1", "P2", "P3"])

    def test_乱序并行中间缺页补空白(self) -> None:
        """先落地 3-3（dest 只有第 1 页）：中间补空白占位，页号不错位。"""
        part1 = write_text_pdf(self.td / "p1.pdf", ["P1"])
        part3 = write_text_pdf(self.td / "p3.pdf", ["P1", "P2", "P3"])
        dest = self.td / "mono.pdf"
        papertran._splice(dest, part1, 1, 1)
        papertran._splice(dest, part3, 3, 3)
        texts = pdfio.page_texts(dest)
        self.assertEqual(len(texts), 3)
        self.assertEqual(texts[0], "P1")
        self.assertEqual(texts[2], "P3")
        self.assertEqual(texts[1], "")            # 空白占位，等 2-2 那段来填


# ---------------- 来自 test_papertran_trim.py ----------------
class TrimTest(unittest.TestCase):
    def setUp(self) -> None:
        self.td = pathlib.Path(tempfile.mkdtemp())

    def test_尾部原页被删(self) -> None:
        src = write_text_pdf(self.td / "s.pdf", ["AAA", "BBB", "CCC"])
        mono = write_text_pdf(self.td / "m.pdf", ["ZZZ", "YYY", "CCC"])   # 第 3 页 == 原文 -> 没翻
        papertran._trim_tail(mono, src, done_pages=2)
        self.assertEqual(pdfio.page_count(mono), 2)

    def test_范围内文字相同也不许删(self) -> None:
        """API 报错整段 fallback 时，真译文页的文字与原文一字不差 —— 不能当原页删掉。"""
        src = write_text_pdf(self.td / "s.pdf", ["AAA", "BBB"])
        mono = write_text_pdf(self.td / "m.pdf", ["AAA", "BBB"])
        papertran._trim_tail(mono, src, done_pages=2)
        self.assertEqual(pdfio.page_count(mono), 2)

    def test_已翻译的页不被删(self) -> None:
        src = write_text_pdf(self.td / "s.pdf", ["AAA", "BBB"])
        mono = write_text_pdf(self.td / "m.pdf", ["ZZZ", "YYY"])
        papertran._trim_tail(mono, src, done_pages=2)
        self.assertEqual(pdfio.page_count(mono), 2)

    def test_单页不动(self) -> None:
        src = write_text_pdf(self.td / "s.pdf", ["AAA"])
        mono = write_text_pdf(self.td / "m.pdf", ["AAA"])
        papertran._trim_tail(mono, src, done_pages=1)
        self.assertEqual(pdfio.page_count(mono), 1)


if __name__ == "__main__":
    unittest.main()
