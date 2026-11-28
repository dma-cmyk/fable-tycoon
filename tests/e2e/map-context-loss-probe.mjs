// Report 105: does the map survive a phone canvas purge, or does the sea stay black?
//
//   node tests/e2e/map-context-loss-probe.mjs [--view=so53c,sm] [--label=run]
//
// Android Chrome discards 2D canvas backing stores under GPU/memory pressure and iOS purges
// them when a tab is backgrounded. A discarded canvas keeps its width, height and context;
// `drawImage` of it draws nothing. The map canvas is opaque and cleared every frame, so
// "nothing" means black — which is what the user reported for the sea.
//
// There is no way to force a 2D context loss from script (`loseContext()` is WebGL only), so
// the probe reproduces the state a purge leaves behind: every cached canvas is emptied
// (`width = 0`), the visible canvas' context is dropped, and then either nothing happens
// (that is the pre-fix build, reproduced by stubbing the recovery hook) or the real
// `contextlost` / `contextrestored` / `visibilitychange` path runs.
//
// Metrics are the ones `map-jump-fallback.mjs` uses: alpha-0 pixels and 32×32 blocks that are
// at least 90% pure black.
//
// Screenshots: .tmp/e2e/report105/

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, '.tmp/e2e/report105');
const DEV_URL = process.env.DEV_URL || 'http://127.0.0.1:5277/';

const args = new Map(
  process.argv
    .filter((arg) => arg.startsWith('--') && arg.includes('='))
    .map((arg) => [arg.slice(2, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]),
);
const LABEL = args.get('label') ?? 'run';
const VIEW_FILTER = args.get('view') ?? 'so53c,sm';

// SO-53C (Xperia Ace III): 720×1496 physical, ~360×748 CSS at DPR 2. Plus the 390×844 DPR 3
// phone the other reports use, so the numbers stay comparable.
const VIEWPORTS = {
  so53c: { width: 360, height: 748, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  sm: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
};
const VIEWS = VIEW_FILTER.split(',').filter((v) => VIEWPORTS[v]);
const CPU_THROTTLE = Number(args.get('throttle') ?? 4);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (v) => Math.round(v * 100) / 100;

async function visible(page, selector) {
  return page.locator(selector).first().isVisible().catch(() => false);
}

async function waitFor(page, fn, { timeout = 90_000, interval = 150, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await sleep(interval);
  }
  throw new Error(`timeout waiting for ${label}${last ? ` (${last.message})` : ''}`);
}

/** Boot a 1-year solo game and park the camera on Europe at play zoom. */
async function startGame(page) {
  await page.goto(new URL('?speed=8', DEV_URL).toString(), { waitUntil: 'domcontentloaded' });
  await waitFor(page, () => visible(page, '.title-menu-btn'), { label: 'title screen' });
  await page.locator('.title-menu-btn').filter({ hasText: 'ひとりで' }).first().click();
  await waitFor(page, () => visible(page, '.setup-screen'), { timeout: 20_000, label: 'setup screen' });
  await page.locator('.seg-btn').filter({ hasText: /^1年$/ }).first().click();
  await page.locator('.setup-start:visible, .setup-mobile-start:visible').first().click();
  await waitFor(page, () => visible(page, '.game-screen'), { timeout: 60_000, label: 'game screen' });
  await waitFor(page, () => page.evaluate(() => !!globalThis.__fableGame?.map?.state), { timeout: 60_000, label: 'map' });
  await page.evaluate(() => {
    const map = globalThis.__fableGame.map;
    map.setAutoViewFollow(false);
    map.follow(null);
    const cam = map.camera;
    cam.startTween(cam.x, cam.y, cam.zoom, 0);
    cam.zoom = cam.clampZoom(1.5);
    cam.x = 4117;
    cam.y = 1212;
    map.landLayer.setFrameBudget(0);
    for (let i = 0; i < 200; i += 1) {
      map.draw(performance.now());
      if (map.landLayer.getFrameStats().pending === 0) break;
    }
    map.landLayer.setFrameBudget(8);
    map.requestRender();
  });
  await sleep(1600);
}

/** Score the visible map canvas the same way `map-jump-fallback.mjs` does. */
const MEASURE = () => {
  const canvas = document.querySelector('.map-canvas');
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const data = ctx.getImageData(0, 0, w, h).data;
  let alphaZero = 0;
  let black = 0;
  const BW = 32;
  const blocks = new Map();
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      if (data[i + 3] < 8) alphaZero += 1;
      if (data[i] < 10 && data[i + 1] < 10 && data[i + 2] < 10) {
        black += 1;
        const key = `${Math.floor(x / BW)}:${Math.floor(y / BW)}`;
        const cell = blocks.get(key) ?? { n: 0 };
        cell.n += 1;
        blocks.set(key, cell);
      }
    }
  }
  let blackBlocks = 0;
  for (const cell of blocks.values()) if (cell.n >= BW * BW * 0.9) blackBlocks += 1;
  const map = globalThis.__fableGame?.map;
  const stats = map?.landLayer?.getFrameStats?.() ?? {};
  return {
    w,
    h,
    alphaZero,
    black,
    blackPct: Math.round((100 * black) / (w * h) * 100) / 100,
    blackBlocks,
    exact: stats.exact ?? -1,
    pending: stats.pending ?? -1,
  };
};

