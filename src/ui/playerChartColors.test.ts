import { describe, expect, it } from 'vitest';
import {
  colorDistance,
  MIN_CHART_COLOR_DISTANCE,
  parseHexRgb,
  resolveDistinctColors,
  resolvePlayerChartColors,
} from './playerChartColors';

describe('playerChartColors', () => {
  it('gives Momotaro and Red Riding Hood clearly distinct colors in the default 4-player cast', () => {
    const colors = resolvePlayerChartColors([
      { characterId: 'momotaro' },
      { characterId: 'red_hood' },
      { characterId: 'aladdin' },
      { characterId: 'kaguya' },
    ]);
    expect(colors).toHaveLength(4);
    expect(new Set(colors).size).toBe(4);
    for (let i = 0; i < colors.length; i++) {
      for (let j = i + 1; j < colors.length; j++) {
        const a = parseHexRgb(colors[i])!;
        const b = parseHexRgb(colors[j])!;
        expect(colorDistance(a, b)).toBeGreaterThanOrEqual(MIN_CHART_COLOR_DISTANCE);
      }
    }
  });

  it('preserves character colors when all players already have distinct legible hues', () => {
    const base = ['#e63946', '#1d70d8', '#159947', '#d97706'];
    expect(resolveDistinctColors(base)).toEqual(base);
  });

  it('separates four players who all share red hues into four distinct high-contrast colors', () => {
    const colors = resolveDistinctColors(['#e63946', '#d62828', '#dc2626', '#ef4444']);
    expect(new Set(colors).size).toBe(4);
    for (let i = 0; i < colors.length; i++) {
      for (let j = i + 1; j < colors.length; j++) {
        const a = parseHexRgb(colors[i])!;
        const b = parseHexRgb(colors[j])!;
        expect(colorDistance(a, b)).toBeGreaterThanOrEqual(MIN_CHART_COLOR_DISTANCE);
      }
    }
  });
});
