// Raster parity harness: does the incrementally-maintained land cache ever drift from a
// from-scratch rebuild at the same camera?
//
//   node tests/e2e/map-raster-parity.mjs [--browser=chromium,firefox] [--view=all|pc1280|pc1920|phone]
//                                       [--label=run] [--keep]
//
// For every browser × viewport it drives a scripted camera sequence through the real game
// map — small pans, a pan across the world seam, and pans during a zoom tween — then forces
// a full rebuild at the final camera and compares the two rendered frames pixel by pixel.
// A cache that patches itself must stay within noise of a clean rebuild; a 1%-plus diff
// means the background raster is wrong (the symptom is vertical bands of mismatched terrain).
//
// The dev server must already be running (DEV_URL, default http://127.0.0.1:5272/).
// Writes .tmp/raster-parity/<label>.json and .png captures.

import { chromium, firefox } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, '.tmp/raster-parity');
const DEV_URL = process.env.DEV_URL || 'http://127.0.0.1:5272/';

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
  pc1280: { width: 1280, height: 720, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  pc1920: { width: 1920, height: 1080, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  phone: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
};
const VIEWS = VIEW_FILTER === 'all' ? Object.keys(VIEWPORTS) : VIEW_FILTER.split(',');

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
  await page.goto(DEV_URL, { waitUntil: 'domcontentloaded' });
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
 * Freeze the board so both captures see the same content, and take over the camera so the
 * scripted pan cannot be fought by the game's follow logic.
 */
async function freezeBoard(page) {
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
    map.labelFade = new map.labelFade.constructor(0, 0);
    map.requestRender = () => {};
    map.scheduleAmbient = () => {};
    if (map.raf) cancelAnimationFrame(map.raf);
    map.raf = 0;
    clearTimeout(map.ambientTimer);
    map.ambientTimer = null;
    const cam = map.camera;
    cam.startTween(cam.x, cam.y, cam.zoom, 0);
    cam.zoom = cam.clampZoom(1.5);
    cam.x = 4117;
    cam.y = 1212;
    map.month = 4;
    map.season = 'spring';
    map.staticRevision += 1;
    map.landLayer.invalidate();
    map.draw(1_700_000_000_000);
    return { zoom: cam.zoom, x: cam.x, y: cam.y, layer: [map.landLayer.canvas.width, map.landLayer.canvas.height] };
  });
}

/**
 * Scripted camera moves. Each entry is applied directly to the camera (no tweens unless
 * asked), then one frame is drawn so the cache has to keep up exactly like in play.
 */
async function driveCamera(page, steps) {
  return page.evaluate((steps) => {
    const map = globalThis.__fableGame.map;
    const cam = map.camera;
    const drawn = [];
    for (const step of steps) {
      if (step.kind === 'pan') {
        cam.x = cam.x + step.dx;
        cam.y = cam.y + step.dy;
        cam.y = cam.clampCenterY(cam.y, cam.zoom);
      } else if (step.kind === 'abs') {
        cam.x = step.x;
        cam.y = cam.clampCenterY(step.y, cam.zoom);
      } else if (step.kind === 'zoom') {
        cam.zoom = cam.clampZoom(step.zoom);
      } else if (step.kind === 'tween') {
        cam.startTween(cam.x + step.dx, cam.y, cam.zoom, 320);
      }
      // A tween needs frames to advance; everything else just needs one draw.
      const frames = step.frames ?? 1;
      for (let i = 0; i < frames; i += 1) {
        if (step.kind === 'tween') cam.update(performance.now() + i * 60);
        map.draw(1_700_000_000_000 + i * 16);
      }
      drawn.push({ x: Math.round(cam.x), y: Math.round(cam.y), z: Math.round(cam.zoom * 1000) / 1000 });
    }
    // Settle any running tween, then draw once more: the comparison must be made in the
    // state a user actually stops panning in, not mid-animation.
    cam.update(performance.now() + 10_000);
    map.draw(1_700_000_000_000);
    return drawn;
  }, steps);
}

