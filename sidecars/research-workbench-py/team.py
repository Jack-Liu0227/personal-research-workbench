# -*- coding: utf-8 -*-
"""团队（A 档）：Leader + Partner 成员 + 派活队列 + 运行事件。

抄 AionUi 的 Teams 模型（`packages/desktop/src/common/types/team/teamTypes.ts`）：
  · 角色 `role = 'leader' | 'teammate'`；**Leader 恒为成员列表第一个、不可移除**（AionUi 原话）；
  · 成员状态 `pending | idle | active | completed | failed | dormant` → 这里落成 idle|queued|running|done|failed|blocked；
  · 任务看板（AionUi 的 Activity：TaskCard + MessageCard）→ 这里落成 team_tasks + team_events。

与原版的**硬差别（如实说明）**：AionUi 每个成员是独立 agent 进程、能真并行；本应用单进程、
模型调用阻塞 → 这里是**串行队列**（一次只跑一个成员），排队状态在界面上明确显示。
"""
from __future__ import annotations

import threading
import time
import traceback
import uuid
from datetime import datetime
from typing import Any

import workflow

DB_PATH: Any = None          # 由 server.py 运行时注入（和 schedule.py 同一套路）

TICK = 3.0                   # 队列轮询间隔（秒）
RUNNING: set[str] = set()    # 正在跑的任务行 id（防重入）
_lock = threading.Lock()

STEPS = ["idea", "search", "download", "notes", "write", "review", "convert"]   # 可绑的工作流步骤
LEADER_NAME = "全局 Leader"
LEADER_BRIEF = "你好，我是 Leader，负责理解你的目标并协调团队。描述你想做的事，我来安排。"


def _db_path():
    if DB_PATH:
        return DB_PATH
    import server
    return server.DB_PATH


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


# ---------------- 成员 ----------------
def ensure_leader(task_id: str) -> dict[str, Any]:
    """确保团队里有 leader 行（幂等）。AionUi：Leader 恒为列表第一个、不可移除。"""
    if not (task_id or "").strip():
        raise ValueError("团队要挂在一个项目或对话上（scope 不能是空）")
    with workflow.WorkflowDB(_db_path()) as db:
        rows = [m for m in db.team_members(task_id) if m["role"] == "leader"]
        if rows:
            return rows[0]
        return db.team_member_add(task_id, LEADER_NAME, "leader", "", LEADER_BRIEF)


def members(task_id: str) -> list[dict[str, Any]]:
    ensure_leader(task_id)
    with workflow.WorkflowDB(_db_path()) as db:
        return db.team_members(task_id)


def add_member(task_id: str, name: str, step: str = "", prompt: str = "") -> dict[str, Any]:
    name = (name or "").strip() or "新成员"
    step = step if step in STEPS else ""
    with workflow.WorkflowDB(_db_path()) as db:
        return db.team_member_add(task_id, name, "member", step, prompt or "")


def update_member(member_id: str, **fields: Any) -> dict[str, Any]:
    fields = {k: v for k, v in fields.items() if v is not None}   # 没传的字段别写成 NULL
    with workflow.WorkflowDB(_db_path()) as db:
        return db.team_member_update(member_id, **fields)


def remove_member(member_id: str) -> dict[str, Any]:
    with workflow.WorkflowDB(_db_path()) as db:
        row = db.team_member(member_id)
        if not row:
            raise ValueError("成员不存在")
        if row["role"] == "leader":
            raise ValueError("Leader 不能移除（AionUi 同款规则）")
        db.team_member_remove(member_id)
        return {"removed": member_id}


# ---------------- 派活 ----------------
def assign(task_id: str, member: str, prompt: str, title: str = "", trigger: str = "leader",
           origin: str = "") -> dict[str, Any]:
    """把一件事派给某个成员 → 落一条 queued 任务，等队列 worker 串行跑。"""
    prompt = (prompt or "").strip()
    if not prompt:
        raise ValueError("要派的事不能为空")
    ensure_leader(task_id)
    with workflow.WorkflowDB(_db_path()) as db:
        rows = db.team_members(task_id)
        key = (member or "").strip().lower()
        hit = next((m for m in rows if m["id"] == member or m["name"].lower() == key), None)
        if not hit:
            names = "、".join(m["name"] for m in rows)
            raise ValueError(f"团队里没有成员「{member}」（现有：{names}）")
        row = db.team_task_add(task_id, hit["id"], hit["name"], title or prompt[:40], prompt, trigger, origin)
        db.team_event_add(row["id"], task_id, "assign", f"{trigger} 派给「{hit['name']}」：{prompt[:160]}")
        db.team_member_update(hit["id"], status="queued")
        return row


