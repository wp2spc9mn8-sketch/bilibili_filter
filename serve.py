#!/usr/bin/env python3
"""把 bilibili 目录用本地 HTTP 服务暴露出来，供 Tampermonkey 抓取 .user.js。
双 fork 成守护进程，避免被父 shell 的进程组清理掉。"""
import os
import sys
import json
import time
import socket
import http.server
import socketserver

PORT = 8899
# 脚本所在目录，而不是硬编码的家目录 ——
# 否则别人 clone 下来跑会直接 500（目录不存在）。
# 仓库提交前这里是 "/Users/kent/bilibili"，公开分发时会坏掉。
ROOT = os.path.dirname(os.path.abspath(__file__))


def already_running():
    s = socket.socket()
    s.settimeout(0.5)
    try:
        s.connect(("127.0.0.1", PORT))
        return True
    except OSError:
        return False
    finally:
        s.close()


def daemonize():
    if os.fork() > 0:
        os._exit(0)
    os.setsid()
    if os.fork() > 0:
        os._exit(0)
    # 脱离控制终端
    devnull = os.open(os.devnull, os.O_RDWR)
    log = os.open("/tmp/blf-server.log", os.O_CREAT | os.O_WRONLY | os.O_APPEND)
    os.dup2(devnull, 0)
    os.dup2(log, 1)
    os.dup2(log, 2)
    os.chdir(ROOT)


REPORTS = os.path.join(ROOT, "reports")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def guess_type(self, path):
        """文本资源一律标明 UTF-8。

        不加 charset 时，Tampermonkey 会按 Latin-1 解码脚本，
        所有中文注释都变成 æ¡£ä½ 这样的乱码。
        """
        base = super().guess_type(path)
        if base.startswith("text/") or base in (
            "application/javascript",
            "application/x-javascript",
            "application/json",
        ):
            if "charset" not in base:
                base += "; charset=utf-8"
        return base

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_POST(self):
        if self.path.rstrip("/") not in ("/report", ""):
            self.send_error(404)
            return
        try:
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n) if n else b"{}"
            data = json.loads(raw.decode("utf-8") or "{}")
            os.makedirs(REPORTS, exist_ok=True)
            ts = time.strftime("%Y%m%d-%H%M%S")
            seq = data.get("seq")
            name = "%s-%s.json" % (ts, seq if seq is not None else "x")
            with open(os.path.join(REPORTS, name), "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=1)
            with open(os.path.join(REPORTS, "latest.json"), "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=1)
            body = json.dumps({"ok": True, "saved": name}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:  # noqa: BLE001
            body = json.dumps({"ok": False, "err": str(e)}).encode("utf-8")
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)


def main():
    if already_running():
        print("already running on %d" % PORT)
        return
    if "--foreground" not in sys.argv:
        daemonize()
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    socketserver.ThreadingTCPServer.daemon_threads = True
    with socketserver.ThreadingTCPServer(("127.0.0.1", PORT), Handler) as httpd:
        httpd.serve_forever()


if __name__ == "__main__":
    main()
