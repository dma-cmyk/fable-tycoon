// Deterministic pacing rules for CPU routine fx — the single source of truth for both sides:
//
//  - the HOST (`RoomController.armTurn`) divides the budget it schedules CPU actions by;
//  - the CLIENT (`FxPlayer` via `src/ui/cpuPacing.ts`) multiplies its playback speed by.
//
// Keeping one pure function here is what prevents the two from drifting apart. Everything the
// human might act on is deliberately absent from these tables: goals, piper fx, buyouts,
// events, skills, city mods, the final year, monopolies and any cash change of a human stay at
// the nominal budget / chosen playback speed.
//
// Two tiers (2026-11-27 tempo slice):
//
//  1. `routine` — a CPU's bookkeeping (roll, walk, quip, blue square, purchase). Always sped up.
//  2. `compact drama` — a CPU's 固有技 / CPU-to-CPU 買収 that touches no human. It still shows a
//     beat (the human must see that something happened), just a short one. Whether it is compact
//     is decided from the *whole update's* fx list, which both sides hold identically, so the
//     host budget and the client playback always agree.
//
// `FxTempoLevel` is the player's 「演出の長さ」 setting. It only ever makes a *client* faster than
// the host's budget: `calm` (じっくり) is the nominal DESIGN timing the host uses for online rooms,
// so no client can ever be slower than the time the host already allotted.

import type { Fx, LineKey } from './types';

/** How much faster a routine CPU fx plays, and how much shorter its host budget is. */
export const CPU_ROUTINE_BOOST = 3;

/** 「演出の長さ」: calm = 今までどおり, standard = 標準 (default), brisk = さくさく. */
export type FxTempoLevel = 'calm' | 'standard' | 'brisk';

/** Default of the player-facing 「演出の長さ」 setting. */
export const DEFAULT_TEMPO_LEVEL: FxTempoLevel = 'standard';

/**
 * Tier a *room budget* assumes when no level is given: the nominal DESIGN timing. Online hosts
 * schedule with this, so a client can only ever finish early, never overrun the room's time.
 */
export const HOST_BUDGET_LEVEL: FxTempoLevel = 'calm';

/**
 * Routine CPU bookkeeping by tier. `calm` is what the room always did; 標準 tightens the
 * ordinary CPU-only turn further (the playtest still felt those), さくさく adds two notches.
 * The host schedules with the same number, so a room never overruns.
 */
export const ROUTINE_BOOST: Record<FxTempoLevel, number> = {
  calm: CPU_ROUTINE_BOOST,
  standard: 4,
  brisk: 6,
};

/**
 * Compact beat lengths (1x, ms). `standard` halves the 2.2s skill cut-in; `brisk` halves it
 * again. `calm` has no entry: it keeps the nominal DESIGN duration.
 *
 * The repeat kinds (`goal` / `monopoly` / `piper_roulette` / `piper_mischief`) are the second
 * tier below: the first occurrence of each kind in a year plays its nominal beat, every later
 * one plays the short banner here. They are all "the human is a bystander" beats — a CPU's
 * destination bonus, a CPU's monopoly, a roulette that does not change form, a piper mischief
 * on a CPU — so a shorter banner loses no information the player can act on.
 */
export const COMPACT_DRAMA_MS = {
  skill: { standard: 800, brisk: 500 },
  buyout: { standard: 460, brisk: 320 },
  goal: { standard: 520, brisk: 380 },
  monopoly: { standard: 420, brisk: 320 },
  piper_roulette: { standard: 480, brisk: 340 },
  piper_mischief: { standard: 420, brisk: 300 },
} as const;

/** Every kind that can play a compact beat. */
export type CompactDramaKind = keyof typeof COMPACT_DRAMA_MS;

/** Kinds whose *repeats* compact (the first occurrence in a year plays full). */
export type DramaRepeatKind = 'goal' | 'monopoly' | 'piper_roulette' | 'piper_mischief';

/** Nominal DESIGN lengths of the compacted beats (mirrors `FX_MS`; kept here so this module is self-contained). */
const NOMINAL_DRAMA_MS: Record<CompactDramaKind, number> = {
  skill: 2200,
  buyout: 900,
  goal: 1600,
  monopoly: 440,
  piper_roulette: 2600,
  piper_mischief: 900,
};