/** Capture the land-layer raster itself (the thing a cache can corrupt). */
async function captureLayer(page) {
  return page.evaluate(() => {
    const map = globalThis.__fableGame.map;
    const L = map.landLayer;
    const data = L.ctx.getImageData(0, 0, L.canvas.width, L.canvas.height);
    const bytes = new Uint8Array(data.data.buffer);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    const cam = map.camera;
    return {
      raw: btoa(binary),
      width: L.canvas.width,
      height: L.canvas.height,
      camera: { x: cam.x, y: cam.y, zoom: cam.zoom },
      geom: { ox: L.ox, oy: L.oy, scale: L.scale, key: L.key },
    };
  });
}

/** Capture the map canvas as raw RGBA (base64) plus the camera state. */
async function capture(page) {
  return page.evaluate(() => {
    const map = globalThis.__fableGame.map;
    const cam = map.camera;
    const canvas = document.querySelector('.map-canvas');
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const bytes = new Uint8Array(data.data.buffer);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return {
      raw: btoa(binary),
      width: canvas.width,
      height: canvas.height,
      camera: { x: cam.x, y: cam.y, zoom: cam.zoom },
      layer: [map.landLayer.canvas.width, map.landLayer.canvas.height],
    };
  });
}

/** After the scripted moves: snapshot, then force a clean rebuild and snapshot again. */
/**
 * The invariant under test: the background raster is a *pure function* of camera and
 * content, so a camera visited, left, and visited again must render identically. Any
 * state carried over from incremental updates (the old scrollPatch did exactly that)
 * shows up here as mismatched terrain.
 */
const FIXED_NOW = 1_700_000_000_000;

/** Draw one deterministic frame at the current camera, then capture it. */
async function captureAtCamera(page) {
  const diff = await page.evaluate((fixedNow) => {
    const map = globalThis.__fableGame.map;
    // Label alpha is a time-latched fade: a camera that wandered through occluded
    // regions carries latch state that has nothing to do with the raster under test.
    // Reset it so both captures start from the same label state.
    map.labelFade = new map.labelFade.constructor(0, 0);
    // The HUD republishes label obstacles on a 180 ms timer; pin them to the baseline so a
    // capture cannot depend on when that timer last fired.
    if (globalThis.__parityObstacles) {
      map.labelObstacles = globalThis.__parityObstacles.map((r) => ({ ...r }));
    }
    // Transient frame decorations (bubbles, celebrations, float texts, arrival bounces)
    // accumulate while the camera wanders; none of them is the raster under test.
    map.bubbles.clear();
    map.floatTexts = [];
    map.celebrations = [];
    map.hitOverlays.clear();
    map.arrivalBounces.clear();
    map.moods.clear();
    const realNow = performance.now.bind(performance);
    // Several label/ambient paths read the wall clock directly.
    performance.now = () => fixedNow;
    try {
      map.draw(fixedNow);
    } finally {
      performance.now = realNow;
    }
    return null;
  }, FIXED_NOW);
  void diff;
  const layer = await captureLayer(page);
  const frame = await capture(page);
  return { layer, frame };
}

async function setCamera(page, camera) {
  return page.evaluate((camera) => {
    const map = globalThis.__fableGame.map;
    const cam = map.camera;
    cam.startTween(cam.x, cam.y, cam.zoom, 0);
    cam.zoom = cam.clampZoom(camera.zoom);
    cam.x = camera.x;
    cam.y = cam.clampCenterY(camera.y, cam.zoom);
    const realNow = performance.now.bind(performance);
    performance.now = () => 1_700_000_000_000;
    try {
      map.draw(1_700_000_000_000);
    } finally {
      performance.now = realNow;
    }
    return { x: cam.x, y: cam.y, zoom: cam.zoom };
  }, camera);
}

