from __future__ import annotations

import csv
import tempfile
import unittest
from pathlib import Path

from integrations import apply_obsidian_preview, obsidian_preview, zotero_preview
from ml_analysis import baseline


class IntegrationTest(unittest.TestCase):
    def test_preview_requires_explicit_apply_and_ml_runs(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            vault = root / "Vault"
            vault.mkdir()
            preview = obsidian_preview(vault, "evidence", "# Evidence")
            with self.assertRaises(PermissionError):
                apply_obsidian_preview(preview, "wrong")
            self.assertTrue(apply_obsidian_preview(preview, preview["confirm_token"])["written"])
            with (root / "data.csv").open("w", newline="", encoding="utf-8") as f:
                w = csv.writer(f); w.writerow(["Cu", "capacity"]); w.writerows([[1, 100], [2, 110], [3, 120], [4, 130], [5, 140]])
            result = baseline(root / "data.csv", "capacity", root / "ml.json")
            self.assertEqual(result["model"], "mean-baseline")
            self.assertTrue((root / "ml.json").is_file())
            self.assertEqual(zotero_preview({"title": "CuO"})["kind"], "zotero-preview")
