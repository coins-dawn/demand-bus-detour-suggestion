#!/usr/bin/env python3
"""画面を撮る（目視確認用）。python3 scripts/shot.py [URL] [出力先ディレクトリ]

1. 開いたところ  2. 行きの便  3. 帰りの便  4. 経路全体
6. このサービスについて  7. スマホの幅
"""
import os
import sys

from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8004/"
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), "..", "shots")
os.makedirs(OUT, exist_ok=True)
ARGS = ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"]


def open_page(b, **kw):
    pg = b.new_page(**kw)
    pg.on("pageerror", lambda e: print("pageerror:", e))
    pg.goto(URL, wait_until="networkidle")
    pg.wait_for_function("window.READY === true", timeout=180000)
    pg.wait_for_timeout(2500)
    return pg


with sync_playwright() as p:
    b = p.chromium.launch(args=ARGS)
    pg = open_page(b, viewport={"width": 1440, "height": 900})
    pg.screenshot(path=f"{OUT}/1_top.png")
    pg.click("#go")
    pg.wait_for_timeout(2500)
    pg.screenshot(path=f"{OUT}/2_go.png")
    pg.click("#to-back")
    pg.wait_for_timeout(2500)
    pg.screenshot(path=f"{OUT}/3_back.png")
    pg.click("#to-all")
    pg.wait_for_timeout(2500)
    pg.screenshot(path=f"{OUT}/4_all.png")
    pg.close()
    ab = b.new_page(viewport={"width": 1440, "height": 900})
    ab.goto(URL + "about.html")
    ab.screenshot(path=f"{OUT}/6_about.png", full_page=True)
    m = open_page(b, viewport={"width": 390, "height": 844}, device_scale_factor=2)
    m.click("#go")
    m.wait_for_timeout(2000)
    m.screenshot(path=f"{OUT}/7_phone.png", full_page=True)
    b.close()