/**
 * 声を待たずに台詞を次へ送るときの読み上げ速度（文字/秒）。さくさくだけで使う。
 * 標準は声を切らない（{@link sayVoiceAdvanceMs}）ので、この値は使わない。
 * じっくり（`calm`）は従来どおり声の終わりまで待つ。
 */
export const READ_CHARS_PER_SECOND = 11;

/** 声を待たないときの最低表示時間（1x, ms）。短い掛け合いでも一瞬で消えない。 */
export const SAY_MIN_HOLD_MS = 800;

/**
 * 標準で、声が終わってから次の beat へ移るまでの小休止（1x, ms）。旧実装の 1.5 s タレは廃止。
 */
export const SAY_VOICE_TAIL_MS = 120;

/** One voiced line's duration estimate, mirroring `audio/voiceBudget.estimateSpeechMs`. */
export function estimateSayVoiceMs(text: string): number {
  return 900 + [...text].length * 110;
}

/**
 * How many times each repeat kind has already played this year. The host and the client both
 * feed the same fx stream through {@link noteDramaLedger}, in the same order, so their decision
 * to compact agrees without either side knowing game data. A new year clears the counts.
 */
export interface DramaLedger {
  year: number;
  counts: Partial<Record<DramaRepeatKind, number>>;
}

export function createDramaLedger(year = 0): DramaLedger {
  return { year, counts: {} };
}

/** Occurrences of `kind` already seen this year (0 = this one is the first). */
export function dramaOrdinal(
  ledger: DramaLedger | undefined,
  year: number,
  kind: DramaRepeatKind,
): number {
  if (!ledger || ledger.year !== year) return 0;
  return ledger.counts[kind] ?? 0;
}

/** Which repeat kind an fx belongs to, if any. */
export function dramaRepeatKind(fx: Fx): DramaRepeatKind | null {
  switch (fx.t) {
    case 'goal':
      return 'goal';
    case 'buy':
      return fx.monopoly ? 'monopoly' : null;
    case 'piper_roulette':
      return 'piper_roulette';
    case 'piper':
      return 'piper_mischief';
    default:
      return null;
  }
}

/**
 * Record one occurrence. Call exactly once per fx, in stream order, after that fx's pacing was
 * decided — the host does it while budgeting an update, the client while playing it.
 */
export function noteDramaLedger(ledger: DramaLedger, year: number, fx: Fx): void {
  if (ledger.year !== year) {
    ledger.year = year;
    ledger.counts = {};
  }
  const kind = dramaRepeatKind(fx);
  if (kind === null) return;
  ledger.counts[kind] = (ledger.counts[kind] ?? 0) + 1;
}

/** A CPU's 固有技 swing at or above this share of the leader's net worth keeps the full cut-in. */
export const BIG_SWING_RATIO = 0.1;

/**
 * Character lines a CPU may deliver without the human having to read along.
 * `goal`, `monopoly`, `piper_*`, `win` and `lose` are deliberately absent: those
 * are the beats the human is playing for. `skill` is handled separately below, because a
 * *compact* CPU skill must not wait on its voice line while a big one still should.
 */
const ROUTINE_LINE_KEYS: Partial<Record<LineKey, true>> = {
  turn: true,
  buy: true,
  blue: true,
  red: true,
  card: true,
};

/**
 * Cash reasons that are pure bookkeeping for the CPU. Transfers (`スリ`, `肩代わり`,
 * `敵対的買収`, `決算`, `目的地ボーナス`, …) are absent: they either touch the human or are
 * the payoff of a beat that should land.
 */
const ROUTINE_CASH_REASONS: Record<string, true> = {
  青マス: true,
  赤マス: true,
  物件購入: true,
  カード購入: true,
  カード売却: true,
  // 決算・関税は全員に同じタイミングで降りる。人間の行だけ通常速度で見せれば足りる。
  決算: true,
  関税: true,
};

