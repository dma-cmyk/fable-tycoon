// Cost of one land tile, attributed per painting pass.
//
//   node tests/e2e/land-tile-cost.mjs --view=pc1920 [--label=probe] [--zoom=1.5]
//
// A canvas 2D paint is deferred: `paintRegion` returns long before the pixels exist, and
// the bill arrives at the first read-back / blit of that canvas. Every measurement here
// therefore forces a full read-back (`getImageData`) inside the timed window.
//
// A second hazard is Chromium's raster cache: painting the *same* display list into the
// *same* canvas repeatedly stays warm and looks 2-3x cheaper than the real first paint.
// Each rep here uses a fresh canvas and a different world origin, which is what the tile
// cache actually does.
//
// Attribution: `passes.*` replays one pass of the land body in isolation (same geometry,
// same style maths as `LandLayer.paintRegion`), and `scenes.*` ablates the real painter by
// hiding the inputs it needs. Both are medians of N reps on fresh canvases.
//
// Writes .tmp/longtask/<label>-tilecost-<view>.json and prints a table.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, '.tmp/longtask');
const DEV_URL = process.env.DEV_URL || 'http://127.0.0.1:5277/';

const args = new Map(
  process.argv
    .filter((arg) => arg.startsWith('--') && arg.includes('='))
    .map((arg) => [arg.slice(2, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]),
);
const LABEL = args.get('label') ?? 'probe';
const VIEW = args.get('view') ?? 'pc1920';
const ZOOMS = (args.get('zoom') ?? '1.5,3').split(',').map(Number);
const REPS = Number(args.get('reps') ?? 7);
const SIZE = Number(args.get('size') ?? 512);
const BLEED = 8;

const VIEWPORTS = {
  pc1280: { width: 1280, height: 720, deviceScaleFactor: 1 },
  pc1920: { width: 1920, height: 1080, deviceScaleFactor: 1 },
  phone: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
};

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

const vp = VIEWPORTS[VIEW];
const browser = await chromium.launch({ headless: true, args: ['--mute-audio'] });
const context = await browser.newContext({
  viewport: { width: vp.width, height: vp.height },
  deviceScaleFactor: vp.deviceScaleFactor,
  isMobile: Boolean(vp.isMobile),
  hasTouch: Boolean(vp.hasTouch),
  locale: 'ja-JP',
  reducedMotion: 'reduce',
});
const page = await context.newPage();
await page.goto(new URL('?speed=8', DEV_URL).toString(), { waitUntil: 'domcontentloaded' });
await waitFor(page, () => visible(page, '.title-menu-btn'), { label: 'title' });
await page.locator('.title-menu-btn').filter({ hasText: 'ひとりで' }).first().click();
await waitFor(page, () => visible(page, '.setup-screen'), { timeout: 20_000, label: 'setup' });
await page.locator('.seg-btn').filter({ hasText: /^1年$/ }).first().click();
await page.locator('.setup-start:visible, .setup-mobile-start:visible').first().click();
await waitFor(page, () => visible(page, '.game-screen'), { timeout: 60_000, label: 'game' });
await waitFor(page, () => page.evaluate(() => !!globalThis.__fableGame?.map?.state), { timeout: 60_000, label: 'map' });
await sleep(3000);

const result = await page.evaluate(
  ({ zooms, reps, SIZE, BLEED }) => {
    const map = globalThis.__fableGame.map;
    const L = map.landLayer;
    const dpr = map.dpr;
    // Freeze the season and the camera-dependent inputs so the probe is reproducible.
    map.season = 'spring';
    const season = 'spring';

    const content = (extra = {}) => ({
      season,
      overview: false,
      withTrees: true,
      paintStatic: (layer) => map.paintStaticBoard(layer),
      treeAvoid: (x, y) => map.avoidGrid.queryRect({ x: x - 42, y: y - 42, w: 84, h: 84 }).length > 0,
      geoAt: (x, y) => map.geoAt(x, y),
      ...extra,
    });

    const median = (values) => {
      const s = [...values].sort((a, b) => a - b);
      return Math.round(s[Math.floor(s.length / 2)] * 100) / 100;
    };
    const fresh = () => {
      const canvas = document.createElement('canvas');
      canvas.width = SIZE + BLEED * 2;
      canvas.height = SIZE + BLEED * 2;
      return { canvas, ctx: canvas.getContext('2d') };
    };
    const flush = (ctx, canvas) => {
      ctx.getImageData(0, 0, canvas.width, canvas.height);
    };
    // Real paint through the shipping path: scale/zoom from the bucket quantisation.
    const measure = (devX, devY, scale, zoom, c, n = reps) => {
      const js = [];
      const total = [];
      for (let i = 0; i < n; i += 1) {
        const { canvas, ctx } = fresh();
        const ox = devX + i * 977; // different world anchor each rep: a cold raster every time
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        const t0 = performance.now();
        L.paintRegion(ctx, ox, devY, canvas.width, canvas.height, scale, zoom, dpr, c);
        const t1 = performance.now();
        flush(ctx, canvas);
        const t2 = performance.now();
        js.push(t1 - t0);
        total.push(t2 - t0);
      }
      return { js: median(js), flush: median(total.map((t, i) => t - js[i])), total: median(total) };
    };

    // ---- one-pass replicas of the land body (same maths as paintRegion) ----
    const buildPath = (devX, devY, devW, devH, scale, zoom) => {
      const wWorld = devW / scale;
      const hWorld = devH / scale;
      const ox = devX / scale;
      const oy = devY / scale;
      const x1 = ox + wWorld;
      const y1 = oy + hWorld;
      const haloDev = Math.max(4, Math.min(12, 4 * zoom)) * dpr;
      const outlineDev = Math.max(2, Math.min(8, 2.1 * scale));
      const shadowDev = Math.max(1, 3.2 * scale);
      const pad = (haloDev + shadowDev + outlineDev + 6) / scale;
      const kMin = Math.floor((ox - 8192) / 8192);
      const kMax = Math.ceil(x1 / 8192);
      let path = null;
      let boxes = 0;
      let points = 0;
      for (let k = kMin; k <= kMax; k += 1) {
        const shift = k * 8192;
        for (const box of L.boxes) {
          if (box.maxX + shift < ox - pad || box.minX + shift > x1 + pad) continue;
          if (box.maxY < oy - pad || box.minY > y1 + pad) continue;
          if (!path) path = new Path2D();
          path.addPath(box.path, { a: 1, b: 0, c: 0, d: 1, e: shift, f: 0 });
          boxes += 1;
          for (const ring of box.rings) points += ring.length / 2;
        }
      }
      return { path, boxes, points, haloDev, outlineDev, shadowDev, ox, oy, wWorld, hWorld };
    };
    const PALETTE = { top: '#c9ef91', mid: '#a8e06d', bottom: '#81cd57', outline: '#407c2c' };
    const onePass = (devX, devY, scale, zoom, which, n = reps) => {
      const times = [];
      const pts = [];
      for (let i = 0; i < n; i += 1) {
        const { canvas, ctx } = fresh();
        const ox0 = devX + i * 977;
        const t0 = performance.now();
        const g = buildPath(ox0, devY, canvas.width, canvas.height, scale, zoom);
        const ox = ox0 / scale;
        const oy = devY / scale;
        ctx.save();
        ctx.setTransform(scale, 0, 0, scale, -ox0, -devY);
        if (g.path) {
          if (which === 'halo') {
            ctx.strokeStyle = 'rgba(146, 236, 255, 0.5)';
            ctx.lineWidth = g.haloDev / scale;
            ctx.lineJoin = 'round';
            ctx.stroke(g.path);
          } else if (which === 'shadow') {
            ctx.translate(g.shadowDev / scale, g.shadowDev / scale);
            ctx.fillStyle = 'rgba(3, 48, 72, 0.28)';
            ctx.fill(g.path, 'evenodd');
          } else if (which === 'fill') {
            const grad = ctx.createLinearGradient(0, 0, 0, 1908);
            grad.addColorStop(0, PALETTE.top);
            grad.addColorStop(0.45, PALETTE.mid);
            grad.addColorStop(1, PALETTE.bottom);
            ctx.fillStyle = grad;
            ctx.fill(g.path, 'evenodd');
          } else if (which === 'clip') {
            ctx.clip(g.path, 'evenodd');
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, 8192, 1908);
          } else if (which === 'texture') {
            const tex = L.terrain;
            ctx.save();
            ctx.clip(g.path, 'evenodd');
            if (tex && tex.naturalWidth > 0) ctx.drawImage(tex, 0, 0, 8192, 1908);
            ctx.restore();
          } else if (which === 'softlight') {
            const tex = L.terrain;
            ctx.save();
            ctx.clip(g.path, 'evenodd');
            if (tex && tex.naturalWidth > 0) ctx.drawImage(tex, 0, 0, 8192, 1908);
            ctx.globalCompositeOperation = 'soft-light';
            ctx.globalAlpha = 0.5;
            ctx.fillStyle = PALETTE.mid;
            ctx.fillRect(-8192, -1908, 8192 * 3, 1908 * 3);
            ctx.restore();
          } else if (which === 'outline') {
            ctx.strokeStyle = PALETTE.outline;
            ctx.lineWidth = g.outlineDev / scale;
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            ctx.stroke(g.path);
          }
        }
        ctx.restore();
        const t1 = performance.now();
        flush(ctx, canvas);
        times.push(performance.now() - t0);
        pts.push({ t: t1 - t0, boxes: g.boxes, points: g.points });
      }
      return {
        total: median(times),
        js: median(pts.map((p) => p.t)),
        boxes: pts[0].boxes,
        points: pts[0].points,
        haloDev: Math.round(buildPath(devX, devY, SIZE, SIZE, scale, zoom).haloDev * 100) / 100,
      };
    };

    const buckets = zoom => {
      const bucket = Math.round(Math.log2(zoom) * 10);
      const desired = Math.pow(2, bucket / 10) * dpr;
      const nx = Math.max(1, Math.round((8192 * desired) / 512));
      const scale = (nx * 512) / 8192;
      return { bucket, scale, zoom: scale / dpr };
    };

    const out = { dpr, size: SIZE, bleed: BLEED, zooms: {}, weather: {}, sceneBreakdown: {} };
    // Europe: land, coastline, towns, trees.
    const EUROPE = [4117 * 1.0, 1212];
    for (const z of zooms) {
      const { scale, zoom, bucket } = buckets(z);
      const devX = Math.round(EUROPE[0] * scale / 512) * 512;
      const devY = Math.round(EUROPE[1] * scale / 512) * 512;
      const base = measure(devX, devY, scale, zoom, content());
      const noStatic = measure(devX, devY, scale, zoom, content({ paintStatic: undefined }));
      const noTrees = measure(devX, devY, scale, zoom, content({ withTrees: false }));
      const noTerrain = (() => {
        const t = L.terrain;
        const tl = L.terrainLo;
        L.terrain = undefined;
        L.terrainLo = undefined;
        const r = measure(devX, devY, scale, zoom, content());
        L.terrain = t;
        L.terrainLo = tl;
        return r;
      })();
      const landOnly = (() => {
        const t = L.terrain;
        const tl = L.terrainLo;
        L.terrain = undefined;
        L.terrainLo = undefined;
        const r = measure(devX, devY, scale, zoom, content({ paintStatic: undefined, withTrees: false }));
        L.terrain = t;
        L.terrainLo = tl;
        return r;
      })();
      out.zooms[String(z)] = { bucket, scale, zoom, base, noStatic, noTrees, noTerrain, landOnly };
      out.sceneBreakdown[String(z)] = {
        halo: onePass(devX, devY, scale, zoom, 'halo'),
        shadow: onePass(devX, devY, scale, zoom, 'shadow'),
        fill: onePass(devX, devY, scale, zoom, 'fill'),
        clip: onePass(devX, devY, scale, zoom, 'clip'),
        texture: onePass(devX, devY, scale, zoom, 'texture'),
        softlight: onePass(devX, devY, scale, zoom, 'softlight'),
        outline: onePass(devX, devY, scale, zoom, 'outline'),
      };
    }
    // Winter adds the snow overlay; summer adds the other half of it.
    {
      const { scale, zoom } = buckets(1.5);
      const devX = Math.round((EUROPE[0] * scale) / 512) * 512;
      const devY = Math.round((EUROPE[1] * scale) / 512) * 512;
      for (const s of ['spring', 'summer', 'winter']) {
        out.weather[s] = measure(devX, devY, scale, zoom, content({ season: s }));
      }
    }

    // ---- cost of the tile flush itself, and whether a self-blit can pay it early ----
    {
      const { scale, zoom } = buckets(1.5);
      const devX = Math.round((EUROPE[0] * scale) / 512) * 512;
      const devY = Math.round((EUROPE[1] * scale) / 512) * 512;
      const probe = (mode) => {
        const times = { paint: [], flush: [], blit: [] };
        for (let i = 0; i < reps; i += 1) {
          const { canvas, ctx } = fresh();
          const ox = devX + i * 977;
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          const t0 = performance.now();
          L.paintRegion(ctx, ox, devY, canvas.width, canvas.height, scale, zoom, dpr, content());
          const t1 = performance.now();
          if (mode === 'self') ctx.drawImage(canvas, 0, 0);
          else if (mode === 'half') {
            const c2 = document.createElement('canvas');
            c2.width = Math.ceil(canvas.width / 2);
            c2.height = Math.ceil(canvas.height / 2);
            c2.getContext('2d').drawImage(canvas, 0, 0, c2.width, c2.height);
          } else if (mode === 'pixel') ctx.getImageData(0, 0, 1, 1);
          const t2 = performance.now();
          // The real destination: a screen-like canvas, blitted 1:1.
          const screen = document.createElement('canvas');
          screen.width = 1920;
          screen.height = 1080;
          const sctx = screen.getContext('2d');
          sctx.drawImage(canvas, BLEED, BLEED, SIZE, SIZE, 100, 100, SIZE, SIZE);
          const t3 = performance.now();
          times.paint.push(t1 - t0);
          times.flush.push(t2 - t1);
          times.blit.push(t3 - t2);
        }
        return { paint: median(times.paint), flush: median(times.flush), blit: median(times.blit) };
      };
      out.flushStrategies = {
        none: probe('none'),
        selfBlit: probe('self'),
        halfBlit: probe('half'),
        onePixelRead: probe('pixel'),
      };
    }

    out.boxes = L.boxes.length;
    out.totalRingPoints = L.boxes.reduce((sum, b) => sum + b.rings.reduce((n, r) => n + r.length / 2, 0), 0);
    out.trees = L.trees?.length ?? 0;
    out.terrain = { w: L.terrain?.naturalWidth ?? 0, h: L.terrain?.naturalHeight ?? 0 };
    return out;
  },
  { zooms: ZOOMS, reps: REPS, SIZE, BLEED },
);

