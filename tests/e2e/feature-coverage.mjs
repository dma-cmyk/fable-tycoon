// Single-browser feature coverage for two rules the 4-browser online E2E never reached:
//
//   1. 飛行機 (pegasus) / ロケット (rocket) cannot land within 4 steps of the destination.
//   2. A human piper Lv1/Lv2 confiscation opens the 2-choice deal; properties above the
//      12% / 20% net-worth cap are never confiscated.
//
// How the state is staged
// -----------------------
// The game itself is started through the real UI (みんなで → 1年 → start). The scenario state is
// then written into the *real* local save envelope (`localStorage["fable.local"]`, which stores
// `RoomController.serialize()`), and the page is reloaded and resumed via the production
// つづきから path. No production code is patched or stubbed: the UI reads the staged state through
// its normal session and every click below is a real `Action` validated by the real engine.
// `window.__fableGame` (already exposed in dev by game.ts) is used only to observe `state`/`phase`.
//
// Run: node tests/e2e/feature-coverage.mjs [--viewport=pc|phone|both] [--port=5281] [--phone-dpr=1|3]
// Artifacts: .tmp/e2e/feature-coverage/*.png and report.json

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, '.tmp/e2e/feature-coverage');

const args = new Map(
  process.argv
    .filter((arg) => arg.startsWith('--') && arg.includes('='))
    .map((arg) => [arg.slice(2, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]),
);
const VIEWPORT_ARG = args.get('viewport') ?? 'both';
const PORT = Number(args.get('port') ?? process.env.E2E_PORT ?? 5281);
const BASE = `http://127.0.0.1:${PORT}`;

const VIEWPORTS = {
  pc: { width: 1280, height: 720, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  // DPR 1 by default: the renderer's map canvas is drawn at size*DPR and DPR 3 hits the
  // browser's canvas-area limit under memory pressure (same workaround as E2E_MOBILE_DPR=1).
  phone: { width: 390, height: 844, deviceScaleFactor: Number(args.get('phone-dpr') ?? 1), isMobile: true, hasTouch: true },
};
const VIEW_NAMES = VIEWPORT_ARG === 'both' ? ['pc', 'phone'] : VIEWPORT_ARG.split(',');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const checks = [];
const findings = [];
let currentView = null;
function check(name, condition, detail = '') {
  checks.push({ name, ok: !!condition, detail, view: currentView });
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  return !!condition;
}
function finding(text) {
  findings.push(text);
  console.log(`[FINDING] ${text}`);
}

async function waitFor(fn, { timeout = 20000, interval = 150, label = 'condition' } = {}) {
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

async function visible(page, selector) {
  return page.locator(selector).first().isVisible().catch(() => false);
}

async function startDevServer() {
  const child = spawn(
    process.execPath,
    ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += String(chunk);
  });
  await waitFor(
    async () => {
      if (child.exitCode !== null) throw new Error(`vite dev exited: ${output.slice(-400)}`);
      try {
        return (await fetch(`${BASE}/`, { signal: AbortSignal.timeout(1000) })).ok;
      } catch {
        return false;
      }
    },
    { timeout: 60_000, label: 'vite dev server' },
  );
  return child;
}

/** Start a 2-human hot-seat game (both seats are controlled by this browser). */
async function startLocalGame(page) {
  await page.goto(`${BASE}/?speed=8`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /みんなで/ }).click();
  await page.locator('.seg-btn', { hasText: /^1年$/ }).click();
  await page
    .locator('.setup-start:visible, .setup-mobile-start:visible')
    .first()
    .click();
  await page.waitForFunction(() => window.__fableGame?.mapReady === true, null, { timeout: 120000 });
  await waitFor(
    () => page.evaluate(() => (window.__fableGame?.state?.players.length ?? 0) >= 2),
    { timeout: 15_000, label: 'two players in game state' },
  );
}

/**
 * Write a scenario into the real local save and resume it through つづきから.
 * The in-page function has access to the app's own source modules (vite dev), so the
 * staging math uses the same `currentPrice` / `netWorth` / `piperSeizePlan` as production.
 */
async function stageAndResume(page, scenario) {
  const staged = await page.evaluate(async (spec) => {
    const { GAME_DATA } = await import('/src/data/index.ts');
    const graph = await import('/src/core/graph.ts');
    const engine = await import('/src/core/engine.ts');
    const economy = await import('/src/core/economy.ts');
    const seize = await import('/src/core/piperSeize.ts');
    const rng = await import('/src/core/rng.ts');

    const raw = localStorage.getItem('fable.local');
    if (!raw) throw new Error('no local save');
    const envelope = JSON.parse(raw);
    const room = JSON.parse(envelope.room);
    const state = room.state;
    if (!state) throw new Error('no game state in save');
    if (state.players.length < 2) throw new Error('need two human seats');

    const cityNode = (cityId) => graph.nodeForCity(GAME_DATA, cityId);
    const distance = (a, b) => engine.distance(GAME_DATA, a, b);
    const worldCities = GAME_DATA.cities.filter((c) => c.realm === undefined);

    // Common staged fields: deterministic, human, quiet room (no timers / events).
    state.current = 0;
    state.phase = { t: 'turn_start' };
    state.activeEventId = null;
    state.pendingTurnStart = false;
    state.year = 1;
    state.month = 4;
    state.round = 0;
    state.assetHistory = [];
    state.piper = { holder: null, level: 1, heldTurns: 0 };
    state.owner = {};
    for (const player of state.players) {
      player.cards = [];
      player.cash = 500;
      player.skipTurns = 0;
      player.autoplay = false;
    }
    room.deadline = null;
    room.deadlineSeq = room.seq ?? 0;
    room.deadlineActor = null;
    room.tasks = [];
    room.status = 'playing';

    const result = { kind: spec.kind };

    if (spec.kind === 'warp') {
      const isAirport = spec.cardId === 'pegasus';
      const targets = isAirport
        ? worldCities.filter((c) => c.airport)
        : worldCities;
      const targetNodes = targets
        .map((c) => ({ city: c, node: cityNode(c.id) }))
        .filter((entry) => entry.node !== null);
      let pick = null;
      for (const dest of targetNodes) {
        const steps = targetNodes.map((t) => ({ node: t.node, d: distance(t.node, dest.node) }));
        const blocked = steps.filter((s) => Number.isFinite(s.d) && s.d < 4);
        const allowed = steps.filter((s) => Number.isFinite(s.d) && s.d >= 4);
        if (blocked.length >= 2 && allowed.length >= 5) {
          pick = { dest, blocked, allowed };
          break;
        }
      }
      if (!pick) throw new Error('no destination with blocked and allowed targets');
      state.destination = pick.dest.city.id;
      state.players[0].nodeId = pick.dest.node;
      state.players[0].prevNodeId = null;
      state.players[0].cards = [spec.cardId];
      result.destination = pick.dest.city.id;
      result.destinationNode = pick.dest.node;
      result.blockedNodes = pick.blocked.map((s) => s.node);
      result.allowedNodes = pick.allowed.map((s) => s.node);
      result.playerNode = state.players[0].nodeId;
    } else if (spec.kind === 'confiscate') {
      const level = spec.level;
      const propertyPrice = (id) => economy.currentPrice(GAME_DATA, state, id);
      const all = [];
      for (const city of worldCities) {
        for (const property of city.properties) all.push({ id: property.id, cityId: city.id });
      }
      const priced = all.map((p) => ({ ...p, price: propertyPrice(p.id) }));
      const cheap = priced
        .filter((p) => p.price >= 18 && p.price <= 32)
        .slice(0, 2);
      const expensive = priced.slice().sort((a, b) => b.price - a.price)[0];
      const holder = 1;
      const owned = spec.expensiveOnly ? [] : cheap;
      if (!spec.expensiveOnly && owned.length === 0) throw new Error('no cheap properties found');
      state.owner[expensive.id] = holder;
      for (const p of owned) state.owner[p.id] = holder;
      state.players[holder].cash = 500;
      state.players[0].cash = 500;
      state.current = 0;
      state.piper = { holder, level, heldTurns: 0 };
      const stand = worldCities.find((c) => c.id !== expensive.cityId && c.properties.length > 0);
      state.players[0].nodeId = cityNode(stand.id);
      state.players[0].prevNodeId = null;
      state.phase = { t: 'buy', cityId: stand.id };

      // The mischief kind is `randInt(state, 0, 4)` after two RNG draws (hell roll, gift roll).
      // Pick a seed whose third draw is kind 1 (property confiscation).
      let seed = 0;
      for (let s = 1; s < 300000; s += 1) {
        const holderRng = { rng: s >>> 0 };
        rng.nextRandom(holderRng); // hell roll (unused below Lv3)
        const gift = rng.nextRandom(holderRng);
        const kind = Math.floor(rng.nextRandom(holderRng) * 5);
        if (gift >= 0.05 && kind === 1) {
          seed = s;
          break;
        }
      }
      if (!seed) throw new Error('no RNG seed for the confiscation mischief');
      state.rng = seed;

      const plan = seize.piperSeizePlan(GAME_DATA, state, state.players[holder], level);
      result.level = level;
      result.holder = holder;
      result.expensive = { id: expensive.id, price: expensive.price };
      result.cheap = owned.map((p) => ({ id: p.id, price: p.price }));
      result.plan = plan;
      result.planCap = economy.netWorth(GAME_DATA, state, holder) * seize.PIPER_SEIZE_CAP[level];
      result.netWorth = economy.netWorth(GAME_DATA, state, holder);
      result.cashBefore = state.players[holder].cash;
      result.ownedBefore = Object.fromEntries(
        Object.entries(state.owner).filter(([, owner]) => owner === holder),
      );
      result.seed = seed;
    } else {
      throw new Error(`unknown scenario ${spec.kind}`);
    }

    envelope.room = JSON.stringify(room);
    const stagedJson = JSON.stringify(envelope);
    try {
      JSON.parse(stagedJson);
    } catch (error) {
      return { ...result, serializeError: String(error), stagedJson: stagedJson.slice(0, 8000) };
    }
    localStorage.setItem('fable.local', stagedJson);
    return result;
  }, scenario);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /つづきから/ }).click();
  await page.waitForFunction(() => window.__fableGame?.mapReady === true, null, { timeout: 120000 });
  await waitFor(
    () => page.evaluate(() => !!window.__fableGame?.state && window.__fableGame.state.phase.t !== 'game_over'),
    { timeout: 20_000, label: 'staged state resumed' },
  );
  await sleep(350);
  return staged;
}

