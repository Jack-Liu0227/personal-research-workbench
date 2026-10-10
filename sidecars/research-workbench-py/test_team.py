# -*- coding: utf-8 -*-
"""team.py 的自检：成员与 Leader 规则 / 派活 / 串行队列状态流转 / 失败留痕 / Leader 的工具派活。

    python -m unittest test_team -v
"""
from __future__ import annotations

import os
import pathlib
import tempfile
import unittest

os.environ["RESEARCH_WORKBENCH_DB"] = str(pathlib.Path(tempfile.gettempdir()) / "team_test.sqlite3")
_p = pathlib.Path(os.environ["RESEARCH_WORKBENCH_DB"])
if _p.exists():
    _p.unlink()

import team                      # noqa: E402
import workflow                  # noqa: E402

team.DB_PATH = _p


class TeamTest(unittest.TestCase):
    def setUp(self) -> None:
        team.DB_PATH = _p          # 每个用例都把团队库指回自己的（多模块一起跑时别串）
        if _p.exists():
            _p.unlink()                       # 每个用例一个干净库：队列是全库轮询的，不隔离会互相串
        with workflow.WorkflowDB(_p) as db:
            self.tid = db.create_task("测试项目", "问题", "体系", "")
            db.add_model("假模型", "http://127.0.0.1:1/v1", "fake", "sk", activate=True)

    def test_leader_seeded_once_and_immutable(self) -> None:
        ms = team.members(self.tid)
        self.assertEqual(len(ms), 1)
        self.assertEqual(ms[0]["role"], "leader")
        self.assertEqual(team.members(self.tid)[0]["id"], ms[0]["id"])       # 幂等，不会重复播种
        with self.assertRaises(ValueError):
            team.remove_member(ms[0]["id"])                                  # AionUi 同款：Leader 不可移除

    def test_assign_requires_existing_member(self) -> None:
        with self.assertRaises(ValueError):
            team.assign(self.tid, "查无此人", "干活")
        m = team.add_member(self.tid, "检索员", "search")
        row = team.assign(self.tid, "检索员", "检索钠电掺杂")
        self.assertEqual(row["status"], "queued")
        self.assertEqual(row["member_name"], "检索员")
        self.assertEqual([x for x in team.members(self.tid) if x["id"] == m["id"]][0]["status"], "queued")

    def test_queue_runs_one_and_records_events(self) -> None:
        team.add_member(self.tid, "写手", "write")
        row = team.assign(self.tid, "写手", "写一段引言")

        def fake_chat_raw(profile, messages, tools=None, **kw):
            return {"role": "assistant", "content": "写好了：引言……", "tool_calls": []}

        old = workflow.chat_raw
        workflow.chat_raw = fake_chat_raw
        try:
            n = team.tick()
        finally:
            workflow.chat_raw = old
        self.assertEqual(n, 1)
        b = team.board(self.tid)
        t = [x for x in b["tasks"] if x["id"] == row["id"]][0]
        self.assertEqual(t["status"], "done")
        self.assertTrue(t["output_path"])
        self.assertTrue(pathlib.Path(t["output_path"]).is_file())            # 产物真落盘
        kinds = [e["kind"] for e in t["events"]]
        for k in ("assign", "start", "assistant", "done"):
            self.assertIn(k, kinds)                                          # 看板的事件流有料
        self.assertEqual(b["counts"].get("done"), 1)

    def test_failure_is_recorded_not_raised(self) -> None:
        team.add_member(self.tid, "倒霉蛋")
        row = team.assign(self.tid, "倒霉蛋", "会炸的活")

        def boom(profile, messages, tools=None, **kw):
            raise RuntimeError("模型挂了")

        old = workflow.chat_raw
        workflow.chat_raw = boom
        try:
            team.tick()                                                       # 不许把异常抛出去
        finally:
            workflow.chat_raw = old
        t = [x for x in team.board(self.tid)["tasks"] if x["id"] == row["id"]][0]
        self.assertEqual(t["status"], "failed")
        self.assertIn("模型挂了", t["reason"])

    def test_cancel_and_retry(self) -> None:
        team.add_member(self.tid, "闲人")
        row = team.assign(self.tid, "闲人", "一件不急的事")
        team.cancel(row["id"])
        self.assertEqual(team.board(self.tid)["counts"].get("canceled"), 1)
        team.retry(row["id"])
        self.assertEqual(team.board(self.tid)["counts"].get("queued"), 1)

    def test_leader_tool_dispatch(self) -> None:
        """Leader 通过工具派活：项目内可直接派；首页通用对话必须点名项目，不许瞎猜。"""
        team.add_member(self.tid, "检索员", "search")
        with workflow.WorkflowDB(_p) as db:
            out = workflow._tool_impl("team_assign", db, self.tid, {"member": "检索员", "prompt": "检索一下"})
            self.assertEqual(out["status"], "queued")
            b = workflow._tool_impl("team_board", db, self.tid, {})
            self.assertEqual(len(b["members"]), 2)
            self.assertIn("单进程串行队列", b["serial_note"])
            chat = db.create_chat("通用对话")
            with self.assertRaises(ValueError):
                workflow._tool_impl("team_assign", db, chat, {"member": "检索员", "prompt": "x"})
            out2 = workflow._tool_impl("team_assign", db, chat, {"project": "测试项目", "member": "检索员", "prompt": "再检索"})
            self.assertEqual(out2["task_id"], self.tid)


if __name__ == "__main__":
    unittest.main()
