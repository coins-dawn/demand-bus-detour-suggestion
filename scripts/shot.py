#!/usr/bin/env python3
"""画面を撮る（目視確認用）。python3 scripts/shot.py [URL] [出力先ディレクトリ]

1. 開いたところ  2. 日付のカレンダー  3. 予約時刻の棒グラフ  4. 行きの候補  5. 帰りの候補  6. 経路全体
8. 乗り物で行けない病院  9. 病院の吹き出し  11. このサービスについて  12. スマホ
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
    pg.on("console", lambda m: m.type == "error" and print("console:", m.text))
    pg.goto(URL, wait_until="networkidle")
    pg.wait_for_function("window.READY === true", timeout=180000)
    pg.wait_for_timeout(2500)
    return pg


def hosp_id(pg, name):
    return pg.evaluate(f"S.med.list.find((x) => x.name.includes({name!r})).id")


def fill(pg, g, stop, hosp, date, t, dur=3600):
    pg.evaluate(f"setDistrict({g!r})")
    pg.evaluate(f"setStop({stop!r})")
    pg.evaluate(f"setHosp({hosp_id(pg, hosp)!r})")
    pg.evaluate(f"setDate(S.data.days.findIndex((d) => d.date === {date!r}))")
    pg.evaluate(f"S.T = {t}; S.dur = {dur}; syncForm()")


def shot(pg, name, wait=2500):
    pg.wait_for_timeout(wait)
    pg.screenshot(path=f"{OUT}/{name}.png")


with sync_playwright() as p:
    b = p.chromium.launch(args=ARGS)
    pg = open_page(b, viewport={"width": 1440, "height": 900})
    shot(pg, "1_top", 500)
    pg.evaluate("setStop('291')")
    pg.click("#date")
    shot(pg, "2_date", 800)
    pg.click("#pop .day[data-i='7']")
    pg.select_option("#dur", "3600")
    pg.click("#time")
    pg.click("#pop .tbtn[data-t='36000']")
    pg.wait_for_timeout(400)
    pg.click("#time")
    shot(pg, "3_time", 800)
    pg.click("#pop-close")
    pg.evaluate(f"setHosp({hosp_id(pg, 'きりむら')!r})")
    pg.click("#go")
    shot(pg, "4_go")
    pg.click("#to-back")
    shot(pg, "5_back")
    pg.click("#to-all")
    shot(pg, "6_all")
    # 乗り物で行けない
    fill(pg, "2", "291", "叶澤", "20260708", 10 * 3600)
    pg.click("#go")
    shot(pg, "8_taxi")
    # 病院の吹き出し
    pg.evaluate("clearResults()")
    pg.evaluate(f"(() => {{ const H = medOf({hosp_id(pg, 'きりむら')!r}); map.jumpTo({{center: [H.lon, H.lat], zoom: 15}}); openPopup([H.lon, H.lat], hospPopup(H)); }})()")
    shot(pg, "9_popup")
    pg.close()
    ab = b.new_page(viewport={"width": 1440, "height": 900})
    ab.goto(URL + "about.html")
    ab.screenshot(path=f"{OUT}/11_about.png", full_page=True)
    m = open_page(b, viewport={"width": 390, "height": 844}, device_scale_factor=2)
    fill(m, "2", "291", "きりむら", "20260708", 10 * 3600)
    m.click("#go")
    m.wait_for_timeout(2000)
    m.screenshot(path=f"{OUT}/12_phone.png", full_page=True)
    b.close()
