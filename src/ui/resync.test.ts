import { describe, expect, it } from 'vitest';
import { canonicalState, isIdenticalResync, shouldInterruptForResync } from './resync';

const state = {
  current: 1,
  phase: { t: 'choose_dest', options: [{ nodeId: 'b', path: ['a', 'b'] }] },
  players: [
    { id: 0, nodeId: 'a', cash: 120 },
    { id: 1, nodeId: 'b', cash: 90 },
  ],
};

describe('resync snapshot policy', () => {
  it('adopts the first snapshot without cancelling anything', () => {
    expect(shouldInterruptForResync(null, { gen: 1, seq: 4, state })).toBe(false);
  });

  it('does not interrupt an identical same-(gen,seq) resync', () => {
    const previous = { gen: 1, seq: 4, state };
    const next = { gen: 1, seq: 4, state: JSON.parse(JSON.stringify(state)) };
    expect(shouldInterruptForResync(previous, next)).toBe(false);
    expect(isIdenticalResync(previous, next)).toBe(true);
  });

  it('ignores key order when comparing identical state', () => {
    const reordered = {
      players: state.players,
      phase: state.phase,
      current: state.current,
    };
    expect(canonicalState(reordered)).toBe(canonicalState(state));
    expect(shouldInterruptForResync({ gen: 2, seq: 9, state }, { gen: 2, seq: 9, state: reordered })).toBe(false);
  });

  it('interrupts when a same-(gen,seq) resync carries diverged state', () => {
    const diverged = { ...state, players: [{ ...state.players[0], cash: 119 }, state.players[1]] };
    expect(shouldInterruptForResync({ gen: 1, seq: 4, state }, { gen: 1, seq: 4, state: diverged })).toBe(true);
  });

  it('interrupts on a generation change even with identical state', () => {
    expect(shouldInterruptForResync({ gen: 1, seq: 4, state }, { gen: 2, seq: 4, state })).toBe(true);
  });

  it('interrupts on a seq change', () => {
    expect(shouldInterruptForResync({ gen: 1, seq: 4, state }, { gen: 1, seq: 5, state })).toBe(true);
  });
});
