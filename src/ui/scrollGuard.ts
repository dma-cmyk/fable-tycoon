// Horizontal scroll guard for the game screen (2026-11-26 Sol playtest).
//
// Sol opened a player's rank detail from the right edge of the ranking list; afterwards the
// world-map screen was shifted left and its left edge was cut. The page itself must never
// scroll horizontally: the game is a fixed-viewport app, and `overflow: hidden` alone allows
// programmatic scrolls (focus, scroll-into-view, browser scroll anchoring) to stick.

/** Snap every page-level horizontal offset back to 0. */
export function resetHorizontalScroll(): void {
  for (const el of [document.documentElement, document.body]) {
    if (el.scrollLeft !== 0) el.scrollLeft = 0;
  }
  for (const el of document.querySelectorAll<HTMLElement>('.screen-host, .screen')) {
    if (el.scrollLeft !== 0) el.scrollLeft = 0;
  }
  if (window.scrollX !== 0) window.scrollTo(0, window.scrollY);
}

/** Belt and braces: if a browser still manages to scroll the window sideways, undo it. */
export function watchHorizontalScroll(): () => void {
  const handler = (): void => {
    if (window.scrollX !== 0) resetHorizontalScroll();
  };
  window.addEventListener('scroll', handler, { passive: true });
  return () => window.removeEventListener('scroll', handler);
}