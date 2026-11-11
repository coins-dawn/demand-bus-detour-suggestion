#!/usr/bin/env python3.9
"""画面が読むデータ（web/data/*.json）を作る。

    python3.9 scripts/build_data.py            # 停留所・所要時間・予約の実績・周辺の場所
    python3.9 scripts/build_data.py --geom     # 上に加えて、停留所間の道路の形（OSRM が要る）

入力（どれも ../data-exploration/data/ の下。git 管理外）
- demand/kawagoe/gtfs/        … ODPT デマンド交通 GTFS-Flex（川越市「かわまる」）
- demand/kawagoe/demand/      … 同 需要情報（乗降の実績）
- demand/kawagoe/osrm_table.npz … 停留所間の車の所要時間（OSRM）
- /var/tmp/odc2026-osrm/kawagoe_spots.geojsonseq … OSM から抜いたカフェ・店・公園など
  （osmium tags-filter で作る。手順は README）

道路の形は OSRM の /route を停留所の組ごとに叩く（OSRM_URL、既定 http://localhost:5055）。
"""
import argparse
import collections
import concurrent.futures as cf
import csv
import datetime as dt
import json
import math
import os
import re
import sys
import urllib.request

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DX = os.path.join(ROOT, "..", "data-exploration")
DATA = os.path.join(DX, "data", "demand", "kawagoe")
OUT = os.path.join(ROOT, "web", "data")
SPOTS = os.environ.get("SPOTS", "/var/tmp/odc2026-osrm/kawagoe_spots.geojsonseq")
OSRM_URL = os.environ.get("OSRM_URL", "http://localhost:5055")

DISTRICTS = {"1": "地区1", "2": "地区2", "3": "地区3"}
MED = re.compile(r"病院|クリニック|医院|診療所|外科|内科|医療センター|メディカル")
N_DATES = 6
N_HOSP = {"1": 3, "2": 4, "3": 5}
N_ORIG = {"1": 3, "2": 3, "3": 4}
SPOT_R = 600       # 病院・乗り場からこの距離［m］以内の場所を拾う

# OSM のタグ → (種類, 表示名, まとまり)
#   rest  : 落ち着ける場所（カフェ・飲食）
#   errand: 「ついで」の用事（スーパー・本屋・薬局・郵便局・銀行）
#   sit   : 座れる場所（公園・ベンチ・図書館・公民館）
KINDS = [
    ("cafe", "カフェ", "rest", lambda t: t.get("amenity") == "cafe"),
    ("fast_food", "ファストフード", "rest", lambda t: t.get("amenity") == "fast_food"),
    ("restaurant", "飲食店", "rest", lambda t: t.get("amenity") == "restaurant"),
    ("supermarket", "スーパー", "errand", lambda t: t.get("shop") in ("supermarket", "department_store", "mall")),
    ("books", "本屋", "errand", lambda t: t.get("shop") == "books"),
    ("drug", "ドラッグストア・薬局", "errand", lambda t: t.get("shop") == "chemist" or t.get("amenity") == "pharmacy"),
    ("post", "郵便局", "errand", lambda t: t.get("amenity") == "post_office"),
    ("bank", "銀行", "errand", lambda t: t.get("amenity") == "bank"),
    ("bakery", "パン屋", "errand", lambda t: t.get("shop") == "bakery"),
    ("convenience", "コンビニ", "errand", lambda t: t.get("shop") == "convenience"),
    ("library", "図書館", "sit", lambda t: t.get("amenity") == "library"),
    ("community", "公民館・市民センター", "sit", lambda t: t.get("amenity") == "community_centre"),
    ("park", "公園", "sit", lambda t: t.get("leisure") == "park"),
    ("bench", "ベンチ", "sit", lambda t: t.get("amenity") == "bench"),
]


def hav(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))


def tosec(s):
    h, m, *r = s.split(":")
    return int(h) * 3600 + int(m) * 60 + (int(r[0]) if r else 0)


