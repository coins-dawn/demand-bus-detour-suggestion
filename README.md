# tsuin-demand

かわまる 通院寄り道シミュレーション（試作）。静的サイト（HTML + JavaScript）で、サーバーの処理はありません。

## 動かし方

```sh
# 1. データを作る（../data-exploration にデマンド交通データ・OSRM の所要時間表・医療情報ネットがある前提）
python3.9 scripts/build_data.py            # web/data/kawagoe.json（はじめの 1 回。地区の範囲を作る）
python3 scripts/build_rail.py              # web/data/rail.json（鉄道。ODPT_CHALLENGE_TOKEN が要る）
python3 scripts/build_med.py               # web/data/med.json（病院・診療所。OSRM の徒歩が要る）
python3.9 scripts/build_data.py --geom     # もう一度: 寄り道の場所を病院・駅のまわりから拾う ＋ 停留所間の道路の形（OSRM が要る）
python3 scripts/build_walk.py              # web/data/walk.json（歩く道の形と道のり。OSRM の徒歩が要る）

# 2. 配信して開く
python3 scripts/serve.py                     # http://localhost:8004/（ポートは引数で変えられる）
```

### 入力データの用意

- デマンド交通データ: `../data-exploration/scripts/demand_fetch.py`
- 車の所要時間表（`osrm_table.npz`）: `../data-exploration/scripts/osrm_matrix.py`
- OSRM のグラフ: `../data-exploration/scripts/osrm_build.py kawagoe`（`/var/tmp/odc2026-osrm` に作る）
- 道路の形を取るときは OSRM を立てておく:
  `docker run -d --rm -p 5055:5000 -v /var/tmp/odc2026-osrm:/data osrm/osrm-backend osrm-routed --algorithm mld /data/kawagoe.osrm`
- 歩く道を取るときは OSRM の徒歩のグラフを作って立てておく:
  ```sh
  docker run --rm -v /var/tmp/odc2026-osrm-foot:/data osrm/osrm-backend osrm-extract -p /opt/foot.lua /data/kawagoe.osm.pbf
  docker run --rm -v /var/tmp/odc2026-osrm-foot:/data osrm/osrm-backend osrm-partition /data/kawagoe.osrm
  docker run --rm -v /var/tmp/odc2026-osrm-foot:/data osrm/osrm-backend osrm-customize /data/kawagoe.osrm
  docker run -d --rm -p 5056:5000 -v /var/tmp/odc2026-osrm-foot:/data osrm/osrm-backend osrm-routed --algorithm mld /data/kawagoe.osrm
  ```
- 医療情報ネット: 厚生労働省のページから 2026-06-01 時点の `01-1`・`01-2`・`02-1`・`02-2` を取り、
  `../data-exploration/data/iryo/20260601/` に展開する（`MED_DIR` で変えられる）
- 鉄道の線の形（OSM）:
  ```sh
  osmium tags-filter -O -o rail.pbf kawagoe.osm.pbf w/railway=rail r/route=train
  osmium export -O -f geojsonseq -o /var/tmp/odc2026-rail/rail.geojsonseq rail.pbf
  ```
- 周辺の場所（OSM）:
  ```sh
  osmium tags-filter -O -o kawagoe_spots.pbf kawagoe.osm.pbf \
    nwr/amenity=cafe,fast_food,restaurant,library,community_centre,bench,pharmacy,post_office,bank \
    nwr/shop=supermarket,books,convenience,department_store,mall,chemist,bakery nwr/leisure=park
  osmium export -O -f geojsonseq -o kawagoe_spots.geojsonseq kawagoe_spots.pbf
  ```

## 公開

`.github/workflows/pages.yml` が main への push で `web/` を GitHub Pages に出す（Settings → Pages → Source を「GitHub Actions」にしておく）。

## 作り

- `web/engine.js` … 配車の計算（車 1 台・挿入法）。ブラウザでも Node でも動く
- `web/planner.js` … デマンドバスの便をさがす部品
- `web/trip.js` … 片道の経路の候補（デマンドバス・電車・歩き・寄り道・タクシー）
- `web/app.js` … 画面と地図（MapLibre GL JS ＋ OpenFreeMap）
- `web/about.html` … このサービスについて（出典・ライセンスの表示）
- `scripts/build_data.py` … 画面が読むデータを作る
- `scripts/build_rail.py` … 鉄道の時刻・駅・線の形を作る
- `scripts/build_med.py` … 病院・診療所を作る
- `scripts/build_walk.py` … 歩く道の形と道のりを作る
- `scripts/shot.py` … 画面を撮る（Playwright）
- `tests/` … `node tests/replay.test.js`、`node tests/trip.test.js`

## データの出典・ライセンス

- デマンド交通データ（GTFS-Flex・需要情報）: 公共交通オープンデータセンター、CC BY 4.0。
  事業者・提供元は画面の下に表示している
- 鉄道の時刻表（JR川越線・東武東上線）: 公共交通オープンデータセンター、公共交通オープンデータチャレンジ限定ライセンス
- 病院・診療所: 厚生労働省「医療情報ネット」オープンデータ（2026-06-01 時点）、公共データ利用規約（第1.0版）
- 周辺の場所・道路・鉄道の線の形: © OpenStreetMap contributors（ODbL）
- 背景地図: OpenFreeMap（© OpenMapTiles、© OpenStreetMap contributors）
- アイコン: Material Design Icons（Iconify 経由、Apache License 2.0）

`web/data/` は上のデータから作った派生データで、GitHub Pages で配るために git に入れている。
`web/data/rail.json` は鉄道の時刻表から、この画面で使う 10 駅の発着時刻だけを抜き出したもの（チャレンジ限定ライセンス。利用は 2027-03-12 まで）。
