# CONTENT — データ追加・変更ガイド

このプロジェクトのデータは `src/data/*.json` に置く。型の正本は `src/core/types.ts`、ルールの正本は
`docs/DESIGN.md`。**この2つと `src/core/geo.ts` / `src/net/protocol.ts` は勝手に変えない**。
データを変えたら、必ず生成と検証を通す。

## コマンド

```bash
npm run board      # node tools/build-board.mjs : board.json と land.json を生成
npm run validate   # node tools/validate-data.mjs : 全データを検証（エラーで exit 1）
npm run voice      # node tools/gen-voice.mjs : 台詞の音声を差分生成
npm run typecheck  # tsc --noEmit
npm run test       # vitest
npm run dev        # Vite 開発サーバー
```

`board.json` と `public/assets/map/land.json` は**生成物**。手で編集しない。
都市を追加・変更したら `npm run board` の後に `npm run validate`。

## データファイル

| ファイル | 内容 | 生成 |
|---|---|---|
| `src/data/cities.json` | 150都市と物件 | 手書き |
| `src/data/board.json` | 盤面ノード・辺 | `npm run board` |
| `public/assets/map/land.json` | 投影済み陸地ポリゴン | `npm run board` |
| `src/data/characters.json` | 48キャラクター | 手書き |
| `src/data/npcs.json` | NPC 8人 + narrator | 手書き |
| `src/data/events.json` | ニュース・歴史・寓話イベント | 手書き |
| `src/data/cards.json` | カード13種の文言・重み | 手書き |

---

## 1. 都市を追加する

`src/data/cities.json` は `City[]`。**必ず150件**。追加するなら、同じ数を保つため既存の1件を置き換えるか、
DESIGN 側の都市数合意を更新する。`id` は kebab-case ASCII で一意。

```json
{
  "id": "new-city",
  "nameJa": "新都市",
  "nameEn": "New City",
  "country": "JP",
  "countryJa": "日本",
  "region": "east_asia",
  "lat": 35.00,
  "lon": 139.00,
  "tier": 2,
  "port": true,
  "airport": true,
  "landmark": "tokyo_tower",
  "blurb": "一句ブラックユーモアの紹介。",
  "properties": [
    { "id": "new-city-1", "name": "物件名", "industry": "tourism", "price": 120, "yieldPct": 12 }
  ]
}
```

### 都市フィールド

- `region`: `east_asia` `southeast_asia` `south_asia` `middle_east` `europe`
  `russia_central_asia` `africa` `north_america` `central_america` `south_america` `oceania`
- `tier`: 1=世界都市（約25）、2=主要都市、3=地方都市。tier 1 は物件価格帯を高めにする。
- `lat` / `lon`: 実座標。小数2桁まで。`lat` は -56〜80（地図の表示範囲）。
- `port`: 海運の辺を作れる港町か。`airport`: ペガサス便の目的地になれるか。
- `blurb`: 日本語1文。改行なし。表向きかわいく、裏に風刺。
- `properties`: 2〜6件。`id` は `<cityId>-<連番>`。連番は1から。

### 物件の価格・利回り

| 業種 | 価格（億円） | 利回り |
|---|---|---|
| `agri` `food` | 1〜30 | 30〜80% |
| `tourism` `industry` `shipping` `media` | 20〜300 | 8〜25% |
| `finance` `tech` `energy` | 200〜3000 | 2〜10% |

バリデーターは範囲外を warning にする（エラーにはしない）。tier 1 は `finance` / `tech` / `energy` の
高額物件を入れて「金持ちの街」にする。物件名は都市の産業・名物をもじった風刺名にする。

### ランドマーク

`landmark` は次の24種のみ。各1回だけ、指定都市に置く。

