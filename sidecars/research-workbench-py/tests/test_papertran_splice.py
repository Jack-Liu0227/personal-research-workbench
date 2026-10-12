# -*- coding: utf-8 -*-
"""_splice 自检：文档只增不减、乱序并行缺页补空白。"""
import os, sys, tempfile, unittest, pathlib
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import fitz
import papertran


def mk(texts):
    p = pathlib.Path(tempfile.mkdtemp()) / "t.pdf"
    d = fitz.open()
    for t in texts:
        d.new_page().insert_text((72, 100), t)
    d.save(str(p)); d.close()
    return p


def texts(p):
    with fitz.open(str(p)) as d:
        return [d[i].get_text().strip() for i in range(d.page_count)]


class SpliceTest(unittest.TestCase):
    def test_第一段只取请求区间(self):
        dest = pathlib.Path(tempfile.mkdtemp()) / "out.pdf"
        part = mk(["x", "B", "C"])          # babeldoc 多给了第 1 页
        papertran._splice(dest, part, 2, 3)
        self.assertEqual(texts(dest), ["B", "C"])

    def test_第二段把文档撑长(self):
        d = pathlib.Path(tempfile.mkdtemp())
        dest = d / "out.pdf"
        papertran._splice(dest, mk(["A"]), 1, 1)                  # 先只有 1 页
        papertran._splice(dest, mk(["x", "B", "C"]), 2, 3)     # 再来 2-3 页
        self.assertEqual(texts(dest), ["A", "B", "C"])     # 关键是别卡在 1 页

    def test_乱序并行中间缺页补空白(self):
        d = pathlib.Path(tempfile.mkdtemp())
        dest = d / "out.pdf"
        papertran._splice(dest, mk(["A"]), 1, 1)
        papertran._splice(dest, mk(["x", "x", "C"]), 3, 3)         # 先到的是第 3 页
        t = texts(dest)
        self.assertEqual(len(t), 3)
        self.assertEqual(t[0], "A"); self.assertEqual(t[2], "C"); self.assertEqual(t[1], "")


if __name__ == "__main__":
    unittest.main()
