from __future__ import annotations

import os
import sys
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
from pathlib import Path

from research_core import ResearchDB

ROOT = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent
DATA_ROOT = Path(os.environ.get("LOCALAPPDATA", ROOT)) / "ResearchWorkbench"
DB_PATH = DATA_ROOT / "data" / "research.sqlite3"


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("科研工作 1.0")
        self.geometry("1100x700")
        self.db = ResearchDB(DB_PATH)
        self.task_id: str | None = None
        self._build()
        self.refresh()

    def _build(self):
        top = ttk.Frame(self, padding=12)
        top.pack(fill="x")
        ttk.Label(top, text="科研工作 1.0", font=("Segoe UI", 20, "bold")).pack(side="left")
        ttk.Label(top, text="证据优先 · 本地可复现", foreground="#59636e").pack(side="left", padx=16)
        body = ttk.PanedWindow(self, orient="horizontal")
        body.pack(fill="both", expand=True, padx=12, pady=(0, 12))
        left = ttk.Frame(body, padding=8)
        right = ttk.Frame(body, padding=8)
        body.add(left, weight=1); body.add(right, weight=3)

        ttk.Label(left, text="研究任务", font=("Segoe UI", 12, "bold")).pack(anchor="w")
        self.task_list = tk.Listbox(left, height=18, exportselection=False)
        self.task_list.pack(fill="both", expand=True, pady=8)
        self.task_list.bind("<<ListboxSelect>>", self.select_task)
        form = ttk.LabelFrame(left, text="新建任务", padding=8); form.pack(fill="x")
        self.title_var = tk.StringVar(); self.question_var = tk.StringVar(); self.material_var = tk.StringVar()
        for label, var in (("标题", self.title_var), ("研究问题", self.question_var), ("材料体系", self.material_var)):
            ttk.Label(form, text=label).pack(anchor="w")
            ttk.Entry(form, textvariable=var).pack(fill="x", pady=(0, 5))
        ttk.Button(form, text="创建任务", command=self.create_task).pack(fill="x")

        self.header = ttk.Label(right, text="选择一个任务", font=("Segoe UI", 15, "bold")); self.header.pack(anchor="w")
        self.stats = ttk.Label(right, text=""); self.stats.pack(anchor="w", pady=(4, 10))
        actions = ttk.Frame(right); actions.pack(fill="x")
        ttk.Button(actions, text="导入 PDF", command=self.import_pdf).pack(side="left")
        ttk.Button(actions, text="抽取候选证据", command=self.extract).pack(side="left", padx=8)
        ttk.Button(actions, text="导出证据 JSON", command=self.export).pack(side="left")
        ttk.Button(actions, text="生成研究报告", command=self.report).pack(side="left", padx=8)
        ttk.Button(actions, text="刷新", command=self.refresh).pack(side="left")
        ttk.Label(right, text="证据记录（候选值必须回查原文；1.0 不把候选自动当结论）", foreground="#59636e").pack(anchor="w", pady=(16, 4))
        cols = ("field", "value", "page", "file", "excerpt")
        self.table = ttk.Treeview(right, columns=cols, show="headings")
        for c, text, width in (("field", "字段", 110), ("value", "候选值", 120), ("page", "页码", 60), ("file", "文献", 180), ("excerpt", "原文片段", 500)):
            self.table.heading(c, text=text); self.table.column(c, width=width, anchor="w")
        self.table.pack(fill="both", expand=True)

    def refresh(self):
        tasks = self.db.tasks(); self.task_list.delete(0, "end")
        for task in tasks: self.task_list.insert("end", f"{task['title']}  [{task['stage']}]")
        if self.task_id:
            for i, task in enumerate(tasks):
                if task["id"] == self.task_id: self.task_list.selection_set(i); break
        self.render()

    def select_task(self, _event=None):
        sel = self.task_list.curselection()
        if not sel: return
        self.task_id = self.db.tasks()[sel[0]]["id"]
        self.render()

    def render(self):
        for item in self.table.get_children(): self.table.delete(item)
        if not self.task_id:
            self.header.config(text="选择一个任务"); self.stats.config(text=""); return
        summary = self.db.summary(self.task_id); task = summary["task"]
        self.header.config(text=task["title"])
        self.stats.config(text=f"阶段：{task['stage']}   文献：{summary['papers']}   证据候选：{summary['evidence']}   材料体系：{task['material_system'] or '未填写'}")
        for row in self.db.evidence(self.task_id):
            self.table.insert("", "end", values=(row["field"], row["value"], row["page_no"], row["filename"], row["excerpt"]))

    def create_task(self):
        if not self.title_var.get().strip(): return messagebox.showwarning("缺少标题", "请填写研究任务标题")
        self.task_id = self.db.create_task(self.title_var.get(), self.question_var.get(), self.material_var.get())
        self.title_var.set(""); self.question_var.set(""); self.material_var.set(""); self.refresh()

    def import_pdf(self):
        if not self.task_id: return messagebox.showwarning("未选择任务", "先创建或选择研究任务")
        path = filedialog.askopenfilename(filetypes=[("PDF", "*.pdf")])
        if not path: return
        try:
            paper = self.db.ingest_pdf(self.task_id, path)
            messagebox.showinfo("导入完成", f"{paper['filename']}\n页数：{paper['pages'].__len__()}\n文本字符：{paper['text_chars']}\n状态：{paper['ocr_status']}")
            self.refresh()
        except Exception as exc:
            messagebox.showerror("导入失败", str(exc))

    def extract(self):
        if not self.task_id: return messagebox.showwarning("未选择任务", "先选择研究任务")
        papers = self.db.db.execute("SELECT id FROM papers WHERE task_id=?", (self.task_id,)).fetchall()
        if not papers: return messagebox.showwarning("没有文献", "先导入 PDF")
        total = sum(len(self.db.extract_materials(p["id"])) for p in papers)
        self.refresh(); messagebox.showinfo("抽取完成", f"新增候选证据：{total} 条\n请逐条回查页码和原文，不要直接当作最终事实。")

    def export(self):
        if not self.task_id:
            return messagebox.showwarning("未选择任务", "先选择研究任务")
        path = filedialog.asksaveasfilename(
            defaultextension=".json", filetypes=[("JSON", "*.json")], initialfile="evidence.json"
        )
        if not path:
            return
        try:
            self.db.export_evidence(self.task_id, path)
            messagebox.showinfo("导出完成", path)
        except Exception as exc:
            messagebox.showerror("导出失败", str(exc))

    def report(self):
        if not self.task_id:
            return messagebox.showwarning("未选择任务", "先选择研究任务")
        path = filedialog.asksaveasfilename(
            defaultextension=".md", filetypes=[("Markdown", "*.md")], initialfile="research-report.md"
        )
        if not path:
            return
        try:
            self.db.export_report(self.task_id, path)
            messagebox.showinfo("报告已生成", path)
        except Exception as exc:
            messagebox.showerror("报告失败", str(exc))

    def destroy(self):
        self.db.close(); super().destroy()


if __name__ == "__main__":
    App().mainloop()
