// Hand-written service worker for the game shell and its art.
//
// Goals:
//   - Repeat visits paint instantly: the shell and the first-screen art come from cache.
//   - Updates still roll out: cache names carry the build id the page passes as `?v=`; a new
//     deploy installs new caches, activates immediately (`skipWaiting` + `clients.claim`) and
//     deletes the old ones. The running page keeps its own bundle; the next navigation uses
//     the new shell (the page shows a notice instead of reloading mid-game).
//   - Voice mp3s (~100 MB) are never precached; they are cached lazily on first play.
//   - Online play is untouched: only same-origin GETs are intercepted. WebSockets/MQTT and
//     WebRTC never reach the fetch handler.
//
// The page disables this worker when `navigator.webdriver` is true (the Playwright online E2E
// harness runs four independent contexts against one preview server and must not share a
// cache) and in Vite dev.

// v2: v1 could store a partial (Range) response for an mp3 under its full URL, which made
// `decodeAudioData` fail for that track on every later visit. Bumping drops those entries.
const MEDIA_VERSION = 'v2';
const scopeBase = new URL(self.registration.scope).pathname;
const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const SHELL_CACHE = `fable-shell-${VERSION}`;
const ART_CACHE = `fable-art-${VERSION}`;
const MEDIA_CACHE = `fable-media-${MEDIA_VERSION}`;
const KEEP = new Set([SHELL_CACHE, ART_CACHE, MEDIA_CACHE]);
/** Never worth a round trip; the network stays authoritative. */
const BYPASS = /\/(sw\.js|sw-manifest\.json)$/;

const SHELL_FILES = ['', 'index.html'];

async function precacheShell() {
  const cache = await caches.open(SHELL_CACHE);
  await Promise.all(
    SHELL_FILES.map(async (rel) => {
      const url = new URL(`${scopeBase}${rel}`, self.location.origin).href;
      try {
        const res = await fetch(new Request(url, { cache: 'reload' }));
        if (res.ok) await cache.put(url, res);
      } catch {
        // A failed shell entry must not abort activation; the network still serves it.
      }
    }),
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheShell().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => !KEEP.has(name)).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

/**
 * The page posts the URLs it just decoded, so a first visit ends with the critical art
 * already cached for the next one without downloading anything twice.
 */
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'warm' || !Array.isArray(data.urls)) return;
  event.waitUntil(
    (async () => {
      const cache = await caches.open(ART_CACHE);
      for (const url of data.urls.slice(0, 400)) {
        const absolute = new URL(url, self.location.origin).href;
        if (!absolute.startsWith(self.location.origin + scopeBase)) continue;
        if (await cache.match(absolute)) continue;
        try {
          const res = await fetch(absolute, { cache: 'default' });
          if (res.ok) await cache.put(absolute, res);
        } catch {
          // Warming is best effort.
        }
      }
    })(),
  );
});

function cacheNameFor(pathname) {
  if (pathname.includes('/assets/voice/') || pathname.includes('/assets/bgm/') || pathname.includes('/assets/sfx/')) {
    return MEDIA_CACHE;
  }
  if (pathname.includes('/assets/')) return ART_CACHE;
  return null;
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(request);
  // Only a complete 200 is worth caching. A `Range` request answers 206 (partial) or a 200 of the
  // whole file, and storing the 206 under this URL would replay a truncated mp3 to a later full
  // read — decodeAudioData then fails and the track never plays again. Media is fetched whole by
  // the game (WebAudio decode, no <audio> element), so skipping Range responses costs nothing.
  const partial = res.status === 206 || request.headers.has('range');
  if (res.status === 200 && res.ok && !partial && res.type !== 'opaque') {
    cache.put(request, res.clone()).catch(() => undefined);
  }
  return res;
}

/** Documents: cache first, refreshed in the background so the next load sees a new deploy. */
async function shellRequest(request) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (!hit) return fetch(request);
  fetch(request)
    .then((res) => {
      if (res.ok) cache.put(request, res.clone()).catch(() => undefined);
    })
    .catch(() => undefined);
  return hit;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (BYPASS.test(url.pathname)) return;

  const assetCache = cacheNameFor(url.pathname);
  if (assetCache) {
    event.respondWith(
      cacheFirst(request, assetCache).catch(async () => {
        const other = await caches.match(request, { ignoreSearch: true });
        return other ?? new Response('', { status: 504, statusText: 'offline' });
      }),
    );
    return;
  }

  if (request.destination === 'document' || url.pathname.endsWith('/')) {
    event.respondWith(shellRequest(request).catch(() => fetch(request)));
  }
});