def board(task_id: str, limit: int = 40) -> dict[str, Any]:
    """看板数据：成员（含状态）+ 任务列表 + 事件流（对话状态与执行情况）。"""
    ensure_leader(task_id)
    with workflow.WorkflowDB(_db_path()) as db:
        mem = db.team_members(task_id)
        tasks = db.team_tasks(task_id, limit)
        events = db.team_events(task_id, 200)
    by_task: dict[str, list] = {}
    for e in events:
        by_task.setdefault(e["team_task_id"], []).append(e)
    for t in tasks:
        t["events"] = by_task.get(t["id"], [])
    counts: dict[str, int] = {}
    for t in tasks:
        counts[t["status"]] = counts.get(t["status"], 0) + 1
    return {"members": mem, "tasks": tasks, "counts": counts,
            "leader_brief": LEADER_BRIEF, "steps": STEPS,
            "serial_note": "单进程串行队列：一次只跑一个成员（AionUi 是真并行，那是独立 agent 进程换来的）",
            "running": sorted(RUNNING)}


def cancel(task_id_row: str) -> dict[str, Any]:
    with workflow.WorkflowDB(_db_path()) as db:
        row = db.team_task(task_id_row)
        if not row:
            raise ValueError("任务不存在")
        if row["status"] == "running":
            raise ValueError("正在运行，停不下来（模型调用是阻塞的）—— 等它跑完再重试")
        db.team_task_mark(task_id_row, "canceled", ended_at=_now(), reason="手动取消")
        return {"canceled": task_id_row}


def retry(task_id_row: str) -> dict[str, Any]:
    with workflow.WorkflowDB(_db_path()) as db:
        row = db.team_task(task_id_row)
        if not row:
            raise ValueError("任务不存在")
        if row["status"] == "running":
            raise ValueError("还在跑")
        db.team_task_mark(task_id_row, "queued", started_at="", ended_at="", reason="", result="")
        db.team_event_add(task_id_row, row["task_id"], "note", "重新排队")
        return {"queued": task_id_row}


# ---------------- 队列 worker（串行） ----------------
def _run_one(row: dict[str, Any]) -> None:
    import team as _self                      # 便于测试替换 run_agent
    t_id = row["task_id"]
    with workflow.WorkflowDB(_db_path()) as db:
        db.team_task_mark(row["id"], "running", started_at=_now())
        db.team_member_update(row["member_id"], status="running")
        db.team_event_add(row["id"], t_id, "start", "开始执行")
        mem = db.team_member(row["member_id"]) or {}
        brief = (mem.get("prompt") or "").strip()
        step = mem.get("step") or ""
        role = ("你是《%s》项目的 Partner Agent「%s」" % (db.summary(t_id)["task"]["title"], row["member_name"]))
        if step:
            role += "，负责工作流里的「%s」环节" % step
        extra = role + "。只在这个项目范围内工作。\n" + (brief + "\n" if brief else "")
    outs: list[str] = []

    def emit(ev: dict[str, Any]) -> None:
        t = ev.get("type")
        if t == "tool_call":
            _ev(row, "tool", "调用 %s" % ev.get("name"))
        elif t == "tool_result":
            _ev(row, "tool", ("%s：%s" % (ev.get("name"), ev.get("summary"))) if ev.get("ok") else ("失败：" + str(ev.get("summary"))))
        elif t == "assistant" and ev.get("content"):
            outs.append(ev["content"])
            _ev(row, "assistant", str(ev["content"])[:400])
        elif t == "usage":
            _ev(row, "note", "tokens %s" % ev.get("total"))

    try:
        with workflow.WorkflowDB(_db_path()) as db:
            out = workflow.run_agent(db, t_id, row["prompt"], emit=emit, publish=False,
                                     extra_context=extra, max_steps=8)
        text = (out.get("reply") or "\n".join(outs) or "").strip()
        with workflow.WorkflowDB(_db_path()) as db:
            folder = db.pdir(t_id, "其余") / "团队"
            folder.mkdir(parents=True, exist_ok=True)
            path = folder / ("%s-%s.md" % ((row["member_name"] or "member").replace("/", "_"),
                                           datetime.now().strftime("%Y%m%d-%H%M%S")))
            path.write_text("> 团队任务「%s」· 成员 %s · %s\n\n%s\n" %
                            (row["title"], row["member_name"], _now(), text or "（没有产出内容）"), encoding="utf-8")
            db.team_task_mark(row["id"], "done", ended_at=_now(),
                              output_path=str(path), result=text[:500])
            db.team_member_update(row["member_id"], status="done", note="最近完成：" + row["title"])
            db.team_event_add(row["id"], t_id, "done", "完成 → %s" % path.name)
    except Exception as exc:
        with workflow.WorkflowDB(_db_path()) as db:
            db.team_task_mark(row["id"], "failed", ended_at=_now(),
                              reason="%s: %s" % (type(exc).__name__, exc))
            db.team_member_update(row["member_id"], status="failed")
            db.team_event_add(row["id"], t_id, "fail", "%s: %s" % (type(exc).__name__, exc))


