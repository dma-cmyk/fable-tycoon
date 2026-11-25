import type { PublicState } from '../core/engine';
import type {Fx} from '../core/types';
import { FX_MS } from '../net/session-types';
import type { UiSettings } from './settings';
import { CpuTurnPacer, MAX_PACED_SPEED } from './cpuPacing';

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

/** Nominal 1x duration of one fx; used for the watchdog (2x + 5s). */
export function estimateFxDurationMs(fx: Fx): number {
  switch (fx.t) {
    case 'turn': return FX_MS.turn;
    case 'dice': return FX_MS.dice;
    case 'move': return Math.max(300, FX_MS.moveStep * Math.max(1, fx.path.length));
    case 'warp': return FX_MS.warp;
    case 'cash': return FX_MS.cash;
    case 'buy': return FX_MS.buy;
    case 'sell': return FX_MS.sell;
    case 'card_get': return FX_MS.card_get;
    case 'card_use': return FX_MS.card_use;
    case 'say': return FX_MS.sayBase + FX_MS.sayPerChar * [...fx.text].length;
    case 'event_open': return FX_MS.event_open;
    case 'event_close': return FX_MS.event_close;
    case 'goal': return FX_MS.goal;
    case 'destination': return Math.max(FX_MS.destination, 3200);
    case 'piper': return FX_MS.piper;
    case 'industry': return FX_MS.industry;
    case 'skip': return FX_MS.skip;
    case 'month': return FX_MS.month;
    case 'year_end': return FX_MS.year_end;
    case 'game_over': return FX_MS.game_over;
    case 'toast': return FX_MS.toast;
    case 'piper_roulette': return FX_MS.piper_roulette;
    case 'piper_disaster': return FX_MS.piper_disaster;
    case 'piper_gift': return FX_MS.piper_gift;
    case 'buyout': return FX_MS.buyout;
    case 'city_mod': return FX_MS.city_mod;
    case 'skill': return FX_MS.skill;
    case 'final_year': return FX_MS.final_year;
    default: return 800;
  }
}

export interface PlaybackControl {
  /** Waits `ms` scaled by the current presentation speed. Resolves early when the user skips. */
  wait(ms: number): Promise<void>;
  /** Waits until the user taps / presses skip (used by 台詞自動送りオフ). */
  waitManual(): Promise<void>;
  /** Pauses/resumes the watchdog while intentionally waiting on manual user advance. */
  setManualWait(waiting: boolean): void;
  /** Registers a cleanup/stop callback for the current fx; invoked exactly once on skip. */
  onSkip(callback: () => void): () => void;
  readonly skipped: boolean;
  readonly speed: number;
  /** Extra multiplier applied to `speed` because the current fx is routine CPU bookkeeping. */
  readonly accel: number;
  /** Number of newer updates waiting behind the currently playing head. */
  readonly backlog: number;
}

export interface FxPlayerHost {
  settings(): UiSettings;
  handleFx(fx: Fx, state: PublicState, control: PlaybackControl): Promise<void> | void;
  applyState(state: PublicState, deadline: number | null, seq: number, gen?: number): void;
  setBusy(busy: boolean): void;
  setSkippable(skippable: boolean): void;
  onQueueChange(pending: number): void;
  /** Optional cleanup hook run when the watchdog force-terminates a stalled update. */
  onWatchdog?(update: FxUpdate): void;
}

interface ActiveWait {
  resolve: () => void;
  timer: ReturnType<typeof globalThis.setTimeout>;
}