async function screenshot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`[shot] ${path.relative(ROOT, file)}`);
  return file;
}

async function openHandAndUseCard(page, cardId, cardName) {
  await page.locator('.hud-cmd-card').click();
  await waitFor(() => visible(page, '.cards-dialog'), { label: 'cards dialog' });
  const row = page.locator('.card-item', { hasText: cardName }).first();
  await waitFor(async () => (await row.count()) > 0, { label: `${cardName} in hand` });
  await row.locator('button').first().click();
  await waitFor(() => visible(page, '.target-dialog'), { timeout: 20000, label: `${cardId} target dialog` });
}

async function readTargetRows(page) {
  return page.evaluate(() => {
    const dialog = document.querySelector('.target-dialog');
    const rows = [];
    for (const el of dialog?.querySelectorAll('.target-item') ?? []) {
      const distText = el.querySelector('.warp-dist strong')?.textContent ?? '';
      const blockedTag = el.querySelector('.warp-tag.is-blocked')?.textContent ?? '';
      rows.push({
        node: el.dataset.node ?? null,
        steps: /^\d+$/.test(distText.trim()) ? Number(distText.trim()) : null,
        blocked: blockedTag.trim(),
        disabled: el.disabled,
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 90),
      });
    }
    const note = dialog?.querySelector('.warp-summary-note')?.textContent?.trim() ?? '';
    return { rows, note };
  });
}

