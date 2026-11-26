// Shared contract between data, core engine, renderer, UI and audio.
// Money unit everywhere: 億円 (integer or float, display rounds). 1兆 = 10000億.

// ---------------------------------------------------------------- static data

export type Industry =
  | 'agri' // 農林水産
  | 'food' // 食品・飲食
  | 'tourism' // 観光・ホテル
  | 'industry' // 工業・製造
  | 'tech' // IT・AI
  | 'finance' // 金融
  | 'energy' // 資源・エネルギー
  | 'shipping' // 物流・海運
  | 'media'; // 娯楽・メディア

export const INDUSTRIES: readonly Industry[] = [
  'agri', 'food', 'tourism', 'industry', 'tech', 'finance', 'energy', 'shipping', 'media',
];

export type Region =
  | 'east_asia' | 'southeast_asia' | 'south_asia' | 'middle_east' | 'europe' | 'russia_central_asia'
  | 'africa' | 'north_america' | 'central_america' | 'south_america' | 'oceania';

export interface Property {
  id: string; // globally unique, e.g. "tokyo-1"
  name: string; // 日本語の物件名（風刺・ダジャレ可）
  industry: Industry;
  price: number; // 億円
  yieldPct: number; // 年間収益率 % (base, before modifiers)
}

export interface City {
  id: string; // ascii slug, e.g. "tokyo"
  nameJa: string;
  /** nameJa のひらがな読み（ふりがな）。漢字を含む nameJa では必須。カタカナだけの名前では持たない。 */
  nameKana?: string;
  nameEn: string;
  country: string; // ISO 3166-1 alpha-2
  countryJa: string;
  region: Region;
  lat: number;
  lon: number;
  tier: 1 | 2 | 3; // 1 = 世界都市, 2 = 主要都市, 3 = 地方都市
  port: boolean; // 船が出る
  airport: boolean; // ペガサス便の発着地
  landmark?: string; // landmark sprite id (public/assets/landmarks/<id>.png)
  blurb: string; // 一言紹介（ブラックユーモア可、1文）
  properties: Property[]; // 2..6
  /** 異世界の駅なら realm id（lat/lon は無視、盤面座標は board.json の node.x/y を使う） */
  realm?: RealmId;
}

export type SquareKind =
  | 'city' // 駅。止まると物件購入
  | 'blue' // お金がもらえる
  | 'red' // お金が減る
  | 'yellow' // カードがもらえる
  | 'news' // ニュース/歴史イベント
  | 'shop' // カード売り場（所持金でカードを買える）
  | 'warp' // オズの竜巻マス（ランダムな都市へ吹き飛ばされる）
  | 'portal'; // 異世界の出口（止まる/通過で地上へ戻る。行き先は realm ごとの規則）

/** 異世界マップ。地上 (world) とはつながっておらず、イベント・カード・特殊マスで出入りする。 */
export type RealmId = 'heaven' | 'hell' | 'space';

export type EdgeMode = 'rail' | 'sea' | 'air';

export interface BoardNode {
  id: string; // "c:<cityId>" for cities, "s:<n>" for squares
  kind: SquareKind;
  x: number; // map units (see geo.ts MAP_W/MAP_H)
  y: number;
  cityId?: string; // only for kind === 'city'
  realm?: RealmId; // 省略 = 地上。異世界ノードの x/y はその realm の座標系（REALM_W × REALM_H）
}

export interface BoardEdge {
  a: string;
  b: string;
  mode: EdgeMode;
}

export interface Board {
  nodes: BoardNode[];
  edges: BoardEdge[];
}

export type PerkId =
  | 'none'
  | 'agri_boost' // 農林水産・食品の収益 +25%
  | 'tech_boost' // IT・AI・メディアの収益 +25%
  | 'tourism_boost' // 観光の収益 +30%
  | 'finance_boost' // 金融・資源の収益 +20%
  | 'sailor' // 海路 (sea edge) を進む時、出目 +1
  | 'lucky' // 青マス +30%
  | 'tough' // 赤マス -40%
  | 'card_shark' // 黄マスでカード 2 枚、手札上限 +2
  | 'haggler' // 物件価格 -10%
  | 'pickpocket' // 他プレイヤーを追い越すと相手の所持金 2% を奪う
  | 'piper_charm'; // 笛吹きの取り立て被害 -50%

