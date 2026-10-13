# -*- coding: utf-8 -*-
"""数据根目录回归测试。

背景：侧车被 Electron 主进程托管后，用户数据不能再落在程序目录下的 data/。
安装目录（Program Files）通常不可写，卸载时还会连数据一起删掉，而 data/
也绝不该随发行物分发或混进仓库。因此 server.py 与 workflow.py 都必须跟随
mail.py 早已确立的 RESEARCH_WORKBENCH_DATA 约定。

两个模块都用模块级常量缓存解析结果，所以每次都必须用独立子进程重新导入，
不能在同一个解释器里改环境变量后重复导入。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
APP = HERE.parent

PROBE = r"""
import json, sys
sys.path.insert(0, sys.argv[1])
result = {"error": None}
try:
    import workflow
    import server
except Exception as exc:                      # 依赖缺失不应该伪装成断言失败
    result["error"] = f"{type(exc).__name__}: {exc}"
else:
    result.update({
        "workflow_data": str(workflow.DATA),
        "workflow_notes": str(workflow.NOTES),
        "workflow_out": str(workflow.OUT),
        "data_root": str(server.DATA_ROOT),
        "db": str(server.DB_PATH),
        "uploads": str(server.UPLOADS),
    })
print(json.dumps(result, ensure_ascii=False))
"""


def probe(data_root: str | None, db_path: str | None = None) -> dict:
    """在干净解释器里导入侧车模块，返回各数据路径。"""
    env = {k: v for k, v in os.environ.items()
           if k not in ("RESEARCH_WORKBENCH_DATA", "RESEARCH_WORKBENCH_DB")}
    if data_root is not None:
        env["RESEARCH_WORKBENCH_DATA"] = data_root
    if db_path is not None:
        env["RESEARCH_WORKBENCH_DB"] = db_path
    out = subprocess.run([sys.executable, "-c", PROBE, str(APP)],
                         capture_output=True, text=True, timeout=120, env=env)
    if out.returncode != 0:
        raise AssertionError(f"探测进程失败：{out.stderr.strip()[-800:]}")
    return json.loads(out.stdout.strip().splitlines()[-1])


class DataRootTest(unittest.TestCase):
    def test_default_stays_next_to_the_application(self) -> None:
        """不设环境变量时，行为必须与改造前完全一致。"""
        r = probe(None)
        self.assertIsNone(r["error"], r["error"])
        self.assertEqual(r["data_root"], str(APP / "data"))
        self.assertEqual(r["db"], str(APP / "data" / "research.sqlite3"))
        self.assertEqual(r["uploads"], str(APP / "data" / "uploads"))
        self.assertEqual(r["workflow_data"], str(APP / "data"))
        self.assertEqual(r["workflow_notes"], str(APP / "data" / "notes"))
        self.assertEqual(r["workflow_out"], str(APP / "data" / "out"))

    def test_data_env_moves_every_root(self) -> None:
        """一个 RESEARCH_WORKBENCH_DATA 必须同时搬走 server 与 workflow 的全部路径。"""
        target = str(Path(os.environ.get("TEMP", "/tmp")) / "rw-sidecar-data-root")
        r = probe(target)
        self.assertIsNone(r["error"], r["error"])
        self.assertEqual(r["data_root"], target)
        self.assertEqual(r["db"], str(Path(target) / "research.sqlite3"))
        self.assertEqual(r["uploads"], str(Path(target) / "uploads"))
        self.assertEqual(r["workflow_data"], target)
        self.assertEqual(r["workflow_notes"], str(Path(target) / "notes"))
        self.assertEqual(r["workflow_out"], str(Path(target) / "out"))

    def test_db_env_still_overrides_only_the_database(self) -> None:
        """RESEARCH_WORKBENCH_DB 是更具体的覆盖，现有测试依赖它，不能被破坏。"""
        root = str(Path(os.environ.get("TEMP", "/tmp")) / "rw-sidecar-data-root2")
        db = str(Path(os.environ.get("TEMP", "/tmp")) / "rw-other.sqlite3")
        r = probe(root, db)
        self.assertIsNone(r["error"], r["error"])
        self.assertEqual(r["db"], db)
        self.assertEqual(r["data_root"], root)
        self.assertEqual(r["workflow_data"], root)


if __name__ == "__main__":
    unittest.main()
