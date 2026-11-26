# UI / 描画 / 音 仕様

見た目の基準: `art/concept.png`（コンセプト画像）。明るい空色の海、緑の大陸、白い太縁の吹き出しと濃紺の縁取りパネル、金色の主ボタン、丸ゴシック（M PLUS Rounded 1c、`@fontsource/m-plus-rounded-1c` を同梱）。

## 1. 画面

| 画面 | 内容 |
|---|---|
| タイトル | キーアート `assets/ui/keyart.webp` 全面、CSS 文字ロゴ「グローバル寓話大富豪」+ サブ「世界童話経済すごろく」、ボタン: ひとりで（CPU 対戦）/ みんなで（同じ端末）/ オンライン（ルーム作成・参加）/ 遊び方 / 設定 / クレジット。最初のタップで音声アンロック。URL に `?room=XXXXXX` があればオンライン参加画面へ直行 |
| セットアップ（ローカル） | 4 席: 人間 / CPU(Lv1-3) / なし、名前、キャラ選択（48 人グリッド、出典・性格・特性を表示、選択時に `select` ボイス）、年数 1/3/5/10 |
| オンラインロビー | ルーム ID 大表示、招待 URL コピー / Web Share API、QR は不要。席一覧（接続状態●、ホスト王冠、CPU 設定はホストのみ）、キャラ選択（他人が選択済みは不可）、設定（年数・制限時間）、開始ボタン（ホストのみ、条件を満たすまで無効）。ルーム参加フォーム（ID 入力） |
| ゲーム | §2 |
| 決算 | 年度ごとの収益・総資産ランキング、風刺見出し、資産推移グラフ（Canvas 折れ線） |
| 結果 | 最終順位、優勝キャラの `win` ボイス、最下位の `lose` ボイス、資産推移、タイトルへ / もう一度 |

## 2. ゲーム画面レイアウト（コンセプト画像準拠）

PC（横長 ≥ 900px）:
- 全面: マップ Canvas（`MapView`）。
- 上部中央: 「3年目 4月」「ターン 7/36」、目的地パネル（都市名 + 現在の手番プレイヤーからの残り歩数）。
- 右上: メニュー / 設定 / ヘルプ。
- 左: 順位パネル（顔アイコン、名前、総資産、取り立て屋が憑いていればアイコン、オンラインなら接続状態、手番の人を強調）。
- 左下: 手番キャラの大きな立ち絵 + 吹き出し（直近の台詞）。
- 下中央: 主ボタン「サイコロをふる」（自分が操作できる番だけ）。その右にアイコンボタン列: カード / 物件 / 目的地 / 世界地図 / 固有技 / その他 / チャット。
- 下中央（コマンドバーの上）: 自分のコマが画面外のとき「📍 自分のコマへ」ボタン（自分の立ち絵 + `Home / C` キーヒント）。他のプレイヤーの手番では、手番のコマも画面外なら「🎯 手番のコマへ」も上に出す。メッセージ窓・移動先リスト・コマンドバー・所持金パネルの実測位置から `bottom` を計算するので重ならない。
- 画面端: 自分のコマが画面外のとき、最寄りの端に自分の顔と方向矢印のインジケーター。タップで自分のコマへ。別世界にいるときは盤面右上に顔チップ。
- 右下: 自分（または手番プレイヤー）の所持金・年間収益見込み・総資産。
- イベント: 右側の大パネル（赤帯見出し「世界ニュースイベント！」、挿絵、台詞、選択肢ボタン、「元ネタ」ボタンで fact / sources / satireNote を表示）。
- オンライン: タイマー（手番の残り秒、円形ゲージ）。
- コミュニケーション（DESIGN.md §8、ローカル / オンライン共通）: 画面右下寄りに「💬」チャットボタンと「😆」エモートボタン（常時表示、手番外も押せる）。エモートパレットはタブ（喜怒哀楽 / アクション / 煽り / ちょっかい / 固有技）でボタン各 44px 以上、クールダウン中は円形ゲージでグレーアウト。ちょっかいは押した後に相手の顔アイコンを選ぶ。チャットは下からせり上がる小パネル（ログ + 入力欄 + 定型文チップ「よろしく！」「ナイス！」「やられた〜」「それはズルい！」「GG！」等）。各プレイヤー行の「…」メニューにミュート（チャット / エモート / ボイス）と通報。受信したチャットはマップ上の駒の頭上と順位パネル横に吹き出し、エモートは駒のアニメ + 頭上アイコン + 台詞の吹き出し + ボイス。ローカル（ホットシート）では手番プレイヤーとしてエモートを出す。

