# 地図アート (MAP-ART)

ワールドマップの地形・水系・国境・ラベルの制作物と、その再生成手順。座標はすべて
`src/core/geo.ts` の**ワープ済み Miller 座標**（`MAP_W = 8192`, `MAP_H = 3817`）で、
y は下方向。経度の継ぎ目は **-169°E**（ベーリング海峡・太平洋中央）。地図は横方向に
ラップする。

## 座標系とワープ

`src/core/geo.ts` は Miller 図法の生座標に、`src/data/warp.json` の変位グリッドを
バイリニアで足す:

```text
project(lon, lat) = warp(projectRaw(lon, lat))
```

`warp.json` は `{ w, h, cols, rows, dx, dy }`。`dx`/`dy` は `cols × rows`
（512 × 240）の頂点グリッド上の**整数 map 単位の変位**で、row-major。
x 頂点は `i * w / cols`（周期的、列 0 が x=0 と x=w の両方）、y 頂点は
`j * h / (rows - 1)`（上下端を含む）。サンプルは `src/core/geo.ts` と
`tools/lib/project.mjs` の `warpPoint()`。

ワープは `tools/build-warp.py` が生成する（駅密度を中心にした**楕円フィッシュアイ
レンズの合成**。各レンズは homeomorphism なので折り返しがない）。`build-map-art.py`
は `src/data/warp.json` を**読み込むだけ**で、生成はしない（`--generate-warp` は
旧実験用で既定オフ）。レンズ中心付近の線形倍率は約 2〜2.3×、全体のヤコビアンは
最小 0.425・中央値 1.0。駅密度の高いクラスタのコアが広がり、その外側はほぼ等倍。
前バージョンの緯度方向ストレッチのような強いシアーはない。

`warp.json` を変えたら `node tools/build-board.mjs` で `land.json` / `board.json` を
作り直し、このスクリプトで地形も作り直すこと。

## 生成物

| ファイル | サイズ | 内容 |
|---|---:|---|
| `public/assets/map/terrain.webp` | 4096 × 1908 RGBA, 約 0.52 MB | 中〜近ズーム用の地形。アルファ = 陸。海は完全透明（RGB は一定色） |
| `public/assets/map/terrain_lo.webp` | 1024 × 477 RGBA, 約 95 KB | 遠ズーム用。同じ絵の縮小 |
| `public/assets/map/rivers.json` | 約 138 KB | 主要河川 607 本（50m rivers, scalerank ≤ 6） |
| `public/assets/map/lakes.json` | 約 244 KB | 湖 287 ポリゴン（50m + 有名な 10m 湖 + カスピ海） |
| `public/assets/map/borders.json` | 約 61 KB | 国境の共有辺のみ（海岸線を含まない）176 本 |
| `public/assets/map/labels.json` | 約 16 KB | 海・大陸・国・川・湖のラベル 143 件 |

### terrain.webp

- 元データ: Natural Earth II shaded relief `NE2_50M_SR_W`（パブリックドメイン）。
- 逆ワープで Miller+ワープ座標の各ピクセルを緯度経度に戻し、バイリニアで再投影。
- イラスト化: メディアンフィルタ → HSV のバイオーム分類（森林/熱帯/草原/砂漠/
  ツンドラ/岩/雪/氷）→ パレットのランプ → **大きくぼかした起伏**のヒルシェード
  → 手描き風ノイズ。元画像の細かい衛星的な陰影は落とし、境界は低周波ノイズで
  揺らしている。
- アルファ: `land.json` からラスタライズ。モードは `--land-mode auto` が
  `land.json` と `warp.json` の mtime で判断する（`warped` なら直接、
  `raw` なら生 Miller でラスタライズして逆ワープでサンプル）。1〜2 px フェザー。
- 海岸には 5 px 幅の砂浜リムを内側に入れてある。海は透明なので、レンダラー側の
  海グラデーションと浅瀬ハローがそのまま見える。
- WebP quality 85 / method 6。上限 3.5 MB に対して十分小さい。

### rivers.json

```json
{ "w": 8192, "h": 3817,
  "rivers": [
    { "name": "Nile", "nameJa": "ナイル川", "rank": 1, "w": 6.0, "pts": [x0,y0,x1,y1,...] }
  ] }
```

- `pts` はワープ座標のフラット配列、0.5 単位丸め。継ぎ目を跨ぐ線は分割済み。
- `rank` は Natural Earth の `scalerank`。`w` は**描画幅のヒント（map 単位）**。
  画面幅は `max(1.0, w * zoom)` px（zoom は CSS px / map 単位）。
- `nameJa` は有名河川のみ（25 本）。
- 湖の中心線（`featurecla = Lake Centerline`）は重複を避けて除外。

### lakes.json

```json
{ "w": 8192, "h": 3817,
  "lakes": [
    { "name": "Lake Baikal", "nameJa": "バイカル湖", "rank": 0,
      "rings": [[x0,y0,x1,y1,...], ...] }
  ] }
```

- `rings[0]` が外周、`rings[1..]` が穴。フラット配列・0.5 丸め・継ぎ目分割済み。
- 面積 15 map 単位² 未満の無名湖は省略。有名湖は 10m レイヤから補完
  （琵琶湖・アラル海など）。カスピ海は 50m 湖レイヤに無いため、簡略ポリゴンを
  同梱している。
- 描画: 塗り `#4eaed6`、縁 `#2a6e96` 1 px。地形側では湖は透明なので、
  湖ポリゴンがそのまま海の色で見える。

### borders.json

