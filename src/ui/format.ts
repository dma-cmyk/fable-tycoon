import type {
  CardDef,
  Character,
  City,
  EmoteDef,
  GameEventDef,
  Industry,
  NpcDef,
  Property,
  RealmId,
  SquareKind,
} from '../core/types';
import { GAME_DATA } from '../data/index';

export const charsById = new Map<string, Character>(GAME_DATA.characters.map((c) => [c.id, c]));
export const citiesById = new Map<string, City>(GAME_DATA.cities.map((c) => [c.id, c]));
export const cardsById = new Map<string, CardDef>(GAME_DATA.cards.map((c) => [c.id, c]));
export const eventsById = new Map<string, GameEventDef>(GAME_DATA.events.map((e) => [e.id, e]));
export const emotesById = new Map<string, EmoteDef>(GAME_DATA.emotes.map((e) => [e.id, e]));
export const npcsById = new Map<string, NpcDef>(GAME_DATA.npcs.map((n) => [n.id, n]));
export const nodesById = new Map(GAME_DATA.board.nodes.map((n) => [n.id, n]));

export const propertiesById = new Map<string, { city: City; property: Property }>();
for (const city of GAME_DATA.cities) {
  for (const property of city.properties) propertiesById.set(property.id, { city, property });
}

export const INDUSTRY_JA: Record<Industry, string> = {
  agri: '農林水産',
  food: '食品・飲食',
  tourism: '観光・ホテル',
  industry: '工業・製造',
  tech: 'IT・AI',
  finance: '金融',
  energy: '資源・エネルギー',
  shipping: '物流・海運',
  media: '娯楽・メディア',
};

export const INDUSTRY_ICON: Record<Industry, string> = {
  agri: '🌾',
  food: '🍜',
  tourism: '🏨',
  industry: '🏭',
  tech: '🤖',
  finance: '🏦',
  energy: '⚡',
  shipping: '🚢',
  media: '🎬',
};

export const SQUARE_JA: Record<SquareKind, string> = {
  city: '都市',
  blue: '青マス',
  red: '赤マス',
  yellow: '黄マス',
  news: 'ニュース',
  shop: 'カード売り場',
  warp: '竜巻',
  portal: '出口',
};

export const SQUARE_ICON: Record<SquareKind, string> = {
  city: '🏙️',
  blue: '💎',
  red: '🔥',
  yellow: '🃏',
  news: '📰',
  shop: '🛒',
  warp: '🌪️',
  portal: '🌀',
};

export function assetUrl(path: string): string {
  const rel = path.replace(/^\/+/, '').replace(/\.png$/i, '.webp');
  return `${import.meta.env.BASE_URL}${rel}`;
}

export function characterSprite(character: Character | undefined): string {
  return character ? assetUrl(character.sprite) : '';
}

export function cityNodeId(cityId: string): string {
  return `c:${cityId}`;
}

export function cityOfNode(nodeId: string): City | undefined {
  const node = nodesById.get(nodeId);
  return node?.cityId ? citiesById.get(node.cityId) : undefined;
}

export function nodeLabel(nodeId: string): string {
  const node = nodesById.get(nodeId);
  if (!node) return nodeId;
  if (node.cityId) return citiesById.get(node.cityId)?.nameJa ?? nodeId;
  return SQUARE_JA[node.kind];
}

export function municipalityLabel(cityId: string): string {
  return citiesById.get(cityId)?.nameJa ?? cityId;
}

/** Integer 億円 display. 12480 -> 1兆2,480億円; -30 -> ▲30億円. */
export function formatOku(n: number): string {
  const total = Math.round(n);
  const abs = Math.abs(total);
  const sign = total < 0 ? '▲' : '';
  if (abs >= 10000) {
    const cho = Math.floor(abs / 10000);
    const rest = abs % 10000;
    return rest > 0
      ? `${sign}${cho.toLocaleString('ja-JP')}兆${rest.toLocaleString('ja-JP')}億円`
      : `${sign}${cho.toLocaleString('ja-JP')}兆円`;
  }
  return `${sign}${abs.toLocaleString('ja-JP')}億円`;
}

/** Same as formatOku but without 円, for compact chips: 1兆2,480億. */
export function formatOkuShort(n: number): string {
  return formatOku(n).replace(/円$/, '');
}

/** '+12億' / '▲12億' for floating cash text. */
export function formatDelta(n: number): string {
  const total = Math.round(n);
  if (total > 0) return `+${formatOkuShort(total)}`;
  if (total < 0) return formatOkuShort(total);
  return '±0億';
}