async function runWarpScenario(page, view, cardId, cardName) {
  const staged = await stageAndResume(page, { kind: 'warp', cardId });
  await waitFor(
    () => page.evaluate(() => window.__fableGame.state.phase.t === 'turn_start' && window.__fableGame.state.current === 0),
    { label: `${cardId} staged turn start` },
  );
  await openHandAndUseCard(page, cardId, cardName);
  const { rows, note } = await readTargetRows(page);
  const enabled = rows.filter((r) => !r.disabled);
  const blockedRows = rows.filter((r) => r.blocked || (r.steps !== null && r.steps < 4));
  const forbiddenPresent = rows.filter((r) => staged.blockedNodes.includes(r.node));
  const pickerFile = await screenshot(page, `${view}-${cardId}-picker`);

  check(
    `${cardId}: picker lists at least one selectable target`,
    enabled.length >= 1,
    `${rows.length} rows / ${enabled.length} enabled`,
  );
  check(
    `${cardId}: no row within 3 steps of the destination is selectable`,
    rows.every((r) => r.steps === null || r.steps >= 4 || r.disabled),
    blockedRows.length ? `blocked rows: ${blockedRows.length}` : 'no blocked row offered',
  );
  check(
    `${cardId}: destination and near airports/cities are absent from the picker`,
    forbiddenPresent.length === 0,
    `${staged.blockedNodes.length} staged near nodes, ${forbiddenPresent.length} shown`,
  );
  check(
    `${cardId}: the 4-step rule is explained in the picker`,
    /4 マス未満/.test(note),
    note.slice(0, 60),
  );
  if (blockedRows.length > 0) {
    check(
      `${cardId}: blocked rows are disabled and show 目的地に近すぎる`,
      blockedRows.every((r) => r.disabled && r.blocked.includes('目的地に近すぎる')),
      blockedRows.map((r) => `${r.node}:${r.disabled}:${r.blocked}`).join(' / '),
    );
  } else {
    finding(
      `${cardId}: 目的地に近すぎる行は「disabled 表示」ではなく、エンジンが候補から除外している（${staged.blockedNodes.length}件が非表示）。UI の disabled+理由表示は実プレイでは出ない。`,
    );
  }

  // Fly to a selectable target and verify the engine actually moved the pawn.
  const target = enabled[Math.min(1, enabled.length - 1)];
  check(`${cardId}: chosen target is >= 4 steps from the destination`, target.steps === null || target.steps >= 4, JSON.stringify(target));
  await page.locator('.target-dialog .target-item').nth(rows.findIndex((r) => r.node === target.node)).click();
  await waitFor(
    () => page.evaluate((node) => window.__fableGame.state.players[0].nodeId === node, target.node),
    { timeout: 20000, label: `${cardId} landing at ${target.node}` },
  );
  const landed = await page.evaluate(() => ({
    node: window.__fableGame.state.players[0].nodeId,
    phase: window.__fableGame.state.phase.t,
  }));
  const landedFile = await screenshot(page, `${view}-${cardId}-landed`);
  check(
    `${cardId}: the player actually landed on the selected target`,
    landed.node === target.node,
    `node=${landed.node} phase=${landed.phase}`,
  );
  return { staged, pickerFile, landedFile, rows, note };
}