スマホ（< 900px または縦向き）:
- 上部 1 行に年月・手番・目的地・残り歩数。順位はアイコンだけの横並び（タップで詳細）。
- 360px 幅でも 4 チップが 1 行に収まるよう、狭幅では依頼チップを「📜 あと12」に縮める（都市名・報酬は非表示）。
- 下部に主ボタンとアイコンボタン列（親指で届く位置、各 44px 以上）。
- 立ち絵は小さく、吹き出しは画面下部の字幕バー。
- ダイアログは全画面シート。
- 縦向き・横向きどちらでも遊べること（縦向きでマップが狭くなっても操作できる）。

### 世界地図画面（`地図` ボタン / キーボード 5）
プレイ画面とは別の全画面で、下部 HUD・字幕を隠す（`.map-screen-open`）。
- ヘッダー「🌍 世界地図」+ 手番情報、`✕ プレイ画面に戻る`（大きな金ボタン）、`⤢ 全体`、操作ヒント。
- 地上 / 天国 / 地獄 / 宇宙のタブ（世界ごとの人数バッジ）。
- 都市検索（漢字・かな・英語・国名・駅 ID、8 件まで）。
- 表示レイヤー: 自分の物件 / ライバルの物件 / 都市効果 / 寄り道依頼 / 目的地 / プレイヤーの位置。
- プレイヤー一覧（顔・名前・いる世界・手番表示、タップでそのコマへジャンプ）。
- 都市タップで読み取り専用の都市シート（購入ボタンなし）。
- 閉じる: `✕ プレイ画面に戻る` / Esc / 戻るジェスチャー（`history.pushState` + `popstate`）。開いた瞬間の中心・ズーム・世界を保存し、閉じるときに厳密に復元する。
- 実装は同じ `MapAssets` を共有する 2 つ目の `MapView`。プレイ側のカメラ・fx の影響を受けず、閉じると `destroy()` でキャンバスを解放する。ターンは開いたままでも進み、自分の操作フェーズが始まると自動で閉じて自分のコマへ戻り、トースト「あなたの番です」を出す。

## 3. 操作
- マップ: ドラッグでパン、ホイール / ピンチでズーム（プレイ画面は全体地図しきい値より上の下限でクランプ）、横方向は無限ループ。ダブルタップでズームイン。**プレイ画面が全体地図に切り替わることはない**（全体表示は世界地図画面の役割）。
- 移動先選択: 到達可能マスを脈動ハイライト + ゴースト経路。ピン/一覧のタップは**選択のみ**（経路を太く表示し、セーフエリア内へフィット）。確定は下段の「ここへ移動」= `confirmMoveOption` だけ。同じピンの再タップでも確定しない。空マップのタップは選択解除で `onSelect(null)`。PC はホバーで経路プレビュー。
- 都市タップ: 都市情報シート（物件一覧、所有者、価格、収益率、独占状況、ランドマーク画像）。
- 物件購入フェーズ: 都市シートが購入モードで開き、各物件に「買う」、下に「購入を終える」。
- カメラ復帰: fx（一番乗り・目的地ルーレット・依頼・都市効果・買収）が都市へ寄ったあとは、手番のコマへ自動で戻る。ユーザーがドラッグ / ホイールしたら自動復帰はキャンセル。自分の手番開始時と移動先リスト表示時にコマが見えていなければ戻す。
- キーボード（PC）: Space/Enter = 主ボタン、Esc = ダイアログ / 世界地図画面を閉じる、1〜6 = コマンド（5 = 世界地図、6 = 固有技）、Home / C = 自分のコマへ、イベント中は 1〜3 = 選択肢。

## 4. fx 再生（`src/ui/fxPlayer.ts`）
- `ServerMsg.update` の fx を順に await 再生してから `state` を採用（HUD を最新に）。再生中に次の update が来たらキュー。キューが 2 件以上たまったら 2 倍速。
- 設定「演出速度」1x / 2x / 4x、「台詞の自動送り」、タップ / クリックで現在の fx をスキップ（自分の画面だけ）。
- `say`: 立ち絵 + 吹き出し + 字幕、`Audio.playVoice` の終了または `FX_MS` の時間の長い方を待つ（スキップ可）。
- `dice`: 3D 風の CSS サイコロ回転 → 出目。`move`: `MapView.animateMove`。`cash`: 対象プレイヤーの頭上に「+12億」浮遊文字 + コイン SE。`event_open`: イベントパネル。`year_end`: 決算画面。`game_over`: 結果画面。
- `snapshot`: アニメなしで即座に反映。

## 5. モジュール API

