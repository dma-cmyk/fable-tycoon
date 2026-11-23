# グローバル寓話大富豪 〜世界童話経済すごろく〜 設計書

世界中の童話キャラクターが現実の世界地図を旅し、物件を買い漁り、風刺ニュースに振り回されながら大富豪を目指す経済すごろく。PC / スマホのブラウザで CPU・ローカル（同じ端末を回す）・オンライン（最大4人、別端末）対戦。

この文書が実装の正本。型の正本は `src/core/types.ts`、通信の正本は `src/net/protocol.ts`。

## 1. 技術構成

| 層 | 技術 | 場所 |
|---|---|---|
| ルールエンジン | 純 TypeScript。DOM・時計・乱数の外部依存なし。`(data, state, action) -> {state, fx}` | `src/core/` |
| ルーム制御 | 純 TypeScript。席・タイマー・CPU 進行・切断処理。時計とタイマーを注入 | `src/net/room.ts` |
| サーバー | Node 24 + `ws`（ローカル・LAN・自前ホスト・テスト）／Cloudflare Workers + Durable Objects（本番ホスティング）。どちらも同じ `RoomController` を使う薄いアダプタ | `server/` |
| クライアント | Vite + TypeScript。マップは Canvas 2D、HUD とダイアログは DOM/CSS | `src/render/`, `src/ui/` |
| 音 | VOICEVOX で事前生成した mp3、`manifest.json` で照合。SE/BGM は手続き生成 | `tools/gen-voice.mjs`, `src/audio/` |
| データ | JSON（AI が追加しやすい平坦な構造、`tools/validate-data.mjs` で検証） | `src/data/` |

### 1.1 オンライン前提の設計（権威サーバー方式）

- **ゲーム状態の正本はサーバーの `RoomController` だけ**。クライアントは `Action` を送り、サーバーが `step()` で検証・適用し、`fx` と新しい状態を全員に配信する。クライアントは状態を予測しない。
- **乱数はサーバー内**（`state.rng`, mulberry32）。配信時に `rng` を取り除く（`sanitizeState`）。サイコロの出目をクライアントが決めることはない。
- 不正・競合対策: 行動は「今行動すべき席の持ち主」からだけ受け付ける。各メッセージは `seq`（ルームの状態番号）を持ち、古い `seq` の行動は `stale` で拒否（二重タップ・同時操作・再送を無害化）。ルームごとに処理は直列。
- **ローカル / CPU 対戦も同じ `RoomController` をブラウザ内で動かす**（`LocalSession`）。オンラインとローカルでルール・CPU・タイマーの経路が一つ。
- 再接続: 参加時に発行する `seatToken`（推測不能な乱数）を `localStorage` に保存。再接続時にトークンで同じ席へ復帰し、`snapshot`（最新状態 + 直近ログ）を受け取る。
- 放置・切断: 人間の手番には制限時間（既定 30 秒、ルーム設定 20/30/60/無制限）。時間切れ・切断中は CPU ロジックが代行（`autoplay`）。切断後 120 秒戻らなければ席は CPU に置換（資産は維持）。明示的な退出は即 CPU 置換。ホストが抜けたら次の人間がホスト。
- コミュニケーション: スタンプ（定型リアクション）と定型チャット。サーバーで 1 人 1 秒 1 回にレート制限。自由入力は将来拡張（モデレーション前提）。
- 公開マッチング拡張: ルームに `visibility: 'private' | 'public'` を持たせ、`GET /api/rooms` が public かつ空席ありのルームを返す（初版は private のみ UI に出す）。

### 1.2 ディレクトリ

```
src/core/      types.ts, engine.ts, rng.ts, geo.ts, economy.ts, events.ts, cards.ts, piper.ts, cpu.ts, *.test.ts
src/net/       protocol.ts, room.ts, session.ts(LocalSession/OnlineSession)
src/render/    map.ts (Canvas, pan/zoom/pinch), tokens, fx animations
src/ui/        screens (title, setup, lobby, game, result), hud, dialogs
src/audio/     audio.ts (voice/sfx/bgm, volume, subtitles hook)
src/data/      cities.json, board.json(生成物), characters.json, events.json, cards.json, npcs.json
server/        node.ts, worker.ts
tools/         build-board.mjs, validate-data.mjs, gen-voice.mjs, cut-sprites.mjs
public/assets/ chars/, npcs/, landmarks/, events/, ui/, voice/, sfx/, bgm/, map/land.json
```