async function runConfiscateScenario(page, view, level, expensiveOnly) {
  const staged = await stageAndResume(page, { kind: 'confiscate', level, expensiveOnly });
  await waitFor(() => visible(page, '.city-end-buy:not([disabled])'), { label: 'buy-phase end button' });
  await page.locator('.city-end-buy:not([disabled])').first().click();

  if (expensiveOnly) {
    // kind===1 with an empty seize plan falls back to the cash mischief: no 2-choice event.
    await sleep(3500);
    const after = await page.evaluate(() => {
      const s = window.__fableGame.state;
      return {
        phase: s.phase.t,
        activeEventId: s.activeEventId,
        cash: s.players[1].cash,
        owned: Object.fromEntries(Object.entries(s.owner).filter(([, o]) => o === 1)),
        panel: !!document.querySelector('.event-panel.is-open .event-choice-label'),
      };
    });
    const file = await screenshot(page, `${view}-cap-lv${level}`);
    check(
      `Lv${level}: over-cap property is never in the seize plan`,
      staged.plan.propertyIds.length === 0,
      `plan=${JSON.stringify(staged.plan.propertyIds)} expensive=${staged.expensive.price} cap=${Math.round(staged.planCap)}`,
    );
    check(
      `Lv${level}: over-cap property stays owned after the mischief`,
      after.owned[staged.expensive.id] === 1,
      `owned=${JSON.stringify(after.owned)}`,
    );
    check(
      `Lv${level}: no confiscation 2-choice is opened when nothing is eligible`,
      after.activeEventId !== 'piper_confiscate' && !after.panel,
      `event=${after.activeEventId} phase=${after.phase} cash=${after.cash}`,
    );
    return { staged, file, after };
  }

  await waitFor(() => visible(page, '.event-panel.is-open .event-choice'), { timeout: 25000, label: 'confiscation event' });
  // The panel opens on the `event_open` fx, which is played *before* the state is adopted.
  // Wait for the engine state to carry the event so the assertions read the committed state.
  await waitFor(
    () => page.evaluate(() => window.__fableGame.state.activeEventId === 'piper_confiscate'),
    { timeout: 25000, label: 'confiscation state adopted' },
  );
  const event = await page.evaluate(() => ({
    choices: [...document.querySelectorAll('.event-choice')].map((el) => ({
      label: el.querySelector('.event-choice-label')?.textContent?.trim() ?? '',
      disabled: el.disabled,
    })),
    activeEventId: window.__fableGame.state.activeEventId,
    cash: window.__fableGame.state.players[1].cash,
    owned: Object.fromEntries(Object.entries(window.__fableGame.state.owner).filter(([, o]) => o === 1)),
  }));
  const offerFile = await screenshot(page, `${view}-confiscate-lv${level}-offer`);
  check(
    `Lv${level}: the confiscation event opens`,
    event.activeEventId === 'piper_confiscate',
    `event=${event.activeEventId}`,
  );
  check(
    `Lv${level}: two enabled choices are shown (差し出す / 示談金)`,
    event.choices.length === 2 && event.choices.every((c) => !c.disabled) &&
      event.choices[0].label.includes('物件を差し出す') && event.choices[1].label.includes('示談金'),
    JSON.stringify(event.choices),
  );
  check(
    `Lv${level}: the plan excludes the over-cap property`,
    staged.plan.propertyIds.length > 0 && !staged.plan.propertyIds.includes(staged.expensive.id),
    `plan=${JSON.stringify(staged.plan.propertyIds)} expensive=${staged.expensive.price} cap=${Math.round(staged.planCap)}`,
  );

  const choiceIndex = level === 2 ? 1 : 0;
  await page.locator('.event-choice').nth(choiceIndex).click();
  await waitFor(
    () => page.evaluate(() => window.__fableGame.state.phase.t === 'turn_start' && window.__fableGame.state.activeEventId === null),
    { timeout: 25000, label: `confiscation resolution (choice ${choiceIndex})` },
  );
  await sleep(500);
  const after = await page.evaluate(() => ({
    cash: window.__fableGame.state.players[1].cash,
    owned: Object.fromEntries(Object.entries(window.__fableGame.state.owner).filter(([, o]) => o === 1)),
  }));
  const afterFile = await screenshot(page, `${view}-confiscate-lv${level}-${choiceIndex === 0 ? 'surrender' : 'pay'}`);

  const dealCost = staged.plan.dealCost;
  const seizedValue = staged.plan.value;
  if (choiceIndex === 0) {
    const expectedGain = seizedValue * 0.2;
    check(
      `Lv${level} surrender: planned property is lost`,
      staged.plan.propertyIds.every((id) => after.owned[id] !== 1),
      `owned=${JSON.stringify(after.owned)}`,
    );
    check(
      `Lv${level} surrender: cash increases by the 20% distress-sale proceeds`,
      Math.abs(after.cash - (staged.cashBefore + expectedGain)) < 0.51,
      `cash ${staged.cashBefore} -> ${after.cash}, expected +${expectedGain.toFixed(1)}`,
    );
  } else {
    check(
      `Lv${level} pay: all planned properties stay owned`,
      staged.plan.propertyIds.every((id) => after.owned[id] === 1),
      `owned=${JSON.stringify(after.owned)}`,
    );
    check(
      `Lv${level} pay: cash decreases by the deal cost`,
      Math.abs(after.cash - (staged.cashBefore - dealCost)) < 0.51,
      `cash ${staged.cashBefore} -> ${after.cash}, expected -${dealCost.toFixed(1)}`,
    );
  }
  check(
    `Lv${level}: the over-cap property is untouched`,
    after.owned[staged.expensive.id] === 1,
    `expensive=${staged.expensive.id}`,
  );
  return { staged, event, after, offerFile, afterFile };
}

