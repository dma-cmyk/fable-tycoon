// Service-worker registration, cache warm-up and update handling.
//
// Rules:
//   - Dev: never register. Vite serves unbundled modules and a cached shell would hide edits.
//   - Automated browsers (`navigator.webdriver`): never register. The Playwright online E2E
//     harness runs four independent contexts against one preview server, and a shared worker
//     cache would leak state between them. This is the test-safe choice and costs nothing in
//     production.
//   - Production: register at the app's base path, versioned by the emitted bundle hash.
//
// Updates: the new worker takes over as soon as it installs (`skipWaiting` + `clients.claim`)
// and the page shows a one-line notice instead of reloading under a running game. The new
// shell is used on the next navigation, so a deploy rolls out without interrupting play.

const NOTICE_TEXT = '新しい世界地図が届きました。次の読み込みで最新になります。';

/** Art the current visit has decoded; handed to the worker so visit #2 is already cached. */
const warmed: string[] = [];
const warmedSet = new Set<string>();

export function rememberWarmedUrl(url: string): void {
  if (warmedSet.has(url) || warmed.length >= 400) return;
  warmedSet.add(url);
  warmed.push(url);
}

let notice = (text: string): void => {
  // Until the app hands its toast host over, keep the message in the console.
  console.info(text);
};

/** The app hands its toast host over so SW notices surface in the normal UI. */
export function setServiceWorkerNotice(fn: (text: string) => void): void {
  notice = fn;
}

/**
 * Build id taken from the hashed entry bundle (`assets/index-Cg8E1cJb.js`), which is the
 * deploy identity Vite already produces. Falls back to `dev` when unbundled.
 */
function buildId(): string {
  for (const script of document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')) {
    const match = /-([A-Za-z0-9_-]{8})\.m?js(?:\?|$)/.exec(script.src);
    if (match) return match[1];
  }
  return 'dev';
}

export function registerServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  if (import.meta.env.DEV || navigator.webdriver) return;

  const base = new URL(import.meta.env.BASE_URL, location.href);
  const swUrl = new URL('sw.js', base);
  swUrl.searchParams.set('v', buildId());

  void navigator.serviceWorker
    .register(swUrl.href, { scope: base.pathname })
    .then((registration) => {
      // The art decoded before the worker took control is only in the HTTP cache. Push the
      // list so visit #2 reads it from the service worker cache instead of revalidating.
      const warm = (): void => {
        if (warmed.length > 0) registration.active?.postMessage({ type: 'warm', urls: [...warmed] });
      };
      if (registration.active) warm();
      else {
        navigator.serviceWorker.addEventListener('controllerchange', warm, { once: true });
      }
    })
    .catch(() => undefined);

  // Fires for a first install too (because of clients.claim); only an update matters here.
  let controlled = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!controlled) {
      controlled = true;
      return;
    }
    notice(NOTICE_TEXT);
  });
}