export interface FxPacingContext {
  /** Seat whose turn is being presented (latest `turn` fx / the acting player of the step). */
  actor: number | null;
  /** Whether a player id is a CPU. */
  isCpu: (playerId: number | null | undefined) => boolean;
  /**
   * Every fx of the update being played. Lets the 固有技 / 買収 rules see the *consequences* of
   * the beat (a cash hit on the human, a broken monopoly) without consulting game data, so the
   * host and every client reach the same answer.
   */
  update?: readonly Fx[];
  /** 「演出の長さ」. Omitted = 標準. */
  level?: FxTempoLevel;
  /** Net worth (億) of the current leader; enables the "big swing keeps the full cut-in" rule. */
  leaderWorth?: number;
  /** Game year of the update. Clears {@link ledger} at a year boundary. */
  year?: number;
  /** Repeat counts of this year; see {@link noteDramaLedger}. */
  ledger?: DramaLedger;
  /**
   * Pre-decided compact tiers of the current update, from {@link paceUpdate}. Present on both the
   * host and the client so a line that follows its beat sees the tier that beat actually played.
   */
  compactOf?: ReadonlyMap<Fx, CompactDramaKind | null>;
}

/** The fx of the current update, or just the fx itself when the caller passed no list. */
function updateOf(fx: Fx, ctx: FxPacingContext): readonly Fx[] {
  return ctx.update && ctx.update.length > 0 ? ctx.update : [fx];
}

/** Total absolute cash the update moved through generic event bookkeeping rows. */
function skillCashSwing(siblings: readonly Fx[]): number {
  let swing = 0;
  for (const item of siblings) {
    if (item.t !== 'cash') continue;
    if (item.reason !== 'イベント' && item.reason !== 'イベント物件収益') continue;
    swing += Math.abs(item.delta);
  }
  return swing;
}

/**
 * Seats whose money / assets an fx moves. `null` = the fx cannot touch a seat's holdings
 * (dice, month, a generic toast), so it says nothing about whether a skill touched anyone.
 */
function affectedSeats(fx: Fx): (number | null)[] | null {
  switch (fx.t) {
    case 'cash':
    case 'buy':
    case 'sell':
    case 'card_get':
    case 'card_use':
    case 'move':
    case 'warp':
    case 'skip':
    case 'goal':
    case 'errand_done':
    case 'buyout':
      return [fx.playerId, ...(fx.t === 'buyout' ? [fx.fromId] : [])];
    case 'piper':
    case 'piper_roulette':
    case 'piper_disaster':
    case 'piper_gift':
      return [fx.holder];
    default:
      return null;
  }
}

/**
 * True when a CPU's 固有技 changes nothing the human holds: no cash, property, piper or skip on
 * a non-CPU seat, and a swing smaller than {@link BIG_SWING_RATIO} of the leader's net worth.
 */
export function isCompactSkill(
  fx: Extract<Fx, { t: 'skill' }>,
  ctx: FxPacingContext,
): boolean {
  if (!ctx.isCpu(fx.playerId)) return false;
  if ((ctx.level ?? HOST_BUDGET_LEVEL) === 'calm') return false;
  const siblings = updateOf(fx, ctx);
  if (fx.targetId !== undefined && ctx.isCpu(fx.targetId) === false) return false;
  for (const item of siblings) {
    const seats = affectedSeats(item);
    if (seats === null) {
      // A monopoly flip is not a bookkeeping row: it reshapes the income race for everyone.
      if (item.t === 'toast' && item.text.includes('独占')) return false;
      continue;
    }
    for (const seat of seats) {
      if (seat !== null && ctx.isCpu(seat) === false) return false;
    }
  }
  const worth = ctx.leaderWorth ?? 0;
  const swing = skillCashSwing(siblings);
  // Without a leader worth, 40億 is the same 10% at the year-1 scale of an average table.
  if (worth > 0 ? swing >= worth * BIG_SWING_RATIO : swing >= 40) return false;
  return true;
}

/** True when both sides of a 買収 are CPUs — the human neither buys nor loses the property. */
export function isCompactBuyout(fx: Extract<Fx, { t: 'buyout' }>, ctx: FxPacingContext): boolean {
  if ((ctx.level ?? HOST_BUDGET_LEVEL) === 'calm') return false;
  if (!ctx.isCpu(fx.playerId) || !ctx.isCpu(fx.fromId)) return false;
  // A monopoly breaking reshapes the income race: keep its full beat (confetti + warning).
  if (fx.brokeMonopoly) return false;
  return true;
}

