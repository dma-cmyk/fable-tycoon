/** Upper bounds for voice playback so a stalled AudioContext can never wedge the fx queue. */

export const VOICE_TAIL_MS = 1500;

/** Rough spoken length when the buffer duration is unknown (Japanese ~110ms per character). */
export function estimateSpeechMs(text: string): number {
  return 900 + [...text].length * 110;
}

/** Wall-clock budget for one voice line: decoded duration when known, else a text estimate. */
export function voiceBudgetMs(bufferDurationMs: number, text: string, speed = 1): number {
  const rate = Math.max(1, Number.isFinite(speed) ? speed : 1);
  const base = bufferDurationMs > 0 ? bufferDurationMs : estimateSpeechMs(text);
  const scaled = (base + VOICE_TAIL_MS) / rate;
  const floor = Math.max(320, Math.round(1200 / rate));
  return Math.max(floor, Math.round(scaled));
}

/** Resolves with `promise`, or after `ms`, whichever comes first. Clears the timer either way. */
export function raceWithTimeout(promise: Promise<void>, ms: number): Promise<void> {
  const { promise: timed, resolve } = Promise.withResolvers<void>();
  const timer = globalThis.setTimeout(resolve, Math.max(0, ms));
  return Promise.race([promise.catch(() => undefined), timed]).finally(() => {
    globalThis.clearTimeout(timer);
    resolve();
  });
}