/**
 * Empty every cached canvas the renderer owns — what a discarded backing store looks like
 * from the outside — and drop the visible context.
 */
const PURGE = (mode) => {
  const map = globalThis.__fableGame.map;
  const land = map.landLayer;
  const oceanOnly = String(mode ?? 'all').startsWith('ocean');
  const zero = String(mode ?? 'all').endsWith('-zero');
  const emptied = [];
  const empty = (canvas, name) => {
    if (!canvas || canvas.width < 1) return;
    emptied.push(`${name}:${canvas.width}x${canvas.height}`);
    if (zero) {
      // A release to zero size: the harsher of the two shapes a discarded canvas takes.
      canvas.width = 0;
      canvas.height = 0;
      return;
    }
    // A discarded backing store keeps its size and reads back transparent, which is what
    // `drawImage` then paints: nothing at all.
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  };
  empty(map.ocean.background, 'ocean-bg');
  empty(map.ocean.tile, 'ocean-tile');
  if (!oceanOnly) {
    empty(land.thumbCanvas, 'land-thumb');
    empty(land.fadeCanvas, 'land-fade');
    empty(land.flushCanvas, 'land-flush');
    for (const group of land.groups.values()) {
      for (const tile of group.tiles.values()) empty(tile.canvas, 'land-tile');
    }
    empty(map.miniLand, 'mini-land');
  }
  // Drop the visible canvas' context too: this is the `contextlost` case.
  const canvas = map.canvas;
  canvas.dispatchEvent(new Event('contextlost', { cancelable: true }));
  return { emptied: emptied.length, zero, names: emptied.slice(0, 4) };
};

/** What the renderer believes it owns, in device pixels and megabytes. */
const CANVAS_MEMORY = () => {
  const map = globalThis.__fableGame.map;
  const land = map.landLayer;
  const rows = [];
  const add = (label, canvas) => {
    if (!canvas || !canvas.width || !canvas.height) return;
    const px = canvas.width * canvas.height;
    rows.push({
      label,
      w: canvas.width,
      h: canvas.height,
      mp: Math.round((px / 1e6) * 100) / 100,
      mb: Math.round(((px * 4) / (1024 * 1024)) * 100) / 100,
    });
  };
  add('map-canvas', map.canvas);
  add('ocean-bg', map.ocean.background);
  add('ocean-tile', map.ocean.tile);
  add('land-thumb', land.thumbCanvas);
  add('land-fade', land.fadeCanvas);
  add('land-flush', land.flushCanvas);
  add('land-compose', land.canvas);
  add('mini-land', map.miniLand);
  add('mini-map', map.miniMapEl instanceof HTMLCanvasElement ? map.miniMapEl : null);
  add('spotlight-mask', map.spotlightMask);
  let tiles = 0;
  let tilePx = 0;
  for (const group of land.groups.values()) {
    for (const tile of group.tiles.values()) {
      tiles += 1;
      tilePx += tile.canvas.width * tile.canvas.height;
    }
  }
  rows.push({
    label: `land-tiles x${tiles}`,
    w: 0,
    h: 0,
    mp: Math.round((tilePx / 1e6) * 100) / 100,
    mb: Math.round(((tilePx * 4) / (1024 * 1024)) * 100) / 100,
  });
  const total = rows.reduce((sum, r) => sum + r.mb, 0);
  const docCanvases = document.querySelectorAll('canvas').length;
  return { rows, totalMb: Math.round(total * 100) / 100, docCanvases };
};