| id | 都市 |
|---|---|
| `big_ben` | london |
| `eiffel` | paris |
| `brandenburg` | berlin |
| `colosseum` | rome |
| `kremlin` | moscow |
| `statue_liberty` | new-york |
| `golden_gate` | san-francisco |
| `sugarloaf` | rio-de-janeiro |
| `pyramids` | cairo |
| `taj_mahal` | agra または delhi |
| `tokyo_tower` | tokyo |
| `great_wall` | beijing |
| `angkor_wat` | siem-reap または phnom-penh |
| `machu_picchu` | cusco または lima |
| `chichen_itza` | cancun または mexico-city |
| `table_mountain` | cape-town |
| `harbour_bridge` | sydney |
| `windmill` | amsterdam |
| `osaka_castle` | osaka |
| `acropolis` | athens |
| `cn_tower` | toronto |
| `gyeongbokgung` | seoul |
| `petra` | amman |
| `kilimanjaro` | nairobi または arusha |

### 都市追加の手順

1. `cities.json` を編集（150件・id・物件id・landmark を確認）。
2. `npm run board`。
   - 出力の `total nodes` が **900以上**、`components: 1`、`sea squares on land: 0`、
     `rail squares on water: 0` を確認。
   - 新しい都市が孤立していないか、`components` とログを見る。
3. `npm run validate`。エラー0を確認。
4. 可能なら `.tmp/board-preview.png` のようなプレビューで、海路が陸を横切っていないか目視する。

`build-board.mjs` は **cities.json から都市ノードを生成する**。board.json に古い都市IDが残っていたら、
必ず `npm run board` で作り直す。`validate-data.mjs` は「board に cities.json にない都市」
「cities.json の都市が board にない」をエラーにする。

---

## 2. 盤面生成のルール（`tools/build-board.mjs`）

- 投影は `src/core/geo.ts` の Miller 図法のコピー。**数式を変えるときは両方同時に**変える。
- 都市を Delaunay 三角形分割し、日付変更線をまたぐ辺のために ±MAP_W のコピーを入れる。
- 各辺を 0.5° 間隔でサンプリングし、次で分類する:
  - **rail**: ほぼ陸。短い川・海峡は1サンプルまで。`london-paris`（英仏トンネル）、
    `istanbul-belgrade`（ボスポラス）、`copenhagen-stockholm`（エーレスンド）などはホワイトリスト。
  - **sea**: 両端が港で、ほぼ海。内陸の陸地は小さな島だけ。港のアプローチは両端で許容。
  - どちらでもない辺は落とす。長すぎる辺・短すぎる辺・交差する辺・都市を貫通する辺も落とす。
- グラフが分断されたら、港同士の海路や陸路で最短の有効な辺を追加する。
- 主要回廊（日本—韓国、英—仏、大西洋2〜3、太平洋2、インド洋1〜2、オセアニア—東南アジア1〜2）は
  保護され、混雑する海路は予算とハブ次数で間引く。
- 各辺に中間マスを `clamp(round(length / 35) - 1, 1, 7)` 個置く（密度調整のため35）。
  種類は blue 42% / red 22% / yellow 18% / news 18% 目安。news は隣接させない。
- 海の辺の中間マスは必ず水上。陸の辺の中間マスは陸上に寄せる。
- 出力: `src/data/board.json`（`Board`）と `public/assets/map/land.json`
  （`{ w, h, polygons }`、各 ring は `[x0,y0,x1,y1,...]` の平坦配列、0.5単位に丸め、600KB未満）。

---

## 3. キャラクターを追加する

`characters.json` は `Character[]`。DESIGN.md §7 の **48人**が正本。追加・削除は DESIGN と相談する。

```json
{
  "id": "new_char",
  "nameJa": "新キャラ",
  "origin": "出典の物語",
  "originRegion": "日本",
  "role": "trickster",
  "sprite": "assets/chars/new_char.png",
  "color": "#4a90d9",
  "personality": "一言の性格（風刺可）。",
  "perk": "lucky",
  "voice": { "speaker": 50, "speed": 1.0, "pitch": 0, "intonation": 1.0 },
  "lines": {
    "select": "選択時。",
    "turn": "手番開始。",
    "buy": "購入時。",
    "monopoly": "独占時。",
    "goal": "目的地一番乗り。",
    "blue": "青マス。",
    "red": "赤マス。",
    "card": "カード使用。",
    "piper_get": "笛吹きに憑かれた。",
    "piper_hit": "笛吹きの被害。",
    "win": "優勝。",
    "lose": "最下位。"
  }
}
```

