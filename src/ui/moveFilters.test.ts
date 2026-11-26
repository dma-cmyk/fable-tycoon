import { describe, expect, it } from 'vitest';
import {
  countMoveFilters,
  matchesMoveFilter,
  pinErrandFirst,
  type MoveFilterEntry,
} from './moveFilters';

const entry = (overrides: Partial<MoveFilterEntry> & { nodeId: string }): MoveFilterEntry => ({
  kind: 'blue',
  cityId: null,
  affordable: false,
  ...overrides,
});

describe('move quick filters', () => {
  const errand = entry({ nodeId: 'c:bishkek', kind: 'city', cityId: 'bishkek', affordable: false });
  const rows = [
    entry({ nodeId: 'b:1', kind: 'blue' }),
    entry({ nodeId: 'b:2', kind: 'yellow' }),
    entry({ nodeId: 'b:3', kind: 'shop' }),
    entry({ nodeId: 'b:4', kind: 'red' }),
    entry({ nodeId: 'b:5', kind: 'news' }),
    entry({ nodeId: 'b:6', kind: 'warp' }),
    entry({ nodeId: 'c:tokyo', kind: 'city', cityId: 'tokyo', affordable: true }),
    entry({ nodeId: 'c:paris', kind: 'city', cityId: 'paris', affordable: false }),
    errand,
  ];

  it('keeps everything when no filter is active', () => {
    for (const row of rows) expect(matchesMoveFilter('all', row, 'bishkek')).toBe(true);
  });

  it('keeps only cities with an affordable property for 買える駅', () => {
    expect(rows.filter((row) => matchesMoveFilter('affordable', row, 'bishkek')).map((r) => r.nodeId)).toEqual([
      'c:tokyo',
    ]);
  });

  it('keeps blue and card squares for 青・カード', () => {
    expect(rows.filter((row) => matchesMoveFilter('blue-card', row, 'bishkek')).map((r) => r.nodeId)).toEqual([
      'b:1',
      'b:2',
      'b:3',
    ]);
  });

  it('keeps only the reachable errand city for 依頼', () => {
    expect(rows.filter((row) => matchesMoveFilter('errand', row, 'bishkek')).map((r) => r.nodeId)).toEqual([
      'c:bishkek',
    ]);
    expect(rows.filter((row) => matchesMoveFilter('errand', row, null))).toHaveLength(0);
  });

  it('counts each filter over the whole list', () => {
    expect(countMoveFilters(rows, 'bishkek')).toEqual({ affordable: 1, 'blue-card': 3, errand: 1 });
  });
});

describe('errand pinning', () => {
  it('moves the errand to the front and keeps the rest in order', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'errand' }, { id: 'c' }];
    expect(pinErrandFirst(rows, (row) => row.id === 'errand').map((row) => row.id)).toEqual([
      'errand',
      'a',
      'b',
      'c',
    ]);
  });

  it('does not mutate the input and is a no-op without an errand', () => {
    const rows = [{ id: 'a' }, { id: 'b' }];
    expect(pinErrandFirst(rows, (row) => row.id === 'errand').map((row) => row.id)).toEqual(['a', 'b']);
    const pinned = [{ id: 'errand' }, { id: 'a' }];
    expect(pinErrandFirst(pinned, (row) => row.id === 'errand').map((row) => row.id)).toEqual([
      'errand',
      'a',
    ]);
    expect(rows.map((row) => row.id)).toEqual(['a', 'b']);
  });
});