async function shot(page, name) {
  const file = path.join(OUT, `${LABEL}-${name}.png`);
  await page.screenshot({ path: file });
  return file;
}

async function runView(browserName, viewName) {
  const vp = VIEWPORTS[viewName];
  const browser = await chromium.launch({ headless: true, args: ['--mute-audio'] });
  const result = { browser: browserName, view: viewName, viewport: vp, throttle: CPU_THROTTLE, cases: {} };
  try {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.deviceScaleFactor,
      isMobile: vp.isMobile,
      hasTouch: vp.hasTouch,
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo',
      reducedMotion: 'reduce',
    });
    const cdp = await context.newCDPSession(await context.newPage()).catch(() => null);
    const page = await context.newPage();
    result.pageErrors = [];
    page.on('pageerror', (error) => result.pageErrors.push(error.message));

    // ---- case A: purged caches with the recovery hook disabled = the pre-fix build ----
    await startGame(page);
    if (cdp) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE }).catch(() => {});
    result.memory = await page.evaluate(CANVAS_MEMORY);
    // Peak over a scripted tour of four zoom buckets: the tile cache is what varies, and a
    // single moment after one bucket does not show it.
    result.memoryPeak = await page.evaluate(() => {
      const map = globalThis.__fableGame.map;
      const cam = map.camera;
      const measure = () => {
        let bytes = 0;
        const add = (c) => {
          if (c && c.width && c.height) bytes += c.width * c.height * 4;
        };
        add(map.canvas);
        add(map.ocean.background);
        add(map.ocean.tile);
        add(map.landLayer.thumbCanvas);
        add(map.landLayer.flushCanvas);
        add(map.landLayer.fadeCanvas);
        add(map.landLayer.canvas);
        add(map.miniLand);
        let tiles = 0;
        for (const group of map.landLayer.groups.values()) {
          for (const tile of group.tiles.values()) {
            tiles += 1;
            bytes += tile.canvas.width * tile.canvas.height * 4;
          }
        }
        return { mb: Math.round((bytes / (1024 * 1024)) * 100) / 100, tiles };
      };
      map.landLayer.setFrameBudget(0);
      let peak = measure();
      for (const zoom of [1.5, 1.9, 1.2, 2.3, 1.5]) {
        cam.zoom = cam.clampZoom(zoom);
        for (let i = 0; i < 60; i += 1) {
          map.draw(performance.now());
          if (map.landLayer.getFrameStats().pending === 0) break;
        }
        const sample = measure();
        if (sample.mb > peak.mb) peak = sample;
      }
      map.landLayer.setFrameBudget(8);
      map.draw(performance.now());
      map.requestRender();
      return peak;
    });
    result.memoryFull = await page.evaluate(CANVAS_MEMORY);
    result.cases.healthy = await page.evaluate(MEASURE);
    result.cases.healthy.shot = await shot(page, `${viewName}-healthy`);

    // Park the camera over open ocean so the sea is most of the frame: the report is about
    // the sea, and a land-heavy frame would hide the failure.
    await page.evaluate(() => {
      const map = globalThis.__fableGame.map;
      const cam = map.camera;
      cam.startTween(cam.x, cam.y, cam.zoom, 0);
      cam.zoom = cam.clampZoom(1.5);
      cam.x = 2000;
      cam.y = 2500;
      map.landLayer.setFrameBudget(0);
      for (let i = 0; i < 200; i += 1) {
        map.draw(performance.now());
        if (map.landLayer.getFrameStats().pending === 0) break;
      }
      map.landLayer.setFrameBudget(8);
      map.draw(performance.now());
    });
    await sleep(300);
    result.cases.openOcean = await page.evaluate(MEASURE);
    result.cases.openOcean.shot = await shot(page, `${viewName}-open-ocean`);
    await page.evaluate(() => {
      const map = globalThis.__fableGame.map;
      // Emulate the old build: no contextlost/restored handling, no visibility revalidation.
      map.markCanvasSuspect = () => {};
      map.recoverFromCanvasLoss = () => {};
      map.ocean.invalidate = () => {};
    });
    await page.evaluate(() => {
      const map = globalThis.__fableGame.map;
      // The pre-fix implementation: one blit of the cached raster, nothing underneath it and
      // no validity check. This is what shipped before report 105.
      map.ocean.draw = function draw(ctx, cam) {
        const w = cam.vw;
        const h = cam.vh;
        const bgDpr = this.bgDpr || 1;
        if (!this.background) return;
        ctx.drawImage(this.background, 0, 0, w * bgDpr, h * bgDpr, 0, 0, w, h);
      };
    });
    result.cases.before = await page.evaluate(PURGE, 'ocean');
    await page.evaluate(() => {
      const map = globalThis.__fableGame.map;
      map.requestRender();
      // Draw directly: this is exactly what the old draw() did with a purged cache.
      map.draw(performance.now());
    });
    await sleep(500);
    result.cases.before = { ...result.cases.before, ...(await page.evaluate(MEASURE)) };
    result.cases.before.shot = await shot(page, `${viewName}-before-fix-black-sea`);
    await context.close();

    // ---- case B: the same purge, with the shipped recovery path ----
    const context2 = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.deviceScaleFactor,
      isMobile: vp.isMobile,
      hasTouch: vp.hasTouch,
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo',
      reducedMotion: 'reduce',
    });
    const page2 = await context2.newPage();
    page2.on('pageerror', (error) => result.pageErrors.push(error.message));
    if (cdp) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE }).catch(() => {});
    await startGame(page2);
    // Same open-ocean camera as the pre-fix case, so the two screenshots compare.
    await page2.evaluate(() => {
      const map = globalThis.__fableGame.map;
      const cam = map.camera;
      cam.startTween(cam.x, cam.y, cam.zoom, 0);
      cam.zoom = cam.clampZoom(1.5);
      cam.x = 2000;
      cam.y = 2500;
      map.landLayer.setFrameBudget(0);
      for (let i = 0; i < 200; i += 1) {
        map.draw(performance.now());
        if (map.landLayer.getFrameStats().pending === 0) break;
      }
      map.landLayer.setFrameBudget(8);
      map.draw(performance.now());
    });
    await sleep(300);
    // The reported symptom first: only the sea caches are gone, the land tiles are fine.
    result.cases.afterOcean = await page2.evaluate(PURGE, 'ocean');
    await page2.evaluate(() => {
      const map = globalThis.__fableGame.map;
      map.canvas.dispatchEvent(new Event('contextrestored'));
      map.requestRender();
    });
    await sleep(1600);
    result.cases.afterOcean = { ...result.cases.afterOcean, ...(await page2.evaluate(MEASURE)) };
    result.cases.afterOcean.shot = await shot(page2, `${viewName}-after-fix-ocean`);

    // Then everything: every cache the renderer owns.
    result.cases.after = await page2.evaluate(PURGE, 'all');
    // Give the renderer its frame loop back: `pageshow`/`visibilitychange` and
    // `contextrestored` are all wired to the same rebuild, and any one of them must fix it.
    await page2.evaluate(() => {
      const map = globalThis.__fableGame.map;
      map.canvas.dispatchEvent(new Event('contextrestored'));
      map.requestRender();
    });
    await sleep(1600);
    result.cases.after = { ...result.cases.after, ...(await page2.evaluate(MEASURE)) };
    result.cases.after.shot = await shot(page2, `${viewName}-after-fix-recovered`);

    // Harsher shape: the canvases are released to zero size (this is what threw
    // `InvalidStateError: image argument is a canvas element with a width or height of 0`).
    result.cases.afterZero = await page2.evaluate(PURGE, 'all-zero');
    await page2.evaluate(() => {
      globalThis.__fableGame.map.canvas.dispatchEvent(new Event('contextrestored'));
      globalThis.__fableGame.map.requestRender();
    });
    await sleep(1600);
    result.cases.afterZero = { ...result.cases.afterZero, ...(await page2.evaluate(MEASURE)) };
    result.cases.afterZero.shot = await shot(page2, `${viewName}-after-fix-zero-size`);

    // ---- case C: hidden → visible, which is the real Android/iOS trigger ----
    await page2.evaluate(() => {
      const map = globalThis.__fableGame.map;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page2.evaluate(PURGE, 'all');
    await sleep(120);
    await page2.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
      globalThis.__fableGame.map.requestRender();
    });
    await sleep(1600);
    result.cases.afterResume = await page2.evaluate(MEASURE);
    result.cases.afterResume.shot = await shot(page2, `${viewName}-after-visibility-resume`);

    // ---- case D: main context lost for a whole second, then restored ----
    await page2.evaluate(() => {
      const map = globalThis.__fableGame.map;
      map.canvas.dispatchEvent(new Event('contextlost', { cancelable: true }));
    });
    await sleep(700);
    await page2.evaluate(() => {
      const map = globalThis.__fableGame.map;
      map.canvas.dispatchEvent(new Event('contextrestored'));
      map.requestRender();
    });
    await sleep(1600);
    result.cases.afterContextCycle = await page2.evaluate(MEASURE);
    result.cases.afterContextCycle.shot = await shot(page2, `${viewName}-after-context-cycle`);
    result.memoryAfter = await page2.evaluate(CANVAS_MEMORY);
    await context2.close();
  } catch (error) {
    result.error = String(error).slice(0, 300);
  } finally {
    await browser.close();
  }
  return result;
}

