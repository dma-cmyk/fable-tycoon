import { afterEach, describe, expect, it, vi } from 'vitest';
import { estimateFxDurationMs, FxPlayer, slowUpdateBudgetMs, type FxPlayerHost } from './fxPlayer';
import { FX_MS } from '../net/session-types';
import type { PublicState } from '../core/engine';
import type { Fx } from '../core/types';
import type { FxSpeed, UiSettings } from './settings';

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

  it('skips all remaining fx in the current update on skipUpdate() and applies state immediately', async () => {
    const seen: string[] = [];
    const applied: number[] = [];
    let release!: () => void;
    const player = new FxPlayer({
      settings: () => settings,
      handleFx: (fx, _state, control) => {
        seen.push(fx.t);
        const { promise, resolve } = Promise.withResolvers<void>();
        release = resolve;
        control.onSkip(resolve);
        return promise;
      },
      applyState: (_s, _d, seq) => applied.push(seq),
      setBusy: () => undefined,
      setSkippable: () => undefined,
      onQueueChange: () => undefined,
    });
    player.enqueue({
      seq: 9,
      fx: [
        { t: 'event_open', eventId: 'e1', playerId: 0 },
        { t: 'say', speaker: 'narrator', text: 'line1' },
        { t: 'say', speaker: 'narrator', text: 'line2' },
      ],
      state,
      deadline: null,
      gen: 1,
    });
    await Promise.resolve();
    expect(seen).toEqual(['event_open']);
    expect(player.skipUpdate()).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual(['event_open']);
    expect(applied).toEqual([9]);
    expect(player.busy).toBe(false);
    release();
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
    const budget = estimateFxDurationMs(toastFx) * 2 + 8000;
    await vi.advanceTimersByTimeAsync(budget + 50);
    expect(h.applied).toEqual([7]);
    expect(h.cleanup).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(player.busy).toBe(false);
    player.destroy();
    warn.mockRestore();
  });

  it('adopts the NEWEST queued update (not the stalled head) when watchdog fires so CPU turns never deadlock', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = host(true);
    const player = new FxPlayer(h.impl);
    const cpuState = { current: 3, players: [] } as unknown as PublicState;
    const humanState = { current: 0, players: [] } as unknown as PublicState;
    const appliedStates: PublicState[] = [];
    h.impl.applyState = (s, _d, seq) => {
      h.applied.push(seq);
      appliedStates.push(s);
    };
    player.enqueue({ seq: 47, fx: [toastFx], state: cpuState, deadline: null, gen: 1 });
    player.enqueue({ seq: 48, fx: [toastFx], state: cpuState, deadline: null, gen: 1 });
    player.enqueue({ seq: 50, fx: [toastFx], state: humanState, deadline: null, gen: 1 });
    await vi.advanceTimersByTimeAsync(50);
    const budget = estimateFxDurationMs(toastFx) * 2 + 8000;
    await vi.advanceTimersByTimeAsync(budget + 50);
    expect(h.applied).toEqual([50]);
    expect(appliedStates).toEqual([humanState]);
    expect(h.cleanup).toHaveBeenCalledTimes(1);
    expect(player.busy).toBe(false);
    player.destroy();
    warn.mockRestore();
  });

  it('pauses the watchdog during intentional manual-advance waiting and resumes afterwards', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const applied: number[] = [];
    let release!: () => void;
    const player = new FxPlayer({
      settings: () => ({ ...settings, autoAdvance: false }),
      handleFx: async (_fx, _state, control) => {
        control.setManualWait(true);
        await new Promise<void>((resolve) => { release = resolve; });
        control.setManualWait(false);
      },
      applyState: (_s, _d, seq) => applied.push(seq),
      setBusy: () => undefined,
      setSkippable: () => undefined,
      onQueueChange: () => undefined,
    });
    player.enqueue({ seq: 11, fx: [toastFx], state, deadline: null, gen: 1 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(warn).not.toHaveBeenCalled();
    expect(applied).toEqual([]);
    expect(player.busy).toBe(true);
    release();
    await vi.advanceTimersByTimeAsync(10);
    expect(applied).toEqual([11]);
    expect(player.busy).toBe(false);
    player.destroy();
    warn.mockRestore();
  });

  it('preserves the new epoch watchdog and isolates stale PlaybackControl after reset()', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const onWatchdog = vi.fn();
    const applied: Array<{ seq: number; gen: number | undefined }> = [];
    let staleControlSkippedAfterReset = false;
    let releaseFirst!: () => void;
    let call = 0;

    const player = new FxPlayer({
      settings: () => settings,
      handleFx: async (_fx, _state, control) => {
        call += 1;
        if (call === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
          // After reset(), stale control MUST report skipped=true and MUST NOT pause the new epoch's watchdog.
          staleControlSkippedAfterReset = control.skipped;
          control.setManualWait(true);
          return;
        }
        return new Promise<void>(() => undefined);
      },
      applyState: (_s, _d, seq, gen) => applied.push({ seq, gen }),
      setBusy: () => undefined,
      setSkippable: () => undefined,
      onQueueChange: () => undefined,
      onWatchdog,
    });

    player.enqueue({ seq: 1, fx: [toastFx], state, deadline: null, gen: 1 });
    player.reset();
    player.enqueue({ seq: 2, fx: [toastFx], state, deadline: null, gen: 2 });
    releaseFirst();
    await Promise.resolve();
    await Promise.resolve();

    expect(staleControlSkippedAfterReset).toBe(true);
    const budget = estimateFxDurationMs(toastFx) * 2 + 8000;
    await vi.advanceTimersByTimeAsync(budget + 100);
    expect(player.busy).toBe(false);
    expect(applied).toEqual([{ seq: 2, gen: 2 }]);
    expect(onWatchdog).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    player.destroy();
    warn.mockRestore();
  });

  it('does not wedge in busy state if applyState throws and compresses obsolete backlog updates', async () => {
    const seenSeqs: number[] = [];
    const appliedSeqs: number[] = [];
    let throwOnce = true;
    const player = new FxPlayer({
      settings: () => settings,
      handleFx: async (_fx, state) => {
        seenSeqs.push(state.current);
        await Promise.resolve();
      },
      applyState: (_s, _d, seq) => {
        if (throwOnce) {
          throwOnce = false;
          throw new Error('simulated DOM applyState failure');
        }
        appliedSeqs.push(seq);
      },
      setBusy: () => undefined,
      setSkippable: () => undefined,
      onQueueChange: () => undefined,
    });

    const s = (n: number) => ({ current: n, players: [] }) as unknown as PublicState;
    player.enqueue({ seq: 10, fx: [toastFx], state: s(10), deadline: null, gen: 1 });
    player.enqueue({ seq: 11, fx: [toastFx], state: s(11), deadline: null, gen: 1 });
    player.enqueue({ seq: 12, fx: [toastFx], state: s(12), deadline: null, gen: 1 });
    player.enqueue({ seq: 13, fx: [toastFx], state: s(13), deadline: null, gen: 1 });

    await new Promise((r) => setTimeout(r, 50));
    expect(player.busy).toBe(false);
    // Intermediate stale updates (11, 12) compressed so we jumped directly to the latest update (13).
    expect(appliedSeqs).toEqual([13]);
    expect(seenSeqs).toEqual([10, 13]);
    player.destroy();
  });

  it('exposes live backlog count on PlaybackControl so voice-heavy cutscenes stop blocking while behind', async () => {
    const backlogs: number[] = [];
    const releases: Array<() => void> = [];
    const player = new FxPlayer({
      settings: () => ({ ...settings, fxSpeed: 1 }),
      handleFx: (_fx, _state, control) => {
        backlogs.push(control.backlog);
        const { promise, resolve } = Promise.withResolvers<void>();
        releases.push(resolve);
        return promise;
      },
      applyState: () => undefined,
      setBusy: () => undefined,
      setSkippable: () => undefined,
      onQueueChange: () => undefined,
    });

    player.enqueue({ seq: 1, fx: [toastFx], state, deadline: null, gen: 1 });
    expect(backlogs).toEqual([0]);
    player.enqueue({ seq: 2, fx: [toastFx], state, deadline: null, gen: 1 });
    player.enqueue({ seq: 3, fx: [toastFx], state, deadline: null, gen: 1 });
    releases.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(backlogs).toEqual([0, 1]);
    releases.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(backlogs).toEqual([0, 1, 0]);
    releases.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(player.busy).toBe(false);
    player.destroy();
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
  it('scales say by text length and move by path length, and budgets destination voice playback', () => {
    expect(estimateFxDurationMs({ t: 'say', speaker: 'narrator', text: 'あ'.repeat(10) })).toBe(
      FX_MS.sayBase + FX_MS.sayPerChar * 10,
    );
    expect(estimateFxDurationMs({ t: 'move', playerId: 0, path: ['a', 'b', 'c'], dice: 1 })).toBe(
      FX_MS.moveStep * 3,
    );
    expect(estimateFxDurationMs({ t: 'destination', cityId: 'tokyo' })).toBeGreaterThanOrEqual(3200);
  });
});

