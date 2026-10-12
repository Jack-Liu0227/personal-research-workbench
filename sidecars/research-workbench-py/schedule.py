# -*- coding: utf-8 -*-
"""定时任务 —— 抄原版「科研工作台」的自动化（`features/automation.tsx` + `ScheduleCoordinator`），
按本应用的实际能力落地。

保留的语义（与原版一致）：
  · **只在应用进程活着时调度**：关掉科研工作 1.0 就不会后台执行（界面里原话照抄这句）；
  · 启动时对「错过的时间点」**最多补跑一次**，之后等下一个时间点；
  · 每次触发都落一条运行记录（状态/开始结束/输出路径/摘要/失败或阻断原因）；
  · **预检不过直接标 blocked，不生成产物**（原版：预检不通过不会生成成功产物）；
  · 输出目录 = **项目目录内的相对路径**；绝对路径、盘符、`..`、隐藏目录（如 .obsidian）一律拒绝
    （对应原版 `inspectAgentOutputFolder` 的安全谓词，越界不许静默改写）；
  · 归档后的任务不再自动运行（`enabled` 置 0 + 软删）。

与原版的差别（如实说明）：原版跑内嵌 Pi Agent + skill 目录 + Obsidian 直投 + 审批策略/CAS 修订；
这里跑本应用自己的 Agent（`workflow.run_agent`），产物写成 markdown 落到项目目录。
未做：时区字段（用本机时区）、skill 目录探测、运行中实时推送到前台。
"""
from __future__ import annotations

import threading
import time
import traceback
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import integrations
import workflow

DB_PATH: "Path | None" = None     # 由 server.py 运行时注入（schedule 不能反向 import server）


def _db_path() -> Path:
    """定时任务用哪个库：优先注入值，其次延迟 import server 拿它的 DB_PATH。"""
    if DB_PATH:
        return Path(DB_PATH)
    import server                 # 延迟导入：server 导入本模块，调用时它已经加载完
    return Path(server.DB_PATH)


TICK = 30                     # 秒：每 30 秒看一遍到点的任务（原版也是进程内轮询）
CATCHUP_GRACE = 6 * 3600      # 启动补跑：错过超过 6 小时的点只重排、不补跑
FREQ_LABELS = {"manual": "手动", "hourly": "每小时", "daily": "每天",
               "weekdays": "工作日", "weekly": "每周", "custom": "自定义 Cron"}
RETRYABLE = {"failed", "blocked", "canceled", "partial"}
RUN_STATUS = {"running": "运行中", "completed": "完成", "partial": "部分完成",
              "failed": "失败", "blocked": "已阻断", "canceled": "已取消"}

# ------------------------------------------------------------------ cron ----


def _parse_field(text: str, lo: int, hi: int) -> set[int]:
    """一段 cron 字段 → 取值集合。支持 `*` `?` `5` `1-5` `*/2` `1-5/2` 与逗号列表。"""
    out: set[int] = set()
    for part in str(text).split(","):
        part = part.strip()
        if not part:
            continue
        step = 1
        if "/" in part:
            part, _, raw_step = part.partition("/")
            raw_step = raw_step.strip()
            if not raw_step.isdigit() or int(raw_step) <= 0:
                raise ValueError(f"步长无效：{raw_step or '(空)'}")
            step = int(raw_step)
            part = part.strip()
        if part in ("*", "?"):
            a, b = lo, hi
        elif "-" in part:
            a_s, _, b_s = part.partition("-")
            if not (a_s.strip().isdigit() and b_s.strip().isdigit()):
                raise ValueError(f"区间无效：{part}")
            a, b = int(a_s), int(b_s)
        else:
            if not part.isdigit():
                raise ValueError(f"取值无效：{part}")
            a = b = int(part)
        if a > b or a < lo or b > hi:
            raise ValueError(f"取值越界：{part}（允许 {lo}-{hi}）")
        out.update(range(a, b + 1, step))
    if not out:
        raise ValueError("字段为空")
    return out


def parse_cron(expr: str) -> tuple[list[bool], list[bool], list[bool], list[bool], list[bool], bool, bool]:
    """5 段（分 时 日 月 周）→ 五个布尔表 + 「日/周是否通配」。周：0=周日…6=周六（7 也当周日）。"""
    parts = str(expr or "").split()
    if len(parts) != 5:
        raise ValueError("Cron 需要 5 段（分 时 日 月 周），例如 0 9 * * *")
    mins = _parse_field(parts[0], 0, 59)
    hours = _parse_field(parts[1], 0, 23)
    dom = _parse_field(parts[2], 1, 31)
    mon = _parse_field(parts[3], 1, 12)
    dow = _parse_field(parts[4], 0, 7)
    if 7 in dow:                       # 7 = 周日
        dow.discard(7)
        dow.add(0)
    return ([i in mins for i in range(60)], [i in hours for i in range(24)],
            [i in dom for i in range(32)], [i in mon for i in range(13)],
            [i in dow for i in range(7)],
            parts[2].strip() in ("*", "?"), parts[4].strip() in ("*", "?"))


