# -*- coding: utf-8 -*-
"""团队 v2 自检：成员从助手选（≤5）/ 交接规则 / 团队群记录 / 自动接力跑一轮。

    python -m unittest test_team_chat -v
"""
from __future__ import annotations

import os
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pathlib
import tempfile
import unittest

_p = pathlib.Path(tempfile.gettempdir()) / "team2_unit.sqlite3"
os.environ["RESEARCH_WORKBENCH_DB"] = str(_p)

import team  # noqa: E402
import workflow  # noqa: E402

team.DB_PATH = _p


class TeamChatTest(unittest.TestCase):
    def setUp(self) -> None:
        team.DB_PATH = _p
        if _p.exists():
            _p.unlink()
        with workflow.WorkflowDB(_p) as db:
            self.scope = db.create_chat("团队群")
        team.ensure_leader(self.scope)

    def _pick(self, aid: str = "builtin-searcher") -> dict:
        return team.add_assistant(self.scope, aid)

    # ---------- 交接规则（纯函数，最值得测） ----------
    def test_01_next_speaker_rules(self):
        names = ["甲", "乙", "丙"]
        self.assertEqual(team.next_speaker("", names, None), "甲")            # 开头轮到第一个
        self.assertEqual(team.next_speaker("我干完了", names, "甲"), "乙")     # 没说 @ 就顺序轮
        self.assertEqual(team.next_speaker("乙，你来补充", names, "甲"), "乙")  # 点名（无 @）
        self.assertEqual(team.next_speaker("@丙 你核对数字", names, "甲"), "丙")  # @ 定向
        self.assertIsNone(team.next_speaker("这件事完成", names, "甲"))         # 收工词散会
        self.assertIsNone(team.next_speaker("@甲", [], "甲"))                  # 没人了就停
        self.assertEqual(team.next_speaker("", names, "丙"), "甲")             # 轮到尾巴回开头

    # ---------- 成员 = 从助手里选，最多 5 个 ----------
    def test_02_members_are_assistants_and_capped(self):
        self.assertEqual(team.picks(self.scope), [])
        m = self._pick()
        self.assertEqual(m["name"], "文献检索员")
        self.assertEqual(m["role"], "member")
        self.assertEqual(m["color"], 1)                    # 0 号色留给 Leader
        self.assertEqual(team.color_of(m), "#5c9ea4")
        with self.assertRaises(ValueError):
            self._pick()                                   # 同一个助手不许进两次
        for aid in ("builtin-writer", "builtin-reviewer", "builtin-extractor"):
            team.add_assistant(self.scope, aid)
        self.assertEqual(len(team.picks(self.scope)), 4)
        with self.assertRaises(ValueError) as e:           # 第 6 个（这里已是第 5 个之外）
            team.add_assistant(self.scope, "a-new")
        self.assertIn("没有这个助手", str(e.exception))     # 先撞「助手不存在」
        with workflow.WorkflowDB(_p) as db:                # 造 5 个助手把上限顶满
            for i in range(5):
                db.assistant_save("x-%d" % i, name="凑数%d" % i)
        team.add_assistant(self.scope, "x-0")
        self.assertEqual(len(team.picks(self.scope)), 5)   # 满 5 个
        with self.assertRaises(ValueError) as e:
            team.add_assistant(self.scope, "x-1")
        self.assertIn("最多 5 个", str(e.exception))

    def test_03_leader_is_not_a_pick(self):
        team.ensure_leader(self.scope)
        self.assertEqual(len(team.picks(self.scope)), 0)
        with self.assertRaises(ValueError):
            team.remove_member(team.members(self.scope)[0]["id"])

    # ---------- 群记录：谁说的都记下来 ----------
    def test_04_say_writes_user_row(self):
        self._pick()
        team.say(self.scope, "先检索一下 O3 钠电掺杂的近三年论文", start=False)
        tr = team.transcript(self.scope)
        self.assertEqual(tr[-1]["role"], "user")
        self.assertEqual(tr[-1]["sender"], "你")
        self.assertIn("O3", tr[-1]["content"])

    # ---------- 自动接力：成员互相 @，一轮接一轮，收工就停 ----------
    def test_05_relay_hands_off_and_stops(self):
        with workflow.WorkflowDB(_p) as db:
            db.assistant_save("w-1", name="检索员", rules="只检索")
            db.assistant_save("w-2", name="写手", rules="只写")
            db.add_model("假模型", "http://127.0.0.1:1/v1", "fake", "sk", activate=True)
        team.add_assistant(self.scope, "w-1")
        team.add_assistant(self.scope, "w-2")
        team.say(self.scope, "把这段梳理成摘要", start=False)
        said = []

        def fake(name, messages, tools=None, **kw):
            who = "检索员" if "检索员" in str(messages[-1].get("content", "")) else "写手"
            said.append(who)
            body = "@写手 你来写" if who == "检索员" else "完成"
            return {"role": "assistant", "content": body, "tool_calls": []}

        old = workflow.chat_raw
        workflow.chat_raw = fake
        try:
            team._round(self.scope, 4)                     # 同步跑，别用线程
        finally:
            workflow.chat_raw = old
        tr = team.transcript(self.scope)
        senders = [x["sender"] for x in tr]
        self.assertIn("检索员", senders)
        self.assertIn("写手", senders)
        self.assertEqual(senders[-1], "系统")               # 收到「完成」→ 系统收工
        self.assertIn("收工", tr[-1]["content"])
        self.assertNotIn(self.scope, team.TEAM_RUNS)          # 跑完清干净

    def test_06_member_failure_does_not_kill_team(self):
        with workflow.WorkflowDB(_p) as db:
            db.assistant_save("bad-1", name="会炸的")
            db.add_model("假模型", "http://127.0.0.1:1/v1", "fake", "sk", activate=True)
        team.add_assistant(self.scope, "bad-1")
        team.say(self.scope, "随便做点什么", start=False)

        def boom(name, messages, tools=None, **kw):
            raise RuntimeError("模型挂了")

        old = workflow.chat_raw
        workflow.chat_raw = boom
        try:
            team._round(self.scope, 2)
        finally:
            workflow.chat_raw = old
        tr = team.transcript(self.scope)
        self.assertTrue(any("失败" in (x["content"] or "") for x in tr))
        self.assertEqual(tr[-1]["sender"], "系统")

    def test_07_chat_state_shape(self):
        self._pick()
        st = team.chat_state(self.scope)
        self.assertIn("members", st)
        self.assertEqual(st["max"], 5)
        self.assertEqual(len(st["palette"]), 6)
        self.assertTrue(st["colors"])
        self.assertIsNone(st["running"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
