import { describe, expect, it } from 'vitest';
import { GAME_DATA } from '../data/index';
import type { BoardNode, SquareKind } from '../core/types';
import {
  buildCityRouteConnections,
  cityTileAssetPath,
  commonCityTileKind,
  describeBoardNode,
  hasCityTile,
  REALM_MULTIPLIER_ROWS,
  SQUARE_INFO_LIST,
  squareInfoOf,
} from './squareInfo';

describe('squareInfo', () => {
  it('defines all 8 square types with full names, short labels, and non-empty effects', () => {
    const expected: SquareKind[] = ['city', 'blue', 'red', 'yellow', 'news', 'shop', 'warp', 'portal'];
    expect(SQUARE_INFO_LIST.map((info) => info.kind)).toEqual(expected);
    for (const kind of expected) {
      const info = squareInfoOf(kind);
      expect(info.name.length).toBeGreaterThan(0);
      expect(info.shortLabel.length).toBeGreaterThan(0);
      expect(info.effect.length).toBeGreaterThan(10);
    }
    expect(REALM_MULTIPLIER_ROWS.map((r) => r.id)).toEqual(['heaven', 'hell', 'space']);
  });

  it('resolves common city tile fallbacks across realms, air/sea routes, and tiers', () => {
    const connections = {
      airCityIds: new Set(['hub-air']),
      seaCityIds: new Set(['hub-sea']),
    };
    expect(commonCityTileKind({ id: 'h1', realm: 'heaven', tier: 1, port: false, airport: false }, connections)).toBe('heaven');
    expect(commonCityTileKind({ id: 'd1', realm: 'hell', tier: 2, port: false, airport: false }, connections)).toBe('hell');
    expect(commonCityTileKind({ id: 's1', realm: 'space', tier: 3, port: false, airport: false }, connections)).toBe('space');
    expect(commonCityTileKind({ id: 'hub-air', tier: 3, port: true, airport: true }, connections)).toBe('airport');
    expect(commonCityTileKind({ id: 'hub-sea', tier: 3, port: true, airport: true }, connections)).toBe('port');
    expect(commonCityTileKind({ id: 'big', tier: 1, port: false, airport: true }, connections)).toBe('metro');
    expect(commonCityTileKind({ id: 'mid', tier: 2, port: false, airport: true }, connections)).toBe('city');
    expect(commonCityTileKind({ id: 'small', tier: 3, port: false, airport: true }, connections)).toBe('town');
  });

  it('distributes all 5 world fallback city tile kinds across real GAME_DATA cities', () => {
    const connections = buildCityRouteConnections(GAME_DATA.board.edges);
    const counts = new Map<string, number>();
    for (const city of GAME_DATA.cities) {
      if (city.realm) continue;
      const kind = commonCityTileKind(city, connections);
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    expect(counts.get('airport') ?? 0).toBeGreaterThan(10);
    expect(counts.get('port') ?? 0).toBeGreaterThan(10);
    expect(counts.get('metro') ?? 0).toBeGreaterThan(5);
    expect(counts.get('city') ?? 0).toBeGreaterThan(20);
    expect(counts.get('town') ?? 0).toBeGreaterThan(20);
  });

  it('uses per-city tiles when available and falls back to common city tiles otherwise', () => {
    expect(hasCityTile('tokyo')).toBe(true);
    expect(cityTileAssetPath({ id: 'tokyo', tier: 1, port: true, airport: true }, true)).toBe('tiles/cities/small/tokyo.webp');
    expect(cityTileAssetPath({ id: 'tokyo', tier: 1, port: true, airport: true }, false)).toBe('tiles/cities/tokyo.webp');

    const connections = { airCityIds: new Set<string>(), seaCityIds: new Set<string>() };
    expect(
      cityTileAssetPath({ id: 'unbuilt-test-town', tier: 3, port: false, airport: true }, true, connections),
    ).toBe('tiles/city/small/town.webp');
    expect(
      cityTileAssetPath({ id: 'unbuilt-test-town', tier: 3, port: false, airport: true }, false, connections),
    ).toBe('tiles/city/town.webp');
  });

  it('describes realm multiplier differences on blue/red squares and city status', () => {
    const hellRed: BoardNode = { id: 'r:hell:1', kind: 'red', x: 100, y: 100, realm: 'hell' };
    const redCard = describeBoardNode(hellRed, null);
    expect(redCard.title).toBe('赤マス');
    expect(redCard.extra).toContain('借金地獄');
    expect(redCard.extra).toContain('×3');

    const tokyoNode: BoardNode = { id: 'c:tokyo', kind: 'city', cityId: 'tokyo', x: 0, y: 0 };
    const cityCard = describeBoardNode(tokyoNode, null);
    expect(cityCard.title).toContain('東京');
    expect(cityCard.iconUrl).toContain('tiles/cities/small/tokyo.webp');
  });
});