async function runViewport(browser, view) {
  currentView = view;
  const context = await browser.newContext({
    viewport: { width: VIEWPORTS[view].width, height: VIEWPORTS[view].height },
    deviceScaleFactor: VIEWPORTS[view].deviceScaleFactor,
    isMobile: VIEWPORTS[view].isMobile,
    hasTouch: VIEWPORTS[view].hasTouch,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
    console.error(`[${view}] pageerror: ${error.message}`);
  });
  page.on('crash', () => console.error(`[${view}] renderer crashed`));
  try {
    await startLocalGame(page);
    await runWarpScenario(page, view, 'pegasus', '飛行機チケット');
    await runWarpScenario(page, view, 'rocket', 'ロケット便');
    await runConfiscateScenario(page, view, 1, false);
    await runConfiscateScenario(page, view, 2, false);
    await runConfiscateScenario(page, view, 1, true);
    await runConfiscateScenario(page, view, 2, true);
    check(`${view}: no uncaught page errors`, errors.length === 0, errors.join(' | '));
  } finally {
    await context.close();
  }
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const server = await startDevServer();
  let browser = await chromium.launch({ headless: true, args: ['--mute-audio'] });
  const started = Date.now();
  try {
    for (const view of VIEW_NAMES) {
      console.log(`\n=== ${view} (${VIEWPORTS[view].width}x${VIEWPORTS[view].height}) ===`);
      const attempts = 2;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const checkMark = checks.length;
        const findingMark = findings.length;
        try {
          await runViewport(browser, view);
          break;
        } catch (error) {
          console.error(`[${view}] attempt ${attempt}/${attempts} failed: ${error.message}`);
          // Discard partial checks/findings from the failed attempt; a fresh attempt restages.
          checks.length = checkMark;
          findings.length = findingMark;
          if (attempt === attempts) throw error;
          if (!browser.isConnected()) {
            browser = await chromium.launch({ headless: true, args: ['--mute-audio'] });
          }
          await sleep(1500);
        }
      }
    }
  } finally {
    await browser.close().catch(() => undefined);
    server.kill('SIGTERM');
  }
  const failed = checks.filter((c) => !c.ok);
  const report = {
    viewports: VIEW_NAMES,
    emulation: Object.fromEntries(VIEW_NAMES.map((v) => [v, VIEWPORTS[v]])),
    perView: VIEW_NAMES.map((v) => {
      const own = checks.filter((c) => c.view === v);
      return { view: v, passed: own.filter((c) => c.ok).length, total: own.length };
    }),
    durationMs: Date.now() - started,
    checks,
    failed: failed.length,
    findings: [...new Set(findings)],
  };
  await writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed in ${Math.round(report.durationMs / 1000)}s`);
  if (findings.length > 0) console.log(`findings:\n- ${findings.join('\n- ')}`);
  if (failed.length > 0) {
    console.log(`failures:\n- ${failed.map((f) => `${f.name}: ${f.detail}`).join('\n- ')}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});