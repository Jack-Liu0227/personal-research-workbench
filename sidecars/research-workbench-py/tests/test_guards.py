"""两个闸门的自检：出站脱敏不能误伤科研文本，引用核验要能把编的引用抓出来。"""
import unittest

import guards


class PrivacyGateTest(unittest.TestCase):
    def test_redacts_pii_keeps_science(self) -> None:
        msg = [{"role": "user", "content": "联系 13812345678 或 zhangsan@xjtu.edu.cn。"
                                           "DOI 10.1016/j.jes.2026.122995，样品 NaNi1/3Fe1/3Mn1/3O2，"
                                           "页码 122995，年份 2026，批号 2024 0912 3311 8877。"}]
        hits = guards.scrub(msg)
        c = msg[0]["content"]
        self.assertIn("手机号", hits)
        self.assertIn("邮箱", hits)
        self.assertNotIn("13812345678", c)
        self.assertNotIn("zhangsan@xjtu.edu.cn", c)
        # 科研文本一律不许被打码
        self.assertIn("10.1016/j.jes.2026.122995", c)
        self.assertIn("NaNi1/3Fe1/3Mn1/3O2", c)
        self.assertIn("122995", c)
        self.assertIn("2026", c)

    def test_redacts_secrets(self) -> None:
        msg = [{"role": "system", "content": "key sk-abcdefghijklmnop12345678 和 "
                                             "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----"}]
        hits = guards.scrub(msg)
        self.assertIn("密钥", hits)
        self.assertIn("私钥", hits)
        self.assertNotIn("sk-abcdefghijklmnop12345678", msg[0]["content"])
        self.assertNotIn("MIIEowIBAAKCAQEA", msg[0]["content"])


class CiteGateTest(unittest.TestCase):
    def setUp(self) -> None:
        self.draft = ("# 正文\n\n## 1 引言\nCu 掺杂能提升循环保持率[1]，见 Smith et al., 2024 的结论。\n"
                      "锚句在这里摆着。\n")
        self.entries = [
            {"anchor": "锚句在这里摆着。", "title": "A real paper on NaNFM", "doi": "10.1016/j.jes.2026.122995",
             "paper_id": "p1"},
            {"anchor": "这句正文里没有", "title": "Fake Nature paper", "doi": "10.1038/fake.2026.9"},
            {"anchor": "锚句在这里摆着。", "title": "", "doi": "", "url": ""},
        ]
        self.papers = [{"id": "p1", "title": "A real paper on NaNFM", "doi": "10.1016/j.jes.2026.122995",
                        "filename": "a.pdf", "pages": 12}]

    def test_catches_fabrication(self) -> None:
        r = guards.audit(self.draft, self.entries, self.papers)
        codes = [b["code"] for b in r["bad"]]
        self.assertEqual(r["total"], 3)
        self.assertEqual(r["inline"], 2)                    # [1] 和 Smith et al., 2024 都该抓到
        self.assertIn("ANCHOR", codes)                      # C2 锚句对不上
        self.assertIn("NOTINLIB", codes)                    # C2 的 DOI 库里没有 = 疑似编造
        self.assertIn("NOSOURCE", codes)                    # C3 什么落点都没给
        self.assertNotIn("C1", [b["where"] for b in r["bad"]])   # C1 是真引用，不许误报

    def test_clean_draft_passes(self) -> None:
        r = guards.audit("锚句在这里摆着。\n", [self.entries[0]], self.papers)
        self.assertEqual(r["bad"], [])
        self.assertIn("全部对得上号", guards.report(r))
        self.assertIn("全部对得上号", guards.audit_block(r))


if __name__ == "__main__":
    unittest.main(verbosity=2)
