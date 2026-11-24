import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { estimateSpeechMs, MAX_VOICE_RATE, raceWithTimeout, voiceBudgetMs, voicePlaybackRate } from './voiceBudget';

describe('voice playback budget', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('uses the decoded buffer duration plus a 1.5s tail', () => {
    expect(voiceBudgetMs(2400, 'こんにちは')).toBe(3900);
  });

  it('falls back to a text-length estimate and never goes below 1.2s at 1x', () => {
    const estimate = 900 + 'こんにちは'.length * 110;
    expect(voiceBudgetMs(0, 'こんにちは')).toBe(estimate + 1500);
    expect(estimateSpeechMs('')).toBe(900);
    expect(voiceBudgetMs(0, '')).toBe(2400);
  });

  it('scales the budget proportionally with fx speed', () => {
    const base = voiceBudgetMs(2400, 'こんにちは', 1);
    const fast2 = voiceBudgetMs(2400, 'こんにちは', 2);
    const fast4 = voiceBudgetMs(2400, 'こんにちは', 4);
    const fast8 = voiceBudgetMs(2400, 'こんにちは', 8);
    expect(fast2).toBe(Math.round(base / 2));
    expect(fast4).toBe(Math.round(base / 4));
    expect(fast8).toBeLessThan(fast4);
    expect(fast8).toBeGreaterThanOrEqual(320);
  });

  it('caps voice playback speed-up so fast fx speeds do not raise the pitch much', () => {
    expect(voicePlaybackRate(1)).toBe(1);
    expect(voicePlaybackRate(undefined)).toBe(1);
    expect(voicePlaybackRate(8)).toBe(MAX_VOICE_RATE);
    expect(MAX_VOICE_RATE).toBeLessThanOrEqual(1.25);
    // A line budgeted at the capped rate is never shorter than the audio actually takes.
    const durationMs = 3000;
    expect(voiceBudgetMs(durationMs, '', voicePlaybackRate(8))).toBeGreaterThan(durationMs / MAX_VOICE_RATE);
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
