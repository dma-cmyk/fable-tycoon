// Event-art load probe: opens every event stage on a phone profile and proves the art appears.
//
//   node tests/e2e/event-art-load-probe.mjs [--url=http://127.0.0.1:5280/] [--profile=phone|pc]
//        [--net=slow3g|fast3g|none] [--cpu=4] [--fail=first|none] [--delay=ms]
//        [--wait=6000] [--only=id1,id2] [--label=name] [--shots=0|1]
//
// Runs against the DEV server (the probe drives `__fableGame.eventPanel.show()` and imports
// `src/data/events.json`). One browser, headless, muted. Slow 3G: 400 kbps down / 400 ms RTT.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = new Map(
  process.argv
    .filter((a) => a.startsWith('--') && a.includes('='))
    .map((a) => [a.slice(2, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]),
);
const URL_BASE = args.get('url') ?? 'http://127.0.0.1:5280/';
const PROFILE = args.get('profile') ?? 'phone';
const NET = args.get('net') ?? 'slow3g';
const CPU = Number(args.get('cpu') ?? 4);
const FAIL = args.get('fail') ?? 'none';
const DELAY = Number(args.get('delay') ?? 0);
const BLOCK_MS = Number(args.get('block') ?? 0);
const BUDGET = Number(args.get('budget') ?? 150) * 1000;
const MAX_EVENTS = Number(args.get('events') ?? 20);
const LABEL = args.get('label') ?? 'run';
const SHOTS = args.get('shots') === '1';
const OUT = path.join(ROOT, '.tmp/e2e/report106');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const NET_PROFILES = {
  slow3g: { offline: false, downloadThroughput: (400 * 1024) / 8, uploadThroughput: (400 * 1024) / 8, latency: 400 },
  fast3g: { offline: false, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8, latency: 150 },
  none: { offline: false, downloadThroughput: -1, uploadThroughput: -1, latency: 0 },
};

async function startGame(page) {
  await page.locator('.title-menu-btn').filter({ hasText: 'ひとりで' }).first().waitFor({ timeout: 60_000 });
  await page.locator('.title-menu-btn').filter({ hasText: 'ひとりで' }).first().click();
  await page.locator('.setup-screen').first().waitFor({ timeout: 30_000 });
  const mobile = page.locator('.setup-mobile-start').first();
  if ((await mobile.count().catch(() => 0)) > 0 && (await mobile.isVisible().catch(() => false))) await mobile.click();
  else await page.locator('.setup-start').first().click();
  await page.locator('.game-screen').first().waitFor({ timeout: 90_000 });
  await page.waitForFunction(() => Boolean(globalThis.__fableGame?.state), null, { timeout: 150_000 });
  // Let the first paint and the initial host updates settle.
  await sleep(2500);
}

const SW = args.get('sw') === '1';
const browser = await chromium.launch({
  headless: true,
  ...(SW ? { ignoreDefaultArgs: ['--enable-automation'] } : {}),
  args: ['--mute-audio'],
});
const context = await browser.newContext(
  PROFILE === 'phone'
    ? { viewport: { width: 360, height: 748 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ja-JP' }
    : { viewport: { width: 1280, height: 720 }, locale: 'ja-JP' },
);
if (SW) {
  await context.addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    } catch {}
  });
}
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send('Network.enable');
if (CPU > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });

let failedOnce = false;
let blockUntil = 0;
const armedAt = { at: 0 };
await page.exposeFunction('__probeArmBlock', () => {
  blockUntil = Date.now() + BLOCK_MS;
});
await page.route('**/assets/events/*.webp*', async (route) => {
  if (BLOCK_MS > 0 && blockUntil > 0 && Date.now() < blockUntil) {
    await route.abort('failed');
    return;
  }
  if (FAIL === 'first' && !failedOnce) {
    failedOnce = true;
    await route.abort('failed');
    return;
  }
  if (DELAY > 0) await sleep(DELAY);
  await route.continue();
});

await mkdir(OUT, { recursive: true });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('crash', () => errors.push('page crash'));
const url = new URL(URL_BASE);
url.searchParams.set('speed', args.get('speed') ?? '8');
url.searchParams.set('debug', '1');
await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 120_000 });
await startGame(page);
if (BLOCK_MS > 0) await page.evaluate(() => globalThis.__probeArmBlock());
// The phone's link is slow in the field but the app shell is already open: throttle from here,
// so the measured stage load is the art's, not the dev bundle's.
if (NET !== 'none') {
  await cdp.send('Network.emulateNetworkConditions', NET_PROFILES[NET] ?? NET_PROFILES.slow3g);
}