export type CharacterRole = 'hero' | 'sidekick' | 'villain' | 'animal' | 'monster' | 'royal' | 'trickster';

export interface VoiceSpec {
  speaker: number; // VOICEVOX style id
  speed: number; // speedScale
  pitch: number; // pitchScale
  intonation: number; // intonationScale
}

/** Fixed voice line keys. Voiced text MUST be fixed (no variables) so it can be pre-generated. */
export type LineKey =
  | 'select' // キャラ選択時
  | 'turn' // 自分の番
  | 'buy' // 物件購入
  | 'monopoly' // 独占達成
  | 'goal' // 目的地一番乗り
  | 'blue' // 青マス
  | 'red' // 赤マス
  | 'card' // カード使用
  | 'piper_get' // 笛吹きに憑かれた
  | 'piper_hit' // 笛吹きの被害
  | 'win' // 優勝
  | 'lose' // 最下位
  | 'skill'; // 固有技の発動の決め台詞

export interface Character {
  id: string; // ascii slug
  nameJa: string;
  origin: string; // 出典の物語名（日本語）
  originRegion: string; // 例: 日本, イギリス, ドイツ, 中国, 中東, ...
  role: CharacterRole;
  sprite: string; // public-relative path, e.g. "assets/chars/momotaro.png"
  color: string; // テーマ色 #rrggbb（駒・UI）
  personality: string; // 1行の性格説明（ブラックユーモア可）
  perk: PerkId;
  voice: VoiceSpec;
  lines: Record<LineKey, string>;
  /** 固有技（1 年に 1 回、手番開始時に使える）。発動の決め台詞は lines.skill */
  skill: CharacterSkill;
}

export interface CharacterSkill {
  name: string; // 技名（短く）例: "求婚者の難題"
  desc: string; // 効果説明（プレイヤーが読む。effects と完全一致させる）
  /** 相手を選ぶ技なら 'player'（effects 内で who: 'target' を使う） */
  target?: 'player';
  effects: Effect[];
  /** CPU が使うタイミングの目安 */
  cpuHint?: 'early' | 'behind' | 'ahead' | 'anytime';
}

// --- events ---------------------------------------------------------------

/**
 * Who an effect targets. Resolved at effect time. 'self' = current player.
 * 'target' = 固有技で選んだ相手（固有技の effects 内でのみ有効）。
 */
export type Who = 'self' | 'all' | 'others' | 'richest' | 'poorest' | 'random_other' | 'target';

export type Effect =
  // amount 億円 × yearScale(state) unless scale === false
  | { op: 'cash'; who: Who; amount: number; scale?: boolean }
  // percent of current cash (positive cash only; negative pct takes money)
  | { op: 'cash_pct'; who: Who; pct: number }
  // each owned property of `industry` pays `perProperty` (negative = costs)
  | { op: 'per_property'; who: Who; industry: Industry | 'any'; perProperty: number; scale?: boolean }
  // global income multiplier for an industry for N settlements (years). stacks multiplicatively
  | { op: 'industry_mod'; industry: Industry; mult: number; years: number; label: string }
  // permanent change of purchase price of an industry (affects asset value)
  | { op: 'price_mod'; industry: Industry; mult: number }
  // force sell owned properties (cheapest first) at price × priceMult
  | { op: 'sell'; who: Who; industry: Industry | 'any'; count: number; priceMult: number }
  | { op: 'card'; who: Who; card: string; count?: number }
  | { op: 'move'; who: Who; to: 'destination_near' | 'random_city' | 'nearest_port' | string /* cityId */ }
  | { op: 'skip'; who: Who; turns: number }
  | { op: 'piper'; to: Who }
  // 異世界へ送る（入口ノードへワープ）。'world' なら地上の random city へ戻す
  | { op: 'realm'; who: Who; realm: RealmId | 'world' }
  // probabilistic branch (chance 0..1), uses seeded rng
  | { op: 'gamble'; chance: number; win: Effect[]; lose: Effect[] }
  // 都市単位の価格・収益倍率（mult < 1 は災害、> 1 はバブル）。city は対象の決め方
  | { op: 'city_mod'; city: CityTarget; mult: number; years: number; label: string; kind: CityModKind };

