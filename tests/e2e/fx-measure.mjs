// Measures per-update fx playback wall time in a real headless browser.
//
//   node tests/e2e/fx-measure.mjs [--speed=8,1] [--label=after] [--headful] [--act=250]
//
// Plays a 1-year local game (1 human + 3 CPU) through the real UI and reads
// `__fableGame.fxPlayer.playbackStats`, which FxPlayer fills once per adopted update with the
// wall time it actually played and the speed-scaled budget it was given. The script prints a
// summary plus the slowest updates and writes .tmp/fx-measure/<label>-<speed>.json.
//
// The dev server must already be running (DEV_URL, default http://127.0.0.1:5269).

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, '.tmp/fx-measure');
const DEV_URL = process.env.DEV_URL || 'http://127.0.0.1:5269/';
const HEADFUL = process.argv.includes('--headful');
const args = new Map(
  process.argv
    .filter((arg) => arg.startsWith('--') && arg.includes('='))
    .map((arg) => {
      const index = arg.indexOf('=');
      return [arg.slice(2, index), arg.slice(index + 1)];
    }),
);
const SPEEDS = (args.get('speed') ?? '8,1')
  .split(',')
  .map((value) => Number(value))
  .filter((value) => Number.isFinite(value) && value >= 1);
const LABEL = args.get('label') ?? 'run';
/** Pause after each human action so the queue has time to drain like a real player's. */
const ACT_DELAY_MS = Number(args.get('act') ?? 250);
const GAME_TIMEOUT_MS = Number(args.get('timeout') ?? 12 * 60 * 1000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function visible(page, selector) {
  return page.locator(selector).first().isVisible().catch(() => false);
}

async function waitFor(page, fn, { timeout = 60_000, interval = 150, label = 'condition' } = {}) {
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

/** Starts a 1-year local game: solo defaults are 1 human + 3 CPU. */
async function startLocalGame(page, speed) {
  const url = new URL(DEV_URL);
  url.searchParams.set('speed', String(speed));
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
  await waitFor(page, () => visible(page, '.title-menu-btn'), { label: 'title screen' });
  await page.locator('.title-menu-btn').filter({ hasText: 'ひとりで' }).first().click();
  await waitFor(page, () => visible(page, '.setup-screen'), { timeout: 20_000, label: 'setup screen' });
  await page.locator('.seg-btn').filter({ hasText: /^1年$/ }).first().click();
  await page.locator('.setup-start, .setup-mobile-start').first().click();
  await waitFor(page, () => visible(page, '.game-screen'), { timeout: 45_000, label: 'game screen' });
}

/** One driver tick in the page: act for the human seat only when the last cutscene finished. */
async function stepHuman(page) {
  return page.evaluate(() => {
    const game = globalThis.__fableGame;
    const s = game?.state;
    if (!game || !s) return { waiting: true };
    if (s.phase.t === 'game_over') return { done: true };
    // A human waits for the animation to land before pressing the next button.
    if (game.fxBusy || game.fxPlayer?.busy) return { waiting: true, playing: true };
    const player = s.players[s.current];
    if (!player || player.isCpu) return { waiting: true, cpu: true };
    const owner = s.owner ?? {};
    const ownedByMe = Object.keys(owner).find((id) => owner[id] === s.current);
    let action = null;
    switch (s.phase.t) {
      case 'turn_start':
        action = { t: 'roll' };
        break;
      case 'choose_dest':
        action = s.phase.options?.[0] ? { t: 'move', nodeId: s.phase.options[0].nodeId } : null;
        break;
      case 'buy':
        action = { t: 'end_buy' };
        break;
      case 'event':
        action = { t: 'choose', index: 0 };
        break;
      case 'card_target':
        action = s.phase.options?.[0] ? { t: 'card_target', target: s.phase.options[0] } : { t: 'cancel' };
        break;
      case 'skill_target':
        action = s.phase.options?.[0] ? { t: 'skill_target', target: s.phase.options[0] } : { t: 'cancel' };
        break;
      case 'discard':
        action = player.cards?.[0] ? { t: 'discard', cardId: player.cards[0] } : null;
        break;
      case 'sell':
        action = ownedByMe ? { t: 'sell', propertyId: ownedByMe } : null;
        break;
      case 'shop':
        action = { t: 'end_shop' };
        break;
      case 'year_end':
        action = { t: 'ack' };
        break;
      default:
        action = null;
    }
    if (!action) return { waiting: true, stuck: s.phase.t };
    game.sendAction(action);
    return { acted: true, phase: s.phase.t };
  });
}

/** Plays the human seat by feeding real actions through the game UI at human pace. */
async function playHuman(page, log) {
  const start = Date.now();
  let acted = 0;
  let last = null;
  while (Date.now() - start < GAME_TIMEOUT_MS) {
    const result = await stepHuman(page).catch((error) => ({ waiting: true, error: String(error).slice(0, 160) }));
    last = result;
    if (result.done) return { acted, finished: true };
    if (result.acted) acted += 1;
    await sleep(result.acted ? ACT_DELAY_MS : 120);
  }
  log(`playHuman timeout after ${acted} actions; last=${JSON.stringify(last)}`);
  return { acted, finished: false };
}

async function readStats(page) {
  return page.evaluate(() => {
    const game = globalThis.__fableGame;
    if (!game?.fxPlayer) return null;
    return {
      stats: game.fxPlayer.playbackStats,
      slowUpdates: game.fxPlayer.slowUpdates,
      speed: game.fxPlayer.currentSpeed,
    };
  });
}

function summarize(run) {
  const rows = run.stats.map((row) => ({
    seq: row.seq,
    fx: row.fx.map((step) => step.t).join(','),
    year: row.year,
    month: row.month,
    phase: row.phase,
    estMs: Math.round(row.estMs),
    scaledMs: Math.round(row.scaledMs),
    wallMs: Math.round(row.wallMs),
    overMs: Math.round(row.wallMs - row.scaledMs),
  }));
  const byWall = [...rows].sort((a, b) => b.wallMs - a.wallMs);
  // Per-fx-kind overrun: wall time minus that fx's own speed-scaled budget.
  const perKind = new Map();
  for (const row of run.stats) {
    for (const step of row.fx) {
      const entry = perKind.get(step.t) ?? { t: step.t, count: 0, wallMs: 0, budgetMs: 0, overMs: 0, maxOverMs: 0 };
      entry.count += 1;
      entry.wallMs += step.ms;
      entry.budgetMs += step.budgetMs;
      const over = step.ms - step.budgetMs;
      entry.overMs += over;
      entry.maxOverMs = Math.max(entry.maxOverMs, over);
      perKind.set(step.t, entry);
    }
  }
  const fxKinds = [...perKind.values()]
    .map((entry) => ({
      t: entry.t,
      count: entry.count,
      avgWallMs: Math.round(entry.wallMs / entry.count),
      avgBudgetMs: Math.round(entry.budgetMs / entry.count),
      avgOverMs: Math.round(entry.overMs / entry.count),
      maxOverMs: Math.round(entry.maxOverMs),
    }))
    .sort((a, b) => b.avgOverMs - a.avgOverMs);
  const totalWall = rows.reduce((sum, row) => sum + row.wallMs, 0);
  const totalScaled = rows.reduce((sum, row) => sum + row.scaledMs, 0);
  return {
    speed: run.speed,
    updates: rows.length,
    slowUpdates: run.slowUpdates,
    maxWallMs: byWall[0]?.wallMs ?? 0,
    maxScaledMs: byWall[0]?.scaledMs ?? 0,
    maxOverMs: byWall[0]?.overMs ?? 0,
    totalWallMs: Math.round(totalWall),
    totalScaledMs: Math.round(totalScaled),
    over300: rows.filter((row) => row.overMs > 300).length,
    top: byWall.slice(0, 12),
    fxKinds,
  };
}

async function runSpeed(browser, speed, log) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => log(`[pageerror] ${error.message}`));
  await startLocalGame(page, speed);
  const played = await playHuman(page, log);
  await sleep(1500);
  const data = await readStats(page);
  log(`speed=${speed}: raw stats rows=${data?.stats?.length ?? 'null'} game=${data ? 'yes' : 'no'}`);
  await context.close();
  return { speed, ...(data ?? { stats: [], slowUpdates: 0 }), ...played };
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const log = (...args) => console.log('[fx-measure]', ...args);
  const browser = await chromium.launch({
    headless: !HEADFUL,
    args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling'],
  });
  const results = [];
  try {
    for (const speed of SPEEDS) {
      log(`speed=${speed}: starting a 1-year local game`);
      const run = await runSpeed(browser, speed, log);
      const summary = summarize(run);
      results.push(summary);
      await writeFile(path.join(OUT, `${LABEL}-${speed}.json`), JSON.stringify({ summary, ...run }, null, 2));
      log(
        `speed=${speed}: ${summary.updates} updates, max ${summary.maxWallMs}ms (scaled budget ` +
          `${summary.maxScaledMs}ms), total ${summary.totalWallMs}ms vs ${summary.totalScaledMs}ms, ` +
          `slowUpdates=${summary.slowUpdates}, over300=${summary.over300}, finished=${run.finished}`,
      );
      for (const row of summary.top.slice(0, 6)) {
        log(
          `  seq=${row.seq} ${row.year}年${row.month}月 ${row.phase} wall=${row.wallMs}ms ` +
            `scaled=${row.scaledMs}ms est=${row.estMs}ms fx=[${row.fx}]`,
        );
      }
      for (const kind of summary.fxKinds.slice(0, 8)) {
        log(
          `  fx ${kind.t}: n=${kind.count} avgWall=${kind.avgWallMs}ms avgBudget=${kind.avgBudgetMs}ms ` +
            `avgOver=${kind.avgOverMs}ms maxOver=${kind.maxOverMs}ms`,
        );
      }
    }
  } finally {
    await browser.close();
  }
  await writeFile(path.join(OUT, `${LABEL}-all.json`), JSON.stringify(results, null, 2));
  console.log(
    JSON.stringify(
      results.map(({ speed, updates, maxWallMs, maxScaledMs, totalWallMs, totalScaledMs, slowUpdates }) => ({
        speed,
        updates,
        maxWallMs,
        maxScaledMs,
        totalWallMs,
        totalScaledMs,
        slowUpdates,
      })),
    ),
  );
}

await main();
