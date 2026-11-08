#!/usr/bin/env python3
"""鉄道（JR 川越線・東武東上線）のデータを作る → web/data/rail.json

    python3 scripts/build_rail.py

- 列車の時刻: ODPT の odpt:TrainTimetable（チャレンジ専用トークン ODPT_CHALLENGE_TOKEN が要る。
  ワークスペースの .env か環境変数から読む）。取ったものは work/rail_tt.json に置いて使い回す
- 線の形: OpenStreetMap（/var/tmp/odc2026-rail/rail.geojsonseq。作り方は README）

かわまるの乗り場がある駅と、乗り換えに使う川越駅だけを残す。
"""
import heapq
import json
import math
import os
import re
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WORK = os.path.join(ROOT, "work")
OUT = os.path.join(ROOT, "web", "data")
RAIL_OSM = os.environ.get("RAIL_OSM", "/var/tmp/odc2026-rail/rail.geojsonseq")

RAILWAYS = {
    "Tobu.Tojo": {"key": "TJ", "name": "東武東上線", "color": "#1f4e9e"},
    "JR-East.SaikyoKawagoe": {"key": "JK", "name": "JR川越線", "color": "#0e8f6f"},
    "JR-East.Kawagoe": {"key": "JK", "name": "JR川越線", "color": "#0e8f6f"},
}
CALENDARS = {"Weekday": "W", "SaturdayHoliday": "H"}

# 駅 → かわまるの乗り場（地区）。川越駅は乗り換えにだけ使う
STATIONS = {
    "JR-East.SaikyoKawagoe.MinamiFuruya": {"stop": "432", "g": "1"},
    "Tobu.Tojo.Shingashi": {"stop": "278", "g": "2"},
    "Tobu.Tojo.KamiFukuoka": {"stop": "283", "g": "2"},
    "Tobu.Tojo.Kasumigaseki": {"stop": "060", "g": "3"},
    "Tobu.Tojo.Tsurugashima": {"stop": "059", "g": "3"},
    "JR-East.Kawagoe.Matoba": {"stop": "057", "g": "3"},
    "JR-East.Kawagoe.Kasahata": {"stop": "056", "g": "3"},
    "JR-East.Kawagoe.NishiKawagoe": {"stop": "058", "g": "3"},
    "JR-East.Kawagoe.Kawagoe": {"stop": None, "g": None},
    "Tobu.Tojo.Kawagoe": {"stop": None, "g": None},
}
# 川越駅の JR の 2 つの線は同じ駅として扱う
SAME = {"JR-East.SaikyoKawagoe.Kawagoe": "JR-East.Kawagoe.Kawagoe"}
TYPES = {"Local": "普通", "SemiExpress": "準急", "Express": "急行", "RapidExpress": "快速急行",
         "Rapid": "快速", "CommuterRapid": "通勤快速", "TJLiner": "TJライナー",
         "KawagoeLimitedExpress": "川越特急", "LimitedExpress": "特急"}


def token():
    t = os.environ.get("ODPT_CHALLENGE_TOKEN")
    if t:
        return t
    for p in (os.path.join(ROOT, ".env"), os.path.join(ROOT, "..", "..", ".env")):
        if os.path.exists(p):
            for line in open(p):
                if line.startswith("ODPT_CHALLENGE_TOKEN="):
                    return line.split("=", 1)[1].strip()
    raise SystemExit("ODPT_CHALLENGE_TOKEN がない")


def fetch():
    cache = os.path.join(WORK, "rail_tt.json")
    if os.path.exists(cache):
        return json.load(open(cache))
    tk = token()
    get = lambda q: json.load(urllib.request.urlopen(
        f"https://api-challenge.odpt.org/api/v4/{q}&acl:consumerKey={tk}", timeout=180))
    out = {}
    for rw in RAILWAYS:
        for cal in CALENDARS:
            out[f"{rw}|{cal}"] = get(f"odpt:TrainTimetable?odpt:railway=odpt.Railway:{rw}&odpt:calendar=odpt.Calendar:{cal}")
        out[f"station|{rw}"] = get(f"odpt:Station?odpt:railway=odpt.Railway:{rw}")
    os.makedirs(WORK, exist_ok=True)
    json.dump(out, open(cache, "w"), ensure_ascii=False)
    return out


def sec(s):
    h, m = map(int, s.split(":"))
    return h * 3600 + m * 60


