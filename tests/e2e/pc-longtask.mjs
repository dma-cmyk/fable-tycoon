// Long-task attribution profiler for real play.
//
//   node tests/e2e/pc-longtask.mjs --browser=chromium --view=pc1920 --seconds=35 --label=before
//   node tests/e2e/pc-longtask.mjs --browser=firefox  --view=pc1280 --seconds=35 --label=before
//
// Boots a 1-year solo game at ?speed=8, drives the human seat through the real UI (same
// driver as map-perf's `play` mode) and records:
//   * every long task (>50 ms), with the Long Animation Frame attribution when the browser
//     supports it (scripts[].sourceFunctionName / invoker / forcedStyleAndLayoutDuration),
//   * span timings for the renderer, HUD, fx player and JSON.parse, so a task can be
//     attributed even on browsers without LoAF (Firefox),
//   * a CDP CPU profile over the whole window (Chromium) aggregated twice: over the whole
//     window and restricted to the samples that fall inside a >100 ms long task.
//
// Output: .tmp/longtask/<label>-<browser>-<view>.json

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, '.tmp/longtask');
const DEV_URL = process.env.DEV_URL || 'http://127.0.0.1:5277/';

const args = new Map(
  process.argv
    .filter((arg) => arg.startsWith('--') && arg.includes('='))
    .map((arg) => [arg.slice(2, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]),
);
const LABEL = args.get('label') ?? 'run';
const BROWSER = args.get('browser') ?? 'chromium';
const VIEW = args.get('view') ?? 'pc1920';
const SECONDS = Number(args.get('seconds') ?? 35);
const SPEED = args.get('speed') ?? '8';
const THROTTLE = Number(args.get('throttle') ?? 0);
const NO_PROBE = args.get('noprobe') === '1';

const VIEWPORTS = {
  pc1280: { width: 1280, height: 720, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  pc1920: { width: 1920, height: 1080, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  phone: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  // SO-53C (Xperia Ace III): 360×748 CSS at DPR 2, the device from report 105.
  so53c: { width: 360, height: 748, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

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

/** Same driver as map-perf's play mode: real UI actions for the human seat. */
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

const INIT_SCRIPT = () => {
  globalThis.__longTasks = [];
  globalThis.__loafSupported = false;
  globalThis.__loaf = [];
  globalThis.__spans = [];
  globalThis.__mutations = { records: 0, added: 0, removed: 0, attrs: 0, chars: 0, byTarget: {} };
  globalThis.__jsonParse = { calls: 0, ms: 0, max: 0, chars: 0 };
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        globalThis.__longTasks.push({ start: entry.startTime, duration: entry.duration, name: entry.name });
      }
    }).observe({ entryTypes: ['longtask'] });
  } catch {
    /* longtask unsupported */
  }
  try {
    new PerformanceObserver((list) => {
      globalThis.__loafSupported = true;
      for (const entry of list.getEntries()) {
        globalThis.__loaf.push({
          start: entry.startTime,
          duration: entry.duration,
          blockingDuration: entry.blockingDuration,
          renderStart: entry.renderStart,
          styleAndLayoutStart: entry.styleAndLayoutStart,
          scripts: (entry.scripts ?? []).map((s) => ({
            name: s.sourceFunctionName,
            url: s.sourceURL,
            invoker: s.invoker,
            type: s.invokerType,
            duration: s.duration,
            forcedStyleAndLayout: s.forcedStyleAndLayoutDuration,
            pause: s.pauseDuration,
          })),
        });
      }
    }).observe({ type: 'long-animation-frame' });
  } catch {
    /* LoAF unsupported */
  }
  const realParse = JSON.parse;
  JSON.parse = function parse() {
    const t0 = performance.now();
    try {
      return realParse.apply(this, arguments);
    } finally {
      const dt = performance.now() - t0;
      const rec = globalThis.__jsonParse;
      rec.calls += 1;
      rec.ms += dt;
      if (dt > rec.max) rec.max = dt;
      rec.chars += String(arguments[0] ?? '').length;
    }
  };
};

/** Record every call of a method (own or inherited) with its duration. */
const INSTRUMENT = () => {
  const push = (label, t0) => {
    globalThis.__spans.push({ label, start: t0, dur: performance.now() - t0 });
  };
  const wrap = (obj, name, label) => {
    if (!obj || typeof obj[name] !== 'function') return false;
    const real = obj[name].bind(obj);
    obj[name] = function instrumented(...a) {
      const t0 = performance.now();
      try {
        return real(...a);
      } finally {
        push(label, t0);
      }
    };
    return true;
  };
  const game = globalThis.__fableGame;
  const map = game?.map;
  const land = map?.landLayer;
  const out = {};
  out['game.updateHud'] = wrap(game, 'updateHud', 'game.updateHud');
  out['game.applyState'] = wrap(game, 'applyState', 'game.applyState');
  out['fx.handleFx'] = wrap(game?.fxPlayer, 'handleFx', 'fx.handleFx');
  out['fx.applyState'] = wrap(game?.fxPlayer, 'applyState', 'fx.applyState');
  out['map.draw'] = wrap(map, 'draw', 'map.draw');
  out['map.land.draw'] = wrap(land, 'draw', 'land.draw');
  out['map.land.paintTile'] = wrap(land, 'paintTile', 'land.paintTile');
  out['map.drawCityPedestals'] = wrap(map, 'drawCityPedestals', 'map.drawCityPedestals');
  out['map.ensureBakedLayer'] = wrap(map, 'ensureBakedLayer', 'map.ensureBakedLayer');
  out['map.drawCities'] = wrap(map, 'drawCities', 'map.drawCities');
  out['map.drawTokens'] = wrap(map, 'drawTokens', 'map.drawTokens');
  out['map.computeLayouts'] = wrap(map, 'computeLayouts', 'map.computeLayouts');
  out['map.drawMapArtLabels'] = wrap(map, 'drawMapArtLabels', 'map.drawMapArtLabels');
  out['map.drawMiniMap'] = wrap(map, 'drawMiniMap', 'map.drawMiniMap');
  out['map.ambient.draw'] = wrap(map?.ambient, 'draw', 'ambient.draw');
  out['map.ocean.draw'] = wrap(map?.ocean, 'draw', 'ocean.draw');
  out['map.land.fade'] = wrap(land, 'drawSeasonFade', 'land.drawSeasonFade');
  out['map.drawSeasonParticles'] = wrap(map, 'drawSeasonParticles', 'map.drawSeasonParticles');
  out['map.drawCompass'] = wrap(map, 'drawCompass', 'map.drawCompass');
  out['map.drawMoveSpotlight'] = wrap(map, 'drawMoveSpotlight', 'map.drawMoveSpotlight');
  out['map.drawSelectedPathOverlay'] = wrap(map, 'drawSelectedPathOverlay', 'map.drawSelectedPathOverlay');
  out['map.drawBubbles'] = wrap(map, 'drawBubbles', 'map.drawBubbles');
  out['map.drawCityLabels'] = wrap(map, 'drawCityLabels', 'map.drawCityLabels');
  out['map.drawCelebrations'] = wrap(map, 'drawCelebrations', 'map.drawCelebrations');
  out['map.drawFloatTexts'] = wrap(map, 'drawFloatTexts', 'map.drawFloatTexts');
  out['map.drawWarpPreview'] = wrap(map, 'drawWarpPreview', 'map.drawWarpPreview');
  out['land.evict'] = wrap(land, 'evict', 'land.evict');
  out['land.probeTile'] = wrap(land, 'probeOneTile', 'land.probeTile');
  out['ocean.suspect'] = wrap(map?.ocean, 'suspect', 'ocean.suspect');
  out['land.compose'] = wrap(land, 'composeInto', 'land.compose');
  out['map.drawWorldWarpTiles'] = wrap(map, 'drawWorldWarpTiles', 'map.drawWorldWarpTiles');
  out['map.drawSquareShortLabels'] = wrap(map, 'drawSquareShortLabels', 'map.drawSquareShortLabels');
  out['map.drawMoveUi'] = wrap(map, 'drawMoveUi', 'map.drawMoveUi');
  out['map.resolveLabels'] = wrap(map, 'ensureLabelLayout', 'map.ensureLabelLayout');
  const obs = new MutationObserver((records) => {
    const rec = globalThis.__mutations;
    for (const r of records) {
      rec.records += 1;
      if (r.type === 'childList') {
        rec.added += r.addedNodes.length;
        rec.removed += r.removedNodes.length;
      } else if (r.type === 'attributes') rec.attrs += 1;
      else if (r.type === 'characterData') rec.chars += 1;
      const key = `${r.target.nodeName?.toLowerCase() ?? '?'}.${r.target.className?.baseVal ?? r.target.className ?? ''}`;
      rec.byTarget[key] = (rec.byTarget[key] ?? 0) + 1;
    }
  });
  obs.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  globalThis.__mutObs = obs;
  return out;
};

function topFunctions(profile, fromUs = 0, toUs = Infinity) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const self = new Map();
  let at = profile.startTime;
  for (let i = 0; i < profile.samples.length; i += 1) {
    const dt = profile.timeDeltas[i] ?? 0;
    at += dt;
    if (at < fromUs || at > toUs) continue;
    const node = nodes.get(profile.samples[i]);
    if (!node) continue;
    const frame = node.callFrame;
    const name = frame.functionName || (frame.url ? frame.url.split('/').pop() : '(anonymous)');
    self.set(name, (self.get(name) ?? 0) + dt);
  }
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  const rows = [...self.entries()]
    .map(([name, us]) => ({ name, ms: round(us / 1000), pct: total > 0 ? round((us / total) * 100) : 0 }))
    .sort((a, b) => b.ms - a.ms);
  return { totalMs: round(total / 1000), rows };
}

