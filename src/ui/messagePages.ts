/** Text paging for the Momotetsu-style message window (pure, unit-tested). */

export interface WindowMetrics {
  /** Usable text width in CSS px. */
  width: number;
  /** Visible line count (2 in landscape, 3 otherwise). */
  lines: number;
  /** Font size in CSS px. */
  fontSize: number;
}

/** Rough glyph advance for the rounded Japanese font; keeps 1–2 characters of slack. */
const advanceRatio = 1.02;

/** How many characters fit on one window page. */
export function charsPerPage(metrics: WindowMetrics): number {
  const perLine = Math.max(8, Math.floor(metrics.width / (metrics.fontSize * advanceRatio)));
  return Math.max(16, perLine * Math.max(1, metrics.lines));
}

/** Split on sentence punctuation so a page never starts mid-sentence when avoidable. */
export function paginateText(text: string, maxChars: number): string[] {
  const clean = text.trim();
  if (clean.length <= maxChars) return [clean];
  const pages: string[] = [];
  let rest = clean;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars + 1);
    const breakAt = Math.max(
      window.lastIndexOf('。'),
      window.lastIndexOf('！'),
      window.lastIndexOf('？'),
      window.lastIndexOf('、'),
    );
    const cut = breakAt > maxChars * 0.45 ? breakAt + 1 : maxChars;
    pages.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) pages.push(rest);
  return pages;
}

/** Read time for one page before auto-advance (before fx-speed scaling). */
export function pageReadMs(text: string): number {
  return Math.min(5200, Math.max(1100, 700 + [...text].length * 45));
}

/** Typewriter reveal duration; 0 means instant. */
export function revealMs(text: string, speed: number, reducedMotion: boolean): number {
  if (reducedMotion || speed >= 4) return 0;
  return Math.min(900, Math.max(160, [...text].length * 12)) / Math.max(1, speed);
}
