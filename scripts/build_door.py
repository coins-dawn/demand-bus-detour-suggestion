#!/usr/bin/env python3
"""家の近くのバス停 ⇔ 病院・診療所を、乗り物を使わずに行くときの道（同じ地区の組ごと）→ web/data/door_<地区>.json

    python3 scripts/build_door.py      （build_med.py のあとに）

door_<g>.json = {"c": {"<バス停>|h<ID>": [符号化した線, 道のり m, 走る時間 秒]},   … タクシー（OSRM の車）
                 "w": {"<バス停>|h<ID>": [符号化した線, 道のり m]}}               … 歩き（OSRM の徒歩。直線で WALK_M まで）
OSRM の車（OSRM_URL、既定 http://localhost:5055）と徒歩（OSRM_FOOT、既定 http://localhost:5056）を立てておく。
"""
import json
import math
import os
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.join(os.path.dirname(__file__), "..")
OUT = f"{ROOT}/web/data"
CAR = os.environ.get("OSRM_URL", "http://localhost:5055")
FOOT = os.environ.get("OSRM_FOOT", "http://localhost:5056")
WALK_M = 1600     # 直線でこれより近い組だけ、歩く道も取る（trip.js は道のり 2km まで歩きをすすめる）


def hav(a, b):
    R = 6371000
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp, dl = p2 - p1, math.radians(b[1] - a[1])
    return 2 * R * math.asin(math.sqrt(math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2))


def route(base, prof, a, b, overview):
    url = f"{base}/route/v1/{prof}/{a[1]},{a[0]};{b[1]},{b[0]}?overview={overview}&geometries=polyline"
    for _ in range(3):
        try:
            with urllib.request.urlopen(url, timeout=20) as r:
                j = json.load(r)
            if j.get("code") == "Ok":
                x = j["routes"][0]
                return x["geometry"], round(x["distance"]), round(x["duration"])
        except OSError:
            pass
    return None


def main():
    d = json.load(open(f"{OUT}/kawagoe.json"))
    med = json.load(open(f"{OUT}/med.json"))["list"]
    st = d["stops"]
    for g, dist in d["districts"].items():
        pairs = [(s, x) for s in dist["stops"] for x in med if x["g"] == g]
        P = lambda s, x: ((st[s]["lat"], st[s]["lon"]), (x["lat"], x["lon"]))
        with ThreadPoolExecutor(8) as ex:
            cars = list(ex.map(lambda p: route(CAR, "driving", *P(*p), "simplified"), pairs))
            near = [p for p in pairs if hav(*P(*p)) <= WALK_M]
            walks = list(ex.map(lambda p: route(FOOT, "foot", *P(*p), "full"), near))
        out = {"c": {}, "w": {}}
        for (s, x), r in zip(pairs, cars):
            if r:
                out["c"][f"{s}|h{x['id']}"] = list(r)
        for (s, x), r in zip(near, walks):
            if r:
                out["w"][f"{s}|h{x['id']}"] = list(r[:2])
        fn = f"{OUT}/door_{g}.json"
        with open(fn, "w") as f:
            json.dump(out, f, separators=(",", ":"))
        print(f"地区{g}: 車 {len(out['c'])}/{len(pairs)} 組、歩き {len(out['w'])}/{len(near)} 組", os.path.getsize(fn) // 1024, "KB")


if __name__ == "__main__":
    main()