// Record every event stage the real fx queue opens: when it opened, when THIS event's art became
// visible, and whether the fallback silhouette or an error state ever replaced it.
const stageRows = await page.evaluate(async (opts) => {
  const game = globalThis.__fableGame;
  const panel = game.eventPanel.el;
  const img = panel.querySelector('.event-image');
  const hero = panel.querySelector('.event-hero');
  const rows = [];
  let current = null;
  const now = () => Math.round(performance.now());
  const visible = () =>
    img.naturalWidth > 0 &&
    !img.hidden &&
    Number(getComputedStyle(img).opacity) > 0 &&
    img.getBoundingClientRect().width > 0;
  const tick = () => {
    const open = panel.classList.contains('is-open');
    if (open && !current) {
      const src = (img.currentSrc || img.src).split('/').pop() ?? '';
      const events = globalThis.__fableGameData?.events ?? [];
      const def = events.find((e) => e.id === game.eventPanel.eventId);
      current = {
        id: game.eventPanel.eventId,
        noArt: !def?.image,
        openedAt: now(),
        src,
        visibleAt: visible() ? now() : null,
        retries: img.dataset.imgRetry ?? '0',
        fallback: img.dataset.imgFallback ?? null,
        box: null,
        heroClass: hero.className,
        placeholderAtOpen: hero.classList.contains('is-loading'),
        placeholderUntil: null,
      };
    } else if (open && current) {
      if (current.visibleAt === null && visible() && (img.currentSrc || img.src).endsWith(current.src)) {
        current.visibleAt = now();
      }
      // A retry or the placeholder silhouette replacing the art is a failure of this stage.
      const fb = img.dataset.imgFallback ?? null;
      if (fb && current.fallback === null) current.fallback = fb;
      const retry = img.dataset.imgRetry ?? '0';
      if (retry !== '0' && retry !== current.retries) current.retries = retry;
      if (current.placeholderUntil === null && !hero.classList.contains('is-loading')) {
        current.placeholderUntil = now();
      }
    } else if (!open && current) {
      const b = img.getBoundingClientRect();
      current.box = [Math.round(b.width), Math.round(b.height)];
      current.endedAt = now();
      rows.push(current);
      current = null;
    }
  };
  const timer = setInterval(tick, 40);

  // Play the human quickly so the engine draws many events within the budget.
  const deadline = now() + opts.maxMs;
  let acted = 0;
  while (now() < deadline && rows.length < opts.maxEvents) {
    const s = game.state;
    if (!s || s.phase.t === 'game_over') break;
    if (!game.fxBusy && !game.fxPlayer?.busy && !s.players[s.current]?.isCpu) {
      const owned = Object.keys(s.owner ?? {}).find((id) => s.owner[id] === s.current);
      const action =
        s.phase.t === 'turn_start' ? { t: 'roll' }
        : s.phase.t === 'choose_dest' ? (s.phase.options?.[0] ? { t: 'move', nodeId: s.phase.options[0].nodeId } : null)
        : s.phase.t === 'buy' ? { t: 'end_buy' }
        : s.phase.t === 'event' ? { t: 'choose', index: 0 }
        : s.phase.t === 'year_end' ? { t: 'ack' }
        : s.phase.t === 'shop' ? { t: 'end_shop' }
        : s.phase.t === 'discard' ? (s.players[s.current].cards?.[0] ? { t: 'discard', cardId: s.players[s.current].cards[0] } : null)
        : s.phase.t === 'sell' ? (owned ? { t: 'sell', propertyId: owned } : null)
        : null;
      if (action) {
        game.sendAction(action);
        acted += 1;
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  clearInterval(timer);
  if (current) {
    current.endedAt = now();
    const b = img.getBoundingClientRect();
    current.box = [Math.round(b.width), Math.round(b.height)];
    rows.push(current);
  }
  return { rows, acted };
}, { maxMs: BUDGET, maxEvents: MAX_EVENTS });

const rows = stageRows.rows.map((r) => {
  const lifetime = (r.endedAt ?? r.openedAt) - r.openedAt;
  const showed = r.visibleAt !== null && r.visibleAt - r.openedAt <= lifetime;
  return {
    id: r.id,
    src: r.src,
    openedAt: r.openedAt,
    lifetimeMs: lifetime,
    artMs: r.visibleAt === null ? null : r.visibleAt - r.openedAt,
    showed,
    slow: showed && r.visibleAt - r.openedAt > 1000,
    fallback: r.fallback,
    noArt: Boolean(r.noArt),
    box: r.box,
    placeholderAtOpen: r.placeholderAtOpen,
    placeholderMs:
      r.placeholderUntil === null ? null : Math.max(0, r.placeholderUntil - r.openedAt),
  };
});
const artRows = rows.filter((r) => !r.noArt);
const bad = artRows.filter((r) => !r.showed || r.fallback);
const summary = {
  label: LABEL,
  profile: PROFILE,
  net: NET,
  cpu: CPU,
  fail: FAIL,
  delay: DELAY,
  acted: stageRows.acted,
  stages: rows.length,
  artStages: artRows.length,
  noArtStages: rows.length - artRows.length,
  artShown: artRows.filter((r) => r.showed && !r.fallback).length,
  slowOver1s: artRows.filter((r) => r.slow).length,
  neverShown: artRows.filter((r) => !r.showed).length,
  fallback: artRows.filter((r) => r.fallback).length,
  maxArtMs: Math.max(0, ...artRows.filter((r) => r.artMs !== null).map((r) => r.artMs)),
  placeholderAtOpen: artRows.filter((r) => r.placeholderAtOpen).length,
  placeholderMsMed: (() => {
    const v = artRows.filter((r) => r.placeholderMs !== null).map((r) => r.placeholderMs).sort((a, b) => a - b);
    return v.length === 0 ? null : v[Math.floor(v.length / 2)];
  })(),
  medArtMs: (() => {
    const v = artRows.filter((r) => r.artMs !== null).map((r) => r.artMs).sort((a, b) => a - b);
    return v.length === 0 ? null : v[Math.floor(v.length / 2)];
  })(),
  bad: bad.slice(0, 12),
  errors: errors.slice(0, 6),
};
console.log(JSON.stringify(summary, null, 2));
await writeFile(path.join(OUT, `${LABEL}.json`), JSON.stringify({ summary, rows }, null, 2));
if (SHOTS) {
  await page.screenshot({ path: path.join(OUT, `${LABEL}-last.png`) }).catch(() => undefined);
}
await context.close();
await browser.close();
