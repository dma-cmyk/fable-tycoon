// Camera-jump placeholder audit: after a warp-like jump, a seam crossing, a realm round
// trip and a zoom-out/in flip, is any part of the map ever left black or transparent?
//
//   node tests/e2e/map-jump-fallback.mjs [--browser=chromium,firefox] [--view=all|pc|phone]
//                                       [--label=run]
//
// For each jump it captures the map canvas right after the jump and again at +100, +300 and
// +1000 ms. Every capture is checked for holes:
//   * alpha-0 pixels (the canvas is opaque, so any would be a bug)
//   * near-black pixels (the frame clears to black before the ocean backdrop; a black area
//     means the backdrop or the land placeholders did not cover it)
//   * 32x32 blocks that are >=90% near-black (an island of black, not text or a token)
// Screenshots are written to .tmp/jump-fallback/<label>/ so the frames can be eyeballed.
//
// The dev server must already be running (DEV_URL, default http://127.0.0.1:5299/).

import { chromium, firefox } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, '.tmp/jump-fallback');
const DEV_URL = process.env.DEV_URL || 'http://127.0.0.1:5299/';

const args = new Map(
  process.argv
    .filter((arg) => arg.startsWith('--') && arg.includes('='))
    .map((arg) => [arg.slice(2, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]),
);
const LABEL = args.get('label') ?? 'run';
const BROWSERS = (args.get('browser') ?? 'chromium,firefox').split(',');
const VIEW_FILTER = args.get('view') ?? 'all';

const BROWSER_TYPES = { chromium, firefox };
const VIEWPORTS = {
  pc: { width: 1280, height: 720, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  phone: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
};
const VIEWS = VIEW_FILTER === 'all' ? Object.keys(VIEWPORTS) : VIEW_FILTER.split(',');
const DELAYS = [0, 100, 300, 1000];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (value) => Math.round(value * 100) / 100;

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

async function startLocalGame(page) {
  await page.goto(new URL('?speed=8', DEV_URL).toString(), { waitUntil: 'domcontentloaded' });
  await waitFor(page, () => visible(page, '.title-menu-btn'), { label: 'title screen' });
  await page.locator('.title-menu-btn').filter({ hasText: 'ひとりで' }).first().click();
  await waitFor(page, () => visible(page, '.setup-screen'), { timeout: 20_000, label: 'setup screen' });
  await page.locator('.seg-btn').filter({ hasText: /^1年$/ }).first().click();
  const start = page.locator('.setup-start:visible, .setup-mobile-start:visible').first();
  await start.scrollIntoViewIfNeeded().catch(() => {});
  await start.click();
  await waitFor(page, () => visible(page, '.game-screen'), { timeout: 60_000, label: 'game screen' });
  await waitFor(page, () => page.evaluate(() => !!globalThis.__fableGame?.map?.state), { timeout: 60_000, label: 'map' });
}

/**
 * Freeze the board content so only the land layer changes, but leave the game's own render
 * loop alive: the point of the audit is the frames the player actually sees.
 */
async function freezeContent(page) {
  return page.evaluate(() => {
    const game = globalThis.__fableGame;
    const map = game.map;
    map.setAutoViewFollow(false);
    map.follow(null);
    map.setState = () => {};
    map.setMoveOptions = () => {};
    map.animateMove = () => Promise.resolve();
    map.warp = () => Promise.resolve();
    map.focusNode = () => Promise.resolve();
    map.setView = () => {};
    map.playEmote = () => Promise.resolve();
    map.bubble = () => {};
    map.celebrate = () => {};
    map.shake = () => {};
    map.setMood = () => {};
    const cam = map.camera;
    cam.startTween(cam.x, cam.y, cam.zoom, 0);
    cam.zoom = cam.clampZoom(1.5);
    cam.x = 4117;
    cam.y = 1212;
    map.month = 4;
    map.season = 'spring';
    map.staticRevision += 1;
    map.landLayer.invalidate();
    return { zoom: cam.zoom, x: cam.x, y: cam.y };
  });
}

/** Score one frame: holes, alpha, black pixels, black blocks. */
async function measureFrame(page) {
  return page.evaluate(() => {
    const map = globalThis.__fableGame.map;
    const canvas = document.querySelector('.map-canvas');
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const data = ctx.getImageData(0, 0, w, h).data;
    let alphaZero = 0;
    let black = 0;
    const blocks = new Map();
    const BW = 32;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = (y * w + x) * 4;
        if (data[i + 3] < 8) alphaZero += 1;
        const dark = data[i] < 10 && data[i + 1] < 10 && data[i + 2] < 10;
        if (!dark) continue;
        black += 1;
        const key = `${Math.floor(x / BW)}:${Math.floor(y / BW)}`;
        const cell = blocks.get(key) ?? { n: 0 };
        cell.n += 1;
        blocks.set(key, cell);
      }
    }
    let blackBlocks = 0;
    for (const cell of blocks.values()) if (cell.n >= (BW * BW * 0.9)) blackBlocks += 1;
    const stats = map.landLayer.getFrameStats();
    return {
      w,
      h,
      alphaZero,
      black,
      blackPct: +((100 * black) / (w * h)).toFixed(3),
      blackBlocks,
      exact: stats.exact,
      pending: stats.pending,
      painted: stats.painted,
      paintMs: stats.paintMs,
      view: map.view,
      zoom: Math.round(map.camera.zoom * 1000) / 1000,
      camera: [Math.round(map.camera.x), Math.round(map.camera.y)],
    };
  });
}

