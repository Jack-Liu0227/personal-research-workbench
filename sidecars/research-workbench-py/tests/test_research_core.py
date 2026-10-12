import tempfile
import unittest
from pathlib import Path

import pdfio
from _pdf_fixture import write_text_pdf
from research_core import ResearchDB


class CoreTest(unittest.TestCase):
    def test_ingest_is_hash_deduplicated_and_evidence_keeps_page(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); pdf = root / "paper.pdf"
            write_text_pdf(pdf, ["CuO material was sintered at 800 C and reached 120 MPa."])
            db = ResearchDB(root / "research.sqlite3")
            task = db.create_task("Cu test", "What is the process?", "CuO")
            first = db.ingest_pdf(task, pdf); second = db.ingest_pdf(task, pdf)
            self.assertEqual(first["id"], second["id"])
            rows = db.extract_materials(first["id"])
            self.assertTrue(rows)
            self.assertTrue(all(r["page_no"] == 1 and r["excerpt"] for r in rows))
            self.assertEqual(db.summary(task)["papers"], 1)
            with self.assertRaises(ValueError):
                db.add_evidence(first["id"], {"field": "bad", "value": "1", "page_no": 1, "excerpt": "not in source"})
            accepted = db.add_evidence(first["id"], {"field": "method", "value": "sintered", "page_no": 1, "excerpt": "CuO material was sintered"})
            self.assertEqual(accepted["page_no"], 1)
            exported = db.export_evidence(task, root / "out" / "evidence.json")
            self.assertTrue(exported.is_file())
            self.assertIn("sintered", exported.read_text(encoding="utf-8"))
            report = db.export_report(task, root / "out" / "report.md")
            self.assertIn("CuO", report.read_text(encoding="utf-8"))
            self.assertIn("p.1", report.read_text(encoding="utf-8"))
            db.close()


if __name__ == "__main__":
    unittest.main()
