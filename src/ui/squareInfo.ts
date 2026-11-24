import { REALMS } from '../core/realm';
import type { PublicState } from '../core/engine';
import type { BoardEdge, BoardNode, City, RealmId, SquareKind } from '../core/types';
import { GAME_DATA } from '../data/index';
import { h } from './dom';
import { assetUrl, citiesById, displayPlayerName } from './format';

declare const __CITY_TILE_IDS__: readonly string[] | undefined;

export type CommonCityTileKind = 'metro' | 'city' | 'town' | 'port' | 'airport' | 'heaven' | 'hell' | 'space';
export type SquareTileKind = 'blue' | 'red' | 'yellow' | 'news' | 'shop' | 'warp' | 'portal' | 'blank';

export const SQUARE_TILE_KINDS: readonly SquareTileKind[] = [
  'blue', 'red', 'yellow', 'news', 'shop', 'warp', 'portal', 'blank',
];

export const COMMON_CITY_TILE_KINDS: readonly CommonCityTileKind[] = [
  'metro', 'city', 'town', 'port', 'airport', 'heaven', 'hell', 'space',
];

const FALLBACK_CITY_TILE_IDS: readonly string[] = [
  'beijing', 'fukuoka', 'guangzhou', 'hiroshima', 'kanazawa', 'kobe', 'kyoto', 'nagoya',
  'naha', 'osaka', 'sapporo', 'sendai', 'shanghai', 'shenzhen', 'tokyo', 'yokohama',
];

/**
 * Available per-city tile ids (`public/assets/tiles/cities/<id>.webp`), discovered by Vite
 * at startup/build so newly generated tiles are picked up automatically without 404 requests.
 */
export const CITY_TILE_IDS: ReadonlySet<string> = new Set(
  typeof __CITY_TILE_IDS__ !== 'undefined' && Array.isArray(__CITY_TILE_IDS__)
    ? __CITY_TILE_IDS__
    : FALLBACK_CITY_TILE_IDS,
);

export interface CityRouteConnections {
  airCityIds: ReadonlySet<string>;
  seaCityIds: ReadonlySet<string>;
}

/** Build city connection sets from board edges (`air` / `sea`). */
export function buildCityRouteConnections(edges: readonly BoardEdge[]): CityRouteConnections {
  const airCityIds = new Set<string>();
  const seaCityIds = new Set<string>();
  for (const edge of edges) {
    if (edge.mode === 'air') {
      if (edge.a.startsWith('c:')) airCityIds.add(edge.a.slice(2));
      if (edge.b.startsWith('c:')) airCityIds.add(edge.b.slice(2));
    } else if (edge.mode === 'sea') {
      if (edge.a.startsWith('c:')) seaCityIds.add(edge.a.slice(2));
      if (edge.b.startsWith('c:')) seaCityIds.add(edge.b.slice(2));
    }
  }
  return { airCityIds, seaCityIds };
}

const DEFAULT_CITY_CONNECTIONS = buildCityRouteConnections(GAME_DATA.board.edges);

/**
 * Pick the common city tile fallback for a station when `cities/<id>.webp` is not yet generated.
 *
 * Uses board route connections for airport/port because `cities.json` marks 365/372 cities
 * as `airport: true` (for charter-plane targeting); falling back purely on `city.airport`
 * would render nearly every city on Earth as an airport tile.
 */
export function commonCityTileKind(
  city: Pick<City, 'id' | 'realm' | 'tier' | 'port' | 'airport'>,
  connections: CityRouteConnections = DEFAULT_CITY_CONNECTIONS,
): CommonCityTileKind {
  if (city.realm === 'heaven' || city.realm === 'hell' || city.realm === 'space') {
    return city.realm;
  }
  if (connections.airCityIds.has(city.id)) return 'airport';
  if (connections.seaCityIds.has(city.id)) return 'port';
  if (city.tier === 1) return 'metro';
  if (city.tier === 2) return 'city';
  return 'town';
}

export function hasCityTile(cityId: string): boolean {
  return CITY_TILE_IDS.has(cityId);
}

/** Public-relative path under `assets/` (e.g. `tiles/cities/small/tokyo.webp`). */
export function cityTileAssetPath(
  city: Pick<City, 'id' | 'realm' | 'tier' | 'port' | 'airport'>,
  small: boolean,
  connections: CityRouteConnections = DEFAULT_CITY_CONNECTIONS,
): string {
  if (CITY_TILE_IDS.has(city.id)) {
    return small ? `tiles/cities/small/${city.id}.webp` : `tiles/cities/${city.id}.webp`;
  }
  const kind = commonCityTileKind(city, connections);
  return small ? `tiles/city/small/${kind}.webp` : `tiles/city/${kind}.webp`;
}