function diffBounds(a, b, width) {
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2] && a[i + 3] === b[i + 3]) continue;
    const px = (i / 4) % width;
    const py = Math.floor(i / 4 / width);
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  return maxX < 0 ? null : { x0: minX, y0: minY, x1: maxX, y1: maxY };
}

function diffRaw(aB64, bB64) {
  const a = Buffer.from(aB64, 'base64');
  const b = Buffer.from(bB64, 'base64');
  if (a.length !== b.length) return { sizeMismatch: [a.length, b.length] };
  let any = 0;
  let over2 = 0;
  let over8 = 0;
  let max = 0;
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) {
    const dr = Math.abs(a[i] - b[i]);
    const dg = Math.abs(a[i + 1] - b[i + 1]);
    const db = Math.abs(a[i + 2] - b[i + 2]);
    const da = Math.abs(a[i + 3] - b[i + 3]);
    const delta = Math.max(dr, dg, db, da);
    if (delta > 0) any += 1;
    if (delta > 2) over2 += 1;
    if (delta > 8) over8 += 1;
    if (delta > max) max = delta;
    sum += dr + dg + db + da;
  }
  const pixels = a.length / 4;
  return {
    pixels,
    diffAnyPct: round((100 * any) / pixels),
    diffOver2Pct: round((100 * over2) / pixels),
    diffOver8Pct: round((100 * over8) / pixels),
    meanAbsChannelDelta: round(sum / (pixels * 4)),
    maxChannelDelta: max,
  };
}

/**
 * The scripted pan sequence: small pans, world-seam crossings and pans during a zoom tween.
 */
