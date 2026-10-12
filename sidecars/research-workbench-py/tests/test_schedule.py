# -*- coding: utf-8 -*-
"""schedule.py 的自检：cron 引擎 / 输出目录安全谓词 / 数据库存取器 / 到点判定与阻断。

    python -m unittest test_schedule -v
"""
from __future__ import annotations

import os
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import tempfile
import unittest
from pathlib import Path
from datetime import datetime

# 先指到临时库，再 import workflow（DB_PATH 是导入期常量）
_TMP = tempfile.mkdtemp(prefix="rw-sched-test-")
os.environ["RESEARCH_WORKBENCH_DB"] = os.path.join(_TMP, "t.sqlite3")

import schedule          # noqa: E402
import workflow          # noqa: E402

_DB = Path(os.environ["RESEARCH_WORKBENCH_DB"])
schedule.DB_PATH = _DB


class TestCron(unittest.TestCase):
    def test_valid_and_invalid(self):
        for good in ("0 9 * * *", "*/15 * * * *", "30 8 * * 1-5", "0 9 1 * *", "0 0 * * 0", "5,35 * * * *", "0 9 * 1-6 1-5/2"):
            self.assertTrue(schedule.valid(good)[0], good)
        for bad in ("", "0 9 * *", "0 9 * * 9", "60 9 * * *", "*/0 * * * *", "* 24 * * *", "0-5-9 * * * *"):
            ok, why = schedule.valid(bad)
            self.assertFalse(ok, f"{bad!r} 应该被拒绝")
            self.assertTrue(why)

    def test_next_after(self):
        base = datetime(2026, 10, 8, 16, 40)          # 周四 16:40
        self.assertEqual(schedule.next_after("0 9 * * *", base), datetime(2026, 10, 9, 9, 0))
        self.assertEqual(schedule.next_after("*/15 * * * *", base), datetime(2026, 10, 8, 16, 45))
        self.assertEqual(schedule.next_after("0 9 * * 1-5", datetime(2026, 10, 9, 18, 0)), datetime(2026, 10, 12, 9, 0))
        self.assertEqual(schedule.next_after("0 9 * * 0", base), datetime(2026, 10, 11, 9, 0))    # 周日
        self.assertEqual(schedule.next_after("0 9 1 * *", base), datetime(2026, 11, 1, 9, 0))

    def test_matches_and_dow_aliases(self):
        self.assertTrue(schedule.matches("30 8 * * 1-5", datetime(2026, 10, 9, 8, 30)))             # 周五
        self.assertFalse(schedule.matches("30 8 * * 1-5", datetime(2026, 10, 10, 8, 30)))           # 周六
        self.assertTrue(schedule.matches("0 9 * * 7", datetime(2026, 10, 11, 9, 0)))                # 7 = 周日
        # 日与周都受限 → 取「或」（POSIX）
        self.assertTrue(schedule.matches("0 0 1 * 0", datetime(2026, 11, 1, 0, 0)))                 # 既是 1 号又是周日
        self.assertTrue(schedule.matches("0 0 1 * 0", datetime(2026, 12, 6, 0, 0)))                 # 只是周日
        self.assertTrue(schedule.matches("0 0 1 * 0", datetime(2026, 12, 1, 0, 0)))                 # 只是 1 号
        self.assertFalse(schedule.matches("0 0 1 * 0", datetime(2026, 12, 2, 0, 0)))

    def test_describe(self):
        self.assertIn("不可用", schedule.describe("bad cron"))
        self.assertRegex(schedule.describe("0 9 * * *"), r"^\d{2}-\d{2} \d{2}:\d{2}$")


class TestOutputDir(unittest.TestCase):
    def test_predicate(self):
        for ok_value in ("定时任务", "定时任务/日报", "a b/c"):
            self.assertTrue(schedule.inspect_output_dir(ok_value)[0], ok_value)
        for bad, why in (("", "不能为空"), ("/abs", "相对路径"), ("C:/x", "相对路径"),
                         ("../x", ".."), (".obsidian", "隐藏目录"), ("a/../b", "..")):
            ok, msg = schedule.inspect_output_dir(bad)
            self.assertFalse(ok, bad)
            self.assertIn(why, msg)


