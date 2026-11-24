import { describe, expect, it } from 'vitest';
import { GAME_DATA } from '../data/index';
import { formatCompletedTurns, formatTurnLabel } from './format';

describe('turn count formatting (#6)', () => {
  it('aligns HUD turn label and result total turns for 1-year and 3-year games', () => {
    // 1-year game: 12 months played (round 0..11), settleYear increments round to 12.
    expect(formatTurnLabel(0, 1)).toBe('1 / 12');
    expect(formatTurnLabel(11, 1)).toBe('12 / 12');
    expect(formatTurnLabel(12, 1)).toBe('12 / 12');
    expect(formatCompletedTurns(12, 1, 'game_over')).toBe(12);
    expect(formatCompletedTurns(12, 1, 'year_end')).toBe(12);

    // 3-year game: 36 months played, ends with round === 36.
    expect(formatTurnLabel(35, 3)).toBe('36 / 36');
    expect(formatCompletedTurns(36, 3, 'game_over')).toBe(36);
  });
});

describe('cards.json copy alignment (#5)', () => {
  it('describes express2 accurately as choosing destination with 2 dice (no misleading cannot-choose text)', () => {
    const express2 = GAME_DATA.cards.find((card) => card.id === 'express2');
    expect(express2).toBeDefined();
    expect(express2?.desc).toContain('2個');
    expect(express2?.desc).not.toContain('選べない');
  });
});
