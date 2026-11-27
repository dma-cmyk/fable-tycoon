// Coalesced, write-only-if-changed HUD updates.
//
// At 8x the host pushes a state update every ~120 ms and the client applies it on arrival.
// Each one used to rebuild the ranking list, the move chips and the portrait from scratch,
// rewrite every chip label and re-measure the fitted text — measured 27 ms of `updateHud`
// p95 and 130 ms spikes, with `get clientWidth` / `getBoundingClientRect` as the top self
// time inside long tasks (forced layout right after the writes in the same task).
//
// Three rules keep a HUD refresh inside one cheap task:
//
//   1. **One refresh per animation frame.** `coalesceHud()` keeps the latest request and
//      runs it from a single rAF, so ten state updates in one frame paint once.
//   2. **No write for an unchanged value.** `setText` / `setHidden` / `setAttr` / `setClass`
//      compare against the last value they wrote and skip the DOM call. A `textContent =`
//      write invalidates the element's layout even when the string is identical.
//   3. **Layout reads never follow writes in the same task.** `fitTextCached()` measures an
//      element once per (text, width) pair, in a read pass that runs *before* the next
//      write pass; the measurement is also skipped entirely when neither changed.

type WriteCache = Map<string, string>;

const TEXT_CACHE = new WeakMap<Element, WriteCache>();
const ATTRIBUTE_CACHE = new WeakMap<Element, WriteCache>();
const CLASS_CACHE = new WeakMap<Element, WriteCache>();
const HIDDEN_CACHE = new WeakMap<Element, boolean>();
const FIT_CACHE = new WeakMap<Element, { text: string; width: number; minPx: number; applied: number }>();

function cacheFor(store: WeakMap<Element, WriteCache>, el: Element): WriteCache {
  let cache = store.get(el);
  if (!cache) {
    cache = new Map();
    store.set(el, cache);
  }
  return cache;
}

/** `el.textContent = value`, skipped when the element already shows it. */
export function setText(el: Element | null, value: string): void {
  if (!el) return;
  const cache = cacheFor(TEXT_CACHE, el);
  if (cache.get('') === value) return;
  cache.set('', value);
  el.textContent = value;
}

/** `el.hidden = value`, skipped when unchanged. */
export function setHidden(el: HTMLElement | null, value: boolean): void {
  if (!el) return;
  if (HIDDEN_CACHE.get(el) === value) return;
  HIDDEN_CACHE.set(el, value);
  el.hidden = value;
}

/** `el.setAttribute(name, value)`, skipped when unchanged. */
export function setAttr(el: Element | null, name: string, value: string): void {
  if (!el) return;
  const cache = cacheFor(ATTRIBUTE_CACHE, el);
  if (cache.get(name) === value) return;
  cache.set(name, value);
  el.setAttribute(name, value);
}

/** `el.classList.toggle(name, on)`, skipped when unchanged. */
export function setClass(el: Element | null, name: string, on: boolean): void {
  if (!el) return;
  const cache = cacheFor(CLASS_CACHE, el);
  const key = `class:${name}`;
  if (cache.get(key) === String(on)) return;
  cache.set(key, String(on));
  el.classList.toggle(name, on);
}

/** Forget everything remembered about an element that is about to be replaced. */
export function forgetElement(el: Element): void {
  TEXT_CACHE.delete(el);
  ATTRIBUTE_CACHE.delete(el);
  CLASS_CACHE.delete(el);
  HIDDEN_CACHE.delete(el);
  FIT_CACHE.delete(el);
}

// ---------------------------------------------------------------- frame coalescing

let frameHandle: number | null = null;
let pending: (() => void) | null = null;

/**
 * Run `fn` at most once per animation frame, always with the most recent request.
 * The first call schedules the frame; later calls in the same frame replace the payload.
 */
export function coalesceHud(fn: () => void): void {
  pending = fn;
  if (frameHandle !== null) return;
  frameHandle = requestAnimationFrame(() => {
    frameHandle = null;
    const job = pending;
    pending = null;
    job?.();
  });
}

/** Drop a queued refresh (screen teardown). */
export function cancelHud(): void {
  pending = null;
  if (frameHandle !== null) cancelAnimationFrame(frameHandle);
  frameHandle = null;
}

// ---------------------------------------------------------------- text fitting

/** Layout-reading part of `fitTextOneLine`, safe to call from a read pass. */
function measureFits(el: HTMLElement, minPx: number): number {
  const previous = el.style.fontSize;
  el.style.removeProperty('font-size');
  const slack = Math.max(2, (parseFloat(getComputedStyle(el).fontSize) || 14) * 0.2);
  const fits = (): boolean => el.scrollHeight <= el.clientHeight + slack && el.scrollWidth <= el.clientWidth + 0.5;
  if (fits()) {
    if (previous) el.style.removeProperty('font-size');
    return 0;
  }
  const base = parseFloat(getComputedStyle(el).fontSize) || 14;
  const min = Math.min(base, minPx);
  const steps = 8;
  for (let i = 1; i <= steps; i += 1) {
    const candidate = Math.max(min, Math.round((base - ((base - min) * i) / steps) * 10) / 10);
    el.style.fontSize = `${candidate}px`;
    if (fits()) return candidate;
    if (candidate <= min) break;
  }
  return min;
}

/**
 * Shrink `el` until its single line fits, at most one measurement per (text, width).
 *
 * Repeated HUD refreshes with the same destination name and the same panel width — the
 * common case at 8x — make this a cache hit and cost no layout at all. The width is read
 * only when the text changed, so the read happens once and never after a write in the same
 * task, as long as callers run after layout has settled.
 */
export function fitTextCached(el: HTMLElement | null, text: string, minPx = 10): void {
  if (!el || !el.isConnected) return;
  const cached = FIT_CACHE.get(el);
  const width = el.clientWidth;
  if (cached && cached.text === text && Math.abs(cached.width - width) < 0.5) {
    if (cached.applied > 0) el.style.fontSize = `${cached.applied}px`;
    return;
  }
  if (width < 4) return;
  const applied = measureFits(el, minPx);
  FIT_CACHE.set(el, { text, width, minPx, applied });
}