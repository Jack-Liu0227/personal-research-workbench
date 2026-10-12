"""test_mail.py —— 邮箱后端里唯一不方便连真服务器验证的那块：MIME 解析（正文/附件/内嵌图/编码头）。
真 IMAP 登录要有账号，无法在测试里跑；所以这里造一封真实的 RFC822 邮件喂给 shape_message()。
"""
import email.message
import email.utils
import unittest

import mail

PNG = bytes.fromhex("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a494441547800010000000005010d0a2db40000000049454e44ae426082")
PDF = b"%PDF-1.4\n" + b"x" * 500 + b"\n%%EOF\n"


def build_mail() -> bytes:
    msg = email.message.EmailMessage()
    msg["Subject"] = "=?utf-8?B?" + __import__("base64").b64encode("周报：掺杂排序".encode()).decode() + "?="
    msg["From"] = "=?utf-8?B?" + __import__("base64").b64encode("张三".encode()).decode() + "?= <zhangsan@example.com>"
    msg["To"] = "me@example.com"
    msg["Cc"] = "boss@example.com"
    msg["Date"] = email.utils.formatdate()
    msg["Message-ID"] = "<abc123@example.com>"
    msg.set_content("纯文本正文第一行\n第二行")
    msg.add_alternative('<p>HTML 正文</p><img src="cid:pic1">', subtype="html")
    html_part = msg.get_payload()[1]
    html_part.add_related(PNG, maintype="image", subtype="png", cid="<pic1>", filename="pic.png")
    msg.add_attachment(PDF, maintype="application", subtype="pdf", filename="论文.pdf")
    return msg.as_bytes()


class TestShapeMessage(unittest.TestCase):
    def setUp(self):
        self.d = mail.shape_message(build_mail(), "42")

    def test_头部解码(self):
        self.assertEqual(self.d["subject"], "周报：掺杂排序")
        self.assertEqual(self.d["fromName"], "张三")
        self.assertEqual(self.d["fromAddress"], "zhangsan@example.com")
        self.assertEqual(self.d["to"], "me@example.com")
        self.assertEqual(self.d["cc"], "boss@example.com")
        self.assertEqual(self.d["messageId"], "<abc123@example.com>")

    def test_正文两份都有(self):
        self.assertIn("纯文本正文第一行", self.d["text"])
        self.assertIn("HTML 正文", self.d["html"])

    def test_内嵌图换成_data_url(self):
        self.assertNotIn("cid:pic1", self.d["html"])
        self.assertIn("data:image/png;base64,", self.d["html"])

    def test_附件清单(self):
        names = [a["filename"] for a in self.d["attachments"]]
        self.assertIn("论文.pdf", names)
        pdf = [a for a in self.d["attachments"] if a["filename"] == "论文.pdf"][0]
        self.assertEqual(pdf["contentType"], "application/pdf")
        self.assertEqual(pdf["size"], len(PDF))
        self.assertFalse(pdf["inline"])
        self.assertIn("pic.png", names)

    def test_uid与大小(self):
        self.assertEqual(self.d["uid"], 42)
        self.assertGreater(self.d["size"], 500)


class TestAccountShape(unittest.TestCase):
    def test_密码不外泄(self):
        acc = {"id": "1", "email": "a@b.com", "password": "secret", "provider": "163"}
        pub = mail.public_account(acc)
        self.assertNotIn("password", pub)
        self.assertTrue(pub["hasPassword"])

    def test_预设补全端口(self):
        acc = mail.normalize_account_input({"provider": "163", "email": "a@163.com", "password": "p"}, {})
        self.assertEqual(acc["imapHost"], "imap.163.com")
        self.assertEqual(acc["smtpPort"], 465)
        self.assertTrue(acc["imapSecure"])

    def test_校验必填(self):
        self.assertEqual(mail.validate_account({"email": "bad", "password": "p"}), "请填写正确的邮箱地址")
        self.assertEqual(mail.validate_account({"email": "a@b.com", "password": ""}), "请填写授权码 / 密码")
        self.assertEqual(mail.validate_account({"email": "a@b.com", "password": "p"}), "请填写 IMAP 服务器地址（可在「服务商」处选择预设）")

    def test_mutf7_文件夹名(self):
        # 中文文件夹在 IMAP 上走 modified UTF-7
        self.assertEqual(mail._decode_mutf7("&XfJT0ZAB-"), "已发送")   # 163 的「已发送」就是这个编码
        self.assertEqual(mail._decode_mutf7("INBOX"), "INBOX")


if __name__ == "__main__":
    unittest.main()
