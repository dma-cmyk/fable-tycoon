// Probe: why does each fx cost ~250-300ms at ?speed=8?
// Measures raw timer latency, rAF cadence, layout cost and visibility in the running game.
import { chromium } from 'playwright';

const URL_BASE = process.env.DEV_URL || 'http://127.0.0.1:5269/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ headless: true, args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: 'ja-JP', reducedMotion: 'reduce' });
const page = await context.newPage();
await page.goto(`${URL_BASE}?speed=8`, { waitUntil: 'domcontentloaded' });
await page.locator('.title-menu-btn').filter({ hasText: 'ひとりで' }).first().click();
await page.locator('.seg-btn').filter({ hasText: /^1年$/ }).first().click();
await page.locator('.setup-start, .setup-mobile-start').first().click();
await page.locator('.game-screen').first().waitFor({ state: 'visible', timeout: 45_000 });
await sleep(3000);

const probe = await page.evaluate(async () => {
  const out = { visibility: document.visibilityState, hidden: document.hidden };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // raw timer latency at the delays the fx player uses
  out.timers = {};
  for (const ms of [40, 50, 80, 150]) {
    const samples = [];
    for (let i = 0; i < 6; i += 1) {
      const t0 = performance.now();
      await wait(ms);
      samples.push(Math.round(performance.now() - t0));
    }
    out.timers[ms] = samples;
  }
  // rAF cadence over ~1s
  const frames = [];
  await new Promise((resolve) => {
    let last = performance.now();
    const start = last;
    const tick = (now) => {
      frames.push(Math.round(now - last));
      last = now;
      if (now - start < 1200) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
  out.rafDeltas = frames;
  out.rafMedian = frames.slice().sort((a, b) => a - b)[Math.floor(frames.length / 2)] ?? null;
  // forced layout cost of the game screen
  const el = document.querySelector('.game-screen') ?? document.body;
  const layouts = [];
  for (let i = 0; i < 5; i += 1) {
    const t0 = performance.now();
    void el.getBoundingClientRect();
    void document.body.offsetHeight;
    layouts.push(Math.round((performance.now() - t0) * 10) / 10);
  }
  out.layoutMs = layouts;
  // one map frame cost (if the renderer exposes frame stats)
  out.mapFrameStats = globalThis.__fableGame?.map?.getFrameStats?.() ?? null;
  out.fxStats = globalThis.__fableGame?.fxPlayer?.playbackStats?.slice(-6) ?? null;
  return out;
});
console.log(JSON.stringify(probe, null, 2));
await context.close();
await browser.close();