def _ev(row: dict[str, Any], kind: str, text: str) -> None:
    try:
        with workflow.WorkflowDB(_db_path()) as db:
            db.team_event_add(row["id"], row["task_id"], kind, text)
    except Exception:
        pass


def tick() -> int:
    """跑一轮队列（串行：一次一个）。返回本轮跑了几个。"""
    done = 0
    with workflow.WorkflowDB(_db_path()) as db:
        rows = [t for t in db.team_tasks(None, 200) if t["status"] == "queued"]
    rows.sort(key=lambda r: r["created_at"])
    for row in rows:
        if row["id"] in RUNNING:
            continue
        with _lock:
            if row["id"] in RUNNING:
                continue
            RUNNING.add(row["id"])
        try:
            _run_one(row)
            done += 1
        finally:
            RUNNING.discard(row["id"])
    return done


def start_worker() -> None:
    threading.Thread(target=_loop, daemon=True).start()


def _loop() -> None:
    while True:
        try:
            tick()
        except Exception:
            traceback.print_exc()
        time.sleep(TICK)


if __name__ == "__main__":       # 手跑自检：python team.py
    import os, tempfile
    os.environ.setdefault("RESEARCH_WORKBENCH_DB", str(tempfile.gettempdir() + "/team_selfcheck.sqlite3"))
    import pathlib
    p = pathlib.Path(os.environ["RESEARCH_WORKBENCH_DB"])
    if p.exists():
        p.unlink()
    DB_PATH = p
    with workflow.WorkflowDB(p) as db:
        tid = db.create_task("自检项目", "问题", "体系", "")
    ms = members(tid)
    assert ms and ms[0]["role"] == "leader", ms
    m2 = add_member(tid, "检索员", "search", "负责检索")
    assert len(members(tid)) == 2
    row = assign(tid, "检索员", "检索 O3 钠电掺杂近三年的论文")
    assert row["status"] == "queued"
    b = board(tid)
    assert b["members"][0]["name"] == LEADER_NAME
    assert b["counts"].get("queued") == 1
    try:
        remove_member(ms[0]["id"]); raise SystemExit("Leader 不该能删")
    except ValueError:
        pass
    cancel(row["id"])
    assert board(tid)["counts"].get("canceled") == 1
    retry(row["id"])
    assert board(tid)["counts"].get("queued") == 1
    print("team.py 自检通过：", [m["name"] + "/" + m["role"] for m in members(tid)], b["counts"])


# ============================ v2：成员=助手 + 团队内 AI 聊天平台 ============================

MAX_PICKS = 5            # 一个团队最多选 5 个助手（Leader 是常驻主持，不占名额）
# 身份色：0 号固定给 Leader，其余照 AionUi TEAM_MEMBER_PALETTE 的低饱和 slate 系
MEMBER_COLORS = ["var(--brand)", "#5c9ea4", "#b58a5e", "#8f7fb5", "#7fa06a", "#b57f92"]
STOP_WORDS = ("完成", "全部完成", "已全部完成", "DONE", "收工")

