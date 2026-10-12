# -*- coding: utf-8 -*-
"""精读相关纯函数自检：非论文过滤 + 检索相关度粗筛。

    python -m unittest test_deepread -v
"""
from __future__ import annotations

import os
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pathlib
import tempfile
import unittest

os.environ.setdefault("RESEARCH_WORKBENCH_DB", str(pathlib.Path(tempfile.gettempdir()) / "dr_unit.sqlite3"))

import workflow  # noqa: E402


class DeepreadTest(unittest.TestCase):
    def setUp(self) -> None:
        self.d = pathlib.Path(tempfile.mkdtemp(prefix="dr_"))
        # 一篇「真论文」：够大、没有同名 .tex
        self.paper = self.d / "s41586-024-08328-6.pdf"
        self.paper.write_bytes(b"%PDF-1.4" + b"x" * 30000)
        # 各种建产物/残件
        (self.d / "main_zh.pdf").write_bytes(b"%PDF-1.4" + b"x" * 30000)
        (self.d / "main_zh.tex").write_text("\\documentclass{revtex4-1}", encoding="utf-8")
        (self.d / "tiny.pdf").write_bytes(b"%PDF-1.4" + b"x" * 100)
        (self.d / "_build").mkdir()
        (self.d / "_build" / "main.pdf").write_bytes(b"%PDF-1.4" + b"x" * 30000)
        (self.d / "overleaf").mkdir()
        (self.d / "overleaf" / "main.pdf").write_bytes(b"%PDF-1.4" + b"x" * 30000)

    def test_01_only_real_papers_pass(self):
        self.assertTrue(workflow.is_paper_pdf(self.paper))                 # 真论文
        self.assertFalse(workflow.is_paper_pdf(self.d / "main_zh.pdf"))    # 旁边有 .tex → 编出来的
        self.assertFalse(workflow.is_paper_pdf(self.d / "tiny.pdf"))       # 太小
        self.assertFalse(workflow.is_paper_pdf(self.d / "_build" / "main.pdf"))
        self.assertFalse(workflow.is_paper_pdf(self.d / "overleaf" / "main.pdf"))
        self.assertFalse(workflow.is_paper_pdf(self.d / "不存在.pdf"))      # 不存在也算不算

    def test_02_relevance_filter(self):
        q = "materials informatics machine learning doping"
        good = {"title": "Machine learning for materials informatics in doped cathodes", "abstract": ""}
        junk = {"title": "Teacher materials Volume 1", "abstract": ""}
        self.assertTrue(workflow._relevant(q, good))
        self.assertFalse(workflow._relevant(q, junk))                      # 只蹭到一个词 → 挡掉
        self.assertTrue(workflow._relevant(q, {"title": "Machine learning review", "abstract": "doping in materials"}))
        self.assertTrue(workflow._relevant("doping", junk))                # 关键词本来就少 → 不过滤

    def test_03_vocab_and_stop_exception_exist(self):
        self.assertTrue(hasattr(workflow, "DeepreadStopped"))
        self.assertTrue(hasattr(workflow, "deepread_kick"))
        self.assertTrue(hasattr(workflow, "deepread_stop"))
        self.assertIsNone(workflow.deepread_state("no-such-task"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
