import type { PublicState } from '../core/engine';
import type {Fx} from '../core/types';
import type { CompactDramaKind } from '../core/fxPacing';
import { FX_MS } from '../net/session-types';
import { voiceBudgetMs, voicePlaybackRate } from '../audio/voiceBudget';
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
    case 'errand': return FX_MS.errand;
    case 'errand_done': return FX_MS.errand_done;
    default: return 800;
  }
}

export interface PlaybackControl {
  /** Waits `ms` scaled by the current presentation speed. Resolves early when the user skips. */
  wait(ms: number): Promise<void>;
  /**
   * Awaits a presentation promise (a camera tween, an image/voice, a modal close) with a bound:
   * resolves on settle, on skip, or after `ms` scaled by the current speed, whichever is first.
   * `ms` is the nominal 1x budget of that await.
   */
  bound(promise: Promise<unknown> | null | undefined, ms: number): Promise<void>;
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
  /** Compact presentation tier of the current fx (`null` = the full beat). */
  readonly compact: CompactDramaKind | null;
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
  /**
   * Net worth (億) of the current leader, used by the 「大きすぎる固有技はフルで見せる」 rule.
   * Optional so tests can omit it (the rule then falls back to a fixed 40億 threshold).
   */
  leaderWorth?(state: PublicState): number;
}

interface ActiveWait {
  resolve: () => void;
  timer: ReturnType<typeof globalThis.setTimeout>;
}

/** One fx's wall time inside an update, measured by FxPlayer (QA / `?debug=fx`). */
export interface FxStepStat {
  /** fx kind. */
  t: string;
  /** Wall time the handler held the queue. */
  ms: number;
  /** Speed-scaled nominal budget for this single fx. */
  budgetMs: number;
}

/** One adopted update's playback cost, measured by FxPlayer (QA / `?debug=fx`). */
export interface FxPlaybackStat {
  seq: number;
  gen: number | undefined;
  /** Per-fx wall times in play order. */
  fx: FxStepStat[];
  /** Sum of the nominal 1x durations of the update's fx. */
  estMs: number;
  /** Budget the update was given at the current speed (estMs / speed). */
  scaledMs: number;
  /** Wall time from starting the update to adopting its state. */
  wallMs: number;
  year: number;
  month: number;
  phase: string;
}

/** Playback stats kept for QA; old entries are dropped so a long game cannot grow memory. */
const MAX_PLAYBACK_STATS = 300;

/**
 * Minimum wall clock for the slow-update net. A real browser needs at least one frame (and
 * sometimes a long one) per fx, so a bound near zero would cut every presentation at 8x.
 */
const SLOW_UPDATE_FLOOR_MS = 2500;

/** Presentational beats that hold the whole screen and must give way first when the client is behind. */
const CUTIN_FX: Readonly<Record<string, true>> = {
  destination: true,
  errand: true,
  errand_done: true,
  goal: true,
  piper_roulette: true,
  piper_disaster: true,
  piper_gift: true,
  skill: true,
  final_year: true,
  city_mod: true,
  buyout: true,
};

/** True when the fx is a full-screen beat that can be cut short without losing information. */
export function isCutinFx(fx: Fx): boolean {
  return CUTIN_FX[fx.t] === true;
}

/**
 * Wall clock one update may take before the player gives up on it and adopts the newest state.
 * Three times its speed-scaled budget, never below {@link SLOW_UPDATE_FLOOR_MS}. Voice lines are
 * added unscaled because playback is capped at 1.2x, so 2x/4x must not cut a spoken line.
 */