/**
 * 都市の選び方。'here' = 手番プレイヤーの現在地の都市（都市でなければ最寄りの都市）、
 * 'destination' = 現在の目的地、'random' = 地上のランダムな都市、
 * 'richest_best' = 首位プレイヤーが最も多く物件を持つ都市、'self_best' = 手番プレイヤーが最も多く持つ都市、
 * それ以外の文字列 = cityId
 */
export type CityTarget = 'here' | 'destination' | 'random' | 'richest_best' | 'self_best' | string;

export type SpeakerRef =
  | 'narrator' // ナレーター
  | 'self' // 現在のプレイヤーのキャラクター
  | `char:${string}` // 特定キャラクター（ゲスト出演）
  | `npc:${string}`; // NPC (npcs.json)

export interface DialogueLine {
  speaker: SpeakerRef;
  text: string; // fixed text (voiced). 'self' lines are voiced per character at build time.
}

export interface EventChoice {
  label: string; // ボタン文言 例: "乗る！"
  detail: string; // 効果の説明 例: "IT物件の収益+200%（3年）"
  effects: Effect[];
  reply?: DialogueLine[]; // 選択後の掛け合い
  cpuWeight?: number; // CPU の選びやすさ (default 1)
}

export interface Source {
  title: string;
  url: string;
  date?: string; // YYYY or YYYY-MM-DD
}

export interface GameEventDef {
  id: string;
  title: string; // 例: "AIバブル再来!?"
  kind: 'news' | 'history' | 'fable'; // fable = 完全創作
  image?: string; // public-relative illustration path
  /** BGM id while this event is shown (src/audio/audio.ts BgmName). Omitted = default by kind. */
  bgm?: string;
  /** 事実の要約（風刺を含めない）。kind が news/history のとき必須。 */
  fact?: string;
  sources?: Source[];
  /** どこが創作・誇張かの注記（ゲーム内「元ネタ」表示に使う） */
  satireNote: string;
  /** ニュースマスで発生できる場所。省略 = 地上のみ。['hell'] なら地獄のニュースマス専用 */
  realms?: (RealmId | 'world')[];
  weight: number; // 抽選の重み
  minYear?: number;
  once?: boolean; // 1 ゲーム 1 回
  /** 発生できる月（4..12,1..3）。省略 = 通年 */
  months?: number[];
  /** true = ニュースマスではなく「月替わりイベント」として月初に全体へ発生（効果の 'self' は月初の手番プレイヤー） */
  monthly?: boolean;
  lines: DialogueLine[]; // 導入の掛け合い
  choices?: EventChoice[]; // 無ければ effects を即適用
  effects?: Effect[];
  /** true = 最終年だけ抽選される（首位狙い撃ち・逆転イベント用） */
  finalYear?: boolean;
}

export interface NpcDef {
  id: string;
  nameJa: string;
  sprite?: string;
  voice: VoiceSpec;
}

export type CardKind = 'move' | 'money' | 'attack' | 'defense' | 'special';

export interface CardDef {
  id: string; // engine-implemented id (see DESIGN.md card table)
  name: string;
  desc: string;
  kind: CardKind;
  weight: number; // 黄マスで引く重み
  needsTarget?: 'player' | 'city' | 'airport';
  price: number; // カード売り場での価格（億円、yearScale 倍）。売却は半額
}

// --- communication (cosmetic only; never touches GameState) -----------------