/** The compact tier an fx belongs to, or null when it plays at its nominal length. */
export function compactDramaKind(fx: Fx, ctx: FxPacingContext): CompactDramaKind | null {
  const decided = ctx.compactOf?.get(fx);
  if (decided !== undefined) return decided;
  if (fx.t === 'skill' && isCompactSkill(fx, ctx)) return 'skill';
  if (fx.t === 'buyout' && isCompactBuyout(fx, ctx)) return 'buyout';
  return repeatedDramaKind(fx, ctx);
}

/**
 * Decides one update in stream order: the compact tier of every fx is taken against the ledger
 * as it stood *before* the update, then the ledger is advanced. Both the host budget and the
 * client playback call this once per update and pass the result as `compactOf`, so
 *
 *  - a beat and the line it produces always agree (the line is colour iff its beat was short), and
 *  - the first occurrence of a kind plays full even though the ledger counts it right away.
 */
export function paceUpdate(
  update: readonly Fx[],
  ctx: FxPacingContext,
): Map<Fx, CompactDramaKind | null> {
  const decided = new Map<Fx, CompactDramaKind | null>();
  for (const item of update) decided.set(item, compactDramaKind(item, ctx));
  if (ctx.ledger) {
    const year = ctx.year ?? 0;
    for (const item of update) noteDramaLedger(ctx.ledger, year, item);
  }
  return decided;
}

/**
 * A *repeat* of a drama kind that already played this year. The first occurrence of each kind
 * plays the full beat (the player learns the news once a year); every later one only needs a
 * short banner, because the human is a bystander in all four:
 *
 *  - `goal` — a CPU's destination bonus (the human's own goal always plays full),
 *  - `monopoly` — a CPU completing a city monopoly,
 *  - `piper_roulette` — a roulette that does not change the piper's form,
 *  - `piper_mischief` — the piper's demand on a CPU holder.
 *
 * じっくり (`calm`) never compacts: the setting means "show it the way it was designed".
 * The ordinal comes from {@link DramaLedger}, which the host and the client advance from the
 * same fx stream, so both decide identically.
 */
export function repeatedDramaKind(fx: Fx, ctx: FxPacingContext): DramaRepeatKind | null {
  if ((ctx.level ?? HOST_BUDGET_LEVEL) === 'calm') return null;
  const year = ctx.year ?? 0;
  const repeat = (kind: DramaRepeatKind): DramaRepeatKind | null =>
    dramaOrdinal(ctx.ledger, year, kind) >= 1 ? kind : null;
  switch (fx.t) {
    case 'goal':
      // 人間の目的地は自分の収入が大きく動く。読む時間を守ってフルで見せる。
      if (!ctx.isCpu(fx.playerId)) return null;
      return repeat('goal');
    case 'buy':
      if (!fx.monopoly || !ctx.isCpu(fx.playerId)) return null;
      return repeat('monopoly');
    case 'piper_roulette':
      // 姿が変わらないルーレットは結果が既知（憑き先も強さも変わらない＝お金が動かない）。
      // 年の初出だけフルで見せ、2 回目以降は短いバナーだけ。
      if (fx.from !== fx.to) return null;
      return repeat('piper_roulette');
    case 'piper':
      // 憑かれているのが人間なら自分の損害。被害の実額は cash 側で見せるのでフル。
      if (fx.holder === null || !ctx.isCpu(fx.holder)) return null;
      return repeat('piper_mischief');
    default:
      return null;
  }
}

/** A compact repeat that is part of the *current* update (used to shorten its 掛け合い). */
export function compactRepeatOfUpdate(ctx: FxPacingContext): CompactDramaKind | null {
  for (const item of ctx.update ?? []) {
    const kind = compactDramaKind(item, ctx);
    if (kind !== null) return kind;
  }
  return null;
}

