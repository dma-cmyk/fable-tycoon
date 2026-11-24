import { afterEach, describe, expect, it, vi } from 'vitest';
import { estimateFxDurationMs, FxPlayer, type FxPlayerHost } from './fxPlayer';
import type { PublicState } from '../core/engine';
import type { UiSettings } from './settings';

const settings: UiSettings = { fxSpeed: 8, autoAdvance: true, showChat: true, reducedMotion: false };
const state = { current: 0, players: [] } as unknown as PublicState;
const toastFx = { t: 'toast', text: 'x' } as const;

function host(hang = true) {
  const applied: number[] = [];
  const cleanup = vi.fn();
  let release: (() => void) | null = null;
  const impl: FxPlayerHost = {
    settings: () => settings,
    handleFx: (_fx, _state, control) => {
      control.onSkip(cleanup);
      if (!hang) return Promise.resolve();
      const { promise, resolve } = Promise.withResolvers<void>();
      release = resolve;
      return promise;
    },
    applyState: (_state, _deadline, seq) => applied.push(seq),
    setBusy: () => undefined,
    setSkippable: () => undefined,
    onQueueChange: () => undefined,
  };
  return { impl, cleanup, applied, release: () => release?.() };
}

describe('FxPlayer reset', () => {
  it('runs registered presentation cleanups and resolves the pending fx', async () => {
    const h = host();
    const player = new FxPlayer(h.impl);
    player.enqueue({ seq: 1, fx: [toastFx], state, deadline: null, gen: 1 });
    await Promise.resolve();
    player.reset();
    expect(h.cleanup).toHaveBeenCalledTimes(1);
    expect(h.applied).toEqual([]);
    expect(player.busy).toBe(false);
    player.destroy();
  });

  it('runs cleanups on skip', async () => {
    const h = host();
    const player = new FxPlayer(h.impl);
    player.enqueue({ seq: 2, fx: [toastFx], state, deadline: null, gen: 1 });
    await Promise.resolve();
    expect(player.skip()).toBe(true);
    expect(h.cleanup).toHaveBeenCalledTimes(1);
    player.destroy();
  });
});

describe('FxPlayer watchdog', () => {
  afterEach(() => vi.useRealTimers());

  it('applies the end state when one update never settles', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = host(true);
    const player = new FxPlayer(h.impl);
    player.enqueue({ seq: 7, fx: [toastFx], state, deadline: null, gen: 1 });
    await vi.advanceTimersByTimeAsync(50);
    expect(h.applied).toEqual([]);
    const budget = estimateFxDurationMs(toastFx) * 2 + 5000;
    await vi.advanceTimersByTimeAsync(budget + 50);
    expect(h.applied).toEqual([7]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(player.busy).toBe(false);
    player.destroy();
    warn.mockRestore();
  });
});

describe('FxPlayer backlog pruning', () => {
  it('drops queued updates the snapshot already covers', async () => {
    const h = host(false);
    const player = new FxPlayer(h.impl);
    player.enqueue({ seq: 1, fx: [toastFx], state, deadline: null, gen: 1 });
    player.enqueue({ seq: 2, fx: [toastFx], state, deadline: null, gen: 1 });
    player.enqueue({ seq: 5, fx: [toastFx], state, deadline: null, gen: 1 });
    await Promise.resolve();
    expect(player.dropThrough(1, 2)).toBe(1); // seq 5 stays
    expect(player.dropThrough(2, 0)).toBe(1); // older generation is dropped
    expect(player.pending).toBeLessThan(2);
    player.destroy();
  });
});

describe('estimateFxDurationMs', () => {
  it('scales say by text length and move by path length', () => {
    expect(estimateFxDurationMs({ t: 'say', speaker: 'narrator', text: 'あ'.repeat(10) })).toBe(700 + 95 * 10);
    expect(estimateFxDurationMs({ t: 'move', playerId: 0, path: ['a', 'b', 'c'], dice: 1 })).toBe(230 * 3);
  });
});
