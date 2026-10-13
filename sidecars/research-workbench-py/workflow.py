"""科研工作 1.0 · 工作流引擎

在 research_core.ResearchDB 之上补齐「创新点审查 → 论文搜索 → 下载精读 → 知识库笔记
→ 文章撰写 → 审查 → 格式转换」七步工作流，外加任务/日历体系、模型切换、主题色。

设计原则（沿用 1.0）：
  * 证据优先：候选证据一律带页码 + 原文片段，走 research_core 的严格闸门。
  * 只走开放获取：下载只对 OA 链接放行，拿不到就如实返回「无 OA 全文」。
  * 模型只做草稿与建议：审查/撰写产出是草稿，不是结论。
"""
from __future__ import annotations

import json
import os

import guards          # 出站脱敏 + 引用核验（见 guards.py）
import pdfio            # PDF 读写（pypdf/pdfplumber，见 pdfio.py）
import re
import shutil
import socket
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from research_core import ResearchDB

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
PAPERS = DATA / "papers"
NOTES = DATA / "notes"
OUT = DATA / "out"
UA = {"User-Agent": "research-workbench-1.0 (mailto:local@localhost)"}

WORKFLOW_SCHEMA = """
CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY, task_id TEXT, title TEXT NOT NULL, date TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'milestone', note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS model_profiles (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL,
  api_key TEXT NOT NULL DEFAULT '', model TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, paper_id TEXT, title TEXT NOT NULL,
  markdown TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS steps (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, stage TEXT NOT NULL,
  status TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS search_cache (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, source TEXT NOT NULL, title TEXT NOT NULL,
  authors TEXT NOT NULL DEFAULT '', year TEXT NOT NULL DEFAULT '', doi TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '', pdf_url TEXT NOT NULL DEFAULT '', abstract TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chat (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
  events TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, scope TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS project_memory (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS md_notes (           -- 「笔记」页：大笔记；task_id 空=不绑项目，paper_id 空=不绑论文
  id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '未命名笔记',
  content TEXT NOT NULL DEFAULT '', task_id TEXT NOT NULL DEFAULT '',
  paper_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL,
  api TEXT NOT NULL DEFAULT 'openai-completions', api_key TEXT NOT NULL DEFAULT '',
  models TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL DEFAULT 'builtin',
  enabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
"""

# 内置 Provider 目录：从科研工作台内嵌的 pi-ai SDK 里导出（40 家），不手抄
# 见同目录 providers_catalog.json（id / name / base_url / wire / auth / 模型 id）
CATALOG_PATH = Path(__file__).resolve().parent / "providers_catalog.json"
try:
    PROVIDER_CATALOG: dict[str, dict[str, Any]] = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
except (OSError, ValueError):
    PROVIDER_CATALOG = {}

# 接入协议（wire）—— 卡片上的徽标；本机真正跑得通的只有 openai-completions
WIRE_LABEL = {
    "openai-completions": "OpenAI Chat Completions",
    "openai-responses": "OpenAI Responses",
    "anthropic-messages": "Anthropic Messages",
    "google-generative-ai": "Google Gemini",
    "google-vertex": "Google Vertex AI",
    "bedrock-converse-stream": "Bedrock Converse",
    "azure-openai-responses": "Azure OpenAI Responses",
    "mistral-conversations": "Mistral Conversations",
    "openai-codex-responses": "OpenAI Codex Responses",
    "pi-messages": "Pi Messages",
}
USABLE_WIRES = {"openai-completions"}
CUSTOM_WIRES = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"]
# 「订阅 / OAuth 登录」时给用户打开的授权页；设备码流需要各家的 client_id，
# 这里不假装能自动授权（ponytail: 真有 client_id 时再把 RFC 8628 轮询加进来）
OAUTH_CONSOLE = {
    "openai": "https://platform.openai.com/api-keys",
    "openai-codex": "https://chatgpt.com/",
    "anthropic": "https://console.anthropic.com/settings/keys",
    "google": "https://aistudio.google.com/apikey",
    "google-vertex": "https://console.cloud.google.com/apis/credentials",
    "deepseek": "https://platform.deepseek.com/api_keys",
    "moonshotai": "https://platform.moonshot.ai/console/api-keys",
    "moonshotai-cn": "https://platform.moonshot.cn/console/api-keys",
    "zai": "https://z.ai/manage-apikey/apikey-list",
    "zai-coding-cn": "https://open.bigmodel.cn/usercenter/apikeys",
    "groq": "https://console.groq.com/keys",
    "mistral": "https://console.mistral.ai/api-keys",
    "together": "https://api.together.ai/settings/api-keys",
    "fireworks": "https://fireworks.ai/account/api-keys",
    "cerebras": "https://cloud.cerebras.ai/",
    "nvidia": "https://build.nvidia.com/",
    "openrouter": "https://openrouter.ai/keys",
    "huggingface": "https://huggingface.co/settings/tokens",
    "baseten": "https://app.baseten.co/settings/api_keys",
    "minimax": "https://platform.minimax.io/user-center/basic-information/interface-key",
    "minimax-cn": "https://platform.minimaxi.com/user-center/basic-information/interface-key",
    "xai": "https://console.x.ai/",
    "github-copilot": "https://github.com/settings/copilot",
    "vercel-ai-gateway": "https://vercel.com/dashboard",
    "amazon-bedrock": "https://console.aws.amazon.com/bedrock/",
    "azure-openai-responses": "https://portal.azure.com/",
    "qwen-token-plan": "https://bailian.console.aliyun.com/",
    "qwen-token-plan-cn": "https://bailian.console.aliyun.com/",
    "qwen-token-plan-individual": "https://bailian.console.aliyun.com/",
    "xiaomi": "https://xiaomimimo.com/",
    "cloudflare-ai-gateway": "https://dash.cloudflare.com/",
    "cloudflare-workers-ai": "https://dash.cloudflare.com/",
}

STAGES = ["idea", "search", "download", "notes", "outline", "map", "write", "review", "entrans", "convert"]
STAGE_LABEL = {
    "idea": "创新点审查", "search": "论文搜索", "download": "下载精读",
    "notes": "论文翻译", "outline": "确认大纲", "map": "梳理精读", "write": "文章撰写", "review": "审查",
    "entrans": "中译英", "convert": "格式转换",
}


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _text(value: str) -> str:
    """去标签 + 折叠空白，用于解析 Crossref/OpenAlex/arXiv 返回。"""
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", value or "")).strip()


