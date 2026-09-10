"""User-triggered Google Scholar adapter for Personal Research Workbench.

The sidecar is deliberately page-bounded. It never solves CAPTCHAs, retries a
blocked session, or runs unattended; callers must send one JSON request on
stdin and receive one JSON response on stdout.
"""
from __future__ import annotations

import json
import os
import sys


def main() -> int:
    request = json.loads((sys.stdin.read() or "").lstrip("\ufeff") or "{}")
    query = str(request.get("query", "")).strip()
    page = max(1, int(request.get("page", 1)))
    page_size = min(100, max(1, int(request.get("pageSize", 50))))
    proxy = str(request.get("proxy", "")).strip()
    if not query:
        raise ValueError("query is required")

    try:
        from scholarly import scholarly  # type: ignore
    except Exception as exc:  # pragma: no cover - exercised in packaged smoke
        raise RuntimeError("scholarly 未安装，请安装 sidecars/requirements.txt") from exc

    if proxy:
        # scholarly exposes arbitrary proxy URLs through ProxyGenerator rather
        # than a direct set_proxy helper.  A failed setup is surfaced to the
        # renderer as a partial source failure; the adapter never falls back
        # to an ambient proxy silently.
        from scholarly import ProxyGenerator  # type: ignore
        generator = ProxyGenerator()
        if not generator.SingleProxy(http=proxy, https=proxy):
            raise RuntimeError("scholarly 无法启用配置的代理")
        scholarly.use_proxy(generator)

    iterator = scholarly.search_pubs(query)
    skip = (page - 1) * page_size
    for _ in range(skip):
        next(iterator)

    items = []
    for _ in range(page_size):
        try:
            item = next(iterator)
        except StopIteration:
            break
        bib = item.get("bib", {}) if isinstance(item, dict) else {}
        title = str(bib.get("title", "")).strip()
        if not title:
            continue
        authors = bib.get("author", [])
        if isinstance(authors, str):
            authors = [authors]
        items.append({
            "sourceId": str(item.get("author_pub_id") or item.get("pub_url") or f"scholar-{skip + len(items)}"),
            "title": title,
            "authors": [str(value) for value in authors if str(value).strip()],
            "year": int(bib["pub_year"]) if str(bib.get("pub_year", "")).isdigit() else None,
            "venue": str(bib.get("venue", "")).strip(),
            "abstract": str(bib.get("abstract", "")).strip(),
            "doi": None,
            "url": str(item.get("pub_url") or "").strip() or None,
            "isOpenAccess": None,
            "openMetric": None,
        })

    print(json.dumps({"items": items, "hasMore": len(items) == page_size}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        raise SystemExit(1)
