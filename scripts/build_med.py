#!/usr/bin/env python3
"""地区 1〜3 の中の病院・診療所（医療情報ネット）→ web/data/med.json

    python3 scripts/build_med.py

入力
- ../data-exploration/data/iryo/20260601/ … 厚生労働省「医療情報ネット」のオープンデータ（2026-06-01 時点、PDL1.0）
    01-1_hospital_facility_info / 01-2_hospital_speciality_hours / 02-1_clinic_facility_info / 02-2_clinic_speciality_hours
- web/data/kawagoe.json（乗り場と地区の範囲）、web/data/rail.json（駅）
- OSRM の徒歩（OSRM_FOOT、既定 http://localhost:5056）で、病院から近くの乗り場・駅まで歩く距離を取る

地区の範囲（乗り場を囲む多角形）の中にあるものを、その地区の病院とする。
"""
import csv
import json
import math
import os
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "web", "data")
SRC = os.environ.get("MED_DIR", os.path.join(ROOT, "..", "data-exploration", "data", "iryo", "20260601"))
ASOF = "2026-06-01"
OSRM_FOOT = os.environ.get("OSRM_FOOT", "http://localhost:5056")
WD = "月火水木金土日"
ACC_M = 1000      # 病院からこの距離（歩く道のり）までの乗り場で乗り降りしてよい
STA_M = 1500      # 駅からの歩きはここまで調べる


def hav(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))


def inside(pt, poly):
    x, y = pt
    c = False
    for i in range(len(poly) - 1):
        x1, y1 = poly[i]
        x2, y2 = poly[i + 1]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            c = not c
    return c


def foot(a, b):
    url = f"{OSRM_FOOT}/route/v1/foot/{a[1]},{a[0]};{b[1]},{b[0]}?overview=full&geometries=polyline"
    for _ in range(3):
        try:
            j = json.load(urllib.request.urlopen(url, timeout=20))
            if j.get("code") == "Ok":
                r = j["routes"][0]
                return round(r["distance"]), r["geometry"]
        except OSError:
            pass
    return None, None


def read(name):
    fn = [f for f in os.listdir(SRC) if f.startswith(name) and f.endswith(".csv")][0]
    with open(os.path.join(SRC, fn), encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def merge(slots):
    out = []
    for a, b in sorted(slots):
        if out and a <= out[-1][1]:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out


def main():
    data = json.load(open(os.path.join(OUT, "kawagoe.json")))
    rail = json.load(open(os.path.join(OUT, "rail.json")))
    stops = data["stops"]
    hulls = {g: d["hull"] for g, d in data["districts"].items()}

    fac = {}
    for kind, f1, f2 in (("病院", "01-1_hospital_facility_info", "01-2_hospital_speciality_hours"),
                         ("診療所", "02-1_clinic_facility_info", "02-2_clinic_speciality_hours")):
        for r in read(f1):
            if r["都道府県コード"] != "11":
                continue
            try:
                la, lo = float(r["所在地座標（緯度）"]), float(r["所在地座標（経度）"])
            except ValueError:
                continue
            g = next((g for g, h in hulls.items() if inside((lo, la), h)), None)
            if not g:
                continue
            col = lambda k: next((r[c] for c in r if c.startswith(k)), "")
            open_w = "".join(col(f"毎週決まった曜日に休診（{w}）") or "1" for w in WD)   # 1=診療 0=休診
            wk = "".join(col(f"決まった週に休診（定期週）第{n}週（{w}）") or "1" for n in "12345" for w in WD)
            fac[r["ID"]] = {
                "id": r["ID"], "name": r["正式名称"], "kind": kind, "g": g,
                "addr": r["所在地"], "lat": round(la, 6), "lon": round(lo, 6),
                "hp": r.get("案内用ホームページアドレス", ""), "ow": open_w, "wk": wk,
                "hol": col("祝日に休診") or "1", "other": col("その他の休診日"),
                "beds": col("合計病床数"), "deps": [], "rc": {}, "sh": {},
            }
        rc, sh = {}, {}
        for r in read(f2):
            x = fac.get(r["ID"])
            if not x:
                continue
            if r["診療科目名"] and r["診療科目名"] not in x["deps"]:
                x["deps"].append(r["診療科目名"])
            for w in WD + "祝":
                a, b = r.get(f"{w}_外来受付開始時間"), r.get(f"{w}_外来受付終了時間")
                if a and b:
                    rc.setdefault((r["ID"], w), []).append((a, b))
                a, b = r.get(f"{w}_診療開始時間"), r.get(f"{w}_診療終了時間")
                if a and b:
                    sh.setdefault((r["ID"], w), []).append((a, b))
        for (i, w), v in rc.items():
            fac[i]["rc"][w] = merge(v)
        for (i, w), v in sh.items():
            fac[i]["sh"][w] = merge(v)
    # 時間の載っていないもの（企業の診療所など）は外す
    med = [x for x in fac.values() if x["rc"] or x["sh"]]
    print("地区の中の病院・診療所", len(fac), "→ 時間あり", len(med),
          {g: sum(1 for x in med if x["g"] == g) for g in hulls},
          "病院", sum(1 for x in med if x["kind"] == "病院"))

    # 近くの乗り場（同じ地区）と駅まで歩く道のり
    walk = {}
    for x in med:
        H = (x["lat"], x["lon"])
        cands = sorted(data["districts"][x["g"]]["stops"], key=lambda s: hav(H, (stops[s]["lat"], stops[s]["lon"])))[:5]
        acc = []
        for s in cands:
            S = (stops[s]["lat"], stops[s]["lon"])
            if hav(H, S) > ACC_M:
                continue
            m, enc = foot(S, H)
            if m is None:
                m, enc = round(hav(H, S) * 1.3), None
            if m <= ACC_M:
                acc.append([s, m])
                if enc:
                    walk[f"{s}|h{x['id']}"] = enc
        x["acc"] = sorted(acc, key=lambda a: a[1])[:3]
        sta = []
        for i, st in enumerate(rail["stations"]):
            if not st.get("stop"):
                continue
            S = (stops[st["stop"]]["lat"], stops[st["stop"]]["lon"])   # 駅のかわまるの乗り場から歩く
            if hav(H, S) > STA_M:
                continue
            m, enc = foot(S, H)
            if m is None or m > STA_M:
                continue
            sta.append([i, m])
            if enc:
                walk[f"{st['stop']}|h{x['id']}"] = enc
        x["sta"] = sorted(sta, key=lambda a: a[1])
    med.sort(key=lambda x: (x["g"], x["kind"] != "病院", x["name"]))
    no = [x["name"] for x in med if not x["acc"] and not x["sta"]]
    print("乗り場も駅も 1km 内に無い", len(no), no[:10])
    out = {"asof": ASOF, "list": med}
    with open(os.path.join(OUT, "med.json"), "w") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(ROOT, "work", "walk_med.json"), "w") as f:
        json.dump(walk, f, separators=(",", ":"))
    print("書き出し med.json", os.path.getsize(os.path.join(OUT, "med.json")) // 1024, "KB",
          "walk_med.json", os.path.getsize(os.path.join(ROOT, "work", "walk_med.json")) // 1024, "KB")


if __name__ == "__main__":
    main()
