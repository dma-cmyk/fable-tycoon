// 魔法のじゅうたん等の都市ターゲットピッカーが、実タップで全候補を選べるかを測る。
//
//   node tests/e2e/warp-picker-tap-probe.mjs [--profile=xperia|375|390|pc] [--port=5284]
//
// - 一覧: 候補ごとに、タッチスワイプ（PC はマウスホイール）でリストへ入れてから実タップ。
// - 地図: 「📍 地図の都市をタップして選ぶ」で city-pick に入り、候補の画面座標をタップ。
//   画面外・HUD に覆われた候補は、その場では選べないものとして記録する。
// - ブラウザは 1 スタックだけ、headless / muted。VOICEVOX は使わない。
//
// 出力: .tmp/e2e/report104/<PROBE_DIR>/*.png と report.json（既定 sendback1）
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, '.tmp/e2e/report104', process.env.PROBE_DIR ?? 'sendback1');
const args = new Map(
  process.argv
    .filter((arg) => arg.startsWith('--') && arg.includes('='))
    .map((arg) => [arg.slice(2, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]),
);
const PORT = Number(args.get('port') ?? 5284);
const BASE = `http://127.0.0.1:${PORT}`;
const ONLY = args.get('profile') ?? null;

const PROFILES = [
  // ユーザー実機: SO-53C (Xperia Ace III) / Android Chrome / 360x748 CSS / DPR 2
  { id: 'xperia', width: 360, height: 748, dpr: 2, touch: true },
  { id: '375', width: 375, height: 667, dpr: 2, touch: true },
  { id: '390', width: 390, height: 844, dpr: 3, touch: true },
  { id: 'pc', width: 1280, height: 720, dpr: 1, touch: false },
].filter((profile) => !ONLY || profile.id === ONLY);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, { timeout = 30000, interval = 150, label = 'condition' } = {}) {
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

async function startDevServer() {
  const child = spawn(
    process.execPath,
    ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort', '--config', '.tmp/e2e/vite-nohmr.config.mjs'],
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
    { timeout: 60000, label: 'vite dev server' },
  );
  return child;
}

async function openGame(page) {
  await page.goto(`${BASE}/?speed=8`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /ひとりで/ }).click({ timeout: 30000 });
  await page.locator('.setup-start:visible, .setup-mobile-start:visible').first().click({ timeout: 30000 });
  await page.waitForFunction(() => window.__fableGame?.mapReady === true, null, { timeout: 120000 });
  // サービスワーカー更新などで読み込み直ると __fableGame が一瞬消える。復帰を待つ。
  await page
    .waitForFunction(() => !!window.__fableGame?.app && window.__fableGame?.mapReady === true, null, { timeout: 30000 })
    .catch(async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__fableGame?.mapReady === true, null, { timeout: 120000 });
    });
  await page.waitForFunction(() => window.__fableGame?.fxBusy !== true, null, { timeout: 60000 }).catch(() => undefined);
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const game = window.__fableGame;
    game?.app?.modal?.closeAll?.();
    game?.eventPanel?.hide?.();
    game?.msgWindow?.clear?.();
  });
}

/** じゅうたんの候補（目的地から 5〜10 マス）が最多になる目的地を作る。 */
async function pickCarpetScenario(page) {
  return page.evaluate(async () => {
    const { GAME_DATA } = await import('/src/data/index.ts');
    const graph = await import('/src/core/graph.ts');
    const worldCities = GAME_DATA.cities.filter((city) => city.realm === undefined);
    let best = null;
    for (const city of worldCities) {
      const destNode = graph.nodeForCity(GAME_DATA, city.id);
      const options = worldCities
        .map((other) => {
          const node = graph.nodeForCity(GAME_DATA, other.id);
          const distance = graph.shortestDistance(GAME_DATA, destNode, node);
          return { node, distance };
        })
        .filter((entry) => Number.isFinite(entry.distance) && entry.distance >= 5 && entry.distance <= 10)
        .map((entry) => entry.node)
        .sort();
      if (!best || options.length > best.options.length) best = { destination: city.id, options };
      if (options.length >= 12) break;
    }
    return best;
  });
}

