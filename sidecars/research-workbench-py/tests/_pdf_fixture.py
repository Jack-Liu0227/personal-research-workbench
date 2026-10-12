# -*- coding: utf-8 -*-
"""测试用的最小 PDF 构造器：造一份「每页一句话」的 PDF，好让 pdfio 读回来验证。

pypdf 没有「写文字」的高层 API，这里按 PDF 规范手拼页面内容流 + Helvetica 资源。
只给测试用，不进产品路径。
"""
from __future__ import annotations

from pathlib import Path

from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject


def _esc(t: str) -> str:
    return t.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")


def write_text_pdf(path: Path | str, texts: list[str], size: tuple[int, int] = (400, 200)) -> Path:
    """texts 里每个元素写成一页（ASCII 文字：内置 Helvetica 只有拉丁字形）。"""
    w = PdfWriter()
    for t in texts:
        page = w.add_blank_page(width=size[0], height=size[1])
        font = DictionaryObject({
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        })
        page[NameObject("/Resources")] = DictionaryObject({
            NameObject("/Font"): DictionaryObject({NameObject("/F1"): w._add_object(font)}),
        })
        stream = DecodedStreamObject()
        stream.set_data(("BT /F1 14 Tf 40 100 Td (%s) Tj ET" % _esc(t)).encode("latin-1"))
        page[NameObject("/Contents")] = w._add_object(stream)
    p = Path(path)
    with p.open("wb") as fh:
        w.write(fh)
    return p


if __name__ == "__main__":
    import sys, tempfile
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    import pdfio
    d = Path(tempfile.mkdtemp())
    p = write_text_pdf(d / "t.pdf", ["AA", "BB", "CC"])
    got = pdfio.page_texts(p)
    assert pdfio.page_count(p) == 3, pdfio.page_count(p)
    assert got == ["AA", "BB", "CC"], got
    print("fixture 自检通过：3 页，读回", got)
