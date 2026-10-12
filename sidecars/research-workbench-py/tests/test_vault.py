"""知识库（Obsidian Vault）读写自检。

跑：py -3.10 -m unittest -q test_vault
造一个临时 Vault（含 .obsidian 与子目录）→ 扫 → 断言状态口径/热力图口径/标签 →
写回状态 → 断言 frontmatter 变了、正文一字不动 → 断言越界路径被拒。
"""
import datetime as dt
import pathlib
import shutil
import tempfile
import unittest

import vault

NOTE_A = """---
分类: 文献
tags: [NFM, 钠电]
创建日期: {today}
阅读状态: 未读
吸收状态: 待沉淀
---

# 层状氧化物
正文第一行。
#随手标签

## 小结
不动我。
"""

NOTE_B = "# 没有 frontmatter 的笔记\n\n正文。\n"


class VaultTest(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.root = pathlib.Path(tempfile.mkdtemp(prefix="vaulttest_"))
        (cls.root / ".obsidian").mkdir()
        (cls.root / ".obsidian" / "hidden.md").write_text("# 不该被扫到\n", encoding="utf-8")
        (cls.root / "文献").mkdir()
        (cls.root / "文献" / "A.md").write_text(NOTE_A.format(today=dt.date.today().isoformat()), encoding="utf-8")
        (cls.root / "B.md").write_text(NOTE_B, encoding="utf-8")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.root, ignore_errors=True)

    def test_scan(self):
        out = vault.scan(str(self.root))
        self.assertEqual(out["name"], self.root.name)
        self.assertEqual([n["path"] for n in out["notes"]], ["B.md", "文献/A.md"])   # .obsidian 里的被跳过
        a = [n for n in out["notes"] if n["path"] == "文献/A.md"][0]
        self.assertEqual((a["reading"], a["absorption"]), ("未读", "待沉淀"))
        self.assertEqual(a["folder"], "文献")
        self.assertEqual(a["rootFolder"], "文献")
        self.assertEqual(a["created"], dt.date.today().isoformat())
        self.assertTrue(a["createdFromFrontmatter"])
        self.assertIn("NFM", a["tags"])
        b = out["notes"][0]
        self.assertEqual(b["reading"], "未读")                      # 缺属性 = 未读/待沉淀
        self.assertFalse(b["createdFromFrontmatter"])                # 非 frontmatter 日期不进热力图
        st = out["stats"]
        self.assertEqual((st["total"], st["unread"], st["read"], st["todayAdded"]), (2, 2, 0, 1))
        self.assertEqual(len(out["days"]), 365)
        self.assertEqual(out["days"][-1]["date"], dt.date.today().isoformat())
        self.assertEqual(out["days"][-1]["added"], 1)

    def test_write_status_keeps_body(self):
        p = self.root / "文献" / "A.md"
        before_body = vault.split_frontmatter(p.read_text(encoding="utf-8"))[2]
        out = vault.set_status(str(self.root), "文献/A.md", "阅读状态", "已读")
        self.assertEqual(out["value"], "已读")
        text = p.read_text(encoding="utf-8")
        fm, _raw, body = vault.split_frontmatter(text)
        self.assertEqual(fm["阅读状态"], "已读")
        self.assertEqual(fm["完成阅读"], dt.date.today().isoformat())
        self.assertEqual(fm["状态更新时间"], dt.date.today().isoformat())
        self.assertEqual(body, before_body)                          # 正文一字不动
        again = vault.set_status(str(self.root), "文献/A.md", "吸收状态", "已沉淀")
        self.assertEqual(again["changed"], ["吸收状态"])            # 状态更新时间 已是今天 → 不算改动
        self.assertEqual(vault.scan(str(self.root))["stats"]["read"], 1)

    def test_reject_bad_paths(self):
        for bad in ("../secret.md", "文献/A.txt", ".obsidian/x.md"):
            with self.assertRaises(vault.VaultError, msg=bad):
                vault.set_status(str(self.root), bad, "阅读状态", "在读")
        with self.assertRaises(vault.VaultError):
            vault.set_status(str(self.root), "文献/A.md", "阅读状态", "读完了")   # 不在枚举里
        with self.assertRaises(vault.VaultError):
            vault.vault_root("相对路径/vault")


if __name__ == "__main__":
    unittest.main()
