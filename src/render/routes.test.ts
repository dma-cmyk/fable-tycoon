import { describe, expect, it } from 'vitest';
import { airLaneControl, chooseRecommended, hopDistances, lanePointAt, routeModeOf, vehicleForStep } from './routes';

describe('routeModeOf', () => {
  it('keeps known modes and defaults to rail', () => {
    expect(routeModeOf('rail')).toBe('rail');
    expect(routeModeOf('sea')).toBe('sea');
    expect(routeModeOf('air')).toBe('air');
    expect(routeModeOf('teleport')).toBe('rail');
  });
});

describe('air lanes', () => {
  it('bows to one side of the chord and stays capped', () => {
    const short = airLaneControl(0, 0, 100, 0, 0.16, 66);
    expect(short.qx).toBe(50);
    expect(short.qy).toBeCloseTo(16, 5);

    const long = airLaneControl(0, 0, 2000, 0, 0.16, 66);
    expect(long.qx).toBe(1000);
    expect(long.qy).toBeCloseTo(66, 5);
  });

  it('starts and ends on the endpoints with a unit tangent', () => {
    const { qx, qy } = airLaneControl(10, 20, 210, 20);
    const start = lanePointAt(0, 10, 20, qx, qy, 210, 20);
    const end = lanePointAt(1, 10, 20, qx, qy, 210, 20);
    expect(start.x).toBeCloseTo(10, 5);
    expect(start.y).toBeCloseTo(20, 5);
    expect(end.x).toBeCloseTo(210, 5);
    expect(end.y).toBeCloseTo(20, 5);
    expect(Math.hypot(start.hx, start.hy)).toBeCloseTo(1, 5);
    // A lane bowing +y leaves the start heading down and arrives heading up.
    expect(start.hy).toBeGreaterThan(0);
    expect(end.hy).toBeLessThan(0);
  });

  it('degenerates safely for coincident endpoints', () => {
    const arc = airLaneControl(50, 50, 50, 50);
    expect(Number.isFinite(arc.qx)).toBe(true);
    expect(Number.isFinite(arc.qy)).toBe(true);
    const p = lanePointAt(0.5, 50, 50, arc.qx, arc.qy, 50, 50);
    expect(Number.isFinite(p.hx)).toBe(true);
    expect(Number.isFinite(p.hy)).toBe(true);
  });
});

describe('vehicleForStep', () => {
  it('flies air steps regardless of the roll', () => {
    expect(vehicleForStep('air', 1)).toBe('plane');
    expect(vehicleForStep('air', 3)).toBe('plane');
  });

  it('keeps ferries on sea and express tiers on rail', () => {
    expect(vehicleForStep('sea', 3)).toBe('ferry');
    expect(vehicleForStep('rail', 1)).toBe('train');
    expect(vehicleForStep('rail', 2)).toBe('express');
    expect(vehicleForStep('rail', 3)).toBe('bullet_train');
  });
});
describe('hopDistances', () => {
  const edges = [
    { a: 'a', b: 'b' },
    { a: 'b', b: 'c' },
    { a: 'c', b: 'd' },
    { a: 'x', b: 'y' },
  ];

  it('walks edges undirected and skips unreachable nodes', () => {
    const fromD = hopDistances('d', edges);
    expect(fromD.get('d')).toBe(0);
    expect(fromD.get('c')).toBe(1);
    expect(fromD.get('b')).toBe(2);
    expect(fromD.get('a')).toBe(3);
    expect(fromD.has('x')).toBe(false);
  });

  it('still reports the origin for an isolated start', () => {
    const alone = hopDistances('nope', edges);
    expect(alone.size).toBe(1);
    expect(alone.get('nope')).toBe(0);
  });

  it('handles a single-node graph', () => {
    expect(hopDistances('a', []).get('a')).toBe(0);
  });
});

describe('chooseRecommended', () => {
  const candidates = [
    { id: 'blue-1', kind: 'blue' },
    { id: 'city-1', kind: 'city' },
    { id: 'city-2', kind: 'city' },
    { id: 'far', kind: 'city' },
    { id: 'island', kind: 'city' },
  ];
  const distances = new Map([
    ['blue-1', 4],
    ['city-1', 2],
    ['city-2', 2],
    ['far', 9],
  ]);

  it('picks the shortest remaining hops and prefers a station on ties', () => {
    expect(chooseRecommended(candidates, distances)?.id).toBe('city-1');
  });

  it('falls back to a non-station when it is strictly closer', () => {
    const near = new Map([
      ['blue-1', 1],
      ['city-1', 2],
    ]);
    expect(chooseRecommended(candidates, near)?.id).toBe('blue-1');
  });

  it('returns null when nothing is reachable', () => {
    expect(chooseRecommended(candidates, new Map())).toBeNull();
  });
});
