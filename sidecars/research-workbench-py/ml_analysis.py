from __future__ import annotations

import csv
import json
import math
from pathlib import Path
from typing import Any


def _read_rows(path: str | Path, target: str) -> tuple[list[list[float]], list[float]]:
    with Path(path).open(newline="", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    if not rows or target not in rows[0]:
        raise ValueError(f"CSV needs rows and target column: {target}")
    features = [k for k in rows[0] if k != target]
    if not features:
        raise ValueError("CSV needs at least one feature column")
    X, y = [], []
    for row in rows:
        try:
            X.append([float(row[k]) for k in features])
            y.append(float(row[target]))
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError(f"non-numeric CSV row: {row}") from exc
    return X, y


def _predict_mean(y_train: list[float], n: int) -> list[float]:
    mean = sum(y_train) / len(y_train)
    return [mean] * n


def _metrics(y_true: list[float], pred: list[float]) -> dict[str, float]:
    mae = sum(abs(a - b) for a, b in zip(y_true, pred)) / len(y_true)
    mean = sum(y_true) / len(y_true)
    ss_tot = sum((v - mean) ** 2 for v in y_true)
    ss_res = sum((a - b) ** 2 for a, b in zip(y_true, pred))
    return {"mae": mae, "r2": 1 - ss_res / ss_tot if ss_tot else 0.0}


def baseline(path: str | Path, target: str, output: str | Path | None = None) -> dict[str, Any]:
    X, y = _read_rows(path, target)
    split = max(1, math.floor(len(y) * 0.8))
    if split >= len(y):
        split = len(y) - 1
    if split < 1:
        raise ValueError("at least two rows are required")
    # ponytail: deterministic mean baseline, not a model-selection claim; add sklearn only when data volume justifies it.
    pred = _predict_mean(y[:split], len(y) - split)
    result = {
        "model": "mean-baseline",
        "target": target,
        "rows": len(y),
        "features": len(X[0]),
        "split": {"train": split, "test": len(y) - split},
        "metrics": _metrics(y[split:], pred),
        "warning": "baseline only; no causal or extrapolation claim",
    }
    if output:
        p = Path(output).resolve(); p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        result["artifact"] = str(p)
    return result
