// 「おすすめ」 recommendation probe.
//
// Plays a real solo game (human + 3 CPUs) via the real UI on the given viewport and,
// for every human dice roll that shows move options, records:
//   - option count / visible chip count
//   - whether the move list shows a `.move-chip-tag` with 「おすすめ」
//   - `game.recommendedMoveNodeId`
//   - `map.getRecommendedMoveOption()`
//   - whether the map drew the gold 「おすすめ」 flag (`drawRecommendedTag`) during the roll
//   - ms from the options becoming visible to the tag appearing
// plus the conditions of each miss (filters, realm, errand, unreachable destination,
// list overflow, the recommended chip scrolled out of the tray, off-board pin, ...).
//
//   node tests/e2e/recommendation-probe.mjs --viewport=pc --rolls=40 --label=current
//   node tests/e2e/recommendation-probe.mjs --viewport=phone --rolls=40 --label=current
//
// Results go to .tmp/reco/<label>-<viewport>.json and a summary is printed.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, '.tmp/reco');
const args = new Map(
  process.argv
    .filter((a) => a.startsWith('--') && a.includes('='))
    .map((a) => [a.slice(2, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]),
);
const DEV_URL = process.env.DEV_URL || 'http://127.0.0.1:5283/';
const LABEL = args.get('label') ?? 'run';
const VIEWPORTS = {
  pc: { width: 1280, height: 720, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  phone: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};
const WHICH = args.get('viewport') ?? 'both';
const TARGET_ROLLS = Number(args.get('rolls') ?? 40);
const YEARS = args.get('years') ?? '20';
const SETTLE_MS = Number(args.get('settle') ?? 700);
const SHOTS = Number(args.get('shots') ?? 0);
const CPUS = Number(args.get('cpus') ?? 3);
const DEADLINE_MS = Number(args.get('deadline') ?? 25 * 60_000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const vis = (page, s) => page.locator(s).first().isVisible().catch(() => false);

async function waitFor(page, fn, label, timeout = 90_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      if (await fn()) return true;
    } catch {
      /* not ready */
    }
    await sleep(150);
  }
  throw new Error(`timeout ${label}`);
}

/** Runs inside the page: patches drawRecommendedTag and samples the move tray every frame. */
function installRecorder() {
  const g = globalThis.__fableGame;
  if (!g || !g.map) return false;
  const rec = (globalThis.__reco = globalThis.__reco ?? {
    rolls: [],
    pending: null,
    flagDraws: 0,
    frames: 0,
    startedAt: performance.now(),
  });
  const proto = Object.getPrototypeOf(g.map);
  if (!proto.__recoPatched) {
    const origTag = proto.drawRecommendedTag;
    proto.drawRecommendedTag = function patchedTag(...rest) {
      const r = globalThis.__reco;
      if (r) {
        r.flagDraws += 1;
        if (r.pending) {
          if (r.pending.flagAt === null) r.pending.flagAt = performance.now() - r.pending.t0;
          // Record which candidate the flag represents, no matter which marker path drew it
          // (pin, small chip, off-board edge badge, or the last-resort anchor).
          r.pending.flagNode = this.getRecommendedMoveOption?.() ?? null;
        }
      }
      return origTag.apply(this, rest);
    };
    const origPin = proto.drawOptionPin;
    // drawOptionPin(ctx, nodeId, x, y, r, kind, chip, number, selected, isRecommended, now, index)
    proto.drawOptionPin = function patchedPin(...rest) {
      const r = globalThis.__reco;
      if (r && rest[9] === true) {
        r.recPinNodeId = rest[1];
        if (r.pending) r.pending.recPinNodeIds = [...(r.pending.recPinNodeIds ?? []), rest[1]].slice(-8);
      }
      return origPin.apply(this, rest);
    };
    proto.__recoPatched = true;
  }

  const nodeRealm = (nodeId) => {
    const node = g.map?.nodeById?.get(nodeId);
    return node?.realm ?? 'world';
  };
  const inside = (rect, box) =>
    rect.right > box.x && rect.left < box.x + box.w && rect.bottom > box.y && rect.top < box.y + box.h;
  const boxOf = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height, right: r.right, bottom: r.bottom, left: r.left, top: r.top };
  };

  const begin = (state, host, chips) => {
    const actor = state.current;
    const player = state.players[actor];
    const options = state.phase.options;
    const distances = options.map((option) => g.map?.getMoveOptionDistanceInfo?.(option.nodeId)?.hops ?? null);
    const scroller = host.querySelector('.move-chip-scroll');
    const map = g.map;
    const board = map?.freeBoardBox?.() ?? null;
    const target = map?.moveTarget?.() ?? null;
    const pinInfo = options
      .map((option) => {
        const node = map?.nodeById?.get(option.nodeId);
        if (!node || !map?.camera) return null;
        return {
          id: option.nodeId,
          x: map.camera.screenX(node.x),
          y: map.camera.screenY(node.y),
        };
      })
      .filter(Boolean);
    return {
      key: `${state.round}:${state.phase.roll}:${options.map((o) => o.nodeId).join(',')}`,
      t0: performance.now(),
      flagAt: null,
      flagDrawsAtStart: rec.flagDraws,
      flagNode: null,
      shotTaken: false,
      year: state.year,
      month: state.month,
      round: state.round,
      roll: state.phase.roll,
      optionCount: options.length,
      visibleCount: chips.length,
      hasTag: false,
      tagAt: null,
      recommendedMoveNodeId: g.recommendedMoveNodeId ?? null,
      mapRecommended: map?.getRecommendedMoveOption?.() ?? null,
      moveOnlyCities: !!g.moveOnlyCities,
      quickFilter: g.moveQuickFilter ?? 'all',
      many: host.classList.contains('is-many'),
      veryMany: host.classList.contains('is-very-many'),
      errandCityId: state.errand?.cityId ?? null,
      errandBonus: state.errand?.bonus ?? 0,
      realm: nodeRealm(player?.nodeId),
      playerRealmFlag: g.playerRealm ?? null,
      cash: player?.cash ?? null,
      destination: state.destination,
      moveTarget: target,
      distances,
      unreachableOptions: distances.filter((d) => d === null).length,
      mapOptionCount: map?.moveOptions?.length ?? null,
      scrollerOverflow: scroller ? scroller.scrollWidth > scroller.clientWidth + 1 : null,
      scrollerScrollLeft: scroller?.scrollLeft ?? null,
      scrollerWidth: scroller?.clientWidth ?? null,
      scrollerScrollWidth: scroller?.scrollWidth ?? null,
      board,
      freeBox: board,
      pins: pinInfo,
      recommendedChip: null,
      recommendedChipVisibleInScroller: null,
      recommendedOnBoard: null,
      homeRealm: nodeRealm(player?.nodeId),
    };
  };

  const sample = () => {
    rec.frames += 1;
    const s = g.state;
    if (!s || !s.phase || s.phase.t !== 'choose_dest') return;
    const host = document.querySelector('.game-screen .move-options');
    if (!host || host.hidden) return;
    const chips = [...host.querySelectorAll('.move-chip')];
    if (chips.length === 0) return;
    const key = `${s.round}:${s.phase.roll}:${s.phase.options.map((o) => o.nodeId).join(',')}`;
    if (!rec.pending || rec.pending.key !== key) {
      rec.pending = begin(s, host, chips);
      globalThis.__shotTaken = false;
    }
    const p = rec.pending;
    const now = performance.now();
    if (!p.hasTag) {
      const tag = [...host.querySelectorAll('.move-chip-tag')].find((el) => el.textContent?.trim() === 'おすすめ');
      if (tag) {
        p.hasTag = true;
        p.tagAt = now - p.t0;
      }
    }
    // Live recomputation: the fields may change between the first paint and the confirm.
    p.recommendedMoveNodeId = g.recommendedMoveNodeId ?? null;
    p.mapRecommended = g.map?.getRecommendedMoveOption?.() ?? null;
    p.tagCount = host.querySelectorAll('.move-chip-tag').length;
    p.optionCount = s.phase.options.length;
    p.visibleCount = chips.length;
    p.moveQuickFilter = g.moveQuickFilter ?? 'all';
    p.moveOnlyCities = !!g.moveOnlyCities;
    const recId = p.recommendedMoveNodeId;
    const recChip = recId ? chips.find((chip) => chip.dataset.nodeId === recId) : null;
    p.recommendedChip = recChip ? { nodeId: recId, isRecommended: recChip.classList.contains('is-recommended') } : null;
    if (recChip) {
      const scroller = host.querySelector('.move-chip-scroll');
      if (scroller) {
        const c = boxOf(recChip);
        const sc = boxOf(scroller);
        p.recommendedChipVisibleInScroller =
          c.right > sc.left + 2 && c.left < sc.right - 2 && c.bottom > sc.top + 2 && c.top < sc.bottom - 2;
        p.scrollerScrollLeft = scroller.scrollLeft;
      }
      const box = boxOf(recChip);
      p.recommendedChipOnScreen =
        box.right > 0 && box.left < window.innerWidth - 1 && box.bottom > 0 && box.top < window.innerHeight - 1;
      p.recommendedChipRect = { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) };
      p.recommendedChipIndex = chips.indexOf(recChip);
      p.recommendedChipFirst = chips.indexOf(recChip) === 0;
    } else {
      p.recommendedChipVisibleInScroller = false;
    }
    const pin = p.pins?.find((entry) => entry.id === recId);
    if (pin && p.board) {
      const r = 20;
      p.recommendedOnBoard =
        pin.x - r >= p.board.x && pin.x + r <= p.board.x + p.board.w && pin.y - r >= p.board.y && pin.y + r <= p.board.y + p.board.h;
    }
    p.lastSampleAt = now;
    p.flagEverDrawn = rec.flagDraws > p.flagDrawsAtStart;
    p.mapFlagNodeId = p.flagNode ?? rec.recPinNodeId ?? null;
    p.agree = p.mapRecommended === p.recommendedMoveNodeId;
  };

  const finish = () => {
    const p = rec.pending;
    if (!p) return null;
    p.flagEverDrawn = rec.flagDraws > p.flagDrawsAtStart;
    p.flagAt = p.flagAt ?? null;
    p.durationMs = performance.now() - p.t0;
    p.tagPresentAnyTime = p.hasTag;
    p.miss = !p.hasTag;
    p.mapFlagDrawn = p.flagEverDrawn;
    p.mapFlagNodeId = p.flagNode ?? rec.recPinNodeId ?? null;
    p.agree = p.mapRecommended === p.recommendedMoveNodeId;
    p.moveRemain = Object.fromEntries(g.moveRemain ?? []);
    p.tagCountFinal = p.tagCount ?? 0;
    rec.rolls.push(p);
    rec.pending = null;
    return p;
  };

  globalThis.__reco.finish = finish;
  globalThis.__reco.sample = sample;
  const loop = () => {
    const r = globalThis.__reco;
    if (!r) return;
    try {
      sample();
    } catch (error) {
      r.error = String(error);
    }
    if (!g.destroyed) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return true;
}