### `src/render/map.ts` — `MapView`
```ts
export interface MapAssets { land: LandJson; chars: Map<string, HTMLImageElement>; landmarks: Map<string, HTMLImageElement>; npcs?: Map<string, HTMLImageElement>; vehicles?: Map<string, HTMLImageElement>; joy?: Map<string, HTMLImageElement>; sad?: Map<string, HTMLImageElement>; realms?: Map<RealmId, HTMLImageElement>; stamps?: Map<string, HTMLImageElement>; terrain?: HTMLImageElement; terrainLo?: HTMLImageElement; mapArt?: MapArtData; }
export interface MoveOptionHooks { onSelect?: (nodeId: string | null) => void; onConfirm?: (nodeId: string) => void; numbers?: number[]; }
export interface SafeArea { top: number; right: number; bottom: number; left: number; }
export interface MapLabelObstacle { x: number; y: number; w: number; h: number; } // CSS px, canvas relative
export interface MoveProgress { playerId: number; path: string[]; stepIndex: number; remaining: number; vehicle: string | null; nextNodeId: string | null; }
export interface MoveKindChip { color: string; symbol: string; label: string; }
export function moveKindChip(kind: SquareKind): MoveKindChip;
export class MapView {
  constructor(canvas: HTMLCanvasElement, data: GameData, assets: MapAssets);
  setState(state: PublicState): void; // tokens, ownership tint on city badges, destination flag, piper on holder
  setMoveOptions(options: MoveOption[] | null, onPickOrHooks: ((nodeId: string) => void) | MoveOptionHooks | null): void;
  /** 一覧から同じ選択状態にする（選択のみ。経路をセーフエリア内にフィットする）。 */
  selectMoveOption(nodeId: string, opts?: { frame?: boolean }): void; // frame:false = 選択だけ（カメラは動かさない）
  /** UI の確定ボタンからのみ呼ぶ。nodeId 省略時は選択中。 */
  confirmMoveOption(nodeId?: string): void;
  /** HUD の「残りマス」表示用。移動中以外は null。 */
  getMoveProgress(): MoveProgress | null;
  /** HUD/パネルが覆う領域。カメラのフィット・フォーカス・フォローは残りの盤面領域基準になる。 */
  setSafeArea(area: Partial<SafeArea>): void;
  /** HUD/モーダル/操作パネルの矩形。都市名・地形名ラベルはこの領域を避ける。 */
  setLabelObstacles(rects: ReadonlyArray<MapLabelObstacle>): void;
  animateMove(playerId: number, path: string[], msPerStep: number, opts?: { dice?: number }): Promise<void>; // dice 1=列車 / 2=急行 / 3=超特急
  warp(playerId: number, nodeId: string, via?: 'plane'|'rocket'|'carpet'|'event'|'tornado'|'realm'): Promise<void>;
  focusNode(nodeId: string, opts?: { zoom?: number; ms?: number }): Promise<void>;
  fitWorld(ms?: number): Promise<void>; // 盤面領域に世界一周をフィット。プレイ画面では最小ズーム下限（全体地図しきい値より上）でクランプされ、世界地図画面では全体表示になる
  follow(playerId: number | null): void;
  floatText(nodeId: string, text: string, color: string): void;
  onCityTap(cb: (cityId: string) => void): void;
  resize(): void; // also called internally on ResizeObserver
  destroy(): void;
  /** Cosmetic emote on the player's token (and projectile to target). Resolves when the animation ends (~1.5–2.5 s). */
  playEmote(playerId: number, def: EmoteDef, targetPlayerId: number | null): Promise<void>;
  /** Speech bubble above a token (chat or emote line), auto-hides after ms. */
  bubble(playerId: number, text: string, ms?: number): void;
  /** 表情差分。neutral/null で通常に戻る。 */
  setMood(playerId: number, mood: 'joy' | 'sad' | 'neutral' | null, ms?: number): void;
  /** イベント演出。nodeId 版と playerId 版のオーバーロード。 */
  celebrate(nodeId: string, kind: 'buy' | 'monopoly' | 'goal' | 'bad'): void;
  celebrate(playerId: number, kind?: 'buy' | 'monopoly' | 'goal' | 'bad'): void;
  shake(intensity?: number): void;
  /** 環境アニメーション（波・雲・交通・呼吸など）を止める。操作/移動演出は残る。 */
  setReducedMotion(on: boolean): void;
  /** 地上と異世界ビューを切り替える。follow/setState でも自動切替。 */
  setView(realm: RealmId | 'world'): void;
  /** 全体地図の見た目を使うか。プレイ画面は false（ズーム下限も 1.24 倍へ上がる）、世界地図画面は true。 */
  setOverviewEnabled(on: boolean): void;
  /** setState が手番プレイヤーの世界へ自動で切り替えるか。世界地図画面は false。 */
  setAutoViewFollow(on: boolean): void;
  /** ネイティブ描画レイヤー（目的地・依頼・都市効果・トークン）を隠す。世界地図画面のトグル用。 */
  setHiddenLayers(hidden: Partial<{ destination: boolean; errand: boolean; cityMods: boolean; players: boolean }>): void;
  /** プレイカメラの中心・ズーム・世界を厳密に保存する（オーバーレイ表示前）。 */
  captureCameraState(): MapCameraState;
  /** captureCameraState のスナップショットへ復帰する。進行中の tween は停止する。 */
  restoreCameraState(state: MapCameraState): void;
  /** 各ビューにいるプレイヤー数（UI バッジ用）。 */
  readonly realmCounts: Record<RealmId | 'world', number>;
  screenPositionOf(playerId: number): { x: number; y: number } | null;
  screenPositionOfNode(nodeId: string): { x: number; y: number; visible?: boolean } | null;
  isNodeVisible(nodeId: string): boolean;
  /** 季節。1秒クロスフェード。 */
  setMonth(month: number): void;
  /** 外部キャンバスにワールドミニマップを描画。タップでその地点へジャンプ。 */
  setMiniMap(el: HTMLCanvasElement | null): void;
  /** QA 用: 有効 DPR・予算・最大確保キャンバスを返す。 */
  getCanvasBudgetInfo(): { dpr: number; budget: CanvasBudget; largest: CanvasAllocation | null };
  /** 全体地図の見た目中は true（世界地図画面のみ）。プレイ画面は常に false。 */
  isOverviewMode(): boolean;
  /** 目的地（地上）/最寄りの異世界出口（天国・地獄・宇宙）までの残りホップ数。到達不能は null。
   *  目標は表示中のビューではなく手番プレイヤーのいる盤面で決まる（異世界で地上マップを表示中でも出口距離）。 */
  getMoveOptionDistanceInfo(nodeId: string): { hops: number; target: 'destination' | 'exit' } | null;
  getMoveOptionDistance(nodeId: string): number | null; // getMoveOptionDistanceInfo()?.hops
  /** QA 用: 直近フレームで描いたラベル矩形とアンカー（ラベルが動かないことの検証用）。 */
  getLabelLayoutSnapshot(): { zoom: number; layoutMs: { art: number; city: number; total: number }; city: Array<{ id: string; rect: { x: number; y: number; w: number; h: number }; anchor: { x: number; y: number } }>; art: Array<{ id: string; rect: { x: number; y: number; w: number; h: number }; anchor: { x: number; y: number } }> };
}
// 立ち上げ時に canvas 要素へ `__fableMapView` を定義する（QA/スクリーンショット用のハンドル）。
// MapArtLabel は省略可能な `kana`、City は省略可能な `nameKana` を持つ（漢字名のみ）。地図ラベルは両方をふりがなとして描く。
// UI の候補チップは moveKindChip(node.kind) の color/symbol/label を地図ピンと共有する。
// 空マップのタップは onSelect(null)。ピン/一覧の再タップは選択のみで、onConfirm は明示的な confirmMoveOption だけ。
```
- 描画: devicePixelRatio 対応（モバイル/WebKit は実効 DPR ≤1.5、デスクトップは ≤2。さらに 1 キャンバスあたり最大辺 4096/8192・面積 16MP/32MP にクランプ）、変更が無ければ再描画しない（ダーティフラグ）、アニメ中のみ rAF。ランド/季節フェード/海背景/ミニマップは予算内ラスタへ縮小し、ズームバケット切替やフェード終了時に旧 backing store を 0×0 で解放する。`canvasBudget.ts` が最大確保キャンバスを debug ログし、`getCanvasBudgetInfo()` で QA から確認できる。ズームに応じた詳細度（概要: 世界一周を横1回・主要都市ドット・現在地/目的地マーカー、通常: マス・駅・ラベル）、画面外カリング。移動中は補間位置に乗り物+乗員を描き、次のマスを金リングで強調する。移動候補はUI一覧と同じ番号・色・記号のピン（44px 判定）で表示し、ピン/一覧のタップは選択のみ、確定は `confirmMoveOption` だけ。
- 行き先の強調: 候補表示中は盤面全体を57%暗くし、現在地・候補マス・経路コリドーだけを穴あき（非ゼロ巻き数）で残すスポットライト。各候補マスは種類色のグロー+リング（=光っているマス）で示し、番号は「選択中」「おすすめ」「候補8件以下」のときだけ大きなピン、それ以外（9件以上）はリング内の小さな番号チップで、重なる番号は描かない（ピンは絶対に重ねない）。経路は選択中（未選択ならおすすめ）だけ太い金+シェブロン、他は細い薄線。おすすめは目的地までの残りホップ数が最小の候補（同数は駅優先）で、金の「おすすめ」旗+目的地方向の矢印を付ける。異世界（天国・地獄・宇宙）では目的地ではなく**最寄りの出口（`portal`）** までのホップ数で並べ、UI は `getMoveOptionDistanceInfo()` の `target: 'exit'` を見て「出口まで」と表記する。`getRecommendedMoveOption()` / `getMoveOptionDistance(nodeId)` は従来どおり動く。カメラは `setSafeArea` と `setLabelObstacles` から求めた空き領域（`freeBoardBox`）に現在地+全候補を余白付き（ピン/リング分を含む）でフィットし、最小ズームで入り切らない場合は現在地+近い候補だけを残して残りを画面端の番号バッジ（矢印付き・タップ可）で示す。リサイズやHUD障害物の変化でも再フィットする。振動/パルスは `setReducedMotion` で停止。
- ラベル: 都市名・地形名のスロットは静的データ（マーカー円・線路/航路・先に置いたラベル）だけでズームバケット単位に決定し、`labels.ts` がカメラ非依存で計算する（`placeLabels`）。トークン・ピン・HUD の遮蔽では位置を変えず、`LabelFade` が 300ms 保持 + 160ms フェードで隠すだけなので、パン中や移動中にラベルが飛ばない・明滅しない。現在地/目的地/候補のラベルは固定スロットで常時表示。ラベル矩形にはふりがなを含め、衝突判定にも含める。
- ふりがな: 漢字を含む都市名は `City.nameKana`、地形名は `MapArtLabel.kana` を名前の上に小さく（名前の約50%・最小8px）同じ縁取りで描く。都市名は詳細度1以上、地形名はフォント14px以上のとき表示し、データが無い場合は従来どおり。
- 安全領域: `boardBox()` は HUD 計測の異常で 220×180px 未満に潰れないようインセットをクランプする（zoom が minZoom 未満へ暴走しない）。
- 見た目: 海は青のグラデーション + 波の模様、大陸は明るい緑に濃い緑の縁と影、所々に木のスタンプ（決定的な疑似乱数で配置）。鉄道は通常倍率で太い灰色の塊を避け、白い1〜1.5pxの芯 + 薄いバラスト、航路は白の点線。空路（`mode: 'air'`）は弦から膨らむ二次曲線の水色点線+小さな飛行機グリフで、地上の鉄道/航路より上・駒やラベルより下に描き、プレイズームでは薄くする。空路に乗るマスは雲の台座付きで描く。マスは18〜22pxの天面 + 2〜3pxの側面を持つ宝石風タイル（青=円/＋、赤=角丸四角/−、黄=菱形/？、ニュース=八角形/！、売り場=角丸四角/店）。都市は白い台座の駅 + 名前ラベル（吹き出し風、所有色帯、独占で金縁）、ランドマークがある都市は画像と足元の街クラスタを描く。駒はキャラ画像（影・色リング、複数は顔バッジ）。乗り物は辺の種別で決まり、空路=飛行機、海路=船、鉄道=列車/急行/超特急（`routes.ts` の `vehicleForStep`）。目的地はチェッカーフラッグ + 脈動、取り立て屋は holder の後ろに NPC 画像。

### `src/audio/audio.ts` — `Audio`
```ts
export const Audio: {
  unlock(): void;                       // 最初のユーザー操作で呼ぶ
  playVoice(voiceKey: string, text: string): Promise<void>; // manifest に無ければ即 resolve
  stopVoice(): void;
  sfx(name: SfxName): void;
  bgm(name: BgmName | null): void;     // クロスフェード
  setVolume(kind: 'master' | 'voice' | 'bgm' | 'sfx', v: number): void; // 0..1, localStorage 保存
  getVolume(kind): number;
};
export function voiceKeyOf(speaker: SpeakerRef, playerCharacterId?: string): string; // 'char:<id>' | 'npc:<id>' | 'narrator'
```
- `src/audio/narration.ts`: ナレーター定型文（都市到着、目的地発表、決算、ゲーム開始・終了、取り立て屋レベルアップ等）を関数で生成。音声生成ツールも同じ関数で全都市分を列挙する。
- `src/audio/voicekey.ts`: `voiceHash(voiceKey, text)` = FNV-1a 32bit の 8 桁 hex。manifest は `{ [hash]: "voice/<hash>.mp3" }`。