TEAM_RUNS: dict[str, dict[str, Any]] = {}          # scope -> {turn,total,current,phase,stop}（在内存，重启即丢）
_LOCK = threading.Lock()
TEAM_SCOPE = "team"                              # 团队记录存在 chat 表的 scope 里


def color_of(m: dict[str, Any]) -> str:
    return MEMBER_COLORS[int(m.get("color") or 0) % len(MEMBER_COLORS)]


def picks(scope: str) -> list[dict[str, Any]]:
    """团队里被选中的助手成员（不含 Leader）。"""
    return [m for m in members(scope) if m.get("role") == "member"]


def add_assistant(scope: str, assistant_id: str) -> dict[str, Any]:
    """把一个助手拉进团队（照 AionUi：团队成员就是助手实例）。最多 MAX_PICKS 个。"""
    with workflow.WorkflowDB(_db_path()) as db:
        asst = db.assistant(assistant_id)
        if not asst:
            raise ValueError("没有这个助手 —— 先去「助手」页建一个")
        cur = [m for m in db.team_members(scope) if m["role"] == "member"]
        if any(m["assistant_id"] == assistant_id for m in cur):
            raise ValueError("「%s」已经在团队里了" % asst["name"])
        if len(cur) >= MAX_PICKS:
            raise ValueError("一个团队最多 %d 个助手（现在 %d 个），先移掉一个再加" % (MAX_PICKS, len(cur)))
        return db.team_member_add(scope, asst["name"], "member", "", asst["rules"] or "",
                                  assistant_id=assistant_id, color=1 + len(cur))


def transcript(scope: str, limit: int = 200) -> list[dict[str, Any]]:
    """团队群里的对话（谁说的都记在 sender 上）。"""
    with workflow.WorkflowDB(_db_path()) as db:
        return [{"role": m["role"], "content": m["content"],
                 "sender": m.get("sender") or ("你" if m["role"] == "user" else "成员"),
                 "at": m["created_at"]} for m in db.messages(scope, TEAM_SCOPE)][-limit:]


def say(scope: str, text: str, start: bool = True) -> dict[str, Any]:
    """用户往群里插一句话 → 团队接着往下推进。"""
    text = (text or "").strip()
    if not text:
        raise ValueError("要说点什么")
    with workflow.WorkflowDB(_db_path()) as db:
        db.add_message(scope, "user", text, scope=TEAM_SCOPE, sender="你")
    started = kick(scope) if start else False
    return {"ok": True, "started": started, "running": scope in TEAM_RUNS}


def next_speaker(text: str, names: list[str], last: str | None) -> str | None:
    """交接规则（照 AionUi 的 @ 交接）：说了收工词就散会；@ 谁就归谁；没说就按顺序轮下一个。"""
    if not names:
        return None
    blob = text or ""
    if any(w in blob for w in STOP_WORDS):
        return None
    for n in names:
        if ("@" + n) in blob or ("＠" + n) in blob:
            return n
    if last is None or last not in names:
        return names[0]
    return names[(names.index(last) + 1) % len(names)]


def _set(scope: str, **kw: Any) -> None:
    with _LOCK:
        st = TEAM_RUNS.get(scope)
        if st:
            st.update(kw)


def kick(scope: str, turns: int = 6) -> bool:
    """让这个团队跑起来（一次只跑一个团队；已经在跑就不重复起）。"""
    with _LOCK:
        if scope in TEAM_RUNS:
            return False
        TEAM_RUNS[scope] = {"turn": 0, "total": turns, "current": "", "phase": "排队中", "stop": False}
    threading.Thread(target=_round, args=(scope, turns), daemon=True).start()
    return True


def stop(scope: str) -> dict[str, Any]:
    _set(scope, stop=True, phase="停止中")
    return {"ok": True}


