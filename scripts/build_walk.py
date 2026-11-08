#!/usr/bin/env python3
"""歩く道の形と道のりを OSRM（徒歩）で取る → web/data/walk.json

    python3 scripts/build_walk.py      （build_data.py・build_rail.py・build_med.py のあとに）

walk.json = {"p": {"<a>|<b>": [符号化した線, 道のり m]}, "c": {"<起点>": [寄り道の場所の番号, ...]}}
  a, b は 乗り場の id ／ "h<医療情報ネットの ID>"（病院・診療所）／ "s<番号>"（kawagoe.json の spots の並び）。a < b の向きで持つ。
  c は、病院と駅の乗り場ごとに「寄り道の候補にする場所」（種類ごとに近い 2 か所、SPOT_M 以内）。
OSRM の徒歩のグラフを立てておく（OSRM_FOOT、既定 http://localhost:5056）:
  docker run -d --rm -p 5056:5000 -v /var/tmp/odc2026-osrm-foot:/data osrm/osrm-backend osrm-routed --algorithm mld /data/kawagoe.osrm
"""
import collections
import json
import math
import os
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.join(os.path.dirname(__file__), "..")
OUT = f"{ROOT}/web/data"
OSRM = os.environ.get("OSRM_FOOT", "http://localhost:5056")
SPOT_M = 500           # 寄り道の場所は、起点からこの距離（直線）まで
PER_KIND = 2


def hav(a, b):
    R = 6371000
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp, dl = p2 - p1, math.radians(b[1] - a[1])
    return 2 * R * math.asin(math.sqrt(math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2))


def route(a, b):
    url = f"{OSRM}/route/v1/foot/{a[1]},{a[0]};{b[1]},{b[0]}?overview=full&geometries=polyline"
    for _ in range(3):
        try:
            with urllib.request.urlopen(url, timeout=20) as r:
                j = json.load(r)
            if j.get("code") == "Ok":
                return j["routes"][0]["geometry"], round(j["routes"][0]["distance"])
        except OSError:
            pass
    return None


def main():
    d = json.load(open(f"{OUT}/kawagoe.json"))
    med = json.load(open(f"{OUT}/med.json"))["list"]
    rail = json.load(open(f"{OUT}/rail.json"))
    pts = {k: (v["lat"], v["lon"]) for k, v in d["stops"].items()}
    for i, s in enumerate(d["spots"]):
        pts[f"s{i}"] = (s["lat"], s["lon"])
    for x in med:
        pts["h" + x["id"]] = (x["lat"], x["lon"])

    def near_spots(P):
        by = collections.defaultdict(list)
        for i, s in enumerate(d["spots"]):
            m = hav((s["lat"], s["lon"]), P)
            if m <= SPOT_M:
                by[s["kind"]].append((m, i))
        return sorted(i for v in by.values() for _, i in sorted(v)[:PER_KIND])

    cand, pairs = {}, set()
    key = lambda a, b: (a, b) if a < b else (b, a)
    # 病院: 病院 ⇔ 場所、場所 ⇔ 病院の近くの乗り場
    for x in med:
        h = "h" + x["id"]
        cs = near_spots(pts[h])
        cand[h] = cs
        for i in cs:
            pairs.add(key(h, f"s{i}"))
            for s, _ in x["acc"]:
                pairs.add(key(s, f"s{i}"))
            for k, _ in x["sta"]:
                pairs.add(key(rail["stations"][k]["stop"], f"s{i}"))
    # 駅の乗り場: 乗り場 ⇔ 場所
    for st in rail["stations"]:
        if not st.get("stop"):
            continue
        cs = near_spots(pts[st["stop"]])
        cand[st["stop"]] = cs
        for i in cs:
            pairs.add(key(st["stop"], f"s{i}"))
    pairs = sorted(pairs)
    print("組", len(pairs), "起点", len(cand))
    out = {}
    with ThreadPoolExecutor(8) as ex:
        for (a, b), r in zip(pairs, ex.map(lambda p: route(pts[p[0]], pts[p[1]]), pairs)):
            if r:
                out[f"{a}|{b}"] = list(r)
    # 病院 ⇔ 乗り場・駅（build_med.py が取ったもの）
    wm = f"{ROOT}/work/walk_med.json"
    if os.path.exists(wm):
        dist = {}
        for x in med:
            for s, m in x["acc"]:
                dist[key(s, "h" + x["id"])] = m
            for k, m in x["sta"]:
                dist[key(rail["stations"][k]["stop"], "h" + x["id"])] = m
        for k, enc in json.load(open(wm)).items():
            a, b = k.split("|")
            kk = key(a, b)
            out[f"{kk[0]}|{kk[1]}"] = [enc, dist.get(kk, 0)]
    with open(f"{OUT}/walk.json", "w") as f:
        json.dump({"p": out, "c": cand}, f, separators=(",", ":"))
    print("書き出し walk.json", len(out), "組", os.path.getsize(f"{OUT}/walk.json") // 1024, "KB")


if __name__ == "__main__":
    main()
