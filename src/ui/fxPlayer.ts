import type { PublicState } from '../core/engine';
import type {Fx} from '../core/types';
import type { UiSettings } from './settings';

/**
 * Plays ServerMsg.update fx sequentially, then adopts the authoritative state.
 * Presentation handlers live in the host (GameScreen); this class only owns ordering,
 * speed-up, skip and the queue.
 */

export interface FxUpdate {
  seq: number;
  fx: Fx[];
  state: PublicState;
  deadline: number | null;
  gen?: number;
}

export interface PlaybackControl {
  /** Waits `ms` scaled by the current presentation speed. Resolves early when the user skips. */
  wait(ms: number): Promise<void>;
  /** Waits until the user taps / presses skip (used by 台詞自動送りオフ). */
  waitManual(): Promise<void>;
  /** Registers a cleanup/stop callback for the current fx; invoked exactly once on skip. */
  onSkip(callback: () => void): () => void;
  readonly skipped: boolean;
  readonly speed: number;
}

export interface FxPlayerHost {
  settings(): UiSettings;
  handleFx(fx: Fx, state: PublicState, control: PlaybackControl): Promise<void> | void;
  applyState(state: PublicState, deadline: number | null, seq: number, gen?: number): void;
  setBusy(busy: boolean): void;
  setSkippable(skippable: boolean): void;
  onQueueChange(pending: number): void;
}

interface ActiveWait {
  resolve: () => void;
  timer: number;
}

export class FxPlayer {
  private queue: FxUpdate[] = [];
  private running = false;
  private active: ActiveWait | null = null;
  private manualResolve: (() => void) | null = null;
  private skipCallbacks = new Set<() => void>();
  private skipRequested = false;
  private destroyed = false;
  private epoch = 0;

  constructor(private readonly host: FxPlayerHost) {}

  get busy(): boolean {
    return this.running || this.queue.length > 0;
  }

  get pending(): number {
    return this.queue.length + (this.running ? 1 : 0);
  }

  enqueue(update: FxUpdate): void {
    if (this.destroyed) return;
    this.queue.push(update);
    this.host.onQueueChange(this.queue.length);
    void this.pump();
  }

  /**
   * Snapshot / reconnect: abandon animations and apply immediately.
   * Registered presentation cleanups are run (not dropped) so an interrupted voice line,
   * dice overlay or similar does not outlive the state it belonged to.
   */
  reset(): void {
    this.epoch++;
    this.runSkipCallbacks();
    this.queue = [];
    this.finishActive();
    this.skipRequested = false;
    this.running = false;
    this.host.setBusy(false);
    this.host.setSkippable(false);
    this.host.onQueueChange(0);
  }

  skip(): boolean {
    if (!this.running) return false;
    this.skipRequested = true;
    this.runSkipCallbacks();
    this.finishActive();
    return true;
  }

  private runSkipCallbacks(): void {
    const callbacks = [...this.skipCallbacks];
    this.skipCallbacks.clear();
    for (const callback of callbacks) {
      try {
        callback();
      } catch {
        /* presentation cleanup must not break the queue */
      }
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.reset();
  }

  private finishActive(): void {
    if (this.active) {
      window.clearTimeout(this.active.timer);
      const { resolve } = this.active;
      this.active = null;
      resolve();
    }
    if (this.manualResolve) {
      const resolve = this.manualResolve;
      this.manualResolve = null;
      resolve();
    }
  }

  private speedFactor(): number {
    const settings = this.host.settings();
    const backlog = this.queue.length;
    // DESIGN/UI: once two or more updates are waiting, play at 2x even if the setting is 1x.
    return Math.max(settings.fxSpeed, backlog >= 2 ? 2 : 1);
  }

  private controlFor(): PlaybackControl {
    const player = this;
    return {
      get speed() {
        return player.speedFactor();
      },
      get skipped() {
        return player.skipRequested;
      },
      wait(ms: number) {
        if (player.destroyed || ms <= 0) return Promise.resolve();
        const scaled = Math.max(40, Math.round(ms / player.speedFactor()));
        const { promise, resolve } = Promise.withResolvers<void>();
        player.finishActive();
        const timer = window.setTimeout(() => {
          if (player.active?.resolve === resolve) player.active = null;
          resolve();
        }, scaled);
        player.active = { resolve, timer };
        return promise;
      },
      waitManual() {
        if (player.destroyed || player.skipRequested) return Promise.resolve();
        const { promise, resolve } = Promise.withResolvers<void>();
        player.finishActive();
        player.manualResolve = resolve;
        return promise;
      },
      onSkip(callback: () => void) {
        if (player.skipRequested) {
          callback();
          return () => undefined;
        }
        player.skipCallbacks.add(callback);
        return () => player.skipCallbacks.delete(callback);
      },
    };
  }

  private async pump(): Promise<void> {
    if (this.running || this.destroyed) return;
    const epoch = this.epoch;
    this.running = true;
    this.host.setBusy(true);
    this.host.setSkippable(true);
    while (this.queue.length > 0 && !this.destroyed && this.epoch === epoch) {
      const update = this.queue[0];
      for (const fx of update.fx) {
        if (this.destroyed || this.epoch !== epoch) break;
        this.skipCallbacks.clear();
        this.skipRequested = false;
        this.host.setSkippable(true);
        try {
          await this.host.handleFx(fx, update.state, this.controlFor());
        } catch {
          // A presentation handler must not wedge the game. Continue to the next fx.
        }
      }
      if (this.epoch !== epoch) break;
      this.finishActive();
      this.skipCallbacks.clear();
      this.queue.shift();
      this.host.onQueueChange(this.queue.length);
      if (!this.destroyed) this.host.applyState(update.state, update.deadline, update.seq, update.gen);
    }
    if (this.epoch !== epoch) return;
    this.running = false;
    this.host.setBusy(false);
    this.host.setSkippable(false);
    if (this.queue.length > 0 && !this.destroyed) void this.pump();
  }
}