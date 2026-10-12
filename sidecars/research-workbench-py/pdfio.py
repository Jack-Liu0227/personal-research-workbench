# -*- coding: utf-8 -*-
"""PDF 读写适配层。

只用宽松许可的实现：pypdf(BSD-3) 管页数与页面合并，pdfplumber(MIT) 管文本与词坐标 ——
替代原先的 PyMuPDF(AGPL)。上层只跟这里打交道，将来换实现只改这一个文件。

坐标口径：一律「原点在左上」（pdfplumber 的 top/bottom 就是这个口径），与换库前一致，
前端按缩放比铺文字层。
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

import pdfplumber
from pypdf import PdfReader, PdfWriter

DEFAULT_SIZE = (595.0, 842.0)          # 补空白页时用不到页面自身尺寸的兜底（A4）


def page_count(path: Path | str) -> int:
    with open(path, "rb") as fh:
        return len(PdfReader(fh).pages)


def page_texts(path: Path | str, limit: int = 0) -> list[str]:
    """每页纯文本（阅读顺序）。limit>0 时只看前 limit 页。"""
    out: list[str] = []
    with pdfplumber.open(str(path)) as pdf:
        pages = pdf.pages if not limit else pdf.pages[:limit]
        for pg in pages:
            out.append((pg.extract_text() or "").strip())
    return out


def text(path: Path | str, limit: int = 0) -> str:
    return "\n".join(page_texts(path, limit))


def pages_with_words(path: Path | str, max_pages: int = 0) -> list[dict[str, Any]]:
    """每页的词 + 坐标（PDF 点，左上原点）：前端自己铺文字层，荧光笔才划得准。"""
    out: list[dict[str, Any]] = []
    with pdfplumber.open(str(path)) as pdf:
        pages = pdf.pages if not max_pages else pdf.pages[:max_pages]
        for i, pg in enumerate(pages, 1):
            words = [{"x": round(w["x0"], 1), "y": round(w["top"], 1),
                      "w": round(w["x1"] - w["x0"], 1), "h": round(w["bottom"] - w["top"], 1),
                      "t": w["text"]}
                     for w in pg.extract_words(use_text_flow=False, keep_blank_chars=False)]
            out.append({"n": i, "w": round(float(pg.width), 1), "h": round(float(pg.height), 1),
                        "words": words})
    return out


def page_size(path: Path | str, n: int = 1) -> tuple[float, float]:
    with open(path, "rb") as fh:
        pg = PdfReader(fh).pages[max(0, n - 1)]
        return float(pg.mediabox.width), float(pg.mediabox.height)


def write_pages(out_path: Path | str, sources: list[tuple[Path | str, int] | None],
                size: tuple[float, float] | None = None) -> None:
    """按给定顺序合成一份 PDF：sources 里 (文件, 页号0基) 取页，None = 补一张空白页。

    None 是给「段与段并行、完成顺序不定」用的：先到的段把位置占住，页号才不会错位。
    ponytail: 逐页 add_page 只保留页面内容，不带原文件的书签/页级注释；译文产物不需要那些。
    """
    w = PdfWriter()
    cache: dict[str, PdfReader] = {}
    sw, sh = size or DEFAULT_SIZE
    for item in sources:
        if item is None:
            w.add_blank_page(width=sw, height=sh)
            continue
        src, idx = item
        key = str(src)
        if key not in cache:
            cache[key] = PdfReader(key)
        w.add_page(cache[key].pages[idx])
    with open(out_path, "wb") as fh:
        w.write(fh)


def biggest_title(path: Path | str) -> str:
    """首页字号最大的那几行当标题（跳过期刊页眉/DOI 行）。pdfplumber 每个字符都带 size。"""
    try:
        with pdfplumber.open(str(path)) as pdf:
            chars = (pdf.pages[0].chars or []) if pdf.pages else []
        lines: dict[int, list[dict[str, Any]]] = {}
        for ch in chars:
            lines.setdefault(round((ch.get("top") or 0) / 2), []).append(ch)   # 同一行 = top 接近
        best: list[tuple[float, str]] = []
        for _, group in lines.items():
            group.sort(key=lambda c: c.get("x0") or 0)
            txt = "".join(c.get("text") or "" for c in group).strip()
            size = max((c.get("size") or 0) for c in group)
            if len(txt) >= 12 and size > 0:
                best.append((size, txt))
        if not best:
            return ""
        best.sort(key=lambda x: -x[0])
        top = best[0][0]
        return " ".join(t for s, t in best if s >= top * 0.92)[:300]
    except Exception:
        return ""


def meta(path: Path | str) -> dict[str, str]:
    """PDF 自带元数据里的标题/创建时间（取不到就给空串）。"""
    try:
        with open(path, "rb") as fh:
            info = PdfReader(fh).metadata or {}
        return {"title": str(info.get("/Title") or "").strip(),
                "creation": str(info.get("/CreationDate") or "")}
    except Exception:
        return {"title": "", "creation": ""}


def _demo() -> None:
    """自检：写一份两页 PDF -> 数页数 -> 取文本 -> 取词坐标 -> 只留第 2 页。"""
    import tempfile
    from pathlib import Path as P
    d = P(tempfile.mkdtemp())
    a, b = d / "a.pdf", d / "b.pdf"
    write_pages(a, [None, None], size=(300, 200))
    assert page_count(a) == 2, page_count(a)
    write_pages(b, [(a, 1)])
    assert page_count(b) == 1 and page_size(b) == (300.0, 200.0), page_size(b)
    assert isinstance(page_texts(a), list) and isinstance(pages_with_words(a), list)
    print("pdfio 自检通过：页数/尺寸/文本/词坐标/取页 都正常")


if __name__ == "__main__":
    _demo()