describe('FxPlayer scaled waits', () => {
  afterEach(() => vi.useRealTimers());

  it('divides control.wait by the current fx speed: 8x resolves inside a frame, 1x does not', async () => {
    vi.useFakeTimers();
    // A 3s nominal fx so the update's own budget never clamps the 2s wait.
    const longFx: Fx = { t: 'final_year', year: 1, rules: [] };
    const finished = new Map<number, boolean>();
    const makePlayer = (fxSpeed: FxSpeed) => {
      const player = new FxPlayer({
        settings: () => ({ ...settings, fxSpeed }),
        handleFx: (_fx, _state, control) =>
          control.wait(2000).then(() => {
            finished.set(fxSpeed, true);
          }),
        applyState: () => undefined,
        setBusy: () => undefined,
        setSkippable: () => undefined,
        onQueueChange: () => undefined,
      });
      player.enqueue({ seq: 1, fx: [longFx], state, deadline: null, gen: 1 });
      return player;
    };
    const fast = makePlayer(8);
    const slow = makePlayer(1);
    // 2000 / 8 = 250ms scaled; 2000 / 1 = 2000ms. Advance a middle amount.
    await vi.advanceTimersByTimeAsync(700);
    expect(finished.get(8)).toBe(true);
    expect(finished.get(1)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2000);
    expect(finished.get(1)).toBe(true);
    fast.destroy();
    slow.destroy();
  });

  it('resolves control.bound without the awaited promise ever settling', async () => {
    vi.useFakeTimers();
    const outcomes: string[] = [];
    const player = new FxPlayer({
      settings: () => ({ ...settings, fxSpeed: 8 }),
      handleFx: async (fx, _state, control) => {
        await control.bound(new Promise<void>(() => undefined), fx.t === 'buy' ? 1600 : 8000);
        outcomes.push(fx.t);
      },
      applyState: () => undefined,
      setBusy: () => undefined,
      setSkippable: () => undefined,
      onQueueChange: () => undefined,
    });
    player.enqueue({
      seq: 1,
      fx: [{ t: 'buy', playerId: 0, propertyId: 'p', monopoly: false }, toastFx],
      state,
      deadline: null,
      gen: 1,
    });
    // 1600 / 8 = 200ms and 8000 / 8 = 1000ms scaled, so both give up before settling.
    await vi.advanceTimersByTimeAsync(1400);
    expect(outcomes).toEqual(['buy', 'toast']);
    expect(player.busy).toBe(false);
    player.destroy();
  });

  it('returns from control.bound immediately on skip', async () => {
    const finished: string[] = [];
    const player = new FxPlayer({
      settings: () => ({ ...settings, fxSpeed: 1 }),
      handleFx: async (fx, _state, control) => {
        await control.bound(new Promise<void>(() => undefined), 60_000);
        finished.push(fx.t);
      },
      applyState: () => undefined,
      setBusy: () => undefined,
      setSkippable: () => undefined,
      onQueueChange: () => undefined,
    });
    player.enqueue({ seq: 1, fx: [toastFx], state, deadline: null, gen: 1 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(finished).toEqual([]);
    player.skip();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(finished).toEqual(['toast']);
    player.destroy();
  });
});

describe('FxPlayer slow update net', () => {
  afterEach(() => vi.useRealTimers());

  it('adopts the newest state and warns once when an update outruns 3x its scaled budget', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const applied: number[] = [];
    let release!: () => void;
    const player = new FxPlayer({
      settings: () => ({ ...settings, fxSpeed: 8 }),
      handleFx: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      applyState: (_s, _d, seq) => applied.push(seq),
      setBusy: () => undefined,
      setSkippable: () => undefined,
      onQueueChange: () => undefined,
    });
    const slowMs = slowUpdateBudgetMs([toastFx], 8);
    player.enqueue({ seq: 3, fx: [toastFx], state, deadline: null, gen: 1 });
    player.enqueue({ seq: 4, fx: [toastFx], state, deadline: null, gen: 1 });
    await vi.advanceTimersByTimeAsync(slowMs - 100);
    expect(applied).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(applied).toEqual([4]);
    expect(player.slowUpdates).toBe(1);
    expect(warn.mock.calls.filter((call) => String(call[0]).startsWith('[fx] slow update'))).toHaveLength(1);
    // Advancing past the emergency watchdog must not fire a second give-up.
    await vi.advanceTimersByTimeAsync(estimateFxDurationMs(toastFx) * 2 + 9000);
    expect(applied).toEqual([4]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(player.busy).toBe(false);
    release?.();
    player.destroy();
    warn.mockRestore();
  });

  it('never cuts a 1x update that is still inside its nominal budget', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const applied: number[] = [];
    const sayFx = { t: 'say', speaker: 'narrator', text: 'あ'.repeat(30) } as const;
    const player = new FxPlayer({
      settings: () => ({ ...settings, fxSpeed: 1 }),
      handleFx: (_fx, _state, control) => control.wait(estimateFxDurationMs(sayFx)),
      applyState: (_s, _d, seq) => applied.push(seq),
      setBusy: () => undefined,
      setSkippable: () => undefined,
      onQueueChange: () => undefined,
    });
    player.enqueue({ seq: 1, fx: [sayFx], state, deadline: null, gen: 1 });
    await vi.advanceTimersByTimeAsync(estimateFxDurationMs(sayFx) + 200);
    expect(applied).toEqual([1]);
    expect(player.slowUpdates).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    player.destroy();
    warn.mockRestore();
  });

  it('scales the slow budget with speed but never below the frame floor', () => {
    const big = Array.from({ length: 12 }, () => ({ t: 'cash', playerId: 0, delta: 1, reason: '青マス' }) as const);
    const slow1 = slowUpdateBudgetMs(big, 1);
    const slow8 = slowUpdateBudgetMs(big, 8);
    expect(slow1).toBe(Math.round(12 * FX_MS.cash * 3));
    expect(slow8).toBeGreaterThanOrEqual(2500);
    expect(slow8).toBeLessThan(slow1);
    expect(slowUpdateBudgetMs([], 8)).toBe(2500);
  });

  it('does not fire either net while the player is intentionally waiting for manual advance', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const applied: number[] = [];
    let release!: () => void;
    const player = new FxPlayer({
      settings: () => ({ ...settings, fxSpeed: 8, autoAdvance: false }),
      handleFx: async (_fx, _state, control) => {
        control.setManualWait(true);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        control.setManualWait(false);
      },
      applyState: (_s, _d, seq) => applied.push(seq),
      setBusy: () => undefined,
      setSkippable: () => undefined,
      onQueueChange: () => undefined,
    });
    player.enqueue({ seq: 9, fx: [toastFx], state, deadline: null, gen: 1 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(applied).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    release();
    await vi.advanceTimersByTimeAsync(20);
    expect(applied).toEqual([9]);
    expect(player.busy).toBe(false);
    player.destroy();
    warn.mockRestore();
  });
});

describe('FxPlayer backlog cut-in', () => {
  it('ends a full-screen cut-in as soon as two newer updates are queued', async () => {
    vi.useFakeTimers();
    const cleanup = vi.fn();
    const finished: string[] = [];
    const player = new FxPlayer({
      settings: () => ({ ...settings, fxSpeed: 1 }),
      handleFx: async (fx, _state, control) => {
        control.onSkip(cleanup);
        await control.wait(6000);
        finished.push(fx.t);
      },
      applyState: () => undefined,
      setBusy: () => undefined,
      setSkippable: () => undefined,
      onQueueChange: () => undefined,
    });
    player.enqueue({ seq: 1, fx: [{ t: 'skill', playerId: 0, characterId: 'c', name: 's' }], state, deadline: null, gen: 1 });
    await Promise.resolve();
    expect(player.busy).toBe(true);
    player.enqueue({ seq: 2, fx: [toastFx], state, deadline: null, gen: 1 });
    expect(cleanup).not.toHaveBeenCalled();
    player.enqueue({ seq: 3, fx: [toastFx], state, deadline: null, gen: 1 });
    expect(cleanup).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(finished).toEqual(['skill']);
    player.skipUpdate();
    player.destroy();
  });
});