const table = (o) => {
  const rows = [];
  for (const [z, v] of Object.entries(o.zooms)) {
    rows.push(`zoom ${z} (bucket ${v.bucket}, scale ${v.scale.toFixed(3)}): base ${v.base.total}ms (js ${v.base.js}) | noStatic ${v.noStatic.total} | noTrees ${v.noTrees.total} | noTerrain ${v.noTerrain.total} | landOnly ${v.landOnly.total}`);
  }
  for (const [z, v] of Object.entries(o.sceneBreakdown)) {
    rows.push(`zoom ${z} passes: halo ${v.halo.total} (${v.halo.boxes} boxes/${v.halo.points} pts) shadow ${v.shadow.total} fill ${v.fill.total} clip ${v.clip.total} texture ${v.texture.total} softlight ${v.softlight.total} outline ${v.outline.total}`);
  }
  rows.push(`weather: ${Object.entries(o.weather).map(([k, v]) => `${k} ${v.total}`).join(' | ')}`);
  rows.push(`flush strategies: ${Object.entries(o.flushStrategies).map(([k, v]) => `${k} paint ${v.paint} flush ${v.flush} blit ${v.blit}`).join(' | ')}`);
  return rows.join('\n');
};

console.log(`[tilecost] ${VIEW} dpr=${result.dpr} size=${result.size} trees=${result.trees} boxes=${result.boxes} points=${result.totalRingPoints}`);
console.log(table(result));
await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, `${LABEL}-tilecost-${VIEW}.json`), JSON.stringify(result, null, 2));
await context.close();
await browser.close();