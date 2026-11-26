import { describe, expect, it } from 'vitest';
import type { City } from '../core/types';
import { shortestDistance } from '../core/graph';
import { WARP_MIN_DEST_STEPS, WARP_TOO_CLOSE_REASON } from '../core/warpRules';
import { GAME_DATA } from '../data/index';
import {
  buildWarpCandidates,
  INSIDER_NEAR_STEPS,
  insiderNotice,
  sortWarpCandidates,
  warpDestinationRange,
  warpGainText,
  type WarpCandidate,
} from './warpInfo';

function city(id: string, nameJa: string, nameEn: string): City {
  return {
    id,
    nameJa,
    nameEn,
    country: 'JP',
    countryJa: '日本',
    region: 'east_asia',
    lat: 0,
    lon: 0,
    tier: 2,
    port: false,
    airport: false,
    blurb: '',
    properties: [],
  };
}

/** Distance table keyed `from|to`; missing pairs are Infinity (unreachable). */
function table(entries: Record<string, number>): (from: string, to: string) => number {
  return (from, to) => (from === to ? 0 : (entries[`${from}|${to}`] ?? Number.POSITIVE_INFINITY));
}

describe('buildWarpCandidates', () => {
  const tokyo = city('tokyo', '東京', 'Tokyo');
  const osaka = city('osaka', '大阪', 'Osaka');
  const here = 'c:tokyo';
  const dest = 'c:cairo';

  const distance = table({
    'c:tokyo|c:cairo': 30,
    'c:osaka|c:cairo': 22,
    'c:tokyo|c:osaka': 4,
    'c:tokyo|c:tokyo': 0,
    'c:osaka|c:osaka': 0,
    'c:tokyo|c:cairo ': 30,
  });

  it('computes destination, errand and from-here steps plus the gain', () => {
    const candidates = buildWarpCandidates({
      sources: [
        { nodeId: 'c:osaka', city: osaka },
        { nodeId: 'c:tokyo', city: tokyo },
      ],
      hereNodeId: here,
      destinationNodeId: dest,
      errandNodeId: 'c:osaka',
      distance,
    });
    const osakaRow = candidates.find((c) => c.cityId === 'osaka');
    // Standing still leaves 30 steps; Osaka leaves 22, so the jump saves 8 (negative = closer).
    expect(osakaRow).toMatchObject({
      nodeId: 'c:osaka',
      toDestination: 22,
      toErrand: 0,
      fromHere: 4,
      gain: -8,
    });
    const tokyoRow = candidates.find((c) => c.cityId === 'tokyo');
    expect(tokyoRow).toMatchObject({ toDestination: 30, fromHere: 0, gain: 0 });
  });

  it('ignores the walk to the candidate when measuring the gain', () => {
    // Two cities at the same remaining distance, one of them right next to the player.
    // The gain must compare against the destination only, so both read "no change", and a
    // city that is a detour from the goal must not advertise a gain just because it is near.
    const rows = buildWarpCandidates({
      sources: [
        { nodeId: 'c:osaka', city: osaka },
        { nodeId: 'c:tokyo', city: tokyo },
      ],
      hereNodeId: here,
      destinationNodeId: dest,
      distance: table({
        'c:tokyo|c:cairo': 30,
        'c:osaka|c:cairo': 30,
        'c:tokyo|c:osaka': 1,
      }),
    });
    expect(rows.find((c) => c.cityId === 'osaka')?.gain).toBe(0);
    expect(rows.find((c) => c.cityId === 'tokyo')?.gain).toBe(0);
    expect(rows.find((c) => c.cityId === 'osaka')?.fromHere).toBe(1);
  });

  it('treats unreachable and absent errands as null instead of Infinity', () => {
    const candidates = buildWarpCandidates({
      sources: [{ nodeId: 'c:tokyo', city: tokyo }],
      hereNodeId: here,
      destinationNodeId: dest,
      errandNodeId: 'c:missing',
      distance,
    });
    expect(candidates[0].toErrand).toBeNull();
    expect(candidates[0].toDestination).toBe(30);
    // Standing on the destination city itself, so the jump changes nothing.
    expect(candidates[0].gain).toBe(0);
  });

  it('returns null when the player is in another realm (no path to the world city)', () => {
    const candidates = buildWarpCandidates({
      sources: [{ nodeId: 'c:tokyo', city: tokyo }],
      hereNodeId: 'r:hell:1',
      destinationNodeId: dest,
      distance,
    });
    expect(candidates[0].fromHere).toBeNull();
    expect(candidates[0].gain).toBeNull();
  });
});