class TestStore(unittest.TestCase):
    def setUp(self):
        with workflow.WorkflowDB(_DB) as db:
            for row in db.schedules():
                db.schedule_delete(row["id"])
            db.schedule_run_delete([r["id"] for r in db.schedule_runs()])

    def make(self, **over):
        data = {"name": "每日摘要", "prompt": "写摘要", "project_id": "", "frequency": "daily",
                "cron": "0 9 * * *", "output_dir": "定时任务", "enabled": True,
                "next_run_at": schedule.next_run_at("0 9 * * *")}
        data.update(over)
        with workflow.WorkflowDB(_DB) as db:
            return db.schedule_save(data)

    def test_save_update_delete(self):
        row = self.make()
        self.assertTrue(row["id"] and row["enabled"] == 1 and row["next_run_at"])
        again = self.make(id=row["id"], name="改名了", enabled=False)
        self.assertEqual(again["id"], row["id"])
        self.assertEqual(again["name"], "改名了")
        self.assertEqual(again["enabled"], 0)
        with workflow.WorkflowDB(_DB) as db:
            self.assertEqual(len(db.schedules()), 1)
            db.schedule_delete(row["id"])
            self.assertEqual(db.schedules(), [])

    def test_runs_upsert_and_cascade(self):
        row = self.make()
        run = {"id": "r1", "schedule_id": row["id"], "name": row["name"], "trigger": "manual",
               "status": "running", "started_at": "2026-10-08T10:00:00"}
        with workflow.WorkflowDB(_DB) as db:
            db.schedule_run_add(run)
            self.assertEqual(db.schedule_runs()[0]["status"], "running")
            run.update({"status": "completed", "ended_at": "2026-10-08T10:01:00", "output_path": "x.md"})
            db.schedule_run_add(run)                      # 同 id 覆盖写
            rows = db.schedule_runs()
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["status"], "completed")
            self.assertEqual(rows[0]["output_path"], "x.md")
            self.assertEqual(db.schedule_run_delete(["r1"]), 1)
        with workflow.WorkflowDB(_DB) as db:
            db.schedule_run_add({"id": "r2", "schedule_id": row["id"], "started_at": "2026-10-08T11:00:00"})
            db.schedule_delete(row["id"])                 # 归档任务连带删运行记录
            self.assertEqual(db.schedule_runs(), [])

    def test_due_list_skips_manual_and_disabled(self):
        past = "2000-01-01T00:00:00"
        self.make(name="自动", frequency="daily", next_run_at=past)
        self.make(name="手动", frequency="manual", next_run_at=past)
        self.make(name="暂停", enabled=False, next_run_at=past)
        names = [s["name"] for s in schedule.due_list(datetime(2026, 10, 8, 16, 40))]
        self.assertEqual(names, ["自动"])

    def test_run_once_blocks_without_project(self):
        row = self.make()
        run = schedule.run_once(row, trigger="manual")
        self.assertEqual(run["status"], "blocked")
        self.assertIn("未绑定项目", run["reason"])
        self.assertEqual(run["output_path"], "")
        with workflow.WorkflowDB(_DB) as db:          # 阻断也要落记录 + 重排下次
            rows = db.schedule_runs()
            self.assertEqual(rows[0]["status"], "blocked")
            again = db.schedule(row["id"])
            self.assertTrue(again["last_run_at"])

    def test_run_once_blocks_on_bad_cron(self):
        with workflow.WorkflowDB(_DB) as db:
            pid = db.create_task("测试项目", "问题", "体系", "")
        row = self.make(project_id=pid, cron="0 9 * *")     # 绑了项目才能走到 cron 这一关
        run = schedule.run_once(row, trigger="manual")
        self.assertEqual(run["status"], "blocked")
        self.assertIn("Cron 不可用", run["reason"])

    def test_run_once_blocks_on_bad_output_dir(self):
        with workflow.WorkflowDB(_DB) as db:
            pid = db.create_task("测试项目", "问题", "体系", "")
        row = self.make(project_id=pid, output_dir="../escape")
        run = schedule.run_once(row, trigger="manual")
        self.assertEqual(run["status"], "blocked")
        self.assertIn("..", run["reason"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