/** 都市ターゲットを作り直し、本番と同じ経路でピッカーを開く。 */
async function stageCarpet(page, scenario, cardId = 'carpet') {
  return page.evaluate((spec) => {
    const game = window.__fableGame;
    const fake = structuredClone(game.state);
    fake.current = 0;
    fake.destination = spec.destination;
    fake.phase = { t: 'card_target', cardId: spec.cardId, options: spec.options };
    fake.activeEventId = null;
    fake.pendingTurnStart = false;
    game.fxBusy = false;
    game.actionPending = false;
    game.cityPick = null;
    game.state = fake;
    game.map?.setState(fake);
    if (!window.__patchedSend) {
      window.__patchedSend = true;
      window.__origSend = game.sendAction.bind(game);
      game.sendAction = (action) => {
        if (action?.t === 'card_target') {
          window.__pickResult = action.target;
          return;
        }
        window.__origSend(action);
      };
    }
    window.__pickResult = null;
    game.updateTransientDialog(fake, true);
    return { destination: spec.destination, count: spec.options.length };
  }, { ...scenario, cardId });
}

async function listMetrics(page) {
  return page.evaluate(() => {
    const list = document.querySelector('.target-list');
    if (!list) return null;
    const r = list.getBoundingClientRect();
    let scroller = list;
    let node = list;
    while (node && node !== document.documentElement) {
      const cs = getComputedStyle(node);
      if (/(auto|scroll)/.test(cs.overflowY) && node.scrollHeight > node.clientHeight + 2) {
        scroller = node;
        break;
      }
      node = node.parentElement;
    }
    const sr = scroller.getBoundingClientRect();
    const rows = [...list.querySelectorAll(':scope > .target-item')];
    const visTop = Math.max(r.top, 0);
    const visBottom = Math.min(r.bottom, window.innerHeight);
    const fullRows = rows.filter((row) => {
      const rr = row.getBoundingClientRect();
      return rr.top >= visTop - 1 && rr.bottom <= visBottom - 1;
    }).length;
    const initialTops = rows.slice(0, 6).map((row) => {
      const rr = row.getBoundingClientRect();
      return [Math.round(rr.top), Math.round(rr.bottom)];
    });
    const firstRow = rows[0]?.getBoundingClientRect();
    return {
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      height: Math.round(r.height),
      clientHeight: list.clientHeight,
      scrollHeight: list.scrollHeight,
      overflowY: getComputedStyle(list).overflowY,
      visibleSlice: Math.round(visBottom - visTop),
      fullRows,
      initialTops,
      rowHeight: firstRow ? Math.round(firstRow.height) : null,
      scroller: {
        cls: String(scroller.className || scroller.tagName).slice(0, 50),
        top: Math.round(sr.top),
        bottom: Math.round(sr.bottom),
        clientHeight: scroller.clientHeight,
        scrollHeight: scroller.scrollHeight,
        scrollTop: scroller.scrollTop,
      },
    };
  });
}

let cdp = null;
async function touchDrag(page, fromX, fromY, toY, steps = 10) {
  const client = cdp ?? (cdp = await page.context().newCDPSession(page));
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: fromX, y: fromY }] });
  for (let i = 1; i <= steps; i += 1) {
    const y = fromY + ((toY - fromY) * i) / steps;
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: fromX, y }] });
    await sleep(16);
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(110);
}

