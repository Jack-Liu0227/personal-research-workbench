# -*- coding: utf-8 -*-
"""read_attachment 自检（不联网、不调模型）。

回归背景：read_attachment 在改用 pdfio 抓 PDF 正文时，`else` 分支和最后的
`return` 被一起删掉了，函数变成「永远返回 None」，而 agent 的 read_attachment
工具却一直在调它（调用点 6 处）。当时 tests/ 对这个函数是 0 覆盖，所以没拦住。

这里把手写文件、PDF 正文、页数上限、截断标记、越界路径五条都钉住。
"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import workflow
from workflow import ATTACH_PDF_PAGES, DATA, read_attachment
from tests._pdf_fixture import write_text_pdf


class ReadAttachmentTest(unittest.TestCase):
    def setUp(self) -> None:
        # 必须落在 _FILE_ROOTS（DATA 及其子目录）里，否则会被越界检查拦掉
        self.dir = DATA / "uploads" / "_test_read_attachment"
        self.dir.mkdir(parents=True, exist_ok=True)

    def tearDown(self) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)

    # ---- 纯文本 ----

    def test_text_file_returns_dict(self) -> None:
        """文本文件：返回 dict（而不是 None），字段齐全且内容对得上。"""
        f = self.dir / "笔记.md"
        f.write_text("# 标题\n正文若干\n", encoding="utf-8")

        got = read_attachment(str(f))

        self.assertIsInstance(got, dict)                     # 回归点：以前这里是 None
        self.assertEqual(got["name"], "笔记.md")
        self.assertEqual(got["path"], str(f.resolve()))
        self.assertIn("正文若干", got["text"])
        self.assertEqual(got["chars"], len("# 标题\n正文若干\n"))
        self.assertFalse(got["truncated"])

    def test_binary_garbage_does_not_raise(self) -> None:
        """非 UTF-8 的文本也按 replace 读，不能把工具调炸。"""
        f = self.dir / "raw.txt"
        f.write_bytes(b"\xff\xfe\x00abc")
        got = read_attachment(str(f))
        self.assertIsInstance(got, dict)
        self.assertEqual(got["chars"], len(got["text"]))

    # ---- PDF ----

    def test_pdf_returns_text_not_none(self) -> None:
        """PDF：走 pdfio 分支，同样必须返回 dict 且带上正文。"""
        pdf = write_text_pdf(self.dir / "a.pdf", ["PPONE", "PPTWO"])

        got = read_attachment(str(pdf))

        self.assertIsInstance(got, dict)                     # 回归点
        self.assertEqual(got["name"], "a.pdf")
        self.assertIn("PPONE", got["text"])
        self.assertIn("PPTWO", got["text"])
        self.assertFalse(got["truncated"])

    def test_pdf_page_cap(self) -> None:
        """超过 ATTACH_PDF_PAGES 页的 PDF 只扫前几页，避免拖死服务。"""
        pages = ["PG%02d" % i for i in range(1, 11)]          # 10 页
        pdf = write_text_pdf(self.dir / "big.pdf", pages)

        got = read_attachment(str(pdf))

        self.assertIn("PG01", got["text"])
        self.assertIn("PG%02d" % ATTACH_PDF_PAGES, got["text"])
        self.assertNotIn("PG%02d" % (ATTACH_PDF_PAGES + 1), got["text"])

    # ---- 截断 ----

    def test_truncation_flag(self) -> None:
        """chars 只在 [500, READ_MAX] 之间生效；超长内容要标 truncated。"""
        f = self.dir / "long.txt"
        f.write_text("x" * 3000, encoding="utf-8")

        got = read_attachment(str(f), chars=500)

        self.assertEqual(len(got["text"]), 500)
        self.assertEqual(got["chars"], 3000)
        self.assertTrue(got["truncated"])

    def test_chars_floor_is_500(self) -> None:
        """chars 传个很小的值，也不能低于下限 500（否则 agent 拿不到上下文）。"""
        f = self.dir / "tiny.txt"
        f.write_text("y" * 1000, encoding="utf-8")
        got = read_attachment(str(f), chars=1)
        self.assertEqual(len(got["text"]), 500)

    def test_shorter_than_cap_is_not_truncated(self) -> None:
        f = self.dir / "s.txt"
        f.write_text("z" * 100, encoding="utf-8")
        got = read_attachment(str(f), chars=500)
        self.assertEqual(got["text"], "z" * 100)
        self.assertFalse(got["truncated"])

    # ---- 越界 ----

    def test_rejects_outside_roots(self) -> None:
        """data/ 与项目目录之外的文件一律拒读。"""
        with tempfile.TemporaryDirectory() as td:
            outside = Path(td) / "secret.txt"
            outside.write_text("top secret", encoding="utf-8")
            with self.assertRaises(ValueError):
                read_attachment(str(outside))

    def test_rejects_sibling_prefix_dir(self) -> None:
        """同级的 data-evil/ 不能靠前缀比较混进来。"""
        evil = DATA.parent / "data-evil"
        f = evil / "x.txt"
        try:
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text("nope", encoding="utf-8")
            with self.assertRaises(ValueError):
                read_attachment(str(f))
        finally:
            shutil.rmtree(evil, ignore_errors=True)

    def test_rejects_directory_and_missing(self) -> None:
        with self.assertRaises(ValueError):
            read_attachment(str(self.dir))                   # 目录不是文件
        with self.assertRaises(ValueError):
            read_attachment(str(self.dir / "没有这个文件.txt"))
        with self.assertRaises(ValueError):
            read_attachment("")                              # 没给路径


if __name__ == "__main__":
    unittest.main(verbosity=2)
