# -*- coding: utf-8 -*-
"""_trim_tail 自检：超出已翻页数的尾部原页要删；范围内的页（哪怕是 fallback 的原文）不许动。"""
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
import pdfio
import papertran
from _pdf_fixture import write_text_pdf


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