```json
{ "w": 8192, "h": 3817, "lines": [[x0,y0,x1,y1,...], ...] }
```

- `world-atlas` の `countries-50m` から `topojson.mesh(a !== b)` で**共有国境のみ**を
  抽出（海岸線なし）。1.4 map 単位で簡略化、継ぎ目分割済み。
- 描画: 1 px の破線（dash 6 px / gap 5 px、画面上の長さ）、色 `rgba(86,100,78,0.45)`。
  ズームが遠いときは省略可。

### labels.json

```json
[
  { "text": "太平洋", "x": 7123.5, "y": 1350.2, "kind": "ocean",
    "size": 150, "minZoom": 0.08, "maxZoom": 1.1, "rotate": 0 }
]
```

- `kind`: `ocean` | `sea` | `continent` | `country` | `river` | `lake`。
- `size` は**map 単位のフォントサイズ**。画面 px は `size * zoom`。
- `minZoom` / `maxZoom` はカメラの zoom（CSS px / map 単位）。目安:
  - ワールド全体フィット（1280×720 で `minZoom ≈ 0.15`）: 海・大陸のみ。
  - `zoom 0.3–0.8`: 国名。
  - `zoom 0.5–2.6`: 河川・湖。
- `rotate` は度（CCW、画面上で反時計回り）。PIL の `rotate()` と同じ向き。
- 太平洋は経度ラップの両側に 2 件ある。ラベルの重なりはレンダラー側で
  宣言的に間引く（`minZoom`/`maxZoom` と簡易衝突判定）。
- 国名は Natural Earth の `NAME_JA`。位置は国ポリゴンの**pole of inaccessibility**
  （最大ポリゴンをワープ後に `polylabel`）で、重心ではない。
- 河川名は最長セグメントの 45% 地点、角度は流路方向。湖名は湖ポリゴンの
  `polylabel`。

## 推奨描画順

1. **海のグラデーション**（上が明るく下が深い青。例 `#66c6ee` → `#388ed2`）。
2. **浅瀬ハロー**: `land.json` の輪郭を 10〜20 px 外側にぼかした水色
   （例 `rgba(150,232,244,0.55)`）。
3. **地形テクスチャ**: `zoom` が小さいとき `terrain_lo.webp`、中〜近は
   `terrain.webp`。`land.json` の陸パスでクリップ（またはテクスチャのアルファ）し、
   `MAP_W × MAP_H` に引き伸ばす。継ぎ目の反対側にも ±`MAP_W` でコピーする。
4. **湖**（`lakes.json`）: 海と同じ塗り＋濃い縁。地形の上。
5. **河川**（`rivers.json`）: 幅 `max(1, w * zoom)`、丸い lineJoin。海へ注ぐ位置は
   湖/海の上に少しはみ出してよい。
6. **国境**（`borders.json`）: 細い破線。陸の上だけ。stamps より下。
7. **stamps**（森・山・都市などの既存アセット）。
8. **線路・海路・マス・コマ**（盤面）。
9. **ラベル**（`labels.json`）: 海→大陸→国→湖→川の順。白フチ（2 px）付き。
   回転ラベルは画面座標で回転。

地形は 4096 px 幅（map 8192 の 1/2 スケール）。`zoom` が 0.5 を超えるあたりから
等倍相当になり、それ以上はバイリニアで拡大される。`terrain_lo` は 0.2 以下で十分。

## 注意点

レンズワープは駅密度の高いクラスタのコアを約 2〜2.3× に拡大し、外側はほぼ等倍の
ままにする。コアの境界は滑らかだが、狭い地域で駅間隔が急に変わるため、ラベルは
`minZoom` と簡易衝突判定で間引くこと。旧・緯度ストレッチのような地中海・黒海・
カスピ海の斜めスリバーや、中東の国境フェンは解消済み。

## 再生成

```bash
# 依存（初回のみ）
uv pip install --python .tmp/venv/bin/python numpy scipy pillow shapely

# 全工程（ダウンロードは .tmp/ne にキャッシュ、冪等）
.tmp/venv/bin/python tools/build-map-art.py

# 工程を絞る
# ワープを作り直す場合だけ（通常は設計側の tools/build-warp.py が所有）
.tmp/venv/bin/python tools/build-warp.py
.tmp/venv/bin/python tools/build-map-art.py --stages terrain
.tmp/venv/bin/python tools/build-map-art.py --stages hydro,borders,labels,preview

# land.json がワープ済みであることを明示（mtime 自動判定を上書き）
.tmp/venv/bin/python tools/build-map-art.py --land-mode warped
```

- 逆ワープは 2048×954 のグリッドで 1 回だけ解き、`.tmp/map-art/inverse-*.npz`
  にキャッシュする。`warp.json` のハッシュが変わると再計算される。
- 国境メッシュは `node tools/topojson-mesh.mjs node_modules/world-atlas/countries-50m.json countries .tmp/ne/countries-50m-mesh.geojson`。
  无ければスクリプトが自動実行する（Node が必要）。
- プレビュー: `.tmp/mapart-preview.png`（2048 幅の合成）と
  `.tmp/mapart-europe.png` / `-sahara` / `-himalaya` / `-amazon` / `-japan`
  （各地域 2 倍クロップ）。プレビューは確認用で、ゲームには含めない。
- `public/assets/map/land.json` は `node tools/build-board.mjs` の生成物。
  このスクリプトは変更しない。

## データ出典

`docs/CREDITS.md` の「地図データ」を参照。Natural Earth（パブリックドメイン）と
world-atlas（ISC, TopoJSON 版 Natural Earth）を使用。