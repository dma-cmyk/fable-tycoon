// Last line of defence for DOM <img> elements.
//
// The app paints from a generated art set, so a single missing or slow file used to mean a
// blank box ("表示されない画像"). This module makes every <img> in the document:
//   1. reserve its box and show a shimmer while it decodes (`data-img-pending`),
//   2. retry twice with backoff on error,
//   3. fall back to a neutral silhouette instead of a broken-image glyph.
//
// It is installed once at boot and covers screens added later via a MutationObserver, so no
// call site has to remember it. Decorative art that should vanish instead of falling back can
// opt out with `data-img-onfail="hide"`; non-art images can opt out with `data-img-guard="off"`.

const FALLBACK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">' +
  '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">' +
  '<stop offset="0" stop-color="#cfe2f7"/><stop offset="1" stop-color="#a8c6e8"/>' +
  '</linearGradient></defs>' +
  '<rect width="120" height="120" rx="14" fill="url(#g)"/>' +
  '<circle cx="60" cy="48" r="20" fill="#7d9dc0"/>' +
  '<path d="M24 112c0-20 16-32 36-32s36 12 36 32z" fill="#7d9dc0"/>' +
  '<circle cx="96" cy="24" r="6" fill="#ffe9a8" opacity="0.9"/>' +
  '</svg>';

export const IMAGE_FALLBACK_SRC = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(FALLBACK_SVG)}`;

// 320 → 900 → 2500: a phone on a bad link can lose 3+ seconds before the art arrives, and the
// silhouette must be the last resort, not the first hiccup.
const RETRY_DELAYS_MS = [320, 900, 2500];
const GUARDED = new WeakSet<HTMLImageElement>();
let installed = false;

function bypassed(img: HTMLImageElement): boolean {
  return img.dataset.imgGuard === 'off' || img.dataset.imgFallback === '1' || img.src.startsWith('data:');
}

function markPending(img: HTMLImageElement): void {
  if (bypassed(img)) return;
  if (img.complete && img.naturalWidth > 0) {
    delete img.dataset.imgPending;
    return;
  }
  img.dataset.imgPending = '';
}

function settle(img: HTMLImageElement): void {
  delete img.dataset.imgPending;
}

function fail(img: HTMLImageElement): void {
  delete img.dataset.imgPending;
  if (img.dataset.imgOnfail === 'hide') {
    img.hidden = true;
    return;
  }
  img.dataset.imgFallback = '1';
  img.removeAttribute('srcset');
  img.src = IMAGE_FALLBACK_SRC;
}

function retry(img: HTMLImageElement): void {
  const attempt = Number(img.dataset.imgRetry ?? '0');
  if (attempt >= RETRY_DELAYS_MS.length) {
    fail(img);
    return;
  }
  img.dataset.imgRetry = String(attempt + 1);
  img.dataset.imgPending = '';
  img.classList.remove('is-error');
  // 失敗した URL を控えておく。待っている間に別の画像（次のイベント）へ差し替わったら
  // 古い URL を書き戻さない — でないと前のイベントの絵が居座る。
  const failedSrc = img.src;
  const url = new URL(img.src, location.href);
  // A cache-busting query is the only way past a service worker that cached a failed/partial
  // response for this URL, and it also re-runs a transiently failed network request.
  url.searchParams.set('retry', String(attempt + 1));
  window.setTimeout(() => {
    if (!img.isConnected) return;
    if (img.src !== failedSrc) return;
    img.src = url.href;
  }, RETRY_DELAYS_MS[attempt]);
}

function watch(img: HTMLImageElement): void {
  if (GUARDED.has(img)) return;
  GUARDED.add(img);
  // `error` is handled by the single capturing document listener below; a per-image
  // listener would double-count retries.
  img.addEventListener('load', () => settle(img));
  markPending(img);
}

/** Retry-then-fallback for an image that already has its final URL. */
export function installImageResilience(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;

  // Capture phase: `error` does not bubble, but it can be captured on the document.
  document.addEventListener(
    'error',
    (event) => {
      const img = event.target;
      if (img instanceof HTMLImageElement) retry(img);
    },
    true,
  );

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof HTMLImageElement) watch(node);
        else if (node instanceof HTMLElement) {
          for (const img of node.querySelectorAll('img')) watch(img);
        }
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  for (const img of document.querySelectorAll('img')) watch(img);
}