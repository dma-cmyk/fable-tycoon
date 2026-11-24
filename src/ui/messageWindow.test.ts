import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageCursor } from './messageCursor';
import { charsPerPage, pageReadMs, paginateText, postVoicePauseMs, revealMs, scaledPageReadMs } from './messagePages';

// DOM-free core of the window: queue ordering + paging + bounded timing constants.
// (The component needs a browser DOM; the gallery/headless shots cover rendering.)

describe('message window core', () => {
  it('resolves a pushed line only once it has been advanced', () => {
    const cursor = new MessageCursor<string>();
    const shown = vi.fn();
    void cursor.push('long').then(shown);
    expect(cursor.busy).toBe(true);
    cursor.advance();
    expect(cursor.busy).toBe(false);
    expect(shown).not.toHaveBeenCalled(); // still resolves on the microtask queue
  });

  it('clears pending messages with the fx teardown', async () => {
    const cursor = new MessageCursor<string>();
    let resolved = 0;
    void cursor.push('a').then(() => { resolved += 1; });
    void cursor.push('b').then(() => { resolved += 1; });
    cursor.clear();
    await Promise.resolve();
    expect(resolved).toBe(2);
    expect(cursor.busy).toBe(false);
  });
});

describe('message window timing bounds', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('advances an auto message within the read budget', async () => {
    const readMs = pageReadMs('短い台詞');
    let done = false;
    setTimeout(() => { done = true; }, Math.max(220, Math.round(readMs / 8)));
    await vi.advanceTimersByTimeAsync(Math.max(220, Math.round(readMs / 8)) + 10);
    expect(done).toBe(true);
    expect(Math.max(220, Math.round(readMs / 8))).toBeLessThanOrEqual(700);
  });

  it('reveals instantly at high speed / reduced motion', () => {
    expect(revealMs('あ'.repeat(40), 8, false)).toBe(0);
    expect(revealMs('あ'.repeat(40), 1, true)).toBe(0);
  });

  it('bounds the dwell of every page, so a multi-page line cannot stall a CPU turn', () => {
    const page = '世界の果てまで物件を買いあさる。銀行は笑い、取り立て屋は走る。';
    const pages = paginateText(page.repeat(4), 60);
    expect(pages.length).toBeGreaterThan(1);
    for (const p of pages) {
      // Rendering holds each page for pageReadMs/speed, never indefinitely.
      expect(Math.max(240, Math.round(pageReadMs(p) / 8))).toBeLessThanOrEqual(700);
    }
  });

  it('scales page read duration and post-voice pause proportionally with fx speed', () => {
    const line = 'お使いの報酬をもらった。';
    const d1 = scaledPageReadMs(line, 1);
    const d2 = scaledPageReadMs(line, 2);
    const d4 = scaledPageReadMs(line, 4);
    const d8 = scaledPageReadMs(line, 8);
    expect(d2).toBe(Math.round(d1 / 2));
    expect(d4).toBe(Math.round(d1 / 4));
    expect(d8).toBeLessThan(d4);
    expect(postVoicePauseMs(1)).toBeLessThanOrEqual(300);
    expect(postVoicePauseMs(2)).toBe(Math.round(postVoicePauseMs(1) / 2));
    expect(postVoicePauseMs(4)).toBeLessThan(postVoicePauseMs(2));
  });

  it('fits at least one page worth of text for each viewport size', () => {
    const pc = charsPerPage({ width: 560, lines: 3, fontSize: 17 });
    const phone = charsPerPage({ width: 312, lines: 3, fontSize: 15 });
    const landscape = charsPerPage({ width: 430, lines: 2, fontSize: 14 });
    expect(Math.min(pc, phone, landscape)).toBeGreaterThanOrEqual(16);
    expect(paginateText('あ'.repeat(pc + 5), pc).length).toBeGreaterThan(1);
  });
});
