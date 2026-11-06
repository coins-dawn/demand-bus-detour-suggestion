#!/usr/bin/env python3
"""病院・病院の近くの乗り場・寄り道の場所のあいだの歩く道の形を OSRM（徒歩）で取る。

python3 scripts/build_walk.py   →  web/data/walk.json  {"<a>|<b>": 符号化した線}
  a, b は乗り場の id か "s<番号>"（kawagoe.json の spots の並び）。a < b の向きで持つ。
OSRM の徒歩のグラフを立てておく（OSRM_FOOT、既定 http://localhost:5056）:
  docker run -d --rm -p 5056:5000 -v /var/tmp/odc2026-osrm-foot:/data osrm/osrm-backend osrm-routed --algorithm mld /data/kawagoe.osrm
"""
import json
import math
import os
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.join(os.path.dirname(__file__), "..")
OSRM = os.environ.get("OSRM_FOOT", "http://localhost:5056")
NEAR_STOP_M = 500      # planner.js と同じ
SPOT_M = 700           # 寄り道の場所（planner.js は歩いて 12 分まで。少し広めに取る）


def hav(a, b):
    R = 6371000
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp, dl = p2 - p1, math.radians(b[1] - a[1])
    return 2 * R * math.asin(math.sqrt(math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2))


def main():
    d = json.load(open(f"{ROOT}/web/data/kawagoe.json"))
    st = d["stops"]
    pts = {k: (v["lat"], v["lon"]) for k, v in st.items()}
    for i, s in enumerate(d["spots"]):
        pts[f"s{i}"] = (s["lat"], s["lon"])
    pairs = set()
    for h in d["hospitals"]:
        H = pts[h["id"]]
        ids = d["districts"][h["g"]]["stops"]
        near = sorted((s for s in ids if s != h["id"] and hav(pts[s], H) <= NEAR_STOP_M), key=lambda s: hav(pts[s], H))[:5]
        xs = [h["id"]] + near
        sp = [f"s{i}" for i, s in enumerate(d["spots"]) if hav((s["lat"], s["lon"]), H) <= SPOT_M]
        for x in xs:
            if x != h["id"]:
                pairs.add(tuple(sorted((x, h["id"]))))
            for s in sp:
                pairs.add(tuple(sorted((x, s))))
    print("組", len(pairs))

    def fetch(p):
        a, b = pts[p[0]], pts[p[1]]
        url = f"{OSRM}/route/v1/foot/{a[1]},{a[0]};{b[1]},{b[0]}?overview=full&geometries=polyline"
        for _ in range(3):
            try:
                with urllib.request.urlopen(url, timeout=20) as r:
                    j = json.load(r)
                if j.get("code") == "Ok":
                    return p, j["routes"][0]["geometry"]
            except OSError:
                pass
        return p, None

    out = {}
    with ThreadPoolExecutor(8) as ex:
        for p, g in ex.map(fetch, sorted(pairs)):
            if g:
                out[f"{p[0]}|{p[1]}"] = g
    path = f"{ROOT}/web/data/walk.json"
    json.dump(out, open(path, "w"), separators=(",", ":"))
    print("書き出し", path, len(out), "組", os.path.getsize(path) // 1024, "KB")


if __name__ == "__main__":
    main()