/** One UI step. Returns what it did so the caller can pace. */
function stepHuman() {
  const g = globalThis.__fableGame;
  const s = g?.state;
  if (!g || !s) return { waiting: true };
  if (s.phase.t === 'game_over') return { done: true };
  if (g.fxBusy || g.fxPlayer?.busy) {
    // Presentation-only fast-forward: the state is the same, only the cutscenes are skipped,
    // so a 40-roll measurement does not spend 20 minutes watching CPU dice.
    g.fxPlayer?.skip?.();
    return { acted: 'skip' };
  }
  const player = s.players[s.current];
  if (!player || player.isCpu) return { waiting: true };
  const owned = s.owner ?? {};
  const ownedId = Object.keys(owned).find((id) => owned[id] === s.current);
  switch (s.phase.t) {
    case 'turn_start': {
      const btn = document.querySelector('.game-screen .dice-primary');
      if (btn && !btn.disabled) {
        btn.click();
        return { acted: 'roll' };
      }
      g.sendAction({ t: 'roll' });
      return { acted: 'roll-api' };
    }
    case 'choose_dest': {
      const rec = globalThis.__reco;
      const p = rec?.pending;
      if (p && performance.now() - p.t0 < (globalThis.__recoSettle ?? 650)) return { waiting: true };
      // Screenshot mode: let the host capture the open tray before this roll is confirmed.
      if (p && globalThis.__shotMode && !globalThis.__shotTaken) {
        globalThis.__shotTaken = true;
        return { ready: true };
      }
      // Record this roll before confirming it.
      const row = rec?.finish ? rec.finish() : null;
      const chips = [...document.querySelectorAll('.game-screen .move-options .move-chip')];
      const pick =
        chips.find((chip) => chip.classList.contains('is-recommended')) ??
        chips.find((chip) => chip.classList.contains('is-selected')) ??
        chips[0];
      if (!pick) return { waiting: true };
      pick.click();
      const btn = document.querySelector('.game-screen .dice-primary');
      if (btn && !btn.disabled) {
        btn.click();
        return { acted: 'move-ui', recorded: row ? 1 : 0 };
      }
      g.sendAction({ t: 'move', nodeId: pick.dataset.nodeId });
      return { acted: 'move-api', recorded: row ? 1 : 0 };
    }
    case 'buy':
      g.sendAction({ t: 'end_buy' });
      return { acted: 'buy' };
    case 'event':
      g.sendAction({ t: 'choose', index: 0 });
      return { acted: 'event' };
    case 'card_target':
      g.sendAction(s.phase.options?.[0] ? { t: 'card_target', target: s.phase.options[0] } : { t: 'cancel' });
      return { acted: 'card_target' };
    case 'skill_target':
      g.sendAction(s.phase.options?.[0] ? { t: 'skill_target', target: s.phase.options[0] } : { t: 'cancel' });
      return { acted: 'skill_target' };
    case 'discard':
      g.sendAction(player.cards?.[0] ? { t: 'discard', cardId: player.cards[0] } : { t: 'end_buy' });
      return { acted: 'discard' };
    case 'sell':
      g.sendAction(ownedId ? { t: 'sell', propertyId: ownedId } : { t: 'end_buy' });
      return { acted: 'sell' };
    case 'shop':
      g.sendAction({ t: 'end_shop' });
      return { acted: 'shop' };
    case 'year_end':
      g.sendAction({ t: 'ack' });
      return { acted: 'year_end' };
    default:
      return { waiting: true };
  }
}