/** 実効スクロール容器（リスト自身 or modal-body）を実タッチで最下部まで運べるか。 */
async function touchScrollListToEnd(page) {
  const start = await listMetrics(page);
  if (!start) return { ok: false, reason: 'list-missing' };
  const box = await page.evaluate(() => {
    const list = document.querySelector('.target-list');
    let scroller = list;
    let node = list;
    while (node && node !== document.documentElement) {
      const cs = getComputedStyle(node);
      if (/(auto|scroll)/.test(cs.overflowY) && node.scrollHeight > node.clientHeight + 2) {
        scroller = node;
        break;
      }
      node = node.parentElement;
    }
    const r = scroller.getBoundingClientRect();
    const top = Math.max(r.top, 0);
    const bottom = Math.min(r.bottom, window.innerHeight);
    return {
      x: Math.round(r.x + r.width / 2),
      fromY: Math.round(bottom - 30),
      toY: Math.round(top + 30),
      top,
      bottom,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
    };
  });
  if (box.scrollHeight <= box.clientHeight + 2) {
    return { ok: true, needed: false, start, end: start, scroller: start.scroller };
  }
  if (box.bottom - box.top < 80) return { ok: false, reason: 'scroller-not-visible', start, box };
  const samples = [];
  for (let i = 0; i < 80; i += 1) {
    await touchDrag(page, box.x, box.fromY, box.toY, 8);
    const current = await listMetrics(page);
    samples.push(current?.scroller?.scrollTop ?? null);
    if (current && current.scroller.scrollTop + current.scroller.clientHeight >= current.scroller.scrollHeight - 4) {
      return { ok: true, needed: true, start, end: current, swipes: i + 1, samples };
    }
  }
  return { ok: false, reason: 'swipe-end-not-reached', start, end: await listMetrics(page), samples };
}

/** 行を実効スクロール容器の中央へ寄せる。 */
async function bringRowIntoView(page, node, touch) {
  void touch;
  const state = await page.evaluate((targetNode) => {
    const list = document.querySelector('.target-list');
    const row = list?.querySelector(`.target-item[data-node="${CSS.escape(targetNode)}"]`);
    if (!list || !row) return null;
    let scroller = list;
    let node2 = list;
    while (node2 && node2 !== document.documentElement) {
      const cs = getComputedStyle(node2);
      if (/(auto|scroll)/.test(cs.overflowY) && node2.scrollHeight > node2.clientHeight + 2) {
        scroller = node2;
        break;
      }
      node2 = node2.parentElement;
    }
    const sr = scroller.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    const offset = rr.top - sr.top + scroller.scrollTop;
    scroller.scrollTop = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, offset - scroller.clientHeight * 0.42));
    return { scrollTop: scroller.scrollTop, cls: String(scroller.className).slice(0, 40) };
  }, node);
  await sleep(60);
  return { ok: true, ...state };
}

async function rowInfo(page, node) {
  return page.evaluate((targetNode) => {
    const list = document.querySelector('.target-list');
    const row = list?.querySelector(`.target-item[data-node="${CSS.escape(targetNode)}"]`);
    if (!list || !row) return { node: targetNode, found: false };
    const lr = list.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    const cx = Math.round(rr.x + rr.width / 2);
    const cy = Math.round(rr.y + rr.height / 2);
    const hit = document.elementFromPoint(cx, cy);
    const cs = getComputedStyle(row);
    return {
      node: targetNode,
      found: true,
      label: row.textContent.replace(/\s+/g, ' ').trim().slice(0, 36),
      cx,
      cy,
      rect: { top: Math.round(rr.top), bottom: Math.round(rr.bottom), h: Math.round(rr.height) },
      list: { top: Math.round(lr.top), bottom: Math.round(lr.bottom), h: Math.round(lr.height) },
      fullyInList: rr.top >= lr.top + 2 && rr.bottom <= lr.bottom - 2,
      fullyInViewport: rr.top >= 0 && rr.bottom <= window.innerHeight,
      hitOwn: !!hit && (row === hit || row.contains(hit)),
      hit: hit ? `${hit.tagName}.${String(hit.className).slice(0, 40)}` : null,
      disabled: row.disabled,
      pointerEvents: cs.pointerEvents,
      display: cs.display,
    };
  }, node);
}

