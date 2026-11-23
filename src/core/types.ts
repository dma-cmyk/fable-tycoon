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
}

export type SquareKind =
  | 'city' // 駅。止まると物件購入
  | 'blue' // お金がもらえる
  | 'red' // お金が減る
  | 'yellow' // カードがもらえる
  | 'news'; // ニュース/歴史イベント

export type EdgeMode = 'rail' | 'sea';

export interface BoardNode {
  id: string; // "c:<cityId>" for cities, "s:<n>" for squares
  kind: SquareKind;
  x: number; // map units (see geo.ts MAP_W/MAP_H)
  y: number;
  cityId?: string; // only for kind === 'city'
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
  | 'lose'; // 最下位

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
}

// --- events ---------------------------------------------------------------

/** Who an effect targets. Resolved at effect time. 'self' = current player. */
export type Who = 'self' | 'all' | 'others' | 'richest' | 'poorest' | 'random_other';

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
  // probabilistic branch (chance 0..1), uses seeded rng
  | { op: 'gamble'; chance: number; win: Effect[]; lose: Effect[] };

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
  /** 事実の要約（風刺を含めない）。kind が news/history のとき必須。 */
  fact?: string;
  sources?: Source[];
  /** どこが創作・誇張かの注記（ゲーム内「元ネタ」表示に使う） */
  satireNote: string;
  weight: number; // 抽選の重み
  minYear?: number;
  once?: boolean; // 1 ゲーム 1 回
  lines: DialogueLine[]; // 導入の掛け合い
  choices?: EventChoice[]; // 無ければ effects を即適用
  effects?: Effect[];
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
}

// ---------------------------------------------------------------- runtime state

export interface PlayerSetup {
  name: string;
  characterId: string;
  isCpu: boolean;
  cpuLevel?: 1 | 2 | 3;
}

export interface GameConfig {
  years: number; // 1..10
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
  prevNodeId: string | null; // to discourage immediate backtracking
  cards: string[];
  skipTurns: number;
  goals: number; // 目的地到着回数
}

export interface IndustryModState {
  industry: Industry;
  mult: number;
  yearsLeft: number;
  label: string;
}

export interface PiperState {
  holder: number | null; // player id
  level: 1 | 2 | 3; // 1 = 笛吹き, 2 = ブラック笛吹き, 3 = キング笛吹き
  heldTurns: number;
}

export type Phase =
  | { t: 'turn_start' } // roll or use card
  | { t: 'choose_dest'; roll: number; options: MoveOption[] }
  | { t: 'buy'; cityId: string } // buy properties then end
  | { t: 'event'; eventId: string } // pick a choice (only when event has choices)
  | { t: 'card_target'; cardId: string; options: string[] } // choose target (player id as string / city id)
  | { t: 'discard' } // hand over limit
  | { t: 'sell' } // cash < 0 and owns property: must sell until >= 0 or no property
  | { t: 'year_end'; report: YearReport } // acknowledge
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
  activeEventId: string | null;
  assetHistory: number[][]; // per round: total assets per player
}

// ---------------------------------------------------------------- actions & fx

export type Action =
  | { t: 'roll' }
  | { t: 'use_card'; cardId: string }
  | { t: 'card_target'; target: string }
  | { t: 'cancel' } // cancel card_target
  | { t: 'move'; nodeId: string }
  | { t: 'buy'; propertyId: string }
  | { t: 'end_buy' }
  | { t: 'choose'; index: number }
  | { t: 'discard'; cardId: string }
  | { t: 'sell'; propertyId: string }
  | { t: 'ack' };

/** Presentation effects emitted by the engine, played in order by the UI. */
export type Fx =
  | { t: 'turn'; playerId: number }
  | { t: 'dice'; values: number[] }
  | { t: 'move'; playerId: number; path: string[] }
  | { t: 'warp'; playerId: number; nodeId: string }
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
  | { t: 'toast'; text: string };

export interface StepResult {
  state: GameState;
  fx: Fx[];
}
