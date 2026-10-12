"""科研工作 1.0 · 自检（不联网、不调模型）

    py -3.10 test_workflow.py

只跑确定性的部分：DB 新表、日历、模型档案、笔记、检索去重、格式转换、
以及「没有 OA 链接就不下载」这条法律/合规红线。
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import workflow
from workflow import SOURCES, WorkflowDB, download_pdf, run_agent, stage_convert, stage_notes


class WorkflowTest(unittest.TestCase):
    def setUp(self) -> None:
        self.td = tempfile.TemporaryDirectory()
        self.db = WorkflowDB(Path(self.td.name) / "wb.sqlite3")
        self.task = self.db.create_task("O3 掺杂", "哪种掺杂元素值得验证", "NaNi1/3Fe1/3Mn1/3O2")

    def tearDown(self) -> None:
        self.db.close()
        self.td.cleanup()

    def test_rss_fixed_sources_dedupe_and_filters(self) -> None:
        """情报日报：来源固定 5 个（seed 幂等）、网址校验、按 link 去重、三条件筛选。"""
        import rss as rss_mod

        with self.assertRaises(ValueError):
            self.db.add_rss_source("ftp://x/feed")
        self.assertEqual(rss_mod.seed(self.db), 5)                  # 固定 5 个来源
        self.assertEqual(rss_mod.seed(self.db), 0)                  # 再来一次不重复加
        self.assertEqual(len(self.db.rss_sources()), 5)
        self.assertEqual([s["title"] for s in self.db.rss_sources()][0], "Nature Energy")
        self.assertEqual([s["title"] for s in self.db.rss_sources()],
                         ["Nature Energy", "Nature Materials", "npj Computational Materials",
                          "arXiv cond-mat.mtrl-sci", "Hacker News"])

        src = self.db.rss_source(self.db.rss_sources()[0]["id"])
        items = [{"title": "钠电正极掺杂", "link": "https://a.example/1", "authors": "Zhang",
                  "summary": "Cu 掺杂", "published_at": "2026-10-06 08:30"},
                 {"title": "第二条", "link": "https://a.example/2", "authors": "",
                  "summary": "没有日期", "published_at": ""}]
        self.assertEqual(self.db.save_rss_items(src, items), 2)
        self.assertEqual(self.db.save_rss_items(src, items), 0)     # 按 link 去重 → 再存 0 新增
        self.assertEqual(self.db.rss_count(), 2)
        self.assertEqual(self.db.rss_count(q="掺杂"), 1)
        self.assertEqual(self.db.rss_count(q="没有"), 1)
        self.assertEqual(self.db.rss_count(year="2026"), 1)
        self.assertEqual(self.db.rss_count(year="1999"), 0)
        self.assertEqual(self.db.rss_count(source_id=src["id"]), 2)

        rows = self.db.rss_items()
        self.assertEqual(rows[0]["title"], "钠电正极掺杂")           # 有日期的排前面，空日期垫底
        self.assertEqual(rows[0]["source_title"], "Nature Energy")   # 条目带来源名
        self.assertEqual(self.db.rss_sources()[0]["count"], 2)

    def test_md_notes_optional_project_binding(self) -> None:
        """大笔记可选绑项目：绑 → 解绑 → 再绑；不传 task_id 时保持原绑定。"""
        n = self.db.save_md_note("", "锂电随手记", "# 初稿", self.task)
        self.assertEqual(n["task_id"], self.task)
        self.assertEqual(self.db.md_notes()[0]["task_id"], self.task)
        n2 = self.db.save_md_note(n["id"], "锂电随手记", "# 改过", "")       # 传 "" = 解绑
        self.assertEqual(n2["task_id"], "")
        self.assertEqual(n2["content"], "# 改过")
        self.db.save_md_note(n["id"], "锂电随手记", "# 改过", self.task)     # 再绑回去
        self.assertEqual(self.db.md_note(n["id"])["task_id"], self.task)
        self.db.save_md_note(n["id"], "锂电随手记", "# 再改", None)          # 不传 = 保持
        self.assertEqual(self.db.md_note(n["id"])["task_id"], self.task)
        self.assertEqual(self.db.md_note(n["id"])["content"], "# 再改")

    def test_reading_note_binds_paper(self) -> None:
        """「阅读笔记」绑论文：一篇论文只有一篇；不传 paper_id 时保持绑定；空白起步。"""
        pid = "paper-abc"
        note = self.db.save_md_note("", "阅读笔记", "", self.task, pid)
        self.assertEqual((note["paper_id"], note["task_id"], note["content"]), (pid, self.task, ""))
        self.assertEqual(self.db.md_note_by_paper(pid)["id"], note["id"])
        self.assertEqual(self.db.md_note_by_paper("other"), None)
        self.db.save_md_note(note["id"], "阅读笔记", "我的批注", None)        # 保存正文时别把论文绑定弄丢
        again = self.db.md_note(note["id"])
        self.assertEqual((again["paper_id"], again["content"]), (pid, "我的批注"))

    def test_calendar_and_models_and_notes(self) -> None:
        ev = self.db.add_event("组会汇报", "2026-10-04", self.task, "meeting")
        self.assertEqual(self.db.events("2026-10")[0]["title"], "组会汇报")
        with self.assertRaises(ValueError):
            self.db.add_event("坏日期", "10/04/2026")
        self.db.delete_event(ev["id"])
        self.assertEqual(self.db.events(), [])

        m1 = self.db.add_model("A", "https://api.deepseek.com/v1", "deepseek-chat", "sk-x", activate=True)
        m2 = self.db.add_model("B", "http://127.0.0.1:10090/v1", "local", "")
        self.assertEqual(self.db.active_model()["id"], m1["id"])
        self.assertEqual(self.db.set_active(m2["id"])["id"], m2["id"])
        self.assertEqual(self.db.active_model()["name"], "B")
        self.assertEqual(len(self.db.models()), 2)

        note = self.db.add_note(self.task, "精读 · A", "# 精读\n\n- 要点 (p.1)")
        self.assertTrue((Path(self.td.name) / "..").exists())
        self.assertEqual(self.db.notes(self.task)[0]["id"], note["id"])

    def test_search_cache_dedupes(self) -> None:
        items = [
            {"source": "openalex", "title": "Cu doping in O3", "doi": "10.1/abc", "year": "2025"},
            {"source": "openalex", "title": "Cu doping in O3", "doi": "10.1/abc", "year": "2025"},
            {"source": "arxiv", "title": "O3 cathodes", "doi": "", "year": "2024"},
        ]
        first = self.db.cache_results(self.task, items)
        second = self.db.cache_results(self.task, items)
        self.assertEqual(len(first), 2)       # 两条重复被折叠
        self.assertEqual(second, [])          # 再存不重复
        self.assertEqual(len(self.db.results(self.task)), 2)

    def test_convert_offline(self) -> None:
        md = "# 标题\n\n- 要点一\n- 要点二\n\n正文段落。"
        for fmt in ("md", "html"):
            out = stage_convert(self.db, self.task, md, fmt, "paper")
            self.assertTrue(Path(out["path"]).is_file())
            self.assertGreater(out["size"], 0)
        with self.assertRaises(ValueError):
            stage_convert(self.db, self.task, md, "pdf", "paper")
        self.assertEqual({s["stage"] for s in self.db.steps(self.task)}, {"convert"})

    def test_no_oa_no_download(self) -> None:
        with self.assertRaises(ValueError):
            download_pdf({"title": "closed access", "pdf_url": ""}, Path(self.td.name))
        self.assertEqual(set(SOURCES), {"crossref", "openalex", "arxiv"})

    def test_notes_stage_needs_model_when_no_evidence(self) -> None:
        note = self.db.add_note(self.task, "精读 · B", "- (p.1) 无模型也能整理")
        out = stage_notes(self.db, self.task, note["id"])   # 无当前模型也应产出笔记
        self.assertIn("知识库笔记", out["markdown"])

    def test_agent_loop_calls_tool_then_answers(self) -> None:
        """假模型：第一轮要调 library_overview，第二轮给结论。事件流必须按序完整。"""
        calls = {"n": 0}

        def fake_chat_raw(profile, messages, tools=None, **kw):
            calls["n"] += 1
            if calls["n"] == 1:
                assert tools and any(t["function"]["name"] == "library_overview" for t in tools)
                return {"role": "assistant", "content": "", "tool_calls": [
                    {"id": "c1", "type": "function", "function": {"name": "library_overview", "arguments": "{}"}}]}
            return {"role": "assistant", "content": "现状看完了，建议先检索。", "tool_calls": []}

        self.db.add_model("假模型", "http://127.0.0.1:1/v1", "fake-model", "sk", activate=True)
        old = workflow.chat_raw
        workflow.chat_raw = fake_chat_raw
        try:
            seen: list = []
            out = run_agent(self.db, self.task, "看下现在有什么", emit=seen.append)
        finally:
            workflow.chat_raw = old
        self.assertEqual([e["type"] for e in out["events"]], ["tool_call", "tool_result", "assistant"])
        self.assertEqual(out["events"][0]["name"], "library_overview")
        self.assertTrue(out["events"][1]["ok"])
        self.assertEqual(seen[-1]["type"], "done")
        self.assertIn("建议先检索", out["reply"])
        self.assertEqual([m["role"] for m in self.db.messages(self.task)], ["user", "assistant"])

    def test_agent_tool_failure_is_reported_not_raised(self) -> None:
        def fake_chat_raw(profile, messages, tools=None, **kw):
            if not any(m.get("role") == "tool" for m in messages):
                return {"role": "assistant", "content": "", "tool_calls": [
                    {"id": "c1", "type": "function", "function": {"name": "paper_download", "arguments": '{"result_id":"nope"}'}}]}
            return {"role": "assistant", "content": "那条结果不存在。", "tool_calls": []}

        self.db.add_model("假模型2", "http://127.0.0.1:1/v1", "fake2", "sk", activate=True)
        old = workflow.chat_raw
        workflow.chat_raw = fake_chat_raw
        try:
            out = run_agent(self.db, self.task, "下载 nope")
        finally:
            workflow.chat_raw = old
        self.assertFalse(out["events"][1]["ok"])
        self.assertIn("失败", out["events"][1]["summary"])


    def test_agent_roles_leader_vs_partner(self) -> None:
        """分档：首页通用对话 = 全局 Leader（带全局简报，能看到所有项目）；
        项目对话 = 绑定该项目的 Partner Agent。锁住这两句口径，别以后被改回去。"""
        self.db.add_model("假模型3", "http://127.0.0.1:1/v1", "fake3", "sk", activate=True)
        proj = self.db.create_task("钠电掺杂", "选一种金属掺杂", "NFM", "")
        chat = self.db.create_chat("通用对话")
        seen: dict = {}

        def fake_chat_raw(profile, messages, tools=None, **kw):
            seen["ctx"] = messages[1]["content"]          # [0]=system, [1]=上下文
            return {"role": "assistant", "content": "好。", "tool_calls": []}

        old = workflow.chat_raw
        workflow.chat_raw = fake_chat_raw
        try:
            run_agent(self.db, proj, "项目内问一句")
            partner = seen["ctx"]
            run_agent(self.db, chat, "全局问一句")
            leader = seen["ctx"]
            brief = workflow._global_brief(self.db)
        finally:
            workflow.chat_raw = old
        self.assertIn("Partner Agent", partner)
        self.assertIn("钠电掺杂", partner)
        self.assertIn("全局 Leader", leader)
        self.assertIn("全局简报", leader)
        self.assertIn("钠电掺杂", leader)                 # Leader 要能看到项目名
        self.assertIn("全局简报", brief)

    def test_delete_task_cascades_and_spares_user_files(self) -> None:
        """删项目：子表（含只能经 papers 关联的 paper_pages/evidence）清干净，别的项目不受影响；
        磁盘上只清 data/papers 里的副本 —— 用户自己的原文件必须还在。"""
        from _pdf_fixture import write_text_pdf

        pdf = Path(self.td.name) / "keep-me.pdf"
        write_text_pdf(pdf, ["NaNi1/3Fe1/3Mn1/3O2 Cu doping"])
        paper = self.db.ingest_pdf(self.task, pdf)
        self.db.add_note(self.task, "笔记", "# n")
        self.db.log_step(self.task, "search", "ok", "搜索完成")
        self.db.add_event("组会", "2026-10-04", self.task)
        self.db.add_message(self.task, "user", "hi")
        other = self.db.create_task("别的项目", "q", "kw")

        out = self.db.delete_task(self.task)
        self.assertTrue(out["deleted"])
        self.assertEqual(out["files_removed"], 0)                     # 源文件不在 data/papers，没删
        self.assertEqual([t["title"] for t in self.db.tasks()], ["别的项目"])
        self.assertEqual(self.db.papers_of(self.task), [])
        self.assertEqual(self.db.messages(self.task), [])
        self.assertEqual(self.db.notes(self.task), [])
        self.assertEqual(self.db.events(), [])
        for sql in ("SELECT COUNT(*) n FROM paper_pages WHERE paper_id=?",
                    "SELECT COUNT(*) n FROM evidence WHERE paper_id=?",
                    "SELECT COUNT(*) n FROM steps WHERE task_id=?",
                    "SELECT COUNT(*) n FROM chat WHERE task_id=?"):
            arg = paper["id"] if "paper_id" in sql else self.task
            self.assertEqual(self.db.db.execute(sql, (arg,)).fetchone()["n"], 0, sql)
        self.assertTrue(pdf.is_file(), "用户原文件不能被删掉")
        self.assertEqual(self.db.tasks()[0]["id"], other)
        with self.assertRaises(KeyError):
            self.db.delete_task("不存在的项目")

    def test_litgraph_clusters_and_edges(self) -> None:
        """文献库星图：标题高频词成簇 + OpenAlex 引用边取交集（网络用假数据，不联网）。"""
        self.db.cache_results(self.task, [
            {"source": "openalex", "title": "Sodium layered oxide cathodes for batteries", "doi": "10.1/a", "year": "2021"},
            {"source": "openalex", "title": "Layered oxide cathode doping study", "doi": "10.1/b", "year": "2022"},
            {"source": "openalex", "title": "Batteries and beyond", "doi": "", "year": "2023"},
        ])
        fake = {
            "10.1/a": {"id": "https://openalex.org/W1", "referenced_works": [], "cited_by_count": 5},
            "10.1/b": {"id": "https://openalex.org/W2", "referenced_works": ["https://openalex.org/W1"], "cited_by_count": 1},
        }
        orig = workflow._openalex_works
        workflow._openalex_works = lambda dois, chunk=40: fake
        workflow._GRAPH_CACHE.clear()
        try:
            g = workflow.litgraph(self.db, self.task)
        finally:
            workflow._openalex_works = orig
        self.assertEqual(g["counts"]["papers"], 3)
        self.assertEqual(g["counts"]["with_doi"], 2)
        self.assertEqual(len(g["edges"]), 1)                 # b 引用 a → 一条边（引文表取交集）
        ids = {n["id"] for n in g["nodes"]}
        self.assertTrue(set(g["edges"][0]) <= ids)
        self.assertTrue(g["clusters"] and g["clusters"][0]["count"] >= 2)
        self.assertEqual(g["center"]["sub"], "O3 掺杂")
        self.assertEqual(sum(n["cited"] for n in g["nodes"]), 6)   # 被引数来自 OpenAlex（5 + 1）

    def test_upload_stores_file_and_ingests_pdf(self) -> None:
        """真发一次字节到 /api/upload：文件落盘、内容一致、同名重传只留一份；
        PDF 顺手入当前任务的文献库（Agent 的 paper_read 全靠这一步才读得到附件）。"""
        import json as _json
        import threading
        import urllib.parse
        import urllib.request
        from http.server import ThreadingHTTPServer

        from _pdf_fixture import write_text_pdf

        import server as srv

        srv.DB_PATH = Path(self.td.name) / "wb.sqlite3"      # 指到本测试的临时库
        srv.UPLOADS = Path(self.td.name) / "uploads"
        pdf_path = Path(self.td.name) / "样例.pdf"
        write_text_pdf(pdf_path, ["NaNi1/3Fe1/3Mn1/3O2 Cu doping"])

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), srv.Handler)
        port = httpd.server_address[1]
        threading.Thread(target=httpd.serve_forever, daemon=True).start()

        def upload(name: str, blob: bytes) -> dict:
            url = (f"http://127.0.0.1:{port}/api/upload?name={urllib.parse.quote(name)}"
                   f"&task_id={urllib.parse.quote(self.task)}")
            req = urllib.request.Request(url, data=blob, method="POST",
                                         headers={"Content-Type": "application/octet-stream"})
            return _json.loads(urllib.request.urlopen(req, timeout=15).read())

        try:
            out = upload("样例.pdf", pdf_path.read_bytes())
            self.assertTrue(Path(out["path"]).is_file())
            self.assertEqual(Path(out["path"]).read_bytes(), pdf_path.read_bytes())
            self.assertEqual(out["ext"], "pdf")
            self.assertEqual(out["pages"], 1)                 # 入库成功：有 paper_id 和页数
            self.assertEqual(len(self.db.papers_of(self.task)), 1)
            self.assertEqual(self.db.paper(out["paper_id"])["pages"][0]["page_no"], 1)

            again = upload("样例.pdf", pdf_path.read_bytes())
            self.assertEqual(again["path"], out["path"])      # 同内容不重复落盘
            self.assertEqual(again["paper_id"], out["paper_id"])

            img = upload("图.png", b"\x89PNG\r\n\x1a\nfake")
            self.assertNotIn("paper_id", img)                 # 非 PDF 只存盘，不入库
            self.assertTrue(Path(img["path"]).is_file())
        finally:
            httpd.shutdown()
            httpd.server_close()


    def test_write_pipeline_three_agents_then_final_pass(self) -> None:
        """文章撰写后台流水线：素材官 → 写手（初稿）→ 审查 → 写手（定稿）。
        子 agent 不能占对话历史、不能各发一个 done（否则前台第一次 done 就收流）。"""
        self.db.add_model("假模型3", "http://127.0.0.1:1/v1", "fake3", "sk", activate=True)
        workflow.doc_write(self.db, self.task, "outline", "## 1 引言\n### 1.1 背景\n## 2 结果\n")
        seen: list = []
        stages: list[str] = []

        def fake_chat_raw(profile, messages, tools=None, **kw):
            system = messages[0]["content"]
            names = [t["function"]["name"] for t in (tools or [])]
            if "**素材官**（后台 agent" in system:
                stages.append("素材官")
                return {"role": "assistant", "tool_calls": [],
                        "content": "- [1 引言] Cu 掺杂提升循环保持率 —— 出处：a.pdf p.3\n- [2 结果] 出处：无（待核）"}
            if "**审查 agent**（后台 agent" in system:
                stages.append("审查")
                return {"role": "assistant", "tool_calls": [],
                        "content": "- [2 结果] 保持率数字没有出处 → 补出处，拿不到就写「待补」"}
            stages.append("写手")
            wrote = any(m.get("role") == "tool" for m in messages)
            if "doc_write" in names and not wrote:      # 初稿与定稿各落盘一次（整份覆盖）
                return {"role": "assistant", "content": "", "tool_calls": [
                    {"id": "w1", "type": "function", "function": {
                        "name": "doc_write", "arguments": '{"markdown": "正文：Cu 掺杂提升循环保持率。"}'}}]}
            return {"role": "assistant", "content": "正文写好了。", "tool_calls": []}

        old = workflow.chat_raw
        workflow.chat_raw = fake_chat_raw
        try:
            out = workflow.run_write(self.db, self.task, "写一版初稿", emit=seen.append)
        finally:
            workflow.chat_raw = old

        self.assertEqual(stages, ["素材官", "写手", "写手", "审查", "写手", "写手"])   # 顺序就是流水线
        self.assertEqual([e["type"] for e in seen].count("done"), 1)                 # 只有一个收尾 done
        self.assertEqual(seen[-1]["type"], "done")
        self.assertEqual([m["role"] for m in self.db.messages(self.task, "write")], ["user", "assistant"])
        self.assertIn("后台流水线完成", out["reply"])
        self.assertIn("审查意见：1 条", out["reply"])
        body = workflow.doc_read(self.db, self.task, "write")
        self.assertTrue(body["exists"] and "Cu 掺杂提升循环保持率" in body["markdown"])
        workflow.doc_path(self.db, self.task, "write").unlink(missing_ok=True)       # 别在产出目录留测试文件

    def test_write_pipeline_gate(self) -> None:
        """流水线拐点：没框架不走；第一次（没正文）走；已有正文只说改一节时不走，说整篇/重写才走。"""
        self.assertFalse(workflow._wants_draft("写一篇初稿", False, False))
        self.assertTrue(workflow._wants_draft("随便写点", False, True))
        self.assertFalse(workflow._wants_draft("把 2.1 改一下", True, True))
        self.assertTrue(workflow._wants_draft("重写整篇", True, True))


if __name__ == "__main__":
    unittest.main(verbosity=2)