def _round(scope: str, turns: int) -> None:
    """一个 AI 聊天平台：成员之间互相 @ 派话，一轮接一轮把活推下去（串行，一轮一个人）。"""
    import workflow as _wf
    try:
        with workflow.WorkflowDB(_db_path()) as db:
            ms = [m for m in db.team_members(scope) if m["role"] == "member"]
            names = [m["name"] for m in ms]
            by_name = {m["name"]: m for m in ms}
            if not names:
                db.add_message(scope, "assistant", "团队里还没有人 —— 先从左边的助手里选几个。",
                               scope=TEAM_SCOPE, sender="系统")
                return
            last = None
            for t in range(1, turns + 1):
                st = TEAM_RUNS.get(scope) or {}
                if st.get("stop"):
                    db.add_message(scope, "assistant", "（已停止）", scope=TEAM_SCOPE, sender="系统")
                    return
                hist = [dict(m) for m in db.messages(scope, TEAM_SCOPE)][-12:]
                tail = "\n".join((h.get("content") or "") for h in hist[-2:])
                speaker = next_speaker(tail, names, last)
                if not speaker:
                    db.add_message(scope, "assistant", "团队：这件事告一段落（收到收工信号）。",
                                   scope=TEAM_SCOPE, sender="系统")
                    return
                m = by_name[speaker]
                _set(scope, turn=t, current=speaker, phase="%s 正在做（第 %d/%d 轮）" % (speaker, t, turns))
                prof = None                                  # 这个成员背后接的模型（= 它那个助手绑的模型）
                if m.get("assistant_id"):
                    _a = db.assistant(m["assistant_id"]) or {}
                    if _a.get("model_id"):
                        prof = db.model(_a["model_id"]) or None
                extra = (
                    "【团队协作】你现在的身份是团队成员「%s」（不是全局 Leader）：%s\n"
                    "团队名单：%s\n"
                    "干活规则：只做你这份；结论要能核查（引用来源/数字）；"
                    "要交给谁，就在回复开头写 @那个人的名字；整件事真做完了就回复「完成」并且不要再 @人。\n"
                    "最近的团队记录：\n%s" % (speaker, m["prompt"] or "（没写职责）", "、".join(names),
                                            "\n".join("%s：%s" % (h.get("sender") or h.get("role"), (h.get("content") or "")[:240])
                                                        for h in hist)))
                try:
                    out = _wf.run_agent(db, scope, "继续推进（你是 %s）" % speaker, extra_context=extra,
                                        scope=TEAM_SCOPE, publish=False, profile=prof)
                    body = (out.get("reply") or "").strip() or "（这一轮没说话）"
                except Exception as exc:                       # 一个成员失败不该掀翻整个团队，但也别空转
                    db.add_message(scope, "assistant", "（%s 这一轮失败：%s）" % (speaker, exc),
                                   scope=TEAM_SCOPE, sender=speaker)
                    db.add_message(scope, "assistant", "团队：%s 这一轮出错了，先停在这里 —— 修好再继续。"
                                   % speaker, scope=TEAM_SCOPE, sender="系统")
                    return
                db.add_message(scope, "assistant", body, scope=TEAM_SCOPE, sender=speaker)
                last = speaker
                if next_speaker(body, names, last) is None:
                    db.add_message(scope, "assistant", "团队：都齐了，收工。", scope=TEAM_SCOPE, sender="系统")
                    return
            _set(scope, phase="轮次用完（%d 轮）" % turns)
    finally:
        release(scope)                     # 机动团队：跑完就把成员释放掉、标记收工（名额还给别人）
        with _LOCK:
            TEAM_RUNS.pop(scope, None)


def chat_state(scope: str) -> dict[str, Any]:
    """团队页要的一切：这个团队 + 成员（带色 + 各自模型）+ 群记录 + 正在跑的状态 + 上限。"""
    ensure_leader(scope)
    with workflow.WorkflowDB(_db_path()) as db:
        ms = members(scope)
        for m in ms:
            m["model"] = _member_model(db, m)
        t_rec = db.team(scope)
    return {"team": t_rec, "members": ms, "max": MAX_PICKS, "palette": MEMBER_COLORS,
            "transcript": transcript(scope), "running": TEAM_RUNS.get(scope),
            "colors": {m["id"]: color_of(m) for m in ms}}


# ============================ v3：多团队（3 固定 + 2 机动）+ 成员各用自己的模型 ============================

