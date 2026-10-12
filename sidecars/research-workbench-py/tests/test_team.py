# team.py 的自检：成员与 Leader 规则 / 派活 / 串行队列状态流转 / 失败留痕 / Leader 的工具派活。
# 
# python -m unittest test_team -v
from __future__ import annotations
import os
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pathlib
import tempfile
import unittest
# 多团队（2 固定 + 3 机动）+ 固定团队预置成员 + 助手=模型 的自检。
# python -m unittest test_teams -v
# 团队 v2 自检：成员从助手选（≤5）/ 交接规则 / 团队群记录 / 自动接力跑一轮。
# python -m unittest test_team_chat -v


# ---------------- 来自 test_team.py ----------------
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


# ---------------- 来自 test_teams.py ----------------
_p = pathlib.Path(tempfile.gettempdir()) / "teams_unit.sqlite3"
os.environ["RESEARCH_WORKBENCH_DB"] = str(_p)

import team  # noqa: E402
import workflow  # noqa: E402

team.DB_PATH = _p


class TeamsTest(unittest.TestCase):
    def setUp(self) -> None:
        if _p.exists():
            _p.unlink()
        team.DB_PATH = _p
        with workflow.WorkflowDB(_p) as db:
            self.db = db

    def _t(self, tid):
        with workflow.WorkflowDB(_p) as db:
            return db.team(tid)

    # ---------- 固定位 ----------
    def test_01_two_fixed_seeded_idempotent(self):
        a = team.ensure_defaults()
        fixed = [x for x in a if x["kind"] == "fixed"]
        self.assertEqual([x["name"] for x in fixed], ["论文精读", "论文写作"])
        b = team.ensure_defaults()
        self.assertEqual(len(b), 2)                       # 幂等，不重复播
        self.assertEqual(team.teams()["fixed"], 2)
        with self.assertRaises(ValueError):
            team.new_team("fixed")                        # 第 3 个固定位不给

    def test_01b_fixed_teams_preseeded_roster(self):
        """两个固定团队各预置 3 个成员（按助手名字找），再调一次不会重复拉人。"""
        team.ensure_defaults()
        want = {"论文精读": ["分块员", "图表解读员", "论文精读"],
                "论文写作": ["结构规划员", "论文写作", "论文审查"]}
        for t in team.teams()["teams"]:
            if t["kind"] != "fixed":
                continue
            names = [m["name"] for m in team.picks(t["id"])]
            self.assertEqual(names, want[t["name"]], t["name"])
            for m in team.picks(t["id"]):
                self.assertTrue(m["assistant_id"])        # 每个成员都挂在助手上
                self.assertGreaterEqual(m["color"], 1)    # Leader 占 0 号色
        again = [m["name"] for t in team.teams()["teams"] if t["name"] == "论文精读"
                 for m in team.picks(t["id"])]
        self.assertEqual(again, want["论文精读"])          # 幂等：还是 3 个

    # ---------- 机动位 ----------
    def test_02_three_temp_then_full(self):
        t1 = team.new_team("temp")
        t2 = team.new_team("temp")
        t3x = team.new_team("temp")
        self.assertEqual(team.teams()["temp"], 3)
        with self.assertRaises(ValueError) as e:
            team.new_team("temp")                         # 三个都在用 → 不给
        self.assertIn("都在用", str(e.exception))
        team.release(t1["id"])                            # t1 用完 → 释放
        self.assertEqual(team.teams()["temp"], 3)
        t3 = team.new_team("temp")                        # 用完的自动回收 → 又能建
        self.assertNotEqual(t3["id"], t1["id"])
        ids = [x["id"] for x in team.teams()["teams"]]
        self.assertNotIn(t1["id"], ids)                   # 旧的已收掉
        self.assertIn(t3["id"], ids)

    def test_03_release_frees_members(self):
        with workflow.WorkflowDB(_p) as db:
            db.assistant_save("w-1", name="甲")
        t = team.new_team("temp")
        team.add_assistant(t["id"], "w-1")
        self.assertEqual(len(team.picks(t["id"])), 1)
        team.release(t["id"])
        self.assertEqual(len(team.picks(t["id"])), 0)     # 成员让出来了
        self.assertEqual(self._t(t["id"])["status"], "done")

    def test_04_total_cap_five(self):
        team.ensure_defaults()
        team.new_team("temp")
        team.new_team("temp")
        team.new_team("temp")
        self.assertEqual(len(team.teams()["teams"]), 5)
        team.release([x for x in team.teams()["teams"] if x["kind"] == "temp"][0]["id"])
        with self.assertRaises(ValueError):
            team.new_team("fixed")

    # ---------- 解散 ----------
    def test_05_fixed_cannot_dissolve(self):
        fx = [x for x in team.ensure_defaults() if x["kind"] == "fixed"][0]
        with self.assertRaises(ValueError):
            team.dissolve(fx["id"])
        t = team.new_team("temp")
        self.assertTrue(team.dissolve(t["id"])["ok"])
        self.assertIsNone(self._t(t["id"]))

    def test_06_rename(self):
        t = team.new_team("temp")
        team.rename_team(t["id"], "换名字")
        self.assertEqual(self._t(t["id"])["name"], "换名字")
        with self.assertRaises(ValueError):
            team.rename_team(t["id"], "  ")

    # ---------- 助手 = 模型接入 ----------
    def test_07_agent_profile_follows_assistant_model(self):
        with workflow.WorkflowDB(_p) as db:
            db.add_model("激活的", "http://127.0.0.1:1/v1", "active-model", "k", activate=True)
            m2 = db.add_model("deepseek", "https://api.deepseek.com/v1", "deepseek-chat", "k2")
            db.assistant_save("a-ds", name="deepseek 助手", model_id=m2["id"])
            cid = db.create_chat("接了 deepseek 的对话")
            # 没绑助手 → 用激活模型
            self.assertEqual(workflow.agent_profile(db, cid)["model"], "active-model")
            # 绑了助手 → 用助手接的那个模型（这就是「deepseek 接进去就是个助手」）
            db.set_chat_assistant(cid, "a-ds")
            self.assertEqual(workflow.agent_profile(db, cid)["model"], "deepseek-chat")
            self.assertEqual(workflow.agent_profile(db, cid)["name"], "deepseek")
            # 助手没指定模型 → 退回激活模型
            db.assistant_save("a-none", name="没指模型")
            db.set_chat_assistant(cid, "a-none")
            self.assertEqual(workflow.agent_profile(db, cid)["model"], "active-model")

    def test_08_member_model_shown(self):
        with workflow.WorkflowDB(_p) as db:
            db.add_model("deepseek", "https://api.deepseek.com/v1", "deepseek-chat", "k")
            db.assistant_save("a-ds", name="ds 助手", model_id=db.models()[0]["id"])
        t = team.new_team("temp")
        team.add_assistant(t["id"], "a-ds")
        st = team.chat_state(t["id"])
        self.assertEqual(st["team"]["id"], t["id"])
        mem = [m for m in st["members"] if m["role"] == "member"][0]
        self.assertEqual(mem["model"], "deepseek")        # 卡片上能看到它背后是哪个模型
        self.assertEqual(len(st["members"]), 2)           # Leader + 1 人


    # ---------- 老库迁移 ----------
    def test_09_legacy_placeholders_handed_over(self):
        """老库里的空占位「团队 1/2/3」：前两个被改名接手（并预置成员），多的转成「已收工」的机动，记录不删。"""
        for i in (1, 2, 3):
            with workflow.WorkflowDB(_p) as db:
                db.team_add("团队 %d" % i, "fixed")
        team.ensure_defaults()
        ts = team.teams()["teams"]
        fixed = [x["name"] for x in ts if x["kind"] == "fixed"]
        self.assertEqual(sorted(fixed), ["论文写作", "论文精读"])
        left = [x for x in ts if x["kind"] == "temp" and x["name"].startswith("团队")]
        self.assertEqual(len(left), 1)                    # 多出来的那一个转成了机动位
        self.assertEqual(left[0]["status"], "done")       # 标已收工，等着被回收
        self.assertEqual(team.teams()["fixed"], 2)


# ---------------- 来自 test_team_chat.py ----------------
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
    unittest.main()