/** Animation vocabulary implemented by MapView.playEmote. Add new ones there first. */
export type EmoteAnim =
  | 'jump' // 喜: ぴょんぴょん
  | 'angry' // 怒: 震え + 湯気
  | 'cry' // 哀: 涙のしずく
  | 'laugh' // 楽: 左右に揺れる + 音符
  | 'dance' // くるくる回って跳ねる
  | 'taunt' // 挑発: お尻ぺんぺん風の左右フリ + 「べー」マーク
  | 'dogeza' // 土下座: 平たく潰れて小さく上下
  | 'money_rain' // 札束をばらまく: 頭上から紙幣パーティクル
  | 'flex' // 自慢: 拡大 + キラキラ
  | 'sleep' // 放置ネタ: Zzz
  | 'heart' // 感謝: ハート
  | 'throw' // 対象へ投げ物（projectile）→ 当たった相手が 'hit'
  | 'hit' // 被弾リアクション（throw の着弾側で自動再生）
  | 'spotlight'; // 固有技向け: スポットライト + 拡大 + 決めポーズ

export type EmoteCategory = 'emotion' | 'action' | 'taunt' | 'poke' | 'unique';

export interface EmoteDef {
  id: string; // ascii slug
  category: EmoteCategory;
  label: string; // ボタン表示（日本語、短く）
  icon: string; // 絵文字 1 つ（ボタン・頭上ポップ）
  anim: EmoteAnim;
  targeted: boolean; // true なら相手プレイヤーを選ぶ（ちょっかい）
  projectile?: string; // throw 用の絵文字（例: 🍑, 🍅, 💸）
  characterId?: string; // category 'unique' の持ち主（その人だけ使える）
  cooldownMs: number; // この emote 自体の再使用間隔（席ごと）
  /** 発動者キャラの台詞（音声化）。キーは character id。無いキャラは default を使う。 */
  lines: Record<string, string> & { default: string };
  /** targeted のとき、当てられた側キャラの返し台詞（音声化、任意）。 */
  hitLines?: Record<string, string> & { default: string };
}

export interface GameData {
  cities: City[];
  board: Board;
  characters: Character[];
  events: GameEventDef[];
  cards: CardDef[];
  npcs: NpcDef[];
  emotes: EmoteDef[];
  /** 手番開始の台詞のバリエーション（characterId → 状況別の候補）。無いキャラは lines.turn を使う */
  turnLines?: Record<string, TurnLines>;
}

/**
 * 手番開始の台詞。状況に合う候補から、直近と同じにならないよう決定的に選ぶ（rng は消費しない）。
 * どれも固定文（音声を事前生成するため）。
 */
export interface TurnLines {
  normal: string[]; // ふだんの手番（5 つ以上）
  lead: string[]; // 首位のとき
  last: string[]; // 最下位のとき
  piper: string[]; // 取り立て屋に憑かれているとき
  near: string[]; // 目的地がすぐ近いとき
  final: string[]; // 最終年
  realm: string[]; // 異世界（天国・地獄・宇宙）にいるとき
}

// ---------------------------------------------------------------- runtime state

export interface PlayerSetup {
  name: string;
  characterId: string;
  isCpu: boolean;
  cpuLevel?: 1 | 2 | 3;
}

export interface GameConfig {
  years: number; // 1 | 3 | 5 | 10 | 20 (see ALLOWED_YEARS)
  players: PlayerSetup[]; // 1..4
  seed?: number;
}

export interface PlayerState {
  id: number; // index
  name: string;
  characterId: string;
  isCpu: boolean;
  cpuLevel: 1 | 2 | 3;
  cash: number; // may go negative (= 借金)
  nodeId: string;
  prevNodeId: string | null; // previous path node (presentation only; no-backtrack is per move)
  cards: string[];
  skipTurns: number;
  goals: number; // 目的地到着回数
  /** 固有技を最後に使った年（1 年に 1 回）。未使用なら undefined */
  skillUsedYear?: number;
}

export interface IndustryModState {
  industry: Industry;
  mult: number;
  yearsLeft: number;
  label: string;
}

export type CityModKind = 'bubble' | 'damage' | 'blockade' | 'boom';

export interface CityModState {
  cityId: string;
  /** その都市の物件の価格（資産価値・購入価格）と決算収益に掛かる倍率。複数は乗算 */
  mult: number;
  yearsLeft: number;
  label: string;
  kind: CityModKind;
}