export function squareTileAssetPath(kind: SquareTileKind, small: boolean): string {
  return small ? `tiles/small/${kind}.webp` : `tiles/${kind}.webp`;
}

export function cityTileUrl(
  city: Pick<City, 'id' | 'realm' | 'tier' | 'port' | 'airport'>,
  small = true,
): string {
  return assetUrl(`assets/${cityTileAssetPath(city, small)}`);
}

export function squareTileUrl(kind: SquareKind, small = true, city?: City): string {
  if (kind === 'city') {
    if (city) return cityTileUrl(city, small);
    return assetUrl(small ? 'assets/tiles/city/small/metro.webp' : 'assets/tiles/city/metro.webp');
  }
  return assetUrl(`assets/${squareTileAssetPath(kind, small)}`);
}

export function tileThumb(src: string, className = 'square-tile-thumb', alt = ''): HTMLImageElement {
  return h('img', {
    class: className,
    attrs: { src, alt, decoding: 'async', loading: 'lazy', draggable: 'false' },
  });
}

export interface SquareInfo {
  kind: SquareKind;
  /** Full name shown in legends, tooltips, and move lists (never abbreviated). */
  name: string;
  /** Compact name shown below a non-city square on the canvas only when zoomed in. */
  shortLabel: string;
  /** Short one-line summary for chips / compact views. */
  summary: string;
  /** Full effect description matching `src/core` rules. */
  effect: string;
  /** Optional realm-specific note (e.g. multiplier differences). */
  realmNote?: string;
}

/**
 * Authoritative descriptions of all 8 board square types, matching `src/core/engine.ts`,
 * `src/core/economy.ts`, and `src/core/realm.ts`.
 */
export const SQUARE_INFO_LIST: readonly SquareInfo[] = [
  {
    kind: 'city',
    name: '駅（都市）',
    shortLabel: '駅',
    summary: '物件を買える（独占で収益2倍）',
    effect:
      'その都市の物件を所持金の範囲で何件でも買えます。同じ都市の物件をすべて買い占めると「独占」となり、決算時の収益が 2 倍になります。',
  },
  {
    kind: 'blue',
    name: '青マス',
    shortLabel: '収入',
    summary: 'お金がもらえる（年が進むほど増額）',
    effect:
      '8〜20 億円 × 年倍率（年ごとに +35%）のお金がもらえます。特性「強運」のキャラはさらに +30%。',
    realmNote: '異世界倍率：天国 ×3 ／ 地獄 ×0.5 ／ 宇宙 ×1.5',
  },
  {
    kind: 'red',
    name: '赤マス',
    shortLabel: '支出',
    summary: 'お金が減る（赤字なら物件を7割で売却）',
    effect:
      '5〜15 億円 × 年倍率（年ごとに +35%）のお金が減ります（特性「不屈」で 40% 軽減）。払えずマイナスになると、物件を現在価格の 7 割で売却します。',
    realmNote: '異世界倍率：天国 ×0.5 ／ 地獄 ×3 ／ 宇宙 ×1.5',
  },
  {
    kind: 'yellow',
    name: '黄マス（カード）',
    shortLabel: 'カード',
    summary: 'カードをランダムで1枚獲得',
    effect:
      'カードをランダムで 1 枚もらえます（特性「カード通」は 2 枚）。手札上限（通常 8 枚・カード通は 10 枚）を超えると 1 枚選んで捨てます。',
  },
  {
    kind: 'news',
    name: 'ニュースマス',
    shortLabel: 'ニュース',
    summary: '世界のニュースや寓話イベントが発生',
    effect:
      '世界のニュース・歴史・寓話イベントが発生します。選択肢で得したり損したり、業種倍率や物件価格が変わることもあります。',
    realmNote: '借金地獄では地獄専用のニュースも発生',
  },
  {
    kind: 'shop',
    name: 'カード売り場',
    shortLabel: '売り場',
    summary: 'カードを購入・半額で売却',
    effect:
      '並ぶ 5 枚の在庫から所持金でカードを買えます（価格は年倍率で変動）。手持ちカードを半額で売ることもできます。',
  },
  {
    kind: 'warp',
    name: '竜巻マス（ワープ）',
    shortLabel: 'ワープ',
    summary: 'ランダムな都市へ移動（10%で異世界）',
    effect:
      'オズの竜巻に巻き込まれ、ランダムな地上の都市へ飛ばされます（目的地のすぐ近くには落ちません）。10% の確率で異世界（天国 5%・地獄 5%）へ飛ばされます。',
  },
  {
    kind: 'portal',
    name: '異世界の出口',
    shortLabel: '出口',
    summary: '止まるか通過すると地上へ帰還',
    effect:
      '異世界（天国・地獄・宇宙）の出口です。止まるか通過すると地上へ戻ります（天国＝目的地の近く、地獄＝ランダムな都市、宇宙＝好きな空港都市を選んで再突入）。',
  },
];

