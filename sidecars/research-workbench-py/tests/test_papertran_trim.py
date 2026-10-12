# -*- coding: utf-8 -*-
"""_trim_tail 自检：只裁「超出已翻页数」的尾部原页；范围内即使文字与原文相同（模型 fallback）也不许动。"""
import os, sys, tempfile, unittest, pathlib
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import fitz
import papertran


class TrimTest(unittest.TestCase):
    def _pdf(self, texts):
        p = pathlib.Path(tempfile.mkdtemp()) / "t.pdf"
        d = fitz.open()
        for t in texts:
            pg = d.new_page()
            pg.insert_text((72, 100), t)
        d.save(str(p)); d.close()
        return p

    def test_尾部原页被删(self):
        src = self._pdf(["AAA", "BBB", "CCC"])
        mono = self._pdf(["译文A", "译文B", "CCC"])        # 第 3 页 == 原文第 3 页 -> 未翻译
        papertran._trim_tail(mono, src, 2)
        with fitz.open(str(mono)) as d:
            self.assertEqual(d.page_count, 2)

    def test_已翻译的页不被删(self):
        src = self._pdf(["AAA", "BBB"])
        mono = self._pdf(["译文A", "译文B"])
        papertran._trim_tail(mono, src, 2)
        with fitz.open(str(mono)) as d:
            self.assertEqual(d.page_count, 2)

    def test_范围内文字相同也不许删(self):
        """模型/接口挂掉时 babeldoc 会原样 fallback，这些真译文页的文字与原文逐字相同 ——
        只按文字判会全删（踩过：39 页只剩 1 页）。已翻范围内的页一律保留。"""
        src = self._pdf(["AAA", "BBB"])
        mono = self._pdf(["AAA", "BBB"])              # 两页都是 fallback，文字与原文一样
        papertran._trim_tail(mono, src, 2)
        with fitz.open(str(mono)) as d:
            self.assertEqual(d.page_count, 2)

    def test_单页不动(self):
        src = self._pdf(["AAA"])
        mono = self._pdf(["AAA"])
        papertran._trim_tail(mono, src, 1)
        with fitz.open(str(mono)) as d:
            self.assertEqual(d.page_count, 1)


if __name__ == "__main__":
    unittest.main()
