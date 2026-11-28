// スマホでイベントの選択肢が押せないことがある ── 実タップでの再現プローブ。
//
//   node tests/e2e/event-choice-tap-probe.mjs --view=phone --mode=standard --events=15 --years=3年 --tag=before
//   node tests/e2e/event-choice-tap-probe.mjs --view=pc    --mode=standard --events=15 --tag=after
//
// やること:
//   1. ソロ（人間 1 + CPU 3）を開始し、人間の手番を自動で進める。
//   2. 人間の選択肢イベントが開いたら、選択肢が出た瞬間（is-choosing）を記録し、
//      各ボタンの elementFromPoint / opacity / pointer-events を取る。
//   3. page.touchscreen.tap（PC は mouse）で実際に選び、chosen になったかで成否を判定。
//   4. イベント中に選択肢が作り直された回数（refreshChoices の rebuild）も数える。
// Artifacts: .tmp/e2e/report102/<tag>/*.png, .tmp/e2e/report102/<tag>/report.json

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = new Map(
  process.argv
    .filter((a) => a.startsWith('--') && a.includes('='))
    .map((a) => [a.slice(2, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]),
);
const PORT = Number(args.get('port') ?? 5281);
const BASE = `http://127.0.0.1:${PORT}`;
const VIEW = args.get('view') ?? 'phone';
const MODE = args.get('mode') ?? 'standard';
const MAX_EVENTS = Number(args.get('events') ?? 15);
const SCENARIOS = Number(args.get('scenarios') ?? 15);
const NO_RECOVERY = args.get('no-recovery') === '1';
const SAFETY = args.get('safety') !== '0';
const TAG = args.get('tag') ?? VIEW;
const OUT = path.join(ROOT, '.tmp/e2e/report102', TAG);
const SPEED = Number(args.get('speed') ?? (MODE === 'brisk' ? 4 : 1));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { view: VIEW, mode: MODE, events: [], failures: [], errors: [] };

async function startDevServer() {
  const child = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (c) => (output += String(c)));
  child.stderr.on('data', (c) => (output += String(c)));
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`vite dev exited: ${output.slice(-400)}`);
    try {
      if ((await fetch(`${BASE}/`, { signal: AbortSignal.timeout(1000) })).ok) return child;
    } catch {
      /* retry */
    }
    await sleep(150);
  }
  throw new Error('vite dev server timeout');
}