async function testRows(page, nodes, touch) {
  const results = [];
  for (const node of nodes) {
    const scroll = await bringRowIntoView(page, node, touch);
    const info = await rowInfo(page, node);
    let picked = null;
    if (info.found && info.fullyInViewport && info.hitOwn && !info.disabled) {
      await page.evaluate(() => {
        window.__pickResult = null;
      });
      if (touch) await page.touchscreen.tap(info.cx, info.cy);
      else await page.mouse.click(info.cx, info.cy);
      await page.waitForTimeout(120);
      picked = await page.evaluate(() => window.__pickResult);
      await page.evaluate((targetNode) => {
        const list = document.querySelector('.target-list');
        const row = list?.querySelector(`.target-item[data-node="${CSS.escape(targetNode)}"]`);
        if (row) {
          row.disabled = false;
          row.classList.remove('is-busy');
        }
        window.__pickResult = null;
      }, node);
    }
    results.push({ ...info, scroll, picked, ok: picked === node });
  }
  return results;
}

async function stageMapPick(page, scenario) {
  await page.waitForFunction(() => !!window.__fableGame?.app, null, { timeout: 15000 });
  await page.evaluate((spec) => {
    const game = window.__fableGame;
    game.app.modal.closeAll();
    const fake = structuredClone(game.state);
    fake.current = 0;
    fake.destination = spec.destination;
    fake.phase = { t: 'card_target', cardId: 'carpet', options: spec.options };
    fake.activeEventId = null;
    fake.pendingTurnStart = false;
    game.state = fake;
    game.map?.setState(fake);
    game.cityPick = null;
    game.suppressMapTapUntil = 0;
    if (!window.__patchedCityPick) {
      window.__patchedCityPick = true;
      window.__origClearCityPick = game.clearCityPick.bind(game);
      game.clearCityPick = () => {
        window.__pickCleared = true;
      };
    }
    window.__pickResult = null;
    window.__pickCleared = false;
    game.updateTransientDialog(fake, true);
  }, scenario);
  await page.waitForSelector('.warp-target-modal');
  const btn = page.locator('.warp-target-modal .target-map-btn');
  if (await btn.count()) {
    if (await btn.first().isVisible()) {
      await btn.first().click();
      await page.waitForTimeout(500);
    }
  }
  return page.evaluate(() => {
    const game = window.__fableGame;
    const canvas = document.querySelector('.game-screen canvas');
    const rect = canvas?.getBoundingClientRect();
    const banner = document.querySelector('.city-pick-banner');
    const bannerRect = banner?.getBoundingClientRect();
    const toasts = [...document.querySelectorAll('.toast')]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter((entry) => entry.r.width > 2 && entry.r.height > 2)
      .map((entry) => ({ text: entry.el.textContent.trim().slice(0, 40), top: Math.round(entry.r.top), bottom: Math.round(entry.r.bottom) }));
    const bannerOverlap = bannerRect
      ? toasts.filter((toast) => toast.bottom > bannerRect.top && toast.top < bannerRect.bottom)
      : [];
    return {
      cityPick: game.cityPick ? { count: game.cityPick.options.size } : null,
      canvas: rect ? { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) } : null,
      banner: bannerRect ? { hidden: banner.hidden, top: Math.round(bannerRect.top), bottom: Math.round(bannerRect.bottom), text: banner.textContent.trim().slice(0, 60) } : null,
      markers: document.querySelectorAll('.city-pick-marker').length,
      markersVisible: [...document.querySelectorAll('.city-pick-marker')].filter((el) => el.style.display !== 'none').length,
      toasts,
      bannerOverlap,
    };
  });
}

/** リング中心の実タップが、そのリングの候補を選ぶか（intended vs selected）。 */
async function ringTapResults(page, touch) {
  const rings = await page.evaluate(() =>
    [...document.querySelectorAll('.city-pick-marker')]
      .filter((el) => el.style.display !== 'none' && el.getBoundingClientRect().width > 0)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { node: el.dataset.node, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), size: Math.round(r.width) };
      }),
  );
  const out = [];
  for (const ring of rings) {
    const cover = await page.evaluate(({ x, y }) => {
      const hit = document.elementFromPoint(x, y);
      return { onCanvas: !!hit && hit.tagName === 'CANVAS', hit: hit ? `${hit.tagName}.${String(hit.className).slice(0, 32)}` : null };
    }, ring);
    if (!cover.onCanvas) {
      out.push({ ...ring, ok: false, failure: 'covered', hit: cover.hit });
      continue;
    }
    await page.evaluate(() => {
      window.__pickResult = null;
    });
    if (touch) await page.touchscreen.tap(ring.x, ring.y);
    else await page.mouse.click(ring.x, ring.y);
    await page.waitForTimeout(130);
    const picked = await page.evaluate(() => window.__pickResult);
    out.push({ ...ring, picked, ok: picked === ring.node, failure: picked === ring.node ? null : 'wrong-city' });
  }
  return out;
}

