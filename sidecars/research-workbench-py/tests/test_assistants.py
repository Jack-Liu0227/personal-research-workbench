# -*- coding: utf-8 -*-
"""助手（照 AionUi Assistant）自检：内置播种 / 只读不可删 / 保存更新 / 对话绑定 / 规则进 system。

    python -m unittest test_assistants -v
"""
from __future__ import annotations

import json
import os
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pathlib
import tempfile
import unittest

_p = pathlib.Path(tempfile.gettempdir()) / "as_unit.sqlite3"
os.environ["RESEARCH_WORKBENCH_DB"] = str(_p)

import workflow  # noqa: E402


class AssistantTest(unittest.TestCase):
    def setUp(self) -> None:
        if _p.exists():
            _p.unlink()
        self.db = workflow.WorkflowDB(_p)

    def tearDown(self) -> None:
        self.db.close()

    def test_01_builtin_seeded_and_idempotent(self):
        a = self.db.assistants()
        self.assertEqual(len(a), 5)                                   # 4 个业务助手 + Pony 模式
        self.assertTrue(all(x["source"] == "builtin" for x in a))
        names = [x["name"] for x in a]
        self.assertIn("文献检索员", names)
        self.assertIn("Pony 模式", names)
        self.assertTrue([x for x in a if x["name"] == "Pony 模式"][0]["rules"])   # pony 规则非空
        self.db.assistant_seed(workflow.BUILTIN_ASSISTANTS)          # 再播一次
        self.assertEqual(len(self.db.assistants()), 5)                # 不重复
        self.assertTrue(all(json.loads(x["prompts"] or "[]") for x in a))   # 每个都有推荐问题

    def test_02_builtin_immutable_and_undeletable(self):
        with self.assertRaises(ValueError):
            self.db.assistant_delete("builtin-searcher")
        with self.assertRaises(ValueError):
            self.db.assistant_save("builtin-searcher", name="改了")
        self.assertEqual(self.db.assistant("builtin-searcher")["name"], "文献检索员")

    def test_03_user_crud(self):
        a = self.db.assistant_save("a-test1", name="我的助手", avatar="🧪", description="d",
                                   rules="只做检索", prompts=json.dumps(["问1", "问2"], ensure_ascii=False))
        self.assertEqual(a["source"], "user")
        a2 = self.db.assistant_save("a-test1", name="改名了", rules="只做检索 + 去重")
        self.assertEqual(a2["name"], "改名了")
        self.assertEqual(a2["rules"], "只做检索 + 去重")
        self.assertEqual(json.loads(a2["prompts"]), ["问1", "问2"])   # 没传的字段不动
        self.db.assistant_delete("a-test1")
        self.assertIsNone(self.db.assistant("a-test1"))

    def test_04_bind_to_chat(self):
        cid = self.db.create_chat("绑定测试")
        self.assertEqual(self.db.assistant_of_chat(cid), "")
        self.db.set_chat_assistant(cid, "builtin-searcher")
        self.assertEqual(self.db.assistant_of_chat(cid), "builtin-searcher")

    def test_05_rules_reach_system_ctx(self):
        """最要紧的一条：助手绑到对话后，它的名字与规则必须真的进 system。"""
        cid = self.db.create_chat("规则测试")
        self.db.set_chat_assistant(cid, "builtin-searcher")
        self.db.add_model("假模型", "http://127.0.0.1:1/v1", "fake", "sk", activate=True)
        seen = {}

        def fake(name, messages, tools=None, **kw):
            seen["msgs"] = messages
            return {"role": "assistant", "content": "收到", "tool_calls": []}

        old = workflow.chat_raw
        workflow.chat_raw = fake
        try:
            workflow.run_agent(self.db, cid, "帮我检索一下", publish=False)
        finally:
            workflow.chat_raw = old
        system = "\n".join(m["content"] for m in seen["msgs"] if m["role"] == "system")
        self.assertIn("【当前助手】", system)
        self.assertIn("文献检索员", system)
        self.assertIn("开放获取", system)          # 规则正文
        self.assertIn("全局 Leader", system)      # 原有 Leader 口径没被挤掉

    def test_06_unbound_chat_has_no_assistant_block(self):
        cid = self.db.create_chat("没绑助手")
        self.db.add_model("假模型", "http://127.0.0.1:1/v1", "fake", "sk", activate=True)
        seen = {}

        def fake(name, messages, tools=None, **kw):
            seen["msgs"] = messages
            return {"role": "assistant", "content": "收到", "tool_calls": []}

        old = workflow.chat_raw
        workflow.chat_raw = fake
        try:
            workflow.run_agent(self.db, cid, "在吗", publish=False)
        finally:
            workflow.chat_raw = old
        system = "\n".join(m["content"] for m in seen["msgs"] if m["role"] == "system")
        self.assertNotIn("【当前助手】", system)


if __name__ == "__main__":
    unittest.main(verbosity=2)