def main():
    tt = fetch()
    title = {}
    geo = {}
    for rw in RAILWAYS:
        for s in tt[f"station|{rw}"]:
            sid = s["owl:sameAs"].replace("odpt.Station:", "")
            title[sid] = s["dc:title"]
            geo[sid] = (s.get("geo:lat"), s.get("geo:long"))
    # 行き先の名前（ほかの線の駅もある）
    for f in ("stations_kanto_by_operator_challenge.json", "stations_kanto_by_operator.json"):
        p = os.path.join(ROOT, "..", "data-exploration", "data", "odpt", f)
        if os.path.exists(p):
            for op, xs in json.load(open(p)).items():
                for s in xs if isinstance(xs, list) else []:
                    sid = (s.get("owl:sameAs") or s.get("id") or "").replace("odpt.Station:", "")
                    nm = s.get("dc:title") or s.get("title") or s.get("name")
                    if sid and nm and sid not in title:
                        title[sid] = nm

    keys = list(STATIONS)
    idx = {k: i for i, k in enumerate(keys)}
    stations = []
    for k in keys:
        rw = ".".join(k.split(".")[:2])
        la, lo = geo.get(k, (None, None))
        stations.append({"id": k, "name": title.get(k, k.split(".")[-1]) + "駅", "line": RAILWAYS[rw]["key"],
                         "lat": la, "lon": lo, **STATIONS[k]})

    trains = {c: [] for c in CALENDARS.values()}
    for rw, info in RAILWAYS.items():
        for cal, c in CALENDARS.items():
            for x in tt[f"{rw}|{cal}"]:
                seq = []
                for o in x["odpt:trainTimetableObject"]:
                    st = (o.get("odpt:departureStation") or o.get("odpt:arrivalStation")).replace("odpt.Station:", "")
                    st = SAME.get(st, st)
                    if st not in idx:
                        continue
                    a = o.get("odpt:arrivalTime") or o.get("odpt:departureTime")
                    d = o.get("odpt:departureTime") or o.get("odpt:arrivalTime")
                    if not a:   # 通過
                        continue
                    ta, td = sec(a), sec(d)
                    if seq and ta < seq[-1][2] - 6 * 3600:   # 日付をまたぐ
                        ta += 86400
                    if seq and td < ta:
                        td += 86400
                    seq.append([idx[st], ta, td])
                if len(seq) < 2:
                    continue
                if seq[0][2] > 20 * 3600 or seq[-1][1] < 7 * 3600:   # かわまるの運行時間（8〜18 時）に関係しない便
                    continue
                dest = x.get("odpt:destinationStation") or [""]
                dest = dest[-1].replace("odpt.Station:", "")
                tp = x.get("odpt:trainType", "").split(".")[-1]
                trains[c].append({"l": info["key"], "k": TYPES.get(tp, "普通"),
                                  "to": re.sub(r"<.*?>", "", title.get(dest, dest.split(".")[-1])), "s": seq})
    for c in trains:
        trains[c].sort(key=lambda t: t["s"][0][2])

    # 線の形（OSM の名前つきの線路）。地区のまわりだけ
    lines = {"TJ": [], "JK": []}
    graph_extra = {"TJ": [], "JK": []}   # 名前のない線路（駅の構内など）。形はたどるのに使うだけで、描かない
    box = (139.36, 35.84, 139.56, 35.97)
    name2key = {"東武東上線": "TJ", "川越線": "JK"}
    if os.path.exists(RAIL_OSM):
        for line in open(RAIL_OSM):
            o = json.loads(line.strip("\x1e"))
            p, g = o["properties"], o["geometry"]
            k = name2key.get(p.get("name"))
            extra = None
            if not k and not p.get("name") and p.get("operator") in ("東武鉄道", "東日本旅客鉄道") and p.get("railway") == "rail":
                extra = {"東武鉄道": "TJ", "東日本旅客鉄道": "JK"}[p["operator"]]
            if (not k and not extra) or g["type"] != "LineString":
                continue
            cs = [[round(x, 5), round(y, 5)] for x, y in g["coordinates"]]
            if not any(box[0] <= x <= box[2] and box[1] <= y <= box[3] for x, y in cs):
                continue
            if k:
                lines[k].append(cs)
            else:
                graph_extra[extra].append(cs)
    # 駅と駅のあいだの線路の形（同じ線の駅の組ごとに、線路をたどる最短の道）
    paths = {}
    for k, segs in lines.items():
        adj = {}
        for cs in segs + graph_extra[k]:
            for a, b in zip(cs, cs[1:]):
                a, b = tuple(a), tuple(b)
                d = math.hypot((a[0] - b[0]) * math.cos(math.radians(35.9)), a[1] - b[1])
                adj.setdefault(a, []).append((b, d))
                adj.setdefault(b, []).append((a, d))
        nodes = list(adj)
        if not nodes:
            continue
        near = lambda st: min(nodes, key=lambda n: (n[0] - st["lon"]) ** 2 + (n[1] - st["lat"]) ** 2)
        ids = [i for i, st in enumerate(stations) if st["line"] == k]
        for i in ids:
            src = near(stations[i])
            dist, prev, pq = {src: 0}, {}, [(0, src)]
            while pq:
                d, u = heapq.heappop(pq)
                if d > dist[u]:
                    continue
                for v, w in adj[u]:
                    if d + w < dist.get(v, 1e9):
                        dist[v] = d + w
                        prev[v] = u
                        heapq.heappush(pq, (d + w, v))
            for j in ids:
                if j <= i:
                    continue
                t = near(stations[j])
                if t not in dist:
                    continue
                path = [t]
                while path[-1] != src:
                    path.append(prev[path[-1]])
                path.reverse()
                paths[f"{i}|{j}"] = [list(p) for p in path]
    print("駅のあいだの形", len(paths), "組")
    meta = {v["key"]: {"name": v["name"], "color": v["color"]} for v in RAILWAYS.values()}
    out = {"asof": tt["Tobu.Tojo|Weekday"][0].get("dct:issued"), "lines": meta, "stations": stations,
           "trains": trains, "shapes": lines, "paths": paths,
           "transfer": {"same": 180, "walk": [[idx["JR-East.Kawagoe.Kawagoe"], idx["Tobu.Tojo.Kawagoe"], 420]]}}
    with open(os.path.join(OUT, "rail.json"), "w") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print("駅", len(stations), "列車", {c: len(v) for c, v in trains.items()},
          "線", {k: len(v) for k, v in lines.items()}, os.path.getsize(os.path.join(OUT, "rail.json")) // 1024, "KB")


if __name__ == "__main__":
    main()