/** 2 本指のピンチで地図を広げる（広げた後のリング中心タップも測る）。 */
async function pinchZoom(page, cx, cy, from, to) {
  const client = cdp ?? (cdp = await page.context().newCDPSession(page));
  const points = (d) => [{ x: cx - d, y: cy }, { x: cx + d, y: cy }];
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(from) });
  for (let i = 1; i <= 8; i += 1) {
    const d = from + ((to - from) * i) / 8;
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(d) });
    await sleep(16);
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(500);
}

async function testMapCandidates(page, nodes, offset, touch) {
  const results = [];
  for (const node of nodes) {
    const info = await page.evaluate(({ targetNode, offX, offY }) => {
      const game = window.__fableGame;
      const map = game.map;
      const pos = map?.screenPositionOfNode(targetNode);
      if (!pos) return { node: targetNode, failure: 'no-position' };
      const x = offX + pos.x;
      const y = offY + pos.y;
      const inViewport = x > 2 && x < window.innerWidth - 2 && y > 2 && y < window.innerHeight - 2;
      const hit = inViewport ? document.elementFromPoint(Math.round(x), Math.round(y)) : null;
      return {
        node: targetNode,
        x: Math.round(x),
        y: Math.round(y),
        inViewport,
        hit: hit ? `${hit.tagName}.${String(hit.className).slice(0, 40)}` : null,
        onCanvas: !!hit && hit.tagName === 'CANVAS',
      };
    }, { targetNode: node, offX: offset.x, offY: offset.y });
    let target = info.inViewport && info.onCanvas ? { x: info.x, y: info.y } : null;
    if (!target) {
      // 画面外・HUD 下は一度中央へ寄せ、中央ならタップできるかも測る。
      const focused = await page.evaluate(async (targetNode) => {
        const game = window.__fableGame;
        await game.map?.focusNode(targetNode, { ms: 0 });
        await new Promise((resolve) => setTimeout(resolve, 140));
        const canvas = document.querySelector('.game-screen canvas');
        const rect = canvas?.getBoundingClientRect();
        const pos = game.map?.screenPositionOfNode(targetNode);
        if (!pos || !rect) return null;
        const x = rect.x + pos.x;
        const y = rect.y + pos.y;
        const hit = document.elementFromPoint(Math.round(x), Math.round(y));
        return {
          x: Math.round(x),
          y: Math.round(y),
          hit: hit ? `${hit.tagName}.${String(hit.className).slice(0, 40)}` : null,
          onCanvas: !!hit && hit.tagName === 'CANVAS',
        };
      }, node);
      info.focused = focused;
      if (focused?.onCanvas) target = { x: focused.x, y: focused.y };
    }
    if (target) {
      await page.evaluate(() => {
        window.__pickResult = null;
      });
      if (touch) await page.touchscreen.tap(target.x, target.y);
      else await page.mouse.click(target.x, target.y);
      await page.waitForTimeout(140);
      info.picked = await page.evaluate(() => window.__pickResult);
      info.ok = info.picked === node;
      if (!info.ok) {
        // 座標の近くに別の候補がいる場合（重なり）を記録。
        info.nearestHit = await page.evaluate(({ targetNode, x, y }) => {
          const game = window.__fableGame;
          const candidates = [...(game.cityPick?.options ?? [])];
          const canvas = document.querySelector('.game-screen canvas');
          const rect = canvas?.getBoundingClientRect();
          if (!rect) return null;
          const near = candidates
            .map((candidate) => {
              const pos = game.map?.screenPositionOfNode(candidate);
              return pos ? { candidate, d: Math.round(Math.hypot(rect.x + pos.x - x, rect.y + pos.y - y)) } : null;
            })
            .filter(Boolean)
            .sort((a, b) => a.d - b.d)[0];
          return { targetNode, nearest: near?.candidate ?? null, distance: near?.d ?? null };
        }, { targetNode: node, x: target.x, y: target.y });
      }
    } else {
      info.ok = false;
      info.failure = info.inViewport ? 'covered-or-offcanvas' : 'offscreen-and-focus-failed';
    }
    results.push(info);
  }
  return results;
}