const brief = (v) => (v ? `blackBlocks=${v.blackBlocks} black=${v.blackPct}%` : 'missing');

async function main() {
  await mkdir(OUT, { recursive: true });
  const results = [];
  for (const viewName of VIEWS) {
    const r = await runView('chromium', viewName);
    results.push(r);
    const c = r.cases;
    if (r.error) {
      console.log(`[ctx] ${r.view}: ERROR ${r.error}`);
      if (r.pageErrors?.length) console.log('  pageErrors:', r.pageErrors.slice(0, 3));
      continue;
    }
    console.log(
      `[ctx] ${r.view} ${r.viewport.width}x${r.viewport.height}@${r.viewport.deviceScaleFactor}` +
        ` (throttle ${r.throttle}x) canvas now ${r.memory?.totalMb}MB, peak ${r.memoryPeak?.mb}MB over ${r.memoryPeak?.tiles} tiles / ${r.memory?.docCanvases} canvases`,
    );
    console.log(`  healthy   ${brief(c.healthy)} exact=${c.healthy?.exact}`);
    console.log(`  ocean     ${brief(c.openOcean)} (open sea baseline)`);
    console.log(`  pre-fix   ${brief(c.before)} alpha0=${c.before?.alphaZero}`);
    console.log(`  ocean-fix ${brief(c.afterOcean)}`);
    console.log(`  zero-size ${brief(c.afterZero)}`);
    console.log(`  recovered ${brief(c.after)} pending=${c.after?.pending}`);
    console.log(`  resume    ${brief(c.afterResume)}`);
    console.log(`  ctx-cycle ${brief(c.afterContextCycle)}`);
    if (r.error || r.pageErrors?.length) console.log('  errors:', (r.error ? [r.error] : r.pageErrors).slice(0, 3));
  }
  await writeFile(path.join(OUT, `${LABEL}.json`), JSON.stringify({ label: LABEL, results }, null, 2));
  const failed = results.filter(
    (r) => r.error || !r.cases.after || r.cases.afterOcean?.blackBlocks > 0 || r.cases.after.blackBlocks > 0
      || r.cases.afterResume.blackBlocks > 0 || r.cases.afterContextCycle.blackBlocks > 0,
  );
  console.log(JSON.stringify({ label: LABEL, runs: results.length, failed: failed.length }));
  if (failed.length > 0) process.exitCode = 1;
}

await main();