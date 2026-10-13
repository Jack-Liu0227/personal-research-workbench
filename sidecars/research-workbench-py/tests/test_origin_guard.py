# 跨站防线的回归测试：do_POST 顶部的 Origin 闸门，以及早退后必须复位长连接。
#
# 背景（2026-10-13）：Origin 检查原本排在 /api/upload 之后 —— 上传走 multipart，
# 属于跨站「简单请求」不触发预检，于是任意网页都能把文件推进用户机器。把闸门提到最前面
# 之后暴露出第二个坑：403/415 早退时没把请求体读走，HTTP/1.1 是长连接
# （Handler 顶部 protocol_version = "HTTP/1.1"），残留在 socket 里的字节会被当成
# 下一个请求的起始行解析 —— 客户端前一个请求被正确拒绝、紧接着那个无辜收到 501。
#
# 这两件事都不靠肉眼看代码，钉在这里。
#
#   python -m unittest tests.test_origin_guard -v
from __future__ import annotations
import http.client
import json
import pathlib
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import server as srv  # noqa: E402


class OriginGuardTest(unittest.TestCase):
    """起一个真的 Handler，用真 socket 说话；库和上传目录都指到临时目录，不碰仓库里的 data/。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls.td = tempfile.TemporaryDirectory(prefix="rw-origin-")
        cls._db, cls._uploads = srv.DB_PATH, srv.UPLOADS
        srv.DB_PATH = pathlib.Path(cls.td.name) / "wb.sqlite3"
        srv.UPLOADS = pathlib.Path(cls.td.name) / "uploads"
        srv.WorkflowDB(srv.DB_PATH).close()
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), srv.Handler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        cls.httpd.server_close()
        srv.DB_PATH, srv.UPLOADS = cls._db, cls._uploads
        cls.td.cleanup()

    # ---------- 工具 ----------
    def _conn(self) -> http.client.HTTPConnection:
        return http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)

    @staticmethod
    def _post(c: http.client.HTTPConnection, path: str, headers: dict, body: bytes = b"{}"):
        c.request("POST", path, body=body, headers=headers)
        r = c.getresponse()
        return r.status, r.read()

    @staticmethod
    def _get(c: http.client.HTTPConnection, path: str):
        c.request("GET", path)
        r = c.getresponse()
        return r.status, r.read()

    def _local_origin(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    # ---------- Origin 闸门 ----------
    def test_cross_site_upload_is_rejected(self) -> None:
        """别的站点发来的上传 → 403。修复前这里会 200，文件直接落到用户磁盘。"""
        c = self._conn()
        try:
            st, body = self._post(c, "/api/upload?name=x.txt", {"Origin": "http://evil.example"}, b"payload")
            self.assertEqual(st, 403)
            self.assertIn("来源", json.loads(body)["error"])
        finally:
            c.close()

    def test_same_origin_upload_passes(self) -> None:
        """界面自己发（Origin 就是本机）→ 照常 200，别把正常路径一起挡了。"""
        c = self._conn()
        try:
            st, body = self._post(c, "/api/upload?name=x.txt", {"Origin": self._local_origin()}, b"payload")
            self.assertEqual(st, 200)
            self.assertEqual(json.loads(body)["size"], len(b"payload"))
        finally:
            c.close()

    def test_missing_origin_upload_still_passes(self) -> None:
        """没有 Origin 的本地脚本 / curl 仍要能用 —— 这条不是漏洞，是设计。"""
        c = self._conn()
        try:
            st, _ = self._post(c, "/api/upload?name=x.txt", {}, b"payload")
            self.assertEqual(st, 200)
        finally:
            c.close()

    def test_cross_site_json_route_is_403_not_501(self) -> None:
        """JSON 路由被跨站打 → 403。

        注意这条单发不出一条连接的版本是抓不住 501 的（退回修复它照样绿）；
        真正钉住 501 的是下面 test_connection_survives_* 两条 —— 必须复用同一条连接
        才复现得出「残留体被当成下一个请求起始行」。这里只确认闸门本身生效。
        """
        c = self._conn()
        try:
            st, _ = self._post(c, "/api/state", {"Origin": "http://evil.example",
                                                 "Content-Type": "application/json"})
            self.assertEqual(st, 403)
        finally:
            c.close()

    def test_non_json_content_type_is_415(self) -> None:
        c = self._conn()
        try:
            st, _ = self._post(c, "/api/state", {"Content-Type": "text/plain"})
            self.assertEqual(st, 415)
        finally:
            c.close()

    # ---------- 早退之后长连接必须还能用（_drain） ----------
    def test_connection_survives_403_then_reuse(self) -> None:
        """同一条连接上：先被 403 挡掉，紧接着的正常请求仍要 200。

        这就是 501 那个现象的正面反例。只发一次请求的测试抓不到它 —— 必须复用同一条连接。
        """
        c = self._conn()
        try:
            st, _ = self._post(c, "/api/state", {"Origin": "http://evil.example",
                                                 "Content-Type": "application/json"})
            self.assertEqual(st, 403)
            st2, body2 = self._get(c, "/api/state")
            self.assertEqual(st2, 200, "403 早退没复位长连接：残留请求体把下一个请求带歪了")
            self.assertGreater(len(body2), 100)
        finally:
            c.close()

    def test_connection_survives_415_then_reuse(self) -> None:
        """415 那条早退路径同样要复位长连接。"""
        c = self._conn()
        try:
            st, _ = self._post(c, "/api/state", {"Content-Type": "text/plain"})
            self.assertEqual(st, 415)
            st2, _ = self._get(c, "/api/state")
            self.assertEqual(st2, 200, "415 早退没复位长连接")
        finally:
            c.close()

    def test_early_rejection_leaves_no_upload_behind(self) -> None:
        """被 403 挡掉的那次上传不能留下任何文件（连空目录都不该建）。"""
        c = self._conn()
        try:
            st, _ = self._post(c, "/api/upload?name=evil.txt", {"Origin": "http://evil.example"}, b"payload")
            self.assertEqual(st, 403)
        finally:
            c.close()
        left = list(pathlib.Path(srv.UPLOADS).glob("*")) if pathlib.Path(srv.UPLOADS).is_dir() else []
        self.assertEqual(left, [], "被拒绝的上传仍然落盘了：%s" % left)


if __name__ == "__main__":
    unittest.main()