export function formatYears(years: number): string {
  return years === 1 ? '1年' : `${years}年`;
}

export function formatTurnLabel(round: number, years: number): string {
  const total = years * 12;
  return `${Math.min(round + 1, total)} / ${total}`;
}

/** 2026-11-23 12:34 style timestamp for chat. */
export function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function shortText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

export interface PlayerLike {
  characterId: string;
}

export function characterOf(player: PlayerLike | undefined | null): Character | undefined {
  return player ? charsById.get(player.characterId) : undefined;
}

export function playerColor(player: PlayerLike | undefined | null): string {
  return characterOf(player)?.color ?? '#9fb3d9';
}

export function speakerName(speaker: string): string {
  if (speaker === 'narrator') return 'ナレーター';
  if (speaker === 'self') return '手番のキャラ';
  if (speaker.startsWith('char:')) {
    return charsById.get(speaker.slice(5))?.nameJa ?? 'ゲスト';
  }
  if (speaker.startsWith('npc:')) {
    return npcsById.get(speaker.slice(4))?.nameJa ?? 'NPC';
  }
  return '？？？';
}

export function speakerSprite(speaker: string): string | undefined {
  if (speaker.startsWith('char:')) return characterSprite(charsById.get(speaker.slice(5)));
  if (speaker.startsWith('npc:')) {
    const npc = npcsById.get(speaker.slice(4));
    return npc?.sprite ? assetUrl(npc.sprite) : undefined;
  }
  return undefined;
}

export const KIND_JA = {
  news: '世界ニュース',
  history: '歴史の真実',
  fable: '創作寓話',
} as const;

export const KIND_ICON = {
  news: '📰',
  history: '📜',
  fable: '🧚',
} as const;

export const ROLE_JA: Record<Character['role'], string> = {
  hero: '主人公',
  sidekick: '相棒',
  villain: '悪役',
  animal: '動物',
  monster: '怪物',
  royal: '王族',
  trickster: 'いたずら者',
};

export function roleLabel(role: Character['role']): string {
  return ROLE_JA[role] ?? role;
}
/** ISO 3166-1 alpha-2 -> flag emoji. */
export function countryFlag(code: string): string {
  if (!/^[A-Za-z]{2}$/.test(code)) return '🏳️';
  return String.fromCodePoint(...[...code.toUpperCase()].map((char) => 0x1f1a5 + char.charCodeAt(0)));
}

export function industryLabel(industry: Industry): string {
  return INDUSTRY_JA[industry];
}


export const SEAT_COLORS = ['#3f9bff', '#ff5b65', '#ffd23f', '#41d17b'] as const;

/** Player-slot color used consistently across HUD badges, rows and banners. */
export function seatColor(playerId: number): string {
  return SEAT_COLORS[((playerId % SEAT_COLORS.length) + SEAT_COLORS.length) % SEAT_COLORS.length];
}

export function realmOfNode(nodeId: string | undefined): RealmId | 'world' {
  return nodeId ? nodesById.get(nodeId)?.realm ?? 'world' : 'world';
}

export const REALM_JA: Record<RealmId | 'world', string> = {
  world: '地上',
  heaven: '天下り天国',
  hell: '借金地獄',
  space: '宇宙ビジネス特区',
};

export const REALM_ICON: Record<RealmId | 'world', string> = {
  world: '🌍',
  heaven: '☁️',
  hell: '🔥',
  space: '🚀',
};

export function realmLabel(realm: RealmId | 'world'): string {
  return REALM_JA[realm];
}

const EDGE_MODE_BY_KEY = new Map<string, 'rail' | 'sea'>();
for (const edge of GAME_DATA.board.edges) {
  EDGE_MODE_BY_KEY.set(`${edge.a}|${edge.b}`, edge.mode);
  EDGE_MODE_BY_KEY.set(`${edge.b}|${edge.a}`, edge.mode);
}

/** Counts rail/sea hops along a node path (path should include the starting node). */
export function transportSummary(path: string[]): { rail: number; sea: number } {
  let rail = 0;
  let sea = 0;
  for (let i = 1; i < path.length; i++) {
    const mode = EDGE_MODE_BY_KEY.get(`${path[i - 1]}|${path[i]}`);
    if (mode === 'sea') sea++;
    else rail++;
  }
  return { rail, sea };
}
