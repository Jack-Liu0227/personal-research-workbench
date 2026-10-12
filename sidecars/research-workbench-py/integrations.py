from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any




def _safe_name(value: str) -> str:
    value = re.sub(r"[^\w\- .()\u4e00-\u9fff]", "_", value).strip()
    return value[:120] or "research-note"




def zotero_preview(item: dict[str, Any]) -> dict[str, Any]:
    """Create a Zotero Connector-compatible item payload; does not write."""
    title = str(item.get("title", "")).strip()
    if not title:
        raise ValueError("title is required")
    payload = {
        "itemType": item.get("itemType", "journalArticle"),
        "title": title,
        "creators": item.get("creators", []),
        "abstractNote": item.get("abstractNote", ""),
        "date": item.get("date", ""),
        "publicationTitle": item.get("publicationTitle", ""),
        "DOI": item.get("DOI", ""),
        "url": item.get("url", ""),
        "tags": item.get("tags", []),
    }
    return {"kind": "zotero-preview", "confirm_token": _token(payload), "payload": payload}


def obsidian_preview(vault: str | Path, title: str, markdown: str) -> dict[str, Any]:
    vault = Path(vault).expanduser().resolve()
    if not vault.is_dir():
        raise FileNotFoundError(f"Obsidian Vault not found: {vault}")
    safe = _safe_name(title) + ".md"
    target = vault / safe
    if vault not in target.parents:
        raise ValueError("invalid Vault target")
    return {
        "kind": "obsidian-preview",
        "confirm_token": _token({"target": str(target), "markdown": markdown}),
        "vault": str(vault),
        "target": str(target),
        "markdown": markdown,
        "exists": target.exists(),
    }


def apply_obsidian_preview(preview: dict[str, Any], confirm_token: str) -> dict[str, Any]:
    if preview.get("confirm_token") != confirm_token:
        raise PermissionError("confirmation token does not match preview")
    target = Path(preview["target"]).resolve()
    vault = Path(preview["vault"]).resolve()
    if vault not in target.parents:
        raise PermissionError("target escaped Vault")
    if target.exists():
        raise FileExistsError(f"refusing overwrite: {target}")
    target.write_text(preview["markdown"], encoding="utf-8")
    return {"written": True, "target": str(target)}


def _token(payload: dict[str, Any]) -> str:
    import hashlib
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:16]