class WorkflowDB(ResearchDB):
    def __init__(self, path: str | Path):
        super().__init__(path)
        self.db.executescript(WORKFLOW_SCHEMA)
        cols = {r["name"] for r in self.db.execute("PRAGMA table_info(chats)")}
        if "assistant_id" not in cols:                # 老库补列：对话绑的助手（我的/公开）
            self.db.execute("ALTER TABLE chats ADD COLUMN assistant_id TEXT NOT NULL DEFAULT ''")
        if "task_id" not in cols:                     # 老库补列：对话绑的项目（'' = 随意对话）
            self.db.execute("ALTER TABLE chats ADD COLUMN task_id TEXT NOT NULL DEFAULT ''")
        # 老库补列（providers 是这次新做的表，早期版本只有 6 列）
        cols = {r["name"] for r in self.db.execute("PRAGMA table_info(providers)")}
        if "source" not in cols:
            self.db.execute("ALTER TABLE providers ADD COLUMN source TEXT NOT NULL DEFAULT 'builtin'")
        if "enabled" not in cols:
            self.db.execute("ALTER TABLE providers ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0")
        cols = {r["name"] for r in self.db.execute("PRAGMA table_info(calendar_events)")}
        if "done" not in cols:
            self.db.execute("ALTER TABLE calendar_events ADD COLUMN done INTEGER NOT NULL DEFAULT 0")
        cols = {r["name"] for r in self.db.execute("PRAGMA table_info(research_tasks)")}
        if "base_dir" not in cols:                      # 老库补列：项目位置
            self.db.execute("ALTER TABLE research_tasks ADD COLUMN base_dir TEXT NOT NULL DEFAULT ''")
        cols = {r["name"] for r in self.db.execute("PRAGMA table_info(md_notes)")}
        if "task_id" not in cols:                       # 老库补列：大笔记可选绑项目
            self.db.execute("ALTER TABLE md_notes ADD COLUMN task_id TEXT NOT NULL DEFAULT ''")
        if "paper_id" not in cols:                      # 老库补列：阅读笔记绑论文（论文又绑项目）
            self.db.execute("ALTER TABLE md_notes ADD COLUMN paper_id TEXT NOT NULL DEFAULT ''")
        cols = {r["name"] for r in self.db.execute("PRAGMA table_info(chat)")}
        if "scope" not in cols:                         # 老库补列：各步骤的对话分开存（原来只有创新点审查一个）
            self.db.execute("ALTER TABLE chat ADD COLUMN scope TEXT NOT NULL DEFAULT ''")
        self.db.execute("""CREATE TABLE IF NOT EXISTS dl_queue (
              task_id TEXT NOT NULL, result_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
              path TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
              PRIMARY KEY (task_id, result_id))""")
        # 团队（A 档：Leader + Partner 成员 + 派活队列 + 运行事件）—— 抄 AionUi Teams 的模型
        self.db.execute("""CREATE TABLE IF NOT EXISTS assistants (
  id TEXT PRIMARY KEY, source TEXT NOT NULL DEFAULT 'user', name TEXT NOT NULL,
  avatar TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
  rules TEXT NOT NULL DEFAULT '', prompts TEXT NOT NULL DEFAULT '[]',
  model_id TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
)""")
        self.db.execute("""CREATE TABLE IF NOT EXISTS team_members (
              id TEXT PRIMARY KEY, task_id TEXT NOT NULL, name TEXT NOT NULL,
              role TEXT NOT NULL DEFAULT 'member', step TEXT NOT NULL DEFAULT '',
              prompt TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'idle',
              note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)""")
        self.db.execute("""CREATE TABLE IF NOT EXISTS team_tasks (
              id TEXT PRIMARY KEY, task_id TEXT NOT NULL, member_id TEXT NOT NULL DEFAULT '',
              member_name TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '',
              prompt TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'queued',
              created_at TEXT NOT NULL, started_at TEXT NOT NULL DEFAULT '', ended_at TEXT NOT NULL DEFAULT '',
              output_path TEXT NOT NULL DEFAULT '', result TEXT NOT NULL DEFAULT '',
              reason TEXT NOT NULL DEFAULT '', trigger TEXT NOT NULL DEFAULT 'leader',
              origin TEXT NOT NULL DEFAULT '')""")
        self.db.execute("""CREATE TABLE IF NOT EXISTS team_events (
              id TEXT PRIMARY KEY, team_task_id TEXT NOT NULL, task_id TEXT NOT NULL,
              kind TEXT NOT NULL DEFAULT 'note', text TEXT NOT NULL DEFAULT '',
              created_at TEXT NOT NULL)""")
        self.db.execute("CREATE INDEX IF NOT EXISTS idx_team_tasks_status ON team_tasks(status)")
        self.db.execute("""CREATE TABLE IF NOT EXISTS schedules (
              id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL DEFAULT '',
              project_id TEXT NOT NULL DEFAULT '', frequency TEXT NOT NULL DEFAULT 'daily',
              cron TEXT NOT NULL DEFAULT '0 9 * * *', output_dir TEXT NOT NULL DEFAULT '定时任务',
              enabled INTEGER NOT NULL DEFAULT 1, last_run_at TEXT NOT NULL DEFAULT '',
              next_run_at TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)""")
        self.db.execute("""CREATE TABLE IF NOT EXISTS schedule_runs (
              id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
              trigger TEXT NOT NULL DEFAULT 'scheduler', status TEXT NOT NULL DEFAULT 'running',
              started_at TEXT NOT NULL, ended_at TEXT NOT NULL DEFAULT '', output_path TEXT NOT NULL DEFAULT '',
              summary TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '')""")
        self.assistant_seed(BUILTIN_ASSISTANTS)      # 公开助手（内置）：只补缺，不覆盖改过的
        self.db.execute("""CREATE TABLE IF NOT EXISTS teams (
              id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'fixed',
              status TEXT NOT NULL DEFAULT 'idle', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)""")
        cols = {r["name"] for r in self.db.execute("PRAGMA table_info(team_members)")}
        if "assistant_id" not in cols:                 # 老库补列：成员 = 哪个助手
            self.db.execute("ALTER TABLE team_members ADD COLUMN assistant_id TEXT NOT NULL DEFAULT ''")
        if "color" not in cols:                        # 老库补列：成员身份色序号
            self.db.execute("ALTER TABLE team_members ADD COLUMN color INTEGER NOT NULL DEFAULT 0")
        cols = {r["name"] for r in self.db.execute("PRAGMA table_info(chat)")}
        if "sender" not in cols:                       # 老库补列：团队群里这条是谁说的
            self.db.execute("ALTER TABLE chat ADD COLUMN sender TEXT NOT NULL DEFAULT ''")
        self.db.commit()
        for folder in (PAPERS, NOTES, OUT):
            folder.mkdir(parents=True, exist_ok=True)

    def __enter__(self) -> "WorkflowDB":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    # ---------- 任务 / 步骤 ----------
    def log_step(self, task_id: str, stage: str, status: str, summary: str = "") -> dict[str, Any]:
        row = (uuid.uuid4().hex, task_id, stage, status, summary, now())
        self.db.execute("INSERT INTO steps VALUES (?,?,?,?,?,?)", row)
        self.db.commit()
        return {"id": row[0], "stage": stage, "status": status, "summary": summary, "created_at": row[5]}

    def steps(self, task_id: str) -> list[dict[str, Any]]:
        rows = self.db.execute("SELECT * FROM steps WHERE task_id=? ORDER BY created_at DESC", (task_id,))
        return [dict(r) for r in rows]

    def out_dir(self, task_id: str) -> Path:
        """对话自己的产出目录（chats.out_dir）；没设就落在默认 data/out。"""
        row = self.db.execute("SELECT out_dir FROM chats WHERE id=?", (task_id,)).fetchone()
        raw = (row["out_dir"] if row else "") or ""
        folder = Path(raw).expanduser() if raw else OUT
        folder.mkdir(parents=True, exist_ok=True)
        return folder

    # ---------- 大笔记（「笔记」页，不绑项目）----------
    def md_notes(self) -> list[dict[str, Any]]:
        return [dict(r) for r in self.db.execute("SELECT * FROM md_notes ORDER BY updated_at DESC")]

    def md_note(self, nid: str) -> dict[str, Any]:
        row = self.db.execute("SELECT * FROM md_notes WHERE id=?", (nid,)).fetchone()
        if not row:
            raise KeyError(nid)
        return dict(row)

    def md_note_by_paper(self, paper_id: str) -> dict[str, Any] | None:
        """一篇论文对应一篇「阅读笔记」；没有就返回 None（不重复建）。"""
        if not paper_id:
            return None
        row = self.db.execute("SELECT * FROM md_notes WHERE paper_id=? ORDER BY created_at LIMIT 1",
                              (paper_id,)).fetchone()
        return dict(row) if row else None

    def save_md_note(self, nid: str, title: str, content: str, task_id: str | None = None,
                     paper_id: str | None = None) -> dict[str, Any]:
        """task_id / paper_id 传 None 保持原绑定不变；传 "" 就是解绑。"""
        t = now()
        title = title.strip() or "未命名笔记"
        if nid and self.db.execute("SELECT 1 FROM md_notes WHERE id=?", (nid,)).fetchone():
            self.db.execute("UPDATE md_notes SET title=?, content=?, task_id=COALESCE(?, task_id),"
                            " paper_id=COALESCE(?, paper_id), updated_at=? WHERE id=?",
                            (title, content, task_id, paper_id, t, nid))
        else:
            nid = nid or uuid.uuid4().hex
            self.db.execute(
                "INSERT OR REPLACE INTO md_notes (id,title,content,task_id,paper_id,created_at,updated_at)"
                " VALUES (?,?,?,?,?,?,?)",
                (nid, title, content, task_id or "", paper_id or "", t, t))
        self.db.commit()
        return self.md_note(nid)

    def delete_md_note(self, nid: str) -> None:
        self.db.execute("DELETE FROM md_notes WHERE id=?", (nid,))
        self.db.commit()

    # ---------- 情报日报（RSS 来源 + 条目，都不绑项目）----------
    def rss_sources(self) -> list[dict[str, Any]]:
        counts = {r["source_id"]: r["n"] for r in self.db.execute(
            "SELECT source_id, COUNT(*) AS n FROM rss_items GROUP BY source_id")}
        rows = self.db.execute("SELECT * FROM rss_sources ORDER BY created_at").fetchall()
        return [{**dict(r), "count": counts.get(r["id"], 0)} for r in rows]

    def rss_source(self, sid: str) -> dict[str, Any]:
        row = self.db.execute("SELECT * FROM rss_sources WHERE id=?", (sid,)).fetchone()
        if not row:
            raise KeyError(sid)
        return dict(row)

    def add_rss_source(self, url: str, title: str = "", category: str = "学术论文", site: str = "") -> dict[str, Any]:
        url = (url or "").strip()
        if not url.startswith(("http://", "https://")):
            raise ValueError("RSS 地址要以 http:// 或 https:// 开头")
        old = self.db.execute("SELECT * FROM rss_sources WHERE url=?", (url,)).fetchone()
        if old:                                    # 同一个 URL 再加：认作同一个源，不重复抓
            return dict(old)
        sid = uuid.uuid4().hex
        self.db.execute(
            "INSERT INTO rss_sources (id,url,title,site,category,enabled,in_daily,last_error,last_fetch,created_at)"
            " VALUES (?,?,?,?,?,1,1,'','',?)",
            (sid, url, title.strip() or url, site.strip(), category.strip() or "学术论文", now()))
        self.db.commit()
        return self.rss_source(sid)

    def save_rss_items(self, src: dict[str, Any], items: list[dict[str, str]]) -> int:
        """按 link 去重入库（UNIQUE 索引 + OR IGNORE），返回真正新增的条数。"""
        n = 0
        for it in items:
            cur = self.db.execute(
                "INSERT OR IGNORE INTO rss_items (id,source_id,link,title,authors,summary,published_at,"
                "source_title,category,fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (uuid.uuid4().hex, src["id"], it["link"], it["title"], it.get("authors", ""),
                 it.get("summary", ""), it.get("published_at", ""), src["title"], src["category"], now()))
            n += cur.rowcount or 0
        self.db.commit()
        return n

    def mark_rss_fetch(self, sid: str, error: str = "") -> None:
        self.db.execute("UPDATE rss_sources SET last_fetch=?, last_error=? WHERE id=?", (now(), error[:200], sid))
        self.db.commit()

    def _rss_where(self, source_id: str = "", q: str = "", year: str = "") -> tuple[str, list[Any]]:
        sql, args = " WHERE 1=1", []
        if source_id:
            sql += " AND i.source_id=?"; args.append(source_id)
        if q:
            sql += " AND (i.title LIKE ? OR i.summary LIKE ? OR i.authors LIKE ?)"; args += [f"%{q}%"] * 3
        if year:
            sql += " AND i.published_at LIKE ?"; args.append(f"{year}%")
        return sql, args

    def rss_items(self, source_id: str = "", q: str = "", year: str = "", limit: int = 200) -> list[dict[str, Any]]:
        sql, args = self._rss_where(source_id, q, year)
        sql = ("SELECT i.*, s.title AS src_now FROM rss_items i LEFT JOIN rss_sources s ON s.id=i.source_id"
               + sql + " ORDER BY (i.published_at='') ASC, i.published_at DESC, i.fetched_at DESC LIMIT ?")
        out = []
        for r in self.db.execute(sql, args + [int(limit)]):
            d = dict(r)
            d["source_title"] = d["src_now"] or d["source_title"]     # 来源删了就用入库时的快照
            d["source_deleted"] = not d["src_now"]
            d.pop("src_now", None)
            out.append(d)
        return out

    def rss_count(self, source_id: str = "", q: str = "", year: str = "") -> int:
        sql, args = self._rss_where(source_id, q, year)
        sql = "SELECT COUNT(*) AS n FROM rss_items i" + sql
        return int(self.db.execute(sql, args).fetchone()["n"])

    # ---------- 勾选下载队列（论文搜索 → 下载精读）----------
    def enqueue(self, task_id: str, result_ids: list[str]) -> int:
        """按本次勾选重建队列（上一批的勾选记录清掉），状态先置 queued。"""
        self.db.execute("DELETE FROM dl_queue WHERE task_id=?", (task_id,))
        for rid in result_ids:
            self.db.execute("INSERT OR REPLACE INTO dl_queue VALUES (?,?,?,?,?,?)",
                            (task_id, rid, "queued", "", "", now()))
        self.db.commit()
        return len(result_ids)

    def set_queue(self, task_id: str, result_id: str, status: str, path: str = "", error: str = "") -> None:
        self.db.execute("INSERT OR REPLACE INTO dl_queue VALUES (?,?,?,?,?,?)",
                        (task_id, result_id, status, path, error, now()))
        self.db.commit()

    def queue(self, task_id: str) -> list[dict[str, Any]]:
        """队列 + 卡片字段（和论文搜索的卡片同源，前端好复用同一套卡片）。"""
        rows = [dict(r) for r in self.db.execute(
            "SELECT * FROM dl_queue WHERE task_id=? ORDER BY updated_at", (task_id,))]
        out = []
        for r in rows:
            try:
                item = self.result(r["result_id"])
            except KeyError:
                continue
            item.update({"status": r["status"], "saved_path": r["path"], "error": r["error"]})
            out.append(item)
        return out

    # ---------- 项目位置（用户选的文件夹）与六个固定子目录 ----------
    def base_dir(self, task_id: str) -> Path | None:
        row = self.db.execute("SELECT base_dir FROM research_tasks WHERE id=?", (task_id,)).fetchone()
        raw = ((row["base_dir"] if row else "") or "").strip()
        return Path(raw).expanduser() if raw else None

    def pdir(self, task_id: str, kind: str) -> Path:
        """按用途拿目录。设了项目位置就落到那六个子夹里，没设就退回工作区默认目录（老项目不受影响）。"""
        names = {n for n, _ in PROJ_DIRS}
        fallback = {"文献库": PAPERS, "笔记": NOTES, "论文正文": OUT, "最终成品": OUT, "其余": OUT, "记忆": OUT}
        base = self.base_dir(task_id)
        folder = (base / kind) if (base and kind in names) else fallback.get(kind, OUT)
        folder.mkdir(parents=True, exist_ok=True)
        return folder

    # ---------- 定时任务（照原版 automation：规则 + 每次运行一条记录） ----------
    def schedules(self) -> list[dict[str, Any]]:
        return [dict(r) for r in self.db.execute("SELECT * FROM schedules ORDER BY created_at").fetchall()]

    def schedule(self, sid: str) -> dict[str, Any] | None:
        row = self.db.execute("SELECT * FROM schedules WHERE id=?", (str(sid or ""),)).fetchone()
        return dict(row) if row else None

    def schedule_save(self, data: dict[str, Any]) -> dict[str, Any]:
        sid = str(data.get("id") or "").strip() or uuid.uuid4().hex
        stamp = now()
        enabled = 1 if data.get("enabled", True) else 0
        fields = (str(data.get("name") or "未命名任务"), str(data.get("prompt") or ""),
                  str(data.get("project_id") or ""), str(data.get("frequency") or "daily"),
                  str(data.get("cron") or "0 9 * * *"), str(data.get("output_dir") or "定时任务"),
                  enabled, str(data.get("next_run_at") or ""))
        row = self.db.execute("SELECT id FROM schedules WHERE id=?", (sid,)).fetchone()
        if row:
            self.db.execute("""UPDATE schedules SET name=?, prompt=?, project_id=?, frequency=?, cron=?,
                output_dir=?, enabled=?, next_run_at=?, updated_at=? WHERE id=?""", (*fields, stamp, sid))
        else:
            self.db.execute("INSERT INTO schedules VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                            (sid, *fields[:6], enabled, "", fields[7], stamp, stamp))
        self.db.commit()
        return self.schedule(sid) or {}

    def schedule_set_enabled(self, sid: str, enabled: bool) -> None:
        self.db.execute("UPDATE schedules SET enabled=?, updated_at=? WHERE id=?",
                        (1 if enabled else 0, now(), str(sid or "")))
        self.db.commit()

    def schedule_delete(self, sid: str) -> None:
        self.db.execute("DELETE FROM schedule_runs WHERE schedule_id=?", (str(sid or ""),))
        self.db.execute("DELETE FROM schedules WHERE id=?", (str(sid or ""),))
        self.db.commit()

    def schedule_mark_run(self, sid: str, last_run_at: str, next_run_at: str) -> None:
        self.db.execute("UPDATE schedules SET last_run_at=?, next_run_at=?, updated_at=? WHERE id=?",
                        (str(last_run_at or ""), str(next_run_at or ""), now(), str(sid or "")))
        self.db.commit()

    def schedule_runs(self, limit: int = 80) -> list[dict[str, Any]]:
        rows = self.db.execute("SELECT * FROM schedule_runs ORDER BY started_at DESC LIMIT ?",
                               (max(1, min(500, int(limit))),)).fetchall()
        return [dict(r) for r in rows]

    def schedule_run_add(self, run: dict[str, Any]) -> None:
        """同一个 id 覆盖写（先落 running，跑完再覆盖成终态）。"""
        self.db.execute("""INSERT INTO schedule_runs VALUES (?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET status=excluded.status, ended_at=excluded.ended_at,
            output_path=excluded.output_path, summary=excluded.summary, reason=excluded.reason""",
                        (str(run.get("id") or uuid.uuid4().hex), str(run.get("schedule_id") or ""),
                         str(run.get("name") or ""), str(run.get("trigger") or "scheduler"),
                         str(run.get("status") or "running"), str(run.get("started_at") or now()),
                         str(run.get("ended_at") or ""), str(run.get("output_path") or ""),
                         str(run.get("summary") or ""), str(run.get("reason") or "")))
        self.db.commit()

    def schedule_run_delete(self, ids: list[str]) -> int:
        ids = [str(i) for i in (ids or []) if str(i).strip()]
        if not ids:
            return 0
        marks = ",".join("?" for _ in ids)
        cur = self.db.execute(f"DELETE FROM schedule_runs WHERE id IN ({marks})", tuple(ids))
        self.db.commit()
        return int(cur.rowcount or 0)

    # ---------- 团队 ----------
    def team_members(self, task_id: str) -> list[dict[str, Any]]:
        rows = self.db.execute(
            "SELECT * FROM team_members WHERE task_id=? ORDER BY (role='leader') DESC, created_at",
            (task_id,)).fetchall()
        return [dict(r) for r in rows]

    def team_member(self, mid: str) -> dict[str, Any] | None:
        row = self.db.execute("SELECT * FROM team_members WHERE id=?", (mid,)).fetchone()
        return dict(row) if row else None

    def team_member_add(self, task_id: str, name: str, role: str = "member", step: str = "",
                        prompt: str = "", assistant_id: str = "", color: int = 0) -> dict[str, Any]:
        row = (uuid.uuid4().hex, task_id, name, role, step, prompt, "idle", "", now(), now(),
               assistant_id, int(color or 0))
        self.db.execute("INSERT INTO team_members (id,task_id,name,role,step,prompt,status,note,created_at,"
                       "updated_at,assistant_id,color) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", row)
        self.db.commit()
        return dict(self.db.execute("SELECT * FROM team_members WHERE id=?", (row[0],)).fetchone())

    def team_member_update(self, mid: str, **fields: Any) -> dict[str, Any]:
        allow = {k: v for k, v in fields.items() if k in ("name", "step", "prompt", "status", "note")}
        if allow:
            allow["updated_at"] = now()
            sets = ", ".join("%s=?" % k for k in allow)
            self.db.execute("UPDATE team_members SET %s WHERE id=?" % sets, (*allow.values(), mid))
            self.db.commit()
        return self.team_member(mid) or {}

    def team_member_remove(self, mid: str) -> None:
        self.db.execute("DELETE FROM team_members WHERE id=?", (mid,))
        self.db.commit()

    def team_tasks(self, task_id: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
        if task_id:
            rows = self.db.execute("SELECT * FROM team_tasks WHERE task_id=? ORDER BY created_at DESC LIMIT ?",
                                   (task_id, limit)).fetchall()
        else:
            rows = self.db.execute("SELECT * FROM team_tasks ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
        return [dict(r) for r in rows]

    def team_task(self, tid: str) -> dict[str, Any] | None:
        row = self.db.execute("SELECT * FROM team_tasks WHERE id=?", (tid,)).fetchone()
        return dict(row) if row else None

    def team_task_add(self, task_id: str, member_id: str, member_name: str, title: str, prompt: str,
                      trigger: str = "leader", origin: str = "") -> dict[str, Any]:
        row = (uuid.uuid4().hex, task_id, member_id, member_name, title[:120], prompt, "queued",
               now(), "", "", "", "", "", trigger, origin)
        self.db.execute("INSERT INTO team_tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", row)
        self.db.commit()
        return dict(self.db.execute("SELECT * FROM team_tasks WHERE id=?", (row[0],)).fetchone())

    def team_task_mark(self, tid: str, status: str, **fields: Any) -> None:
        allow = {k: v for k, v in fields.items()
                 if k in ("started_at", "ended_at", "output_path", "result", "reason")}
        allow["status"] = status
        sets = ", ".join("%s=?" % k for k in allow)
        self.db.execute("UPDATE team_tasks SET %s WHERE id=?" % sets, (*allow.values(), tid))
        self.db.commit()

    # ---------- 团队表（一个团队 = 一条记录；成员/记录都挂在它的 id 上） ----------
    def teams(self) -> list[dict[str, Any]]:
        return [dict(r) for r in self.db.execute("SELECT * FROM teams ORDER BY created_at")]

    def team(self, tid: str) -> dict[str, Any] | None:
        row = self.db.execute("SELECT * FROM teams WHERE id=?", (tid,)).fetchone()
        return dict(row) if row else None

    def team_add(self, name: str, kind: str = "fixed") -> dict[str, Any]:
        tid = uuid.uuid4().hex
        self.db.execute("INSERT INTO teams (id,name,kind,status,created_at,updated_at) VALUES (?,?,?,?,?,?)",
                        (tid, (name or "新团队").strip(), kind, "idle", now(), now()))
        self.db.commit()
        return self.team(tid) or {}

    def team_update(self, tid: str, **fields: Any) -> dict[str, Any]:
        allow = {k: v for k, v in fields.items() if k in ("name", "status", "kind") and v is not None}
        if allow:
            allow["updated_at"] = now()
            self.db.execute("UPDATE teams SET %s WHERE id=?" % ", ".join("%s=?" % k for k in allow),
                            (*allow.values(), tid))
            self.db.commit()
        return self.team(tid) or {}

    def team_delete(self, tid: str) -> None:
        self.db.execute("DELETE FROM teams WHERE id=?", (tid,))
        self.db.execute("DELETE FROM team_members WHERE task_id=?", (tid,))
        self.db.commit()

    def team_events(self, task_id: str, limit: int = 200) -> list[dict[str, Any]]:
        rows = self.db.execute("SELECT * FROM team_events WHERE task_id=? ORDER BY created_at DESC LIMIT ?",
                               (task_id, limit)).fetchall()
        return [dict(r) for r in reversed(rows)]        # 从旧到新（读 trace 的顺序）

    def team_event_add(self, team_task_id: str, task_id: str, kind: str, text: str) -> None:
        self.db.execute("INSERT INTO team_events VALUES (?,?,?,?,?,?)",
                        (uuid.uuid4().hex, team_task_id, task_id, kind, text[:2000], now()))
        self.db.commit()

    # ---------- 助手（照 AionUi Assistant：我的 / 公开；点进去设提示词） ----------
    def assistants(self) -> list[dict[str, Any]]:
        rows = self.db.execute("SELECT * FROM assistants ORDER BY source='builtin', sort_order, created_at").fetchall()
        return [dict(r) for r in rows]

    def assistant(self, aid: str) -> dict[str, Any] | None:
        row = self.db.execute("SELECT * FROM assistants WHERE id=?", (aid,)).fetchone()
        return dict(row) if row else None

    def assistant_save(self, aid: str, **f: Any) -> dict[str, Any]:
        allow = {k: v for k, v in f.items() if k in ("name", "avatar", "description", "rules", "prompts", "model_id") and v is not None}
        cur = self.assistant(aid)
        if cur and cur["source"] == "builtin":
            raise ValueError("公开助手是只读的 —— 请「复制为我的」再改。")
        if cur:
            if allow:
                allow["updated_at"] = now()
                self.db.execute("UPDATE assistants SET %s WHERE id=?" % ", ".join("%s=?" % k for k in allow), (*allow.values(), aid))
        else:
            row = (aid, "user", allow.get("name") or "新助手", allow.get("avatar", ""), allow.get("description", ""),
                   allow.get("rules", ""), allow.get("prompts", "[]"), allow.get("model_id", ""), 1, 99, now(), now())
            self.db.execute("INSERT INTO assistants VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", row)
        self.db.commit()
        return dict(self.db.execute("SELECT * FROM assistants WHERE id=?", (aid,)).fetchone())

    def assistant_delete(self, aid: str) -> None:
        cur = self.assistant(aid)
        if cur and cur["source"] == "builtin":
            raise ValueError("公开助手不能删除 —— 可以「复制为我的」再改。")
        self.db.execute("DELETE FROM assistants WHERE id=?", (aid,))
        self.db.commit()

    def assistant_of_chat(self, chat_id: str) -> str:
        """这个对话绑的是哪个助手（空串=没绑）。"""
        row = self.db.execute("SELECT assistant_id FROM chats WHERE id=?", (chat_id,)).fetchone()
        return ((row["assistant_id"] if row else "") or "")

    def assistant_seed(self, builtins: list[dict[str, Any]]) -> int:
        """内置（公开）助手：只补缺，不覆盖用户改过的。"""
        n = 0
        for b in builtins:
            if not self.assistant(b["id"]):
                self.db.execute("INSERT INTO assistants VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                                (b["id"], "builtin", b["name"], b.get("avatar", ""), b.get("description", ""),
                                 b.get("rules", ""), json.dumps(b.get("prompts", []), ensure_ascii=False),
                                 "", 1, b.get("sort_order", 0), now(), now()))
                n += 1
        self.db.commit()
        return n

    def set_chat_assistant(self, cid: str, aid: str) -> None:
        self.db.execute("UPDATE chats SET assistant_id=?, updated_at=? WHERE id=?", (aid, now(), cid))
        self.db.commit()

    # ---------- 项目记忆（长期 = 项目要点与结论；短期 = 对话内容与细节） ----------
    def memory(self, task_id: str, kind: str | None = None, limit: int = 200) -> list[dict[str, Any]]:
        sql, args = "SELECT * FROM project_memory WHERE task_id=?", [task_id]
        if kind:
            sql += " AND kind=?"; args.append(kind)
        sql += " ORDER BY created_at LIMIT ?"; args.append(limit)
        return [dict(r) for r in self.db.execute(sql, args)]

    def add_memory(self, task_id: str, kind: str, text: str) -> dict[str, Any]:
        text = (text or "").strip()
        if not text:
            raise ValueError("记忆内容不能为空")
        row = (uuid.uuid4().hex, task_id, "short" if kind == "short" else "long", text, now())
        self.db.execute("INSERT INTO project_memory VALUES (?,?,?,?,?)", row)
        self.db.commit()
        self.dump_memory(task_id)                       # 项目位置里同步一份可读文件
        return {"id": row[0], "kind": row[2], "text": text, "created_at": row[4]}

    def dump_memory(self, task_id: str) -> None:
        """把长期/短期记忆落盘到项目位置的「记忆」目录；没设项目位置就只留在库里。"""
        base = self.base_dir(task_id)
        if not base:
            return
        folder = base / "记忆"
        folder.mkdir(parents=True, exist_ok=True)
        long = [m["text"] for m in self.memory(task_id, "long")]
        shorts = [m["text"] for m in self.memory(task_id, "short")]
        msgs = self.messages(task_id)
        lines = [f"- {x}" for x in shorts] + [
            f"- {'我' if m['role'] == 'user' else '助手'}（{m['created_at'][:16]}）：{' '.join((m['content'] or '').split())[:300]}"
            for m in msgs]
        (folder / "长期记忆.md").write_text(
            "# 长期记忆\n\n项目要点与重要结论（自动维护，可直接编辑，下次运行会读回来）。\n\n"
            + ("\n".join(f"- {x}" for x in long) or "- （暂无）") + "\n", encoding="utf-8")
        (folder / "短期记忆.md").write_text(
            "# 短期记忆\n\n这个项目的对话内容与细节（按时间顺序，越靠下越新）。\n\n"
            + ("\n".join(lines) or "- （暂无）") + "\n", encoding="utf-8")

    def seed_long_memory(self, task_id: str) -> int:
        """长期记忆的底子：新建项目时填的那几个点（只在空的时候种一次）。"""
        if self.memory(task_id, "long"):
            return 0
        t = self.db.execute("SELECT * FROM research_tasks WHERE id=?", (task_id,)).fetchone()
        if not t:
            return 0
        points = [("项目", t["title"]), ("研究问题", t["question"]),
                  ("关键词 / 材料体系", t["material_system"])]
        n = 0
        for k, v in points:
            if (v or "").strip():
                self.add_memory(task_id, "long", f"{k}：{v.strip()}"); n += 1
        return n

    def memory_block(self, task_id: str, now_window: int = 10, line: int = 120) -> str:
        """拼给模型看的记忆块：长期全给，短期给窗口外的老对话（窗口内的走正常 messages）。"""
        self.seed_long_memory(task_id)
        long = [m["text"] for m in self.memory(task_id, "long")]
        msgs = self.messages(task_id)
        older = msgs[:-now_window] if len(msgs) > now_window else []
        short = [f"{m['role']}: {' '.join((m['content'] or '').split())[:line]}" for m in older]
        parts = ["【项目长期记忆】" + ("\n".join(f"- {x}" for x in long[-40:]) if long else "（空）")]
        if short:
            parts.append("【更早的对话（短期记忆）】\n" + "\n".join("- " + x for x in short[-20:]))
        return "\n\n".join(parts)


    def stage_map(self, task_id: str) -> dict[str, str]:
        out: dict[str, str] = {}
        for row in reversed(self.steps(task_id)):
            out[row["stage"]] = row["status"]
        return out

    def stage_now(self, task_id: str, fallback: str = "") -> str:
        """项目现在走到七步的哪一步：取最近一条步骤记录；一条都没有就按任务自身阶段兜底。"""
        row = self.db.execute(
            "SELECT stage FROM steps WHERE task_id=? ORDER BY created_at DESC LIMIT 1", (task_id,)
        ).fetchone()
        if row and row["stage"] in STAGE_LABEL:
            return STAGE_LABEL[row["stage"]]
        return {"definition": STAGE_LABEL["idea"], "reading": STAGE_LABEL["download"]}.get(fallback, "未开始")

    def delete_task(self, task_id: str) -> dict[str, Any]:
        """删掉一个项目连带它的全部数据。SQLite 默认不启用外键约束，子表得自己清
        （paper_pages / evidence 没有 task_id，只能经 papers 关联）。
        磁盘上只删 data/papers 里我们自己存的 PDF 副本，用户自己的原文件不动。"""
        if self.db.execute("SELECT 1 FROM research_tasks WHERE id=?", (task_id,)).fetchone() is None:
            raise KeyError(task_id)
        files = [r["source_path"] for r in self.db.execute("SELECT source_path FROM papers WHERE task_id=?", (task_id,))]
        self.db.execute("DELETE FROM paper_pages WHERE paper_id IN (SELECT id FROM papers WHERE task_id=?)", (task_id,))
        self.db.execute("DELETE FROM evidence WHERE paper_id IN (SELECT id FROM papers WHERE task_id=?)", (task_id,))
        for table in ("papers", "artifacts", "runs", "calendar_events", "notes", "steps", "search_cache", "chat"):
            self.db.execute(f"DELETE FROM {table} WHERE task_id=?", (task_id,))
        self.db.execute("DELETE FROM research_tasks WHERE id=?", (task_id,))
        self.db.commit()
        removed = 0
        for raw in files:
            p = Path(raw)
            try:
                if p.is_file() and PAPERS in p.resolve().parents:
                    p.unlink()
                    removed += 1
            except OSError:
                pass
        return {"deleted": True, "id": task_id, "files_removed": removed}

    # ---------- 日历 ----------
    def add_event(self, title: str, date: str, task_id: str | None = None, kind: str = "milestone", note: str = "") -> dict[str, Any]:
        if not title.strip() or not re.match(r"^\d{4}-\d{2}-\d{2}$", date or ""):
            raise ValueError("日历事件需要标题和 YYYY-MM-DD 日期")
        row = (uuid.uuid4().hex, task_id or None, title.strip(), date, kind, note, now())
        self.db.execute("INSERT INTO calendar_events (id,task_id,title,date,kind,note,created_at) VALUES (?,?,?,?,?,?,?)", row)
        self.db.commit()
        return self.event(row[0])

    def toggle_event(self, event_id: str, done: bool | None = None) -> dict[str, Any]:
        """勾掉/取消勾掉今日事项（今日工作计划那个复选框）。"""
        cur = self.event(event_id)
        value = (0 if cur["done"] else 1) if done is None else int(bool(done))
        self.db.execute("UPDATE calendar_events SET done=? WHERE id=?", (value, event_id))
        self.db.commit()
        return self.event(event_id)

    def event(self, event_id: str) -> dict[str, Any]:
        row = self.db.execute("SELECT * FROM calendar_events WHERE id=?", (event_id,)).fetchone()
        if not row:
            raise KeyError(event_id)
        return dict(row)

    def events(self, month: str | None = None) -> list[dict[str, Any]]:
        if month:
            rows = self.db.execute("SELECT * FROM calendar_events WHERE date LIKE ? ORDER BY date", (month + "%",))
        else:
            rows = self.db.execute("SELECT * FROM calendar_events ORDER BY date")
        return [dict(r) for r in rows]

    def delete_event(self, event_id: str) -> None:
        self.db.execute("DELETE FROM calendar_events WHERE id=?", (event_id,))
        self.db.commit()

    # ---------- 模型档案 ----------
    def add_model(self, name: str, base_url: str, model: str, api_key: str = "", activate: bool = False) -> dict[str, Any]:
        if not name.strip() or not base_url.strip() or not model.strip():
            raise ValueError("模型档案需要 名称/接口地址/模型名")
        mid = uuid.uuid4().hex
        self.db.execute("INSERT INTO model_profiles VALUES (?,?,?,?,?,?,?)", (mid, name.strip(), base_url.strip().rstrip("/"), api_key.strip(), model.strip(), 0, now()))
        self.db.commit()
        if activate or not self.active_model():
            self.set_active(mid)
        return self.model(mid)

    def model(self, mid: str) -> dict[str, Any]:
        row = self.db.execute("SELECT * FROM model_profiles WHERE id=?", (mid,)).fetchone()
        if not row:
            raise KeyError(mid)
        return dict(row)

    def models(self) -> list[dict[str, Any]]:
        return [dict(r) for r in self.db.execute("SELECT * FROM model_profiles ORDER BY created_at")]

    def set_active(self, mid: str) -> dict[str, Any]:
        self.model(mid)  # 不存在则抛 KeyError
        self.db.execute("UPDATE model_profiles SET is_active=0")
        self.db.execute("UPDATE model_profiles SET is_active=1 WHERE id=?", (mid,))
        self.db.commit()
        return self.model(mid)

    def delete_model(self, mid: str) -> None:
        self.db.execute("DELETE FROM model_profiles WHERE id=?", (mid,))
        self.db.commit()

    def active_model(self) -> dict[str, Any] | None:
        row = self.db.execute("SELECT * FROM model_profiles WHERE is_active=1").fetchone()
        return dict(row) if row else None

    # ---------- Provider（模型与 Agent 卡片） ----------
    def providers(self) -> list[dict[str, Any]]:
        """只返回库里已有的行；内置目录里没动过的 Provider 由前端补卡片。"""
        out = []
        for r in self.db.execute("SELECT * FROM providers ORDER BY created_at"):
            d = dict(r)
            try:
                d["models"] = json.loads(d["models"])
            except ValueError:
                d["models"] = []
            out.append(d)
        return out

    def provider(self, pid: str) -> dict[str, Any]:
        row = self.db.execute("SELECT * FROM providers WHERE id=?", (pid,)).fetchone()
        if row:
            d = dict(row)
            try:
                d["models"] = json.loads(d["models"])
            except ValueError:
                d["models"] = []
            return d
        if pid in PROVIDER_CATALOG:            # 还没落库的内置 Provider：给一份只读视图
            c = PROVIDER_CATALOG[pid]
            return {"id": pid, "name": c["name"], "base_url": c["base_url"] or "",
                    "api": c["wire"] or "openai-completions", "api_key": "", "models": [],
                    "source": "builtin", "enabled": 0, "created_at": now()}
        raise KeyError(pid)

    def ensure_provider(self, pid: str) -> dict[str, Any]:
        """首次写入（存 Key / 采用模型）时才把内置 Provider 落库。"""
        row = self.db.execute("SELECT id FROM providers WHERE id=?", (pid,)).fetchone()
        if row:
            return self.provider(pid)
        if pid not in PROVIDER_CATALOG:
            raise KeyError(pid)
        c = PROVIDER_CATALOG[pid]
        self.db.execute("INSERT INTO providers (id,name,base_url,api,api_key,models,source,enabled,created_at)"
                        " VALUES (?,?,?,?,?,?,?,?,?)",
                        (pid, c["name"], c["base_url"] or "", c["wire"] or "openai-completions",
                         "", "[]", "builtin", 0, now()))
        self.db.commit()
        return self.provider(pid)

    def add_provider(self, name: str, base_url: str, api: str = "openai-completions", api_key: str = "") -> dict[str, Any]:
        if not name.strip() or not base_url.strip():
            raise ValueError("Provider 需要名称和接口地址")
        pid = "custom:" + uuid.uuid4().hex[:12]
        self.db.execute("INSERT INTO providers (id,name,base_url,api,api_key,models,source,enabled,created_at)"
                        " VALUES (?,?,?,?,?,?,?,?,?)",
                        (pid, name.strip(), base_url.strip().rstrip("/"), api, api_key.strip(),
                         "[]", "custom", 1 if api_key.strip() else 0, now()))
        self.db.commit()
        return self.provider(pid)

    def set_provider_key(self, pid: str, api_key: str) -> dict[str, Any]:
        self.ensure_provider(pid)
        self.db.execute("UPDATE providers SET api_key=?, enabled=? WHERE id=?",
                        (api_key.strip(), 1 if api_key.strip() else 0, pid))
        self.db.commit()
        return self.provider(pid)

    def delete_provider(self, pid: str) -> None:
        """内置的只能复位（卡片要一直在）；自定义的整行删掉。"""
        row = self.db.execute("SELECT source FROM providers WHERE id=?", (pid,)).fetchone()
        if not row or row["source"] == "custom":
            self.db.execute("DELETE FROM providers WHERE id=?", (pid,))
        else:
            self.db.execute("UPDATE providers SET api_key='', models='[]', enabled=0 WHERE id=?", (pid,))
        self.db.commit()

    def adopt_model(self, pid: str, model: str, on: bool = True) -> dict[str, Any]:
        model = model.strip()
        if not model:
            raise ValueError("模型 id 不能为空")
        p = self.ensure_provider(pid)
        names = list(p["models"])
        if on and model not in names:
            names.append(model)
        if not on and model in names:
            names.remove(model)
        self.db.execute("UPDATE providers SET models=?, enabled=? WHERE id=?",
                        (json.dumps(names, ensure_ascii=False), 1 if (names or p["api_key"]) else 0, pid))
        self.db.commit()
        if on and not self.active_model():          # 还没有默认模型 → 这次采用的就当默认，省得 Agent 说「没配模型」
            try:
                self.set_default(pid, model)
            except ValueError:
                pass
        return self.provider(pid)

    def set_default(self, pid: str, model: str) -> dict[str, Any]:
        """把「某 Provider 的某个模型」落成当前模型 —— 写在 model_profiles 上，下游 agent 不用改。"""
        p = self.provider(pid)
        if not model.strip():
            raise ValueError("先采用一个模型，再设为默认")
        if not p["api_key"]:
            raise ValueError("这个 Provider 还没保存 Key")
        if p["api"] not in USABLE_WIRES:
            raise ValueError(f"本机调用只实现了 OpenAI Chat Completions；「{WIRE_LABEL.get(p['api'], p['api'])}」"
                             "这条协议还没接，设成默认会调用失败")
        self.db.execute("UPDATE model_profiles SET is_active=0")
        row = self.db.execute("SELECT id FROM model_profiles WHERE base_url=? AND model=?",
                              (p["base_url"], model)).fetchone()
        if row:
            self.db.execute("UPDATE model_profiles SET is_active=1, api_key=?, name=? WHERE id=?",
                            (p["api_key"], p["name"], row["id"]))
        else:
            self.db.execute("INSERT INTO model_profiles VALUES (?,?,?,?,?,1,?)",
                            (uuid.uuid4().hex, p["name"], p["base_url"], p["api_key"], model, now()))
        self.db.commit()
        return self.active_model()

    def provider_default(self) -> dict[str, Any] | None:
        m = self.active_model()
        if not m:
            return None
        row = self.db.execute("SELECT id FROM providers WHERE base_url=?", (m["base_url"],)).fetchone()
        if row:
            return {"provider_id": row["id"], "model": m["model"]}
        for pid, c in PROVIDER_CATALOG.items():       # 还没落库的内置 Provider
            if c["base_url"] == m["base_url"]:
                return {"provider_id": pid, "model": m["model"]}
        return {"provider_id": None, "model": m["model"]}

    # ---------- 检索缓存 ----------
    def cache_results(self, task_id: str, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        saved = []
        for it in items:
            if not it.get("title"):
                continue
            key = (self.db.execute(
                "SELECT 1 FROM search_cache WHERE task_id=? AND source=? AND (doi=? AND doi!='' OR title=?)",
                (task_id, it.get("source", ""), it.get("doi", ""), it.get("title", "")),
            ).fetchone())
            if key:
                continue
            rid = uuid.uuid4().hex
            row = (rid, task_id, it.get("source", ""), it["title"], it.get("authors", ""), it.get("year", ""),
                   it.get("doi", ""), it.get("url", ""), it.get("pdf_url", ""), it.get("abstract", ""), now())
            self.db.execute("INSERT INTO search_cache VALUES (?,?,?,?,?,?,?,?,?,?,?)", row)
            saved.append(self.result(rid))
        self.db.commit()
        return saved

    def result(self, rid: str) -> dict[str, Any]:
        row = self.db.execute("SELECT * FROM search_cache WHERE id=?", (rid,)).fetchone()
        if not row:
            raise KeyError(rid)
        return dict(row)

    def results(self, task_id: str) -> list[dict[str, Any]]:
        rows = self.db.execute("SELECT * FROM search_cache WHERE task_id=? ORDER BY created_at DESC, year DESC", (task_id,))
        return [dict(r) for r in rows]

    # ---------- 笔记 ----------
    def add_note(self, task_id: str, title: str, markdown: str, paper_id: str | None = None) -> dict[str, Any]:
        nid = uuid.uuid4().hex
        self.db.execute("INSERT INTO notes VALUES (?,?,?,?,?,?)", (nid, task_id, paper_id, title.strip() or "未命名笔记", markdown, now()))
        self.db.commit()
        (self.pdir(task_id, "笔记") / f"{nid}.md").write_text(markdown, encoding="utf-8")
        return self.note(nid)

    def note(self, nid: str) -> dict[str, Any]:
        row = self.db.execute("SELECT * FROM notes WHERE id=?", (nid,)).fetchone()
        if not row:
            raise KeyError(nid)
        return dict(row)

    def notes(self, task_id: str | None = None) -> list[dict[str, Any]]:
        if task_id:
            rows = self.db.execute("SELECT * FROM notes WHERE task_id=? ORDER BY created_at DESC", (task_id,))
        else:
            rows = self.db.execute("SELECT * FROM notes ORDER BY created_at DESC")
        return [dict(r) for r in rows]

    def papers_of(self, task_id: str) -> list[dict[str, Any]]:
        rows = self.db.execute("SELECT * FROM papers WHERE task_id=? ORDER BY created_at DESC", (task_id,))
        return [dict(r) for r in rows]

    # ---------- Agent 对话记录 ----------
    def add_message(self, task_id: str, role: str, content: str, events: list | None = None,
                    scope: str = "", sender: str = "") -> dict[str, Any]:
        row = (uuid.uuid4().hex, task_id, role, content, json.dumps(events or [], ensure_ascii=False), now(), scope, sender)
        self.db.execute("INSERT INTO chat (id,task_id,role,content,events,created_at,scope,sender)"
                        " VALUES (?,?,?,?,?,?,?,?)", row)
        self.db.commit()
        return self.messages(task_id, scope)[-1]

    def messages(self, task_id: str, scope: str | None = None) -> list[dict[str, Any]]:
        """scope=None 拿全部（老行为）；给了 scope 就只看这个步骤的对话。
        「创新点审查」把老库里 scope='' 的也算上（那时还没分家），其余步骤各看各的。"""
        if scope in ("", "idea"):
            sql, args = "SELECT * FROM chat WHERE task_id=? AND (scope='' OR scope=?) ORDER BY created_at", (task_id, scope or "idea")
        elif scope is None:
            sql, args = "SELECT * FROM chat WHERE task_id=? ORDER BY created_at", (task_id,)
        else:
            sql, args = "SELECT * FROM chat WHERE task_id=? AND scope=? ORDER BY created_at", (task_id, scope)
        rows = self.db.execute(sql, args)
        out = []
        for r in rows:
            d = dict(r)
            try:
                d["events"] = json.loads(d["events"])
            except ValueError:
                d["events"] = []
            out.append(d)
        return out

    def clear_messages(self, task_id: str) -> int:
        n = self.db.execute("SELECT COUNT(*) n FROM chat WHERE task_id=?", (task_id,)).fetchone()["n"]
        self.db.execute("DELETE FROM chat WHERE task_id=?", (task_id,))
        self.db.commit()
        return n


# ============================ 模型调用 ============================

def open_url(req: Any, timeout: int = 30) -> Any:
    """出网统一入口。

    环境里可能挂着代理（HTTP(S)_PROXY=127.0.0.1:10090），但代理（猫猫云/mihomo）没开时，
    所有请求都会被"积极拒绝"→ 页面显示「无法连接」，跟 key 一点关系都没有。
    所以这里先探一下代理端口：活着就用代理，死了这一程直连（国内接口直连没问题，真被墙的站点再开代理）。
    """
    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy") or \
            os.environ.get("HTTP_PROXY") or os.environ.get("http_proxy") or ""
    if proxy:
        parts = urllib.parse.urlsplit(proxy if "://" in proxy else "http://" + proxy)
        try:
            with socket.create_connection((parts.hostname, parts.port or 80), timeout=0.6):
                pass                                    # 代理活着：走它
        except OSError:
            return urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=timeout)
    return urllib.request.urlopen(req, timeout=timeout)


def chat(profile: dict[str, Any], messages: list[dict[str, str]], temperature: float = 0.2,
         timeout: int = 180, max_tokens: int = 4096) -> str:
    """OpenAI 兼容 /chat/completions。没有配置模型时给出可执行的提示。"""
    return chat_raw(profile, messages, temperature=temperature, timeout=timeout, max_tokens=max_tokens).get("content") or ""


def chat_raw(profile: dict[str, Any], messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None = None,
             temperature: float = 0.2, timeout: int = 180, max_tokens: int = 4096) -> dict[str, Any]:
    """返回 assistant message 原始结构（含 tool_calls），供 agent 循环使用。"""
    if not profile:
        raise RuntimeError("尚未配置模型：到「模型」页添加一个 OpenAI 兼容接口并设为当前模型。")
    guards.scrub(messages, note=f"→ {profile.get('model') or '?'}")   # 出站闸门：个人信息/密钥就地打码，再发出去
    payload = {"model": profile["model"], "temperature": temperature, "max_tokens": max_tokens, "messages": messages}
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"
    req = urllib.request.Request(
        profile["base_url"].rstrip("/") + "/chat/completions",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {profile['api_key']}"} if profile.get("api_key") else {})},
        method="POST",
    )
    try:
        with open_url(req, timeout=timeout) as res:
            data = json.loads(res.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"模型接口 HTTP {exc.code}: {exc.read().decode('utf-8', 'replace')[:300]}") from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise RuntimeError(f"模型接口不可达：{exc}") from exc
    try:
        msg = data["choices"][0]["message"]
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError(f"模型回包无法解析：{str(data)[:300]}") from exc
    usage = data.get("usage") or {}
    return {"role": "assistant", "content": (msg.get("content") or "").strip(),
            "tool_calls": msg.get("tool_calls") or [],
            "usage": {"prompt": int(usage.get("prompt_tokens") or 0),
                      "completion": int(usage.get("completion_tokens") or 0),
                      "total": int(usage.get("total_tokens") or 0), "exact": bool(usage)}}


def chat_json(profile: dict[str, Any], messages: list[dict[str, str]], **kw: Any) -> Any:
    raw = chat(profile, messages, **kw)
    raw = re.sub(r"^```(?:json)?\s*|```$", "", raw.strip(), flags=re.I).strip()
    match = re.search(r"[\[{].*[\]}]", raw, re.S)
    if not match:
        raise RuntimeError(f"模型没有返回 JSON：{raw[:200]}")
    return json.loads(match.group(0))


def discover_models(base_url: str, api_key: str = "", timeout: int = 25) -> list[dict[str, str]]:
    """GET {base_url}/models —— 一键发现模型。OpenAI 兼容网关基本都认这条。"""
    req = urllib.request.Request(
        base_url.rstrip("/") + "/models",
        headers={"Authorization": f"Bearer {api_key}"} if api_key else {},
    )
    try:
        with open_url(req, timeout=timeout) as res:
            data = json.loads(res.read().decode("utf-8", "replace"))
    except (urllib.error.URLError, TimeoutError) as exc:
        raise RuntimeError(f"发现模型失败：{exc}") from exc
    rows = data.get("data") if isinstance(data, dict) else None
    if not isinstance(rows, list):
        # ponytail: 有些网关只给非标准结构，这时让用户手填模型 id
        raise RuntimeError("该网关没有返回标准模型列表，请手动填写模型 id")
    return [{"id": str(r.get("id") or r.get("name") or ""),
             "name": str(r.get("name") or r.get("id") or "")} for r in rows if (r.get("id") or r.get("name"))]


def test_provider(base_url: str, api_key: str, model: str, timeout: int = 60) -> str:
    """发一条最小消息，证明 Key/地址/模型名三者真的能打通。"""
    return chat({"base_url": base_url, "api_key": api_key, "model": model},
                [{"role": "user", "content": "回复两个字：可用"}], timeout=timeout, max_tokens=64)


# ============================ 论文搜索（开放接口） ============================

def _get(url: str, timeout: int = 30) -> bytes:
    with open_url(urllib.request.Request(url, headers=UA), timeout=timeout) as res:
        return res.read()


def search_crossref(query: str, rows: int = 10) -> list[dict[str, Any]]:
    url = ("https://api.crossref.org/works?rows=%d&filter=type:journal-article&query=%s"
           % (rows, urllib.parse.quote(query)))
    items = json.loads(_get(url).decode("utf-8", "replace")).get("message", {}).get("items", [])
    out = []
    for it in items:
        authors = "; ".join(filter(None, (f"{a.get('family','')} {a.get('given','')}".strip() for a in it.get("author", [])[:6])))
        year = str((it.get("issued", {}).get("date-parts", [[""]])[0] or [""])[0] or "")
        links = [l.get("URL", "") for l in it.get("link", []) if l.get("content-type") == "application/pdf"]
        out.append({"source": "crossref", "title": _text((it.get("title") or [""])[0]), "authors": authors, "year": year,
                    "doi": it.get("DOI", ""), "url": it.get("URL", ""), "pdf_url": links[0] if links else "",
                    "abstract": _text(it.get("abstract", ""))[:800]})
    return out


def _oa_pdf(w: dict[str, Any]) -> str:
    """从 OpenAlex work 里挖出开放获取 PDF 直链：先 best_oa_location，再所有 locations，最后 oa_url(仅当它是 .pdf)。"""
    locs = [w.get("best_oa_location") or {}] + list(w.get("locations") or [])
    for l in locs:
        u = (l.get("pdf_url") or "").strip()
        if u:
            return u
    oa = ((w.get("open_access") or {}).get("oa_url") or "").strip()
    return oa if oa.lower().endswith(".pdf") else ""


def search_openalex(query: str, rows: int = 10) -> list[dict[str, Any]]:
    url = ("https://api.openalex.org/works?per-page=%d&filter=type:article&search=%s"
           % (rows, urllib.parse.quote(query)))
    items = json.loads(_get(url).decode("utf-8", "replace")).get("results", [])
    out = []
    for it in items:
        authors = "; ".join(a.get("author", {}).get("display_name", "") for a in it.get("authorships", [])[:6])
        pdf = _oa_pdf(it)
        out.append({"source": "openalex", "title": _text(it.get("title", "")), "authors": authors,
                    "year": str(it.get("publication_year") or ""), "doi": (it.get("doi") or "").replace("https://doi.org/", ""),
                    "url": it.get("id", ""), "pdf_url": pdf or "", "abstract": _text(it.get("title", ""))[:800]})
    return out


def search_arxiv(query: str, rows: int = 10) -> list[dict[str, Any]]:
    url = "http://export.arxiv.org/api/query?search_query=all:%s&max_results=%d" % (urllib.parse.quote(query), rows)
    feed = _get(url).decode("utf-8", "replace")
    out = []
    for entry in re.findall(r"<entry>(.*?)</entry>", feed, re.S):
        get = lambda tag: (re.search(rf"<{tag}[^>]*>(.*?)</{tag}>", entry, re.S) or [None, ""])[1]
        aid = get("id")
        pdf = ""
        for tag in re.findall(r"<link[^>]*>", entry):        # 属性顺序不固定（href 常在 title 前），按整条 link 判
            if 'title="pdf"' in tag or "application/pdf" in tag:
                m = re.search(r'href="([^"]+)"', tag)
                if m:
                    pdf = m.group(1)
                    break
        out.append({"source": "arxiv", "title": _text(get("title")), "year": (get("published") or "")[:4],
                    "authors": "; ".join(re.findall(r"<name>(.*?)</name>", entry)[:6]), "doi": "",
                    "url": aid, "pdf_url": pdf, "abstract": _text(get("summary"))[:800],
                    "arxiv_id": (aid or "").rsplit("/", 1)[-1]})
    return out


SOURCES = {"crossref": search_crossref, "openalex": search_openalex, "arxiv": search_arxiv}


def enrich_oa(items: list[dict[str, Any]], chunk: int = 40) -> int:
    """给还没有 pdf_url 的条目补开放获取直链：按 DOI 批量反查 OpenAlex（一次 ≤40 个 DOI）。
    只补链接、不改标题摘要；查到几条算几条。"""
    need = [i for i in items if (i.get("doi") or "").strip() and not (i.get("pdf_url") or "").strip()]
    filled = 0
    for i in range(0, len(need), chunk):
        part = need[i:i + chunk]
        flt = "|".join(sorted({p["doi"].strip().lower() for p in part}))
        try:
            data = json.loads(_get("https://api.openalex.org/works?per-page=50&filter=doi:"
                                   + urllib.parse.quote(flt)).decode("utf-8", "replace"))
        except Exception:                      # 补链接失败不影响检索结果
            return filled
        by = {}
        for w in data.get("results") or []:
            doi = (w.get("doi") or "").replace("https://doi.org/", "").lower()
            pdf = _oa_pdf(w)
            if doi and pdf:
                by[doi] = pdf
        for it in part:
            u = by.get(it["doi"].strip().lower())
            if u:
                it["pdf_url"] = u
                filled += 1
    return filled


# ============================ 文献库星图（知识网络总览） ============================

_TERM_STOP = {
    "the", "and", "for", "with", "from", "into", "using", "based", "via", "under", "their", "this", "that",
    "study", "studies", "analysis", "review", "effect", "effects", "novel", "new", "toward", "towards",
    "approach", "method", "methods", "model", "models", "system", "systems", "high", "low", "between",
    "performance", "application", "applications", "using", "results", "based", "through", "during",
}
_GRAPH_CACHE: dict[str, dict[str, Any]] = {}     # ponytail: 进程内缓存（键含结果条数，变了就重算）；要跨会话缓存再加表


def lit_terms(title: str) -> set[str]:
    """标题里能当主题词的低频词（去掉停用词/太短的词）。"""
    words = re.findall(r"[A-Za-z][A-Za-z\-]{3,}", (title or "").lower())
    return {w for w in words if w not in _TERM_STOP}


def lit_clusters(items: list[dict[str, Any]], top: int = 5) -> list[dict[str, Any]]:
    """按标题高频词分组当「分支卡」：取文档频率最高的词，且与已选分支重叠 ≥80% 的丢掉（免得两张卡是同一批文献）。"""
    docs = {i["id"]: lit_terms(i.get("title") or "") for i in items}
    df: dict[str, int] = {}
    for terms in docs.values():
        for w in terms:
            df[w] = df.get(w, 0) + 1
    picked: list[tuple[str, set[str]]] = []
    for term, n in sorted(df.items(), key=lambda kv: (-kv[1], kv[0])):
        if len(picked) >= top:
            break
        if n < 2:                                # 只出现一次的标题词当不了分支
            break
        hits = {i for i, terms in docs.items() if term in terms}
        if any(len(hits & seen) >= 0.8 * len(hits) for _, seen in picked):
            continue
        picked.append((term, hits))
    return [{"term": t, "ids": sorted(ids), "count": len(ids)} for t, ids in picked]


def _openalex_works(dois: list[str], chunk: int = 40) -> dict[str, dict[str, Any]]:
    """按 DOI 批量反查 OpenAlex：拿每篇的 OpenAlex id + 参考文献表 + 被引数（一次 ≤40 个 DOI）。"""
    out: dict[str, dict[str, Any]] = {}
    for i in range(0, len(dois), chunk):
        part = sorted({d.strip().lower() for d in dois[i:i + chunk] if d.strip()})
        if not part:
            continue
        flt = "|".join(part)
        url = ("https://api.openalex.org/works?per-page=50&select=id,doi,referenced_works,cited_by_count&filter=doi:"
               + urllib.parse.quote(flt))
        try:
            data = json.loads(_get(url).decode("utf-8", "replace"))
        except Exception:                        # 拿不到边就别画边，节点照画
            continue
        for w in data.get("results") or []:
            doi = (w.get("doi") or "").replace("https://doi.org/", "").lower()
            if doi:
                out[doi] = w
    return out


def litgraph(db: Any, task_id: str, top: int = 5) -> dict[str, Any]:
    """文献库星图 = 本项目的检索结果当节点集，OpenAlex 补它们**之间**的引用边。"""
    items = db.results(task_id)
    if not items:
        return {"error": "这个项目还没有检索结果 —— 先在「工作流 · 论文搜索」里搜一次。"}
    key = f"{task_id}:{len(items)}"
    if key in _GRAPH_CACHE:
        return _GRAPH_CACHE[key]

    clusters = lit_clusters(items, top)
    primary = {}
    for ci, c in enumerate(clusters):
        for i in c["ids"]:
            primary.setdefault(i, ci)

    works = _openalex_works([i.get("doi") or "" for i in items])
    oa_id = {}                                   # OpenAlex id → 我们的节点 id
    for i in items:
        w = works.get((i.get("doi") or "").strip().lower())
        if w:
            oa_id[w.get("id", "")] = i["id"]
    edges = set()
    for i in items:
        w = works.get((i.get("doi") or "").strip().lower())
        if not w:
            continue
        for ref in w.get("referenced_works") or []:
            j = oa_id.get(ref)
            if j and j != i["id"]:
                edges.add(tuple(sorted((i["id"], j))))

    nodes = []
    for i in items:
        w = works.get((i.get("doi") or "").strip().lower()) or {}
        nodes.append({
            "id": i["id"], "title": _text(i.get("title") or "")[:160], "year": i.get("year") or "",
            "authors": _text(i.get("authors") or "")[:120], "doi": i.get("doi") or "",
            "source": i.get("source") or "", "oa": bool(i.get("pdf_url")), "url": i.get("url") or "",
            "pdf": i.get("pdf_url") or "",
            "cited": w.get("cited_by_count") or 0, "cluster": primary.get(i["id"], -1),
        })
    out = {
        "center": {"title": "文献库", "sub": (db.summary(task_id).get("task") or {}).get("title", ""), "branches": len(clusters)},
        "counts": {"papers": len(items), "with_doi": len(works), "edges": len(edges), "clusters": len(clusters)},
        "clusters": clusters, "nodes": nodes, "edges": [list(e) for e in sorted(edges)],
    }
    _GRAPH_CACHE[key] = out
    return out


def search(query: str, sources: list[str] | None = None, rows: int = 10) -> list[dict[str, Any]]:
    sources = sources or list(SOURCES)
    merged: list[dict[str, Any]] = []
    errors: list[str] = []
    for name in sources:
        fn = SOURCES.get(name)
        if not fn:
            continue
        try:
            merged.extend(fn(query, rows))
        except Exception as exc:  # 单源失败不拖垮整体
            errors.append(f"{name}: {exc}")
    if not merged and errors:
        raise RuntimeError("全部检索源失败 → " + "; ".join(errors))
    return merged


# 项目位置里固定生成的六个子目录：名字 + 写进各自 README 的说明
PROJ_DIRS: list[tuple[str, str]] = [
    ("记忆", "项目记忆的落盘副本：长期记忆.md（项目要点与重要结论）、短期记忆.md（对话内容与细节）。由「创新点审查」等步骤自动维护，人工也可直接编辑，下一步再跑时会读回来。"),
    ("文献库", "开放获取(OA) 全文 PDF：文件名 = 论文标题；只放 OA 全文，付费墙文献请走学校图书馆。"),
    ("笔记", "逐篇精读的 Markdown 笔记：一份笔记一个 .md 文件，含证据表与页码。"),
    ("论文正文", "章节草稿 Markdown：draft-*.md，按章节名命名，是「文章撰写」这一步的直接产物。"),
    ("最终成品", "格式转换后的交付件：.docx / .md / .html，可直接拿去投稿或交稿。"),
    ("其余", "工作流产生的其它杂项文件：中间态导出、脚本、临时数据等，不影响主流程。"),
]


def make_project_tree(base: str | Path, task: dict[str, Any] | None = None) -> list[str]:
    """在用户选的项目位置里建好六个子目录 + 每个目录一个 README，再写一个根 README 说明结构。"""
    root = Path(str(base)).expanduser()
    root.mkdir(parents=True, exist_ok=True)
    made: list[str] = []
    for name, desc in PROJ_DIRS:
        d = root / name
        d.mkdir(parents=True, exist_ok=True)
        (d / "README.md").write_text(f"# {name}\n\n{desc}\n", encoding="utf-8")
        made.append(name)
    t = task or {}
    (root / "README.md").write_text("\n".join([
        f"# {t.get('title') or root.name}",
        "",
        "这个文件夹是「科研工作 1.0」的一个项目位置：程序按用途把文件分到下面六个子目录，",
        "每个子目录里都有一份 README.md 说明该放什么。",
        "",
        "## 项目信息",
        f"- 研究问题：{t.get('question') or '（未填）'}",
        f"- 关键词 / 材料体系：{t.get('material_system') or '（未填）'}",
        f"- 建立时间：{(t.get('created_at') or '')[:19]}",
        "",
        "## 目录结构",
        *[f"- `{name}/` —— {desc.split('：')[0]}" for name, desc in PROJ_DIRS],
        "",
    ]), encoding="utf-8")
    return made


# ============================ 下载（仅开放获取） ============================

def download_pdf(item: dict[str, Any], target_dir: Path | None = None) -> Path:
    url = (item.get("pdf_url") or "").strip()
    if not url:
        raise ValueError("这条记录没有开放获取(OA)PDF 链接；1.0 只下载 OA 全文，不绕过付费墙。")
    target_dir = target_dir or PAPERS
    target_dir.mkdir(parents=True, exist_ok=True)
    safe = re.sub(r"[^\w\-. ]+", "_", item.get("title", "paper"))[:80].strip() or "paper"
    dest = target_dir / f"{safe}.pdf"
    req = urllib.request.Request(url, headers=UA)
    with open_url(req, timeout=120) as res, dest.open("wb") as fh:
        head = res.read(5)
        if head[:4] != b"%PDF":
            raise ValueError(f"目标不是 PDF（返回：{head!r}）")
        fh.write(head)
        while True:
            chunk = res.read(1 << 16)
            if not chunk:
                break
            fh.write(chunk)
    return dest


# ============================ 七步工作流 ============================

def stage_idea(db: WorkflowDB, task_id: str, idea: str) -> dict[str, Any]:
    task = db.summary(task_id)["task"]
    profile = db.active_model()
    out = chat_json(profile, [
        {"role": "system", "content": '你是严格的科研选题评审（博导视角）。只返回 JSON：'
         '{"type":"Novel Problem|Novel Method|New Setting","story":"一句话讲清","flaws":[{"flaw":"","severity":"CRITICAL|MAJOR","defense":""}],'
         '"dims":{"Higher":0-10,"Faster":0-10,"Stronger":0-10,"Cheaper":0-10,"Broader":0-10},'
         '"dims_evidence":{"Higher":"","Faster":"","Stronger":"","Cheaper":"","Broader":""},'
         '"verdict":"Strong Accept|Accept with Revisions|Reject and Pivot","reason":"","next":["下一步 1","下一步 2"]}'
         '。评分从 5 起、凭证据或机理调分；判 Strong Accept 必须 ≥2 个维度 ≥8 且无 CRITICAL 缺陷。'},
        {"role": "user", "content": f"研究任务：{task['title']}\n研究问题：{task['question']}\n关键词 / 材料体系：{task['material_system']}\n\n待审查创新点：\n{idea}"},
    ])
    dims = out.get("dims") or {}
    dim_txt = "　".join(f"{k}：{v}/10" for k, v in dims.items() if v is not None) or "（未给分）"
    flaws = out.get("flaws") or []
    flaw_lines = [f"- [{x.get('severity')}] {x.get('flaw')}　→ {x.get('defense')}" for x in flaws] or ["- 无"]
    next_lines = [f"- {x}" for x in (out.get("next") or [])]
    md = "\n".join([
        f"# 创新点审查 · {task['title']}", "",
        f"- 类型：{out.get('type','')}", f"- 一句话：{out.get('story','')}", "",
        f"- 五维：{dim_txt}", f"- 判定：**{out.get('verdict','')}**", "", f"**理由**：{out.get('reason','')}", "",
        "## 致命缺陷", *flaw_lines,
        "", "## 下一步", *next_lines, "",
        "> 模型意见是草稿式审查，最终判断以导师与证据为准。",
    ])
    note = db.add_note(task_id, f"创新点审查 · {task['title']}", md)
    db.log_step(task_id, "idea", "done", f"判定 {out.get('verdict','')}")
    db.add_memory(task_id, "long", f"创新点审查结论：{out.get('verdict','')}｜理由：{out.get('reason','')[:160]}")
    return {"verdict": out, "note_id": note["id"], "markdown": md}


_GLUE = {"using", "based", "with", "from", "into", "this", "that", "these", "their",
         "have", "been", "were", "between", "toward", "towards", "about", "after", "before", "under"}


def _relevant(query: str, item: dict[str, Any]) -> bool:
    """相关度粗筛：查询里 ≥2 个实词（≥4 字符）出现在标题+摘要里才算命中。
    目的：挡掉「Teacher materials Volume 1」这类只蹭到一个词的噪声。关键词本来就少时不过滤。"""
    toks = [t for t in re.findall(r"[a-z0-9][a-z0-9\-]{3,}", (query or "").lower()) if t not in _GLUE]
    if len(toks) < 2:
        return True
    blob = ("%s %s" % (item.get("title") or "", item.get("abstract") or "")).lower()
    return sum(1 for t in toks if t in blob) >= 2


def stage_search(db: WorkflowDB, task_id: str, query: str, sources: list[str] | None = None, rows: int = 10) -> dict[str, Any]:
    query = (query or "").strip() or db.summary(task_id)["task"]["question"]
    if not query:
        raise ValueError("请填写检索关键词")
    raw = search(query, sources, rows)
    found = [x for x in raw if _relevant(query, x)]
    filled = enrich_oa(found)                      # 按 DOI 反查 OpenAlex，尽量把 OA 直链补全
    saved = db.cache_results(task_id, found)
    db.log_step(task_id, "search", "done", f"检索到 {len(found)} 条（粗筛掉 {len(raw) - len(found)} 条不相关），新增 {len(saved)} 条，补 OA 直链 {filled} 条")
    return {"query": query, "found": len(found), "filtered": len(raw) - len(found), "saved": saved,
            "enriched": filled, "results": db.results(task_id)}


def stage_download(db: WorkflowDB, task_id: str, result_id: str) -> dict[str, Any]:
    if not (result_id or "").strip():
        raise ValueError("没给要下载的那条检索结果 —— 在「论文搜索」里点某条的「下载 OA」，或勾选后自动下载")
    item = db.result(result_id)
    if not item:
        raise ValueError("这条检索结果不在了（可能被清过），重新搜一次")
    path = download_pdf(item, target_dir=db.pdir(task_id, "文献库"))
    paper = db.ingest_pdf(task_id, path)
    db.log_step(task_id, "download", "done", f"已入库 {paper['filename']}（{len(paper['pages'])} 页）")
    return {"paper": paper, "pdf_path": str(path)}


def stage_download_selected(db: WorkflowDB, task_id: str, result_ids: list[str]) -> dict[str, Any]:
    """论文搜索勾选 → 处理：能自动下的下到「文献库」并入库；下不到（无 OA / 403 / 不是 PDF）的进「待手动下载清单」。"""
    ids = [i for i in (result_ids or []) if i]
    if not ids:
        raise ValueError("先在「论文搜索」里勾选论文")
    db.enqueue(task_id, ids)
    done = manual = 0
    for r in db.queue(task_id):
        item = db.result(r["id"])
        if not (item.get("pdf_url") or "").strip():
            db.set_queue(task_id, r["id"], "manual", "", "无开放获取(OA) 全文，需手动下载")
            manual += 1
            continue
        try:
            path = download_pdf(item, target_dir=db.pdir(task_id, "文献库"))
            db.ingest_pdf(task_id, path)
            db.set_queue(task_id, r["id"], "downloaded", str(path), "")
            done += 1
        except Exception as exc:                       # 403 / 落地页不是 PDF / 超时 → 交给人工
            db.set_queue(task_id, r["id"], "manual", "", f"自动下载失败：{exc}")
            manual += 1
    db.log_step(task_id, "download", "done", f"勾选 {len(ids)} 条：自动下载 {done} 篇，待手动 {manual} 篇")
    return {"selected": len(ids), "downloaded": done, "manual": manual, "items": db.queue(task_id)}


def is_paper_pdf(path: Any) -> bool:
    """这算不算「一篇论文」：overleaf 编出来的成品、_build 里的、旁边有同名 .tex 的、<20KB 的都跳过。"""
    p = Path(str(path))
    low = str(p).replace("\\", "/").lower()
    if "_build" in low or "/overleaf/" in low or "/__pycache__/" in low:
        return False
    try:
        if p.stat().st_size < 20000:          # 太小的多半是封面/编译残件，不是论文
            return False
    except OSError:
        return False
    if p.with_suffix(".tex").exists():        # 旁边就是它的 .tex 源 → 这是编出来的
        return False
    if ".no_watermark.zh." in low:            # BabelDOC 译文（xxx.no_watermark.zh.mono|dual.pdf）不是新论文
        return False
    return True


class DeepreadStopped(Exception):
    """用户点了停止 —— 不是失败，是主动中断。"""


DEEPREAD: dict[str, dict[str, Any]] = {}      # task_id -> 进度（内存；重启即丢，这是刻意的）


def deepread_state(task_id: str) -> dict[str, Any] | None:
    return DEEPREAD.get(task_id)


def deepread_stop(task_id: str) -> dict[str, Any]:
    st = DEEPREAD.get(task_id)
    if st:
        st["stop"] = True
    return {"ok": True, "stopping": bool(st)}


def deepread_kick(db_path: str, task_id: str) -> dict[str, Any]:
    """把「一键精读」扔到后台跑（原来同步跑，篇多会卡死界面、也停不下来）。"""
    if task_id in DEEPREAD:
        return {"started": False, "reason": "这个项目已经在精读了"}
    DEEPREAD[task_id] = {"total": 0, "done": 0, "failed": 0, "skipped": [],
                         "current": "准备中", "phase": "running", "stop": False, "errors": []}
    import threading
    threading.Thread(target=_deepread_worker, args=(db_path, task_id), daemon=True).start()
    return {"started": True}


def _deepread_worker(db_path: str, task_id: str) -> None:
    st = DEEPREAD[task_id]
    try:
        with WorkflowDB(db_path) as db:
            folder = db.pdir(task_id, "文献库")
            known = {p["filename"] for p in db.papers_of(task_id)}
            skipped = []
            for pdf in sorted(folder.glob("*.pdf")):
                if st.get("stop"):
                    st["phase"] = "stopped"
                    return
                if pdf.name in known:
                    continue
                if not is_paper_pdf(pdf):
                    skipped.append(pdf.name)
                    continue
                st["current"] = "入库 " + pdf.name[:44]
                try:
                    db.ingest_pdf(task_id, pdf)
                except Exception as exc:
                    st["failed"] += 1
                    st["errors"].append("入库 %s: %s" % (pdf.name[:30], exc))
            st["skipped"] = skipped
            papers = db.papers_of(task_id)
            if not papers:
                raise ValueError("这个项目的「文献库」里没有可精读的 PDF —— 先搜一篇下下来，或把 PDF 丢进文献库")
            st["total"] = len(papers)
            for i, p in enumerate(papers, 1):
                if st.get("stop"):
                    st["phase"] = "stopped"
                    return
                st["current"] = p["filename"][:46]
                try:
                    stage_read(db, task_id, p["id"], should_stop=lambda: bool(st.get("stop")))
                except DeepreadStopped:
                    st["phase"] = "stopped"
                    return
                except Exception as exc:
                    st["failed"] += 1
                    st["errors"].append("%s: %s" % (p["filename"][:30], exc))
                st["done"] = i
            db.log_step(task_id, "notes", "done", "精读 %d 篇（失败 %d，跳过非论文 %d）" % (st["done"], st["failed"], len(skipped)))
            st["phase"] = "done"
    except Exception as exc:
        st["phase"] = "failed"
        st["error"] = "%s: %s" % (type(exc).__name__, exc)
    finally:
        st["current"] = ""




def stage_read(db: WorkflowDB, task_id: str, paper_id: str, per_page: int = 6000,
               should_stop: Any = None) -> dict[str, Any]:
    """逐页精读：把每页文本连同页码交给模型，要求中文要点 + 可引用原文。"""
    profile = db.active_model()
    paper = db.paper(paper_id)
    if paper["text_chars"] < 100:
        raise ValueError("这篇 PDF 疑似扫描件，没有文本层，无法精读。")
    chunks, buf, size = [], [], 0
    for p in paper["pages"]:
        block = f"[PAGE {p['page_no']}]\n{p['text'][:per_page]}"
        if size + len(block) > 24000 and buf:
            chunks.append("\n\n".join(buf)); buf, size = [], 0
        buf.append(block); size += len(block)
    if buf:
        chunks.append("\n\n".join(buf))
    parts = []
    for i, chunk in enumerate(chunks, 1):
        if should_stop and should_stop():      # 每段检查一次：停就立刻不读了
            raise DeepreadStopped()
        parts.append(chat(profile, [
            {"role": "system", "content": READ_SYSTEM},
            {"role": "user", "content": f"论文：{paper['filename']}（第 {i}/{len(chunks)} 段）\n\n{chunk}"},
        ], max_tokens=3000))
    md = f"# 精读 · {paper['filename']}\n\n" + "\n\n".join(parts)
    note = db.add_note(task_id, f"精读 · {paper['filename']}", md, paper_id)
    db.log_step(task_id, "download", "done", f"精读完成：{paper['filename']}")
    return {"note_id": note["id"], "markdown": md, "chunks": len(chunks)}


def stage_notes(db: WorkflowDB, task_id: str, note_id: str, vault: str | None = None, apply: bool = False) -> dict[str, Any]:
    """把精读笔记整理成结构化知识库笔记（含证据表），可选写入 Obsidian。"""
    src = db.note(note_id)
    rows = [dict(r) for r in db.evidence(task_id)]
    prof = db.active_model()
    md = src["markdown"]
    # 先用严格闸门抽取候选证据，拒绝页码/原文对不上的条目
    from research_core import extract_ai
    if src.get("paper_id") and prof:
        try:
            extract_ai(db, task_id, src["paper_id"], prof["base_url"], prof["api_key"], prof["model"])
        except Exception:
            pass  # 抽不到证据不阻塞笔记整理
    rows = [dict(r) for r in db.evidence(task_id)]
    lines = [f"# 知识库笔记 · {src['title']}", "", "## 要点", "", md, "", "## 证据（回查原文）", ""]
    lines += [f"- **{r['field']}**：{r['value']}（{r['filename']}，p.{r['page_no']}）\n  - 原文：{r['excerpt']}" for r in rows] or ["- 暂无"]
    body = "\n".join(lines)
    note = db.add_note(task_id, f"笔记 · {src['title']}", body, src.get("paper_id"))
    result = {"note_id": note["id"], "markdown": body, "evidence": len(rows)}
    if vault:
        from integrations import apply_obsidian_preview, obsidian_preview
        preview = obsidian_preview(vault, src["title"], body)
        result["preview"] = {k: preview[k] for k in ("target", "exists", "confirm_token")}
        if apply:
            result["written"] = apply_obsidian_preview(preview, preview["confirm_token"])
    db.log_step(task_id, "notes", "done", f"知识库笔记已生成（证据 {len(rows)} 条）")
    return result


def stage_write(db: WorkflowDB, task_id: str, title: str = "", section: str = "引言") -> dict[str, Any]:
    profile = db.active_model()
    task = db.summary(task_id)["task"]
    notes = db.notes(task_id)
    ev = [dict(r) for r in db.evidence(task_id)]
    context = "\n\n".join(f"### {n['title']}\n{n['markdown'][:6000]}" for n in notes[:6])
    ev_text = "\n".join(f"- {r['field']}: {r['value']}（{r['filename']} p.{r['page_no']}）" for r in ev[:60])
    md = chat(profile, [
        {"role": "system", "content": f"你是中文材料科学论文写作助手。按《{section}》写，只使用给定资料，每个关键结论后用（文献名 p.页码）标注出处；资料没给的写「资料不足」，禁止编造数据或引用。"},
        {"role": "user", "content": f"题目：{title or task['title']}\n研究问题：{task['question']}\n关键词：{task['material_system']}\n\n== 笔记 ==\n{context}\n\n== 证据 ==\n{ev_text}"},
    ], max_tokens=4000)
    doc = f"# {title or task['title']} · {section}\n\n{md}\n"
    out = db.pdir(task_id, "论文正文") / f"draft-{task_id[:8]}-{section}.md"
    out.write_text(doc, encoding="utf-8")
    db.log_step(task_id, "write", "done", f"{section} 草稿 {len(md)} 字")
    return {"markdown": doc, "path": str(out)}


def stage_review(db: WorkflowDB, task_id: str, draft: str) -> dict[str, Any]:
    profile = db.active_model()
    ev = [dict(r) for r in db.evidence(task_id)]
    ev_text = "\n".join(f"- {r['field']}: {r['value']}（{r['filename']} p.{r['page_no']}）" for r in ev[:60])
    out = chat_json(profile, [
        {"role": "system", "content": "你是严格审稿人。只返回 JSON：{\"verdict\":\"接受|小修|大修|拒稿\",\"scores\":{\"证据\":0-5,\"逻辑\":0-5,\"表达\":0-5},\"issues\":[{\"severity\":\"高|中|低\",\"quote\":\"原文片段\",\"problem\":\"\",\"fix\":\"\"}],\"missing_evidence\":[\"...\"]}"},
        {"role": "user", "content": f"== 稿件 ==\n{draft[:24000]}\n\n== 已登记证据 ==\n{ev_text}"},
    ])
    md = "\n".join([
        "# 稿件审查", "", f"- 结论：**{out.get('verdict','')}**", f"- 评分：{out.get('scores',{})}", "",
        "## 问题", *[f"- [{i.get('severity')}] {i.get('problem')}\n  - 原文：{i.get('quote')}\n  - 建议：{i.get('fix')}" for i in out.get("issues", [])], "",
        "## 证据缺口", *[f"- {x}" for x in out.get("missing_evidence", [])], "",
        "> 审查意见为草稿，是否采纳由作者判断。",
    ])
    note = db.add_note(task_id, "稿件审查", md)
    db.log_step(task_id, "review", "done", f"结论 {out.get('verdict','')}")
    return {"review": out, "markdown": md, "note_id": note["id"]}


def stage_convert(db: WorkflowDB, task_id: str, markdown: str, fmt: str = "docx", name: str = "paper") -> dict[str, Any]:
    fmt = (fmt or "docx").lower()
    safe = re.sub(r"[^\w\-. ]+", "_", name)[:60] or "paper"
    folder = db.pdir(task_id, "最终成品")
    if fmt == "md":
        dest = folder / f"{safe}.md"; dest.write_text(markdown, encoding="utf-8")
    elif fmt == "html":
        import html as _html
        body = "\n".join(
            f"<h{min(len(m.group(1)), 6)}>{_html.escape(m.group(2))}</h{min(len(m.group(1)), 6)}>"
            if (m := re.match(r"^(#{1,6})\s+(.*)$", line))
            else (f"<li>{_html.escape(line[2:])}</li>" if line.startswith("- ") else f"<p>{_html.escape(line)}</p>" if line.strip() else "")
            for line in markdown.splitlines())
        dest = folder / f"{safe}.html"
        dest.write_text(f"<!doctype html><meta charset='utf-8'><body>{body}</body>", encoding="utf-8")
    elif fmt == "docx":
        try:
            from docx import Document
        except ImportError as exc:
            raise RuntimeError("未安装 python-docx，无法导出 docx（可改用 md/pdf 或 `py -3.10 -m pip install python-docx`）") from exc
        doc = Document()
        for line in markdown.splitlines():
            m = re.match(r"^(#{1,6})\s+(.*)$", line)
            if m:
                doc.add_heading(m.group(2), level=min(len(m.group(1)), 4))
            elif line.startswith("- "):
                doc.add_paragraph(line[2:], style="List Bullet")
            elif line.strip():
                doc.add_paragraph(line)
        dest = folder / f"{safe}.docx"; doc.save(str(dest))
    else:
        raise ValueError(f"不支持的格式：{fmt}（可用 md/html/docx）")
    db.log_step(task_id, "convert", "done", f"导出 {dest.name}")
    return {"path": str(dest), "format": fmt, "size": dest.stat().st_size}


def _doc_dir(db: "WorkflowDB", task_id: str) -> Path:
    base = db.base_dir(task_id)
    return (base / "论文正文") if base else OUT


def _doc_fallback(db: "WorkflowDB", task_id: str, name: str) -> Path:
    """项目没设位置时按项目 id 分名（否则多个项目会互相覆盖）。"""
    return _doc_dir(db, task_id) / name if db.base_dir(task_id) \
        else OUT / f"{Path(name).stem}_{task_id[:8]}{Path(name).suffix}"


# ---------------- 引用台账（后台 markdown：正文里不写标号，引用全记在这） ----------------
CITE_FILE = "引用台账.md"
CITE_JSON = "引用台账.json"


def cite_paths(db: "WorkflowDB", task_id: str) -> tuple[Path, Path]:
    return _doc_fallback(db, task_id, CITE_FILE), _doc_fallback(db, task_id, CITE_JSON)


def _cite_load(db: "WorkflowDB", task_id: str) -> list[dict[str, Any]]:
    _, js = cite_paths(db, task_id)
    try:
        data = json.loads(js.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except Exception:
        return []


def cite_sync(db: "WorkflowDB", task_id: str) -> dict[str, Any]:
    """按当前正文重算每条引用的锚点状态，然后把台账 markdown 整份重写（随时跟着前台改）。"""
    md, js = cite_paths(db, task_id)
    entries = _cite_load(db, task_id)
    draft = doc_read(db, task_id, "write")["markdown"]
    lines = ["# 引用台账",
             "",
             "> 后台文档：**正文里不插标号**，每一处引用记在这里（位置 + 文献信息）。正文一改，这里的状态跟着重算。",
             ""]
    for i, e in enumerate(entries, 1):
        anchor = (e.get("anchor") or "").strip()
        ok = bool(anchor) and anchor in draft
        e["ok"] = ok
        lines += [f"## C{i} · {e.get('section') or '（未标章节）'}", ""]
        lines.append(f"- 位置：{(e.get('section') or '（未标章节）')}" +
                     (f"，锚句：「{anchor}」" if anchor else "（没给锚句，只能靠人找）"))
        if e.get("title"):
            lines.append(f"- 文献：{e['title']}")
        if e.get("authors"):
            lines.append(f"- 作者：{e['authors']}")
        if e.get("venue") or e.get("year"):
            lines.append(f"- 出处：{e.get('venue') or '?'}{', ' + str(e['year']) if e.get('year') else ''}")
        if e.get("doi"):
            lines.append(f"- DOI：{e['doi']}")
        if e.get("pages"):
            lines.append(f"- 页数：{e['pages']}" + (f"（引用在 p.{e['cite_page']}）" if e.get("cite_page") else ""))
        if e.get("url"):
            lines.append(f"- 链接：{e['url']}")
        if e.get("why"):
            lines.append(f"- 引用理由：{e['why']}")
        lines.append(f"- 状态：{'✓ 锚句还在正文里' if ok else ('⚠ 正文里找不到这句（可能已改写）' if anchor else '– 未给锚句')}")
        if e.get("paper_id"):
            lines.append(f"- 库内 paper_id：{e['paper_id']}")
        lines.append("")
    md.write_text("\n".join(lines), encoding="utf-8")
    js.write_text(json.dumps(entries, ensure_ascii=False, indent=1), encoding="utf-8")
    return {"path": str(md), "count": len(entries), "stale": sum(1 for e in entries if not e.get("ok")),
            "markdown": "\n".join(lines)}


def cite_read(db: "WorkflowDB", task_id: str) -> dict[str, Any]:
    out = cite_sync(db, task_id)                    # 读之前先同步（这就是「随时根据前台调整改变」）
    out["exists"] = True
    return out


def cite_add(db: "WorkflowDB", task_id: str, args: dict[str, Any]) -> dict[str, Any]:
    """加一条引用（位置 + 文献信息），细节到题目/DOI/页数。"""
    entries = _cite_load(db, task_id)
    fields = ("section", "anchor", "title", "authors", "venue", "year", "doi", "pages", "cite_page",
              "url", "why", "paper_id")
    e = {k: (args.get(k) or "") for k in fields}
    if not any(e.values()):
        raise ValueError("这条引用什么都没给")
    entries.append(e)
    md, js = cite_paths(db, task_id)
    md.parent.mkdir(parents=True, exist_ok=True)
    js.write_text(json.dumps(entries, ensure_ascii=False, indent=1), encoding="utf-8")
    out = cite_sync(db, task_id)
    out["added"] = e
    return out


# ---------------- 格式转换（照 Overleaf：文件 / 代码 / 编译 → PDF） ----------------
CONV_FORMATS = {"docx": "Word (.docx)", "html": "HTML", "md": "Markdown", "latex": "LaTeX (.tex → PDF，本机 MiKTeX)"}


def md_to_tex(md: str, title: str) -> str:
    """极简 markdown → tex（标题/段落/列表够用）。真要投稿的排版还是走组内 revtex 规范。
    注意：这里**不能**用 % 或 str.format 打模板（LaTeX 自带 {} 和 % 注释）。"""
    head = [r"\documentclass[11pt,a4paper]{article}",
            r"\usepackage{ctex}          % 中文：必须 xelatex 编译（本机只装了 ctex/revtex，别引别的宏包）",
            r"\setlength{\textwidth}{16cm}",
            r"\setlength{\oddsidemargin}{0pt}",
            r"\setlength{\evensidemargin}{0pt}",
            r"\title{" + tex_escape(title) + "}",
            r"\date{\today}",
            r"\begin{document}",
            r"\maketitle",
            ""]
    body: list[str] = []
    bullets: list[str] = []
    for line in (md or "").splitlines():
        m = re.match(r"^(#{1,6})\s+(.*)$", line)
        if bullets and (not line.startswith("- ") or m):
            body += [r"\begin{itemize}", *bullets, r"\end{itemize}", ""]
            bullets = []
        if m:
            lvl, txt = len(m.group(1)), tex_escape(m.group(2))
            body.append(r"\section{%s}" % txt if lvl <= 2 else (r"\subsection{%s}" % txt if lvl == 3 else r"\subsubsection{%s}" % txt))
        elif line.startswith("- "):
            bullets.append(r"\item " + tex_escape(line[2:]))
        elif line.strip():
            body.append(tex_escape(line))
            body.append("")
    if bullets:
        body += [r"\begin{itemize}", *bullets, r"\end{itemize}"]
    return "\n".join(head + body + ["", r"\end{document}", ""])


_TEX_MAP = {"\\": r"\textbackslash{}", "&": r"\&", "%": r"\%", "$": r"\$", "#": r"\#", "_": r"\_",
            "{": r"\{", "}": r"\}", "~": r"\textasciitilde{}", "^": r"\textasciicircum{}"}


def tex_escape(s: str) -> str:
    return "".join(_TEX_MAP.get(c, c) for c in (s or ""))    # 逐字符换，避免把插入的反斜杠再转义一遍


def _xelatex() -> str:
    """本机 MiKTeX 的 xelatex（用户级装的那种）。"""
    cand = Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "MiKTeX" / "miktex" / "bin" / "x64" / "xelatex.exe"
    if cand.is_file():
        return str(cand)
    return "xelatex"


def conv_run(db: "WorkflowDB", task_id: str, fmt: str, source: str = "") -> dict[str, Any]:
    """一键格式转换：以正文.md（或指定文件）为源，导出到「最终成品」。latex 会就地编译出 PDF。"""
    fmt = (fmt or "docx").lower()
    src = Path(source) if source else doc_path(db, task_id, "write")
    md = src.read_text(encoding="utf-8", errors="replace") if src.is_file() else ""
    if not md.strip():
        raise ValueError(f"源文件是空的：{src}（先在「论文撰写」写出正文）")
    title = doc_read(db, task_id, "outline")["markdown"].splitlines()
    title = next((l.lstrip("# ").strip() for l in title if l.strip().startswith("#")),
                 db.summary(task_id)["task"]["title"] or Path(src).stem)      # 没框架就用项目名，别叫「正文」
    folder = db.pdir(task_id, "最终成品")
    safe = re.sub(r"[^\w\-. ]+", "_", title)[:60] or "paper"
    out = folder / f"{safe}.{'pdf' if fmt == 'latex' else fmt}"
    if fmt == "md":
        out.write_text(md, encoding="utf-8")
    elif fmt in ("docx", "html"):
        stage_convert(db, task_id, md, fmt, safe)
        out = folder / f"{safe}.{fmt}"
    elif fmt == "latex":
        build = folder / "_tex"
        build.mkdir(parents=True, exist_ok=True)
        tex_path = build / f"{safe}.tex"
        tex_path.write_text(md_to_tex(md, title), encoding="utf-8", newline="\n")   # 必须 LF：CR 会让 TeX 报 ^^M
        env = dict(os.environ)
        env["PATH"] = str(Path(_xelatex()).parent) + os.pathsep + env.get("PATH", "")
        proc = subprocess.run([_xelatex(), "-interaction=nonstopmode", "-halt-on-error", tex_path.name],
                              cwd=str(build), env=env, capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=180)
        made = build / f"{safe}.pdf"
        if proc.returncode != 0 or not made.is_file():
            tail = "\n".join((proc.stdout or "").splitlines()[-12:])
            raise RuntimeError(f"xelatex 失败（退出码 {proc.returncode}）：{tail[-600:]}")
        shutil.copy2(made, out)
    else:
        raise ValueError(f"不支持的格式：{fmt}（可用 {'/'.join(CONV_FORMATS)}）")
    db.log_step(task_id, "convert", "done", f"导出 {out.name}")
    return {"path": str(out), "name": out.name, "format": fmt, "size": out.stat().st_size,
            "pdf": fmt == "latex", "source": str(src)}


CONV_EXT = (".md", ".tex", ".txt", ".json", ".csv", ".html", ".docx", ".pdf")


def conv_files(db: "WorkflowDB", task_id: str) -> dict[str, Any]:
    """左边文件区：项目里这几个子夹的可读文件（按时间倒序）+ 最新那份 PDF（右边默认预览它）。"""
    rows: list[dict[str, Any]] = []
    labels = [("论文正文", _doc_dir(db, task_id)), ("最终成品", db.pdir(task_id, "最终成品")),
              ("LaTeX 源文件", db.pdir(task_id, "最终成品") / "_tex")]
    newest_pdf = ""
    seen: set[str] = set()
    for label, d in dict.fromkeys(labels):
        if not d.is_dir():
            continue
        for p in sorted(d.glob("*"), key=lambda x: -x.stat().st_mtime if x.is_file() else 0):
            if not p.is_file() or p.suffix.lower() not in CONV_EXT or str(p) in seen:
                continue                       # 没设项目位置时论文正文/最终成品是同一个目录，别把同一份列两遍
            if p.name.startswith(CITE_FILE[:-3]) and p.suffix.lower() == ".json":
                continue                       # 台账的 json 是内部账本，不摆到文件区
            seen.add(str(p))
            st = p.stat()
            rows.append({"name": p.name, "path": str(p), "ext": p.suffix.lower()[1:], "size": st.st_size,
                         "group": label, "at": datetime.fromtimestamp(st.st_mtime).strftime("%m-%d %H:%M")})
            if p.suffix.lower() == ".pdf" and not newest_pdf:
                newest_pdf = str(p)
    return {"files": rows[:80], "dirs": [str(d) for _, d in dict.fromkeys(labels)], "pdf": newest_pdf}


def conv_compile(path: str) -> dict[str, Any]:
    """编译任意一份 .tex（代码区「⚙ 编译」用）：产物 PDF 放在同目录。"""
    p = _safe_path(path)
    if p.suffix.lower() != ".tex" or not p.is_file():
        raise ValueError("只能编译 .tex 文件")
    pdf = p.with_suffix(".pdf")
    env = dict(os.environ)
    env["PATH"] = str(Path(_xelatex()).parent) + os.pathsep + env.get("PATH", "")
    try:
        proc = subprocess.run([_xelatex(), "-interaction=nonstopmode", "-halt-on-error", p.name],
                              cwd=str(p.parent), env=env, capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=240)
    except FileNotFoundError as exc:
        raise RuntimeError("本机没找到 xelatex（装 MiKTeX 或把它加进 PATH）") from exc
    if proc.returncode != 0 or not pdf.is_file():
        tail = "\n".join((proc.stdout or "").splitlines()[-10:])
        raise RuntimeError(f"xelatex 失败（退出码 {proc.returncode}）：{tail[-500:]}")
    return {"pdf": str(pdf), "name": pdf.name, "size": pdf.stat().st_size}


def conv_open(path: str) -> dict[str, Any]:
    """用系统默认程序打开（预览窗口右上那个 ↗）。"""
    p = _safe_path(path)
    if not p.is_file():
        raise ValueError("文件不存在")
    if hasattr(os, "startfile"):
        os.startfile(str(p))                      # noqa: S606  Windows 专用，够用
        return {"opened": str(p)}
    raise RuntimeError("这个系统没有 startfile")


def _safe_path(path: str, extra_roots: list[Path] | None = None) -> Path:
    """只允许项目目录 / data 目录里的文件（读写都走它）。"""
    p = Path(path).expanduser()
    if not p.is_absolute():
        raise ValueError("必须是绝对路径")
    p = p.resolve()
    roots = [*(extra_roots or []), DATA, DATA / "uploads", PAPERS, NOTES, OUT]
    roots = [r.resolve() for r in roots if r.exists()]
    if not any(p.is_relative_to(r) for r in roots):        # 前缀比较会让 data-evil/ 混进来
        raise ValueError(f"只允许项目目录与 data 目录里的文件：{p}")
    return p


# ============================ 中译英（中文 markdown → 英文 markdown，左右对照）============================
EN_STEP = "entrans"
EN_LIMIT = 1800                                        # 每片多少字送去翻（太大容易截断）


def en_chunks(md: str, limit: int = EN_LIMIT) -> list[str]:
    """按空行切块再拼到 limit 左右 —— 尽量不切断段落；单块还超长就按行切。"""
    blocks, cur = [], ""
    for block in re.split(r"\n{2,}", md or ""):
        if cur and len(cur) + len(block) + 2 > limit:
            blocks.append(cur)
            cur = block
        else:
            cur = (cur + "\n\n" + block) if cur else block
    if cur:
        blocks.append(cur)
    out: list[str] = []
    for b in blocks:
        while len(b) > limit * 2:                      # 罕见的超长块：按行切
            cut = b.rfind("\n", 0, limit * 2)
            cut = cut if cut > limit else limit * 2
            out.append(b[:cut])
            b = b[cut:]
        if b.strip():
            out.append(b)
    return out


EN_SYSTEM = ("你是学术论文翻译。把用户给的**中文** markdown 译成**英文** markdown，"
             "只输出译文本身：不要任何解释、前言、总结，也不要用 ``` 围栏包起来。"
             "要求：markdown 结构原样保留（#/##/### 层级、列表、表格、加粗、分隔线）；"
             "公式、LaTeX、DOI、URL、数字、人名、机构名、[引用] 原样保留；"
             "术语用材料/计算领域的常用英文说法；不增删内容，不合并段落。")


def en_translate(profile: dict[str, Any], md: str) -> dict[str, Any]:
    """分片并发翻（顺序保持），返回 {text, chunks, ms}。"""
    from concurrent.futures import ThreadPoolExecutor
    chunks = en_chunks(md)
    if not chunks:
        return {"text": "", "chunks": 0, "ms": 0}
    t0 = time.time()

    def one(piece: str) -> str:
        out = chat(profile, [{"role": "system", "content": EN_SYSTEM},
                             {"role": "user", "content": piece}], temperature=0.1, max_tokens=4096)
        out = re.sub(r"^```(?:markdown|md)?\s*\n|```\s*$", "", (out or "").strip()).strip()
        return out

    with ThreadPoolExecutor(max_workers=4) as pool:
        parts = list(pool.map(one, chunks))
    return {"text": "\n\n".join(p for p in parts if p), "chunks": len(chunks),
            "ms": int((time.time() - t0) * 1000)}


def en_state(db: "WorkflowDB", task_id: str) -> dict[str, Any]:
    """默认拿「正文.md」当源；同时把上次译好的 <名字>_en.md 读回来。"""
    src = doc_path(db, task_id, "write")
    res = src.with_name(src.stem + "_en.md")
    return {"source_path": str(src), "source_text": src.read_text(encoding="utf-8", errors="replace") if src.is_file() else "",
            "result_path": str(res), "result_text": res.read_text(encoding="utf-8", errors="replace") if res.is_file() else "",
            "source_exists": src.is_file(), "result_exists": res.is_file()}


def en_run(db: "WorkflowDB", task_id: str, text: str, name: str = "") -> dict[str, Any]:
    """一键翻译：中文 markdown → 英文 markdown，存成 <源名>_en.md（和源同一目录）。"""
    md = (text or "").strip()
    if not md:
        raise ValueError("没有可翻的内容 —— 先把中文正文放进来（点左上 ＋ 或拖文件进来）")
    profile = db.active_model()
    if not profile:
        raise RuntimeError("还没配模型：去「模型」页加一个 OpenAI 兼容接口并设为当前模型")
    out = en_translate(profile, md)
    stem = re.sub(r"[\\/:*?\"<>|]+", "_", (name or "正文").strip()) or "正文"
    stem = stem[:-3] if stem.lower().endswith(".md") else stem
    folder = _doc_dir(db, task_id)
    folder.mkdir(parents=True, exist_ok=True)
    dest = folder / f"{stem}_en.md"
    dest.write_text(out["text"] + "\n", encoding="utf-8", newline="\n")
    db.log_step(task_id, "entrans", "done", f"译成 {dest.name}")
    return {"path": str(dest), "name": dest.name, "text": out["text"], "chars": len(out["text"]),
            "sections": len(re.findall(r"(?m)^#{1,6} ", out["text"])), "src_chars": len(md),
            "chunks": out["chunks"], "ms": out["ms"]}


def compose_draft(db: WorkflowDB, task_id: str) -> str:
    """把该任务下最新的草稿/审查/笔记拼成一篇可转换的稿件。"""
    task = db.summary(task_id)["task"]
    notes = db.notes(task_id)
    return "\n\n".join([f"# {task['title']}", f"> 研究问题：{task['question']}", f"> 关键词：{task['material_system']}"]
                       + [n["markdown"] for n in notes])


ACTION = {
    "idea": stage_idea, "search": stage_search, "download": stage_download,
    "read": stage_read, "notes": stage_notes, "write": stage_write,
    "review": stage_review, "convert": stage_convert,
}


# ============================ Agent：把七步当工具调用 ============================

def _schema(name: str, desc: str, props: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    return {"type": "function", "function": {"name": name, "description": desc,
            "parameters": {"type": "object", "properties": props, "required": required or []}}}


TOOL_SPECS = [
    _schema("library_overview", "查看当前任务的文献/检索结果/笔记/证据数量和最近条目，先调它了解现状。", {}),
    _schema("idea_review", "审查一个创新点：给新颖性/可行性/证据充分度评分、风险与待答问题。", {"idea": {"type": "string", "description": "待审查的创新点"}}, ["idea"]),
    _schema("paper_search", "在 OpenAlex/Crossref/arXiv 检索论文并入库。", {
        "query": {"type": "string"}, "sources": {"type": "array", "items": {"type": "string", "enum": ["openalex", "crossref", "arxiv"]}},
        "rows": {"type": "integer", "description": "每源条数，默认 10"}}, ["query"]),
    _schema("paper_download", "下载一条检索结果的开放获取(OA) PDF 并入库；没有 OA 链接会失败。", {"result_id": {"type": "string"}}, ["result_id"]),
    _schema("paper_read", "把一篇已入库 PDF 逐页精读成中文要点（带 p.页码）。", {"paper_id": {"type": "string"}}, ["paper_id"]),
    _schema("notes_compose", "把一条精读笔记整理成带证据表的知识库笔记，可选写入 Obsidian。", {"note_id": {"type": "string"}, "vault": {"type": "string"}}, ["note_id"]),
    _schema("draft_write", "用当前任务的笔记与证据起草一个章节。", {"section": {"type": "string"}, "title": {"type": "string"}}),
    _schema("draft_review", "以审稿人视角审查稿件，给出结论/评分/问题清单/证据缺口。", {"draft": {"type": "string"}}),
    _schema("format_convert", "把稿件导出为 docx / md / html。", {"format": {"type": "string", "enum": ["docx", "md", "html"]}, "name": {"type": "string"}}, ["format"]),
    _schema("calendar_add", "在日历里加一条日程并关联当前任务。", {"title": {"type": "string"}, "date": {"type": "string", "description": "YYYY-MM-DD"}, "kind": {"type": "string"}}, ["title", "date"]),
    _schema("knowledge_query", "在本任务已入库的笔记与证据里做关键词检索。", {"query": {"type": "string"}}, ["query"]),
    _schema("team_board", "看团队看板：成员各自状态 + 最近派活与执行情况（谁在跑、谁完成了、失败原因）。",
            {"project": {"type": "string", "description": "项目名或 id；不填=当前项目"}}),
    _schema("team_assign", "把一件事派给某个团队成员（Partner Agent）执行；先 team_board 看有哪些成员。",
            {"member": {"type": "string", "description": "成员名字（或 id）"},
             "prompt": {"type": "string", "description": "要它干什么，写清楚要什么产出"},
             "project": {"type": "string", "description": "项目名或 id；不填=当前项目"}}, ["member", "prompt"]),
]

TOOL_NAMES = [t["function"]["name"] for t in TOOL_SPECS]

# 创新点审查这一步只放开这两个工具：正式判定 + 记一条长期记忆
IDEA_TOOLS = [
    _schema("idea_review", "对当前创新点出正式判定（五维评分 1-10 + 致命缺陷 + 三档结论），会落成项目笔记并写入长期记忆。",
            {"idea": {"type": "string", "description": "用户要审查的创新点原文（可带上刚补充的约束）"}}, ["idea"]),
    _schema("memory_save", "把值得长期记住的结论/约束/用户偏好记一条到项目长期记忆。",
            {"text": {"type": "string", "description": "一句话，例如「用户只有 8 周 + 单卡 8G，算力受限」"}}, ["text"]),
]


# 博导 skill：直接读本机 Hermes 装的 skill 正文（找不到就用内置精简版）
SKILL_ROOTS = [Path(os.environ["RW_SKILL_DIR"])] if os.environ.get("RW_SKILL_DIR") else []
SKILL_ROOTS.append(Path.home() / "AppData" / "Local" / "hermes" / "skills")


def skill_text(*rel: str, cap: int = 7000) -> str:
    for root in SKILL_ROOTS:
        p = root.joinpath(*rel)
        if not p.is_file():
            continue
        text = p.read_text(encoding="utf-8", errors="replace")
        text = re.sub(r"^---.*?---\s*", "", text, count=1, flags=re.S)      # 去 frontmatter
        text = text.split("\n## Pitfalls")[0].split("\n## References")[0]
        return text.strip()[:cap]
    return ""


IDEA_FALLBACK = """按 idea-evaluator 的五维框架打分（Higher 更强 / Faster 更快 / Stronger 更稳 / Cheaper 更省 / Broader 更通用，各 1-10，从 5 分起、凭证据或机理调分），
先做致命缺陷审计（F1 撞车、数据反驳、可行性错配等，最多两个），再匹配生命周期与能力，最后给三档结论：
Strong Accept（≥2 个维度 8+ 且无致命缺陷）/ Accept with Revisions（可收窄）/ Reject and Pivot（被前人占位或缺陷不可修）。"""


READ_FALLBACK = "你是文献精读助手。用中文输出：每页 2-4 条要点，每条后标注 (p.页码)。只依据原文，找不到就写「本页未见相关内容」。禁止编造数字。"

# 精读用的 system：本机若有 paper-reading-reports skill 就把它的规范并进来（和博导 skill 同一套做法）
_read_skill = skill_text("research", "paper-reading-reports", "SKILL.md", cap=3000)
READ_SYSTEM = READ_FALLBACK + (f"\n\n【本机 skill：论文精读规范，按它的格式产出】\n{_read_skill}" if _read_skill else "")


def idea_system(db: "WorkflowDB", task_id: str) -> str:
    """创新点审查专用 system：限定工具 + 博导 skill 框架 + 项目记忆。"""
    task = db.summary(task_id)["task"]
    skills = "\n\n".join(x for x in (
        skill_text("research", "research-topic-selection", "SKILL.md", cap=2000),
        skill_text("idea-evaluator", "SKILL.md", cap=4500),
    ) if x) or IDEA_FALLBACK
    return f"""你是「科研工作 1.0」里这一步的创新点审查助手，用中文工作，站在博导（既严格又给建设性建议）的位置。

硬规则：
1. 这个对话 100% 绑定项目《{task['title']}》，你只做「创新点审查」这一件事；不下载文献、不精读、不撰写、不导出格式，用户要这些就说明去别的步骤。
2. 默认多轮：先问清硬约束（能拿到的数据 / 算力 / 时间 / 技能 / 目标期刊或学位要求），一次只问 1-3 个最关键的问题，别一口气拷问。
3. 信息够了再调用 idea_review 出正式判定（会落成项目笔记 + 长期记忆）；结论要落到「下一步做什么」。
4. 出现值得长期记住的结论、约束或用户偏好时，调用 memory_save 记一条（一句话，别刷屏）。
5. 不编造文献与数据；没有检索能力就写「未核实，需查文献」。你是草稿式意见，最终以导师与证据为准。

【评估框架（取自本机 skill）】
{skills}

【项目记忆】
%%MEMORY%%"""


def _overview(db: "WorkflowDB", task_id: str) -> dict[str, Any]:
    s = db.summary(task_id)
    return {"任务": s["task"]["title"], "阶段": s["task"]["stage"], "文献": s["papers"], "证据候选": s["evidence"],
            "检索结果": [{"id": r["id"], "title": r["title"][:90], "source": r["source"], "year": r["year"], "oa": bool(r["pdf_url"])} for r in db.results(task_id)[:10]],
            "文献库": [{"id": p["id"], "name": p["filename"], "pages": p["pages"]} for p in db.papers_of(task_id)[:10]],
            "笔记": [{"id": n["id"], "title": n["title"]} for n in db.notes(task_id)[:10]],
            "日历": [{"title": e["title"], "date": e["date"]} for e in db.events()[:10]]}


def _knowledge_query(db: "WorkflowDB", task_id: str, query: str) -> dict[str, Any]:
    q = query.lower().strip()
    hits = []
    for n in db.notes(task_id):
        if q in n["title"].lower() or q in n["markdown"].lower():
            idx = n["markdown"].lower().find(q)
            hits.append({"kind": "note", "id": n["id"], "title": n["title"],
                         "context": n["markdown"][max(0, idx - 120): idx + 240]})
    for e in db.evidence(task_id):
        if q in (e["value"] or "").lower() or q in e["excerpt"].lower() or q in e["field"].lower():
            hits.append({"kind": "evidence", "field": e["field"], "value": e["value"],
                         "citation": f"{e['filename']} p.{e['page_no']}", "context": e["excerpt"]})
    return {"query": query, "hits": hits[:20], "total": len(hits)}


def _tool_impl(name: str, db: "WorkflowDB", task_id: str, args: dict[str, Any], scope: str = "") -> Any:
    """scope = 当前步骤（''/'idea'/'outline'/'write'/'review'）—— doc_read/doc_write 据此决定动哪个文件。"""
    if name in ("team_board", "team_assign"):
        import team as _team                                  # 延迟导入：team 反向依赖 workflow
        tid = _team_project(db, task_id, args.get("project", ""))
        if name == "team_board":
            return _team.board(tid)
        return _team.assign(tid, args.get("member", ""), args.get("prompt", ""), trigger="leader",
                            origin="leader@" + task_id[:8])
    if name == "memory_save":
        return db.add_memory(task_id, args.get("kind", "long"), args.get("text", ""))
    if name == "library_overview":
        return _overview(db, task_id)
    if name == "knowledge_query":
        return _knowledge_query(db, task_id, args.get("query", ""))
    if name == "calendar_add":
        return db.add_event(args.get("title", ""), args.get("date", ""), task_id, args.get("kind", "milestone"))
    if name == "search":
        return stage_search(db, task_id, args.get("query", ""), args.get("sources"), int(args.get("rows", 10)))
    if name == "paper_search":
        return stage_search(db, task_id, args.get("query", ""), args.get("sources"), int(args.get("rows", 10)))
    if name == "paper_download":
        return stage_download(db, task_id, args.get("result_id", ""))
    if name == "download":
        return stage_download(db, task_id, args.get("result_id", ""))
    if name == "paper_read":
        return stage_read(db, task_id, args.get("paper_id", ""))
    if name == "read":
        return stage_read(db, task_id, args.get("paper_id", ""))
    if name == "notes_compose":
        return stage_notes(db, task_id, args.get("note_id", ""), args.get("vault") or None)
    if name == "notes":
        return stage_notes(db, task_id, args.get("note_id", ""))
    if name == "idea_review":
        return stage_idea(db, task_id, args.get("idea", ""))
    if name == "outline_write":
        return outline_write(db, task_id, args.get("markdown", ""))
    if name == "outline_read":
        return outline_read(db, task_id)
    if name == "map_write":
        return map_write(db, task_id, args.get("data") or {})
    if name == "map_read":
        return map_read(db, task_id)
    if name == "map_sources":
        return map_sources(db, task_id)
    if name == "doc_write":
        return doc_write(db, task_id, scope or "outline", args.get("markdown", ""))
    if name == "doc_read":
        return doc_read(db, task_id, scope or "outline")
    if name == "cite_add":
        return cite_add(db, task_id, args)
    if name == "cite_read":
        return cite_read(db, task_id)
    if name == "read_attachment":
        return read_attachment(args.get("path", ""), int(args.get("chars") or 8000))
    if name == "draft_write":
        return stage_write(db, task_id, args.get("title", ""), args.get("section", "引言"))
    if name == "draft_review":
        return stage_review(db, task_id, args.get("draft") or compose_draft(db, task_id))
    if name == "format_convert":
        return stage_convert(db, task_id, args.get("markdown") or compose_draft(db, task_id), args.get("format", "docx"), args.get("name", "paper"))
    raise ValueError(f"未知工具：{name}")


def run_idea(db: "WorkflowDB", task_id: str, text: str, emit: Any = None) -> dict[str, Any]:
    """创新点审查这一步：受限工具（只看创新点）+ 博导 skill 框架 + 项目长期/短期记忆。"""
    system = idea_system(db, task_id).replace("%%MEMORY%%", db.memory_block(task_id))
    return run_agent(db, task_id, text, emit, max_steps=6, system=system, tools=IDEA_TOOLS, scope="idea")


# ============================ 确认大纲 / 论文撰写 / 稿件审查（三步共用一套「左边那份文件」）============
DOC_STEPS = {
    "outline": {"file": "框架.md", "dir": "论文正文", "label": "框架",
                "hint": "大标题 `## `、小标题 `### `、每个小标题下一行 `- 说明：…`"},
    "write":   {"file": "正文.md", "dir": "论文正文", "label": "正文",
                "hint": "从框架展开成正文：标题层级跟框架一致，每节写实；数据没有就写「待补」，不要编。"},
    "review":  {"file": "正文.md", "dir": "论文正文", "label": "正文",
                "hint": "审的是同一份正文；改就整份覆盖，别只改片段。"},
}


def doc_path(db: "WorkflowDB", task_id: str, kind: str = "outline") -> Path:
    """每一步左边那份文件：设了项目位置就落「<项目>/论文正文/」，没设位置按项目 id 分名（免得互相覆盖）。"""
    d = DOC_STEPS.get(kind) or DOC_STEPS["outline"]
    base = db.base_dir(task_id)
    if base:
        return base / d["dir"] / d["file"]
    stem = d["file"].replace(".md", "")
    return OUT / f"{stem}_{task_id[:8]}.md"


def doc_read(db: "WorkflowDB", task_id: str, kind: str = "outline") -> dict[str, Any]:
    p = doc_path(db, task_id, kind)
    md = p.read_text(encoding="utf-8", errors="replace") if p.is_file() else ""
    return {"path": str(p), "exists": p.is_file(), "markdown": md, "chars": len(md),
            "sections": len(re.findall(r"(?m)^## ", md)), "subs": len(re.findall(r"(?m)^### ", md))}


# ---- 梳理精读（第 5 步）：大纲每个小标题 → 论文精读结论 / 实验数据 的谱系图 ----
MAP_FILE = "谱系.json"
MAP_TYPES = ("section", "paper", "note", "data")


def map_path(db: "WorkflowDB", task_id: str) -> Path:
    """一份 JSON，落在 <项目>/论文正文/谱系.json；没设项目位置就按项目 id 分名。"""
    base = db.base_dir(task_id)
    return (base / "论文正文" / MAP_FILE) if base else (OUT / f"谱系_{task_id[:8]}.json")


def map_read(db: "WorkflowDB", task_id: str) -> dict[str, Any]:
    p = map_path(db, task_id)
    raw: dict[str, Any] = {"nodes": [], "edges": []}
    broken = False
    if p.is_file():
        try:
            raw = json.loads(p.read_text(encoding="utf-8", errors="replace") or "{}") or {}
        except Exception:
            raw, broken = {"nodes": [], "edges": []}, True
    nodes = [n for n in (raw.get("nodes") or []) if isinstance(n, dict) and n.get("id") and n.get("label")]
    ids = {n["id"] for n in nodes}
    edges = [e for e in (raw.get("edges") or [])
             if isinstance(e, dict) and e.get("from") in ids and e.get("to") in ids]
    return {"path": str(p), "exists": p.is_file(), "broken": broken, "nodes": nodes, "edges": edges,
            "updated": raw.get("updated") or "",
            "sections": sum(1 for n in nodes if n.get("type") == "section"),
            "refs": sum(1 for n in nodes if n.get("type") != "section")}


def map_write(db: "WorkflowDB", task_id: str, data: Any) -> dict[str, Any]:
    """整份覆盖写（和 doc_write 同口径）。不合规的节点/边直接丢掉，不报错 —— 模型给脏数据也要能落盘。"""
    if isinstance(data, str):
        data = json.loads(data or "{}")
    if not isinstance(data, dict):
        raise ValueError("谱系要给 {nodes:[…], edges:[…]} 结构的 JSON")
    nodes, seen = [], set()
    for n in (data.get("nodes") or []):
        if not isinstance(n, dict) or not n.get("id") or not n.get("label"):
            continue
        nid = str(n["id"])
        if nid in seen:
            continue
        seen.add(nid)
        t = str(n.get("type") or "note")
        nodes.append({"id": nid, "type": t if t in MAP_TYPES else "note",
                      "label": str(n["label"])[:120], "detail": str(n.get("detail") or "")[:600],
                      "ref": str(n.get("ref") or "")[:300]})
    edges = [{"from": str(e["from"]), "to": str(e["to"]), "label": str(e.get("label") or "")[:40]}
             for e in (data.get("edges") or [])
             if isinstance(e, dict) and str(e.get("from")) in seen and str(e.get("to")) in seen]
    p = map_path(db, task_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"nodes": nodes, "edges": edges, "updated": now()},
                            ensure_ascii=False, indent=1), encoding="utf-8")
    return map_read(db, task_id)


def map_sources(db: "WorkflowDB", task_id: str) -> dict[str, Any]:
    """谱系图能挂哪些东西：大纲小标题 / 精读笔记 / 文献库 PDF / 实验数据（项目其余/数据 + 上传区）。"""
    md = doc_read(db, task_id, "outline")["markdown"]
    secs = re.findall(r"(?m)^###\s+(.+)$", md) or re.findall(r"(?m)^##\s+(.+)$", md)
    base = db.base_dir(task_id)
    def ls(d: Path, pats=("*",)):
        out = []
        if d.is_dir():
            for f in sorted(d.rglob("*")):
                if f.is_file() and any(f.match(x) for x in pats):
                    out.append(f.relative_to(d).as_posix())
        return out[:120]
    notes = ls(base / "笔记") if base else ls(NOTES, ("*.md",))
    papers = [p["filename"] for p in db.papers_of(task_id)]
    data = (ls(base / "其余" / "数据") if base else []) + ls(DATA / "uploads")
    return {"sections": [x.strip() for x in secs][:60], "notes": notes, "papers": papers[:60],
            "data": list(dict.fromkeys(data))[:60], "map_path": str(map_path(db, task_id))}


def doc_write(db: "WorkflowDB", task_id: str, kind: str, markdown: str) -> dict[str, Any]:
    """就地覆盖写（他要的就是「修改调整都直接在原文件改」）。"""
    p = doc_path(db, task_id, kind)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text((markdown or "").strip() + "\n", encoding="utf-8")
    out = doc_read(db, task_id, kind)
    out["written"] = True
    return out




def outline_read(db: "WorkflowDB", task_id: str) -> dict[str, Any]:
    return doc_read(db, task_id, "outline")


def outline_write(db: "WorkflowDB", task_id: str, markdown: str) -> dict[str, Any]:
    return doc_write(db, task_id, "outline", markdown)


OUTLINE_TEMPLATE = """# <题目：一句话说清做什么>

## 1. 引言
- 说明：交代研究背景与瓶颈，点出本文要解决的问题。

### 1.1 研究背景
- 说明：这个方向现在卡在哪、为什么值得做。

### 1.2 本文工作
- 说明：一句话概括本文做了什么 + 主要结论。

## 2. 方法
- 说明：这一段的核心方法与为什么选它。

### 2.1 数据与体系
- 说明：用的什么材料/数据集，规模多大，从哪来。

### 2.2 模型与流程
- 说明：具体怎么建模/怎么做实验，关键参数与判据。

## 3. 结果与讨论
- 说明：按什么顺序摆结果，每一小节回答哪个问题。

## 4. 结论
- 说明：三句话以内的结论与意义。

## 5. 局限与展望
- 说明：诚实地写清楚边界条件与下一步。
"""


DRAFT_TEMPLATE = """# <题目>

## 摘要
（待写：三到五句，问题—方法—结果—意义）

## 1. 引言
（待写）

## 2. 方法
（待写）

## 3. 结果与讨论
（待写）

## 4. 结论
（待写）
"""


def doc_seed(db: "WorkflowDB", task_id: str, kind: str = "outline") -> dict[str, Any]:
    """起稿：大纲用固定模板；正文**按已确认的框架**生成骨架（标题层级照抄，正文留「待写」）。"""
    cur = doc_read(db, task_id, kind)
    if cur["exists"] and cur["markdown"].strip():
        return cur                                       # 已经有内容就别覆盖
    if kind == "outline":
        return doc_write(db, task_id, kind, OUTLINE_TEMPLATE)
    if kind == "write":
        out = doc_read(db, task_id, "outline")
        if not out["markdown"].strip():
            return doc_write(db, task_id, kind, DRAFT_TEMPLATE)
        body = []
        for line in out["markdown"].splitlines():
            if re.match(r"^#{1,3}\s+\S", line):
                body.append(line)
                body.append("（待写）")
                body.append("")
            elif line.strip().startswith("- 说明："):
                body.append("（按框架：%s）" % line.strip()[len("- 说明："):])
                body.append("")
        return doc_write(db, task_id, kind, "\n".join(body) or DRAFT_TEMPLATE)
    return cur


ATTACH_PDF_PAGES = 6                               # 附件 PDF 最多只扫前几页：够 agent 判断，又不拖死服务
READ_MAX = 12000                                   # 附件一次最多读多少字（够 agent 判断，不炸上下文）
_FILE_ROOTS = [DATA, DATA / "uploads", PAPERS, NOTES, OUT]


def read_attachment(path: str, chars: int = 8000) -> dict[str, Any]:
    """读用户上传/项目里的文件：PDF 用 pdfio 抓正文，其余按文本读。只允许 data/ 与项目目录里的文件。"""
    if not path:
        raise ValueError("没给路径")
    p = Path(path).expanduser()
    try:
        p = p.resolve()
    except OSError as exc:
        raise ValueError(f"路径不可用：{exc}") from exc
    roots = [r.resolve() for r in _FILE_ROOTS if r.exists()]
    # 前缀比较（startswith）会让同级的 data-evil/ 混进来，必须按路径层级判断
    if not p.is_file() or not any(p.is_relative_to(r) for r in roots):
        raise ValueError(f"只读 data/ 与项目目录里的文件：{p}")
    cap = max(500, min(int(chars or 8000), READ_MAX))
    if p.suffix.lower() == ".pdf":
        text = pdfio.text(p, ATTACH_PDF_PAGES)
    else:
        text = p.read_text(encoding="utf-8", errors="replace")
    return {"path": str(p), "name": p.name, "chars": len(text), "text": text[:cap],
            "truncated": len(text) > cap}


def doc_tools(kind: str) -> list[dict[str, Any]]:
    d = DOC_STEPS.get(kind) or DOC_STEPS["outline"]
    return [
        _schema("doc_write", f"把**整份**{d['label']} markdown 覆盖写进项目里那一份 {d['file']}（就地改，不新建文件）。"
                             f"用户说「更新{d['label']}」「按这个改」时调用它，参数给完整全文。"
                             f"格式要求：{d['hint']}",
                {"markdown": {"type": "string", "description": f"完整 {d['label']} markdown 全文"}}, ["markdown"]),
        _schema("doc_read", f"读回当前{d['label']}文件（一般不用，system 里已经带了最新全文）。", {}, []),
        _schema("cite_add", "登记一条引用：正文里**不要**写 [1]/[2] 这类标号，凡是引用文献都用这个工具把"
                            "「位置 + 文献信息」记进后台的引用台账（题目/作者/出处/DOI/页数/引用页）。",
                {"section": {"type": "string", "description": "引用落在哪一节，例如「2.2 模型与流程」"},
                 "anchor": {"type": "string", "description": "正文里那句被引用的原话（照抄，用来对锚点）"},
                 "title": {"type": "string", "description": "文献题目"},
                 "authors": {"type": "string", "description": "作者，例如「Smith J., Li W. 等」"},
                 "venue": {"type": "string", "description": "期刊/会议名"},
                 "year": {"type": "string", "description": "年份"},
                 "doi": {"type": "string", "description": "DOI"},
                 "pages": {"type": "string", "description": "页码范围，例如「1-12」"},
                 "cite_page": {"type": "string", "description": "引用具体在第几页"},
                 "url": {"type": "string", "description": "链接（DOI 链接或 OA 链接）"},
                 "why": {"type": "string", "description": "为什么引它（一句话）"},
                 "paper_id": {"type": "string", "description": "如果这篇在项目文献库里，给 paper_id"}},
                ["section", "title"]),
        _schema("read_attachment", "读用户上传或项目里的文件：PDF 抓正文、文本直接读。用户在消息里给了文件路径时用它。",
                {"path": {"type": "string", "description": "文件绝对路径（附件行里给出的那种）"},
                 "chars": {"type": "integer", "description": "最多读多少字，默认 8000"}}, ["path"]),
        _schema("library_overview", "看项目现状：文献数、证据候选、检索结果、已入库 PDF、笔记。", {}, []),
        _schema("knowledge_query", "在项目知识库（笔记 + 证据）里检索关键词。",
                {"query": {"type": "string", "description": "关键词"}}, ["query"]),
        _schema("memory_save", "把值得长期记住的结论/约束/导师要求记一条到项目长期记忆。",
                {"text": {"type": "string", "description": "一句话"}}, ["text"]),
    ]


OUTLINE_TOOLS = doc_tools("outline")


def map_tools() -> list[dict[str, Any]]:
    """梳理精读这一步的工具：读写谱系 + 看数据源 + 附件/项目速览/检索/记忆（沿用 doc_tools 里那几个）。"""
    keep = {"read_attachment", "library_overview", "knowledge_query", "memory_save"}
    return [t for t in doc_tools("outline") if t["function"]["name"] in keep] + [
        _schema("map_write", "把**整份**谱系图 JSON 覆盖写进项目那一份 谱系.json（就地改，不新建）。"
                             "结构：{nodes:[{id,type,label,detail,ref}], edges:[{from,to,label}]}；"
                             "type = section（大纲小标题）/ paper（论文精读结论）/ note（笔记）/ data（实验数据）；"
                             "edges 的 from/to 必须都是已有节点 id。用户说「更新谱系」「按这个改」时就调它，给完整 JSON。",
                {"data": {"type": "string", "description": "完整 JSON 字符串（nodes + edges）"}}, ["data"]),
        _schema("map_read", "读回当前谱系图（一般不用，system 里已经带了最新那份）。", {}, []),
        _schema("map_sources", "看这一步能挂什么：大纲小标题、项目里的精读笔记、文献库 PDF、实验数据文件。",
                {}, []),
    ]


def outline_system(db: "WorkflowDB", task_id: str) -> str:
    """框架 agent 的 system：只做框架 + 固定格式 + 项目记忆 + 当前框架全文。"""
    task = db.summary(task_id)["task"]
    cur = doc_read(db, task_id, "outline")
    body = cur["markdown"][:6000] or "（还没有，等你给第一版）"
    return f"""你是「科研工作 1.0」里「确认大纲」这一步的框架 agent，用中文工作，站在合作者（懂科研、但听用户拍板）的位置。

硬规则：
1. 这个对话 100% 绑定项目《{task['title']}》，你只做一件事：把这份研究的**框架（大纲）**跟用户敲定。不做文献检索/下载/精读/撰写成稿/格式转换，用户要这些就说明去别的步骤。
2. 格式必须照这个骨架（这是这一步的产出规范，别自创层级）：
   - 大标题用 `## `（例如 `## 2. 方法`）
   - 小标题用 `### `（例如 `### 2.1 数据与体系`）
   - **每个小标题下面紧跟一行** `- 说明：<一句话讲清这一块要写什么>`
3. 默认多轮：一次只问 1-3 个最关键的问题（题目/目标期刊或学位要求/已有数据与结论/导师的硬要求），别一口气拷问。
4. 用户说「更新框架」、或你们已经敲定了改动时，**必须调用 doc_write** 写**整份** markdown（覆盖同一个文件，不要新建、不要只给片段），写完用一两句说明改了什么。
5. 不编造数据与文献；拿不准的写「待核实」。你是草稿式建议，最终以导师与证据为准。
6. 用户上传的文件会以「[附件] … 路径」出现在消息里，需要内容就调 read_attachment（PDF 会自动抓正文）。
7. 框架文件只有这一份：`{cur['path']}`（{'已存在' if cur['exists'] else '还没有'}）。

【当前框架】
{body}

【项目记忆】
%%MEMORY%%"""


MAP_FALLBACK = ("把「大纲每个小标题」和「项目里的精读笔记 / 实验数据」连成一张谱系图：每一节挂上支撑它的论文结论"
                "（写清是哪篇、什么结论、支持还是反驳），没有出处的写「待补」，不要编。")


def map_system(db: "WorkflowDB", task_id: str) -> str:
    task = db.summary(task_id)["task"]
    out = doc_read(db, task_id, "outline")
    cur = map_read(db, task_id)
    src = map_sources(db, task_id)
    skills = skill_text("research", "paper-reading-reports", "SKILL.md", cap=2500) or MAP_FALLBACK
    return f"""你是「科研工作 1.0」里「梳理精读」这一步的**结构整理 agent**，用中文工作。

硬规则：
1. 这个对话 100% 绑定项目《{task['title']}》，你只做一件事：**维护一张谱系图**（思维导图），把大纲的每个小标题和「支撑它的精读结论 / 实验数据」连起来。不做检索、下载、翻译、写作。
2. 图存在 `{cur['path']}`（{'已有图' if cur['exists'] else '还没有图'}）—— 结构：
   {{"nodes":[{{"id":"s1","type":"section","label":"2.1 掺杂元素筛选","detail":""}},
             {{"id":"p1","type":"paper","label":"Left 2025","detail":"Cu 掺杂使带隙…","ref":"<笔记文件名或 paper_id>"}},
             {{"id":"d1","type":"data","label":"XRD-2026-10.xlsx","detail":"主峰右移 0.2°","ref":"其余/数据/…"}}],
    "edges":[{{"from":"s1","to":"p1","label":"支撑"}}]}}
   type 只认 section / paper / note / data；edges 的 from/to 必须是已有节点 id。
3. 用户说「更新谱系」「把 X 挂到 Y 下面」、或你们敲定改动时，**必须调用 map_write** 写**整份** JSON（覆盖同一份，不要只给片段、不要新建文件）。
4. **必须有出处**：paper 节点的 detail 要写清是哪篇/哪条结论，data 节点要写清是哪个文件里的什么现象；**没有出处的节点不要画**，缺就写「待补：<还差什么>」。
5. 用户上传的文件以「[附件] … 路径」出现，读它用 read_attachment。要挂实验数据先调 map_sources 看现成的文件清单。
6. **能画就直接画**：用户给了材料就直接 map_write 落盘，然后说清这轮加了/改了哪几个节点；不要先反问一串。

【本机精读规范（节点的 detail 按这个写）】
{skills}

【大纲（谱系图的骨架来源）】
{out['markdown'][:5000] or '（还没有大纲 —— 提醒用户先去「确认大纲」）'}

【可以挂上来的东西】
- 大纲小标题：{'; '.join(src['sections']) or '（无）'}
- 精读笔记：{'; '.join(src['notes'][:20]) or '（无）'}
- 文献库 PDF：{'; '.join(src['papers'][:20]) or '（无）'}
- 实验数据：{'; '.join(src['data'][:20]) or '（无）'}

【当前谱系图】
{json.dumps({'nodes': cur['nodes'], 'edges': cur['edges']}, ensure_ascii=False)[:6000] or '（还没有）'}

【项目记忆】
%%MEMORY%%"""


def run_map(db: "WorkflowDB", task_id: str, text: str, emit: Any = None) -> dict[str, Any]:
    """梳理精读：受限对话（读写谱系 + 附件 + 项目速览 + 记忆）。"""
    system = map_system(db, task_id).replace("%%MEMORY%%", db.memory_block(task_id))
    return run_agent(db, task_id, text, emit, max_steps=8, system=system, tools=map_tools(), scope="map")


def run_outline(db: "WorkflowDB", task_id: str, text: str, emit: Any = None) -> dict[str, Any]:
    """确认大纲这一步：受限工具（读/写框架 + 读附件 + 库内检索）+ 框架格式规范 + 项目记忆。"""
    system = outline_system(db, task_id).replace("%%MEMORY%%", db.memory_block(task_id))
    return run_agent(db, task_id, text, emit, max_steps=8, system=system, tools=doc_tools("outline"), scope="outline")


# ---- 论文撰写：按「上一步敲定的框架」+ 本机写作工作流（paper-spine / paper-writer）写正文 ----
WRITE_FALLBACK = ("按框架逐节展开成正式论文正文：每节先给要写的内容，再落到句子；"
                  "缺数据的地方写「待补」，不编造数字与文献；术语前后一致。")


def write_system(db: "WorkflowDB", task_id: str) -> str:
    task = db.summary(task_id)["task"]
    out = doc_read(db, task_id, "outline")
    cur = doc_read(db, task_id, "write")
    cite = cite_sync(db, task_id)                    # 每次进这一步都按当前正文重算台账状态
    skills = "\n\n".join(x for x in (
        skill_text("academic-writing", "paper-spine", "SKILL.md", cap=4000),
        skill_text("paper-writer", "SKILL.md", cap=3500),
    ) if x) or WRITE_FALLBACK
    return f"""你是「科研工作 1.0」里「论文撰写」这一步的写作 agent，用中文工作（用户要英文稿就写英文），站在一作+导师之间的位置。

硬规则：
1. 这个对话 100% 绑定项目《{task['title']}》，你只做一件事：**按已确认的框架把正文写出来/改好**。不做检索、下载、精读、格式转换。
2. **必须以上一步敲定的框架为骨架**（标题层级、每节要写什么，照它来；要动结构先说清为什么，用户同意再动框架文件）。
3. 缺数据、缺文献、缺结论的地方，写「待补：<还差什么>」，**绝不编造**。数字只能来自用户给的材料或项目库。
4. 用户说「更新正文」「写进文件」、或你们敲定了改动时，**必须调用 doc_write** 写**整份** markdown（覆盖同一个文件，不要新建、不要只给片段）；可以先写一节让他看，但落盘永远是整份。
5. **能写就直接写**：用户让你写某一节、或说「按框架写」，就直接把那一节写出来（300-800 字量级，学术书面语），缺的东西写「待补：<还差什么>」——**不要先反问一串再等**；确实缺到没法动笔（比如完全不知道研究对象）才问 1 个问题。写完落盘并说清改了哪一节。
6. 用户上传的文件会以「[附件] … 路径」出现，需要内容就调 read_attachment（PDF 自动抓正文）。
7. 正文文件：`{cur['path']}`（{'已有正文' if cur['exists'] else '还没有正文'}）。
8. **引用不要写进正文**：正文里**不出现** `[1]` `[2]` 这类标号（也不要写「(Smith et al., 2024)」这种行内引用）；需要引用文献时，调 **cite_add** 把「这一处落在哪一节 + 被引用的那句原话（照抄，用来对锚点）+ 文献题目/作者/出处/年/DOI/页数/引用页」记进后台的引用台账。正文保持流畅通顺，引用关系由台账负责。

【本机写作工作流（按它的规范写）】
{skills}

【框架（上一步敲定的，必须遵守）】
{out['markdown'][:6000] or '（还没有框架 —— 提醒用户先去「确认大纲」敲定框架）'}

【引用台账（后台文档，已有 {cite['count']} 条；正文里不写标号，引用都记这里）】
{(cite['markdown'][:2500] + ('…' if len(cite['markdown']) > 2500 else '')) if cite['count'] else '（还没有引用记录 —— 需要引用文献时用 cite_add 登记）'}

【当前正文】
{cur['markdown'][:6000] or '（还没有，等你第一版）'}

【项目记忆】
%%MEMORY%%"""


# ---- 文章撰写：后台多 agent 流水线（素材官 → 写手 → 审查 → 写手定稿）----
# 口径（2026-10-07）：这一步只要「比较好的论文初稿」，不做 0→出版全链条；agent 在后台协作，前台不加界面。
PIPELINE_WORDS = ("初稿", "整篇", "全文", "全篇", "通篇", "重写", "从头", "都写", "完整", "全部", "初版")

EVIDENCE_FALLBACK = ("把项目里已有的精读笔记与证据原文块整理成写正文能直接用的素材简报：按框架每一节给出"
                     "论断/数据 + 出处（文件名 p.页码），单列缺口；没有出处的素材不许写进简报，缺就写「无出处」。")

CRITIC_FALLBACK = ("以审稿人的位置逐节核对刚写的正文：每个论断有没有素材或引用台账支撑、有没有没出处的数字与文献、"
                   "框架里定的一节是否被漏写或写跑题、术语与符号是否前后一致。只挑能在正文里直接改掉的硬伤。")

EVIDENCE_TOOLS = [
    _schema("library_overview", "看项目现状：文献数、证据候选、检索结果、已入库 PDF、笔记。先调它了解手头有什么。", {}, []),
    _schema("knowledge_query", "在项目知识库（精读笔记 + 证据原文块）里按关键词检索，返回出处与上下文。",
            {"query": {"type": "string", "description": "关键词，例如「掺杂 循环保持率」"}}, ["query"]),
    _schema("read_attachment", "读项目里或用户给的文件：PDF 抓正文、文本直接读。需要原文细节时用它。",
            {"path": {"type": "string", "description": "文件绝对路径"},
             "chars": {"type": "integer", "description": "最多读多少字，默认 8000"}}, ["path"]),
]

CRITIC_TOOLS = [
    _schema("library_overview", "看项目现状，核对写手用的材料是否真的存在。", {}, []),
    _schema("knowledge_query", "在项目知识库（精读笔记 + 证据原文块）里按关键词检索，核对正文里的数字/论断有没有出处。",
            {"query": {"type": "string", "description": "关键词"}}, ["query"]),
]


def evidence_system(db: "WorkflowDB", task_id: str) -> str:
    """素材官（后台 agent）：只出素材简报，不写正文、不落盘、不登记台账。"""
    task = db.summary(task_id)["task"]
    out = doc_read(db, task_id, "outline")
    return f"""你是「科研工作 1.0」里「文章撰写」这一步的**素材官**（后台 agent，用户看不到你的对话，只看到进度）。你在为一篇论文的正文准备**可用素材**。

硬规则：
1. 你只管素材：不写正文、不调用 doc_write、不登记引用台账 —— 你的产出是一份简报，交给后面的写手。
2. 素材只能来自**项目已有材料**：先调 library_overview 看有什么（文献/证据候选/检索结果/笔记），再用 knowledge_query 按每节的关键词检索**精读笔记与证据原文块**（证据带「文件名 p.页码」，是可直接引用的原文），需要更多原文细节时用 read_attachment 读 PDF。**不许**凭记忆写文献、数字、结论。
3. 按下面框架的每一节，一行一条给出素材，格式固定：
   `- [节标题] 一句能写进正文的论断或数据 —— 出处：文件名 p.页码`
   出处必须来自工具返回的内容；确实找不到出处的，写 `—— 出处：无（待核）`，不要编。
4. 最后单列一段「缺口」：哪些节几乎没素材、哪些数字/对比拿不到、哪些结论还没证据。照实写，不许用「需要进一步研究」这类话术凑数。
5. 全文 ≤4000 字，宁少勿虚。只输出简报本身（Markdown），不要客套、不要解释你在做什么。

【框架（上一步敲定，正文必须按它的章节结构走）】
{out['markdown'][:6000] or '（还没有框架 —— 简报里直接写「缺框架，无法按节整理」）'}

【项目记忆】
%%MEMORY%%"""


def critic_system(db: "WorkflowDB", task_id: str, brief: str) -> str:
    """审查 agent（后台）：只挑能在正文里直接改掉的硬伤，输出可执行修改指令；不落盘。"""
    task = db.summary(task_id)["task"]
    out = doc_read(db, task_id, "outline")
    cur = doc_read(db, task_id, "write")
    cite = cite_sync(db, task_id)
    return f"""你是「科研工作 1.0」里「文章撰写」这一步的**审查 agent**（后台 agent，用户看不到你的对话）。写手刚写完一版正文，你只挑**能在正文里直接改掉的硬伤**。

硬规则：
1. 逐节核对四件事：① 每个论断有没有素材/引用台账支撑；② 有没有**没出处的数字、文献、结论**（编造，最严重）；③ 框架里定的一节是否被漏写或写跑题；④ 术语、符号、单位、材料体系命名是否前后一致。
2. 输出 ≤5 条，按严重度从高到低排，每条格式固定：
   `- [节标题] 问题一句话 → 怎么改（具体到该删什么、该补什么、该把哪句改成什么）`
3. **不要**给「创新性不足」「建议加强讨论」「需要更多实验」这类空话；**不要**输出改好的正文（落盘由写手做，避免两个 agent 抢同一个文件）。
4. 一条硬伤都没有就只输出 `无硬伤`。
5. 需要核对材料是否存在时调 library_overview / knowledge_query；你的判断以项目里真实存在的材料为准。

【框架】
{out['markdown'][:3000] or '（没有框架）'}

【素材官给的素材简报（写手就是拿它写的）】
{brief[:3000] or '（简报为空）'}

【当前正文（要审的就是这一份）】
{cur['markdown'][:8000] or '（正文为空）'}

【引用台账（后台文档，共 {cite['count']} 条；正文里不写标号，引用都记这里）】
{(cite['markdown'][:1500] + '…') if cite['count'] else '（还没有引用记录）'}

【项目记忆】
%%MEMORY%%"""


def _stage(db: "WorkflowDB", task_id: str, prompt: str, system: str, tools: list[dict[str, Any]],
           emit: Any, max_steps: int) -> dict[str, Any]:
    """跑一个后台子 agent：不进对话历史、不发 done，进度照旧流给前台。"""
    return run_agent(db, task_id, prompt, emit, max_steps=max_steps, system=system,
                     tools=tools, scope="write", publish=False)


def _bullets(text: str) -> int:
    return sum(1 for line in (text or "").splitlines() if line.lstrip().startswith("-"))


def _wants_draft(text: str, has_body: bool, has_outline: bool) -> bool:
    """要不要走后台流水线：没框架一律不走（先让他去「确认大纲」，四轮模型调用换不来东西）；
    没有正文走后（第一版就是要初稿）；已有正文则只在明说「整篇/初稿/重写」这类词时走。
    ponytail: 文本判据是硬拐点、有上限 —— 误判多了就改成前台显式开关（要动 index.html，本次按约定不碰前台）。"""
    if not has_outline:
        return False
    if not has_body:
        return True
    return any(w in (text or "") for w in PIPELINE_WORDS)


def run_write(db: "WorkflowDB", task_id: str, text: str, emit: Any = None) -> dict[str, Any]:
    """「文章撰写」入口（前台签名不变）。要初稿就走后台三 agent 流水线，改一节/闲聊仍走单个 agent。"""
    out = doc_read(db, task_id, "outline")
    cur = doc_read(db, task_id, "write")
    system = write_system(db, task_id).replace("%%MEMORY%%", db.memory_block(task_id))
    if not _wants_draft(text, cur["exists"], bool(out["markdown"].strip())):
        return run_agent(db, task_id, text, emit, max_steps=8, system=system,
                         tools=doc_tools("write"), scope="write")
    return _run_write_pipeline(db, task_id, text, emit, system)


def _audit(db: "WorkflowDB", task_id: str, online: bool = False) -> dict[str, Any]:
    """引用核验闸门（确定性对账，不花模型钱）：正文 + 台账 + 库内文献。有问题就落一份「引用核验.md」。"""
    r = guards.audit(doc_read(db, task_id, "write")["markdown"], _cite_load(db, task_id),
                     db.papers_of(task_id), online=online)
    if r["bad"]:
        out = cite_paths(db, task_id)[0].with_name("引用核验.md")
        out.write_text(guards.report(r), encoding="utf-8")
        r["path"] = str(out)
    return r


def _run_write_pipeline(db: "WorkflowDB", task_id: str, text: str, emit: Any, system: str) -> dict[str, Any]:
    """素材官 → 写手（初稿）→ 审查 → 写手（定稿）。前台只看到进度 + 最后一条汇总。"""
    say = emit or (lambda _e: None)
    events: list[dict[str, Any]] = []
    db.add_message(task_id, "user", text, scope="write")
    say({"type": "user", "content": text})

    # ① 素材官：上游精读笔记 / 证据原文块 → 带出处的素材简报
    material = _stage(db, task_id, "整理这个项目可用于写正文的素材简报。", 
                      evidence_system(db, task_id).replace("%%MEMORY%%", db.memory_block(task_id)),
                      EVIDENCE_TOOLS, emit, 6)
    events += material["events"]
    brief = (material.get("reply") or "").strip()
    say({"type": "assistant", "content": f"（后台）① 素材官：{_bullets(brief)} 条素材／缺口，交给写手。"})

    brief_block = ("\n\n【素材简报（素材官整理：只能用这里的材料与出处；缺的地方写「待补：<还差什么>」，不许自己补文献和数据）】\n"
                   + (brief[:5000] or "（素材官没找到可用素材 —— 正文只能写结构，材料处一律「待补」）"))

    # ② 写手：按框架 + 素材简报出初稿（整份落盘）
    draft = _stage(db, task_id, text, system + brief_block, doc_tools("write"), emit, 8)
    events += draft["events"]
    say({"type": "assistant", "content": f"（后台）② 写手：初稿 {len(doc_read(db, task_id, 'write')['markdown'])} 字。"})

    # ③ 引用核验闸门：先机器对账（台账对不上号的列出来），再交给审查照着修
    audit = _audit(db, task_id)
    if audit["bad"]:
        say({"type": "assistant", "content":
             f"（后台）③ 引用核验：台账 {audit['total']} 条，对不上号 {len(audit['bad'])} 条 —— 已写进「引用核验.md」。"})

    # ③ 审查：只出可执行的修改指令（不落盘，避免和写手抢同一个文件）
    critic_run = _stage(db, task_id, "审查刚写的这一版正文，按硬规则给出修改指令。",
                        critic_system(db, task_id, brief).replace("%%MEMORY%%", db.memory_block(task_id))
                        + guards.audit_block(audit),
                        CRITIC_TOOLS, emit, 4)
    events += critic_run["events"]
    critic = (critic_run.get("reply") or "").strip()
    n_issues = _bullets(critic)

    # ④ 定稿：写手按审查意见改一遍（同一份正文，整份覆盖）
    fix = ("按下面的审查意见把正文改一遍：能改的直接改；确实缺材料/缺数据改不了的，写「待补：<还差什么>」并说明为什么没改；"
           "不许编造数字与文献。改完必须调用 doc_write 写**整份** markdown 覆盖当前正文。\n\n"
           f"【审查意见】\n{critic[:4000] or '（审查没给出意见）'}")
    final = _stage(db, task_id, fix, system + brief_block, doc_tools("write"), emit, 8)
    events += final["events"]

    cur = doc_read(db, task_id, "write")
    head = next((l for l in critic.splitlines() if l.lstrip().startswith("-")), "")
    digest = (f"（后台流水线完成：素材官 → 写手 → 审查 → 定稿）\n"
              f"- 素材：{_bullets(brief)} 条（含缺口）\n"
              f"- 审查意见：{n_issues} 条" + (f"，最严重一条：{head[:120]}" if head else "（无硬伤）") + "\n"
              f"- 正文：{len(cur['markdown'])} 字，已落盘 `{cur['path']}`\n"
              f"- 改法：审查意见已逐条处理；没处理的在正文里标了「待补」。要再改就说改哪节。")
    db.add_message(task_id, "assistant", digest, events, scope="write")
    db.log_step(task_id, "agent", "done", "文章撰写流水线")
    say({"type": "done", "content": digest})
    return {"reply": digest, "events": events}


# ---- 稿件审查：博导 skill 把关，先给大思路上的问题，再落到可改的细节 ----
REVIEW_FALLBACK = ("以严格审稿人的位置读全文：先说**大的思路层面**的问题（贡献是否成立、逻辑链是否闭合、"
                   "证据是否支撑结论、与前人工作的差别），再给可执行的修改建议；没说清的地方标注「需核实」。")


def review_system(db: "WorkflowDB", task_id: str) -> str:
    task = db.summary(task_id)["task"]
    cur = doc_read(db, task_id, "write")
    skills = "\n\n".join(x for x in (
        skill_text("research", "research-topic-selection", "SKILL.md", cap=1800),
        skill_text("idea-evaluator", "SKILL.md", cap=3500),
        skill_text("manuscript-writing", "SKILL.md", cap=3000),
        skill_text("pre-submission-reviewer", "SKILL.md", cap=2500),
    ) if x) or REVIEW_FALLBACK
    return f"""你是「科研工作 1.0」里「稿件审查」这一步的审查 agent，用中文工作，站在**博导/审稿人**的位置：既严格，也给建设性意见。

硬规则：
1. 这个对话 100% 绑定项目《{task['title']}》，你只做一件事：审这篇文章的正文并帮用户改。
2. **直接审，别反问**：用户说「审一遍」就把大思路上的问题给出来（最多 3 条，按严重度排：结论站不站得住 / 逻辑链 / 证据充分度 / 与前沿的关系），每条说清「问题 → 为什么是问题 → 怎么改」。没有正文就提醒他先去「论文撰写」。
3. 用户在左侧用荧光笔标了「需要改的细节」，会以「[我的标注] …」出现在消息里 —— 逐条回应，别漏。
4. 需要改正文时调用 doc_write 写**整份** markdown（就地覆盖 `正文.md`）；只讨论不改也可以。
5. 不编造文献与数据；页码/数字对不上的不当结论。你的意见是草稿式判断，最终以导师与证据为准。
6. 出现值得长期记住的结论/约束/导师要求时调用 memory_save 记一条。
7. 正文文件：`{cur['path']}`（{'已有正文' if cur['exists'] else '还没有正文 —— 提醒他先去「论文撰写」写一版'}）。

【审查框架（取自本机 skill）】
{skills}

【当前正文（上一步的产出）】
{cur['markdown'][:8000] or '（还没有正文）'}

【项目记忆】
%%MEMORY%%"""


def run_review(db: "WorkflowDB", task_id: str, text: str, emit: Any = None) -> dict[str, Any]:
    system = review_system(db, task_id).replace("%%MEMORY%%", db.memory_block(task_id))
    return run_agent(db, task_id, text, emit, max_steps=8, system=system, tools=doc_tools("review"), scope="review")


AGENT_SYSTEM = """你是「科研工作 1.0」的研究 Agent，用中文工作，只通过工具动手，不编造数据。
可用工具覆盖：创新点审查、论文搜索、OA 下载、逐页精读、知识库笔记、文章撰写、稿件审查、格式转换、日历、库内检索。
规则：
1. 先调 library_overview 或 knowledge_query 了解现状，再决定下一步；用户没说清楚目标时先问一句，不要瞎跑。
2. 工具返回的候选证据必须带页码与原文献；页码或原文对不上的条目一律不当结论。
3. 只下载开放获取全文；没有 OA 链接就如实说明，不做替代下载。
4. 每一步做完用一两句中文说明你做了什么、拿到什么、下一步建议。审查/撰写产出是草稿，不是结论。
5. 一个目标尽量用最少的工具调用完成；任务完成后直接给结论。"""


def _team_project(db: "WorkflowDB", task_id: str, raw: str) -> str:
    """团队派活的落点项目：给了名字/ID 用它；没给就用当前 task（项目对话时就是该项目）。
    首页通用对话没有项目 → 必须点名，否则直接报错（不许瞎猜一个项目去执行）。"""
    raw = (raw or "").strip()
    tasks = {t["id"]: t for t in db.tasks()}
    if raw:
        if raw in tasks:
            return raw
        low = raw.lower()
        for tid, t in tasks.items():
            if low and low in (t["title"] or "").lower():
                return tid
        raise ValueError("没有叫「%s」的项目（现有：%s）" % (raw, "、".join(t["title"] for t in tasks.values()) or "空"))
    row = db.db.execute("SELECT id FROM chats WHERE id=?", (task_id,)).fetchone()
    if row:
        raise ValueError("这是首页通用对话，没绑项目 —— 请用 project 参数指明要派给哪个项目")
    return task_id


PONY_RULES = '你是「懒但靠谱的资深工程师」（Ponytail ultra）。做事顺序：先读透要改的代码与真实流程，再挑最省的那一档——①这需求真有必要吗（YAGNI）②仓里已有现成的就复用 ③标准库能干就别写 ④平台原生特性优先 ⑤已装的依赖优先 ⑥能一行就一行 ⑦最后才写最小可用实现。禁止：没人要的抽象与脚手架、为一个实现写接口、只有一处用的硬编码色板。改 bug 改根因（先 grep 所有调用方，在最共享的那层加一次守卫），不要只堵上报的那条路。输出：先给结果/代码，再最多三行说明（跳过了什么、什么时候补）；不写设计随笔、不为简化辩护。例外（不许简化）：信任边界的输入校验、防数据丢失的错误处理、安全措施、无障碍、用户明确点名要的东西；用户坚持要全量就照做。留下一个能跑的检查（assert 自检或一个小 test），别交空壳。'


BUILTIN_ASSISTANTS = [
    {"id": "builtin-pony", "name": "Pony 模式", "avatar": "🐴", "sort_order": 0,
     "description": "懒但靠谱的资深工程师：先读透再动手，能删不加，只写最小可用实现。",
     "rules": PONY_RULES,
     "prompts": ["按 Ponytail 模式帮我改这个功能", "这段代码哪里过度设计了？", "这个 bug 的根因在哪，改一处就够吗？"]},
    {"id": "builtin-searcher", "name": "文献检索员", "avatar": "🔎", "sort_order": 1,
     "description": "开放获取检索 + 去重 + 候选表；不编造、拿不到就说拿不到。",
     "rules": "只做开放获取检索与筛选：先给候选表（标题 / 年份 / 期刊 / DOI / 是否 OA），"
              "再问要不要入库精读。拿不到的全文直接说拿不到，绝不编造数据或结论。",
     "prompts": ["检索 O3 型钠电正极近三年掺杂改性的论文，产出候选表", "把这篇的期刊和 DOI 补全", "这个方向有哪些值得读的综述"]},
    {"id": "builtin-deepread", "name": "论文精读", "avatar": "📖", "sort_order": 2,
     "description": "一篇一篇读透，产出中文阅读报告：方法、数据、结论、可借鉴与可疑之处。",
     "rules": "只依据原文说话：关键数字回原文核对，逐条标出处在（页/表/图）；原文没写的明确写「未提及」，"
              "绝不用常识补齐。报告固定四段：①这篇想解决什么 ②怎么做的（方法/参数） ③结果与证据强度 ④对我有什么用、哪里可疑。",
     "prompts": ["精读这篇，出中文阅读报告", "这篇的方法和我的体系差在哪", "它这个结论的证据够不够"]},
    {"id": "builtin-extractor", "name": "数据抽取员", "avatar": "📊", "sort_order": 3,
     "description": "从 PDF / 正文里抽结构化数据（材料-性能 / 实验参数）。",
     "rules": "只抽原文明确写了的字段，逐条给出处（页/表/句）；原文没有的字段留空并写「未提及」。",
     "prompts": ["从这篇 PDF 抽出材料-性能表", "把这些实验参数整理成表格", "这篇用的合成方法是什么"]},
    {"id": "builtin-topic", "name": "选题参谋", "avatar": "🧭", "sort_order": 4,
     "description": "判断选题能不能做、值不值得做：创新点、数据可得性、工作量与风险。",
     "rules": "先给结论（值得做 / 有条件做 / 不建议），再逐条给依据：①别人做到哪一步了 ②我的增量是什么 "
              "③数据和算力够不够 ④最可能翻车的地方。不吹可行性，缺数据就说缺数据。",
     "prompts": ["这个选题值不值得做，风险在哪", "帮我把创新点说清楚", "有没有撞车的论文"]},
    {"id": "builtin-proposal", "name": "开题报告", "avatar": "🗂", "sort_order": 5,
     "description": "搭开题报告骨架并逐节论证：背景-问题-方案-路线-预期-风险。",
     "rules": "按「背景 → 研究现状与缺口 → 科学问题 → 研究内容与技术路线 → 预期成果 → 可行性」搭骨架，"
              "每节先列 3-5 条要点再展开成段；技术路线要能落到「用什么数据、跑什么、看什么指标」。",
     "prompts": ["按这个方向写开题报告框架", "技术路线这一节怎么写才说服人", "评审最可能问什么"]},
    {"id": "builtin-survey", "name": "综述撰写", "avatar": "📚", "sort_order": 6,
     "description": "把一堆文献组织成有观点的综述：分类维度、脉络、争议、缺口。",
     "rules": "先定分类维度（别按时间流水账），再把每类文献归位、点出代表工作与争议；"
              "最后单列「还没解决的问题」当自己的切入点。引用只写真实读过的文献，不许凑数。",
     "prompts": ["把这些文献组织成综述框架", "按什么维度分类最合理", "这个领域的争议点在哪"]},
    {"id": "builtin-writer", "name": "写作搭档", "avatar": "✍️", "sort_order": 7,
     "description": "按项目框架写/改正文，逐字保真、只动该动的地方。",
     "rules": "改写时以原稿为骨架、能不改就不改；一次性说明改了哪些句子和为什么，别顺手重写整段。",
     "prompts": ["按框架写 Introduction 的第一段", "把这段改成论文语气，别改事实", "这句话有什么问题"]},
    {"id": "builtin-paperwriting", "name": "论文写作", "avatar": "📝", "sort_order": 8,
     "description": "按框架成篇写正文：一段一个论点，证据、数字、逻辑顺下来。",
     "rules": "严格贴项目框架写，不自己加章节；每段只讲一件事（主张 → 证据/数据 → 一句收束），"
              "数字只能来自已有数据，拿不准的地方写「（待补：要什么数据）」而不是编。写完列出还缺的证据清单。",
     "prompts": ["按框架把这一章写完整", "这一段证据不够，怎么补", "结论部分怎么写才不过度宣称"]},
    {"id": "builtin-writingcoach", "name": "写作指导", "avatar": "🎓", "sort_order": 9,
     "description": "教方法不代写：指出问题、给改法规则、给示范句，让你自己能写。",
     "rules": "不整段代写成稿：先指问题（位置 + 病名），再给可复用的规则，最后给 1-2 句示范并说明为什么这么写。"
              "用大白话讲，必要时打比方；结尾留一个「你试写一句，我看看」的动作。",
     "prompts": ["这段为什么读着别扭，教我改", "学术写作里怎么把话说严谨", "帮我制定一个改稿清单"]},
    {"id": "builtin-polish", "name": "语言润色", "avatar": "✒️", "sort_order": 10,
     "description": "保持原意与术语前提下润色中文/英文，改语言不改事实。",
     "rules": "只动语言，不动事实、数据和术语；改完给「原文 → 改后」对照表并说明每处为什么改。"
              "不许把限定词（可能/初步/在…条件下）删掉让结论变强，也不许加原文没有的因果。",
     "prompts": ["润色这几段，保留原意", "把口语化的表述改学术些", "这些限定词该不该保留"]},
    {"id": "builtin-entrans", "name": "中译英", "avatar": "🌐", "sort_order": 11,
     "description": "中文学术稿译成地道英文，术语一致、句式合规。",
     "rules": "逐段对照给「英 → 中」两栏，术语全篇统一（先列术语表再用）；不用 fancy 词，"
              "主动被动按期刊习惯选；数值、单位、图表编号原样保留。",
     "prompts": ["把摘要译成英文", "这段英文太中文化了，改地道", "先给我一份术语对照表"]},
    {"id": "builtin-figure", "name": "图表设计", "avatar": "🎨", "sort_order": 12,
     "description": "定图的内容规格、轴/图例/配色与图注写法，达到可投稿标准。",
     "rules": "先问清这张图要证明什么，再定坐标轴、单位、误差棒、显著性标记；配色用色盲安全方案（Okabe-Ito 一类），"
              "不放与文案重复的装饰；图注写清「图几 + 图内容」，说明文字放图题上方居中。文字与图形元素不得重叠。",
     "prompts": ["这张图怎么改才能投稿", "帮我定三个视觉方案", "图注该怎么写"]},
    {"id": "builtin-stats", "name": "统计把关", "avatar": "📈", "sort_order": 13,
     "description": "检查统计口径与证据强度：样本、误差、显著性、别用均值糊弄。",
     "rules": "先问清每组的 n、误差是标准差还是标准误、有没有重复测量；给结论必须带置信分级而不是简单均值比较。"
              "别硬切阈值当判据（阈值设在胜者证据上限之上就是 selection artifact），优先连续权重/适用域判据。",
     "prompts": ["我这样比均值有问题吗", "这组数据该报什么误差", "怎么给结论定置信分级"]},
    {"id": "builtin-ml", "name": "机器学习建模", "avatar": "🤖", "sort_order": 14,
     "description": "材料/数据建模：特征、切分、验证、防数据泄露。",
     "rules": "先定预测目标与适用域，再说特征与切分（同源样本不能跨训练/测试集）；给指标必须带基线对照，"
              "别拿 R² 好看当结论；小样本别上复杂模型，先能解释再谈精度。",
     "prompts": ["这套建模流程有没有数据泄露", "小样本该怎么验证", "该用什么基线对比"]},
    {"id": "builtin-code", "name": "代码管家", "avatar": "💻", "sort_order": 15,
     "description": "写/修复现脚本：可重复、有日志、报错定位到行。",
     "rules": "代码要能直接跑：显式路径与依赖、固定随机种子、中间结果落盘；改 bug 先复现再定位，"
              "给最小修复而不是重写；每次交付附「怎么跑 + 预期输出」。",
     "prompts": ["这个脚本报错，定位一下", "帮我把流程写成可复现脚本", "结果对不上，怎么查"]},
    {"id": "builtin-experiment", "name": "实验记录", "avatar": "🧪", "sort_order": 16,
     "description": "把实验过程整理成标准化日志：条件、参数、现象、原始数据位置。",
     "rules": "按固定模板记录：日期 / 目的 / 条件与参数（含批次、设备、环境）/ 现象与异常 / 原始数据路径 / "
              "结论与下一步。缺失项写「未记录」，不许凭印象补；异常必须单独列出。",
     "prompts": ["把今天的实验整理成日志", "这次失败的可能原因列一下", "我漏记了哪些关键参数"]},
    {"id": "builtin-reviewer", "name": "审稿人", "avatar": "🧐", "sort_order": 17,
     "description": "站在审稿人角度挑最致命的问题，按严重程度排序。",
     "rules": "先说最可能被拒的三个问题（附证据/位置），再说次要问题；不谈文风喜好，只谈可验证的问题。",
     "prompts": ["挑这篇稿子最可能被拒的三个问题", "检查数据与结论是否一致", "列出还需要补的实验"]},
    {"id": "builtin-paperreview", "name": "论文审查", "avatar": "🔍", "sort_order": 18,
     "description": "投稿前系统审查：逻辑链、证据-结论一致性、图表与正文对齐、查重风险。",
     "rules": "逐节核查并出表：位置 / 问题 / 严重度 / 建议改法。重点查四样：①结论有没有超出数据 ②正文与图表数字是否一致 "
              "③方法与结果是否对得上 ④是否存在过度宣称（「显著优于」这类无统计支撑的话）。",
     "prompts": ["按投稿标准审一遍全文", "结论有没有超出数据", "图里的数字和正文对得上吗"]},
    {"id": "builtin-format", "name": "格式审查", "avatar": "📐", "sort_order": 19,
     "description": "按目标期刊/学校规范逐条核对：章节、字号、行距、图表编号、参考文献体例。",
     "rules": "先问清目标期刊/学位论文模板，再逐条对表（项目 / 规范要求 / 现状 / 是否合规 / 怎么改）。"
              "不确定规范时宁可写「需确认」也不要猜；引用体例（GB/T 7714 或期刊体例）逐条核到标点。",
     "prompts": ["按这个期刊格式审一遍", "图表编号和交叉引用有没有错", "参考文献体例哪里不合规"]},
    {"id": "builtin-refcheck", "name": "参考文献核对", "avatar": "🧾", "sort_order": 20,
     "description": "逐条核验引文真实性：作者、题名、年份、卷期页、DOI 对不对得上。",
     "rules": "一条一条核：把引用条目与数据库/原文比对，逐字段判「一致 / 冲突 / 查不到」，"
              "卷年与 DOI 年冲突要单列；查不到的明确写查不到，绝不替它编页码。",
     "prompts": ["核对这份参考文献列表", "这条引文是真的吗", "哪些条目缺卷期页"]},
    {"id": "builtin-response", "name": "审稿回复", "avatar": "💬", "sort_order": 21,
     "description": "写 point-by-point 回复：逐条回应、说清改在哪、不改也给理由。",
     "rules": "评审意见逐条抄下再回应，格式固定：意见 → 我们的答复 → 稿件改了什么（位置）。"
              "能改就改并指出改动处；不同意要礼貌但明确地说理由与依据，别含糊过去。",
     "prompts": ["把这些审稿意见写成逐条回复", "这条我不认同，怎么说得体", "回复信的开头怎么写"]},
    {"id": "builtin-submit", "name": "投稿准备", "avatar": "🚀", "sort_order": 22,
     "description": "选刊与投稿清单：范围匹配、体例、材料齐不齐、cover letter。",
     "rules": "先按「范围匹配 / 周期 / 门槛」给 3 个候选期刊并说依据，再出投稿清单（正文、图表源文件、补充材料、"
              "声明、作者信息、推荐审稿人）；cover letter 只写事实与卖点，不夸大。",
     "prompts": ["这篇稿子投哪个刊合适", "投稿前还缺什么材料", "帮我写 cover letter"]},
    {"id": "builtin-slides", "name": "演示稿", "avatar": "📽", "sort_order": 23,
     "description": "答辩/汇报 PPT：一页一个结论、图表能自证、配讲稿。",
     "rules": "先给大纲（每页一句话结论），再逐页给标题 + 图上放什么 + 3 条以内要点；"
              "数据页必须有图或表支撑，别用大段文字；每页附 30 秒讲稿，先讲结论再讲怎么得到的。",
     "prompts": ["帮我把这篇论文做成答辩 PPT 大纲", "这页信息太多，怎么精简", "配一版讲稿"]},
    {"id": "builtin-grant", "name": "项目申报", "avatar": "📑", "sort_order": 24,
     "description": "申报书按评分点写：讲清做什么、为什么是我、怎么保证做成。",
     "rules": "先对齐评审指标（逐项列出评分点与对应材料），再写内容：问题与意义 → 目标 → 技术路线 → "
              "基础与条件 → 预期成果。每一段都要能被评分表打到分，空话删掉；时间节点给到月。",
     "prompts": ["按这个申报模板列提纲", "评审会盯哪些点", "研究基础这节怎么写"]},
    {"id": "builtin-minutes", "name": "会议纪要", "avatar": "🗓", "sort_order": 25,
     "description": "从聊天/录音记录里抽出决策、待办、负责人与时间点。",
     "rules": "只抽记录里说过的：决策（谁定的） / 待办（做什么 + 谁 + 何时）/ 待澄清问题。"
              "每条后括注来源句子，别替人补结论；没提时间就写「未定」。",
     "prompts": ["把这段记录整理成纪要", "抽出所有待办和负责人", "这次会上定了什么"]},
    {"id": "builtin-tutor", "name": "概念讲解", "avatar": "🧑🏫", "sort_order": 26,
     "description": "把方法/原理讲到能懂：先类比再严格，最后给可验证的小例子。",
     "rules": "先用一句大白话类比说清它是什么、解决什么问题，再补严格定义与前提；"
              "给了公式要配一个能手算的小例子，最后列 2 个「怎么自己验证」的办法。术语第一次出现就用中文解释。",
     "prompts": ["用通俗的话讲清这个方法", "这个概念的前提是什么", "给我一个能手算的例子"]},

    {"id": "builtin-chunker", "name": "分块员", "avatar": "🧩", "sort_order": 27,
     "description": "把一篇论文切成可分工的块：每块给页码范围、一句话内容、该交给谁读。",
     "rules": "只切分不解读：按结构切（摘要 / 引言 / 方法 / 结果 / 讨论 / 结论，图与表各自单独成块），"
              "每块给「页码范围 + 一句话内容 + 交给谁（图表块→图表解读员，正文块→论文精读）」。"
              "扫描件没文本层、或结构读不出来时直说，别猜内容。",
     "prompts": ["把这篇切成块，标出每块谁读", "图和表单独成块", "这篇正文块怎么分才不重复"]},
    {"id": "builtin-chartread", "name": "图表解读员", "avatar": "🖼", "sort_order": 28,
     "description": "只读图与表：编号、轴与单位、关键数值、能不能支撑正文那句话。",
     "rules": "只读图表不读正文：逐个给「图/表编号 + 它想说明什么 + 横纵轴与单位 + 图例编码 + 关键数值（照抄，带误差棒/显著性标记）"
              "+ 能支撑哪句结论」。图里看不出或没标数值就写「图里看不出」，绝不估算；数值与正文对不上时两处都列出来。",
     "prompts": ["把这篇的图表逐个解读", "这张图能支撑正文哪句话", "图里的数值和正文对得上吗"]},
    {"id": "builtin-outline", "name": "结构规划员", "avatar": "🧱", "sort_order": 29,
     "description": "按项目框架定大纲：每章要证明什么、要哪些证据、还缺什么。",
     "rules": "只出结构不写正文：按「大标题 → 小标题 → 这一节要证明的一件事 → 需要哪些证据/图/数据」给纲领，"
              "与项目现有框架对齐、不擅自加章节；没有的证据标「待补：要什么数据」，最后单列缺口清单。",
     "prompts": ["按框架定这章的大纲", "每节分别要什么证据", "还缺哪些数据才能写"]},]

def _global_brief(db: "WorkflowDB") -> str:
    """全局 Leader 的简报：有哪些项目、各自走到哪、库里有多少东西。
    首页 Agent 以前完全不知道项目存在（ctx 只说「没有绑定任何项目」）—— 这就是 Leader 缺的视野。"""
    lines: list[str] = []
    for t in db.tasks():
        tid = t["id"]
        try:
            papers = db.db.execute("SELECT COUNT(*) AS c FROM papers WHERE task_id=?", (tid,)).fetchone()["c"]
            notes = db.db.execute("SELECT COUNT(*) AS c FROM notes WHERE task_id=?", (tid,)).fetchone()["c"]
        except Exception:
            papers = notes = 0
        lines.append(f"  · {t['title']}｜阶段 {db.stage_now(tid, t['stage'])}｜文献 {papers}｜笔记 {notes}｜更新 {(t['updated_at'] or '')[:16]}")
    out = ("\n【全局简报】共 %d 个项目：%s" % (len(lines), ("\n" + "\n".join(lines)) if lines else "（还没有项目，可以先用 create 项目的能力建一个）"))
    try:
        out += "\n【大笔记】%d 篇（笔记页那批）" % len(db.md_notes())
    except Exception:
        pass
    return out


def agent_profile(db: "WorkflowDB", task_id: str) -> dict[str, Any] | None:
    """这个对话该用哪个模型：**绑了助手就用助手接的那个模型**（deepseek 助手跑 deepseek、gpt 助手跑 gpt），
    没绑（或助手没指定）就退回当前激活模型。项目工作流仍用激活模型。"""
    try:
        row = db.db.execute("SELECT assistant_id FROM chats WHERE id=?", (task_id,)).fetchone()
    except Exception:
        return db.active_model()
    aid = (row["assistant_id"] if row else "") or ""
    if aid:
        a = db.assistant(aid)
        if a and a.get("model_id"):
            m = db.model(a["model_id"])
            if m and m.get("base_url") and m.get("model"):
                return m
    return db.active_model()


def run_agent(db: "WorkflowDB", task_id: str, text: str, emit: Any = None, max_steps: int = 6,
              system: str | None = None, tools: list[dict[str, Any]] | None = None,
              extra_context: str = "", scope: str = "", publish: bool = True,
              profile: dict[str, Any] | None = None) -> dict[str, Any]:
    """工具调用循环。emit(event) 每产生一条事件调用一次（SSE 用）。
    system/tools 不传就是通用 Agent（AGENT_SYSTEM + 全量工具）；创新点审查/确认大纲那两步会传受限工具 + 记忆块。
    scope 决定这轮对话和哪一步共用历史（'' = 创新点审查/通用，'outline' = 确认大纲）。
    publish=False = 后台子 agent（文章撰写流水线内部用）：不写对话历史、不落 assistant 回复、不发 done，
    工具调用与文本照旧流给前台看进度 —— 由调用方统一收尾。"""
    say = emit or (lambda _e: None)
    profile = profile or agent_profile(db, task_id)
    if publish:
        db.add_message(task_id, "user", text, scope=scope)
        say({"type": "user", "content": text})
    task = db.summary(task_id)["task"]
    chat_row = db.db.execute("SELECT * FROM chats WHERE id=?", (task_id,)).fetchone()
    bound = ""                                     # 这个对话绑的项目（'' = 随意对话）
    if chat_row:
        try:
            bound = (chat_row["task_id"] or "").strip()
        except Exception:
            bound = ""
        if bound and not db.db.execute("SELECT 1 FROM research_tasks WHERE id=?", (bound,)).fetchone():
            bound = ""                             # 项目被删了 → 退回随意对话
    ctx_id = bound or task_id                       # 工具按这个 id 干活：绑了项目就落在项目里
    if chat_row and bound:                        # 绑了项目 → Partner Agent（对话历史独立，视野与产出跟项目走）
        pt = db.summary(bound)["task"]
        ctx = (f"你是《{pt['title']}》项目的 **Partner Agent**：这个对话绑在该项目上 —— 对话历史自己一份，"
               f"但文献/笔记/记忆/产出都按项目来。\n"
               f"当前项目：{pt['title']}\n研究问题：{pt['question']}\n关键词 / 材料体系：{pt['material_system']}\n"
               f"项目 ID：{bound}\n产出目录：{db.pdir(bound, '其余')}")
        try:
            ctx += "\n\n" + db.memory_block(bound)     # 项目的长期/短期记忆
        except Exception:
            pass
    elif chat_row:  # 首页 Agent = 全局 Leader：不绑项目，但有全局视野
        ctx = ("你是这个软件的 **全局 Leader**（首页 Agent，不属于任何单个项目）：可以跨项目工作 —— 查任意项目、"
               "任意文献/笔记/日程，也能新建项目、加日程、检索下载精读文献、写笔记。\n"
               "项目工作流里跑的是 **绑定单个项目的 Partner Agent**；要在某个项目内部推进，就按「哪个项目、要什么产出」把话说清，"
               "或建议用户进那个项目的「项目空间 / 工作流」。\n"
               "你也可以用 `team_board` 看某项目团队的成员与执行状态、用 `team_assign` 直接把活派给某个项目的 Partner Agent"
               "（它们排队执行，产出落在该项目目录的「团队/」里）。\n"
               f"这是通用对话「{task['title']}」，产出目录：{db.out_dir(task_id)}" + _global_brief(db))
    else:
        ctx = (f"你是《{task['title']}》项目的 **Partner Agent**：绑定单个项目，只在这个项目范围内工作；"
               "跨项目的事让用户回首页 Agent（全局 Leader）做。\n"
               f"当前项目：{task['title']}\n研究问题：{task['question']}\n"
               f"关键词 / 材料体系：{task['material_system']}\n项目 ID：{task_id}\n产出目录：{db.out_dir(task_id)}")
    if chat_row:                      # 这个对话绑的助手（我的/公开）→ 它的规则进 system
        try:
            asst = db.assistant(chat_row["assistant_id"] or "")
        except Exception:
            asst = None
        if asst:
            ctx += "\n\n【当前助手】%s（%s）\n规则：%s" % (
                asst["name"], "公开内置" if asst["source"] == "builtin" else "我的助手", asst["rules"] or "（没写规则）")
    if extra_context:
        ctx += "\n\n" + extra_context
    history = [{"role": m["role"], "content": m["content"]} for m in db.messages(task_id, scope or "idea")[:-1]][-12:]
    tool_specs = TOOL_SPECS if tools is None else tools
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": system or AGENT_SYSTEM},
        {"role": "system", "content": ctx},
        *history, {"role": "user", "content": text},
    ]
    events: list[dict[str, Any]] = []
    final = ""
    tokens = {"prompt": 0, "completion": 0, "total": 0, "exact": True}
    for step in range(max_steps):
        msg = chat_raw(profile, messages, tools=tool_specs)
        use = msg.get("usage") or {}
        if use:
            # 每次回包发「这一次」的用量（可累加），不发累计值——否则存进事件流后回放会重复计数
            delta = {"prompt": use["prompt"], "completion": use["completion"],
                     "total": use["total"] or (use["prompt"] + use["completion"]), "exact": bool(use["exact"])}
            tokens["prompt"] += delta["prompt"]; tokens["completion"] += delta["completion"]
            tokens["total"] += delta["total"]; tokens["exact"] = tokens["exact"] and delta["exact"]
            ev = {"type": "usage", **delta}
            say(ev); events.append(ev)
        calls = msg.get("tool_calls") or []
        if msg.get("content"):
            say({"type": "assistant", "content": msg["content"], "step": step})
            events.append({"type": "assistant", "content": msg["content"]})
        if not calls:
            final = msg.get("content") or "（模型没有返回内容）"
            messages.append({"role": "assistant", "content": final})
            break
        messages.append({"role": "assistant", "content": msg.get("content") or "", "tool_calls": calls})
        for call in calls:
            fn = (call.get("function") or {})
            name = fn.get("name") or "?"
            try:
                args = json.loads(fn.get("arguments") or "{}")
            except ValueError:
                args = {}
            ev = {"type": "tool_call", "name": name, "args": args, "id": call.get("id")}
            say(ev); events.append(ev)
            try:
                result = _tool_impl(name, db, ctx_id, args, scope)
                ok, brief = True, _brief(name, result)
            except Exception as exc:
                result, ok, brief = {"error": f"{type(exc).__name__}: {exc}"}, False, f"失败：{exc}"
            path = result.get("path") if isinstance(result, dict) else None
            ev2 = {"type": "tool_result", "name": name, "ok": ok, "summary": brief,
                   "path": path or "", "id": call.get("id")}
            say(ev2); events.append(ev2)
            messages.append({"role": "tool", "tool_call_id": call.get("id") or name, "name": name,
                             "content": json.dumps(result, ensure_ascii=False, default=str)[:4000]})
    else:
        final = "达到单轮工具调用上限，先停在这里。可以再说一句让我继续。"
        say({"type": "assistant", "content": final})
    if publish:
        db.add_message(task_id, "assistant", final, events, scope=scope)
        db.log_step(task_id, "agent", "done", text[:60])
        if chat_row:  # 对话置顶 + 首次提问当标题（默认名用久了列表没法认）
            db.db.execute("UPDATE chats SET updated_at=? WHERE id=?",
                          (datetime.now(timezone.utc).isoformat(), task_id))
            if chat_row["title"] in ("", "新对话"):
                db.db.execute("UPDATE chats SET title=? WHERE id=?", (text.strip().replace("\n", " ")[:24], task_id))
            db.db.commit()
        say({"type": "done", "content": final})
    return {"reply": final, "events": events}


def _brief(name: str, result: Any) -> str:
    if not isinstance(result, dict):
        return str(result)[:120]
    if name == "team_board":
        c = result.get("counts") or {}
        return "团队 %d 人 · 排队 %d · 运行 %d · 完成 %d · 失败 %d" % (
            len(result.get("members") or []), c.get("queued", 0), c.get("running", 0),
            c.get("done", 0), c.get("failed", 0))
    if name == "team_assign":
        return "已派给「%s」，排队等待执行" % result.get("member_name", "")
    if name == "paper_search":
        return f"检索到 {result.get('found')} 条，新增入库 {len(result.get('saved') or [])} 条"
    if name == "paper_download":
        p = result.get("paper") or {}
        return f"已入库 {p.get('filename')}（{len(p.get('pages') or [])} 页）"
    if name in ("paper_read", "read"):
        return f"精读完成，笔记 {result.get('note_id', '')[:8]}，{result.get('chunks', 1)} 段"
    if name in ("notes_compose", "notes"):
        return f"知识库笔记已生成，证据 {result.get('evidence', 0)} 条"
    if name == "idea_review":
        return f"审查判定：{(result.get('verdict') or {}).get('verdict', '')}"
    if name == "draft_write":
        return f"草稿已写入 {result.get('path', '')}"
    if name == "draft_review":
        return f"审查结论：{(result.get('review') or {}).get('verdict', '')}"
    if name == "format_convert":
        return f"已导出 {result.get('path', '')}"
    if name == "calendar_add":
        return f"已加日程 {result.get('title')} @ {result.get('date')}"
    if name == "knowledge_query":
        return f"命中 {result.get('total', 0)} 条"
    if name == "library_overview":
        return f"文献 {result.get('文献')} 篇 / 检索结果 {len(result.get('检索结果') or [])} 条 / 笔记 {len(result.get('笔记') or [])} 篇"
    if name == "memory_save":
        return f"已记入长期记忆：{result.get('text','')[:60]}"
    return "完成"


guards.LOG_PATH = OUT / "隐私命中.log"