export interface PiperState {
  holder: number | null; // player id
  level: 1 | 2 | 3; // 1 = 笛吹き, 2 = ブラック笛吹き, 3 = キング笛吹き
  heldTurns: number;
}

export type Phase =
  | { t: 'turn_start' } // roll or use card
  | { t: 'choose_dest'; roll: number; options: MoveOption[]; dice?: number } // dice = count used (for move fx)
  // buy properties then end。boughtOut = この訪問ですでに買収したか（1訪問1回）
  | { t: 'buy'; cityId: string; boughtOut?: boolean }
  | { t: 'shop'; stock: string[] } // カード売り場: buy_card / sell_card any number of times, then end_shop
  | { t: 'event'; eventId: string } // pick a choice (only when event has choices)
  | { t: 'card_target'; cardId: string; options: string[] } // choose target (player id as string / city id)
  | { t: 'discard' } // hand over limit
  | { t: 'sell' } // cash < 0 and owns property: must sell until >= 0 or no property
  | { t: 'year_end'; report: YearReport } // acknowledge
  | { t: 'skill_target'; options: string[] } // 固有技の対象（player id as string）。'cancel' で戻れる
  | { t: 'game_over'; ranking: number[] };

export interface MoveOption {
  nodeId: string;
  path: string[]; // node ids, excluding start, ending at nodeId
}

export interface YearReport {
  year: number;
  income: { playerId: number; amount: number }[];
  assets: { playerId: number; total: number }[];
  headline: string;
}

export interface GameState {
  version: 1;
  rng: number; // mulberry32 state
  config: GameConfig;
  year: number; // 1-based
  month: number; // 4..12,1..3 (年度は 4 月開始、3 月末決算)
  round: number; // 0-based total rounds played
  current: number; // current player id
  phase: Phase;
  players: PlayerState[];
  owner: Record<string, number>; // propertyId -> player id
  priceMod: Partial<Record<Industry, number>>;
  industryMods: IndustryModState[];
  destination: string; // cityId
  /** Shortest steps from the drawer to `destination` when it was drawn (goal bonus input). */
  destinationStartDistance?: number;
  piper: PiperState;
  usedOnceEvents: string[];
  /** 抽選済みイベントの履歴（古い順）。直近12件の再登場を避け、最終月の「初出」判定にも使う */
  recentEvents?: string[];
  activeEventId: string | null;
  assetHistory: number[][]; // per round: total assets per player
  /** Set while a month-start event must resume the current player's turn when it closes. */
  pendingTurnStart?: boolean;
  /** 都市単位の価格・収益倍率（バブル・災害など）。years で失効 */
  cityMods: CityModState[];
  /**
   * 寄り道依頼（目的地とは別の小目標）。遠い目的地を追う間の単調さを減らす。
   * 最初に止まった人が報酬を受け取り、次の依頼が出る。null = 今は依頼なし
   */
  errand?: ErrandState | null;
}

export interface ErrandState {
  cityId: string;
  /** 達成報酬（億円、発表時に確定） */
  bonus: number;
  requester: string; // character id
  title: string; // 依頼名（例: 「赤ずきんのお使い：ワインを届けて」）
  /** 発表したときの `state.round`。8 ラウンド経っても誰も達成しなければ引き直す */
  drawnRound: number;
}

/** State safe to broadcast: no rng state and no input seed. */
export type PublicState = Omit<GameState, 'rng' | 'config'> & {
  config: Omit<GameConfig, 'seed'>;
};

/** Read-only query boundary: engine accepts authoritative or sanitized state. */
export type StateView = GameState | PublicState;

// ---------------------------------------------------------------- actions & fx

export type Action =
  | { t: 'roll' }
  | { t: 'use_card'; cardId: string }
  | { t: 'card_target'; target: string }
  | { t: 'cancel' } // cancel card_target
  | { t: 'move'; nodeId: string }
  | { t: 'buy'; propertyId: string }
  | { t: 'end_buy' }
  | { t: 'buy_card'; cardId: string }
  | { t: 'sell_card'; cardId: string }
  | { t: 'end_shop' }
  | { t: 'choose'; index: number }
  | { t: 'discard'; cardId: string }
  | { t: 'sell'; propertyId: string }
  | { t: 'ack' }
  /** turn_start で固有技を使う（1 年に 1 回）。target が必要な技は skill_target フェーズへ */
  | { t: 'use_skill' }
  | { t: 'skill_target'; target: string } // player id as string
  /** buy フェーズで、他人が持つこの都市の物件を買い取る */
  | { t: 'buyout'; propertyId: string };

