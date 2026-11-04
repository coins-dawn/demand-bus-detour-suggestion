# tsuin-demand

デマンド交通の予約の画面（試作）。静的サイト（HTML + JavaScript）で、サーバーの処理はありません。

## 動かし方

```sh
# 1. データを作る（../data-exploration にデマンド交通データと OSRM の所要時間表がある前提）
python3.9 scripts/build_data.py            # web/data/kawagoe.json
python3.9 scripts/build_data.py --geom     # ＋ 停留所間の道路の形 web/data/geom_*.json（OSRM が要る）

# 2. 配信して開く
cd web && python3 -m http.server 8006       # http://localhost:8006/
```

URL に `?t=09:00` を付けると、その時刻から再生します。`&paused` を付けると止まった状態で開きます。

### 入力データの用意

- デマンド交通データ: `../data-exploration/scripts/demand_fetch.py`
- 車の所要時間表（`osrm_table.npz`）: `../data-exploration/scripts/osrm_matrix.py`
- OSRM のグラフ: `../data-exploration/scripts/osrm_build.py kawagoe`（`/var/tmp/odc2026-osrm` に作る）
- 道路の形を取るときは OSRM を立てておく:
  `docker run -d --rm -p 5055:5000 -v /var/tmp/odc2026-osrm:/data osrm/osrm-backend osrm-routed --algorithm mld /data/kawagoe.osrm`
- 周辺の場所（OSM）:
  ```sh
  osmium tags-filter -O -o kawagoe_spots.pbf kawagoe.osm.pbf \
    nwr/amenity=cafe,fast_food,restaurant,library,community_centre,bench,pharmacy,post_office,bank \
    nwr/shop=supermarket,books,convenience,department_store,mall,chemist,bakery nwr/leisure=park
  osmium export -O -f geojsonseq -o kawagoe_spots.geojsonseq kawagoe_spots.pbf
  ```

## 作り

- `web/engine.js` … 配車の計算（車 1 台・挿入法）。ブラウザでも Node でも動く
- `web/planner.js` … 便の候補を作る
- `web/app.js` … 画面と地図（MapLibre GL JS ＋ 地理院タイル）
- `scripts/build_data.py` … 画面が読むデータを作る
- `scripts/shot.py` … 画面を撮る（Playwright）
- `tests/` … `node tests/replay.test.js`、`node tests/planner.test.js`

## データの出典・ライセンス

- デマンド交通データ（GTFS-Flex・需要情報）: 公共交通オープンデータセンター、CC BY 4.0。
  事業者・提供元は画面の下に表示している
- 周辺の場所・道路: © OpenStreetMap contributors（ODbL）
- 地図: 国土地理院 地理院タイル
- アイコン: Material Design Icons（Iconify 経由、Apache License 2.0）

`web/data/` はデータの規約に合わせて git に入れていない。