async function startSolo(page, years) {
  await page.goto(new URL('?speed=8', DEV_URL).toString(), { waitUntil: 'domcontentloaded' });
  await waitFor(page, () => vis(page, '.title-menu-btn'), 'title');
  await page.locator('.title-menu-btn').filter({ hasText: 'ひとりで' }).first().click();
  await waitFor(page, () => vis(page, '.setup-screen'), 'setup', 20_000);
  const yearBtn = page.locator('.seg-btn').filter({ hasText: new RegExp(`^${years}年$`) }).first();
  if (await yearBtn.count()) await yearBtn.click();
  // Trim CPU seats so more human rolls land per minute; the recommendation logic does not
  // depend on the table size. The seat-kind selector stays rendered as なし, so decide by the
  // CPU button's aria-pressed instead of by group count.
  const groups = page.locator('.setup-seats .seat-kind-seg');
  const seatGroups = await groups.count();
  for (let index = seatGroups - 1; index >= CPUS; index -= 1) {
    const group = groups.nth(index);
    const cpuBtn = group.locator('.seg-btn').filter({ hasText: 'CPU' }).first();
    if ((await cpuBtn.getAttribute('aria-pressed')) !== 'true') continue;
    await group.locator('.seg-btn').filter({ hasText: 'なし' }).first().click();
    await sleep(120);
  }
  await page.locator('.setup-start:visible, .setup-mobile-start:visible').first().click();
  await waitFor(page, () => vis(page, '.game-screen'), 'game', 60_000);
  await waitFor(page, () => page.evaluate(() => !!globalThis.__fableGame?.map?.state), 'map', 60_000);
  await page.waitForFunction(() => document.querySelectorAll('.game-screen .hud-icon').length > 0, null, { timeout: 30_000 });
  // Install as soon as the game exists, before the first roll.
  await page.evaluate((settle) => { globalThis.__recoSettle = settle; }, SETTLE_MS);
  await page.evaluate((mode) => { globalThis.__shotMode = mode; }, SHOTS > 0);
  await waitFor(page, () => page.evaluate(installRecorder), 'recorder', 20_000);
}