MAX_TEAMS, MAX_FIXED, MAX_TEMP = 5, 3, 2


def ensure_defaults() -> list[dict[str, Any]]:
    """保证 3 个固定团队在（幂等）。"""
    with workflow.WorkflowDB(_db_path()) as db:
        ts = db.teams()
        fixed = [x for x in ts if x["kind"] == "fixed"]
        for i in range(len(fixed), MAX_FIXED):
            db.team_add("团队 %d" % (i + 1), "fixed")
        return db.teams()


def teams() -> dict[str, Any]:
    """团队清单（带成员数、成员各自的模型名）。"""
    with workflow.WorkflowDB(_db_path()) as db:
        ts = ensure_defaults()
        out = []
        for x in ts:
            ms = [m for m in db.team_members(x["id"]) if m["role"] == "member"]
            for m in ms:
                m["model"] = _member_model(db, m)
            out.append({**x, "members": ms, "picks": len(ms)})
        return {"teams": out, "max": MAX_TEAMS, "max_fixed": MAX_FIXED, "max_temp": MAX_TEMP,
                "fixed": len([x for x in out if x["kind"] == "fixed"]),
                "temp": len([x for x in out if x["kind"] == "temp"])}


def new_team(kind: str = "temp", name: str = "") -> dict[str, Any]:
    """建团队。固定位 3 个、机动位 2 个；机动位满了会先把「已收工」的自动收掉（用完即释放）。"""
    with workflow.WorkflowDB(_db_path()) as db:
        ensure_defaults()
        ts = db.teams()
        if kind == "fixed":
            if len([x for x in ts if x["kind"] == "fixed"]) >= MAX_FIXED:
                raise ValueError("固定团队只能有 %d 个" % MAX_FIXED)
        else:
            temps = [x for x in ts if x["kind"] == "temp"]
            if len(temps) >= MAX_TEMP:
                done = [x for x in temps if x["status"] == "done"]
                if not done:
                    raise ValueError("两个机动位都在用 —— 等它们跑完，或先解散一个")
                db.team_delete(done[0]["id"])          # 用完的机动团队自动回收，腾出名额
        if len(db.teams()) >= MAX_TEAMS:               # 兜底（正常走不到：上面两种位各卡了一道）
            raise ValueError("最多 %d 个团队（%d 固定 + %d 机动）" % (MAX_TEAMS, MAX_FIXED, MAX_TEMP))
        n = len([x for x in db.teams() if x["kind"] == kind]) + 1
        return db.team_add(name.strip() or ("%s %d" % ("团队" if kind == "fixed" else "机动", n)), kind)


def rename_team(tid: str, name: str) -> dict[str, Any]:
    name = (name or "").strip()
    if not name:
        raise ValueError("名字不能空")
    with workflow.WorkflowDB(_db_path()) as db:
        if not db.team(tid):
            raise ValueError("没有这个团队")
        return db.team_update(tid, name=name)


def dissolve(tid: str) -> dict[str, Any]:
    """解散团队。机动的可以；固定的不行（3 个固定位是常驻的）。记录留在库里不删。"""
    with workflow.WorkflowDB(_db_path()) as db:
        t = db.team(tid)
        if not t:
            raise ValueError("没有这个团队")
        if t["kind"] == "fixed":
            raise ValueError("固定团队不能解散 —— 只能改名字")
        db.team_delete(tid)
        return {"ok": True, "dissolved": t["name"]}


def release(tid: str) -> None:
    """机动团队「用完」：释放成员（把助手让出来）、标记收工；对话记录留着还能看。"""
    with workflow.WorkflowDB(_db_path()) as db:
        t = db.team(tid)
        if not t or t["kind"] != "temp":
            return
        for m in db.team_members(tid):
            if m["role"] == "member":
                db.team_member_remove(m["id"])
        db.team_update(tid, status="done")


def _member_model(db, m: dict[str, Any]) -> str:
    """这个成员背后接的是哪个模型（助手绑的那个）。"""
    aid = m.get("assistant_id") or ""
    if not aid:
        return ""
    a = db.assistant(aid) or {}
    mid = a.get("model_id") or ""
    if not mid:
        return ""
    prof = db.model(mid) or {}
    return prof.get("name") or ""