function stat(values) {
  if (!values.length) return { n: 0, p50: 0, p95: 0, max: 0, total: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  return {
    n: values.length,
    p50: round(pick(0.5)),
    p95: round(pick(0.95)),
    max: round(sorted[sorted.length - 1]),
    total: round(sorted.reduce((a, b) => a + b, 0)),
  };
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const vp = VIEWPORTS[VIEW];
  const launcher = BROWSER === 'firefox' ? firefox : chromium;
  const launchOptions =
    BROWSER === 'firefox'
      ? { headless: true, firefoxUserPrefs: { 'media.volume_scale': '0.0' } }
      : {
          headless: true,
          args: ['--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
        };
  const browser = await launcher.launch(launchOptions);
  const errors = [];
  const warnings = [];
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
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    // Console warnings are collected so a `willReadFrequently` read-back warning would be
    // visible in the result instead of only in the browser log.
    page.on('console', (message) => {
      if (message.type() !== 'warning' && message.type() !== 'error') return;
      const text = message.text();
      if (/willReadFrequently|readback|read back|GPU stall|Multiple readback/i.test(text)) {
        warnings.push(text.slice(0, 200));
      }
    });
    if (THROTTLE > 0) {
      try {
        const cdpSession = await context.newCDPSession(page);
        await cdpSession.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
      } catch (error) {
        errors.push(`throttle: ${error.message}`);
      }
    }
    // Other slices edit shared files while this runs and Vite then reloads the page. A
    // reload destroys the game (and the instrumentation), so it is counted and the
    // measured window is thrown away and retried.
    let reloads = 0;
    page.on('load', () => { reloads += 1; });
    await page.addInitScript(INIT_SCRIPT);
    await page.goto(new URL(`?speed=${SPEED}`, DEV_URL).toString(), { waitUntil: 'domcontentloaded' });
    await waitFor(page, () => visible(page, '.title-menu-btn'), { label: 'title screen' });
    await page.locator('.title-menu-btn').filter({ hasText: 'ひとりで' }).first().click();
    await waitFor(page, () => visible(page, '.setup-screen'), { timeout: 20_000, label: 'setup screen' });
    await page.locator('.seg-btn').filter({ hasText: /^1年$/ }).first().click();
    await page.locator('.setup-start:visible, .setup-mobile-start:visible').first().click();
    await waitFor(page, () => visible(page, '.game-screen'), { timeout: 60_000, label: 'game screen' });
    await waitFor(page, () => page.evaluate(() => !!globalThis.__fableGame?.map?.state), { timeout: 60_000, label: 'map' });
    await sleep(2000);
    const wrapped = await page.evaluate(INSTRUMENT);
    if (NO_PROBE) {
      // A/B: keep everything else but turn the cache integrity probes off.
      await page.evaluate(() => {
        const map = globalThis.__fableGame.map;
        map.ocean.suspect = () => false;
        map.landLayer.probeOneTile = () => {};
      });
    }

    let cdp = null;
    let profileStartPageMs = 0;
    if (BROWSER === 'chromium') {
      try {
        cdp = await context.newCDPSession(page);
        await cdp.send('Profiler.enable');
        await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
        await cdp.send('Profiler.start');
      } catch (error) {
        errors.push(`profiler: ${error.message}`);
        cdp = null;
      }
    }

    const resetWindow = () =>
      page.evaluate(() => {
        globalThis.__longTasks = [];
        globalThis.__loaf = [];
        globalThis.__spans = [];
        globalThis.__jsonParse = { calls: 0, ms: 0, max: 0, chars: 0 };
        globalThis.__fableGame.map.resetFrameStats();
        const now = performance.now();
        globalThis.__profileStart = now;
        return now;
      });

    const attempt = async () => {
      const reloadsAtStart = reloads;
      const start = await resetWindow();
      const deadline = Date.now() + SECONDS * 1000;
      let acted = 0;
      while (Date.now() < deadline) {
        const result = await stepHuman(page).catch(() => ({ waiting: true }));
        if (result.acted) acted += 1;
        if (result.done) break;
        await sleep(result.acted ? 200 : 120);
      }
      return { start, acted, reloaded: reloads !== reloadsAtStart };
    };

    let run = null;
    for (let i = 0; i < 3; i += 1) {
      run = await attempt().catch(async (error) => {
        errors.push(`attempt ${i}: ${error.message}`);
        await waitFor(page, () => page.evaluate(() => !!globalThis.__fableGame?.map?.state), { timeout: 60_000, label: 'map (retry)' });
        await page.evaluate(INSTRUMENT);
        return { start: 0, acted: 0, reloaded: true };
      });
      if (!run.reloaded) break;
    }
    if (!run || run.reloaded) errors.push('measured window was interrupted by a page reload');
    profileStartPageMs = run?.start ?? 0;
    const acted = run?.acted ?? 0;

    let profile = null;
    let profileEndPageMs = 0;
    if (cdp) {
      profileEndPageMs = await page.evaluate(() => performance.now());
      const stopped = await cdp.send('Profiler.stop');
      profile = stopped.profile;
      await cdp.send('Profiler.disable').catch(() => {});
    }

    const measured = await page.evaluate(() => {
      const map = globalThis.__fableGame.map;
      const spans = globalThis.__spans;
      const byLabel = {};
      for (const s of spans) {
        const rec = (byLabel[s.label] ??= { n: 0, ms: 0, max: 0, values: [] });
        rec.n += 1;
        rec.ms += s.dur;
        if (s.dur > rec.max) rec.max = s.dur;
        rec.values.push(s.dur);
      }
      for (const rec of Object.values(byLabel)) {
        const values = rec.values.sort((a, b) => a - b);
        rec.p50 = values[Math.min(values.length - 1, Math.floor(values.length * 0.5))];
        rec.p95 = values[Math.min(values.length - 1, Math.floor(values.length * 0.95))];
        delete rec.values;
      }
      globalThis.__mutObs?.disconnect();
      return {
        longTasks: globalThis.__longTasks,
        loaf: globalThis.__loaf,
        loafSupported: globalThis.__loafSupported,
        spans: spans.map((s) => ({ label: s.label, start: Math.round(s.start * 10) / 10, dur: Math.round(s.dur * 100) / 100 })),
        spanStats: byLabel,
        mutations: globalThis.__mutations,
        jsonParse: globalThis.__jsonParse,
        raf: map.frameTimes,
        landStats: map.landLayer.getFrameStats(),
        profileStart: globalThis.__profileStart,
      };
    });

    // ---------------------------------------------------------------- attribution
    const longTasks = measured.longTasks.map((t) => {
      const end = t.start + t.duration;
      const inside = measured.spans.filter((s) => s.start >= t.start - 2 && s.start <= end);
      const merge = {};
      for (const s of inside) {
        const rec = (merge[s.label] ??= { n: 0, ms: 0 });
        rec.n += 1;
        rec.ms += s.dur;
      }
      const spans = Object.entries(merge)
        .map(([label, rec]) => ({ label, n: rec.n, ms: round(rec.ms) }))
        .sort((a, b) => b.ms - a.ms);
      const loaf = measured.loaf.find((l) => Math.abs(l.start - t.start) < 8);
      return {
        start: Math.round(t.start),
        duration: Math.round(t.duration),
        spans,
        loaf: loaf
          ? {
              duration: round(loaf.duration),
              styleLayoutMs: loaf.styleAndLayoutStart > 0 ? round(loaf.duration - (loaf.renderStart ? loaf.renderStart - loaf.start : loaf.duration)) : null,
              blockingMs: round(loaf.blockingDuration),
              scripts: loaf.scripts
                .map((s) => ({
                  name: s.name || '(anonymous)',
                  invoker: s.invoker,
                  type: s.type,
                  duration: round(s.duration),
                  forcedStyleLayout: round(s.forcedStyleAndLayout),
                }))
                .sort((a, b) => b.duration - a.duration)
                .slice(0, 6),
            }
          : null,
      };
    });

    // Aggregate the CDP profile: whole window, and <= the windows of >100 ms tasks.
    let profileRows = null;
    let longTaskProfileRows = null;
    let profileOffsetUs = 0;
    if (profile) {
      const pageNowUs = profileStartPageMs * 1000;
      // Align the CDP clock (µs, monotonic) to the page clock: the first evaluate after
      // Profiler.start happened within a few ms of it.
      profileOffsetUs = Math.round(profile.startTime - pageNowUs);
      profileRows = topFunctions(profile);
      const longNodes = new Map();
      const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
      const longTasksMs = measured.longTasks.filter((t) => t.duration > 100);
      for (const t of longTasksMs) {
        const from = (t.start * 1000) + profileOffsetUs;
        const to = ((t.start + t.duration) * 1000) + profileOffsetUs;
        let at = profile.startTime;
        for (let i = 0; i < profile.samples.length; i += 1) {
          at += profile.timeDeltas[i] ?? 0;
          if (at < from || at > to) continue;
          const node = nodes.get(profile.samples[i]);
          if (!node) continue;
          const frame = node.callFrame;
          const name = frame.functionName || (frame.url ? frame.url.split('/').pop() : '(anonymous)');
          longNodes.set(name, (longNodes.get(name) ?? 0) + (profile.timeDeltas[i] ?? 0));
        }
      }
      const total = [...longNodes.values()].reduce((a, b) => a + b, 0);
      longTaskProfileRows = {
        totalMs: round(total / 1000),
        rows: [...longNodes.entries()]
          .map(([name, us]) => ({ name, ms: round(us / 1000), pct: total ? round((us / total) * 100) : 0 }))
          .sort((a, b) => b.ms - a.ms),
      };
    }

    const over100 = longTasks.filter((t) => t.duration > 100);
    const result = {
      label: LABEL,
      browser: BROWSER,
      view: VIEW,
      viewport: { width: vp.width, height: vp.height, dpr: vp.deviceScaleFactor },
      seconds: SECONDS,
      speed: SPEED,
      throttle: THROTTLE,
      noProbe: NO_PROBE,
      acted,
      interrupted: Boolean(run?.reloaded),
      wrapped,
      longTaskSummary: {
        count: longTasks.length,
        over100: over100.length,
        totalMs: round(longTasks.reduce((sum, t) => sum + t.duration, 0)),
        over100TotalMs: round(over100.reduce((sum, t) => sum + t.duration, 0)),
        over100Durations: over100.map((t) => t.duration),
      },
      draw: stat(measured.spans.filter((s) => s.label === 'map.draw').map((s) => s.dur)),
      raf: stat(measured.raf),
      spanStats: Object.fromEntries(
        Object.entries(measured.spanStats).map(([k, v]) => [k, { n: v.n, ms: round(v.ms), p50: round(v.p50), p95: round(v.p95), max: round(v.max) }]),
      ),
      landStats: measured.landStats,
      mutations: measured.mutations,
      jsonParse: { calls: measured.jsonParse.calls, ms: round(measured.jsonParse.ms), max: round(measured.jsonParse.max), chars: measured.jsonParse.chars },
      loafSupported: measured.loafSupported,
      readbackWarnings: warnings,
      cdp: Boolean(profile),
      profile: profileRows,
      longTaskProfile: longTaskProfileRows,
      longTasks,
      errors,
    };
    await writeFile(path.join(OUT, `${LABEL}-${BROWSER}-${VIEW}.json`), JSON.stringify(result, null, 2));

    console.log(
      `[longtask] ${LABEL} ${BROWSER} ${VIEW}: acted=${acted} | draw p50=${result.draw.p50} p95=${result.draw.p95} max=${result.draw.max} ` +
        `| raf p95=${result.raf.p95} | long tasks=${result.longTaskSummary.count} ` +
        `(>100ms ${result.longTaskSummary.over100} / ${result.longTaskSummary.over100TotalMs}ms, max ${Math.max(0, ...result.longTaskSummary.over100Durations)}ms) ` +
        `| LoAF=${result.loafSupported ? 'yes' : 'no'} | cdp=${result.cdp ? 'yes' : 'no'}`,
    );
    console.log(
      `[longtask] json.parse ${result.jsonParse.calls} calls ${result.jsonParse.ms}ms (max ${result.jsonParse.max}ms, ${Math.round(result.jsonParse.chars / 1024)}KB) ` +
        `| mutations ${result.mutations.records} (added ${result.mutations.added}, removed ${result.mutations.removed}, attrs ${result.mutations.attrs}, text ${result.mutations.chars})`,
    );
    if (profileRows) {
      console.log('[longtask] profile (whole window, self time):');
      for (const row of profileRows.rows.slice(0, 14)) {
        console.log(`  ${String(row.ms).padStart(7)}ms ${String(row.pct).padStart(5)}%  ${row.name}`);
      }
    }
    if (longTaskProfileRows) {
      console.log('[longtask] profile inside >100ms tasks (self time):');
      for (const row of longTaskProfileRows.rows.slice(0, 14)) {
        console.log(`  ${String(row.ms).padStart(7)}ms ${String(row.pct).padStart(5)}%  ${row.name}`);
      }
    }
    console.log('[longtask] top long tasks by duration:');
    for (const t of [...over100].sort((a, b) => b.duration - a.duration).slice(0, 12)) {
      const loaf = t.loaf
        ? ` | loaf scripts: ${t.loaf.scripts.map((s) => `${s.name}(${s.duration}ms${s.forcedStyleLayout > 0 ? `,s/l ${s.forcedStyleLayout}` : ''})`).slice(0, 3).join(' ')}`
        : '';
      console.log(
        `  ${String(t.duration).padStart(5)}ms @${t.start}  spans: ${t.spans.slice(0, 5).map((s) => `${s.label} ${s.ms}ms×${s.n}`).join(', ')}${loaf}`,
      );
    }
    console.log('[longtask] span totals:');
    for (const [k, v] of Object.entries(result.spanStats).sort((a, b) => b[1].ms - a[1].ms)) {
      console.log(`  ${String(v.ms).padStart(8)}ms total  n=${String(v.n).padStart(6)}  p50=${String(v.p50).padStart(6)}  p95=${String(v.p95).padStart(7)}  max=${String(v.max).padStart(7)}  ${k}`);
    }
    if (warnings.length) console.log(`[longtask] read-back warnings: ${warnings.length} (${warnings[0]})`);
    if (errors.length) console.log('[longtask] page errors:', errors.slice(0, 5).join(' | '));
    await context.close();
  } finally {
    await browser.close();
  }
}

await main();