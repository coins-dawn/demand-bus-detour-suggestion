#!/usr/bin/env python3
"""web/ を配信する（キャッシュさせない）。python3 scripts/serve.py [ポート]

既定のポートは 8004（Vagrantfile で VM の 8004 がホストの 8004 に出ている）。
python3 -m http.server は Cache-Control を出さず、差し替えても古い画面が出ることがあるので no-store を付ける。
"""
import functools
import http.server
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8004
WEB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web")


class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


http.server.ThreadingHTTPServer(("0.0.0.0", PORT), functools.partial(H, directory=WEB)).serve_forever()
