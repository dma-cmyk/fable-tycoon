/**
 * 長い地名を表示枠に収めるための縮小ヘルパー。
 * 収まるときは CSS の基準サイズのまま、はみ出すときだけ段階的に縮める。
 * 判定は client/scroll の実測値のみ。
 * 折り返し前提の要素は CSS で max-height を「許す行数」にしておくこと
 * （scrollHeight がその高さを超えたら縮める）。
 */
export function fitTextOneLine(
  el: HTMLElement | null,
  options: { minPx?: number; maxPx?: number; steps?: number } = {},
): void {
  if (!el || typeof getComputedStyle !== 'function') return;
  el.style.removeProperty('font-size');
  if (!el.isConnected || el.clientWidth < 4) return;
  // 行ボックスの端数（1〜2px）では縮めない。実害のあるはみ出しだけ拾う。
  const slack = Math.max(2, (parseFloat(getComputedStyle(el).fontSize) || 14) * 0.2);
  const fits = (): boolean => el.scrollHeight <= el.clientHeight + slack && el.scrollWidth <= el.clientWidth + 0.5;
  if (fits()) return;
  const base = options.maxPx ?? (parseFloat(getComputedStyle(el).fontSize) || 14);
  const minPx = Math.min(base, options.minPx ?? Math.max(9, base * 0.66));
  const steps = options.steps ?? 8;
  for (let i = 1; i <= steps; i++) {
    const candidate = Math.max(minPx, Math.round((base - ((base - minPx) * i) / steps) * 10) / 10);
    el.style.fontSize = `${candidate}px`;
    if (fits()) return;
    if (candidate <= minPx) return;
  }
}