/**
 * The compact beat a `say` belongs to, or null when the line keeps its full presentation.
 *
 * A line is colour when the beat that produced it is already compact (a CPU-only 固有技, a
 * CPU-to-CPU 買収, a repeated CPU goal/monopoly/roulette/mischief). The human's own lines never
 * compact here: `self` lines carry the human's seat id and fail the CPU check, so their
 * message window still waits for the reader.
 */
export function compactSayBeat(fx: Extract<Fx, { t: 'say' }>, ctx: FxPacingContext): CompactDramaKind | null {
  if (fx.playerId !== undefined && !ctx.isCpu(fx.playerId)) return null;
  for (const item of updateOf(fx, ctx)) {
    const kind = compactDramaKind(item, ctx);
    if (kind === null) continue;
    // A 固有技 line must belong to the skill's own actor; a piper victim's reaction or an event
    // reply keeps its presentation. A CPU-to-CPU 買収 is colour for both sides (buyer and seller).
    if (item.t === 'skill' && item.playerId !== fx.playerId) continue;
    return kind;
  }
  return null;
}

/**
 * Host budget / client nominal length of a compacted beat. `calm` returns the DESIGN nominal,
 * so a じっくり room schedules exactly what it always did.
 */
export function compactDramaMs(kind: CompactDramaKind, level: FxTempoLevel | undefined): number {
  const resolved = level ?? HOST_BUDGET_LEVEL;
  if (resolved === 'calm') return NOMINAL_DRAMA_MS[kind];
  return COMPACT_DRAMA_MS[kind][resolved];
}

/**
 * How long a compact beat (a repeat, a CPU-only skill, a CPU-to-CPU buyout) may wait on its
 * voice before the queue moves on. The audio keeps playing in the background; the next line
 * queues behind it or ducks it, so two voices never overlap.
 */
export const COMPACT_VOICE_WAIT_MS = 1200;

/**
 * Wall time (1x) a `say` holds before the message window advances.
 *
 *  - じっくり (`calm`): `null` — the voice is awaited to its end, exactly as designed.
 *  - さくさく (`brisk`): the reading time (11 chars/second, floor 0.8 s). The clip may be cut;
 *    the next line fades it out over {@link VOICE_HANDOVER_MS}.
 *  - 標準 (`standard`): `null` — a voice is never clipped here. The line waits for its own voice
 *    and advances {@link SAY_VOICE_TAIL_MS} later (see the message window's `voiceDone` path).
 *
 * A `compact` beat still caps a さくさく line at {@link COMPACT_VOICE_WAIT_MS}.
 */
export function sayHoldMs(
  text: string,
  options: { level?: FxTempoLevel; compact?: boolean } = {},
): number | null {
  const level = options.level ?? HOST_BUDGET_LEVEL;
  if (level !== 'brisk') return null;
  const chars = [...text].length;
  const read = Math.max(SAY_MIN_HOLD_MS, Math.round((chars * 1000) / READ_CHARS_PER_SECOND));
  return options.compact === true ? Math.min(read, COMPACT_VOICE_WAIT_MS) : read;
}

/** True when the level lets a voice be cut (さくさく only). 標準 and じっくり never clip. */
export function cutsVoice(level: FxTempoLevel | undefined): boolean {
  return (level ?? HOST_BUDGET_LEVEL) === 'brisk';
}

/**
 * A `say` fx that can play briefly: the text still reaches the message window and the log,
 * just without the voice wait. Speaker must be the acting CPU itself, so victim/reaction
 * lines (piper_get on someone else, event replies) keep their presentation.
 */
export function isRoutineCpuSay(fx: Extract<Fx, { t: 'say' }>, ctx: FxPacingContext): boolean {
  if (!ctx.isCpu(fx.playerId)) return false;
  if (fx.lineKey !== undefined && ROUTINE_LINE_KEYS[fx.lineKey] === true) return true;
  // 固有技の決め台詞: only the compact tier drops the voice wait. A big skill's line still lands.
  if (fx.lineKey === 'skill') {
    const skill = updateOf(fx, ctx).find(
      (item): item is Extract<Fx, { t: 'skill' }> =>
        item.t === 'skill' && item.playerId === fx.playerId,
    );
    return skill !== undefined && isCompactSkill(skill, ctx);
  }
  // A CPU buying a CPU's property is a compact toast beat: its 掛け合い is colour as well.
  if (fx.lineKey === undefined) {
    return updateOf(fx, ctx).some(
      (item) => item.t === 'buyout' && isCompactBuyout(item, ctx),
    );
  }
  return false;
}