/** Screenshot + measure, once per requested delay. */
async function captureSeries(page, dir, prefix, browserName) {
  const series = [];
  let elapsed = 0;
  for (const delay of DELAYS) {
    if (delay > elapsed) await sleep(delay - elapsed);
    elapsed = delay;
    // 0 ms means "the first frame the browser paints after the jump".
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const measured = await measureFrame(page);
    const file = `${browserName}-${prefix}-${String(delay).padStart(4, '0')}ms.png`;
    await page.screenshot({ path: path.join(dir, file) });
    series.push({ delay, file, ...measured });
  }
  return series;
}

const JUMPS = [
  {
    name: 'warp-far',
    // A warp lands on another continent: nothing cached at that place or that bucket.
    apply: () => {
      const map = globalThis.__fableGame.map;
      const cam = map.camera;
      cam.startTween(cam.x, cam.y, cam.zoom, 0);
      cam.zoom = cam.clampZoom(1.6);
      cam.x = 6100;
      cam.y = 2400;
    },
  },
  {
    name: 'warp-seam',
    // Cross the MAP_W seam: tile columns are index-modulo nx around the world.
    apply: () => {
      const map = globalThis.__fableGame.map;
      const cam = map.camera;
      cam.startTween(cam.x, cam.y, cam.zoom, 0);
      cam.zoom = cam.clampZoom(1.5);
      cam.x = 8180;
      cam.y = 1500;
      setTimeout(() => {
        cam.x = 40;
        cam.y = 1500;
        map.requestRender();
      }, 120);
    },
  },
  {
    name: 'realm-roundtrip',
    // Heaven and back to a different part of the world.
    apply: () => {
      const map = globalThis.__fableGame.map;
      const proto = Object.getPrototypeOf(map);
      map.setView = proto.setView.bind(map);
      map.setView('heaven');
      setTimeout(() => {
        const cam = map.camera;
        cam.startTween(cam.x, cam.y, cam.zoom, 0);
        cam.zoom = cam.clampZoom(1.5);
        cam.x = 1400;
        cam.y = 900;
        map.setView('world');
        map.requestRender();
      }, 400);
    },
  },
  {
    name: 'zoom-out-in',
    // Whole world, then straight into a close zoom on a different place.
    apply: () => {
      const map = globalThis.__fableGame.map;
      const cam = map.camera;
      cam.startTween(cam.x, cam.y, cam.zoom, 0);
      cam.zoom = cam.clampZoom(cam.minZoom());
      cam.x = 4096;
      cam.y = 1908;
      setTimeout(() => {
        cam.startTween(cam.x, cam.y, cam.zoom, 0);
        cam.zoom = cam.clampZoom(2.8);
        cam.x = 6900;
        cam.y = 1100;
        map.requestRender();
      }, 220);
    },
  },
];