function panScript(mapWidth) {
  const small = [];
  for (let i = 0; i < 20; i += 1) {
    small.push({ kind: 'pan', dx: i % 2 === 0 ? 46 : -18, dy: i % 5 === 0 ? 22 : 0 });
  }
  return [
    ...small,
    // Across the horizontal world seam (x wraps at MAP_W = 8192).
    { kind: 'abs', x: mapWidth - 300, y: 1212 },
    { kind: 'pan', dx: 700, dy: 0 },
    { kind: 'pan', dx: 700, dy: 0 },
    { kind: 'pan', dx: 700, dy: 0 },
    // Vertical extremes.
    { kind: 'pan', dx: 0, dy: 900 },
    { kind: 'pan', dx: 0, dy: -1400 },
    // Pans while a zoom tween is running.
    { kind: 'tween', dx: 420, frames: 6 },
    { kind: 'zoom', zoom: 0.8 },
    { kind: 'tween', dx: -380, frames: 6 },
    { kind: 'zoom', zoom: 1.5 },
    { kind: 'pan', dx: -120, dy: 60 },
  ];
}

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
  const result = { browser: browserName, view: viewName, viewport: vp, errors };
  try {
    await startLocalGame(page);
    await sleep(2500);
    result.frozen = await freezeBoard(page);
    await sleep(300);
    const steps = panScript(8192);
    result.cameraTrail = await driveCamera(page, steps);
    // Pin the home camera once, then apply it identically before each capture so the two
    // frames are guaranteed to share the same ox/oy/scale.
    const home = await page.evaluate(() => {
      const cam = globalThis.__fableGame.map.camera;
      cam.startTween(cam.x, cam.y, cam.zoom, 0);
      cam.zoom = cam.clampZoom(1.5);
      return { x: 4117, y: 1212, zoom: cam.zoom };
    });
    await setCamera(page, home);
    await page.evaluate(() => {
      globalThis.__parityObstacles = (globalThis.__fableGame.map.labelObstacles ?? []).map((r) => ({ ...r }));
    });
    const before = await captureAtCamera(page);
    // Leave via the scripted pan/zoom ride, then come back to the exact same camera.
    await driveCamera(page, panScript(8192));
    await setCamera(page, home);
    const after = await captureAtCamera(page);
    // A second visit through a *different* route (the original report was mid-game, after
    // a long, irregular camera history).
    await driveCamera(page, [
      { kind: 'abs', x: 6500, y: 900 },
      { kind: 'pan', dx: 380, dy: 260 },
      { kind: 'zoom', zoom: 1.15 },
      { kind: 'pan', dx: -240, dy: 420 },
      { kind: 'abs', x: 300, y: 1900 },
      { kind: 'zoom', zoom: 1.5 },
      { kind: 'pan', dx: 900, dy: -180 },
    ]);
    await setCamera(page, home);
    const again = await captureAtCamera(page);
    result.diffAgain = diffRaw(before.layer.raw, again.layer.raw);
    result.frameDiffAgain = diffRaw(before.frame.raw, again.frame.raw);
    result.diff = diffRaw(before.layer.raw, after.layer.raw);
    result.frameDiff = diffRaw(before.frame.raw, after.frame.raw);
    result.frameDiffBounds = diffBounds(
      Buffer.from(before.frame.raw, 'base64'),
      Buffer.from(after.frame.raw, 'base64'),
      before.frame.width,
    );
    result.camera = home;
    result.geom = before.layer.geom;
    result.rebuiltGeom = after.layer.geom;
    result.layer = [before.layer.width, before.layer.height];
    result.frame = [before.frame.width, before.frame.height];
    if (args.get('keep') === '1') {
      const dir = path.join(OUT, LABEL);
      await mkdir(dir, { recursive: true });
      await page.locator('.map-canvas').screenshot({ path: path.join(dir, `${browserName}-${viewName}.png`) });
      result.screenshot = `${browserName}-${viewName}.png`;
    }
  } catch (error) {
    result.error = String(error).slice(0, 300);
  } finally {
    await context.close();
    await browser.close();
  }
  return result;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const results = [];
  for (const browserName of BROWSERS) {
    for (const viewName of VIEWS) {
      const result = await runView(browserName, viewName);
      results.push(result);
      if (result.error) {
        console.log(`[parity] ${browserName} ${viewName}: ERROR ${result.error}`);
      } else if (result.diff.sizeMismatch) {
        console.log(`[parity] ${browserName} ${viewName}: SIZE MISMATCH ${result.diff.sizeMismatch}`);
      } else if (
        result.geom && result.rebuiltGeom &&
        (Math.abs(result.geom.ox - result.rebuiltGeom.ox) > 0.001 ||
          Math.abs(result.geom.oy - result.rebuiltGeom.oy) > 0.001 ||
          Math.abs(result.geom.scale - result.rebuiltGeom.scale) > 0.000001)
      ) {
        console.log(
          `[parity] ${browserName} ${viewName}: GEOMETRY CHANGED ${JSON.stringify(result.geom)} -> ` +
            `${JSON.stringify(result.rebuiltGeom)}`,
        );
      } else {
        console.log(
          `[parity] ${browserName} ${viewName}: layer any=${result.diff.diffAnyPct}% ` +
            `>8=${result.diff.diffOver8Pct}% mean=${result.diff.meanAbsChannelDelta} | ` +
            `frame any=${result.frameDiff.diffAnyPct}% max=${result.frameDiff.maxChannelDelta} ` +
            `again any=${result.diffAgain.diffAnyPct}% max=${result.diffAgain.maxChannelDelta} ` +
            `frameBounds=${JSON.stringify(result.frameDiffBounds)} ` +
            `(${result.layer.join('x')} layer, ${result.frame.join('x')} frame)`,
        );
      }
    }
  }
  await writeFile(path.join(OUT, `${LABEL}.json`), JSON.stringify({ label: LABEL, results }, null, 2));
  const failed = results.filter(
    (r) => r.error || r.diff?.sizeMismatch ||
      (r.diff?.diffAnyPct ?? 100) >= 1 || (r.frameDiff?.diffAnyPct ?? 100) >= 1 ||
      (r.diffAgain?.diffAnyPct ?? 100) >= 1,
  );
  console.log(JSON.stringify({ label: LABEL, runs: results.length, failed: failed.length }));
  if (failed.length > 0) process.exitCode = 1;
}

await main();