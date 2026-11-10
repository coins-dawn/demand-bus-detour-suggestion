#!/usr/bin/env python3
"""かわまるの地区 1〜3 と市中心部のエリア → web/data/area.json（GeoJSON）

    python3 scripts/build_area.py      （build_data.py のあとに。shapely と pyshp が要る）

川越市の紹介ページの区域図（市中心部を除き、市内を 3 つの地区に分ける）を、
国勢調査 2020 の小地域（町丁・字）境界で組み立てる。
- 町丁の中にかわまるの乗り場があれば、いちばん多い地区
- 乗り場が無い町丁は、いちばん近い乗り場の地区。ただし川越駅のまわりで、近くに乗り場が無いものは「市中心部」
入力: ../data-exploration/data/estat/r2ka11.shp（e-Stat 統計GIS、埼玉県の小地域。国勢調査 2020）
"""
import collections
import json
import math
import os

import shapefile
from shapely.geometry import Point, mapping, shape
from shapely.ops import unary_union

ROOT = os.path.join(os.path.dirname(__file__), "..")
OUT = f"{ROOT}/web/data"
SHP = os.environ.get("AREA_SHP", f"{ROOT}/../data-exploration/data/estat/r2ka11.shp")
STATION = (139.4826, 35.9073)    # JR・東武 川越駅
CENTER_R = 3000                  # 市中心部を探す範囲（川越駅から）
CENTER_GAP = 350                 # 乗り場がこれより遠い町丁は市中心部


def dist_m(a, b):
    return math.hypot((a[0] - b[0]) * 111320 * math.cos(math.radians(35.9)), (a[1] - b[1]) * 110540)


def main():
    d = json.load(open(f"{OUT}/kawagoe.json"))
    stops = [(g, (d["stops"][s]["lon"], d["stops"][s]["lat"])) for g, x in d["districts"].items() for s in x["stops"]]
    r = shapefile.Reader(SHP, encoding="cp932")
    polys = []
    for sr in r.iterShapeRecords():
        rec = sr.record.as_dict()
        if rec["PREF"] != "11" or rec["CITY"] != "201":
            continue
        g = shape(sr.shape.__geo_interface__)
        if not g.is_valid:
            g = g.buffer(0)
        polys.append((rec["S_NAME"], g))
    print("川越市の小地域", len(polys))
    by = collections.defaultdict(list)
    names = collections.defaultdict(list)
    for nm, g in polys:
        inside = collections.Counter(dg for dg, p in stops if g.contains(Point(p)))
        if inside:
            k = inside.most_common(1)[0][0]
        else:
            c = g.representative_point()
            near = min(stops, key=lambda x: g.distance(Point(x[1])))
            gap = dist_m((c.x, c.y), near[1])
            k = "c" if dist_m((c.x, c.y), STATION) <= CENTER_R and gap > CENTER_GAP else near[0]
        by[k].append((nm, g))
    # 市中心部は 1 つのまとまり（いちばん大きいかたまり）だけ。離れた町丁は、いちばん近い乗り場の地区へもどす
    core = max(getattr(unary_union([g for _, g in by["c"]]), "geoms", [unary_union([g for _, g in by["c"]])]), key=lambda x: x.area)
    keep = []
    for nm, g in by["c"]:
        if g.buffer(0.0001).intersects(core):
            keep.append((nm, g))
        else:
            near = min(stops, key=lambda x: g.distance(Point(x[1])))
            by[near[0]].append((nm, g))
    by["c"] = keep
    for k, v in by.items():
        names[k] = [nm for nm, _ in v]
        by[k] = [g for _, g in v]
    feats = []
    for k in ("1", "2", "3", "c"):
        u = unary_union(by[k]).buffer(0.00005).buffer(-0.00005).simplify(0.00015)
        # 小さな穴は埋める
        from shapely.geometry import Polygon, MultiPolygon
        fill = lambda p: Polygon(p.exterior, [h for h in p.interiors if Polygon(h).area > 2e-6])
        u = MultiPolygon([fill(p) for p in u.geoms]) if u.geom_type == "MultiPolygon" else fill(u)
        feats.append({"type": "Feature", "properties": {"g": k}, "geometry": mapping(u)})
        print(k, len(by[k]), "町丁", u.geom_type, round(u.area * 1e4, 2))
    print("市中心部の町丁", sorted(set(names["c"]))[:40])
    with open(f"{OUT}/area.json", "w") as f:
        json.dump({"type": "FeatureCollection", "features": feats}, f, separators=(",", ":"))
    print("書き出し area.json", os.path.getsize(f"{OUT}/area.json") // 1024, "KB")


if __name__ == "__main__":
    main()
