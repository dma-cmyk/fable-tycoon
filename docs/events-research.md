# events.json 取材・検証ノート

対象: `src/data/events.json`（初版36件 + 季節イベント18件 = 54件）
作成: 2026-11-23

## 1. 検証方法

- 全36件を `src/core/types.ts` の `GameEventDef` に合わせて作成。
- news / history の全32ソースURLを `read` ツールで実際に開き、本文（またはWikipedia APIの要約）が取得できることを確認した。
- 補助的に `curl -L -A 'Mozilla/5.0'` でHTTPステータスも記録した。AP News は curl に対して 403（ボット遮断）を返すが、`read` ツールでは記事本文を取得できている。それ以外は 200。
- 事実要約（`fact`）は風刺を入れず、本文で確認した範囲に限定した。ゲーム内の金額・確率・収益倍率はすべて創作で、各イベントの `satireNote` に明記した。
- 実在の存命人物はゲーム内テキストに登場させていない。ニュースの主体は「大手暗号資産取引所」「米国の地方銀行」「半導体大手」のような一般名詞に置き換えた。役割の戯画（関税おじさん、AI長者の天才児、中央銀行のフクロウなど）のみを使用。
- ソースの `title` はゲーム内の「元ネタ」表示に使われるため、存続企業名・存命人物名を避けた中立ラベルにしている（URLは原典のまま）。

## 2. ソース一覧とHTTP結果

| # | event id | ソース | URL | 日付 | 結果 |
|---|---|---|---|---|---|
| 1 | ai-bubble-again | AI bubble - Wikipedia | https://en.wikipedia.org/wiki/AI_bubble | 2026 | read OK / 200 |
| 2 | ai-bubble-again | AP News: 2025年の市場、関税とAIバブル懸念 | https://apnews.com/article/wall-street-stocks-bonds-crypto-tariffs-ai-539ae5ec338d19f52116e97d38300c28 | 2025-12-23 | read OK / curl 403 |
| 3 | ever-given-stuck | 2021 Suez Canal obstruction - Wikipedia | https://en.wikipedia.org/wiki/2021_Suez_Canal_obstruction | 2021-03-29 | read OK / 200 |
| 4 | meme-stock-squeeze | 2021年の株式空売り踏み上げ - Wikipedia | https://en.wikipedia.org/wiki/GameStop_short_squeeze | 2021-01-28 | read OK / 200 |
| 5 | crypto-exchange-collapse | 暗号資産取引所の破綻（2022年） - Wikipedia | https://en.wikipedia.org/wiki/Bankruptcy_of_FTX | 2022-11-11 | read OK / 200 |
| 6 | bank-run-2023 | 米地方銀行の取り付け騒ぎ（2023年） - Wikipedia | https://en.wikipedia.org/wiki/Collapse_of_Silicon_Valley_Bank | 2023-03-10 | read OK / 200 |
| 7 | tariff-war | China–United States trade war - Wikipedia | https://en.wikipedia.org/wiki/China%E2%80%93United_States_trade_war | 2025 | read OK / 200 |
| 8 | tariff-war | AP News: 2025年の追加関税の経過 | https://apnews.com/article/trump-tariffs-timeline-economy-2b10860dfdb2a5d9c3c4527136314992 | 2025-12-26 | read OK / curl 403 |
| 9 | inflation-surge | 2021–2023 inflation surge - Wikipedia | https://en.wikipedia.org/wiki/2021%E2%80%932023_inflation_surge | 2022 | read OK / 200 |
| 10 | shrinkflation | Shrinkflation - Wikipedia | https://en.wikipedia.org/wiki/Shrinkflation | 2023 | read OK / 200 |
| 11 | chip-shortage | 2020–2023 global chip shortage - Wikipedia | https://en.wikipedia.org/wiki/2020%E2%80%932023_global_chip_shortage | 2021 | read OK / 200 |
| 12 | egg-price-spike | Avian influenza outbreaks reduced egg production... - USDA ERS | https://ers.usda.gov/data-products/charts-of-note/105576 | 2023-01-11 | read OK / 200 |
| 13 | egg-price-spike | Here's why egg prices surged in 2022 - CNBC | https://www.cnbc.com/2022/12/29/why-egg-prices-have-been-rising.html | 2022-12-29 | read OK / 200 |
| 14 | negative-rates-end | Japan: BOJ hikes interest rates for the first time in 17 years - AP News | https://apnews.com/article/japan-economy-interest-rate-boj-b650a9b8a517bcf3a31c32ffdcf651c9 | 2024-03-19 | read OK / curl 403 |
| 15 | metaverse-collapse | Metaverse - Wikipedia | https://en.wikipedia.org/wiki/Metaverse | 2023 | read OK / 200 |
| 16 | rare-earth-controls | Rare-earth industry in China - Wikipedia | https://en.wikipedia.org/wiki/Rare-earth_industry_in_China | 2025 | read OK / 200 |
| 17 | rate-hike-bear | 2022 stock market decline - Wikipedia | https://en.wikipedia.org/wiki/2022_stock_market_decline | 2022 | read OK / 200 |
| 18 | tulip-mania | Tulip mania - Wikipedia | https://en.wikipedia.org/wiki/Tulip_mania | 1637 | read OK / 200 |
| 19 | south-sea-bubble | South Sea Company - Wikipedia | https://en.wikipedia.org/wiki/South_Sea_Company | 1720 | read OK / 200 |
| 20 | mississippi-bubble | John Law's Company (Mississippi Company) - Wikipedia | https://en.wikipedia.org/wiki/Mississippi_Company | 1720 | read OK / 200 |
| 21 | gold-rush-shovels | California gold rush - Wikipedia | https://en.wikipedia.org/wiki/California_gold_rush | 1848 | read OK / 200 |
| 22 | weimar-hyperinflation | Hyperinflation in the Weimar Republic - Wikipedia | https://en.wikipedia.org/wiki/Hyperinflation_in_the_Weimar_Republic | 1923 | read OK / 200 |
| 23 | crash-1929 | Wall Street crash of 1929 - Wikipedia | https://en.wikipedia.org/wiki/Wall_Street_crash_of_1929 | 1929-10-29 | read OK / 200 |
| 24 | black-monday-1987 | Black Monday (1987) - Wikipedia | https://en.wikipedia.org/wiki/Black_Monday_(1987) | 1987-10-19 | read OK / 200 |
| 25 | japan-bubble-burst | Japanese asset price bubble - Wikipedia | https://en.wikipedia.org/wiki/Japanese_asset_price_bubble | 1989 | read OK / 200 |
| 26 | dotcom-bubble | Dot-com bubble - Wikipedia | https://en.wikipedia.org/wiki/Dot-com_bubble | 2000-03-10 | read OK / 200 |
| 27 | too-big-to-fail | 2007–2008 financial crisis - Wikipedia | https://en.wikipedia.org/wiki/2007%E2%80%932008_financial_crisis | 2008-09-15 | read OK / 200 |
| 28 | too-big-to-fail | Too big to fail - Wikipedia | https://en.wikipedia.org/wiki/Too_big_to_fail | 2008 | read OK / 200 |
| 29 | dutch-east-india-company | Dutch East India Company - Wikipedia | https://en.wikipedia.org/wiki/Dutch_East_India_Company | 1602-03-20 | read OK / 200 |
| 30 | bitcoin-pizza | First commercial Bitcoin transaction - Guinness World Records | https://www.guinnessworldrecords.com/world-records/696240-first-commercial-bitcoin-transaction | 2010-05-22 | read OK / 200 |
| 31 | price-revolution | Price revolution - Wikipedia | https://en.wikipedia.org/wiki/Price_revolution | 1550 | read OK / 200 |
| 32 | zimbabwe-hyperinflation | Hyperinflation in Zimbabwe - Wikipedia | https://en.wikipedia.org/wiki/Hyperinflation_in_Zimbabwe | 2008 | read OK / 200 |

