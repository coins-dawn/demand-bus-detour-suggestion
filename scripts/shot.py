#!/usr/bin/env python3
"""画面を撮る（目視確認用）。python3 scripts/shot.py [URL] [出力先ディレクトリ]

1. 開いたところ（車が動いている地図）
2. 便をさがしたところ（行き・帰りの候補）
3. 予約して自分の便を見ているところ
4. スマホの幅
"""
import os
import sys

from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8004/"
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), "..", "shots")
os.makedirs(OUT, exist_ok=True)

with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"])
    pg = b.new_page(viewport={"width": 1440, "height": 900})
    logs = []
    pg.on("console", lambda m: logs.append(f"{m.type}: {m.text}"))
    pg.on("pageerror", lambda e: logs.append(f"pageerror: {e}"))
    pg.goto(URL + "?t=09:00", wait_until="networkidle")
    pg.wait_for_function("window.READY === true", timeout=60000)
    pg.wait_for_timeout(4000)
    pg.screenshot(path=f"{OUT}/1_top.png")
    # 地区を切り替える
    pg.click("#dist button[data-g='1']")
    pg.wait_for_timeout(2500)
    pg.screenshot(path=f"{OUT}/1b_district1.png")
    pg.click("#dist button[data-g='2']")
    pg.wait_for_timeout(2000)
    # 拡大して、経路を引いているところ・走っているところ・乗り降りしているところを止めて撮る
    ev = pg.evaluate("""() => { const E = S.tl[S.g], o = {};
      for (const e of E) {
        if (!o.draw && e.arr - e.leave > 300 && e.leave > 9 * 3600) o.draw = [e.leave + 0.3 * Math.min(0.4 * (e.arr - e.leave), 30), e.from, e.to];
        if (!o.run && e.arr - e.leave > 300 && e.leave > 9.5 * 3600) o.run = [e.leave + 0.6 * (e.arr - e.leave), e.from, e.to];
        if (!o.board && e.k === 'P' && e.start > 9 * 3600) o.board = [e.start + 120, e.to, e.to];
        if (!o.alight && e.k === 'D' && e.start > 9 * 3600) o.alight = [e.start + 50, e.to, e.to];
        if (!o.wait && e.k === 'P' && e.start > 10 * 3600) o.wait = [e.start - 200, e.to, e.to];
      } return o; }""")
    for name, (t, a, b2) in ev.items():
        pg.evaluate(f"""() => {{ S.playing = false; S.speed = 60; const st = S.data.stops, A = st['{a}'], B = st['{b2}'];
          map.jumpTo({{ center: [(A.lon + B.lon) / 2, (A.lat + B.lat) / 2], zoom: '{a}' === '{b2}' ? 16.5 : 14 }}); S.t = {t}; }}""")
        pg.wait_for_timeout(1800)
        pg.screenshot(path=f"{OUT}/5_{name}.png")
    pg.evaluate("S.speed = 300; S.playing = true")
    pg.click("#go")
    pg.wait_for_timeout(2500)
    pg.screenshot(path=f"{OUT}/2_search.png")
    tall = b.new_page(viewport={"width": 1440, "height": 3000})
    tall.goto(URL + "?t=09:00&paused", wait_until="networkidle")
    tall.wait_for_function("window.READY === true", timeout=60000)
    tall.wait_for_timeout(2500)
    tall.click("#go")
    tall.wait_for_timeout(2500)
    tall.screenshot(path=f"{OUT}/2a_pane.png", clip={"x": 0, "y": 230, "width": 420, "height": 2600})
    pg.click("#book")
    pg.wait_for_timeout(5000)
    pg.screenshot(path=f"{OUT}/3_booked.png")
    pg.evaluate("S.t = 9 * 3600 + 25 * 60; S.playing = false")
    pg.wait_for_timeout(1500)
    pg.screenshot(path=f"{OUT}/3b_me_at_spot.png")
    m = b.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    m.goto(URL + "?t=09:00", wait_until="networkidle")
    m.wait_for_function("window.READY === true", timeout=180000)
    m.wait_for_timeout(3000)
    m.click("#go")
    m.wait_for_timeout(2500)
    m.screenshot(path=f"{OUT}/4_phone.png", full_page=False)
    b.close()
    print("\n".join(logs[-20:]) or "コンソールの出力なし")
