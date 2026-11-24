import { describe, expect, it, vi } from 'vitest';
import { FxPlayer, type FxPlayerHost } from './fxPlayer';
import type { PublicState } from '../core/engine';
import type { UiSettings } from './settings';

const settings: UiSettings = { fxSpeed: 8, autoAdvance: true, showChat: true, reducedMotion: false };

function host() {
  const applied: number[] = [];
  const cleanup = vi.fn();
  let release: (() => void) | null = null;
  const impl: FxPlayerHost = {
    settings: () => settings,
    handleFx: (_fx, _state, control) => {
      control.onSkip(cleanup);
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

const state = { current: 0, players: [] } as unknown as PublicState;

describe('FxPlayer reset', () => {
  it('runs registered presentation cleanups and resolves the pending fx', async () => {
    const h = host();
    const player = new FxPlayer(h.impl);
    player.enqueue({ seq: 1, fx: [{ t: 'toast', text: 'x' }], state, deadline: null, gen: 1 });
    await Promise.resolve();
    player.reset();
    // The interrupted handler is resolved: its cleanup ran exactly once, and no state was applied.
    expect(h.cleanup).toHaveBeenCalledTimes(1);
    expect(h.applied).toEqual([]);
    expect(player.busy).toBe(false);
    player.destroy();
  });

  it('runs cleanups on skip', async () => {
    const h = host();
    const player = new FxPlayer(h.impl);
    player.enqueue({ seq: 2, fx: [{ t: 'toast', text: 'x' }], state, deadline: null, gen: 1 });
    await Promise.resolve();
    expect(player.skip()).toBe(true);
    expect(h.cleanup).toHaveBeenCalledTimes(1);
    player.destroy();
  });
});
