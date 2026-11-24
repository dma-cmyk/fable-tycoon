import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { estimateSpeechMs, raceWithTimeout, voiceBudgetMs } from './voiceBudget';

describe('voice playback budget', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('uses the decoded buffer duration plus a 1.5s tail', () => {
    expect(voiceBudgetMs(2400, 'こんにちは')).toBe(3900);
  });

  it('falls back to a text-length estimate and never goes below 1.2s', () => {
    const estimate = 900 + 'こんにちは'.length * 110;
    expect(voiceBudgetMs(0, 'こんにちは')).toBe(estimate + 1500);
    expect(estimateSpeechMs('')).toBe(900);
    expect(voiceBudgetMs(0, '')).toBe(2400);
  });

  it('resolves a never-ending voice promise at the timeout', async () => {
    let settled = false;
    const hanging = new Promise<void>(() => undefined);
    void raceWithTimeout(hanging, 2000).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(settled).toBe(true);
  });

  it('resolves early when the voice promise settles', async () => {
    let settled = false;
    void raceWithTimeout(Promise.resolve(), 5000).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
  });
});
