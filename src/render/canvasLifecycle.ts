// Canvas survival on mobile: detect a lost or silently purged backing store and rebuild.
//
// Report 105: the sea rendered solid black on Android Chrome until a reload.
//
// The map canvas is created with `{ alpha: false }` and cleared every frame, so a clear is
// black. Everything that should cover it with water — the cached ocean backdrop, the wave
// tile, the world thumbnail, the land tiles — is an *offscreen canvas*. Android Chrome
// drops offscreen canvas backing stores under GPU/memory pressure, and iOS purges them when
// the tab is backgrounded. A discarded canvas keeps its `width`/`height` and its context, and
// `drawImage` of it draws **nothing**: the sea stayed black while the land (painted from a
// still-valid tile) looked normal, which is exactly the reported symptom.
//
// There is no event for "an offscreen canvas was purged". This module therefore provides:
//   * `watchCanvasLifecycle` — contextlost/contextrestored on the visible canvas, plus the
//     page lifecycle events that precede a purge (`visibilitychange`, `pageshow`, `resume`).
//   * `isCanvasBlank` — a 1×1 sample, used sparingly as a self-healing check on caches whose
//     loss cannot be observed any other way.

/** Lifecycle callbacks for a renderer that owns cached canvases. */
export interface CanvasLifecycleHandlers {
  /** The drawing context was lost (or the page has to assume its caches were purged). */
  onLost: () => void;
  /** The context came back, or the page became visible again: rebuild and redraw. */
  onResume: () => void;
}

/**
 * Watch every signal that can precede a canvas purge.
 *
 * `contextlost` fires on the element whose context went away (Chrome only), so the visible
 * canvas is registered here as well as the page-level events. `preventDefault()` on
 * `contextlost` is what allows the browser to fire `contextrestored` instead of leaving the
 * canvas dead forever.
 */
export function watchCanvasLifecycle(
  canvas: HTMLCanvasElement | null,
  handlers: CanvasLifecycleHandlers,
): () => void {
  const onContextLost = (event: Event): void => {
    event.preventDefault();
    handlers.onLost();
  };
  const onContextRestored = (): void => handlers.onResume();
  // Coming back must always *finish* in a rebuild: a page that was frozen or hidden is the
  // state that precedes a purge on both Android and iOS, so every "visible again" path ends
  // in `onResume` (which drops the caches and redraws), never in a "maybe suspect" flag.
  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') handlers.onResume();
  };
  const onPageShow = (): void => handlers.onResume();
  const onPageHide = (): void => handlers.onLost();
  const onFreeze = (): void => handlers.onLost();
  const onResumeLifecycle = (): void => handlers.onResume();

  canvas?.addEventListener('contextlost', onContextLost);
  canvas?.addEventListener('contextrestored', onContextRestored);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pageshow', onPageShow);
  window.addEventListener('pagehide', onPageHide);
  // Page Lifecycle API: `freeze` and `resume` are dispatched on `document`.
  document.addEventListener('freeze', onFreeze);
  document.addEventListener('resume', onResumeLifecycle);

  return () => {
    canvas?.removeEventListener('contextlost', onContextLost);
    canvas?.removeEventListener('contextrestored', onContextRestored);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pageshow', onPageShow);
    window.removeEventListener('pagehide', onPageHide);
    document.removeEventListener('freeze', onFreeze);
    document.removeEventListener('resume', onResumeLifecycle);
  };
}

/**
 * True when a canvas has no visible pixel at `(x, y)`, where the caller knows a healthy cache
 * is opaque there. A discarded backing store reads back as transparent black.
 *
 * The sample is taken **through a 1×1 probe canvas**, never from the cache itself: a read-back
 * on an accelerated canvas without `willReadFrequently` makes Chrome warn and demote that
 * canvas to software, and a demoted cache is re-uploaded on every blit — exactly the per-frame
 * cost report 92 removed. A purged source draws nothing, so the probe stays transparent.
 */
export function isCanvasBlank(canvas: HTMLCanvasElement | null, x = 0, y = 0): boolean {
  if (!canvas || canvas.width < 1 || canvas.height < 1) return true;
  const probe = probeContext();
  if (!probe) return false;
  const sx = Math.min(canvas.width - 1, Math.max(0, x));
  const sy = Math.min(canvas.height - 1, Math.max(0, y));
  try {
    probe.clearRect(0, 0, 1, 1);
    probe.drawImage(canvas, sx, sy, 1, 1, 0, 0, 1, 1);
    return probe.getImageData(0, 0, 1, 1).data[3] < 8;
  } catch {
    // A lost context (or a zero-sized source) throws: treat it as blank so the caller rebuilds.
    return true;
  }
}

let probe: CanvasRenderingContext2D | null | undefined;

/**
 * The only canvas this module ever reads back from: 1×1 and created with
 * `willReadFrequently`, so the read demotes nothing and cannot produce a read-back warning on
 * any canvas the renderer draws with.
 */
function probeContext(): CanvasRenderingContext2D | null {
  if (probe === undefined) {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    probe = canvas.getContext('2d', { willReadFrequently: true });
  }
  return probe;
}