export class FxPlayer {
  private queue: FxUpdate[] = [];
  private running = false;
  private active: ActiveWait | null = null;
  private manualResolve: (() => void) | null = null;
  private skipCallbacks = new Set<() => void>();
  private skipRequested = false;
  private skipUpdateRequested = false;
  private destroyed = false;
  private epoch = 0;
  private watchdogTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private watchdogPaused = false;
  private activeUpdate: { update: FxUpdate; epoch: number; budgetMs: number } | null = null;
  /** CPU routine fx are painted at `fxSpeed × CPU_ROUTINE_BOOST`. */
  private readonly pacer = new CpuTurnPacer();
  private activeBoost = 1;

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
    if (
      this.running &&
      !this.watchdogPaused &&
      this.watchdogTimer === null &&
      this.activeUpdate &&
      this.activeUpdate.epoch === this.epoch
    ) {
      this.armWatchdog(this.activeUpdate.update, this.activeUpdate.epoch, this.activeUpdate.budgetMs);
    }
    void this.pump();
  }

  /**
   * Snapshot / reconnect: abandon animations and apply immediately.
   * Registered presentation cleanups are run (not dropped) so an interrupted voice line,
   * dice overlay or similar does not outlive the state it belonged to.
   */
  reset(): void {
    this.clearWatchdog();
    this.activeUpdate = null;
    this.watchdogPaused = false;
    this.epoch++;
    this.runSkipCallbacks();
    this.queue = [];
    this.finishActive();
    this.pacer.reset();
    this.activeBoost = 1;
    this.skipRequested = false;
    this.skipUpdateRequested = false;
    this.running = false;
    this.host.setBusy(false);
    this.host.setSkippable(false);
    this.host.onQueueChange(0);
  }

  /**
   * Snapshot adoption: drop queued updates that the snapshot already covers so a reconnect
   * cannot replay a backlog of stale fx.
   */
  dropThrough(gen: number, seq: number): number {
    const before = this.queue.length;
    this.queue = this.queue.filter((update) => {
      const updateGen = update.gen ?? gen;
      if (updateGen < gen) return false;
      if (updateGen === gen && update.seq <= seq) return false;
      return true;
    });
    const dropped = before - this.queue.length;
    if (dropped > 0) this.host.onQueueChange(this.queue.length);
    return dropped;
  }

  skip(): boolean {
    if (!this.running) return false;
    this.skipRequested = true;
    this.runSkipCallbacks();
    this.finishActive();
    return true;
  }

  /** Skip every remaining fx in the currently playing update and immediately adopt its state. */
  skipUpdate(): boolean {
    if (!this.running) return false;
    this.skipUpdateRequested = true;
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
      globalThis.clearTimeout(this.active.timer);
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

  private applyForcedEnd(update: FxUpdate): void {
    try {
      this.host.applyState(update.state, update.deadline, update.seq, update.gen);
    } catch {
      /* the watchdog must never throw out of the timer */
    }
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer !== null) {
      globalThis.clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private armWatchdog(update: FxUpdate, epoch: number, budgetMs: number): void {
    this.activeUpdate = { update, epoch, budgetMs };
    this.clearWatchdog();
    if (this.watchdogPaused || this.destroyed) return;
    this.watchdogTimer = globalThis.setTimeout(() => {
      this.watchdogTimer = null;
      if (this.epoch !== epoch || this.destroyed) return;
      // Apply the NEWEST queued update's authoritative state (not the stalled head), otherwise
      // dropping later queued updates leaves the UI stuck on an old CPU turn while the room has
      // already advanced to the human player's turn.
      const latest = this.queue[this.queue.length - 1] ?? update;
      console.warn(`[fx] update seq=${update.seq} exceeded ${budgetMs}ms; skipping to its end state`);
      this.epoch += 1; // make the in-flight pump stop before applying anything else
      this.activeUpdate = null;
      this.watchdogPaused = false;
      this.running = false;
      this.queue = [];
      this.skipRequested = false;
      this.skipUpdateRequested = false;
      this.runSkipCallbacks();
      this.finishActive();
      try {
        this.host.onWatchdog?.(latest);
      } catch {
        /* presentation cleanup must not prevent unlocking the UI */
      }
      this.host.setBusy(false);
      this.host.setSkippable(false);
      this.host.onQueueChange(0);
      this.applyForcedEnd(latest);
    }, budgetMs);
  }

  private setManualWait(waiting: boolean): void {
    if (this.watchdogPaused === waiting) return;
    this.watchdogPaused = waiting;
    if (waiting) {
      this.clearWatchdog();
    } else if (this.activeUpdate && this.activeUpdate.epoch === this.epoch && !this.destroyed) {
      this.armWatchdog(this.activeUpdate.update, this.activeUpdate.epoch, this.activeUpdate.budgetMs);
    }
  }

  private speedFactor(): number {
    const settings = this.host.settings();
    const backlog = this.queue.length;
    // DESIGN/UI: once two or more updates are waiting, play at 2x even if the setting is 1x.
    const base = Math.max(settings.fxSpeed, backlog >= 2 ? 2 : 1);
    // Routine CPU bookkeeping plays ~3x faster so the human is not forced to watch it.
    return Math.min(MAX_PACED_SPEED, base * this.activeBoost);
  }

  private controlFor(epoch: number): PlaybackControl {
    const player = this;
    const stale = () => player.destroyed || player.epoch !== epoch;
    return {
      get speed() {
        return player.speedFactor();
      },
      get accel() {
        return player.activeBoost;
      },
      get backlog() {
        return Math.max(0, player.queue.length - 1);
      },
      get skipped() {
        return player.skipRequested || stale();
      },
      wait(ms: number) {
        if (stale() || ms <= 0) return Promise.resolve();
        const scaled = Math.max(40, Math.round(ms / player.speedFactor()));
        const { promise, resolve } = Promise.withResolvers<void>();
        player.finishActive();
        const timer = globalThis.setTimeout(() => {
          if (player.active?.resolve === resolve) player.active = null;
          resolve();
        }, scaled);
        player.active = { resolve, timer };
        return promise;
      },
      waitManual() {
        if (stale() || player.skipRequested) return Promise.resolve();
        const { promise, resolve } = Promise.withResolvers<void>();
        player.finishActive();
        player.manualResolve = resolve;
        return promise;
      },
      setManualWait(waiting: boolean) {
        if (stale()) return;
        player.setManualWait(waiting);
      },
      onSkip(callback: () => void) {
        if (player.skipRequested || stale()) {
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
    try {
      while (this.queue.length > 0 && !this.destroyed && this.epoch === epoch) {
        const update = this.queue[0];
        const estimatedMs = update.fx.reduce((sum, fx) => sum + estimateFxDurationMs(fx), 0);
        const watchdogMs = estimatedMs * 2 + 8000;
        this.watchdogPaused = false;
        this.skipUpdateRequested = false;
        this.armWatchdog(update, epoch, watchdogMs);
        for (const fx of update.fx) {
          if (this.destroyed || this.epoch !== epoch || this.skipUpdateRequested) break;
          this.skipCallbacks.clear();
          this.skipRequested = false;
          // CPU routine bookkeeping plays faster; `turn` fx also update the paced actor.
          this.activeBoost = this.pacer.speedFor(fx, update.state);
          this.host.setSkippable(true);
          try {
            await this.host.handleFx(fx, update.state, this.controlFor(epoch));
          } catch {
            // A presentation handler must not wedge the game. Continue to the next fx.
          } finally {
            if (this.epoch === epoch) this.setManualWait(false);
          }
        }
        this.activeBoost = 1;
        if (this.epoch !== epoch) return;
        this.skipUpdateRequested = false;
        this.clearWatchdog();
        this.activeUpdate = null;
        this.finishActive();
        this.skipCallbacks.clear();
        this.queue.shift();
        // When 3+ newer updates pile up behind the finished update, collapse obsolete middle updates
        // and jump straight to the latest so slow clients never fall tens of seconds behind.
        if (this.queue.length > 2) {
          this.queue = [this.queue[this.queue.length - 1]];
        }
        this.host.onQueueChange(this.queue.length);
        if (!this.destroyed) {
          try {
            this.host.applyState(update.state, update.deadline, update.seq, update.gen);
          } catch {
            // A state paint failure must never leave FxPlayer permanently wedged in busy=true.
          }
        }
      }
    } finally {
      // CRITICAL: never mutate watchdog or queue state if reset()/watchdog started a newer epoch.
      if (this.epoch === epoch) {
        this.clearWatchdog();
        this.activeUpdate = null;
        this.watchdogPaused = false;
        this.running = false;
        this.host.setBusy(false);
        this.host.setSkippable(false);
        if (this.queue.length > 0 && !this.destroyed) void this.pump();
      }
    }
  }
}