def valid(expr: str) -> tuple[bool, str]:
    try:
        parse_cron(expr)
        return True, ""
    except ValueError as exc:
        return False, str(exc)


def _day_ok(dt: datetime, dom: list[bool], dow: list[bool], dom_star: bool, dow_star: bool) -> bool:
    """POSIX：日与周都受限时取「或」；只有一个受限就按那个。"""
    cron_dow = (dt.weekday() + 1) % 7          # Sun=0 … Sat=6
    if dom_star and dow_star:
        return True
    if dom_star:
        return dow[cron_dow]
    if dow_star:
        return dt.day < len(dom) and dom[dt.day]
    return (dt.day < len(dom) and dom[dt.day]) or dow[cron_dow]


def matches(expr: str, dt: datetime) -> bool:
    mins, hours, dom, mon, dow, dom_star, dow_star = parse_cron(expr)
    if not (mins[dt.minute] and hours[dt.hour] and mon[dt.month]):
        return False
    return _day_ok(dt, dom, dom_star=dom_star, dow=dow, dow_star=dow_star)


def next_after(expr: str, dt: datetime) -> datetime | None:
    """下一次触发时刻（本机时区）。找不到（≤2 年内没有）返回 None。"""
    mins, hours, dom, mon, dow, dom_star, dow_star = parse_cron(expr)
    cur = dt.replace(second=0, microsecond=0) + timedelta(minutes=1)
    horizon = cur + timedelta(days=732)
    while cur < horizon:
        if not mon[cur.month]:
            cur = (cur.replace(day=1) + timedelta(days=32)).replace(day=1, hour=0, minute=0)
            continue
        if not _day_ok(cur, dom, dow, dom_star, dow_star):
            cur = (cur + timedelta(days=1)).replace(hour=0, minute=0)
            continue
        if not hours[cur.hour]:
            cur = (cur + timedelta(hours=1)).replace(minute=0)
            continue
        if not mins[cur.minute]:
            cur = cur + timedelta(minutes=1)
            continue
        return cur
    return None


def describe(expr: str) -> str:
    ok, why = valid(expr)
    if not ok:
        return f"不可用：{why}"
    nxt = next_after(expr, datetime.now())
    return nxt.strftime("%m-%d %H:%M") if nxt else "未排期"


# ---------------------------------------------------------- 输出目录安全 ----


def inspect_output_dir(raw: str) -> tuple[bool, str]:
    """项目目录内的相对路径才放行（对应原版的 inspectAgentOutputFolder）。"""
    v = str(raw or "").strip().replace("\\", "/")
    if not v:
        return False, "输出目录不能为空"
    if v.startswith("/") or ":" in v:
        return False, "输出目录必须是相对路径（不能是绝对路径或盘符）"
    parts = [p for p in v.split("/") if p not in ("", ".")]
    if any(p == ".." for p in parts):
        return False, "输出目录不能包含 .."
    if any(p.startswith(".") for p in parts):
        return False, "输出目录不能指向隐藏目录（如 .obsidian）"
    return True, "/".join(parts)


def output_dir_for(db: Any, sched: dict[str, Any]) -> Path:
    ok, folder = inspect_output_dir(sched.get("output_dir") or "定时任务")
    if not ok:
        raise ValueError(folder)
    base = None
    try:
        base = db.base_dir(sched["project_id"])
    except Exception:
        base = None
    root = base if base else (workflow.OUT / str(sched["project_id"] or "未绑定"))
    path = root / folder
    path.mkdir(parents=True, exist_ok=True)
    if base:                        # 越界再验一次（base 是我们拼出来的，防符号链接绕出去）
        try:
            path.resolve().relative_to(base.resolve())
        except ValueError:
            raise ValueError("输出目录越出了项目目录") from None
    return path


# ------------------------------------------------------------- 触发运行 ----


def next_run_at(expr: str, now: datetime | None = None) -> str:
    """下个触发时刻（ISO 字符串）。表达式不可用就返回空串 —— 排期/记运行路径不该因坏 cron 抛异常
    （要错误原因用 valid()）。"""
    try:
        nxt = next_after(expr, now or datetime.now())
    except ValueError:
        return ""
    return nxt.isoformat(timespec="seconds") if nxt else ""


