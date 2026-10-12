# -*- coding: utf-8 -*-
"""第 5 步「梳理精读」：谱系图读写 + 数据源 + 十步口径。"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import workflow  # noqa: E402


class MapStepTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp.name) / "t.sqlite3"
        os.environ["RESEARCH_WORKBENCH_DB"] = str(self.db_path)
        self.db = workflow.WorkflowDB(self.db_path)
        base = Path(self.tmp.name) / "proj"
        (base / "论文正文").mkdir(parents=True)
        (base / "笔记").mkdir()
        (base / "其余" / "数据").mkdir(parents=True)
        (base / "论文正文" / "框架.md").write_text(
            "# 题目\n\n## 1 引言\n\n### 1.1 背景\n- 说明：x\n\n### 1.2 现状\n- 说明：y\n", encoding="utf-8")
        (base / "笔记" / "精读-A.md").write_text("结论：Cu 掺杂带隙收窄\n", encoding="utf-8")
        (base / "其余" / "数据" / "XRD-2026-10.csv").write_text("2theta,int\n28.3,100\n", encoding="utf-8")
        self.tid = self.db.create_task("谱系项目", "q", "Na", str(base))

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def test_step_order_is_ten_with_map_after_outline(self):
        self.assertEqual(len(workflow.STAGES), 10)
        self.assertEqual(workflow.STAGES.index("map"), workflow.STAGES.index("outline") + 1)
        self.assertEqual(workflow.STAGE_LABEL["map"], "梳理精读")

    def test_write_read_roundtrip_and_dirty_data_dropped(self):
        r = workflow.map_write(self.db, self.tid, {
            "nodes": [{"id": "s1", "type": "section", "label": "1.1 背景", "detail": "背景"},
                      {"id": "p1", "type": "paper", "label": "Left2025", "detail": "带隙收窄", "ref": "精读-A.md"},
                      {"id": "x1", "type": "不认识的类型", "label": "杂项"},
                      {"label": "没有 id"},                                   # 丢
                      "不是字典"],                                            # 丢
            "edges": [{"from": "s1", "to": "p1", "label": "支撑"},
                      {"from": "s1", "to": "no-such-node"},                   # 丢
                      {"from": "p1", "to": "x1"}]})                           # 留（两边都在）
        self.assertEqual([n["id"] for n in r["nodes"]], ["s1", "p1", "x1"])
        self.assertEqual(r["nodes"][2]["type"], "note", "未知 type 兜成 note")
        self.assertEqual(len(r["edges"]), 2)
        self.assertEqual(r["sections"], 1)
        self.assertEqual(r["refs"], 2)
        self.assertTrue(r["exists"])
        again = workflow.map_read(self.db, self.tid)
        self.assertEqual(len(again["nodes"]), 3)
        self.assertEqual(json.loads(Path(r["path"]).read_text(encoding="utf-8"))["updated"], r["updated"])

    def test_read_empty_and_broken_json(self):
        empty = workflow.map_read(self.db, self.tid)
        self.assertFalse(empty["exists"])
        self.assertEqual((empty["nodes"], empty["edges"]), ([], []))
        Path(empty["path"]).parent.mkdir(parents=True, exist_ok=True)
        Path(empty["path"]).write_text("{坏 JSON", encoding="utf-8")
        broken = workflow.map_read(self.db, self.tid)
        self.assertTrue(broken["broken"])
        self.assertEqual(broken["nodes"], [])

    def test_sources_list_outline_notes_and_data(self):
        s = workflow.map_sources(self.db, self.tid)
        self.assertEqual(s["sections"], ["1.1 背景", "1.2 现状"])
        self.assertIn("精读-A.md", s["notes"])
        self.assertIn("XRD-2026-10.csv", s["data"])
        self.assertTrue(s["map_path"].endswith("谱系.json"))

    def test_tools_and_tool_impl(self):
        names = [t["function"]["name"] for t in workflow.map_tools()]
        self.assertIn("map_write", names)
        self.assertIn("map_sources", names)
        self.assertNotIn("doc_write", names, "这一步不该能改正文/框架")
        self.assertNotIn("cite_add", names)
        workflow._tool_impl("map_write", self.db, self.tid,
                            {"data": json.dumps({"nodes": [{"id": "s1", "type": "section", "label": "A"}], "edges": []})},
                            scope="map")
        self.assertEqual(workflow._tool_impl("map_read", self.db, self.tid, {}, scope="map")["sections"], 1)
        self.assertTrue(workflow._tool_impl("map_sources", self.db, self.tid, {}, scope="map")["sections"])


if __name__ == "__main__":
    unittest.main()