/**
 * True when the fx is a CPU's routine bookkeeping and can be painted faster / budgeted shorter.
 * The actor is required for `dice` / `move` / `toast`, which carry no playerId of their own.
 */
export function isRoutineCpuFx(fx: Fx, ctx: FxPacingContext): boolean {
  switch (fx.t) {
    case 'turn':
      return ctx.isCpu(fx.playerId);
    case 'dice':
    case 'move':
      return ctx.isCpu(ctx.actor);
    case 'say':
      return isRoutineCpuSay(fx, ctx);
    case 'cash':
      // The human's own ledger always lands at the normal speed / budget.
      return ROUTINE_CASH_REASONS[fx.reason] === true && ctx.isCpu(fx.playerId);
    case 'buy':
      // A monopoly flips the income race; keep its beat at normal speed.
      return !fx.monopoly && ctx.isCpu(fx.playerId);
    case 'toast':
      // The "new destination" toast is owned by the roulette announcement; do not race it.
      // Monopoly news is the payoff of a normal-speed `buy` fx, so its toast stays readable too —
      // unless the monopoly itself is a compact repeat, where the banner already said it.
      return (
        !fx.text.startsWith('新しい目的地は') &&
        (!fx.text.includes('独占') || compactRepeatOfUpdate(ctx) === 'monopoly') &&
        ctx.isCpu(ctx.actor)
      );
    case 'card_get':
      return ctx.isCpu(fx.playerId);
    case 'errand':
    case 'errand_done':
      // 寄り道依頼は人間も狙う共有の山場。CPU が達成しても早送りしない。
      return false;
    default:
      return false;
  }
}

/** 1 for normal playback, the routine boost for routine CPU bookkeeping. */
export function routineFxScale(fx: Fx, ctx: FxPacingContext): number {
  return isRoutineCpuFx(fx, ctx) ? ROUTINE_BOOST[ctx.level ?? HOST_BUDGET_LEVEL] : 1;
}

/** Typewriter reveal the message window runs before the reading hold starts (1x, ms). */
export const SAY_REVEAL_ALLOWANCE_MS = 280;

/**
 * Host-side per-fx budget: the nominal duration shortened by exactly the factor the client
 * plays it at. Compact drama uses its own short length; everything else keeps `nominalMs`.
 *
 * A `say` is the one fx whose client duration is set by the message window rather than by a
 * fixed budget, so it follows the same rule as the client:
 *
 *  - さくさく: the reading hold plus the typewriter reveal (the voice may be cut).
 *  - 標準: the line waits for its own voice, so budget the estimated speech length plus the
 *    small tail — the decoded duration is unknown on the host, and `estimateSpeechMs` is the
 *    number the client's own budget derives from.
 *  - じっくり: unchanged (the nominal voice budget).
 */
export function routineFxDuration(nominalMs: number, fx: Fx, ctx: FxPacingContext): number {
  const kind = compactDramaKind(fx, ctx);
  if (kind !== null) return compactDramaMs(kind, ctx.level);
  const scale = routineFxScale(fx, ctx);
  const budget = scale === 1 ? nominalMs : nominalMs / scale;
  if (fx.t !== 'say') return budget;
  // A routine CPU quip never plays a voice; its boosted nominal budget is the whole story.
  if (scale !== 1) return budget;
  const level = ctx.level ?? HOST_BUDGET_LEVEL;
  const compact = compactSayBeat(fx, ctx) !== null;
  const hold = sayHoldMs(fx.text, { level, compact });
  if (hold !== null) return hold + SAY_REVEAL_ALLOWANCE_MS;
  // 標準 and じっくり: the client waits for the real clip, which decodes shorter than
  // `estimateSpeechMs` (about 50ms/char at 1x). Budgeting the estimate made the room idle
  // 12.6s in the worst month, so the DESIGN nominal stays the host budget — the client is the
  // side that knows the decoded length, and it owns the wait.
  return budget;
}
