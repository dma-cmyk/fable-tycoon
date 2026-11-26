// Map-renderer frame profiler + parity screenshot harness.
//
//   node tests/e2e/map-perf.mjs profile --label=before [--view=pc|phone|both] [--seconds=8] [--zoom=normal]
//   node tests/e2e/map-perf.mjs shots   --label=before [--view=pc|phone|both]
//   node tests/e2e/map-perf.mjs diff    --before=before --after=after
//
// profile: boots a 1-year solo game, freezes the board (camera, ownership, city mods,
// errand) and drives `map.draw()` from its own rAF loop with the game's own render
// scheduler disabled. Measures draw-call time, rAF cadence, long tasks and samples the
// CDP CPU profile; writes .tmp/map-perf/<label>-<view>[-<zoom>].json.
//
// shots: renders one deterministic frame per scenario (fixed clock, reduced motion,
// injected ownership + city mods + errand) and stores canvas PNG + raw RGBA at
// .tmp/map-parity/<label>/<view>-<zoom>-<scenario>.{png,raw}.
//
// diff: compares two shot sets pixel by pixel (any delta, >2, >8, mean/max), and writes
// .tmp/map-parity/diff-<before>-<after>.json.
//
// The dev server must already be running (DEV_URL, default http://127.0.0.1:5272/).

import { chromium } from 'playwright';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PERF_OUT = path.join(ROOT, '.tmp/map-perf');
const SHOT_OUT = path.join(ROOT, '.tmp/map-parity');
const DEV_URL = process.env.DEV_URL || 'http://127.0.0.1:5272/';

