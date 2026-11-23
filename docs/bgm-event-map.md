# BGM とイベントの対応表

`GameEventDef.bgm`（省略可）が **有効な `BgmName`** ならそれを使い、無ければ `kind` の既定値を使う。判定は `src/audio/audio.ts` の `bgmForEvent(ev)`。

| 既定 | 使うイベント |
|---|---|
| `event_news` | `kind: "news"` の全イベント |
| `event_history` | `kind: "history"` の全イベント |
| `event_fable` | `kind: "fable"` の全イベント |

`BgmName`: `title`, `lobby`, `board_a`, `board_b`, `board_c`, `event_news`, `event_history`, `event_fable`, `event_crisis`, `piper`, `yearend`, `result`。
`board_a` / `board_b` / `board_c` は年度でローテーションする想定（UI 側）。`title` / `lobby` / `yearend` / `result` は画面側。

## 上書き推奨: `event_crisis`

暴落・取り付け・ハイパーインフレなど、プレイヤーの資産が直接えぐられるイベント。`kind` に関係なく `bgm: "event_crisis"` を推奨する。

| event id | 理由 |
|---|---|
| `ai-bubble-again` | AI バブル崩壊のギャンブル |
| `crypto-exchange-collapse` | 取引所の連鎖破綻 |
| `bank-run-2023` | 銀行取り付け |
| `metaverse-collapse` | バーチャル土地の大暴落 |
| `rate-hike-bear` | 利上げによるベア市場 |
| `tulip-mania` | チューリップ球根の暴落 |
| `south-sea-bubble` | 南海泡沫事件の崩壊 |
| `mississippi-bubble` | ミシシッピ泡沫の崩壊 |
| `weimar-hyperinflation` | ハイパーインフレ |
| `crash-1929` | 1929 年大暴落 |
| `black-monday-1987` | ブラックマンデー |
| `japan-bubble-burst` | 日本のバブル崩壊 |
| `dotcom-bubble` | ドットコム泡沫の崩壊 |
| `too-big-to-fail` | 大きすぎて潰せない金融危機 |
| `zimbabwe-hyperinflation` | ジンバブエのハイパーインフレ |

## 上書き推奨: `piper`

取り立て・搾取・「笛吹き」が主役のイベント。`bgm: "piper"` を推奨する。

| event id | 理由 |
|---|---|
| `hamelin-temp-agency` | ハーメルンの笛吹きが人材派遣で搾取する話 |

必要なら `too-big-to-fail` も `piper` に寄せられるが、危機の派手さを優先して `event_crisis` を推奨。

## 異世界（天国・地獄・宇宙）

`docs/DESIGN.md` §10 の異世界にいる間は、その realm の BGM を常時使う。

| realm | BgmName |
|---|---|
| `heaven` | `realm_heaven` |
| `hell` | `realm_hell` |
| `space` | `realm_space` |

イベントパネルを開いている間は `bgmForEvent()` の結果（`event_*` / `piper`）を優先し、閉じたら realm の BGM に戻す。

## それ以外

上表に無いイベントは `kind` 既定のまま。`kind: "fable"` の童話回は `event_fable`、`kind: "history"` は `event_history`、`kind: "news"` は `event_news`。