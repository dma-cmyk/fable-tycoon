// Midgame screenshots at PC and phone sizes, for the report.
//   node tests/e2e/midgame-shots.mjs --label=perfpc
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, '.tmp/midgame');
const DEV_URL = process.env.DEV_URL || 'http://127.0.0.1:5277/';
const args = new Map(process.argv.filter((a) => a.startsWith('--') && a.includes('=')).map((a) => [a.slice(2, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]));
const LABEL = args.get('label') ?? 'run';
const VIEWS = {
  pc: { width: 1920, height: 1080, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  phone: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const vis = (page, s) => page.locator(s).first().isVisible().catch(() => false);
async function waitFor(page, fn, label, timeout = 90_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { if (await fn()) return true; } catch { /* not ready */ }
    await sleep(150);
  }
  throw new Error(`timeout ${label}`);
}
async function stepHuman(page) {
  return page.evaluate(() => {
    const game = globalThis.__fableGame; const s = game?.state;
    if (!game || !s) return { waiting: true };
    if (s.phase.t === 'game_over') return { done: true };
    if (game.fxBusy || game.fxPlayer?.busy) return { waiting: true };
    const player = s.players[s.current];
    if (!player || player.isCpu) return { waiting: true };
    const owner = s.owner ?? {};
    const owned = Object.keys(owner).find((id) => owner[id] === s.current);
    let action = null;
    switch (s.phase.t) {
      case 'turn_start': action = { t: 'roll' }; break;
      case 'choose_dest': action = s.phase.options?.[0] ? { t: 'move', nodeId: s.phase.options[0].nodeId } : null; break;
      case 'buy': action = { t: 'end_buy' }; break;
      case 'event': action = { t: 'choose', index: 0 }; break;
      case 'card_target': action = s.phase.options?.[0] ? { t: 'card_target', target: s.phase.options[0] } : { t: 'cancel' }; break;
      case 'skill_target': action = s.phase.options?.[0] ? { t: 'skill_target', target: s.phase.options[0] } : { t: 'cancel' }; break;
      case 'discard': action = player.cards?.[0] ? { t: 'discard', cardId: player.cards[0] } : null; break;
      case 'sell': action = owned ? { t: 'sell', propertyId: owned } : null; break;
      case 'shop': action = { t: 'end_shop' }; break;
      case 'year_end': action = { t: 'ack' }; break;
      default: action = null;
    }
    if (!action) return { waiting: true };
    game.sendAction(action);
    return { acted: true };
  });
}
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--mute-audio'] });
try {
  for (const [name, vp] of Object.entries(VIEWS)) {
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.deviceScaleFactor, isMobile: vp.isMobile, hasTouch: vp.hasTouch, locale: 'ja-JP', timezoneId: 'Asia/Tokyo', reducedMotion: 'reduce' });
    const page = await context.newPage();
    await page.goto(new URL('?speed=8', DEV_URL).toString(), { waitUntil: 'domcontentloaded' });
    await waitFor(page, () => vis(page, '.title-menu-btn'), 'title');
    await page.locator('.title-menu-btn').filter({ hasText: 'ひとりで' }).first().click();
    await waitFor(page, () => vis(page, '.setup-screen'), 'setup', 20_000);
    await page.locator('.seg-btn').filter({ hasText: /^1年$/ }).first().click();
    await page.locator('.setup-start:visible, .setup-mobile-start:visible').first().click();
    await waitFor(page, () => vis(page, '.game-screen'), 'game', 60_000);
    await waitFor(page, () => page.evaluate(() => !!globalThis.__fableGame?.map?.state), 'map', 60_000);
    // Play into the second half of the year, then hold still for a clean capture.
    const end = Date.now() + 16_000;
    while (Date.now() < end) {
      const r = await stepHuman(page).catch(() => ({ waiting: true }));
      if (r.done) break;
      await sleep(r.acted ? 180 : 120);
    }
    // Let the tile fill settle, and record the lowest label alpha drawn at capture time so a
    // screenshot can never claim "settled" while a label is still fading.
    await page.evaluate(() => {
      const m = globalThis.__fableGame.map;
      globalThis.__minLabelAlpha = 1;
      const orig = m.drawLabelBubble.bind(m);
      m.drawLabelBubble = (ctx, nx, ny, rect, plan, ratio, dest, owner, alpha, prio) => {
        if (alpha < globalThis.__minLabelAlpha) globalThis.__minLabelAlpha = alpha;
        return orig(ctx, nx, ny, rect, plan, ratio, dest, owner, alpha, prio);
      };
      m.landLayer.setFrameBudget(0);
      for (let i = 0; i < 60; i++) { m.draw(performance.now()); if (m.landLayer.getFrameStats().pending === 0) break; }
      m.landLayer.setFrameBudget(8);
      m.requestRender();
    });
    // Real frames with real time so every label fade completes before the shot.
    await sleep(1200);
    await page.evaluate(() => { globalThis.__minLabelAlpha = 1; });
    await sleep(260);
    const stats = await page.evaluate(() => { const s = globalThis.__fableGame.state; return { year: s.year, month: s.month, phase: s.phase.t, turn: s.current, minLabelAlpha: Math.round((globalThis.__minLabelAlpha ?? 1) * 100) / 100, land: globalThis.__fableGame.map.landLayer.getFrameStats() }; });
    await page.screenshot({ path: path.join(OUT, `${LABEL}-${name}-midgame.png`), fullPage: false });
    console.log(`[shots] ${name} ${vp.width}x${vp.height} -> ${LABEL}-${name}-midgame.png ${JSON.stringify(stats)}`);
    await context.close();
  }
} finally {
  await browser.close();
}