def run_once(sched: dict[str, Any], trigger: str = "scheduler", emit: Any = None) -> dict[str, Any]:
    """跑一次并落运行记录。返回运行记录 dict。"""
    started = datetime.now()
    run = {"id": uuid.uuid4().hex, "schedule_id": sched["id"], "name": sched["name"],
           "trigger": trigger, "status": "running", "started_at": started.isoformat(timespec="seconds"),
           "ended_at": "", "output_path": "", "summary": "", "reason": ""}
    with workflow.WorkflowDB(_db_path()) as db:
        db.schedule_run_add(run)

    def finish(status: str, *, path: str = "", summary: str = "", reason: str = "") -> dict[str, Any]:
        run.update({"status": status, "output_path": path, "summary": summary, "reason": reason,
                    "ended_at": datetime.now().isoformat(timespec="seconds")})
        with workflow.WorkflowDB(_db_path()) as db:
            db.schedule_run_add(run)
            db.schedule_mark_run(sched["id"], run["ended_at"], next_run_at(sched["cron"]))
        return run

    if not sched.get("enabled"):
        return finish("canceled", reason="任务已暂停")
    if not str(sched.get("project_id") or "").strip():
        return finish("blocked", reason="未绑定项目：Agent 需要项目上下文（原版允许「全部项目」，本应用的 Agent 按项目组织）")
    ok, why = valid(sched.get("cron") or "")
    if not ok:
        return finish("blocked", reason=f"Cron 不可用：{why}")
    folder_ok, folder_why = inspect_output_dir(sched.get("output_dir") or "")
    if not folder_ok:
        return finish("blocked", reason=f"输出目录不可用：{folder_why}")

    try:
        with workflow.WorkflowDB(_db_path()) as db:
            folder = output_dir_for(db, sched)
            prompt = sched["prompt"]
            out = workflow.run_agent(db, sched["project_id"], prompt, emit=emit, publish=False)
            text = str(out.get("reply") or "").strip() or "（模型没有返回内容）"
            stamp = datetime.now().strftime("%Y-%m-%d_%H%M")
            path = folder / f"{integrations._safe_name(sched['name'])[:60]}-{stamp}.md"
            header = (f"# {sched['name']}\n\n"
                      f"> 由「定时任务」生成 · {datetime.now().strftime('%Y-%m-%d %H:%M')} · "
                      f"触发：{'手动' if trigger == 'manual' else ('启动补跑' if trigger == 'catchup' else '定时')} · "
                      f"Cron `{sched['cron']}`\n\n")
            path.write_text(header + text + "\n", encoding="utf-8")
        return finish("completed", path=str(path), summary=text[:160].replace("\n", " "))
    except Exception as exc:                       # 任何失败都记下来，不能让调度线程死掉
        return finish("failed", reason=f"{type(exc).__name__}: {exc}")


# ------------------------------------------------------------------ 循环 ----

_lock = threading.Lock()
_running: set[str] = set()
_started = False


def due_list(now: datetime | None = None) -> list[dict[str, Any]]:
    now = now or datetime.now()
    stamp = now.isoformat(timespec="seconds")
    with workflow.WorkflowDB(_db_path()) as db:
        return [s for s in db.schedules()
                if s["enabled"] and s.get("frequency") != "manual"
                and s["next_run_at"] and s["next_run_at"] <= stamp]


def catch_up() -> int:
    """启动补跑：错过 ≤6 小时的点补跑一次（原版：每日任务最多补跑一次），更久远的只重排。"""
    now = datetime.now()
    done = 0
    with workflow.WorkflowDB(_db_path()) as db:
        rows = [s for s in db.schedules()
                if s["enabled"] and s.get("frequency") != "manual" and s["next_run_at"]]
    for s in rows:
        try:
            missed = datetime.fromisoformat(s["next_run_at"])
        except ValueError:
            continue
        if missed >= now:
            continue
        if (now - missed).total_seconds() <= CATCHUP_GRACE:
            run_once(s, trigger="catchup")
            done += 1
        else:
            with workflow.WorkflowDB(_db_path()) as db:
                db.schedule_mark_run(s["id"], s["last_run_at"], next_run_at(s["cron"], now))
    return done


def tick(now: datetime | None = None) -> int:
    """到点了就按顺序跑（同一规则不重入）。返回本次跑了几条。"""
    ran = 0
    for sched in due_list(now):
        with _lock:
            if sched["id"] in _running:
                continue
            _running.add(sched["id"])
        try:
            run_once(sched, trigger="scheduler")
            ran += 1
        finally:
            with _lock:
                _running.discard(sched["id"])
    return ran


def start() -> None:
    global _started
    if _started:
        return
    _started = True
    threading.Thread(target=_loop, daemon=True, name="schedule-loop").start()


def _loop() -> None:
    try:
        catch_up()
    except Exception:
        traceback.print_exc()
    while True:
        try:
            tick()
        except Exception:
            traceback.print_exc()
        time.sleep(TICK)


if __name__ == "__main__":      # 手跑自检：py -3.10 schedule.py
    samples = ["0 9 * * *", "30 8 * * 1-5", "*/15 * * * *", "0 9 1 * *", "0 0 * * 0"]
    for e in samples:
        assert valid(e)[0], e
        print(f"{e:16s} 下次 {describe(e)}  匹配示例 {matches(e, next_after(e, datetime.now()))}")
    bad = ["0 9 * *", "60 9 * * *", "0 9 * * 9", "*/0 * * * *"]
    for e in bad:
        ok, why = valid(e)
        assert not ok, e
        print(f"{e:16s} 拒绝：{why}")
    for raw, expect in [("定时任务", True), ("a/b", True), ("../x", False), ("/abs", False),
                        ("C:/x", False), (".obsidian", False), ("", False)]:
        print(f"输出目录 {raw!r:12s} -> {inspect_output_dir(raw)}")
    print("schedule.py 自检通过")