/** Presentation effects emitted by the engine, played in order by the UI. */
export type Fx =
  | { t: 'turn'; playerId: number }
  | { t: 'dice'; values: number[] }
  // dice = number of dice used for this move (1 normal, 2 急行, 3 超特急). Renderer picks the vehicle per hop:
  // sea edge -> ship, rail edge -> train (dice 1) / express train (2) / bullet train (3).
  | { t: 'move'; playerId: number; path: string[]; dice?: number }
  // via: how the warp happens (plane = 飛行機カード, rocket = ロケットカード, carpet = 魔法のじゅうたん, event = イベント効果, tornado = オズの竜巻マス)
  | { t: 'warp'; playerId: number; nodeId: string; via?: 'plane' | 'rocket' | 'carpet' | 'event' | 'tornado' | 'realm' }
  | { t: 'cash'; playerId: number; delta: number; reason: string }
  | { t: 'buy'; playerId: number; propertyId: string; monopoly: boolean }
  | { t: 'sell'; playerId: number; propertyId: string; amount: number }
  | { t: 'card_get'; playerId: number; cardId: string }
  | { t: 'card_use'; playerId: number; cardId: string }
  | { t: 'say'; speaker: SpeakerRef; playerId?: number; text: string; lineKey?: LineKey }
  | { t: 'event_open'; eventId: string; playerId: number }
  | { t: 'event_close' }
  | { t: 'goal'; playerId: number; cityId: string; bonus: number }
  | { t: 'destination'; cityId: string }
  | { t: 'piper'; holder: number | null; level: number; message: string }
  | { t: 'industry'; industry: Industry; mult: number; label: string }
  | { t: 'skip'; playerId: number }
  | { t: 'month'; year: number; month: number }
  | { t: 'year_end'; report: YearReport }
  | { t: 'game_over'; ranking: number[] }
  | { t: 'toast'; text: string }
  // --- fun overhaul (2026-11-26) ---
  /** 取り立て屋の変身ルーレット。from → to（同じなら変身なし）。UI はルーレット演出を出す */
  | { t: 'piper_roulette'; holder: number; from: 1 | 2 | 3; to: 1 | 2 | 3 }
  /** 取り立て屋の大災害（主にキング）。amount = 合計被害額（億円）、propertyIds = 没収・売却された物件 */
  | { t: 'piper_disaster'; holder: number; kind: string; title: string; amount: number; propertyIds: string[] }
  /** 取り立て屋の気まぐれな善行（借金を払う等） */
  | { t: 'piper_gift'; holder: number; amount: number; title: string }
  /** 他人の物件の買い取り */
  | { t: 'buyout'; playerId: number; fromId: number; propertyId: string; amount: number; brokeMonopoly: boolean }
  /** 都市単位の効果（バブル・災害・封鎖など）。UI は地図上の都市を強調し、ラベルを出す */
  | { t: 'city_mod'; cityId: string; mult: number; years: number; label: string; kind: CityModKind }
  /** キャラクター固有技の発動（カットイン演出）。台詞は Character.lines.skill */
  | { t: 'skill'; playerId: number; characterId: string; name: string; targetId?: number }
  /** 最終年の開幕（ルール変更の告知演出） */
  | { t: 'final_year'; year: number; rules: string[] }
  /** 寄り道依頼（小目標）の発表。requester = 依頼主のキャラ id（演出と台詞用） */
  | { t: 'errand'; cityId: string; bonus: number; requester: string; title: string }
  /** 寄り道依頼の達成 */
  | { t: 'errand_done'; playerId: number; cityId: string; bonus: number };

export interface StepResult {
  state: GameState;
  fx: Fx[];
}
