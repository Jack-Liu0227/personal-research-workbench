# -*- coding: utf-8 -*-
"""_splice 自检：第一段只取请求区间、第二段能把文档撑长、乱序并行缺页补空白。"""
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
import pdfio
import papertran
from _pdf_fixture import write_text_pdf


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


if __name__ == "__main__":
    unittest.main()