- `role`: `hero` `sidekick` `villain` `animal` `monster` `royal` `trickster`
- `perk`: `none` `agri_boost` `tech_boost` `tourism_boost` `finance_boost` `sailor`
  `lucky` `tough` `card_shark` `haggler` `pickpocket` `piper_charm`
- `sprite` は `public/assets/chars/<id>.png` に置く。画像が無いと validate は warning、
  ゲームではフォールバック表示。
- `lines` は12キーすべて非空。**変数を含む台詞は禁止**（事前音声生成のため固定文）。
- 色は `#rrggbb`。既存キャラと被らない程度に。
- 追加後: `npm run voice` → `npm run validate`。

---

## 4. NPC を追加する

`npcs.json` は `NpcDef[]`。id は DESIGN の
`piper1` `piper2` `piper3` `owl_anchor` `tariff_bulldog` `banker_pig` `tech_kid` `midas`
と `narrator` のみ。`nameJa`・`voice` は必須、`sprite` は任意。

```json
{ "id": "owl_anchor", "nameJa": "フクロウキャスター", "sprite": "assets/npcs/owl_anchor.png",
  "voice": { "speaker": 20, "speed": 1.05, "pitch": 0, "intonation": 1.0 } }
```

`narrator` はナレーション用。イベントの話者 `narrator` はこの定義がなくても動くが、
音声を出すなら定義する。追加後 `npm run voice` → `npm run validate`。

---

## 5. イベントを追加する

`events.json` は `GameEventDef[]`。

```json
{
  "id": "new-event",
  "title": "見出し",
  "kind": "news",
  "image": "assets/events/new-event.png",
  "fact": "風刺を含まない事実要約。",
  "sources": [{ "title": "出典", "url": "https://...", "date": "2026" }],
  "satireNote": "どこを誇張・創作したか。",
  "weight": 5,
  "minYear": 1,
  "once": false,
  "lines": [
    { "speaker": "narrator", "text": "導入。" },
    { "speaker": "npc:owl_anchor", "text": "コメント。" }
  ],
  "choices": [
    {
      "label": "乗る！",
      "detail": "効果の説明。",
      "effects": [
        { "op": "industry_mod", "industry": "tech", "mult": 2, "years": 3, "label": "AIブーム" }
      ],
      "reply": [{ "speaker": "narrator", "text": "結果。" }],
      "cpuWeight": 1
    }
  ]
}
```

- `kind`: `news`（現実のニュース）/ `history`（歴史的事実）/ `fable`（完全創作）。
- `news` / `history` は `fact` と `sources`（1件以上）が必須。`fable` は不要。
- `satireNote` は全イベント必須。ゲーム内「元ネタ」で表示される。
- `lines` は必須。`choices` があれば選択後に `reply`、無ければ `effects` を即適用。
- 話者は `narrator` / `npc:<id>` / `char:<id>` のみ。**`self` はイベントで禁止**
  （手番キャラの反応は `Fx say` + `lineKey` で行う）。
- `char:`・`npc:` は実在する id のみ。`card` 効果の card id も実在する13種のみ。
- `weight` > 0、`minYear` は1〜10、`once` は boolean。

### Effect の op

| op | 必須フィールド | 意味 |
|---|---|---|
| `cash` | `who`, `amount`, `scale?` | 億円の増減（yearScale 適用） |
| `cash_pct` | `who`, `pct` | 所持金の%増減 |
| `per_property` | `who`, `industry` または `any`, `perProperty`, `scale?` | 物件1件あたりの増減 |
| `industry_mod` | `industry`, `mult`, `years`, `label` | 業種の収益倍率（年数） |
| `price_mod` | `industry`, `mult` | 業種の購入価格を恒久変更 |
| `sell` | `who`, `industry` または `any`, `count`, `priceMult` | 強制売却 |
| `card` | `who`, `card`, `count?` | カード付与 |
| `move` | `who`, `to` | `destination_near` / `random_city` / `nearest_port` / cityId |
| `skip` | `who`, `turns` | 休み |
| `piper` | `to` | 取り立て屋を押し付ける |
| `gamble` | `chance`, `win`, `lose` | 確率分岐（入れ子可） |