def read(path):
    with open(path, encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def hull(pts):
    """凸包（lon, lat の組）。"""
    pts = sorted(set(pts))

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lo, up = [], []
    for p in pts:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 0:
            lo.pop()
        lo.append(p)
    for p in reversed(pts):
        while len(up) >= 2 and cross(up[-2], up[-1], p) <= 0:
            up.pop()
        up.append(p)
    h = lo[:-1] + up[:-1]
    # 停留所のすぐ外側まで少し広げる
    cx = sum(p[0] for p in h) / len(h)
    cy = sum(p[1] for p in h) / len(h)
    h = [(cx + (x - cx) * 1.04, cy + (y - cy) * 1.04) for x, y in h]
    return [[round(x, 5), round(y, 5)] for x, y in h + h[:1]]


def short_name(name):
    """「エコスTAIRAYA川越霞ヶ関店/川越霞ヶ関北郵便局」→ / の前だけ。"""
    return name.split("/")[0] if name else name


def centroid(g):
    if g["type"] == "Point":
        return g["coordinates"][1], g["coordinates"][0]
    pts = []

    def walk(c):
        if isinstance(c[0], (int, float)):
            pts.append(c)
        else:
            for x in c:
                walk(x)
    walk(g["coordinates"])
    return sum(p[1] for p in pts) / len(pts), sum(p[0] for p in pts) / len(pts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--geom", action="store_true")
    a = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)

    stops = {r["stop_id"]: {"id": r["stop_id"], "name": r["stop_name"],
                            "lat": float(r["stop_lat"]), "lon": float(r["stop_lon"])}
             for r in read(f"{DATA}/gtfs/stops.txt")}
    grp = collections.defaultdict(list)
    for r in read(f"{DATA}/gtfs/location_group_stops.txt"):
        if r["stop_id"] in stops:
            grp[r["location_group_id"]].append(r["stop_id"])

    # ---------------------------------------------------------------- 実績
    rows = []
    for r in read(f"{DATA}/demand/kawagoe_demand.txt"):
        g, p, d = r["route_id"], r["pickup_stop_id"], r["drop_off_stop_id"]
        if g not in DISTRICTS or p not in stops or d not in stops or p == d:
            continue
        if p not in grp[g] or d not in grp[g]:
            continue
        t0, t1 = tosec(r["pickup_time"]), tosec(r["drop_off_time"])
        if t1 < t0:
            continue
        rows.append((r["pickup_date"].replace("-", "").replace("/", ""), g, p, d, t0, t1))
    print(f"実績 {len(rows)} 行（停留所が引けて区域内のもの）")

    per_day = collections.Counter(r[0] for r in rows)
    wd = lambda d: dt.date(int(d[:4]), int(d[4:6]), int(d[6:])).weekday()
    # 運行日は、予約がいちばん多いひと月分（カレンダーで選ぶ）。予約は [乗る, 降りる, 乗る時刻, 降りる時刻, 人数] の配列にして軽くする
    per_month = collections.Counter(r[0][:6] for r in rows)
    month = per_month.most_common(1)[0][0]
    print("いちばん混む月", month, per_month[month], "件")
    by_day = collections.defaultdict(list)
    for r in rows:
        if r[0][:6] == month:
            by_day[r[0]].append(r)
    days = []
    for d in sorted(by_day):
        reqs = collections.Counter((g, p, q, t0, t1) for (dd, g, p, q, t0, t1) in by_day[d])
        by = {g: [] for g in DISTRICTS}
        for (g, p, q, t0, t1), k in sorted(reqs.items(), key=lambda x: x[0][3]):
            by[g].append([p, q, t0, t1, k])
        days.append({"date": d, "wd": "月火水木金土日"[wd(d)], "reqs": by})
    print("運行日", len(days), days[0]["date"], "〜", days[-1]["date"])

    # ---------------------------------------------------------------- 病院と出発地
    allrows = collections.defaultdict(list)
    for r in rows:
        allrows[r[1]].append(r)
    hosp, orig = [], []
    for g in DISTRICTS:
        ismed = lambda s: bool(MED.search(stops[s]["name"])) and "歯科" not in stops[s]["name"]
        h = collections.Counter(r[3] for r in allrows[g] if ismed(r[3]))
        for s, n in h.most_common(N_HOSP[g]):
            hosp.append({"id": s, "g": g, "name": short_name(stops[s]["name"]), "n": n})
        o = collections.Counter(r[2] for r in allrows[g] if ismed(r[3]) and not ismed(r[2])
                                and not re.search(r"駅|ヤオコー|エコス|オザム|いなげや|生鮮|店|センター/|分団|倉庫|歯科|支援センター",
                                                  stops[r[2]]["name"]))
        for s, n in o.most_common(N_ORIG[g]):
            orig.append({"id": s, "g": g, "name": short_name(stops[s]["name"]), "n": n})
    print("病院", [(x["g"], x["name"], x["n"]) for x in hosp])
    print("出発地", [(x["g"], x["name"], x["n"]) for x in orig])

    # ---------------------------------------------------------------- 所要時間（OSRM）
    z = np.load(f"{DATA}/osrm_table.npz", allow_pickle=True)
    zi = {s: i for i, s in enumerate(z["stop_ids"].tolist())}
    dur = z["duration"]
    districts = {}
    for g, name in DISTRICTS.items():
        ids = sorted(grp[g])
        mat = []
        for s in ids:
            for t in ids:
                v = dur[zi[s], zi[t]] if s in zi and t in zi else np.nan
                if not np.isfinite(v):
                    v = hav((stops[s]["lat"], stops[s]["lon"]), (stops[t]["lat"], stops[t]["lon"])) / (23 / 3.6)
                mat.append(int(round(v)))
        districts[g] = {"name": name, "stops": ids, "drive": mat,
                        "hull": hull([(stops[s]["lon"], stops[s]["lat"]) for s in ids])}

    # ---------------------------------------------------------------- 周辺の場所（OSM）
    # 病院・診療所（医療情報ネット、build_med.py が作る）と、駅の乗り場のまわり。無ければ実績の多い病院の乗り場
    anchors = []
    mp, rp = os.path.join(OUT, "med.json"), os.path.join(OUT, "rail.json")
    if os.path.exists(mp):
        anchors += [(x["lat"], x["lon"]) for x in json.load(open(mp))["list"]]
    if os.path.exists(rp):
        anchors += [(stops[x["stop"]]["lat"], stops[x["stop"]]["lon"]) for x in json.load(open(rp))["stations"] if x.get("stop")]
    if not anchors:
        anchors = [(stops[h["id"]]["lat"], stops[h["id"]]["lon"]) for h in hosp]
    spots = []
    with open(SPOTS) as f:
        for line in f:
            o = json.loads(line.strip("\x1e"))
            t = o["properties"]
            for k, label, group, fn in KINDS:
                if fn(t):
                    break
            else:
                continue
            la, lo = centroid(o["geometry"])
            if min(hav((la, lo), a_) for a_ in anchors) > SPOT_R:
                continue
            nm = t.get("name") or t.get("brand") or ""
            if k == "park" and o["geometry"]["type"] == "Point" and not nm:
                continue
            spots.append({"kind": k, "label": label, "group": group, "name": nm,
                          "lat": round(la, 6), "lon": round(lo, 6),
                          "hours": t.get("opening_hours", ""), "cuisine": t.get("cuisine", "")})
    # node と way の二重登録を落とす（同じ種類・同じ名前で 40m 以内）
    uniq = []
    for s in spots:
        if any(u["kind"] == s["kind"] and u["name"] == s["name"]
               and hav((u["lat"], u["lon"]), (s["lat"], s["lon"])) < 40 for u in uniq):
            continue
        uniq.append(s)
    print("周辺の場所", len(uniq), collections.Counter(s["kind"] for s in uniq).most_common())

    used = sorted({s for g in districts.values() for s in g["stops"]})
    out = {
        "service": {"name": "かわまる", "city": "埼玉県川越市", "open": "08:00", "close": "18:00",
                    "breaks": [["11:00", "11:30"], ["15:00", "15:30"]],
                    "notice_min": 30, "cap": 7},
        "stops": {s: {"name": stops[s]["name"], "lat": stops[s]["lat"], "lon": stops[s]["lon"]} for s in used},
        "districts": districts, "hospitals": hosp, "origins": orig, "days": days, "spots": uniq,
        "built": dt.date.today().isoformat(),
    }
    with open(f"{OUT}/kawagoe.json", "w") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print("書き出し", f"{OUT}/kawagoe.json", os.path.getsize(f"{OUT}/kawagoe.json") // 1024, "KB")

    if a.geom:
        build_geom(stops, districts)


def fetch(pair, stops):
    a, b = pair
    sa, sb = stops[a], stops[b]
    url = (f"{OSRM_URL}/route/v1/driving/{sa['lon']},{sa['lat']};{sb['lon']},{sb['lat']}"
           "?overview=simplified&geometries=polyline")
    for _ in range(3):
        try:
            with urllib.request.urlopen(url, timeout=20) as r:
                j = json.load(r)
            if j.get("code") == "Ok":
                return pair, j["routes"][0]["geometry"]
        except OSError:
            pass
    return pair, None


def build_geom(stops, districts):
    """停留所の組（向きは区別しない）ごとの道路の形。エンコード済みポリライン（精度 5）。"""
    for g, dd in districts.items():
        ids = dd["stops"]
        pairs = [(a, b) for i, a in enumerate(ids) for b in ids[i + 1:]]
        geom = {}
        with cf.ThreadPoolExecutor(8) as ex:
            for (a, b), poly in ex.map(lambda p: fetch(p, stops), pairs):
                if poly:
                    geom[f"{a}|{b}"] = poly
        with open(f"{OUT}/geom_{g}.json", "w") as f:
            json.dump(geom, f, separators=(",", ":"))
        print(f"道路の形 地区{g}: {len(geom)}/{len(pairs)}",
              os.path.getsize(f"{OUT}/geom_{g}.json") // 1024, "KB")


if __name__ == "__main__":
    main()