const MODE = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'profile';
const args = new Map(
  process.argv
    .filter((arg) => arg.startsWith('--') && arg.includes('='))
    .map((arg) => [arg.slice(2, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]),
);
const LABEL = args.get('label') ?? 'run';
const BEFORE = args.get('before') ?? 'before';
const AFTER = args.get('after') ?? 'after';
const SECONDS = Number(args.get('seconds') ?? 8);
const VIEWS = (args.get('view') ?? 'both') === 'both' ? ['pc', 'phone'] : [args.get('view')];
const ZOOM_FILTER = args.get('zoom') ?? 'all';
const EFFECTS = args.get('effects') === '1';

const VIEWPORTS = {
  pc: { width: 1920, height: 1080, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  phone: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
};
const ZOOMS = { normal: 1.5, wide: 0.7 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  // Desktop and mobile builds expose different start buttons; click the visible one.
  const start = page.locator('.setup-start:visible, .setup-mobile-start:visible').first();
  await start.scrollIntoViewIfNeeded().catch(() => {});
  await start.click();
  await waitFor(page, () => visible(page, '.game-screen'), { timeout: 60_000, label: 'game screen' });
  await waitFor(
    page,
    () => page.evaluate(() => !!globalThis.__fableGame?.map && !!globalThis.__fableGame?.state),
    { timeout: 60_000, label: 'map + state' },
  );
}

/**
 * Freeze the board at a dense camera centre and inject a mid-game ownership/mod layout.
 * Runs once per measured window; everything here is deterministic for a given viewport.
 */
async function freezeBoard(page, { zoom, effects }) {
  return page.evaluate(
    ({ zoom, effects }) => {
      const game = globalThis.__fableGame;
      const map = game.map;
      map.setAutoViewFollow(false);
      map.follow(null);
      // Freeze every game-driven mutation: the board must stay identical for the whole
      // measured window (and across before/after runs).
      map.setState = () => {};
      map.setMoveOptions = () => {};
      map.animateMove = () => Promise.resolve();
      map.warp = () => Promise.resolve();
      map.cancelAnimations = () => {};
      map.focusNode = () => Promise.resolve();
      map.setView = () => {};
      map.bubble = () => {};
      map.celebrate = () => {};
      map.shake = () => {};
      map.playEmote = () => Promise.resolve();
      map.setMood = () => {};
      // Stop the game's own render scheduler: the camera must not tween or follow while
      // the harness drives explicit frames, or before/after shots see different views.
      map.requestRender = () => {};
      map.scheduleAmbient = () => {};
      if (map.raf) cancelAnimationFrame(map.raf);
      map.raf = 0;
      clearTimeout(map.ambientTimer);
      map.ambientTimer = null;
      const cam = map.camera;
      const entries = map.cityEntriesForView();
      // Dense camera centre: count cities inside the viewport at the target zoom.
      const W = cam.vw;
      const H = cam.vh;
      let best = null;
      for (const e of entries) {
        let n = 0;
        for (const o of entries) {
          let dx = o.node.x - e.node.x;
          dx -= Math.round(dx / 8192) * 8192;
          if (Math.abs(dx) * zoom <= W / 2 && Math.abs(o.node.y - e.node.y) * zoom <= H / 2) n += 1;
        }
        if (!best || n > best.n) best = { x: e.node.x, y: e.node.y, n, id: e.city.id };
      }
      // Cancel any in-flight camera tween before pinning the view.
      cam.startTween(cam.x, cam.y, cam.zoom, 0);
      cam.zoom = cam.clampZoom(zoom);
      cam.x = best.x;
      cam.y = cam.clampCenterY(best.y, cam.zoom);

      // Mid-game ownership: every city has buyers, every 7th is a monopoly.
      let i = 0;
      for (const [cityId, own] of map.ownership) {
        const counts = own.counts.map(() => 0);
        const total = Math.max(2, own.total);
        counts[i % counts.length] += Math.ceil(total * 0.5);
        counts[(i + 1) % counts.length] += Math.floor(total * 0.3);
        counts[(i + 2) % counts.length] += Math.max(0, total - Math.ceil(total * 0.8));
        const monopoly = i % 7 === 0 ? 0 : -1;
        map.ownership.set(cityId, { counts, total, monopoly });
        i += 1;
      }

      const state = map.state;
      // Deterministic scenery: fixed season, tokens on fixed cities, fixed destination
      // and errand, fixed active seat. Nothing here depends on the random game seed.
      map.month = 4;
      map.season = 'spring';
      map.seasonTransitionStart = 0;
      const fixed = (offset) => entries[(entries.length - 1 - offset) % entries.length];
      if (state) {
        map.tokens = state.players.map((player, k) => ({
          playerId: player.id,
          nodeId: fixed(k * 5 + 2).node.id,
        }));
        state.current = 0;
        state.month = 4;
        state.destination = fixed(9).city.id;
        map.destinationNodeId = fixed(9).node.id;
      }
      if (effects && state) {
        const ids = [fixed(4), fixed(8), fixed(12), fixed(16), fixed(20), fixed(24)].map((e) => e.city.id);
        state.cityMods = ids.map((cityId, k) => ({
          cityId,
          mult: 1.4,
          yearsLeft: 2,
          label: '好況',
          kind: ['boom', 'bubble', 'damage', 'blockade', 'boom', 'damage'][k % 6],
        }));
        const errandCity = fixed(6).city.id;
        state.errand = { cityId: errandCity };
        map.errandNodeId = fixed(6).node.id;
      } else if (state) {
        state.cityMods = [];
        state.errand = null;
        map.errandNodeId = null;
      }
      map.staticRevision += 1;
      map.landLayer.invalidate();
      map.requestRender();
      return {
        view: map.view,
        zoom: cam.zoom,
        camera: { x: cam.x, y: cam.y },
        cities: entries.length,
        denseCity: best.id,
        denseCount: best.n,
        dpr: map.dpr,
        canvas: { cssW: map.cssW, cssH: map.cssH },
        mods: effects ? 6 : 0,
      };
    },
    { zoom, effects },
  );
}

/** Install the measurement loop; returns the scenario descriptor. */
async function startBench(page, { drawExtra = 0 } = {}) {
  return page.evaluate(({ drawExtra }) => {
    const map = globalThis.__fableGame.map;
    // Disable the game's own render scheduler: the bench owns every frame.
    map.requestRender = () => {};
    map.scheduleAmbient = () => {};
    if (map.raf) cancelAnimationFrame(map.raf);
    map.raf = 0;
    clearTimeout(map.ambientTimer);
    map.ambientTimer = null;

    const bench = {
      drawTimes: [],
      rafDeltas: [],
      pedestalMs: 0,
      pedestalCalls: 0,
      running: true,
      last: 0,
      longTasks: [],
      drawExtra,
      flush: false,
    };
    globalThis.__mapBench = bench;

    const ped = map.drawCityPedestalAt.bind(map);
    map.drawCityPedestalAt = (...a) => {
      const t0 = performance.now();
      ped(...a);
      bench.pedestalMs += performance.now() - t0;
      bench.pedestalCalls += 1;
    };
    const blit = typeof map.blitCityPedestal === 'function' ? map.blitCityPedestal.bind(map) : null;
    if (blit) {
      map.blitCityPedestal = (...a) => {
        const t0 = performance.now();
        blit(...a);
        bench.pedestalMs += performance.now() - t0;
        bench.pedestalCalls += 1;
      };
    }

    const draw = map.draw.bind(map);
    const loop = (now) => {
      if (!bench.running) return;
      if (bench.last) bench.rafDeltas.push(now - bench.last);
      bench.last = now;
      const t0 = performance.now();
      draw(now);
      // Optional explicit flush: without it the canvas queues raster work and the cost
      // lands on a later (unrelated) step, which makes per-step attribution meaningless.
      if (bench.flush) map.ctx.getImageData(0, 0, 1, 1);
      bench.drawTimes.push(performance.now() - t0);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    return {
      frameStats: map.getFrameStats(),
      canvasBudget: map.getCanvasBudgetInfo(),
      hits: map.cityHits?.length ?? 0,
      mapSameAsGame: globalThis.__fableGame.map === map,
      ownPedestal: Object.prototype.hasOwnProperty.call(map, 'drawCityPedestalAt'),
      pedestalCalls: bench.pedestalCalls,
      pedestalMs: bench.pedestalMs,
    };
  }, { drawExtra });
}

/** Drop warm-up samples (tile loads, land-layer raster) and keep measuring. */
async function resetBench(page) {
  await page.evaluate(() => {
    const b = globalThis.__mapBench;
    b.drawTimes = [];
    b.rafDeltas = [];
    b.pedestalMs = 0;
    b.pedestalCalls = 0;
    b.last = 0;
    globalThis.__longTasks = [];
  });
}

async function stopBench(page) {
  const raw = await page.evaluate(() => {
    const b = globalThis.__mapBench;
    b.running = false;
    return {
      drawTimes: b.drawTimes,
      rafDeltas: b.rafDeltas,
      pedestalMs: b.pedestalMs,
      pedestalCalls: b.pedestalCalls,
      longTasks: b.longTasks,
    };
  });
  const stat = (values) => {
    if (!values.length) return { n: 0, p50: 0, p95: 0, max: 0, mean: 0 };
    const sorted = [...values].sort((a, b) => a - b);
    const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
    return {
      n: values.length,
      p50: round(pick(0.5)),
      p95: round(pick(0.95)),
      max: round(sorted[sorted.length - 1]),
      mean: round(values.reduce((a, b) => a + b, 0) / values.length),
    };
  };
  const frames = raw.drawTimes.length;
  return {
    frames,
    drawMs: stat(raw.drawTimes),
    rafMs: stat(raw.rafDeltas),
    pedestal: {
      calls: raw.pedestalCalls,
      perFrameMs: round(raw.pedestalMs / Math.max(1, frames)),
      totalMs: round(raw.pedestalMs),
      shareOfDraw: round(100 * raw.pedestalMs / Math.max(1, raw.drawTimes.reduce((a, b) => a + b, 0))),
    },
    slowFrames60: raw.rafDeltas.filter((d) => d > 20).length,
    longTasks: raw.longTasks,
  };
}

const round = (value) => Math.round(value * 100) / 100;

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function topFunctions(profile) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parent = new Map();
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) parent.set(child, node.id);
  }
  const chainOf = (id) => {
    const out = [];
    let cursor = id;
    for (let i = 0; i < 6 && cursor !== undefined; i += 1) {
      const node = nodes.get(cursor);
      if (!node) break;
      const cf = node.callFrame;
      out.push(`${cf.functionName || '(anon)'}${cf.url ? `@${cf.url.replace(/^https?:\/\/[^/]+\//, '')}:${cf.lineNumber + 1}` : ''}`);
      cursor = parent.get(cursor);
    }
    return out.join(' <- ');
  };
  const self = new Map();
  const chains = new Map();
  let total = 0;
  for (let i = 0; i < profile.samples.length; i += 1) {
    const node = nodes.get(profile.samples[i]);
    if (!node) continue;
    const dt = profile.timeDeltas[i] ?? 0;
    total += dt;
    const cf = node.callFrame;
    const url = (cf.url || '').replace(/^https?:\/\/[^/]+\//, '');
    const key = `${cf.functionName || '(anonymous)'} @ ${url}:${cf.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + dt);
    if (!chains.has(key)) chains.set(key, chainOf(node.id));
  }
  const rows = [...self.entries()]
    .map(([name, us]) => ({
      name,
      chain: chains.get(name),
      ms: round(us / 1000),
      pct: round((100 * us) / Math.max(1, total)),
    }))
    .sort((a, b) => b.ms - a.ms);
  return { totalMs: round(total / 1000), rows: rows.slice(0, 16) };
}

/**
 * Per-step breakdown of `draw()`: wraps the sub-draws the frame calls and reports mean
 * ms per frame for each. Nested steps are listed separately (a step's time includes its
 * children), so the top-level list is what to read first.
 */
/**
 * Static-raster rebuild cost: the game bumps `staticRevision` on every state update, which
 * repaints the whole land layer (including every city pedestal). Times N rebuilds.
 */
async function rebuildView(browser, view) {
  const vp = VIEWPORTS[view];
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.deviceScaleFactor,
    isMobile: vp.isMobile,
    hasTouch: vp.hasTouch,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
  });
  const page = await context.newPage();
  await startLocalGame(page);
  await sleep(2500);
  await freezeBoard(page, { zoom: ZOOMS.normal, effects: EFFECTS });
  await sleep(500);
  await startBench(page);
  await sleep(2500);
  const result = await page.evaluate(async () => {
    const map = globalThis.__fableGame.map;
    const bench = globalThis.__mapBench;
    bench.running = false;
    const now = performance.now();
    const measureFrame = () => {
      const t0 = performance.now();
      map.draw(now);
      map.ctx.getImageData(0, 0, 1, 1);
      return performance.now() - t0;
    };
    const spriteFn = map.cityPedestalSprite.bind(map);
    const paints = { count: 0 };
    const paint = map.paintCityPedestal.bind(map);
    map.paintCityPedestal = (...a) => { paints.count += 1; return paint(...a); };

    const runRebuilds = (frames) => {
      const out = [];
      for (let i = 0; i < frames; i += 1) {
        map.staticRevision += 1;
        map.landLayer.invalidate();
        bench.pedestalCalls = 0;
        bench.pedestalMs = 0;
        paints.count = 0;
        out.push({ ms: measureFrame(), calls: bench.pedestalCalls, pedMs: bench.pedestalMs, paints: paints.count });
      }
      return out;
    };

    const steady = [];
    for (let i = 0; i < 6; i += 1) steady.push(measureFrame());

    // A/B in one build: cached sprites vs the pre-optimisation direct paint path, plus
    // a no-pedestal control. Canvas work is deferred, so per-call timers attribute the
    // whole layer flush to whichever pedestal call happens to trigger it; the honest
    // pedestal cost is the rebuild total difference against the control.
    const spriteRuns = runRebuilds(4);
    map.cityPedestalSprite = () => null;
    const directRuns = runRebuilds(4);
    map.cityPedestalSprite = spriteFn;
    const pedAt = map.drawCityPedestalAt;
    map.drawCityPedestalAt = () => undefined;
    const noneRuns = runRebuilds(4);
    map.drawCityPedestalAt = pedAt;

    // One pedestal call per rebuild carries the whole land-raster flush; excluding the
    // largest sample isolates the pedestal work itself.
    const median = (values) => {
      if (!values.length) return 0;
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    };
    const summarize = (runs) => {
      const frames = runs.map((r) => r.ms);
      const ped = runs.map((r) => r.pedMs);
      const pedClean = runs.map((r) => {
        const calls = r.calls || 1;
        return Math.max(0, r.pedMs - r.pedMs / calls);
      });
      return {
        frames: frames.map((v) => Math.round(v * 100) / 100),
        pedestalTotalMs: Math.round(median(ped) * 10) / 10,
        pedestalCleanMs: Math.round(median(pedClean) * 10) / 10,
        calls: runs[runs.length - 1]?.calls ?? 0,
        paints: runs[runs.length - 1]?.paints ?? 0,
      };
    };
    const stat = (values) => {
      const sorted = [...values].sort((a, b) => a - b);
      const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
      return {
        n: sorted.length,
        p50: Math.round(pick(0.5) * 100) / 100,
        p95: Math.round(pick(0.95) * 100) / 100,
        mean: Math.round((sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length)) * 100) / 100,
      };
    };
    return {
      steady: stat(steady),
      sprites: summarize(spriteRuns),
      direct: summarize(directRuns),
      none: summarize(noneRuns),
      pedestalSprites: map.cityPedestalSprites?.size ?? 0,
      pedestalSpritePixels: map.cityPedestalPixels ?? 0,
      tileLoading: map.cityTileLoading?.size ?? 0,
      staticRevision: map.staticRevision,
    };
  });
  await context.close();
  return { label: LABEL, view, ...result };
}

/**
 * Ablation benchmark: measures the flushed frame cost with one draw step disabled at a
 * time. Deltas are the real cost of each step (canvas work is otherwise deferred).
 */
async function ablateView(browser, view) {
  const vp = VIEWPORTS[view];
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.deviceScaleFactor,
    isMobile: vp.isMobile,
    hasTouch: vp.hasTouch,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
  });
  const page = await context.newPage();
  await startLocalGame(page);
  await sleep(2500);
  await freezeBoard(page, { zoom: ZOOMS.normal, effects: false });
  await sleep(500);
  await startBench(page);
  await sleep(3000);
  const result = await page.evaluate(async () => {
    const map = globalThis.__fableGame.map;
    const bench = globalThis.__mapBench;
    const measure = async (ms) => {
      bench.drawTimes = [];
      const frames0 = bench.drawTimes.length;
      void frames0;
      await new Promise((resolve) => setTimeout(resolve, ms));
      const sorted = [...bench.drawTimes].sort((a, b) => a - b);
      const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
      return {
        n: sorted.length,
        p50: Math.round(pick(0.5) * 100) / 100,
        p95: Math.round(pick(0.95) * 100) / 100,
        mean: Math.round((sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length)) * 100) / 100,
      };
    };
    const targets = [
      ['ambient.drawClouds', map.ambient, 'drawClouds'],
      ['ambient.drawOceanDecor', map.ambient, 'drawOceanDecor'],
      ['ambient.draw(all)', map.ambient, 'draw'],
      ['drawCities', map, 'drawCities'],
      ['drawCityLabels', map, 'drawCityLabels'],
      ['drawMapArtLabels', map, 'drawMapArtLabels'],
      ['drawTokens', map, 'drawTokens'],
      ['drawMiniMap', map, 'drawMiniMap'],
      ['drawSeasonParticles', map, 'drawSeasonParticles'],
      ['ocean.draw', map.ocean, 'draw'],
      ['drawSquareShortLabels', map, 'drawSquareShortLabels'],
      ['drawWorldWarpTiles', map, 'drawWorldWarpTiles'],
    ];
    const baseline = await measure(2500);
    const rows = [];
    for (const [label, owner, name] of targets) {
      const original = owner[name];
      if (typeof original !== 'function') continue;
      owner[name] = () => undefined;
      const off = await measure(1500);
      owner[name] = original;
      rows.push({ label, offP50: off.p50, offP95: off.p95, deltaP50: Math.round((baseline.p50 - off.p50) * 100) / 100, deltaMean: Math.round((baseline.mean - off.mean) * 100) / 100 });
    }
    return { baseline, rows };
  });
  await context.close();
  return { label: LABEL, view, ...result };
}

async function breakdownView(browser, view) {
  const vp = VIEWPORTS[view];
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.deviceScaleFactor,
    isMobile: vp.isMobile,
    hasTouch: vp.hasTouch,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
  });
  const page = await context.newPage();
  await startLocalGame(page);
  await sleep(2500);
  await freezeBoard(page, { zoom: ZOOMS.normal, effects: false });
  await sleep(500);
  await startBench(page);
  await sleep(3000);
  const steps = await page.evaluate(async ({ flushEach }) => {
    const map = globalThis.__fableGame.map;
    const bench = globalThis.__mapBench;
    const steps = new Map();
    const wrap = (owner, name, label) => {
      const original = owner[name];
      if (typeof original !== 'function') return;
      owner[name] = function (...a) {
        const t0 = performance.now();
        try {
          return original.apply(this, a);
        } finally {
          if (flushEach) map.ctx.getImageData(0, 0, 1, 1);
          const entry = steps.get(label) ?? { ms: 0, calls: 0 };
          entry.ms += performance.now() - t0;
          entry.calls += 1;
          steps.set(label, entry);
        }
      };
    };
    wrap(map.ocean, 'draw', 'ocean.draw');
    wrap(map.landLayer, 'draw', 'landLayer.draw');
    wrap(map.landLayer, 'drawSeasonFade', 'landLayer.drawSeasonFade');
    wrap(map.ambient, 'draw', 'ambient.draw');
    wrap(map.ambient, 'drawClouds', 'ambient.drawClouds');
    wrap(map.ambient, 'drawRoutes', 'ambient.drawRoutes');
    wrap(map.ambient, 'drawOceanDecor', 'ambient.drawOceanDecor');
    wrap(map, 'drawMapArtLabels', 'drawMapArtLabels');
    wrap(map, 'drawCities', 'drawCities');
    wrap(map, 'drawCityLabels', 'drawCityLabels');
    wrap(map, 'drawCityMods', 'drawCityMods');
    wrap(map, 'drawTokens', 'drawTokens');
    wrap(map, 'drawMiniMap', 'drawMiniMap');
    wrap(map, 'drawWorldWarpTiles', 'drawWorldWarpTiles');
    wrap(map, 'drawSeasonParticles', 'drawSeasonParticles');
    wrap(map, 'drawMoveUi', 'drawMoveUi');
    wrap(map, 'drawBubbles', 'drawBubbles');
    wrap(map, 'drawFloatTexts', 'drawFloatTexts');
    wrap(map, 'drawBadge', 'drawBadge');
    wrap(map, 'drawSelectedPathOverlay', 'drawSelectedPathOverlay');
    wrap(map, 'drawOptionMarkers', 'drawOptionMarkers');
    wrap(map, 'drawCelebrations', 'drawCelebrations');
    wrap(map, 'drawWarpPreview', 'drawWarpPreview');
    wrap(map, 'drawCompass', 'drawCompass');
    wrap(map, 'computeLayouts', 'computeLayouts');
    wrap(map, 'drawSquareShortLabels', 'drawSquareShortLabels');
    const framesBefore = bench.drawTimes.length;
    await new Promise((resolve) => setTimeout(resolve, 4000));
    const frames = bench.drawTimes.length - framesBefore;
    return {
      frames,
      steps: [...steps.entries()]
        .map(([label, entry]) => ({
          label,
          perFrameMs: Math.round((entry.ms / Math.max(1, frames)) * 100) / 100,
          callsPerFrame: Math.round((entry.calls / Math.max(1, frames)) * 100) / 100,
        }))
        .sort((a, b) => b.perFrameMs - a.perFrameMs),
    };
  }, { flushEach: args.get('flushEach') === '1' });
  await context.close();
  return { label: LABEL, view, ...steps };
}

/**
 * Simulated fx-update cadence: applies a real `setState` every `--every` ms while the map's
 * own render loop runs, and reports draw time, rAF cadence, long tasks, land-layer rebuild
 * count and the CDP CPU profile. `--policy=before` reproduces the pre-optimisation code
 * paths in the same build (always invalidate the static layer, no pedestal sprites).
 */
async function updatesView(browser, view, policy) {
  const vp = VIEWPORTS[view];
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.deviceScaleFactor,
    isMobile: vp.isMobile,
    hasTouch: vp.hasTouch,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    globalThis.__longTasks = [];
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          globalThis.__longTasks.push({ start: Math.round(entry.startTime), duration: Math.round(entry.duration) });
        }
      }).observe({ entryTypes: ['longtask'] });
    } catch {
      // longtask unsupported
    }
  });
  await startLocalGame(page);
  await sleep(2500);
  const frozen = await freezeBoard(page, { zoom: ZOOMS[ZOOM_FILTER === 'all' ? 'normal' : ZOOM_FILTER], effects: EFFECTS });
  // `freezeBoard` stubs setState; the update cadence needs it back.
  await page.evaluate(({ policy, every }) => {
    const game = globalThis.__fableGame;
    const map = game.map;
    const proto = Object.getPrototypeOf(map);
    // The game screen keeps sending its own snapshots; keep them out so the only updates
    // applied are the synthetic, fixed-camera ones this benchmark drives.
    const applyState = proto.setState.bind(map);
    map.follow = () => {};
    if (policy === 'before') {
      // Old policy: every update repaints the static layer, and pedestals paint directly.
      map.setState = (state) => {
        applyState(state);
        map.staticRevision += 1;
        map.landLayer.invalidate();
      };
      map.cityPedestalSprite = () => null;
    } else {
      map.setState = (state) => applyState(state);
    }
    map.requestRender = proto.requestRender.bind(map);
    map.scheduleAmbient = proto.scheduleAmbient.bind(map);
    map.focusNode = () => Promise.resolve();
    map.setView = () => {};
    map.resetFrameStats();
    globalThis.__rebuilds = 0;
    globalThis.__invalidates = 0;
    globalThis.__tileRefresh = 0;
    const invalidate = map.landLayer.invalidate.bind(map.landLayer);
    map.landLayer.invalidate = () => {
      globalThis.__invalidates += 1;
      return invalidate();
    };
    const refresh = map.scheduleCityTileRefresh.bind(map);
    map.scheduleCityTileRefresh = () => {
      globalThis.__tileRefresh += 1;
      return refresh();
    };
    globalThis.__rebuildLog = [];
    const rebuild = map.landLayer.rebuild.bind(map.landLayer);
    map.landLayer.rebuild = (...a) => {
      globalThis.__rebuilds += 1;
      globalThis.__rebuildLog.push({
        t: Math.round(performance.now()),
        rev: map.staticRevision,
        cam: [Math.round(map.camera.x), Math.round(map.camera.y), Math.round(map.camera.zoom * 1000) / 1000],
        loading: map.cityTileLoading?.size ?? 0,
        sprites: map.cityPedestalSprites?.size ?? 0,
      });
      return rebuild(...a);
    };
    globalThis.__ped = { ms: 0, calls: 0, paints: 0, paintMs: 0 };
    const pedAt = map.drawCityPedestalAt.bind(map);
    map.drawCityPedestalAt = (...a) => {
      const t0 = performance.now();
      try {
        return pedAt(...a);
      } finally {
        globalThis.__ped.ms += performance.now() - t0;
        globalThis.__ped.calls += 1;
      }
    };
    const paintPed = map.paintCityPedestal.bind(map);
    map.paintCityPedestal = (...a) => {
      const t0 = performance.now();
      try {
        return paintPed(...a);
      } finally {
        globalThis.__ped.paintMs += performance.now() - t0;
        globalThis.__ped.paints += 1;
      }
    };
    globalThis.__drawTimes = [];
    const draw = map.draw.bind(map);
    map.draw = (...a) => {
      const t0 = performance.now();
      try {
        return draw(...a);
      } finally {
        globalThis.__drawTimes.push(performance.now() - t0);
      }
    };
    // Drive updates: rotate tokens over fixed cities and nudge cash, so the map sees a
    // normal snapshot stream (same shape as a live fx update) without the fx player.
    const entries = map.cityEntriesForView();
    const ids = [3, 40, 90, 140, 200, 260].map((i) => entries[i % entries.length].node.id);
    globalThis.__updateTimer = setInterval(() => {
      const current = map.state;
      if (!current) return;
      const next = JSON.parse(JSON.stringify(current));
      next.current = (next.current + 1) % next.players.length;
      for (let i = 0; i < next.players.length; i += 1) {
        next.players[i].nodeId = ids[(i + (globalThis.__tick ?? 0)) % ids.length];
        next.players[i].cash = (next.players[i].cash ?? 0) + 1;
      }
      globalThis.__tick = (globalThis.__tick ?? 0) + 1;
      map.setState(next);
      map.requestRender();
    }, every);
  }, { policy, every: Number(args.get('every') ?? 120) });
  await sleep(2500);
  await page.evaluate(() => {
    globalThis.__drawTimes = [];
    globalThis.__rebuilds = 0;
    globalThis.__invalidates = 0;
    globalThis.__tileRefresh = 0;
    globalThis.__longTasks = [];
    globalThis.__ped = { ms: 0, calls: 0, paints: 0, paintMs: 0 };
    globalThis.__fableGame.map.resetFrameStats();
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');
  await sleep(SECONDS * 1000);
  const { profile } = await cdp.send('Profiler.stop');
  await cdp.send('Profiler.disable');
  const measured = await page.evaluate(() => {
    const map = globalThis.__fableGame.map;
    clearInterval(globalThis.__updateTimer);
    const stat = (values) => {
      if (!values.length) return { n: 0, p50: 0, p95: 0, max: 0, mean: 0 };
      const sorted = [...values].sort((a, b) => a - b);
      const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
      return {
        n: values.length,
        p50: Math.round(pick(0.5) * 100) / 100,
        p95: Math.round(pick(0.95) * 100) / 100,
        max: Math.round(sorted[sorted.length - 1] * 100) / 100,
        mean: Math.round((sorted.reduce((a, b) => a + b, 0) / values.length) * 100) / 100,
      };
    };
    return {
      draw: stat(globalThis.__drawTimes),
      raf: stat(map.frameTimes),
      rebuilds: globalThis.__rebuilds,
      invalidates: globalThis.__invalidates,
      rebuildLog: globalThis.__rebuildLog,
      causes: globalThis.__causes,
      pedestal: {
        ms: Math.round(globalThis.__ped.ms * 10) / 10,
        calls: globalThis.__ped.calls,
        perFrameMs: Math.round((globalThis.__ped.ms / Math.max(1, globalThis.__drawTimes.length)) * 100) / 100,
        paints: globalThis.__ped.paints,
        paintMs: Math.round(globalThis.__ped.paintMs * 10) / 10,
      },
      tileRefresh: globalThis.__tileRefresh,
      longTasks: globalThis.__longTasks,
      canvasBudget: map.getCanvasBudgetInfo(),
      pedestalSprites: map.cityPedestalSprites?.size ?? 0,
    };
  });
  await context.close();
  const longTasks = measured.longTasks;
  return {
    label: LABEL,
    view,
    policy,
    viewport: { width: vp.width, height: vp.height, dpr: vp.deviceScaleFactor },
    frozen,
    seconds: SECONDS,
    ...measured,
    longTaskSummary: {
      count: longTasks.length,
      over100: longTasks.filter((t) => t.duration > 100).length,
      totalMs: longTasks.reduce((sum, t) => sum + t.duration, 0),
      maxMs: longTasks.reduce((max, t) => Math.max(max, t.duration), 0),
    },
    profile: topFunctions(profile),
    errors,
  };
}

/**
 * Isolated pedestal cost: draws every visible station into the real land-layer context
 * (the surface production uses), flushing before and after so the number includes
 * rasterisation. Compares the cached-sprite path against the direct paint path.
 */
async function pedCostView(browser, view) {
  const vp = VIEWPORTS[view];
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.deviceScaleFactor,
    isMobile: vp.isMobile,
    hasTouch: vp.hasTouch,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
  });
  const page = await context.newPage();
  await startLocalGame(page);
  await sleep(2500);
  await freezeBoard(page, { zoom: ZOOMS[ZOOM_FILTER === 'all' ? 'normal' : ZOOM_FILTER], effects: EFFECTS });
  await sleep(800);
  const result = await page.evaluate(() => {
    const map = globalThis.__fableGame.map;
    map.requestRender = () => {};
    map.scheduleAmbient = () => {};
    if (map.raf) cancelAnimationFrame(map.raf);
    map.raf = 0;
    const ctx = map.landLayer.ctx;
    const radius = map.cityRadius() * map.dpr;
    const cities = map.cityEntries
      .map((e) => ({ city: e.city, owner: map.ownership.get(e.city.id) }))
      .slice(0, 200);
    const spriteFn = map.cityPedestalSprite.bind(map);
    const bench = (label) => {
      const runs = [];
      for (let pass = 0; pass < 5; pass += 1) {
        ctx.getImageData(0, 0, 1, 1);
        let calls = 0;
        let paints = 0;
        const paint = map.paintCityPedestal;
        map.paintCityPedestal = (...a) => { paints += 1; return paint.apply(map, a); };
        const t0 = performance.now();
        for (let i = 0; i < cities.length; i += 1) {
          const x = 180 + (i % 20) * 120;
          const y = 220 + Math.floor(i / 20) * 120;
          map.drawCityPedestalAt(ctx, x, y, radius, cities[i].owner, cities[i].city, 1);
          calls += 1;
        }
        ctx.getImageData(0, 0, 1, 1);
        const ms = performance.now() - t0;
        map.paintCityPedestal = paint;
        runs.push({ ms: Math.round(ms * 100) / 100, calls, paints });
      }
      const sorted = [...runs.map((r) => r.ms)].sort((a, b) => a - b);
      return {
        label,
        runs: runs.map((r) => r.ms),
        p50: sorted[Math.floor(sorted.length / 2)],
        calls: runs[runs.length - 1].calls,
        paints: runs[runs.length - 1].paints,
        perCallMs: Math.round((sorted[Math.floor(sorted.length / 2)] / cities.length) * 1000) / 1000,
      };
    };
    const sprites = bench('sprites');
    map.cityPedestalSprite = () => null;
    const direct = bench('direct');
    map.cityPedestalSprite = spriteFn;
    return { count: cities.length, radius: Math.round(radius * 10) / 10, layer: [ctx.canvas.width, ctx.canvas.height], sprites, direct };
  });
  await context.close();
  return { label: LABEL, view, ...result };
}

/**
 * Rebuild composition: disables each `paintStaticBoard` sub-step in turn and measures the
 * land-layer rebuild. `paintStaticBoard` runs on the layer context, so canvas work is
 * attributed to the rebuild as a whole; the deltas are the honest per-step cost.
 */
async function rebuildPartsView(browser, view) {
  const vp = VIEWPORTS[view];
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.deviceScaleFactor,
    isMobile: vp.isMobile,
    hasTouch: vp.hasTouch,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
  });
  const page = await context.newPage();
  await startLocalGame(page);
  await sleep(2500);
  await freezeBoard(page, { zoom: ZOOMS[ZOOM_FILTER === 'all' ? 'normal' : ZOOM_FILTER], effects: EFFECTS });
  await sleep(2500);
  const result = await page.evaluate(() => {
    const map = globalThis.__fableGame.map;
    map.requestRender = () => {};
    map.scheduleAmbient = () => {};
    if (map.raf) cancelAnimationFrame(map.raf);
    map.raf = 0;
    const measure = () => {
      const runs = [];
      for (let i = 0; i < 5; i += 1) {
        map.staticRevision += 1;
        map.landLayer.invalidate();
        map.ctx.getImageData(0, 0, 1, 1);
        const t0 = performance.now();
        map.draw(performance.now());
        map.ctx.getImageData(0, 0, 1, 1);
        runs.push(performance.now() - t0);
      }
      const sorted = [...runs].sort((a, b) => a - b);
      return Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10;
    };
    const targets = [
      ['drawMapArt', map, 'drawMapArt'],
      ['drawTerrain', map, 'drawTerrain'],
      ['drawCityClusters', map, 'drawCityClusters'],
      ['drawCityPedestalAt', map, 'drawCityPedestalAt'],
      ['drawGem', map, 'drawGem'],
      ['paintStaticBoard(all)', map, 'paintStaticBoard'],
    ];
    const base = measure();
    const rows = [];
    for (const [label, owner, name] of targets) {
      const original = owner[name];
      if (typeof original !== 'function') continue;
      owner[name] = () => undefined;
      const off = measure();
      owner[name] = original;
      rows.push({ label, offMs: off, deltaMs: Math.round((base - off) * 10) / 10 });
    }
    return {
      baseMs: base,
      rows,
      layer: [map.landLayer.ctx.canvas.width, map.landLayer.ctx.canvas.height],
    };
  });
  await context.close();
  return { label: LABEL, view, ...result };
}

/** Drives the human seat through the real UI, like a player (fx-measure's driver). */
async function stepHuman(page) {
  return page.evaluate(() => {
    const game = globalThis.__fableGame;
    const s = game?.state;
    if (!game || !s) return { waiting: true };
    if (s.phase.t === 'game_over') return { done: true };
    if (game.fxBusy || game.fxPlayer?.busy) return { waiting: true };
    const player = s.players[s.current];
    if (!player || player.isCpu) return { waiting: true };
    const owner = s.owner ?? {};
    const ownedByMe = Object.keys(owner).find((id) => owner[id] === s.current);
    let action = null;
    switch (s.phase.t) {
      case 'turn_start': action = { t: 'roll' }; break;
      case 'choose_dest': action = s.phase.options?.[0] ? { t: 'move', nodeId: s.phase.options[0].nodeId } : null; break;
      case 'buy': action = { t: 'end_buy' }; break;
      case 'event': action = { t: 'choose', index: 0 }; break;
      case 'card_target': action = s.phase.options?.[0] ? { t: 'card_target', target: s.phase.options[0] } : { t: 'cancel' }; break;
      case 'skill_target': action = s.phase.options?.[0] ? { t: 'skill_target', target: s.phase.options[0] } : { t: 'cancel' }; break;
      case 'discard': action = player.cards?.[0] ? { t: 'discard', cardId: player.cards[0] } : null; break;
      case 'sell': action = ownedByMe ? { t: 'sell', propertyId: ownedByMe } : null; break;
      case 'shop': action = { t: 'end_shop' }; break;
      case 'year_end': action = { t: 'ack' }; break;
      default: action = null;
    }
    if (!action) return { waiting: true };
    game.sendAction(action);
    return { acted: true };
  });
}

/**
 * Real-play window: 1-year solo game at `?speed=8`, the human seat driven through the UI,
 * measuring map draws, land-layer rebuilds and long tasks for `--seconds`. `--policy=before`
 * reproduces the old renderer (rebuild the static layer on every update, blit the whole
 * raster) inside the same build.
 */
async function playView(browser, view, policy) {
  const vp = VIEWPORTS[view];
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
  await page.addInitScript(() => {
    globalThis.__longTasks = [];
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          globalThis.__longTasks.push({ start: Math.round(entry.startTime), duration: Math.round(entry.duration) });
        }
      }).observe({ entryTypes: ['longtask'] });
    } catch {
      // longtask unsupported
    }
  });
  await page.goto(new URL(`?speed=${args.get('speed') ?? 8}`, DEV_URL).toString(), { waitUntil: 'domcontentloaded' });
  await waitFor(page, () => visible(page, '.title-menu-btn'), { label: 'title screen' });
  await page.locator('.title-menu-btn').filter({ hasText: 'ひとりで' }).first().click();
  await waitFor(page, () => visible(page, '.setup-screen'), { timeout: 20_000, label: 'setup screen' });
  await page.locator('.seg-btn').filter({ hasText: /^1年$/ }).first().click();
  await page.locator('.setup-start:visible, .setup-mobile-start:visible').first().click();
  await waitFor(page, () => visible(page, '.game-screen'), { timeout: 60_000, label: 'game screen' });
  await waitFor(page, () => page.evaluate(() => !!globalThis.__fableGame?.map?.state), { timeout: 60_000, label: 'map' });
  await sleep(2000);
  await page.evaluate(({ policy }) => {
    const map = globalThis.__fableGame.map;
    globalThis.__rebuilds = 0;
    globalThis.__rebuildLog = [];
    globalThis.__causes = { bake: 0, tiles: 0 };
    const ensure = map.ensureBakedLayer.bind(map);
    map.ensureBakedLayer = () => {
      const before = map.staticRevision;
      ensure();
      if (map.staticRevision !== before) globalThis.__causes.bake += 1;
    };
    let lastKey = '';
    const rebuild = map.landLayer.rebuild.bind(map.landLayer);
    map.landLayer.rebuild = (...a) => {
      globalThis.__rebuilds += 1;
      globalThis.__rebuildLog.push({
        t: Math.round(performance.now()),
        reason: map.landLayer.key === lastKey ? 'margin' : 'key',
        zoom: Math.round(map.camera.zoom * 1000) / 1000,
        rev: map.staticRevision,
      });
      const out = rebuild(...a);
      lastKey = map.landLayer.key;
      return out;
    };
    globalThis.__drawTimes = [];
    const draw = map.draw.bind(map);
    map.draw = (...a) => {
      const t0 = performance.now();
      try {
        return draw(...a);
      } finally {
        globalThis.__drawTimes.push(performance.now() - t0);
      }
    };
    globalThis.__ped = { ms: 0, calls: 0 };
    const ped = map.drawCityPedestalAt.bind(map);
    map.drawCityPedestalAt = (...a) => {
      const t0 = performance.now();
      try {
        return ped(...a);
      } finally {
        globalThis.__ped.ms += performance.now() - t0;
        globalThis.__ped.calls += 1;
      }
    };
    if (policy === 'before') {
      const applyState = map.setState.bind(map);
      map.setState = (state) => {
        applyState(state);
        map.staticRevision += 1;
        map.landLayer.invalidate();
      };
      map.landLayer.blitLand = function blitWhole(target, cam, screenX, screenY) {
        target.drawImage(this.canvas, screenX, screenY, this.wWorld * cam.zoom, this.hWorld * cam.zoom);
      };
    }
  }, { policy });
  await sleep(1000);
  await page.evaluate(() => {
    globalThis.__drawTimes = [];
    globalThis.__rebuilds = 0;
    globalThis.__longTasks = [];
    globalThis.__ped = { ms: 0, calls: 0 };
    globalThis.__fableGame.map.resetFrameStats();
  });
  const deadline = Date.now() + SECONDS * 1000;
  let acted = 0;
  while (Date.now() < deadline) {
    const result = await stepHuman(page).catch(() => ({ waiting: true }));
    if (result.acted) acted += 1;
    if (result.done) break;
    await sleep(result.acted ? 200 : 120);
  }
  const measured = await page.evaluate(() => {
    const map = globalThis.__fableGame.map;
    const stat = (values) => {
      if (!values.length) return { n: 0, p50: 0, p95: 0, max: 0 };
      const sorted = [...values].sort((a, b) => a - b);
      const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
      return {
        n: values.length,
        p50: Math.round(pick(0.5) * 100) / 100,
        p95: Math.round(pick(0.95) * 100) / 100,
        max: Math.round(sorted[sorted.length - 1] * 100) / 100,
      };
    };
    return {
      draw: stat(globalThis.__drawTimes),
      raf: stat(map.frameTimes),
      rebuilds: globalThis.__rebuilds,
      pedestalMs: Math.round(globalThis.__ped.ms * 10) / 10,
      pedestalCalls: globalThis.__ped.calls,
      longTasks: globalThis.__longTasks,
      rebuildLog: globalThis.__rebuildLog,
      causes: globalThis.__causes,
      frameStats: map.getFrameStats(),
    };
  });
  await context.close();
  const longTasks = measured.longTasks;
  return {
    label: LABEL,
    view,
    policy,
    viewport: { width: vp.width, height: vp.height, dpr: vp.deviceScaleFactor },
    seconds: SECONDS,
    acted,
    ...measured,
    longTaskSummary: {
      count: longTasks.length,
      over100: longTasks.filter((t) => t.duration > 100).length,
      totalMs: longTasks.reduce((sum, t) => sum + t.duration, 0),
      maxMs: longTasks.reduce((max, t) => Math.max(max, t.duration), 0),
    },
    errors,
  };
}

async function profileView(browser, view) {
  const vp = VIEWPORTS[view];
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.deviceScaleFactor,
    isMobile: vp.isMobile,
    hasTouch: vp.hasTouch,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    globalThis.__longTasks = [];
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          globalThis.__longTasks.push({ start: Math.round(entry.startTime), duration: Math.round(entry.duration) });
        }
      }).observe({ entryTypes: ['longtask'] });
    } catch {
      // longtask unsupported: leave the array empty
    }
  });
  await startLocalGame(page);
  await sleep(2500);
  const frozen = await freezeBoard(page, { zoom: ZOOMS.normal, effects: false });
  await sleep(700);

  const cdp = await context.newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  const benchInfo = await startBench(page);
  // Warm up: city tile/webp loads and the first land-layer raster land asynchronously.
  await sleep(3000);
  await resetBench(page);
  await cdp.send('Profiler.start');
  await sleep(SECONDS * 1000);
  const { profile } = await cdp.send('Profiler.stop');
  const live = await page.evaluate(() => ({
    pedestalCalls: globalThis.__mapBench.pedestalCalls,
    pedestalMs: Math.round(globalThis.__mapBench.pedestalMs),
    frames: globalThis.__mapBench.drawTimes.length,
    ownPedestal: Object.prototype.hasOwnProperty.call(globalThis.__fableGame.map, 'drawCityPedestalAt'),
  }));
  const measured = await stopBench(page);
  measured.live = live;
  measured.longTasks = await page.evaluate(() => globalThis.__longTasks ?? []);
  await cdp.send('Profiler.disable');

  const result = {
    label: LABEL,
    view,
    viewport: { width: vp.width, height: vp.height, dpr: vp.deviceScaleFactor },
    frozen,
    benchInfo,
    seconds: SECONDS,
    ...measured,
    profile: topFunctions(profile),
    errors,
  };
  await context.close();
  return result;
}

async function captureShots(browser, view, policy = 'after') {
  const vp = VIEWPORTS[view];
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
  await startLocalGame(page);
  await sleep(2500);

  const dir = path.join(SHOT_OUT, LABEL);
  await mkdir(dir, { recursive: true });
  // `policy=before` reproduces the pre-optimisation pixel path inside the same build:
  // pedestals baked into the land layer with the direct paint path, and the land raster
  // blitted whole.
  if (policy === 'before') {
    // Old renderer behaviour inside the same build: the static board is repainted on every
    // update, and the whole raster rect is blitted every frame. The bake itself is the
    // unchanged code, so any leftover diff is the emulation, not the change under test.
    await page.evaluate(() => {
      const map = globalThis.__fableGame.map;
      const applyState = map.setState.bind(map);
      map.setState = (state) => {
        applyState(state);
        map.staticRevision += 1;
        map.landLayer.invalidate();
      };
      const layer = map.landLayer;
      layer.blitLand = function blitWhole(target, cam, screenX, screenY) {
        target.drawImage(this.canvas, screenX, screenY, this.wWorld * cam.zoom, this.hWorld * cam.zoom);
      };
    });
  }
  const zooms = ZOOM_FILTER === 'all' ? ['normal', 'wide'] : [ZOOM_FILTER];
  const results = [];
  for (const zoomName of zooms) {
    for (const effects of [false, true]) {
      const frozen = await freezeBoard(page, { zoom: ZOOMS[zoomName], effects });
      // Label alpha is a time-based fade latch; replace it with an instant variant so a
      // fixed-clock capture cannot depend on how many frames the warm-up happened to run.
      await page.evaluate(() => {
        const map = globalThis.__fableGame.map;
        map.labelFade = new map.labelFade.constructor(0, 0);
      });
      // City tile art decodes asynchronously; draw with real time in between so every
      // visible station has its final art before the deterministic capture frame.
      for (let warm = 0; warm < 8; warm += 1) {
        await page.evaluate(() => {
          const map = globalThis.__fableGame.map;
          map.draw(1_700_000_000_000);
        });
        await sleep(140);
      }
      const shot = await page.evaluate(() => {
        const map = globalThis.__fableGame.map;
        // Several label/blocker paths read the wall clock directly; pin it so the frame
        // is a pure function of the frozen board.
        const fixedNow = 1_700_000_000_000;
        const realNow = performance.now.bind(performance);
        performance.now = () => fixedNow;
        map.requestRender = () => {};
        map.scheduleAmbient = () => {};
        if (map.raf) cancelAnimationFrame(map.raf);
        map.raf = 0;
        clearTimeout(map.ambientTimer);
        map.ambientTimer = null;
        // Two passes: the first primes per-frame caches (label layout, hits), the second
        // is the frame that gets captured.
        map.draw(fixedNow);
        map.draw(fixedNow);
        const canvas = document.querySelector('.map-canvas');
        const url = canvas.toDataURL('image/png');
        const ctx = canvas.getContext('2d');
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const bytes = new Uint8Array(data.data.buffer);
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        const out = {
          png: url.slice('data:image/png;base64,'.length),
          raw: btoa(binary),
          width: canvas.width,
          height: canvas.height,
          labelCount: map.cityLabelDrawn?.length ?? 0,
          hits: map.cityHits?.length ?? 0,
        };
        performance.now = realNow;
        return out;
      });
      const name = `${view}-${zoomName}-${effects ? 'effects' : 'plain'}`;
      await writeFile(path.join(dir, `${name}.png`), Buffer.from(shot.png, 'base64'));
      await writeFile(path.join(dir, `${name}.raw`), Buffer.from(shot.raw, 'base64'));
      results.push({
        name,
        view,
        zoom: zoomName,
        effects,
        frozen,
        width: shot.width,
        height: shot.height,
        hits: shot.hits,
        labels: shot.labelCount,
      });
      console.log(
        `[shots] ${LABEL} ${name}: ${shot.width}x${shot.height} cities=${shot.hits} labels=${shot.labelCount} ` +
          `camera=${frozen.camera.x.toFixed(1)},${frozen.camera.y.toFixed(1)}@${frozen.zoom}`,
      );
    }
  }
  await writeFile(
    path.join(dir, `${view}-index.json`),
    JSON.stringify({ label: LABEL, view, viewport: vp, results, errors }, null, 2),
  );
  await context.close();
  return results;
}

async function diffShots() {
  const beforeDir = path.join(SHOT_OUT, BEFORE);
  const afterDir = path.join(SHOT_OUT, AFTER);
  const names = (await readdir(beforeDir)).filter((name) => name.endsWith('.raw'));
  const report = { before: BEFORE, after: AFTER, comparisons: [] };
  for (const file of names.sort()) {
    let afterBuf;
    try {
      afterBuf = await readFile(path.join(afterDir, file));
    } catch {
      report.comparisons.push({ name: file.replace(/\.raw$/, ''), missing: true });
      continue;
    }
    const beforeBuf = await readFile(path.join(beforeDir, file));
    if (beforeBuf.length !== afterBuf.length) {
      report.comparisons.push({ name: file.replace(/\.raw$/, ''), sizeMismatch: true });
      continue;
    }
    const a = new Uint8Array(beforeBuf);
    const b = new Uint8Array(afterBuf);
    let any = 0;
    let over2 = 0;
    let over8 = 0;
    let max = 0;
    let sum = 0;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -1;
    let maxY = -1;
    const width = report.width ?? null;
    void width;
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
    report.comparisons.push({
      name: file.replace(/\.raw$/, ''),
      pixels,
      diffAnyPct: round((100 * any) / pixels),
      diffOver2Pct: round((100 * over2) / pixels),
      diffOver8Pct: round((100 * over8) / pixels),
      meanAbsChannelDelta: round(sum / (pixels * 4)),
      maxChannelDelta: max,
    });
  }
  // Canvas size per file: derive from the index files.
  const indexFiles = (await readdir(beforeDir)).filter((name) => name.endsWith('-index.json'));
  for (const file of indexFiles) {
    const index = JSON.parse(await readFile(path.join(beforeDir, file), 'utf8'));
    for (const result of index.results) {
      const row = report.comparisons.find((entry) => entry.name === result.name);
      if (row) row.size = `${result.width}x${result.height}`;
    }
  }
  await mkdir(SHOT_OUT, { recursive: true });
  await writeFile(path.join(SHOT_OUT, `diff-${BEFORE}-${AFTER}.json`), JSON.stringify(report, null, 2));
  for (const row of report.comparisons) {
    console.log(
      row.missing || row.sizeMismatch
        ? `[diff] ${row.name}: ${row.missing ? 'missing after shot' : 'size mismatch'}`
        : `[diff] ${row.name} ${row.size}: any=${row.diffAnyPct}% >2=${row.diffOver2Pct}% ` +
            `>8=${row.diffOver8Pct}% mean=${row.meanAbsChannelDelta} max=${row.maxChannelDelta}`,
    );
  }
}

async function main() {
  await mkdir(PERF_OUT, { recursive: true });
  await mkdir(SHOT_OUT, { recursive: true });
  if (MODE === 'diff') {
    await diffShots();
    return;
  }
  const browser = await chromium.launch({
    headless: true,
    args: ['--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  });
  try {
    const out = [];
    for (const view of VIEWS) {
      if (MODE === 'profile') {
        const result = await profileView(browser, view);
        out.push(result);
        await writeFile(path.join(PERF_OUT, `${LABEL}-${view}.json`), JSON.stringify(result, null, 2));
        console.log(
          `[profile] ${LABEL} ${view}: frames=${result.frames} draw p50=${result.drawMs.p50} ` +
            `p95=${result.drawMs.p95} max=${result.drawMs.max} | raf p50=${result.rafMs.p50} p95=${result.rafMs.p95} ` +
            `| pedestal ${result.pedestal.perFrameMs}ms/frame (${result.pedestal.shareOfDraw}%) ` +
            `cities=${result.frozen.denseCount}`,
        );
        for (const row of result.profile.rows.slice(0, 10)) {
          console.log(`  ${row.ms.toFixed(0).padStart(6)}ms ${String(row.pct).padStart(5)}%  ${row.name}`);
        }
      } else if (MODE === 'play') {
        for (const policy of (args.get('policy') ?? 'after').split(',')) {
          const result = await playView(browser, view, policy);
          out.push(result);
          await writeFile(path.join(PERF_OUT, `${LABEL}-${policy}-play-${view}.json`), JSON.stringify(result, null, 2));
          console.log(
            `[play] ${LABEL} ${policy} ${view}: ${result.acted} actions | draw p50=${result.draw.p50} ` +
              `p95=${result.draw.p95} max=${result.draw.max} | raf p95=${result.raf.p95} | rebuilds=${result.rebuilds} | ` +
              `pedestal ${result.pedestalMs}ms over ${result.pedestalCalls} calls | long tasks ` +
              `${result.longTaskSummary.count} (>100ms ${result.longTaskSummary.over100}, total ` +
              `${result.longTaskSummary.totalMs}ms, max ${result.longTaskSummary.maxMs}ms)`,
          );
        }
      } else if (MODE === 'updates') {
        for (const policy of (args.get('policy') ?? 'after').split(',')) {
          const result = await updatesView(browser, view, policy);
          out.push(result);
          await writeFile(
            path.join(PERF_OUT, `${LABEL}-${policy}-updates-${view}.json`),
            JSON.stringify(result, null, 2),
          );
          console.log(
            `[updates] ${LABEL} ${policy} ${view}: draw p50=${result.draw.p50} p95=${result.draw.p95} max=${result.draw.max} | ` +
              `raf p50=${result.raf.p50} p95=${result.raf.p95} | rebuilds=${result.rebuilds} | ` +
              `invalidate=${result.invalidates} tileRefresh=${result.tileRefresh} | ` +
              `long tasks=${result.longTaskSummary.count} (>100ms ${result.longTaskSummary.over100}, ` +
              `total ${result.longTaskSummary.totalMs}ms, max ${result.longTaskSummary.maxMs}ms) | ` +
              `sprites=${result.pedestalSprites} | pedestal ${result.pedestal.perFrameMs}ms/frame ` +
              `(${result.pedestal.calls} calls, ${result.pedestal.paints} paints)`,
          );
          for (const row of result.profile.rows.slice(0, 8)) {
            console.log(`  ${String(row.ms.toFixed(0)).padStart(6)}ms ${String(row.pct).padStart(5)}%  ${row.name}`);
          }
        }
      } else if (MODE === 'parts') {
        const result = await rebuildPartsView(browser, view);
        out.push(result);
        await writeFile(path.join(PERF_OUT, `${LABEL}-parts-${view}.json`), JSON.stringify(result, null, 2));
        console.log(`[parts] ${LABEL} ${view}: rebuild ${result.baseMs}ms on ${result.layer.join('x')}`);
        for (const row of result.rows) {
          console.log(`  without ${row.label.padEnd(24)} ${String(row.offMs).padStart(7)}ms  saves ${row.deltaMs}ms`);
        }
      } else if (MODE === 'pedcost') {
        const result = await pedCostView(browser, view);
        out.push(result);
        await writeFile(path.join(PERF_OUT, `${LABEL}-pedcost-${view}.json`), JSON.stringify(result, null, 2));
        console.log(
          `[pedcost] ${LABEL} ${view}: ${result.count} pedestals @r=${result.radius} on ${result.layer.join('x')} | ` +
            `sprites ${result.sprites.p50}ms (${result.sprites.perCallMs}ms/call, ${result.sprites.paints} paints) | ` +
            `direct ${result.direct.p50}ms (${result.direct.perCallMs}ms/call, ${result.direct.paints} paints) | ` +
            `speedup x${Math.round((result.direct.p50 / Math.max(0.01, result.sprites.p50)) * 10) / 10}`,
        );
      } else if (MODE === 'rebuild') {
        const result = await rebuildView(browser, view);
        out.push(result);
        await writeFile(path.join(PERF_OUT, `${LABEL}-rebuild-${view}.json`), JSON.stringify(result, null, 2));
        console.log(
          `[rebuild] ${LABEL} ${view}: steady p50=${result.steady.p50}ms | rebuild sprites ` +
            `${result.sprites.frames.join('/')}ms (pedestal ${result.sprites.pedestalCleanMs}ms of ${result.sprites.pedestalTotalMs}ms, ` +
            `${result.sprites.calls} calls, ${result.sprites.paints} paints) | direct ` +
            `${result.direct.frames.join('/')}ms (pedestal ${result.direct.pedestalCleanMs}ms of ${result.direct.pedestalTotalMs}ms, ` +
            `${result.direct.calls} calls, ${result.direct.paints} paints) | no-pedestal ` +
            `${result.none.frames.join('/')}ms | pedestal cost sprites=` +
            `${Math.round((median(result.none.frames) - median(result.sprites.frames)) * 10) / 10}ms ` +
            `direct=${Math.round((median(result.none.frames) - median(result.direct.frames)) * 10) / 10}ms`,
        );
      } else if (MODE === 'ablate') {
        const result = await ablateView(browser, view);
        out.push(result);
        await writeFile(path.join(PERF_OUT, `${LABEL}-ablate-${view}.json`), JSON.stringify(result, null, 2));
        console.log(
          `[ablate] ${LABEL} ${view}: baseline p50=${result.baseline.p50} p95=${result.baseline.p95} mean=${result.baseline.mean}`,
        );
        for (const row of result.rows) {
          console.log(`  off ${String(row.deltaP50).padStart(6)}ms p50 (${row.label}) -> ${row.offP50}ms`);
        }
      } else if (MODE === 'breakdown') {
        const result = await breakdownView(browser, view);
        out.push(result);
        await writeFile(path.join(PERF_OUT, `${LABEL}-breakdown-${view}.json`), JSON.stringify(result, null, 2));
        console.log(`[breakdown] ${LABEL} ${view}: ${result.frames} frames`);
        for (const row of result.steps.slice(0, 18)) {
          console.log(`  ${String(row.perFrameMs).padStart(7)}ms/frame  x${row.callsPerFrame}  ${row.label}`);
        }
      } else if (MODE === 'shots') {
        await captureShots(browser, view, args.get('policy') ?? 'after');
      } else {
        throw new Error(`unknown mode ${MODE}`);
      }
    }
    await writeFile(path.join(PERF_OUT, `${LABEL}-${MODE}-all.json`), JSON.stringify(out, null, 2));
  } finally {
    await browser.close();
  }
}

await main();