async function startSoloGame(page) {
  await page.goto(`${BASE}/?speed=${SPEED}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /ひとりで/ }).click();
  await page.locator('.setup-screen').waitFor({ timeout: 40_000 });
  const years = args.get('years') ?? '1年';
  await page.locator('.seg-btn', { hasText: new RegExp(`^${years}$`) }).click();
  const starts = page.locator('.setup-start:visible, .setup-mobile-start:visible');
  await starts.first().click();
  await page.waitForFunction(() => window.__fableGame?.mapReady === true, null, { timeout: 120_000 });
  await page.waitForFunction(() => (window.__fableGame?.state?.players?.length ?? 0) >= 2, null, { timeout: 20_000 });
  await sleep(600);
}

/** refreshChoices を包んで、選択肢が作り直された回数とタイミングを記録する。 */
async function installInstrumentation(page) {
  await page.evaluate(() => {
    const game = window.__fableGame;
    const probe = (window.__probe = {
      log: [],
      rebuilds: 0,
      keyFlips: 0,
      touch: [],
      now: () => Math.round(performance.now()),
      startedAt: Math.round(performance.now()),
    });
    const panel = game.eventPanel;
    const orig = panel.refreshChoices.bind(panel);
    let lastKey = panel.choiceKey;
    let lastEnabled = null;
    panel.refreshChoices = function patchedRefreshChoices() {
      const beforeKey = this.choiceKey;
      const countBefore = this.choicesHost.childElementCount;
      orig();
      const afterKey = this.choiceKey;
      if (afterKey !== beforeKey) {
        probe.keyFlips += 1;
        const enabled = String(afterKey).split('|')[0];
        if (lastEnabled !== null && enabled !== lastEnabled) probe.log.push({ t: probe.now(), kind: 'enabled-flip', from: lastEnabled, to: enabled });
        lastEnabled = enabled;
        const first = this.choicesHost.firstElementChild;
        if (first && probe.lastFirstChoice && probe.lastFirstChoice !== first) {
          probe.rebuilds += 1;
          probe.log.push({ t: probe.now(), kind: 'rebuild', key: String(afterKey) });
        }
        if (first) probe.lastFirstChoice = first;
      }
      const choosing = this.el.classList.contains('is-choosing');
      if (choosing && !probe.choosing) {
        probe.choosing = true;
        probe.log.push({ t: probe.now(), kind: 'choosing-on' });
      } else if (!choosing && probe.choosing) {
        probe.choosing = false;
        probe.log.push({ t: probe.now(), kind: 'choosing-off' });
      }
    };
    for (const type of ['touchstart', 'touchend', 'click']) {
      document.addEventListener(
        type,
        (event) => {
          const target = event.target instanceof Element ? event.target : null;
          const choice = target?.closest?.('.event-choice');
          if (!choice && !target?.closest?.('.event-choice-area')) return;
          probe.touch.push({ t: probe.now(), type, choice: choice ? [...choice.parentElement.parentElement.children].indexOf(choice.parentElement) : null });
        },
        true,
      );
    }
  });
}

/** 1 手番ぶん進める。戻り値は「何か操作したか」。 */
async function advanceTurn(page) {
  return page.evaluate(() => {
    const game = window.__fableGame;
    const visible = (el) => Boolean(el) && !el.hidden && el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none';
    const enabled = (el) => visible(el) && !(el instanceof HTMLButtonElement && el.disabled);
    const click = (el) => {
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      el.click();
      return true;
    };
    const q = (s) => document.querySelector(s);
    // 演出中は操作できない（ボタンは「演出中…」で無効）。待つだけ。
    if (game.fxBusy || game.actionPending) return 'wait';
    const handoff = q('.handoff-start');
    if (enabled(handoff)) return click(handoff) ? 'handoff' : false;
    const endBuy = q('.city-end-buy');
    if (enabled(endBuy)) return click(endBuy) ? 'end-buy' : false;
    const shopLeave = q('.shop-leave');
    if (enabled(shopLeave)) return click(shopLeave) ? 'shop-leave' : false;
    const moveOptions = q('.move-options');
    if (visible(moveOptions)) {
      // 1 回目は行き先を選び、選んだら「ここへ移動」を押す。
      const selected = q('.move-chip.is-selected');
      if (selected) {
        const primary = q('.dice-primary');
        if (enabled(primary)) return click(primary) ? 'confirm-move' : false;
      }
      const chip = [...document.querySelectorAll('.move-chip')].find((el) => enabled(el) && !el.classList.contains('is-selected'));
      if (chip) return click(chip) ? 'move-chip' : false;
    }
    const primary = q('.dice-primary');
    if (enabled(primary)) return click(primary) ? 'primary' : false;
    // モーダル（物件シート・決算など）は「とじる/つぎへ/OK」で閉じる。
    if (q('.modal-backdrop')) {
      const btn = [...document.querySelectorAll('.modal-panel button')].find(
        (el) => enabled(el) && /とじる|閉じる|つぎへ|次へ|OK|了解|決算を確認|確認/.test(el.textContent || ''),
      );
      if (btn) return click(btn) ? 'modal-ok' : false;
      return false;
    }
    const phase = game.state?.phase?.t;
    if (phase === 'event' && game.eventPanel?.isOpen) return false;
    // それでも止まっているときは Escape で閉じる。
    return false;
  });
}

async function tapChoice(page, index) {
  const box = await page.evaluate((i) => {
    const buttons = [...document.querySelectorAll('.event-choice')];
    const el = buttons[i];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
  }, index);
  if (!box) return { ok: false, reason: 'no-button' };
  if (VIEW === 'pc') {
    await page.mouse.click(box.x, box.y);
  } else {
    await page.touchscreen.tap(box.x, box.y);
  }
  return { ok: true, ...box };
}

async function measureChoices(page) {
  return page.evaluate(() => {
    const buttons = [...document.querySelectorAll('.event-choice')];
    const opacityChain = (el) => {
      let opacity = 1;
      let node = el;
      const names = [];
      while (node && node !== document.documentElement) {
        const cs = getComputedStyle(node);
        opacity *= Number(cs.opacity || '1');
        names.push(`${node.className || node.tagName}:${cs.pointerEvents}`);
        node = node.parentElement;
      }
      return { opacity: +opacity.toFixed(2), chain: names.slice(0, 4) };
    };
    const sheet = document.querySelector('.event-choice-area');
    const shot = buttons.map((el) => {
      const r = el.getBoundingClientRect();
      const cx = Math.round(r.x + r.width / 2);
      const cy = Math.round(r.y + r.height / 2);
      const hit = document.elementFromPoint(cx, cy);
      const { opacity, chain: chainInfo } = opacityChain(el);
      return {
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        hit: hit ? String(hit.className || hit.tagName) : null,
        hitSelf: Boolean(hit) && el.contains(hit),
        opacity,
        pointerEvents: getComputedStyle(el).pointerEvents,
        chain: chainInfo,
      };
    });
    const sr = sheet?.getBoundingClientRect();
    return {
      buttons: shot,
      sheet: sr ? { top: Math.round(sr.top), bottom: Math.round(sr.bottom), h: Math.round(sr.height) } : null,
      sheetScroll: sheet ? { client: sheet.clientHeight, scroll: sheet.scrollHeight } : null,
      viewport: { w: innerWidth, h: innerHeight },
    };
  });
}

/**
 * 決め打ちシナリオ: 本番と同じ openEventPanel + setState でアンロックを作り、
 * 「選択肢が出る瞬間に指を置いていた」タップ（split touch）を再現する。
 * 戻り値: [{ id, split: boolean, normal: boolean }]
 */
async function runTapScenarios(page, n, { disableRecovery = false } = {}) {
  const ids = ['ai-bubble-again', 'tariff-war', 'city-sudden-tourist-boom', 'hell-baba-yaga-cosmetics', 'ever-given-stuck', 'meme-stock-squeeze'];
  const client = await page.context().newCDPSession(page);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const id = ids[i % ids.length];
    await page.evaluate(({ id, disableRecovery }) => {
      const game = window.__fableGame;
      if (!game.__origOpen) game.__origOpen = game.openEventPanel.bind(game);
      if (!game.__origRecover) game.__origRecover = game.eventPanel.recoverChoiceTap.bind(game.eventPanel);
      game.eventPanel.recoverChoiceTap = disableRecovery ? () => {} : game.__origRecover;
      game.openEventPanel = () => {};
      game.renderHud = () => {};
      // pickChoice を数える（強制イベントはエンジンが拒否するので chosen ではなくこれを見る）
      if (!game.__origPick) {
        game.__origPick = game.eventPanel.pickChoice.bind(game.eventPanel);
        game.eventPanel.pickChoice = function patchedPick(i) {
          window.__picks = (window.__picks ?? 0) + 1;
          window.__lastPick = i;
          return game.__origPick(i);
        };
      }
      game.eventPanel.resetChosen();
      game.state.activeEventId = id;
      game.state.phase = { t: 'event', eventId: id };
      game.__origOpen(id, game.state);
      game.eventPanel.el.hidden = false;
      // オンライン相当（earlyChoice=false）: アンロックで enabled が反転する
      game.eventPanel.setState(game.state, true, { fxPlaying: true, isMine: true, earlyChoice: false });
    }, { id, disableRecovery });
    await sleep(320);
    const box = await page.evaluate(() => {
      const game = window.__fableGame;
      game.eventPanel.setState(game.state, true, { fxPlaying: false, isMine: true, earlyChoice: false });
      const btn = document.querySelector('.event-choice');
      const r = btn?.getBoundingClientRect();
      game.eventPanel.setState(game.state, true, { fxPlaying: true, isMine: true, earlyChoice: false });
      return r ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null;
    });
    if (!box) {
      out.push({ id, split: false, normal: false, error: 'no-button' });
      continue;
    }
    await sleep(140);
    // split touch: 選択肢が出る前に指を置き、出た瞬間に離す
    await page.evaluate(() => { window.__picks = 0; });
    if (VIEW === 'pc') {
      await page.mouse.move(box.x, box.y);
      await page.mouse.down();
    } else {
      await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x, y: box.y }] });
    }
    await sleep(40);
    await page.evaluate(() => {
      const game = window.__fableGame;
      game.eventPanel.setState(game.state, true, { fxPlaying: false, isMine: true, earlyChoice: false });
    });
    await sleep(50);
    if (VIEW === 'pc') await page.mouse.up();
    else await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(350);
    const split = (await page.evaluate(() => window.__picks ?? 0)) > 0;
    // 通常タップ（アンロック後に押す）は常に通るべき対照
    await page.evaluate(() => { window.__picks = 0; window.__fableGame.eventPanel.resetChosen(); });
    const normal = await page
      .locator('.event-choice')
      .first()
      .tap({ timeout: 4000 })
      .then(() => true)
      .catch(() => false);
    await sleep(250);
    const normalHit = (await page.evaluate(() => window.__picks ?? 0)) > 0;
    out.push({ id, split, normal: normal && normalHit });
    await page.evaluate(() => {
      const game = window.__fableGame;
      game.eventPanel.resetChosen();
      game.eventPanel.el.classList.remove('is-open');
      game.eventPanel.el.hidden = true;
      game.state.activeEventId = null;
    });
    await sleep(120);
  }
  return out;
}

/** 報告 101 の確認: ステージ上でカード内タップはスキップしない／幕タップはスキップする／トーストとバナーは絵に重ならない。 */
async function runSafetyChecks(page) {
  await page.evaluate(() => {
    const game = window.__fableGame;
    if (!game.__origOpen) game.__origOpen = game.openEventPanel.bind(game);
    game.openEventPanel = () => {};
    game.renderHud = () => {};
    game.state.activeEventId = 'ai-bubble-again';
    game.state.phase = { t: 'event', eventId: 'ai-bubble-again' };
    game.__origOpen('ai-bubble-again', game.state);
    game.eventPanel.el.hidden = false;
    game.eventPanel.setState(game.state, true, { fxPlaying: true, isMine: true, earlyChoice: false });
    // 演出中と同じ状態にする（skip は fxBusy のときだけ効く）
    game.fxBusy = true;
    if (!game.__origSkip) {
      game.__origSkip = game.skipEventIntro.bind(game);
      game.skipEventIntro = function patched() {
        window.__skips = (window.__skips ?? 0) + 1;
        return game.__origSkip();
      };
    }
    window.__skips = 0;
    game.turnBanner.hidden = false;
    game.app.toasts.show('テスト通知', 'info', 4000);
  });
  await sleep(400);
  const client = await page.context().newCDPSession(page);
  const tapPoint = async (x, y) => {
    if (VIEW === 'pc') await page.mouse.click(x, y);
    else {
      await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
    await sleep(200);
  };
  const rects = await page.evaluate(() => {
    const backdropPoint = () => {
      const card = document.querySelector('.event-card')?.getBoundingClientRect();
      const sheet = document.querySelector('.event-choice-area')?.getBoundingClientRect();
      const msg = document.querySelector('.msgwin:not([hidden])')?.getBoundingClientRect();
      const gapTop = card?.bottom ?? 0;
      const gapBottom = Math.min(sheet?.top ?? innerHeight, msg?.top ?? innerHeight);
      const pts = [];
      for (let y = Math.round(gapTop) + 4; y < gapBottom - 4; y += 4) pts.push({ x: Math.round(innerWidth / 2), y });
      for (let x = 4; x < innerWidth - 4; x += 8) pts.push({ x, y: Math.round(innerHeight / 2) });
      for (const p of pts) {
        const el = document.elementFromPoint(p.x, p.y);
        if (el && el.classList.contains('event-panel')) return p;
      }
      return null;
    };
    const bd = backdropPoint();
    return { backdrop: bd };
    const r = (sel) => {
      const el = document.querySelector(sel);
      if (!el || el.hidden || getComputedStyle(el).display === 'none') return null;
      const b = el.getBoundingClientRect();
      return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
    };
    return { art: r('.event-hero'), meta: r('.event-meta-toggle'), card: r('.event-card'), toast: r('.toast'), banner: r('.turn-banner'), viewport: { w: innerWidth, h: innerHeight } };
  });
  const center = (r) => (r ? { x: r.x + Math.round(r.w / 2), y: r.y + Math.round(r.h / 2) } : null);
  const skips = [];
  const art = center(rects.art);
  if (art) await tapPoint(art.x, art.y);
  skips.push(await page.evaluate(() => window.__skips ?? 0));
  const meta = center(rects.meta);
  if (meta) await tapPoint(meta.x, meta.y);
  skips.push(await page.evaluate(() => window.__skips ?? 0));
  // 幕（カード・シート・台詞ウィンドウの外）。演出中と同じ状態を保ってから叩く。
  if (rects.backdrop) {
    await page.evaluate(() => { window.__fableGame.fxBusy = true; });
    await tapPoint(rects.backdrop.x, rects.backdrop.y);
  }
  skips.push(await page.evaluate(() => window.__skips ?? 0));
  const inter = (a, b) => (a && b ? Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)) * Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) : 0);
  const out = {
    skipsAfterArt: skips[0],
    skipsAfterMeta: skips[1],
    skipsAfterBackdrop: skips[2],
    toastVsCard: inter(rects.toast, rects.card),
    bannerVsCard: inter(rects.banner, rects.card),
    toast: rects.toast,
    banner: rects.banner,
    card: rects.card,
  };
  await page.evaluate(() => {
    const game = window.__fableGame;
    game.fxBusy = false;
    game.turnBanner.hidden = true;
    game.eventPanel.el.classList.remove('is-open');
    game.eventPanel.el.hidden = true;
    game.state.activeEventId = null;
    game.skipEventIntro = game.__origSkip;
  });
  return out;
}

/**
 * MUST-3: ソロの実経路。導入の台詞中に選択肢の位置へ指を置き、台詞を送ってから離す。
 * シートが最初から出ていれば同じボタンに click が届く。
 */
async function runSoloIntroScenario(page, n) {
  const client = await page.context().newCDPSession(page);
  const ids = ['ai-bubble-again', 'tariff-war', 'city-sudden-tourist-boom', 'ever-given-stuck', 'meme-stock-squeeze'];
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const id = ids[i % ids.length];
    await page.evaluate(({ id }) => {
      const game = window.__fableGame;
      if (!game.__origOpen) game.__origOpen = game.openEventPanel.bind(game);
      if (!game.__origPick) {
        game.__origPick = game.eventPanel.pickChoice.bind(game.eventPanel);
        game.eventPanel.pickChoice = function patchedPick(idx) {
          window.__picks = (window.__picks ?? 0) + 1;
          window.__lastPick = idx;
          return game.__origPick(idx);
        };
      }
      game.openEventPanel = () => {};
      game.renderHud = () => {};
      game.eventPanel.resetChosen();
      game.state.activeEventId = id;
      game.state.phase = { t: 'event', eventId: id };
      game.__origOpen(id, game.state);
      game.eventPanel.el.hidden = false;
      // ソロ: earlyChoice=true, 台詞中
      void game.msgWindow.show({ speaker: 'narrator', name: 'ナレーター', text: '世界の市場が、AIの夢でふくらんでいます。', speed: 1, autoAdvance: false });
      game.eventPanel.setState(game.state, true, { fxPlaying: true, isMine: true, earlyChoice: true });
      window.__picks = 0;
    }, { id });
    await sleep(360);
    const box = await page.evaluate(() => {
      const btn = document.querySelector('.event-choice');
      const r = btn?.getBoundingClientRect();
      return r ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null;
    });
    if (!box) {
      out.push({ id, picked: false, error: 'no-visible-choice-in-intro' });
      await page.evaluate(() => {
        const g = window.__fableGame;
        g.eventPanel.el.classList.remove('is-open');
        g.eventPanel.el.hidden = true;
        g.state.activeEventId = null;
      });
      continue;
    }
    // 指を置いて、台詞を送って（アンロック）、離す
    if (VIEW === 'pc') await page.mouse.move(box.x, box.y);
    else await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x, y: box.y }] });
    await sleep(60);
    await page.evaluate(() => {
      const g = window.__fableGame;
      g.msgWindow.advance?.();
      g.msgWindow.clear?.();
      g.eventPanel.setState(g.state, true, { fxPlaying: false, isMine: true, earlyChoice: true });
    });
    await sleep(60);
    if (VIEW === 'pc') await page.mouse.up();
    else await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(320);
    const pickedInfo = await page.evaluate(() => ({ picks: window.__picks ?? 0, index: window.__lastPick ?? null }));
    out.push({ id, picked: pickedInfo.picks > 0, index: pickedInfo.index });
    await page.evaluate(() => {
      const g = window.__fableGame;
      g.eventPanel.resetChosen();
      g.eventPanel.el.classList.remove('is-open');
      g.eventPanel.el.hidden = true;
      g.state.activeEventId = null;
    });
    await sleep(100);
  }
  return out;
}

/** MUST-3: 幕で押し始めて、シートの上で離しても選択しない。 */
async function runBackdropSkipCase(page, n) {
  const client = await page.context().newCDPSession(page);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    await page.evaluate(() => {
      const game = window.__fableGame;
      if (!game.__origOpen) game.__origOpen = game.openEventPanel.bind(game);
      if (!game.__origPick) {
        game.__origPick = game.eventPanel.pickChoice.bind(game.eventPanel);
        game.eventPanel.pickChoice = function patchedPick(idx) {
          window.__picks = (window.__picks ?? 0) + 1;
          window.__lastPick = idx;
          return game.__origPick(idx);
        };
      }
      if (!game.__skipWrapped) {
        const inner = game.skipEventIntro.bind(game);
        game.skipEventIntro = function patchedSkip() {
          window.__skips = (window.__skips ?? 0) + 1;
          return inner();
        };
        game.__skipWrapped = true;
      }
      game.openEventPanel = () => {};
      game.renderHud = () => {};
      game.eventPanel.resetChosen();
      game.state.activeEventId = 'ai-bubble-again';
      game.state.phase = { t: 'event', eventId: 'ai-bubble-again' };
      game.__origOpen('ai-bubble-again', game.state);
      game.eventPanel.el.hidden = false;
      game.eventPanel.setState(game.state, true, { fxPlaying: true, isMine: true, earlyChoice: true });
      game.fxBusy = true;
      window.__picks = 0;
      window.__skips = 0;
    });
    await sleep(320);
    const pts = await page.evaluate(() => {
    const backdropPoint = () => {
      const card = document.querySelector('.event-card')?.getBoundingClientRect();
      const sheet = document.querySelector('.event-choice-area')?.getBoundingClientRect();
      const msg = document.querySelector('.msgwin:not([hidden])')?.getBoundingClientRect();
      const gapTop = card?.bottom ?? 0;
      const gapBottom = Math.min(sheet?.top ?? innerHeight, msg?.top ?? innerHeight);
      const pts = [];
      for (let y = Math.round(gapTop) + 4; y < gapBottom - 4; y += 4) pts.push({ x: Math.round(innerWidth / 2), y });
      for (let x = 4; x < innerWidth - 4; x += 8) pts.push({ x, y: Math.round(innerHeight / 2) });
      for (const p of pts) {
        const el = document.elementFromPoint(p.x, p.y);
        if (el && el.classList.contains('event-panel')) return p;
      }
      return null;
    };
      const btn = document.querySelector('.event-choice')?.getBoundingClientRect();
      const from = backdropPoint();
      if (!btn || !from) return null;
      return { from, to: { x: Math.round(btn.x + btn.width / 2), y: Math.round(btn.y + btn.height / 2) } };
    });
    if (!pts) {
      out.push({ picked: false, skipped: false, error: 'no-sheet' });
      continue;
    }
    await page.evaluate(() => { window.__fableGame.fxBusy = true; });
    if (VIEW === 'pc') {
      await page.mouse.move(pts.from.x, pts.from.y);
      await page.mouse.down();
      await page.mouse.move(pts.to.x, pts.to.y, { steps: 4 });
      await page.mouse.up();
    } else {
      await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pts.from.x, y: pts.from.y }] });
      await sleep(40);
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: pts.to.x, y: pts.to.y }] });
      await sleep(40);
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
    await sleep(400);
    const st = await page.evaluate((from) => ({
      picks: window.__picks ?? 0,
      skips: window.__skips ?? 0,
      target: (() => { const el = document.elementFromPoint(from.x, from.y); return el ? String(el.className || el.tagName) : null; })(),
    }), pts.from);
    out.push({ picked: st.picks > 0, skipped: st.skips > 0, from: pts.from, to: pts.to, target: st.target });
    await page.evaluate(() => {
      const game = window.__fableGame;
      game.fxBusy = false;
      game.eventPanel.resetChosen();
      game.eventPanel.el.classList.remove('is-open');
      game.eventPanel.el.hidden = true;
      game.state.activeEventId = null;
    });
    await sleep(100);
  }
  return out;
}

async function run() {
  await mkdir(OUT, { recursive: true });
  const server = await startDevServer();
  const browser = await chromium.launch({ headless: true, args: ['--mute-audio'] });
  try {
    const context = await browser.newContext(
      VIEW === 'pc'
        ? { viewport: { width: 1280, height: 720 } }
        : {
            viewport: { width: 390, height: 844 },
            deviceScaleFactor: 3,
            isMobile: true,
            hasTouch: true,
            userAgent:
              'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
          },
    );
    const page = await context.newPage();
    page.on('pageerror', (e) => report.errors.push(String(e.message).slice(0, 200)));
    await startSoloGame(page);
    await installInstrumentation(page);

    const startedAt = Date.now();
    let current = null;
    let stalls = 0;
    let lastPhase = '';
    let lastChange = Date.now();
    while (report.events.length < MAX_EVENTS && Date.now() - startedAt < 9 * 60_000) {
      const snapshot = await page.evaluate(() => {
        const game = window.__fableGame;
        const s = game?.state;
        const panel = game?.eventPanel;
        return {
          phase: s?.phase?.t ?? null,
          eventId: s?.activeEventId ?? null,
          open: Boolean(panel?.isOpen),
          choosing: Boolean(panel?.el?.classList.contains('is-choosing')),
          chosen: Boolean(panel?.chosen),
          choiceCount: document.querySelectorAll('.event-choice').length,
          fxBusy: Boolean(game?.fxBusy),
          busy: Boolean(game?.eventPanel?.isOpen && document.querySelector('.msgwin:not([hidden])')),
          probe: { rebuilds: window.__probe?.rebuilds ?? 0, keyFlips: window.__probe?.keyFlips ?? 0, log: (window.__probe?.log ?? []).slice(-12) },
        };
      });
      const stamp = `${snapshot.phase}|${snapshot.eventId}|${snapshot.open}|${snapshot.choosing}`;
      if (stamp !== lastPhase) {
        lastPhase = stamp;
        lastChange = Date.now();
        stalls = 0;
      }
      if (snapshot.open && snapshot.eventId) {
        if (current === null) {
          current = { id: snapshot.eventId, openedAt: Date.now(), rebuildsAtOpen: snapshot.probe.rebuilds, log: [] };
        }
        if (snapshot.choosing && !current.tapped) {
          // 選択肢が出た瞬間。スクショと幾何を記録してから実タップ。
          current.choosingAt = Date.now();
          current.unlockAfterMs = current.choosingAt - current.openedAt;
          current.sheet = await measureChoices(page);
          current.log = snapshot.probe.log;
          await page.screenshot({ path: path.join(OUT, `${String(report.events.length + 1).padStart(2, '0')}-${current.id}-unlock.png`) });
          current.touchLogStart = await page.evaluate(() => (window.__probe?.touch ?? []).length);
          const tap = await tapChoice(page, 0);
          current.tap = tap;
          current.duringIntro = await page.evaluate(() => Boolean(window.__fableGame?.fxBusy));
          current.tapped = true;
          // 成否: chosen になる（markChosen）か、イベントが閉じる。
          const deadline = Date.now() + 2500;
          let ok = false;
          while (Date.now() < deadline) {
            const st = await page.evaluate(() => ({
              chosen: Boolean(window.__fableGame?.eventPanel?.chosen),
              eventId: window.__fableGame?.state?.activeEventId ?? null,
            }));
            if (st.chosen || st.eventId !== current.id) {
              ok = true;
              break;
            }
            await sleep(80);
          }
          current.success = ok;
          current.touchLog = await page.evaluate((from) => (window.__probe?.touch ?? []).slice(from), current.touchLogStart);
          if (!ok) {
            current.failureShot = `fail-${report.events.length + 1}-${current.id}.png`;
            await page.screenshot({ path: path.join(OUT, current.failureShot) });
            report.failures.push({ id: current.id, sheet: current.sheet, tap: current.tap, touchLog: current.touchLog });
          }
          report.events.push({
            id: current.id,
            unlockAfterMs: current.unlockAfterMs,
            rebuildsDuringEvent: (await page.evaluate(() => window.__probe?.rebuilds ?? 0)) - current.rebuildsAtOpen,
            sheet: current.sheet,
            tap: current.tap,
            duringIntro: current.duringIntro,
            success: current.success,
            log: current.log,
          });
          console.log(
            `${ok ? 'OK  ' : 'FAIL'} event#${report.events.length} ${current.id} unlock=${current.unlockAfterMs}ms rebuilds+${report.events.length ? '' : ''}`,
            JSON.stringify({ hit: current.sheet.buttons.map((b) => b.hitSelf), op: current.sheet.buttons.map((b) => b.opacity) }),
          );
          current = null;
        }
        await sleep(120);
        continue;
      }
      if (current) current = null;
      if (!snapshot.fxBusy && Date.now() - lastChange > 12_000) {
        stalls += 1;
        await page.keyboard.press('Escape').catch(() => undefined);
        await page.keyboard.press('Space').catch(() => undefined);
        console.log(`stall ${stalls} at phase=${snapshot.phase}`);
        if (stalls >= 4) {
          report.errors.push(`stalled at ${snapshot.phase}`);
          break;
        }
        lastChange = Date.now();
      }
      const acted = await advanceTurn(page);
      if (acted) report.driverActions = [...(report.driverActions ?? []).slice(-40), acted];
      else report.idle = (report.idle ?? 0) + 1;
      await sleep(acted ? 260 : 200);
    }
    report.scenarios = await runTapScenarios(page, SCENARIOS, { disableRecovery: NO_RECOVERY });
    // シナリオの前に、開いているモーダル（売り場・物件シート）を閉じる。
    for (let i = 0; i < 4; i += 1) {
      const open = await page.evaluate(() => Boolean(document.querySelector('.modal-backdrop')));
      if (!open) break;
      await page.keyboard.press('Escape').catch(() => undefined);
      await sleep(150);
    }
    if (SAFETY) report.safety = await runSafetyChecks(page);
    report.soloIntro = await runSoloIntroScenario(page, Number(args.get('solo') ?? 10));
    report.backdropSkip = await runBackdropSkipCase(page, Number(args.get('backdrop') ?? 5));
    report.totalMs = Date.now() - startedAt;
    report.counts = {
      events: report.events.length,
      successes: report.events.filter((e) => e.success).length,
      failures: report.failures.length,
      scenarios: report.scenarios.length,
      soloPicked: report.soloIntro?.filter((x) => x.picked).length ?? 0,
      soloTotal: report.soloIntro?.length ?? 0,
      backdropPicked: report.backdropSkip?.filter((x) => x.picked).length ?? 0,
      backdropTotal: report.backdropSkip?.length ?? 0,
      splitOk: report.scenarios.filter((s) => s.split).length,
      normalOk: report.scenarios.filter((s) => s.normal).length,
    };
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }
  await writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
  console.log('RESULT', JSON.stringify(report.counts), 'errors', report.errors.length);
  console.log('report', path.join(OUT, 'report.json'));
}

await run();