async function runView(browserName, viewName) {
  const browserType = BROWSER_TYPES[browserName];
  const vp = VIEWPORTS[viewName];
  const browser = await browserType.launch({
    headless: true,
    args: browserName === 'chromium' ? ['--mute-audio', '--autoplay-policy=no-user-gesture-required'] : [],
  });
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.deviceScaleFactor,
    isMobile: vp.isMobile,
    hasTouch: vp.hasTouch,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const dir = path.join(OUT, LABEL);
  await mkdir(dir, { recursive: true });
  const result = { browser: browserName, view: viewName, viewport: vp, errors, jumps: [] };
  try {
    await startLocalGame(page);
    await sleep(2500);
    result.frozen = await freezeContent(page);
    await sleep(700);
    for (const jump of JUMPS) {
      await page.evaluate(jump.apply);
      await page.evaluate(() => globalThis.__fableGame.map.requestRender());
      const series = await captureSeries(page, dir, jump.name, `${browserName}-${viewName}`);
      result.jumps.push({ name: jump.name, series });
      // Let the cache settle again before the next jump.
      await page.evaluate(() => {
        const map = globalThis.__fableGame.map;
        map.landLayer.setFrameBudget(0);
        for (let i = 0; i < 200; i += 1) {
          map.draw(performance.now());
          if (map.landLayer.getFrameStats().pending === 0) break;
        }
        map.landLayer.setFrameBudget(8);
        map.requestRender();
      });
      await sleep(900);
    }
  } catch (error) {
    result.error = String(error).slice(0, 400);
  } finally {
    await context.close();
    await browser.close();
  }
  return result;
}

/** Run the hole detector over an image file (used to prove the detector works). */
async function verifyImage(file) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const url = new URL(`file://${path.resolve(file)}`).href;
  await page.goto(url);
  const out = await page.evaluate(async () => {
    const img = document.querySelector('img');
    if (!img) return { error: 'no image' };
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let black = 0;
    const BW = 32;
    const blocks = new Map();
    for (let y = 0; y < c.height; y += 1) {
      for (let x = 0; x < c.width; x += 1) {
        const i = (y * c.width + x) * 4;
        if (!(d[i] < 10 && d[i + 1] < 10 && d[i + 2] < 10)) continue;
        black += 1;
        const key = `${Math.floor(x / BW)}:${Math.floor(y / BW)}`;
        blocks.set(key, (blocks.get(key) ?? 0) + 1);
      }
    }
    let blackBlocks = 0;
    for (const n of blocks.values()) if (n >= BW * BW * 0.9) blackBlocks += 1;
    return { w: c.width, h: c.height, black, blackPct: +((100 * black) / (c.width * c.height)).toFixed(3), blackBlocks };
  });
  await browser.close();
  console.log(JSON.stringify({ verify: file, ...out }));
  if ((out.blackBlocks ?? 0) === 0) process.exitCode = 1;
}

async function main() {
  if (args.get('verify')) {
    await verifyImage(args.get('verify'));
    return;
  }
  await mkdir(OUT, { recursive: true });
  const results = [];
  for (const browserName of BROWSERS) {
    for (const viewName of VIEWS) {
      const result = await runView(browserName, viewName);
      results.push(result);
      if (result.error) {
        console.log(`[jump] ${browserName} ${viewName}: ERROR ${result.error}`);
        continue;
      }
      for (const jump of result.jumps) {
        const worstAlpha = Math.max(...jump.series.map((s) => s.alphaZero));
        const worstBlocks = Math.max(...jump.series.map((s) => s.blackBlocks));
        const worstBlackPct = Math.max(...jump.series.map((s) => s.blackPct));
        const firstExact = jump.series[0].exact;
        const settle = jump.series.map((s) => `${s.delay}ms:${s.pending}`).join(' ');
        console.log(
          `[jump] ${browserName} ${viewName} ${jump.name}: ` +
            `alpha0=${worstAlpha} blackBlocks=${worstBlocks} black=${worstBlackPct}% ` +
            `exact@0=${firstExact} pending(${settle})`,
        );
      }
    }
  }
  await writeFile(path.join(OUT, `${LABEL}.json`), JSON.stringify({ label: LABEL, results }, null, 2));
  const failed = results.filter(
    (r) => r.error || r.jumps.some((j) => j.series.some((s) => s.alphaZero > 0 || s.blackBlocks > 0)),
  );
  console.log(JSON.stringify({ label: LABEL, runs: results.length, failed: failed.length }));
  if (failed.length > 0) process.exitCode = 1;
}

await main();
