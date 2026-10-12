"""开始卡片（splash）自检：卡片要么在，要么整个功能静默消失（CSS 默认 opacity:0 + 不挡点击，
所以接线断了界面照常能用、只是卡片永远不出现）—— 这个测试就是防这种"悄悄没了"。

跑：py -3.10 -m unittest -q test_splash_card
"""
import pathlib
import shutil
import subprocess
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent   # tests/ 的上一层 = sidecar 根
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


if __name__ == "__main__":
    unittest.main()