## 2. ルール

### 2.1 進行
- 1〜4 人。年数 1/3/5/10 年（既定 3 年）。年度は 4 月開始、毎ラウンド（全員が 1 手番）で 1 か月進む。3 月の後に**決算**。
- 開始: 所持金 100 億円、全員同じ開始都市（東京以外も可、既定はランダムな tier1 都市）。最初の目的地を抽選。
- 手番: (カード使用 0〜1 枚) → サイコロ → 移動先を選ぶ → 止まったマスの処理 → 手番終了。`skipTurns > 0` なら手番を飛ばす。
- サイコロ: 通常 1 個（1〜6）。出目ちょうどの歩数で到達できる全マスをハイライトし、プレイヤーがタップで選ぶ。移動中、直前にいたマスへは戻れない（同じ手番で同じ辺の往復禁止）。行き止まりでは折り返し可。
- **目的地を通過・到着した時点で到着扱い**（そこで移動終了）。
- 終了: 最終年の決算後、総資産（所持金 + 物件の現在価格）で順位。

### 2.2 マス
| マス | 効果（`yearScale = 1 + 0.35 × (year − 1)` 倍） |
|---|---|
| 青 | +(8〜20) 億 × yearScale |
| 赤 | −(5〜15) 億 × yearScale |
| 黄 | カード 1 枚 |
| ニュース | イベント抽選（§2.6） |
| 都市 | その都市の物件を購入できる（何件でも、所持金の範囲で） |

### 2.3 物件と経済
- 物件は `price`（億円）と `yieldPct`（年利）。決算時の収益 = `price × yieldPct/100 × 業種倍率 × 特性倍率`、**都市独占（全物件所有）で 2 倍**。
- 業種倍率: `industry_mod` イベントで一時的に変動（複数は乗算、年数で失効）。業種の購入価格は `price_mod` で恒久変動。
- 資金不足: 支払いで所持金が負になったら `sell` フェーズ。物件を売却価格 = 現在価格 × 0.7 で売る。物件が無ければ借金として繰り越し（所持金マイナス）。
- 決算レポート: 各自の収益、総資産、風刺見出し 1 行。

### 2.4 目的地と「ハーメルンの取り立て屋」
- 目的地一番乗りボーナス = `(30 + 2 × 開始時の最短歩数) × yearScale` 億。次の目的地を抽選（現在地から 20 歩以上離れた都市）。
- 一番乗りが出た瞬間、目的地から最も遠い（最短歩数）プレイヤーに**取り立て屋（笛吹き）**が憑く。
- 憑かれたプレイヤーの手番開始時に悪さを 1 つ（所持金の 5〜15% 取り立て／ランダム物件 1 件を没収売却／カード 1〜2 枚を捨てる／ガラクタ情報商材を 10 億で買わされる／1 回休み）。被害は `piper_charm` で半減。
- 憑いた手番数 12 で レベル 2（ブラック: 被害 2 倍）、24 で レベル 3（キング: 3 倍、物件まとめて没収あり）。
- **すれ違い**: 移動中に他プレイヤーのいるマスを通過・停止すると、取り立て屋はその相手へ移る（移動した人が holder の場合のみ）。