## 3. 件数と構成（初版36件時点）

- 合計: 36件
- kind: news 14 / history 14 / fable 8
- id: すべて英小文字ケバブケース、重複なし
- lines: 3〜4行（全行60文字以内、`self` 不使用、話者は narrator / npc / char のみ）
- choices: 全36件が3択（108 choice）。各 choice に `detail` と `effects` あり。
- weight: 3〜7
- once: 5件（ever-given-stuck, crypto-exchange-collapse, bank-run-2023, negative-rates-end, zimbabwe-hyperinflation）
- minYear: 13件が2、残りは指定なし（年1から抽選可）

## 4. Effect op の網羅

| op | 使用例 |
|---|---|
| cash | AIバブルの利益、関税の支払い、ピザ購入 |
| cash_pct | インフレで現金目減り、暗号資産の損失、富裕層への課税 |
| per_property | インフレ時の食品物件、卵バブルの農林物件、レアアース備蓄のエネルギー物件 |
| industry_mod | AI収益×3（3年）、海運×1.6（2年）、金融×0.7（2年） |
| price_mod | 食品物件+20%、エネルギー物件+20%、製造業物件-10% |
| sell | AIバブル時のIT物件1.5倍売却、大恐慌の全売却、バブル崩壊の投げ売り |
| card | 関税、大きすぎて潰せません、金の卵、弁護士軍団、噂話、謎の補助金、急行ゴブリン便 |
| move | 関税回避で最寄りの港へ、シンデレラの靴で目的地近くへワープ |
| skip | 半導体不足で1回休み、ハーメルン派遣で1回休み |
| piper | ハーメルン式人材派遣で他の全員に取り立て屋を押し付ける |
| gamble | メーム株、チューリップ、南海泡沫、BTC保管、ワイマール紙幣など |

