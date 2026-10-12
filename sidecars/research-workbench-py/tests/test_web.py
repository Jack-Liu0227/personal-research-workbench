# POST 必须带 Content-Type: application/json —— 服务端 do_POST 见不到这个头就直接 415，
# 请求连路由都进不去。2026-10-12 开始卡片的「Enter → 全屏」就是栽在这上面：
# splash.js 里裸 fetch 了 /api/win/maximize，被 415 挡掉、catch 一吞，表现成「点了没反应」。
# 
# python -m unittest test_web_fetch -v
from __future__ import annotations
import os
import pathlib
import re
import sys
import unittest
# 开始卡片（splash）自检：卡片要么在，要么整个功能静默消失（CSS 默认 opacity:0 + 不挡点击，
# 所以接线断了界面照常能用、只是卡片永远不出现）—— 这个测试就是防这种"悄悄没了"。
# 跑：py -3.10 -m unittest -q test_splash_card
import shutil
import subprocess
import tempfile


# ---------------- 来自 test_web_fetch.py ----------------
ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

CALL = re.compile(r"fetch\((.*?)\)", re.S)
EXEMPT = "/api/upload"          # 唯一豁免：它走原始字节 body，server.py 在闸门之前就 return 了


class WebFetchTest(unittest.TestCase):
    def test_post_fetches_carry_json_header(self) -> None:
        bad = []
        files = [ROOT / "web" / "index.html"] + sorted((ROOT / "web" / "vendor").glob("*.js"))
        for f in files:
            for m in CALL.finditer(f.read_text(encoding="utf-8")):
                arg = m.group(1)
                if '"POST"' not in arg and "'POST'" not in arg:
                    continue
                if EXEMPT in arg or "Content-Type" in arg:
                    continue
                bad.append("%s: %s" % (f.name, " ".join(arg.split())[:90]))
        self.assertEqual(bad, [], "这些 POST 少了 Content-Type: application/json（会被 415 挡掉）：\n" + "\n".join(bad))


# ---------------- 来自 test_splash_card.py ----------------
ROOT = pathlib.Path(__file__).resolve().parent.parent
HTML = ROOT / "web" / "index.html"
JS = ROOT / "web" / "vendor" / "splash.js"
SERVER = ROOT / "server.py"

TITLE = "Personal Research Workspace"
GO = "Enter"


class SplashCardTest(unittest.TestCase):

    def test_html_wired(self):
        html = HTML.read_text(encoding="utf-8")
        for bit in ('id="splash"', 'id="spGlobe"', 'id="spWord"', 'id="spGo"', 'id="spClose"',
                    '<script src="/vendor/splash.js"></script>', "#splash.ready{opacity:1"):
            self.assertIn(bit, html, bit)
        # 按钮 = magicui 那套结构（圆点 + 覆盖层箭头）
        for bit in ('class="sp-dot"', 'class="sp-lb"', 'class="sp-hv"'):
            self.assertIn(bit, html, bit)

    def test_js_carries_text_and_original_look(self):
        src = JS.read_text(encoding="utf-8")
        self.assertIn(TITLE, src)                     # 标题（字标画的，只能在 JS 里）
        self.assertIn('go: "%s"' % GO, src)
        self.assertIn("LAND_B64", src)                # 地球陆地掩码（base64）
        for bit in ("fade: 0.7", "blurK: 3.5", "labels: true", "function textBox"):   # 原组件的视觉三件套
            self.assertIn(bit, src, bit)
        node = shutil.which("node")
        if node:
            r = subprocess.run([node, "--check", str(JS)], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)

    def test_server_opens_card_sized(self):
        py = SERVER.read_text(encoding="utf-8")
        self.assertIn("CARD_W, CARD_H = 1117, 625", py)
        self.assertIn("_fit_card(h)", py)             # 起来后钉卡片尺寸
        self.assertIn("CARD_PIN = False", py)         # 点「进入」后放掉 → 铺回工作区


class MainScriptSyntaxTest(unittest.TestCase):
    """web/index.html 里那块主脚本必须过 node --check。
    2026-10-12 踩过：加一个 class 时多带了一个反引号，模板串提前闭合，整页只剩一句 SyntaxError 白屏 ——
    这种错 py_compile / 肉眼都抓不到，只有把脚本抠出来 node --check 才看得见。"""

    def test_main_inline_script_parses(self):
        h = (ROOT / "web" / "index.html").read_text(encoding="utf-8")
        blocks = re.findall(r"<script(?![^>]*src=)[^>]*>(.*?)</script>", h, re.S)
        main = max(blocks, key=len)
        tmp = pathlib.Path(tempfile.mkstemp(suffix=".js")[1])
        tmp.write_text(main, encoding="utf-8")
        try:
            r = subprocess.run(["node", "--check", str(tmp)], capture_output=True, text=True, timeout=60)
        except (FileNotFoundError, subprocess.TimeoutExpired):
            self.skipTest("没装 node（或超时），跳过")
        finally:
            try:
                tmp.unlink()
            except OSError:
                pass          # Windows：node 刚读完句柄可能还没放，删不掉就算了（Temp 目录会自己清）
        self.assertEqual(r.returncode, 0, "主脚本语法错：" + chr(10) + (r.stderr or "")[-900:])


if __name__ == "__main__":
    unittest.main()