### 2.5 カード（id はエンジン実装、文言は `cards.json`）
| id | 名前 | 効果 |
|---|---|---|
| `express2` | 急行ゴブリン便 | サイコロ 2 個 |
| `express3` | 特急ドラゴン便 | サイコロ 3 個 |
| `pegasus` | ペガサス便 | 空港都市（airport）を選んでワープ |
| `carpet` | 魔法のじゅうたん | 目的地から 5〜10 歩の都市へワープ |
| `tariff` | 関税カード | 他の全員から所持金の 5% を徴収 |
| `subsidy` | 謎の補助金 | +40 億 × yearScale |
| `bailout` | 大きすぎて潰せませんカード | 自分の借金を全員で肩代わり（他のプレイヤーが等分負担） |
| `stop` | 牛歩法案 | 選んだ相手を 1 回休みにする |
| `takeover` | 敵対的買収 | 選んだ相手の物件 1 件を現在価格の 1.5 倍で強制購入 |
| `piper_pass` | 笛の押し付け | 自分の取り立て屋を選んだ相手に押し付ける |
| `golden_egg` | 金の卵 | 現在の年の物件収益の 30% を即時受け取る |
| `insider` | 噂話カード | 次の目的地を今すぐ再抽選し、自分に近い都市（20 歩以上は維持）にする |
| `shield` | 弁護士軍団 | 所持中、次の赤マス・取り立て被害・攻撃カードを 1 回無効（自動消費） |

手札上限 8（`card_shark` は 10）。超えたら `discard`。

### 2.6 イベント（`events.json`）
- ニュースマスで、重み `weight`・`minYear`・`once` を満たすものから抽選。
- `lines` を順に再生 → `choices` があれば現在プレイヤーが選ぶ（オンラインでは他の人も同じ画面を見る）→ `reply` 再生 → 効果適用。
- `kind`: `news`（現実のニュースが元）/ `history`（歴史的事実が元）/ `fable`（完全創作）。news/history は `fact`（風刺を含まない事実要約）と `sources` 必須。`satireNote` でどこが誇張・創作かを示し、ゲーム内の「元ネタ」ボタンで表示。
- 実在の存命人物は名前・似顔絵で出さず、役割の戯画（「関税おじさん」等）にする。
- 話者は `narrator` / `npc:<id>` / `char:<id>`。**`self` はイベントで使わない**（全キャラ分の音声生成を避ける）。手番キャラの反応は `Fx say` + `lineKey` で行う。

### 2.7 キャラクター特性（`PerkId`）
型定義のコメント通り。各キャラに 1 つ。強さは控えめで、選ぶ楽しさを優先。

### 2.8 CPU
- Lv1: 目的地へ近づく移動のみ、物件はランダム、カードはほぼ使わない。
- Lv2: 目的地への最短歩数を最小化する移動、利回り順で現金の 30% を残して購入、カードを状況で使用。
- Lv3: Lv2 + 独占狙い、取り立て屋のすれ違い押し付けを狙う移動、イベント選択の期待値評価。

## 3. エンジン API（`src/core/engine.ts`）

```ts
createGame(data: GameData, config: GameConfig): StepResult
step(data: GameData, state: GameState, playerId: number, action: Action): StepResult // 不正なら EngineError を throw
actorOf(state: GameState): number | null  // 今行動すべきプレイヤー（game_over なら null）
cpuDecide(data: GameData, state: GameState): Action // actorOf の席の CPU 判断（autoplay にも使う）
netWorth(data: GameData, state: GameState, playerId: number): number
currentPrice(data, state, propertyId): number
annualIncome(data, state, playerId): number
distance(data, fromNodeId, toNodeId): number // 最短歩数（BFS, キャッシュ）
sanitizeState(state): Omit<GameState, 'rng'> & { rng: 0 }
```
- 状態は**不変扱い**（`step` は新しい state を返す。`structuredClone` 可）。JSON シリアライズ可能であること（保存・配信・再接続）。
- 決定論: 同じ seed と同じ行動列なら同じ結果。

## 4. 通信（`src/net/protocol.ts` が正本）

- 接続: `wss://<host>/ws?room=<ROOMID>`。HTTP: `POST /api/rooms`（作成）、`GET /api/rooms/:id`（存在確認）、`GET /api/rooms`（public 一覧）。
- 招待 URL: `https://<host>/?room=<ROOMID>`。ルーム ID は 6 文字（紛らわしい文字を除く英数大文字）。
- ロビー: 席 4 つ（人間 / CPU / 空き）。各自キャラ選択（重複不可）、ホストが年数・制限時間・CPU を設定して開始。開始条件: 人間 1 人以上、合計 2 人以上。
- 進行: サーバーは `step` の結果 `{seq, fx, state, deadline}` を配信。クライアントは fx を順に演出し、終わったら最新 state で操作 UI を出す。CPU / autoplay の手は fx 演出時間の見積もり分だけ遅らせて適用。
- 演出の同期: サーバーは各 fx の標準演出時間（`fxDuration`）の合計を次の締切に加算。クライアントはスキップ／早送り可（自分だけ）。

