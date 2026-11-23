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
- 下中央: 主ボタン「サイコロをふる」（自分が操作できる番だけ）。その右にアイコンボタン列: カード / 物件 / 持ち物（=カード一覧の別名ではなく所有物件一覧）/ 情報（業種倍率・経済ニュース・ログ）/ 全体マップ。
- 右下: 自分（または手番プレイヤー）の所持金・年間収益見込み・総資産。
- イベント: 右側の大パネル（赤帯見出し「世界ニュースイベント！」、挿絵、台詞、選択肢ボタン、「元ネタ」ボタンで fact / sources / satireNote を表示）。
- オンライン: タイマー（手番の残り秒、円形ゲージ）。
- コミュニケーション（DESIGN.md §8、ローカル / オンライン共通）: 画面右下寄りに「💬」チャットボタンと「😆」エモートボタン（常時表示、手番外も押せる）。エモートパレットはタブ（喜怒哀楽 / アクション / 煽り / ちょっかい / 固有技）でボタン各 44px 以上、クールダウン中は円形ゲージでグレーアウト。ちょっかいは押した後に相手の顔アイコンを選ぶ。チャットは下からせり上がる小パネル（ログ + 入力欄 + 定型文チップ「よろしく！」「ナイス！」「やられた〜」「それはズルい！」「GG！」等）。各プレイヤー行の「…」メニューにミュート（チャット / エモート / ボイス）と通報。受信したチャットはマップ上の駒の頭上と順位パネル横に吹き出し、エモートは駒のアニメ + 頭上アイコン + 台詞の吹き出し + ボイス。ローカル（ホットシート）では手番プレイヤーとしてエモートを出す。

スマホ（< 900px または縦向き）:
- 上部 1 行に年月・目的地・残り歩数。順位はアイコンだけの横並び（タップで詳細）。
- 下部に主ボタンとアイコンボタン列（親指で届く位置、各 44px 以上）。
- 立ち絵は小さく、吹き出しは画面下部の字幕バー。
- ダイアログは全画面シート。
- 縦向き・横向きどちらでも遊べること（縦向きでマップが狭くなっても操作できる）。

## 3. 操作
- マップ: ドラッグでパン、ホイール / ピンチでズーム（0.35〜3.0）、横方向は無限ループ。ダブルタップでズームイン。
- 移動先選択: 到達可能マスを脈動ハイライト + ゴースト経路。タップで決定（確認なし、ただし誤タップ防止のため 1 回目タップでそのマスの経路を太く表示し「ここへ移動」ボタン、もう一度タップでも決定）。PC はホバーで経路プレビュー。
- 都市タップ: 都市情報シート（物件一覧、所有者、価格、収益率、独占状況、ランドマーク画像）。
- 物件購入フェーズ: 都市シートが購入モードで開き、各物件に「買う」、下に「購入を終える」。
- キーボード（PC）: Space/Enter = 主ボタン、Esc = ダイアログを閉じる、1〜3 = 選択肢。

## 4. fx 再生（`src/ui/fxPlayer.ts`）
- `ServerMsg.update` の fx を順に await 再生してから `state` を採用（HUD を最新に）。再生中に次の update が来たらキュー。キューが 2 件以上たまったら 2 倍速。
- 設定「演出速度」1x / 2x / 4x、「台詞の自動送り」、タップ / クリックで現在の fx をスキップ（自分の画面だけ）。
- `say`: 立ち絵 + 吹き出し + 字幕、`Audio.playVoice` の終了または `FX_MS` の時間の長い方を待つ（スキップ可）。
- `dice`: 3D 風の CSS サイコロ回転 → 出目。`move`: `MapView.animateMove`。`cash`: 対象プレイヤーの頭上に「+12億」浮遊文字 + コイン SE。`event_open`: イベントパネル。`year_end`: 決算画面。`game_over`: 結果画面。
- `snapshot`: アニメなしで即座に反映。

## 5. モジュール API

### `src/render/map.ts` — `MapView`
```ts
export interface MapAssets { land: LandJson; chars: Map<string, HTMLImageElement>; landmarks: Map<string, HTMLImageElement>; npcs?: Map<string, HTMLImageElement>; vehicles?: Map<string, HTMLImageElement>; joy?: Map<string, HTMLImageElement>; sad?: Map<string, HTMLImageElement>; realms?: Map<RealmId, HTMLImageElement>; }
export class MapView {
  constructor(canvas: HTMLCanvasElement, data: GameData, assets: MapAssets);
  setState(state: PublicState): void; // tokens, ownership tint on city badges, destination flag, piper on holder
  setMoveOptions(options: MoveOption[] | null, onPick: (nodeId: string) => void): void;
  animateMove(playerId: number, path: string[], msPerStep: number, opts?: { dice?: number }): Promise<void>; // dice 1=列車 / 2=急行 / 3=超特急
  warp(playerId: number, nodeId: string, via?: 'plane'|'rocket'|'carpet'|'event'|'tornado'|'realm'): Promise<void>;
  focusNode(nodeId: string, opts?: { zoom?: number; ms?: number }): Promise<void>;
  fitWorld(ms?: number): Promise<void>;
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
  /** 各ビューにいるプレイヤー数（UI バッジ用）。 */
  readonly realmCounts: Record<RealmId | 'world', number>;
  screenPositionOf(playerId: number): { x: number; y: number } | null;
  screenPositionOfNode(nodeId: string): { x: number; y: number; visible?: boolean } | null;
  isNodeVisible(nodeId: string): boolean;
  /** 季節。1秒クロスフェード。 */
  setMonth(month: number): void;
  /** 外部キャンバスにワールドミニマップを描画。タップでその地点へジャンプ。 */
  setMiniMap(el: HTMLCanvasElement | null): void;
}
```
- 描画: devicePixelRatio 対応、変更が無ければ再描画しない（ダーティフラグ）、アニメ中のみ rAF。ズームに応じた詳細度（遠景: 大陸・航路・主要都市名のみ、近景: 全マス・全都市名・ランドマーク）。画面外カリング。
- 見た目: 海は青のグラデーション + 波の模様、大陸は明るい緑に濃い緑の縁と影、所々に木のスタンプ（決定的な疑似乱数で配置）。鉄道は白い太線 + 灰色の縁、航路は白の点線。マスは丸角の宝石風タイル（青 / 赤 / 黄 / ニュースは紫で「！」）。都市は白い台座の駅 + 名前ラベル（吹き出し風、所有者の色の帯、独占で金縁）、ランドマークがある都市は画像を描く。駒はキャラ画像（足元に影と色付きリング、同じマスに複数なら並べる）。目的地はチェッカーフラッグ + 脈動、取り立て屋は holder の駒の後ろに NPC 画像。

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