async function runViewport(browser, name, vp) {
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
  page.on('pageerror', (error) => console.log(`  [pageerror] ${error.message}`));
  await startSolo(page, YEARS);
  console.log(`[${name}] game started, playing for ${TARGET_ROLLS} rolls…`);
  await mkdir(path.join(OUT, 'shots'), { recursive: true });

  const started = Date.now();
  let recorded = 0;
  let lastKey = null;
  let shotsTaken = 0;
  const jsonl = path.join(OUT, `${LABEL}-${name}.jsonl`);
  await writeFile(jsonl, '');
  let written = 0;
  let lastProgress = Date.now();
  let lastStallReport = 0;
  while (recorded < TARGET_ROLLS && Date.now() - started < DEADLINE_MS) {
    if (page.isClosed() || browser.isConnected() === false) {
      console.log(`[${name}] page closed by another process; keeping ${recorded} rolls`);
      break;
    }
    const step = await page.evaluate(stepHuman).catch((error) => ({ waiting: true, error: String(error) }));
    if (step.recorded) lastProgress = Date.now();
    if (Date.now() - lastProgress > 30_000 && Date.now() - lastStallReport > 30_000) {
      lastStallReport = Date.now();
      const diag = await page
        .evaluate(() => {
          const g = globalThis.__fableGame;
          const s = g?.state;
          const p = s ? s.players[s.current] : null;
          return {
            phase: s?.phase?.t,
            round: s?.round,
            month: s?.month,
            year: s?.year,
            actor: s?.current,
            isCpu: p?.isCpu,
            fxBusy: g?.fxBusy,
            actionPending: g?.actionPending,
            deadline: g?.deadline,
            mapReady: g?.mapReady,
            toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent).slice(-3),
            dialog: document.querySelector('.modal-panel')?.textContent?.slice(0, 80) ?? null,
            moveHostHidden: document.querySelector('.game-screen .move-options')?.hidden ?? null,
          };
        })
        .catch((error) => ({ diagError: String(error) }));
      console.log(`[${name}] STALL ${JSON.stringify(diag)}`);
      await page.screenshot({ path: path.join(OUT, 'shots', `${LABEL}-${name}-stall.png`) }).catch(() => undefined);
      // Nudge: a fresh resync often clears a phase the harness has no action for.
      await page.evaluate(() => globalThis.__fableGame?.session?.requestResync?.()).catch(() => undefined);
    }
    if (page.isClosed()) {
      console.log(`[${name}] page closed by another process; keeping ${recorded} rolls`);
      break;
    }
    if (step.done) {
      console.log(`[${name}] game over after ${recorded} rolls`);
      break;
    }
    if (step.error) console.log(`[${name}] step error: ${step.error}`);
    // Stream every finished roll to disk so a killed run still leaves its data behind.
    const fresh = await page
      .evaluate((from) => (globalThis.__reco?.rolls ?? []).slice(from), written)
      .catch(() => null);
    if (fresh && fresh.length > 0) {
      written += fresh.length;
      const lines = fresh.map((roll) => JSON.stringify(roll)).join('\n') + '\n';
      await writeFile(jsonl, lines, { flag: 'a' });
    }
    if (step.ready && shotsTaken < SHOTS) {
      // The tray is open and settled; capture the list tag and the map flag together.
      shotsTaken += 1;
      await page.screenshot({ path: path.join(OUT, 'shots', `${LABEL}-${name}-roll${shotsTaken}.png`) });
      continue;
    }
    if (step.recorded) {
      recorded += 1;
      const info = await page.evaluate(() => {
        const r = globalThis.__reco.rolls.at(-1);
        return r
          ? {
              key: r.key, tag: r.hasTag, tagAt: r.tagAt, mapFlag: r.mapFlagDrawn,
              rec: r.recommendedMoveNodeId, mapRec: r.mapRecommended,
              options: r.optionCount, misses: r.unreachableOptions, filter: r.quickFilter,
              cities: r.moveOnlyCities, realm: r.realm, many: r.many,
              overflow: r.scrollerOverflow, chipVisible: r.recommendedChipVisibleInScroller,
              onBoard: r.recommendedOnBoard, errand: r.errandCityId ? 1 : 0,
              mapOpts: r.mapOptionCount, pins: r.pins?.length ?? -1,
              onScreen: r.recommendedChipOnScreen, agree: r.agree,
            }
          : null;
      });
      console.log(
        `[${name}] roll #${recorded} ${info ? JSON.stringify(info) : '(no record)'}`,
      );
      lastKey = info?.key ?? lastKey;
    }
    await sleep(step.acted ? 60 : 110);
  }

  const result = await page.evaluate(() => ({
    rolls: globalThis.__reco?.rolls ?? [],
    error: globalThis.__reco?.error ?? null,
    frames: globalThis.__reco?.frames ?? 0,
    lastKey: globalThis.__fableGame?.state
      ? `${globalThis.__fableGame.state.round}:${globalThis.__fableGame.state.phase.t}`
      : null,
  }));
  await context.close();
  void lastKey;
  return { viewport: name, vp, ...result };
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ['--mute-audio'] });
  const report = { label: LABEL, url: DEV_URL, at: new Date().toISOString(), runs: [] };
  try {
    const names = WHICH === 'both' ? ['pc', 'phone'] : [WHICH];
    for (const name of names) {
      const run = await runViewport(browser, name, VIEWPORTS[name]);
      report.runs.push(run);
      const rolls = run.rolls;
      const classify = (r) => {
        const reasons = [];
        if (!r.hasTag) reasons.push('no-tag');
        else if (r.recommendedChipOnScreen === false) reasons.push('tag-offscreen');
        if (!r.mapFlagDrawn) reasons.push('no-map-flag');
        else if (r.agree === false) reasons.push('map-picked-other');
        return reasons;
      };
      const judged = rolls.map((r) => ({ roll: r, reasons: classify(r) }));
      const misses = judged.filter((entry) => entry.reasons.length > 0);
      console.log(
        `[${name}] collected=${rolls.length} judged-misses=${misses.length} ` +
          `no-tag=${judged.filter((e) => e.reasons.includes('no-tag')).length} ` +
          `offscreen=${judged.filter((e) => e.reasons.includes('tag-offscreen')).length} ` +
          `no-flag=${judged.filter((e) => e.reasons.includes('no-map-flag')).length} ` +
          `flag-other=${judged.filter((e) => e.reasons.includes('map-picked-other')).length} error=${run.error ?? '-'}`,
      );
      for (const { roll: miss, reasons } of misses) {
        console.log(
          `  MISS [${reasons.join(',')}] ${miss.year}年${miss.month}月 round=${miss.round} roll=${miss.roll} ` +
            `opts=${miss.optionCount} vis=${miss.visibleCount} rec=${miss.recommendedMoveNodeId} ` +
            `mapRec=${miss.mapRecommended} flagNode=${miss.mapFlagNodeId ?? '-'} ` +
            `realm=${miss.realm} errand=${miss.errandCityId ?? '-'} ` +
            `many=${miss.many} filter=${miss.quickFilter} cities=${miss.moveOnlyCities} ` +
            `unreachable=${miss.unreachableOptions} chip=${miss.recommendedChip ? 'yes' : 'no'} ` +
            `chipIdx=${miss.recommendedChipIndex ?? '-'} scrollLeft=${miss.scrollerScrollLeft}/${miss.scrollerWidth} ` +
            `overflow=${miss.scrollerOverflow} mapOpts=${miss.mapOptionCount} pins=${miss.pins?.length ?? '-'} ` +
            `target=${JSON.stringify(miss.moveTarget)}`,
        );
      }
    }
  } finally {
    await browser.close();
  }
  const file = path.join(OUT, `${LABEL}.json`);
  await writeFile(file, JSON.stringify(report, null, 2));
  console.log(`saved ${file}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