export const SQUARE_INFO_BY_KIND: ReadonlyMap<SquareKind, SquareInfo> = new Map(
  SQUARE_INFO_LIST.map((info) => [info.kind, info]),
);

export function squareInfoOf(kind: SquareKind): SquareInfo {
  return SQUARE_INFO_BY_KIND.get(kind) ?? SQUARE_INFO_LIST[0];
}

export interface RealmMultiplierRow {
  id: RealmId;
  name: string;
  blueMult: string;
  redMult: string;
  exitRule: string;
}

export const REALM_MULTIPLIER_ROWS: readonly RealmMultiplierRow[] = [
  {
    id: 'heaven',
    name: REALMS.heaven.nameJa,
    blueMult: `×${REALMS.heaven.blueMult}`,
    redMult: `×${REALMS.heaven.redMult}`,
    exitRule: '出口から目的地まで 5〜10 マスの都市へ帰還',
  },
  {
    id: 'hell',
    name: REALMS.hell.nameJa,
    blueMult: `×${REALMS.hell.blueMult}`,
    redMult: `×${REALMS.hell.redMult}`,
    exitRule: '地獄専用ニュースあり。出口でランダムな都市へ帰還',
  },
  {
    id: 'space',
    name: REALMS.space.nameJa,
    blueMult: `×${REALMS.space.blueMult}`,
    redMult: `×${REALMS.space.redMult}`,
    exitRule: '出口で好きな空港都市を選んで再突入',
  },
];

export interface NodeInspectData {
  title: string;
  badge: string;
  iconUrl: string;
  description: string;
  extra?: string;
}

/** Build the tooltip / long-press card content for any board node. */
export function describeBoardNode(node: BoardNode, state?: PublicState | null): NodeInspectData {
  if (node.kind === 'city' && node.cityId) {
    const city = citiesById.get(node.cityId);
    if (city) {
      const total = city.properties.length;
      const owners = state
        ? city.properties
            .map((p) => state.owner[p.id])
            .filter((owner): owner is number => owner !== undefined)
        : [];
      const uniqueOwners = new Set(owners);
      const isDest = state?.destination === city.id;
      let status = `物件 ${total} 件`;
      if (state) {
        if (owners.length === 0) {
          status = `物件 ${total} 件（すべて空き）`;
        } else if (owners.length === total && uniqueOwners.size === 1) {
          const sole = state.players[[...uniqueOwners][0]];
          status = `👑 ${sole ? displayPlayerName(sole) : '誰か'} が独占（収益2倍）`;
        } else {
          status = `物件 ${owners.length}/${total} 件所有済み`;
        }
      }
      const badge = isDest ? '🎯 目的地・駅（都市）' : city.realm ? `${REALMS[city.realm].nameJa}の駅` : '駅（都市）';
      return {
        title: `${city.nameJa}（${city.countryJa}）`,
        badge,
        iconUrl: cityTileUrl(city, true),
        description: `${status}。止まると物件を買えます（独占で決算収益 2 倍）。`,
        extra: 'タップで物件シートを見る',
      };
    }
  }

  const info = squareInfoOf(node.kind);
  let extra = info.realmNote;
  if (node.realm && (node.kind === 'blue' || node.kind === 'red')) {
    const realm = REALMS[node.realm];
    const mult = node.kind === 'blue' ? realm.blueMult : realm.redMult;
    extra = `${realm.nameJa}では効果 ×${mult}`;
  } else if (node.realm && node.kind === 'portal') {
    const row = REALM_MULTIPLIER_ROWS.find((r) => r.id === node.realm);
    if (row) extra = `${row.name}：${row.exitRule}`;
  }

  return {
    title: info.name,
    badge: node.realm ? REALMS[node.realm].nameJa : '盤面マス',
    iconUrl: squareTileUrl(node.kind, true),
    description: info.effect,
    extra,
  };
}
