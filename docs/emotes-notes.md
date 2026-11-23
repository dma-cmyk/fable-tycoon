# emotes.json メモ

`src/data/emotes.json` は `EmoteDef[]`（`src/core/types.ts`）。14 個の共通エモート + 48 人分の固有エモート 1 つずつ、計 62 件。

## 構成

| category | 件数 | anim | cooldownMs | targeted |
|---|---:|---|---:|---|
| emotion | 4 (joy, angry, sad, laugh) | jump / angry / cry / laugh | 3000 | false |
| action | 5 (dance, dogeza, money_rain, flex, thanks) | dance / dogeza / money_rain / flex / heart | 6000 | false |
| taunt | 2 (taunt, hurry) | taunt / sleep | 8000 | false |
| poke | 3 (throw_tomato, throw_pie, bill_slap) | throw | 10000 | true + projectile |
| unique | 48 (`u_<characterId>`) | spotlight / throw / money_rain / dance / flex / taunt / cry / sleep / heart | 12000 | 20 件が true（41.7%） |

- `targeted === (anim === 'throw')`。targeted は `projectile` と `hitLines` を必ず持つ。
- 固有の targeted 20 件: momotaro 🍡 / issun 🪡 / bunbuku 🫖 / wukong 🪵 / sinbad ⚓ / aladdin 🪔 / white_rabbit ⏰ / heart_queen 👑 / wolf 💨 / gretel 🍬 / candy_witch 🍭 / jack 🫘 / giant 🪨 / cinderella 👠 / snow_white 🍎 / evil_queen 🍎 / dwarf ⛏️ / baba_yaga 🏠 / robin_hood 🏹 / kappa 🥒
- 固有の lines は `{ [ownerId]: 台詞, default: 同じ台詞 }`。所有者以外は使えないため default は実質フォールバック。

## 台詞と音声

- 全 14 共通エモートに 48 人分の `lines` + `default`、poke 3 種に 48 人分の `hitLines` + `default` がある。
- 文字数上限: `lines` 22 文字、`hitLines` 18 文字（コードポイント）。実際の最大は lines 15・hitLines 14。
- VOICEVOX の読み間違いを避けるため、常用外の漢字は一部かな書き（撒く→まく、藁→わら、騙す→だます、凹む→へこむ、頬→ほお など）。
- 音声キーは `voicekey.ts` の `char:<characterId>`。発動者の台詞は発動キャラ、`hitLines` は当てられた側のキャラで生成する。
- 48 人分が揃っているため `default` は通常再生されない。音声生成を軽くしたい場合は `default` キーを除外してよい。
- 発話行数（default 除く）: 14×48 + 3×48 + 48 + 48×20 = **1824**。