`who`: `self` `all` `others` `richest` `poorest` `random_other`。
`industry`: `agri` `food` `tourism` `industry` `tech` `finance` `energy` `shipping` `media`。
追加後: `npm run validate` → `npm run voice`。

---

## 6. カード

`cards.json` は `CardDef[]`。id は DESIGN §2.5 の13種のみ:

`express2` `express3` `pegasus` `carpet` `tariff` `subsidy` `bailout` `stop`
`takeover` `piper_pass` `golden_egg` `insider` `shield`

```json
{ "id": "express2", "name": "急行ゴブリン便", "desc": "サイコロを2個振る。",
  "kind": "move", "weight": 12, "needsTarget": "player" }
```

- `kind`: `move` `money` `attack` `defense` `special`
- `needsTarget`: `player` / `city` / `airport`（任意）
- 新しい id を足してもエンジンは動かない。**カード追加はエンジン実装とセット**。
- 文言・重み・対象だけを変えるなら `cards.json` のみでよい。

---

## 7. 音声

`npm run voice` は VOICEVOX で台詞を生成し、`public/assets/voice/<hash>.mp3` と
`manifest.json` を作る。キーは `fnv1a(voiceKey + "\n" + text)`。

- 対象: characters の `lines`、events の `lines` / `choices[].reply`、npcs の台詞、
  ナレーター定型文。
- **台詞は固定文**。変数・プレイヤー名・数値を混ぜない（事前生成が壊れる）。
- 生成済みはスキップされる。文言を変えると新しいキーになる。
- 声の利用規約は `docs/voicevox-licensing.md`。政治的利用を禁じる話者は使わない。
- 生成後はゲーム内で字幕と音声の両方を確認する。

---

## 8. 検証（`tools/validate-data.mjs`）

```bash
npm run validate
```

- ファイルが無い → **warning**。
- 内容が不正 → **error**。1件でもあれば exit 1。
- 主なチェック:
  - cities: 150件、id一意、物件idの接頭辞と連番、landmarkの許可リストと都市、地域の網羅、
    Africa 12以上 / 南米10以上 / オセアニア5以上、座標2桁、業種・価格・利回り。
  - board: ノードid一意、cityIdが cities に存在、全都市にノード、座標範囲と0.1丸め、
    辺の両端存在、重複辺なし、連結、news隣接なし、900ノード以上。
  - characters: 48 id、12 LineKey、voice、perk、role、spriteパス。
  - npcs: 許可id、voice。
  - events: kind/fact/sources、speaker（self禁止）、char/npc参照、Effectのopとフィールド、
    card参照、industry、choices/effects。
  - cards: 13 id、kind、weight。
  - land.json: 形式、偶数長リング、閉路、seamジャンプなし、600KB未満。
- 他担当のアセット未生成などは warning で通る。エラーは自分のファイルなら直す。

---

## 9. 文章・風刺のルール

- ゲーム内テキストは日本語。表向きはかわいい童話、裏に政治・金融・歴史のブラック風刺。
- **実在の存命人物を名指し・似顔絵で出さない**。役割の戯画（関税おじさん等）にする。
- 民族・宗教へのヘイトは禁止。風刺するのは制度・金・政策・バブル。
- news/history は `fact` と `sources` を付け、`satireNote` で誇張を明示する。
- 都市の blurb は1文。物件名は地域の名物・産業をもじる。
- 下ネタより「制度のズルさ」を笑う。子供も読める語彙で。

---

## 10. 変更前チェックリスト

1. 正本（types.ts / geo.ts / DESIGN.md / protocol.ts）を勝手に変えていない。
2. id は一意、物件idは `<cityId>-<n>`、landmark は表の都市のみ。
3. `npm run board` が成功し、`total nodes >= 900`、`components: 1`、
   `sea squares on land: 0`、`rail squares on water: 0`。
4. `npm run validate` が exit 0（warning は内容を確認）。
5. 海路が大陸を横切っていない、鉄路が外洋を横切っていない（プレビュー目視）。
6. 台詞を変えたら `npm run voice`。固定文か確認。
7. 実在人物・ヘイト・出典なしニュースがない。