await mkdir(OUT, { recursive: true });
const report = [];
const server = await startDevServer();
const browser = await chromium.launch({ headless: true, args: ['--mute-audio'] });
try {
  for (const profile of PROFILES) {
    const tag = profile.id;
    const context = await browser.newContext({
      viewport: { width: profile.width, height: profile.height },
      deviceScaleFactor: profile.dpr,
      isMobile: profile.touch,
      hasTouch: profile.touch,
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo',
    });
    const page = await context.newPage();
    cdp = null;
    page.setDefaultTimeout(30000);
    page.on('pageerror', (error) => console.error(`[${tag}] pageerror:`, error.message));
    await openGame(page);
    const scenario = await pickCarpetScenario(page);
    const staged = await stageCarpet(page, scenario);
    await page.waitForSelector('.warp-target-modal');
    await sleep(300);
    await page.screenshot({ path: path.join(OUT, `${tag}-carpet-list-top.png`) });
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll('.target-item-city')].map((el) => el.dataset.node),
    );
    const metrics = await listMetrics(page);
    const touchScroll = profile.touch ? await touchScrollListToEnd(page) : { ok: true, needed: false };
    await page.evaluate(() => {
      const list = document.querySelector('.target-list');
      if (list) list.scrollTop = 0;
    });
    await sleep(120);
    const rowResults = await testRows(page, rows, profile.touch);
    await page.evaluate(() => {
      const list = document.querySelector('.target-list');
      if (list) list.scrollTop = list.scrollHeight;
    });
    await sleep(200);
    await page.screenshot({ path: path.join(OUT, `${tag}-carpet-list-bottom.png`) });

    const mapStaged = await stageMapPick(page, scenario);
    await page.screenshot({ path: path.join(OUT, `${tag}-carpet-map-pick.png`) });
    const zoomBefore = await page.evaluate(() => window.__fableGame.map?.captureCameraState().zoom ?? null);
    const ringsBefore = await ringTapResults(page, profile.touch);
    let ringsAfter = null;
    let zoomAfter = zoomBefore;
    if (profile.touch) {
      // 密集地（最寄り候補との距離が最小のリング）を中心にピンチする。
      const hotspot = await page.evaluate(() => {
        const rings = [...document.querySelectorAll('.city-pick-marker')]
          .filter((el) => el.style.display !== 'none')
          .map((el) => {
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          });
        let best = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
        let bestGap = Infinity;
        for (const a of rings) {
          let nearest = Infinity;
          for (const b of rings) {
            if (a === b) continue;
            nearest = Math.min(nearest, Math.hypot(a.x - b.x, a.y - b.y));
          }
          if (nearest < bestGap) {
            bestGap = nearest;
            best = a;
          }
        }
        return { x: Math.round(best.x), y: Math.round(best.y) };
      });
      await pinchZoom(page, hotspot.x, hotspot.y, 40, 72);
      zoomAfter = await page.evaluate(() => window.__fableGame.map?.captureCameraState().zoom ?? null);
      await page.screenshot({ path: path.join(OUT, `${tag}-carpet-map-pick-zoomed.png`) });
      ringsAfter = await ringTapResults(page, profile.touch);
    }
    const mapResults = await testMapCandidates(page, scenario.options, mapStaged.canvas ?? { x: 0, y: 0 }, profile.touch);

    // 同じダイアログを共有する飛行機（352 都市）でも、リストが有限高で実タッチスクロールできるか。
    let otherPickers = null;
    if (profile.id === 'xperia') {
      const allCities = await page.evaluate(async () => {
        const { GAME_DATA } = await import('/src/data/index.ts');
        return GAME_DATA.cities
          .filter((city) => city.realm === undefined)
          .map((city) => `c:${city.id}`)
          .sort();
      });
      await page.evaluate(() => window.__fableGame.app.modal.closeAll());
      await stageCarpet(page, { destination: scenario.destination, options: allCities }, 'pegasus');
      await page.waitForSelector('.warp-target-modal');
      const pegasusMetrics = await listMetrics(page);
      const pegasusBox = await page.evaluate(() => {
        const list = document.querySelector('.target-list');
        const r = list.getBoundingClientRect();
        return {
          x: Math.round(r.x + r.width / 2),
          fromY: Math.round(Math.min(r.bottom, window.innerHeight) - 30),
          toY: Math.round(Math.max(r.top, 0) + 30),
        };
      });
      const pegasusTop = await page.evaluate(() => document.querySelector('.target-list').scrollTop);
      for (let i = 0; i < 3; i += 1) await touchDrag(page, pegasusBox.x, pegasusBox.fromY, pegasusBox.toY, 8);
      const pegasusScrollTop = await page.evaluate(() => document.querySelector('.target-list').scrollTop);
      otherPickers = {
        card: 'pegasus',
        count: allCities.length,
        metrics: pegasusMetrics,
        touchScroll: {
          ok: pegasusScrollTop > pegasusTop + 100,
          needed: pegasusMetrics ? pegasusMetrics.scrollHeight > pegasusMetrics.clientHeight + 2 : null,
          from: pegasusTop,
          to: pegasusScrollTop,
          swipes: 3,
        },
      };
      console.log(`[${tag}] pegasus`, JSON.stringify(otherPickers));
    }

    const failedRows = rowResults.filter((entry) => !entry.ok);
    const failedMap = mapResults.filter((entry) => !entry.ok);
    report.push({
      profile: { ...profile },
      destination: staged.destination,
      candidates: staged.count,
      listMetrics: metrics,
      touchScroll,
      rows: rowResults,
      failedRows: failedRows.map((entry) => ({
        node: entry.node,
        failure: entry.hitOwn ? (entry.disabled ? 'disabled' : 'tap-not-registered') : 'covered-or-clipped',
        hit: entry.hit,
        rect: entry.rect,
        list: entry.list,
        scroll: entry.scroll,
        picked: entry.picked,
      })),
      mapStaged,
      ringTaps: {
        zoomBefore,
        zoomAfter,
        before: ringsBefore,
        after: ringsAfter,
        wrongBefore: ringsBefore.filter((entry) => !entry.ok).length,
        wrongAfter: ringsAfter ? ringsAfter.filter((entry) => !entry.ok).length : null,
      },
      mapResults,
      otherPickers,
      failedMap: failedMap.map((entry) => ({
        node: entry.node,
        failure: entry.failure ?? 'tap-not-registered',
        inViewport: entry.inViewport,
        hit: entry.hit,
        picked: entry.picked,
        nearestHit: entry.nearestHit,
        focused: entry.focused,
      })),
    });
    console.log(`[${tag}] list ${rows.length - failedRows.length}/${rows.length} ok, map ${mapResults.length - failedMap.length}/${mapResults.length} ok`);
    if (metrics) console.log(`[${tag}] list metrics`, JSON.stringify(metrics));
    console.log(`[${tag}] touch-scroll`, JSON.stringify({ ok: touchScroll.ok, needed: touchScroll.needed, swipes: touchScroll.swipes, start: touchScroll.start?.scrollTop, end: touchScroll.end?.scrollTop }));
    if (failedRows.length) console.log(`[${tag}] row failures`, JSON.stringify(report.at(-1).failedRows.slice(0, 8)));
    if (failedMap.length) console.log(`[${tag}] map failures`, JSON.stringify(report.at(-1).failedMap.slice(0, 8)));
    await context.close();
  }
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
await writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log('wrote', path.join(OUT, 'report.json'));