使用カード: `tariff` / `bailout` / `golden_egg` / `insider` / `shield` / `subsidy` / `express2`（すべて DESIGN §2.5 のid）。

## 5. バランスと逆転要素

- 開始資金100億に対し、現金効果は -50〜+80億。yearScale による自動スケールを前提に、year 1 でも破綻しない範囲に収めた。
- `industry_mod` は 0.3〜3.0、1〜3年。複数業種にまたがる効果は同時に付与し、合計倍率が過剰にならないよう年数を短くした。
- `price_mod` は物件価格（資産価値）への恒久効果。detail では「◯◯物件の価格」と明記した。
- 逆転要素:
  - `inflation-surge` / `south-sea-bubble`: 最も裕福なプレイヤーの所持金-5%。
  - `ant-grasshopper-pension`: 最も裕福なプレイヤー-10%、最も貧しいプレイヤー+10%。
  - `momotaro-resource-deal`: 最も貧しいプレイヤー+15%。
  - `tariff-war` / `too-big-to-fail`: 関税カード・救済カードで他プレイヤーから徴収。
- リスク選択は 15〜65% の成功確率で、期待値が安全択をわずかに上回る程度に調整。CPU の `cpuWeight` も安全択を高めに設定した。

## 6. 既知の前提・ギャップ

- `cash_pct.pct` は「10 = 10%」の整数パーセント。CoreEngine に確認し、エンジン側も `delta = floor/round(cash * pct / 100)` で実装すると回答済み（2026-11-23）。
- `move.to` は型に定義された `destination_near` / `nearest_port` のみ使用（都市IDは cities.json 未確定のため避けた）。
- `sell` は対象物件を持っていない場合に効果なし。detail には「持っていれば」「持っている分」と明記した。
- `per_property` は選択時の即時精算として記述（「1件につき+10億」）。年次収益ではない。
- `price_mod` の「恒久」はゲーム終了までの価格倍率。実世界の消費者物価ではない。
- ソース日付は記事公開日または出来事の日付。Wikipedia は記事の主題年を入れた箇所がある。
- 初版の fable 8件は完全創作のため `fact` / `sources` を持たない。季節追加分は fable 14件 / news 4件。

## 7. 季節イベント追加（18件、2026-11-23）

### 7.1 構成

- 合計: 54件（初版36 + 季節18）
- kind 合計: news 18 / history 14 / fable 22
- 季節追加分: news 4 / fable 14
- `monthly: true`: 12件。months は 1〜12 をすべてカバー（各月1件）。
- `months` 付き通常（ニュースマス）イベント: 6件。`monthly` は付けていない。
- monthly の内訳: 10件が即時効果、2件が手番プレイヤーの選択（10月・1月）。
- 季節イベントの lines は 2〜3行、全行60文字以内。
- 使用効果: `cash`（who: all 主体）、`industry_mod`、`card`（全員に `express2`）、`gamble`（福袋・絵画）、`cash`（self）。

### 7.2 追加ソースとHTTP結果

| # | event id | ソース | URL | 日付 | 結果 |
|---|---|---|---|---|---|
| 1 | season-black-friday | Black Friday (shopping) - Wikipedia | https://en.wikipedia.org/wiki/Black_Friday_(shopping) | 2025 | read OK / 200 |
| 2 | season-valentine-chocolate | Valentine's Day - Wikipedia | https://en.wikipedia.org/wiki/Valentine%27s_Day | 2025 | read OK / 200 |
| 3 | season-hanami | Hanami - Wikipedia | https://en.wikipedia.org/wiki/Hanami | 2025 | read OK / 200 |
| 4 | season-heatwave | Heat wave - Wikipedia | https://en.wikipedia.org/wiki/Heat_wave | 2024 | read OK / 200 |

### 7.3 検証結果

- `node -e "JSON.parse(require('fs').readFileSync('src/data/events.json','utf8'))"` → exit 0
- イベント単体チェック: 54件、id重複なし、`monthly` 12件、全月カバー、通常の月限定6件、話者・文字数エラーなし。
- `node tools/validate-data.mjs` は events.json に関するエラーを0件で通過するが、実行時点で `cities.json`（300都市 vs 期待150）と `board.json`（未生成の都市ノード）に既存の163エラーがあり、プロセス全体は exit 1。イベント追加とは無関係の同時進行作業。委譲元の Main に報告済み。