export function slowUpdateBudgetMs(fx: readonly Fx[], speed: number): number {
  const rate = Math.max(1, Number.isFinite(speed) ? speed : 1);
  let estimatedMs = 0;
  let voiceMs = 0;
  for (const item of fx) {
    const nominal = estimateFxDurationMs(item);
    estimatedMs += nominal;
    if (item.t === 'say' && item.text && rate < 4) {
      // The message window waits for the (bounded) voice at 1x/2x; it does not at 4x/8x.
      voiceMs += voiceBudgetMs(0, item.text, voicePlaybackRate(rate));
    }
  }
  return Math.max(SLOW_UPDATE_FLOOR_MS, Math.round((estimatedMs * 3) / rate)) + Math.round(voiceMs);
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
  private slowTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private watchdogPaused = false;
  private activeUpdate: { update: FxUpdate; epoch: number; budgetMs: number; slowMs: number } | null = null;
  /** The fx currently holding the queue, when it is a full-screen cut-in that a backlog may cut. */
  private activeCutin: Fx | null = null;
  /** CPU routine fx are painted at `fxSpeed × CPU_ROUTINE_BOOST`. */
  private readonly pacer = new CpuTurnPacer();
  private activeBoost = 1;
  /** Compact tier of the fx being played (skills, buyouts, repeated drama). */
  private activeCompact: CompactDramaKind | null = null;
  private stats: FxPlaybackStat[] = [];
  private slowCount = 0;
  private updateStartedAt = 0;
  /** Wall clock by which the head update should be done; later waits are clamped to it. */
  private updateDeadlineAt = 0;

  constructor(private readonly host: FxPlayerHost) {}

  /** QA seam: the last {@link MAX_PLAYBACK_STATS} adopted updates, oldest first. */
  get playbackStats(): readonly FxPlaybackStat[] {
    return this.stats;
  }

  /** QA seam: how many updates tripped the slow-update net. */
  get slowUpdates(): number {
    return this.slowCount;
  }

  /** QA seam: the speed multiplier the player is using right now. */
  get currentSpeed(): number {
    return this.speedFactor();
  }

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
      const active = this.activeUpdate;
      this.armWatchdog(active.update, active.epoch, active.budgetMs, active.slowMs);
    }
    // A full-screen cut-in must not keep the human waiting on new state that is already here:
    // two newer updates than the one being played means the room moved on, so it ends now.
    // (Same threshold as the backlog compression below, so both decisions agree.)
    if (this.running && this.queue.length > 2) this.cutActiveCutin();
    void this.pump();
  }

  /**
   * Ends the current full-screen cut-in early (backlog). The fx handler's own `onSkip` cleanup
   * closes its DOM and its bounded wait resolves, so the pump continues with the next fx.
   */
  private cutActiveCutin(): void {
    if (!this.activeCutin) return;
    this.activeCutin = null;
    this.skipRequested = true;
    this.runSkipCallbacks();
    this.finishActive();
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
    this.activeCompact = null;
    this.activeCutin = null;
    this.updateDeadlineAt = 0;
    this.updateStartedAt = 0;
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
    if (this.slowTimer !== null) {
      globalThis.clearTimeout(this.slowTimer);
      this.slowTimer = null;
    }
  }

  /**
   * Arms the two give-up timers for the head update:
   *  - `slowTimer` at 3x the speed-scaled budget (`[fx] slow update`): the client is merely behind.
   *  - `watchdogTimer` at the nominal emergency budget: a presentation promise never settled.
   * Both call {@link forceEnd}, which clears the other, so they can never fire twice.
   */
  private armWatchdog(update: FxUpdate, epoch: number, budgetMs: number, slowMs: number): void {
    this.activeUpdate = { update, epoch, budgetMs, slowMs };
    this.clearWatchdog();
    if (this.watchdogPaused || this.destroyed) return;
    this.slowTimer = globalThis.setTimeout(() => {
      this.slowTimer = null;
      this.forceEnd(update, epoch, `[fx] slow update seq=${update.seq} played past 3x its ${slowMs}ms budget; adopting the newest state`, true);
    }, Math.max(1, slowMs));
    this.watchdogTimer = globalThis.setTimeout(() => {
      this.watchdogTimer = null;
      this.forceEnd(update, epoch, `[fx] update seq=${update.seq} exceeded ${budgetMs}ms; skipping to its end state`);
    }, Math.max(1, budgetMs));
  }

  /** Applies the newest queued state and unlocks the UI. Shared by the slow net and the watchdog. */
  private forceEnd(update: FxUpdate, epoch: number, warning: string, slow = false): void {
    if (this.epoch !== epoch || this.destroyed) return;
    // Apply the NEWEST queued update's authoritative state (not the stalled head), otherwise
    // dropping later queued updates leaves the UI stuck on an old CPU turn while the room has
    // already advanced to the human player's turn.
    const latest = this.queue[this.queue.length - 1] ?? update;
    if (slow) this.slowCount += 1;
    console.warn(warning);
    this.epoch += 1; // make the in-flight pump stop before applying anything else
    this.slowTimer = null;
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
  }

  private setManualWait(waiting: boolean): void {
    if (this.watchdogPaused === waiting) return;
    this.watchdogPaused = waiting;
    if (waiting) {
      this.clearWatchdog();
    } else if (this.activeUpdate && this.activeUpdate.epoch === this.epoch && !this.destroyed) {
      const active = this.activeUpdate;
      this.armWatchdog(active.update, active.epoch, active.budgetMs, active.slowMs);
    }
  }

  /** QA: one row per adopted update so a slow cut-in can be identified after the fact. */
  private recordStat(update: FxUpdate, estimatedMs: number, speed: number, steps: FxStepStat[]): void {
    const wallMs = this.updateStartedAt > 0 ? performance.now() - this.updateStartedAt : 0;
    this.updateStartedAt = 0;
    this.stats.push({
      seq: update.seq,
      gen: update.gen,
      fx: steps,
      estMs: estimatedMs,
      scaledMs: estimatedMs / Math.max(1, speed),
      wallMs,
      year: update.state.year ?? 0,
      month: update.state.month ?? 0,
      phase: update.state.phase?.t ?? 'unknown',
    });
    if (this.stats.length > MAX_PLAYBACK_STATS) this.stats.splice(0, this.stats.length - MAX_PLAYBACK_STATS);
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
    const sleepScaled = (ms: number): Promise<void> => {
      if (stale() || ms <= 0) return Promise.resolve();
      const scaled = Math.max(40, Math.round(ms / player.speedFactor()));
      // A busy main thread stretches every timer. Once the update is past its (3x) budget, stop
      // spending wall clock on presentation: waits collapse to the frame minimum so the queue
      // catches up instead of drifting further behind the room.
      const remaining = player.updateDeadlineAt - performance.now();
      const bounded = remaining > 0 ? Math.min(scaled, Math.max(40, Math.round(remaining))) : 40;
      const { promise, resolve } = Promise.withResolvers<void>();
      player.finishActive();
      const timer = globalThis.setTimeout(() => {
        if (player.active?.resolve === resolve) player.active = null;
        resolve();
      }, bounded);
      player.active = { resolve, timer };
      return promise;
    };
    return {
      get speed() {
        return player.speedFactor();
      },
      get accel() {
        return player.activeBoost;
      },
      get compact() {
        return player.activeCompact;
      },
      get backlog() {
        return Math.max(0, player.queue.length - 1);
      },
      get skipped() {
        return player.skipRequested || stale();
      },
      wait: sleepScaled,
      bound(promise: Promise<unknown> | null | undefined, ms: number) {
        const timed = sleepScaled(ms);
        if (!promise) return timed;
        // Settling late must never leak an unhandled rejection; the wait is already bounded.
        void promise.catch(() => undefined);
        return Promise.race([promise.then(() => undefined).catch(() => undefined), timed]);
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
        const playbackSpeed = this.speedFactor();
        const slowMs = slowUpdateBudgetMs(update.fx, playbackSpeed);
        this.updateStartedAt = performance.now();
        // Waits shrink once the update has used its own scaled budget, so a slow frame does not
        // compound into the next fx. The 3x slow net stays as the give-up bound above.
        this.updateDeadlineAt = this.updateStartedAt + Math.max(600, Math.round(estimatedMs / Math.max(1, playbackSpeed)));
        this.watchdogPaused = false;
        this.skipUpdateRequested = false;
        this.armWatchdog(update, epoch, watchdogMs, slowMs);
        const steps: FxStepStat[] = [];
        for (const fx of update.fx) {
          if (this.destroyed || this.epoch !== epoch || this.skipUpdateRequested) break;
          this.skipCallbacks.clear();
          this.skipRequested = false;
          // CPU routine bookkeeping plays faster; `turn` fx also update the paced actor.
          this.activeBoost = this.pacer.speedFor(fx, update.state, {
            update: update.fx,
            level: this.host.settings().pacing,
            ...(this.host.leaderWorth
              ? { leaderWorth: (state: PublicState) => this.host.leaderWorth!(state) }
              : {}),
          });
          this.activeCompact = this.pacer.compactBeat;
          this.activeCutin = isCutinFx(fx) ? fx : null;
          this.host.setSkippable(true);
          const stepStart = performance.now();
          const budgetMs = estimateFxDurationMs(fx) / Math.max(1, playbackSpeed);
          try {
            await this.host.handleFx(fx, update.state, this.controlFor(epoch));
          } catch {
            // A presentation handler must not wedge the game. Continue to the next fx.
          } finally {
            if (this.epoch === epoch) this.setManualWait(false);
            steps.push({ t: fx.t, ms: performance.now() - stepStart, budgetMs });
          }
        }
        this.activeCutin = null;
        this.activeBoost = 1;
        this.activeCompact = null;
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
          this.recordStat(update, estimatedMs, playbackSpeed, steps);
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