describe('sortWarpCandidates', () => {
  const base = (overrides: Partial<WarpCandidate> & { cityId: string }): WarpCandidate => ({
    nodeId: `c:${overrides.cityId}`,
    nameJa: overrides.cityId,
    nameEn: overrides.cityId,
    country: 'JP',
    countryJa: '日本',
    toDestination: null,
    toErrand: null,
    fromHere: null,
    gain: null,
    blocked: false,
    blockedReason: null,
    ...overrides,
  });

  it('sorts by destination distance first and keeps unknown rows last', () => {
    const rows = [
      base({ cityId: 'far', nameJa: 'カイロ', toDestination: 22, fromHere: 30 }),
      base({ cityId: 'unknown', nameJa: 'アテネ', toDestination: null, fromHere: 4 }),
      base({ cityId: 'near', nameJa: '東京', toDestination: 5, fromHere: 12 }),
      base({ cityId: 'tie-far', nameJa: '大阪', toDestination: 5, fromHere: 20 }),
    ];
    expect(sortWarpCandidates(rows, 'distance').map((c) => c.cityId)).toEqual([
      'near',
      'tie-far',
      'far',
      'unknown',
    ]);
  });

  it('sorts by Japanese name without mutating the input', () => {
    const rows = [
      base({ cityId: 'tokyo', nameJa: '東京' }),
      base({ cityId: 'cairo', nameJa: 'カイロ' }),
      base({ cityId: 'osaka', nameJa: '大阪' }),
    ];
    const sorted = sortWarpCandidates(rows, 'name');
    expect(sorted.map((c) => c.cityId)).toEqual(['cairo', 'osaka', 'tokyo']);
    expect(rows.map((c) => c.cityId)).toEqual(['tokyo', 'cairo', 'osaka']);
  });
});

describe('warp copy helpers', () => {
  it('turns the gain into walking copy', () => {
    expect(warpGainText(-12)).toBe('12 マス近づく');
    expect(warpGainText(3)).toBe('3 マス遠のく');
    expect(warpGainText(0)).toBe('今と同じ');
    expect(warpGainText(null)).toBeNull();
  });

  it('reports the landing range of the offered candidates', () => {
    const rows = [
      { toDestination: 10 },
      { toDestination: 5 },
      { toDestination: null },
      { toDestination: 8 },
    ] as WarpCandidate[];
    expect(warpDestinationRange(rows)).toEqual({ min: 5, max: 10 });
    expect(warpDestinationRange([{ toDestination: null } as WarpCandidate])).toBeNull();
  });

  it('warns before an insider redraw when the goal is already near', () => {
    expect(insiderNotice(INSIDER_NEAR_STEPS)).toMatchObject({
      warn: true,
      warnText: '今の方が近いかも',
      distanceText: 'いまの目的地まで 8 マス',
      steps: 8,
    });
    expect(insiderNotice(9).warn).toBe(false);
    expect(insiderNotice(null).warn).toBe(false);
    expect(insiderNotice(40).ruleText).toContain('20 マス以上');
  });
});

describe('warpInfo on the real board', () => {
  const worldCities = GAME_DATA.cities.filter((c) => c.realm === undefined);
  const distance = (from: string, to: string): number => shortestDistance(GAME_DATA, from, to);

  it('offers finite destination distances for every world city and sorts closest first', () => {
    const here = 'c:tokyo';
    const destination = worldCities.find((c) => c.id !== 'tokyo' && c.id !== 'cairo') ?? worldCities[0];
    const rows = buildWarpCandidates({
      sources: worldCities.map((c) => ({ nodeId: `c:${c.id}`, city: c })),
      hereNodeId: here,
      destinationNodeId: `c:${destination.id}`,
      distance,
    });
    expect(rows.length).toBe(worldCities.length);
    for (const row of rows) {
      expect(row.toDestination).not.toBeNull();
      expect(row.fromHere).not.toBeNull();
    }
    const sorted = sortWarpCandidates(rows, 'distance');
    // 目的地の近く（残り3マス以内）は着地できないので、着地可能な候補が先頭・近い順。
    expect(sorted[0].blocked).toBe(false);
    if (sorted[0].blocked) return;
    const bestAllowed = Math.min(
      ...rows.filter((row) => !row.blocked).map((row) => row.toDestination as number),
    );
    expect(sorted[0].toDestination).toBe(bestAllowed);
    expect(bestAllowed).toBeGreaterThanOrEqual(WARP_MIN_DEST_STEPS);
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i].blocked !== sorted[i - 1].blocked) {
        expect(sorted[i].blocked).toBe(true);
        continue;
      }
      expect(sorted[i - 1].toDestination!).toBeLessThanOrEqual(sorted[i].toDestination!);
    }
    expect(warpDestinationRange(rows)?.min).toBeGreaterThanOrEqual(WARP_MIN_DEST_STEPS);
    const near = rows.filter((row) => row.toDestination !== null && row.toDestination < WARP_MIN_DEST_STEPS);
    expect(near.every((row) => row.blocked && row.blockedReason === WARP_TOO_CLOSE_REASON)).toBe(true);
  });

  it('measures the carpet gain from the actual destination distance (Sol: Chicago 13 -> 5)', () => {
    // Sol's playtest: from Seattle, the carpet offered Chicago, which showed 「3マス近づく」
    // while the destination (Atlanta) really went 13 -> 5. The walk to Chicago is 8, but the
    // gain must compare the two destination distances, i.e. 5 - 13 = -8.
    const rows = buildWarpCandidates({
      sources: [{ nodeId: 'c:chicago', city: worldCities.find((c) => c.id === 'chicago')! }],
      hereNodeId: 'c:seattle',
      destinationNodeId: 'c:atlanta',
      distance,
    });
    const [row] = rows;
    expect(row.toDestination).toBe(5);
    expect(row.fromHere).toBe(8);
    expect(row.gain).toBe(-8);
    expect(warpGainText(row.gain)).toBe('8 マス近づく');
  });
});