## 5. 音声
- 話者ごとの規約: `docs/voicevox-licensing.md`。政治的利用を禁止する話者は**この作品では使わない**。クレジットはタイトル画面「クレジット」と README に表示。
- `tools/gen-voice.mjs`: characters.json の lines、events.json / npcs の台詞、ナレーター定型文（都市到着・目的地発表など）を収集 → VOICEVOX `audio_query` + `synthesis` → ffmpeg で mono mp3 → `public/assets/voice/<hash>.mp3` と `manifest.json`（キー = `fnv1a(voiceKey + '\n' + text)`、voiceKey は `char:<id>` / `npc:<id>` / `narrator`）。生成済みはスキップ（差分生成）。
- クライアント: 台詞は字幕を常に表示。音声があれば再生、無ければ字幕のみ。ボリューム（マスター / 声 / BGM / SE）、台詞スキップ、自動送り。

## 6. AI による拡張手順（`docs/CONTENT.md` に詳細）
都市追加 = `cities.json` に追記 → `npm run board` → `npm run validate`。キャラ追加 = 画像 + characters.json → `npm run voice`。イベント追加 = events.json（出典付き）→ validate → voice。

## 7. キャラクター（48 人、`characters.json` の id）

| シート | id（左上から右へ、4×2） |
|---|---|
| 1 日本 | momotaro 桃太郎, momo_dog 犬, momo_monkey 猿, momo_pheasant キジ, aka_oni 赤鬼, kintaro 金太郎, urashima 浦島太郎, kaguya かぐや姫 |
| 2 アジア・中東・アフリカ | issun 一寸法師, bunbuku ぶんぶく茶釜のたぬき, wukong 孫悟空, sinbad シンドバッド, aladdin アラジン, lamp_genie ランプの魔人, ali_baba アリババ, anansi アナンシ（蜘蛛） |
| 3 英国ほか | alice アリス, white_rabbit 白ウサギ, cheshire チェシャ猫, heart_queen ハートの女王, mad_hatter 帽子屋, naked_emperor 裸の王様, pinocchio ピノキオ, puss 長靴をはいた猫 |
| 4 グリム | red_hood 赤ずきん, wolf オオカミ, granny おばあさん, gretel グレーテル, candy_witch お菓子の家の魔女, rumpel ルンペルシュティルツキン, jack ジャック（豆の木）, giant 豆の木の巨人 |
| 5 姫と悪役 | cinderella シンデレラ, stepmother 継母, stepsister 義姉, snow_white 白雪姫, evil_queen 魔女のお妃, dwarf 小人, mermaid 人魚姫, ugly_duckling みにくいアヒルの子 |
| 6 寓話 | ant アリ, grasshopper キリギリス, golden_goose 金の卵のガチョウ, baba_yaga バーバ・ヤーガ, tortoise カメ（ウサギとカメ）, thumbelina おやゆび姫, robin_hood ロビン・フッド, kappa 河童 |

NPC（`npcs.json`）: `piper1` ハーメルンの取り立て屋, `piper2` ブラック取り立て屋, `piper3` キング取り立て屋, `owl_anchor` フクロウキャスター, `tariff_bulldog` 関税おじさん（ブルドッグ）, `banker_pig` 大きすぎて潰せない銀行ブタ, `tech_kid` AI長者の天才児（ロボット）, `midas` ミダス王。

デザイン方針: 全員オリジナルの統一デフォルメ（2.5 頭身、太い輪郭、明るい配色）。ディズニー等の既存映像作品の衣装・配色の特徴を避ける（例: 人魚姫は赤髪にしない、ピノキオは赤い短パン＋黄色帽子の組合せにしない、孫悟空は特定漫画の髪型にしない）。
