import { describe, expect, it } from 'vitest';
import { charsPerPage, pageReadMs, paginateText, revealMs } from './messagePages';

describe('message window paging', () => {
  it('fits short text on one page', () => {
    expect(paginateText('こんにちは。', 40)).toEqual(['こんにちは。']);
  });

  it('breaks long text on sentence punctuation', () => {
    const text = '一つ目の文です。二つ目の文です。三つ目の文です。';
    const pages = paginateText(text, 14);
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) expect(page.length).toBeLessThanOrEqual(14);
    expect(pages.join('')).toBe(text);
  });

  it('falls back to a hard cut when there is no punctuation', () => {
    const pages = paginateText('あ'.repeat(30), 12);
    expect(pages).toHaveLength(3);
    expect(pages.every((page) => page.length <= 12)).toBe(true);
  });

  it('computes capacity from width, lines and font size', () => {
    expect(charsPerPage({ width: 340, lines: 2, fontSize: 15 })).toBeGreaterThan(30);
    expect(charsPerPage({ width: 100, lines: 1, fontSize: 17 })).toBeGreaterThanOrEqual(16);
  });

  it('keeps read time and reveal bounded', () => {
    expect(pageReadMs('')).toBeGreaterThanOrEqual(1100);
    expect(pageReadMs('あ'.repeat(500))).toBeLessThanOrEqual(5200);
    expect(revealMs('あ'.repeat(100), 1, false)).toBeLessThanOrEqual(900);
    expect(revealMs('あ'.repeat(100), 4, false)).toBe(0);
    expect(revealMs('あ', 1, true)).toBe(0);
  });
});
