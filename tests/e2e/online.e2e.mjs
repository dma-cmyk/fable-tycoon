// End-to-end online play across four real browser processes.
//
//   Chromium 1280x720 (authoritative host) / WebKit iPhone 13 (touch) /
//   Firefox desktop / Chromium Pixel 7 (touch)
//
// This is intentionally NOT a vitest file: it builds `dist`, serves it with
// `vite preview`, opens four independent browser processes, and plays a full
// 1-year game through the real UI while exercising chat, emotes, a targeted
// poke, a mid-game Firefox tab close/reopen, and a mid-game host kill.
//
// Run: npm run e2e:online
// Artifacts: .tmp/e2e/*.png and .tmp/e2e/report.json

import { chromium, firefox, webkit, devices } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, '.tmp/e2e');
const PORT = Number(process.env.E2E_PORT || 5195);
const BASE = `http://127.0.0.1:${PORT}`;
const HEADFUL = process.env.E2E_HEADFUL === '1';
const SPEED = process.env.E2E_SPEED || (HEADFUL ? '4' : '8');
const SLOWMO = Number(process.env.E2E_SLOWMO || (HEADFUL ? 150 : 0));
const SKIP_BUILD = process.env.E2E_SKIP_BUILD === '1';
const RUN_LABEL = (process.env.E2E_RUN_LABEL || 'run').replace(/[^A-Za-z0-9_-]/g, '') || 'run';
const SCENARIO = process.env.E2E_SCENARIO || (process.env.E2E_CLIENTS ? 'subset' : 'full');
const CPU_GAP = process.env.E2E_CPU_GAP === '1';
const SKIP_HOST_KILL = process.env.E2E_SKIP_HOST_KILL === '1';
/** `0` disables auto-skip so a stall is measured instead of bypassed. */
const SKIP_AFTER_MS_RAW = (process.env.E2E_SKIP_AFTER_MS ?? '').trim();
const SKIP_AFTER_MS = SKIP_AFTER_MS_RAW === '' ? 15_000 : Math.max(0, Number(SKIP_AFTER_MS_RAW));
if (!Number.isFinite(SKIP_AFTER_MS)) {
  throw new Error(`E2E_SKIP_AFTER_MS must be a non-negative number (got "${process.env.E2E_SKIP_AFTER_MS}")`);
}
const RESULT_TIMEOUT_MS = Number(process.env.E2E_RESULT_TIMEOUT_MS || 12 * 60 * 1000);
const MIGRATION_TIMEOUT_MS = Number(process.env.E2E_MIGRATION_TIMEOUT_MS || 45 * 1000);
/**
 * Mobile emulation DPR: `native` (default) uses the real device descriptor
 * (iPhone 13: 3, Pixel 7: 2.625). `1` forces deviceScaleFactor 1, which is a
 * temporary workaround for the map canvas over-allocation crash.
 */
const MOBILE_DPR_RAW = (process.env.E2E_MOBILE_DPR || 'native').toLowerCase();
const MOBILE_DPR = MOBILE_DPR_RAW === '1' ? 1 : MOBILE_DPR_RAW === 'native' ? 'native' : null;
if (MOBILE_DPR === null) {
  throw new Error(`E2E_MOBILE_DPR must be "native" or "1" (got "${process.env.E2E_MOBILE_DPR}")`);
}

const HOST_NAME = 'HostChrome';
const WEBKIT_NAME = 'WebKitPhone';
const FIREFOX_NAME = 'Firefox';
const PIXEL_NAME = 'PixelChrome';

const startAt = Date.now();
const timings = {};
const screenshots = [];
const phaseLog = [];
let report = {
  ok: false,
  command: 'npm run e2e:online',
  startedAt: new Date(startAt).toISOString(),
  base: BASE,
  runLabel: RUN_LABEL,
  scenario: SCENARIO,
  cpuGap: CPU_GAP,
  headful: HEADFUL,
  speed: SPEED,
  mobileDpr: MOBILE_DPR,
  phases: phaseLog,
  clients: [],
  screenshots,
  errors: { pageErrors: [], consoleErrors: [], ignorableConsole: [], canvasLimitWarnings: 0 },
};

function nowMs() {
  return Date.now() - startAt;
}

function log(...args) {
  console.log(`[e2e +${String(nowMs()).padStart(6)}ms]`, ...args);
}

function phase(name, detail = {}) {
  const entry = { phase: name, atMs: nowMs(), ...detail };
  phaseLog.push(entry);
  log(name, Object.keys(detail).length ? JSON.stringify(detail) : '');
  return entry;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, { timeout = 30_000, interval = 200, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }
  throw new Error(
    `timeout waiting for ${label}${lastError ? ` (last error: ${lastError.message})` : ''}`,
  );
}

async function fileExists(file) {
  return existsSync(file);
}

// ---------------------------------------------------------------- preview server

function viteBin() {
  return path.join(ROOT, 'node_modules/vite/bin/vite.js');
}

function runVite(args, label) {
  const started = Date.now();
  log(`${label}: node vite ${args.join(' ')}`);
  execFileSync(process.execPath, [viteBin(), ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  return Date.now() - started;
}

async function startPreview() {
  const child = spawn(
    process.execPath,
    [viteBin(), 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FORCE_COLOR: '0' } },
  );
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += String(chunk);
  });
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });
  await waitFor(
    async () => {
      if (exited) throw new Error(`vite preview exited early:\n${output}`);
      try {
        const response = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(1000) });
        return response.ok;
      } catch {
        return false;
      }
    },
    { timeout: 30_000, interval: 250, label: 'vite preview' },
  );
  log(`preview ready on ${BASE}`);
  return child;
}

async function stopPreview(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(3000).then(() => child.kill('SIGKILL')),
  ]);
}

// ---------------------------------------------------------------- WebKit deps (Arch)

// Playwright's WebKit bundle is built against Ubuntu 24.04 (libicu74/libxml2).
// Arch ships newer sonames, so we cache the Ubuntu libraries under .tmp/e2e/weblibs
// and inject them through LD_PRELOAD. This is machine setup, not game code.
const WEBKIT_DEB_URLS = {
  icu: 'http://mirrors.kernel.org/ubuntu/pool/main/i/icu/libicu74_74.2-1ubuntu3_amd64.deb',
  xml: 'http://security.ubuntu.com/ubuntu/pool/main/libx/libxml2/libxml2_2.9.14+dfsg-1.3ubuntu3.10_amd64.deb',
};

async function prepareWebkitLibs() {
  if (process.platform !== 'linux') return null;
  const flat = path.join(OUT, 'weblibs');
  const wanted = ['libicudata.so.74', 'libicui18n.so.74', 'libicuuc.so.74', 'libxml2.so.2'];
  if (wanted.every((name) => existsSync(path.join(flat, name)))) {
    return wanted.map((name) => path.join(flat, name)).join(':');
  }
  await mkdir(flat, { recursive: true });
  await mkdir(path.join(OUT, 'webkit-debs'), { recursive: true });
  try {
    for (const [key, url] of Object.entries(WEBKIT_DEB_URLS)) {
      const deb = path.join(OUT, 'webkit-debs', `${key}.deb`);
      if (!existsSync(deb)) {
        log(`downloading WebKit dependency ${key} for Arch fallback`);
        const response = await fetch(url);
        if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
        await writeFile(deb, Buffer.from(await response.arrayBuffer()));
      }
      const dir = path.join(OUT, 'webkit-debs', key);
      await mkdir(dir, { recursive: true });
      execFileSync('bsdtar', ['-xf', deb, '-C', dir], { stdio: 'ignore' });
      const dataName = (await readdir(dir)).find((name) => name.startsWith('data.tar.'));
      if (!dataName) throw new Error(`no data.tar in ${deb}`);
      execFileSync('bsdtar', ['-xf', path.join(dir, dataName), '-C', dir], { stdio: 'ignore' });
    }
    const sources = {
      'libicudata.so.74': path.join(OUT, 'webkit-debs/icu/usr/lib/x86_64-linux-gnu/libicudata.so.74'),
      'libicui18n.so.74': path.join(OUT, 'webkit-debs/icu/usr/lib/x86_64-linux-gnu/libicui18n.so.74'),
      'libicuuc.so.74': path.join(OUT, 'webkit-debs/icu/usr/lib/x86_64-linux-gnu/libicuuc.so.74'),
      'libxml2.so.2': path.join(OUT, 'webkit-debs/xml/usr/lib/x86_64-linux-gnu/libxml2.so.2'),
    };
    for (const [name, source] of Object.entries(sources)) {
      const response = await readFile(source);
      await writeFile(path.join(flat, name), response);
    }
    return wanted.map((name) => path.join(flat, name)).join(':');
  } catch (error) {
    log(`WARN: could not prepare WebKit fallback libraries: ${error.message}`);
    return null;
  }
}

// ---------------------------------------------------------------- clients

const specs = [
  {
    id: 'host-chromium',
    label: 'Chromium desktop 1280x720 (host)',
    name: HOST_NAME,
    browserType: chromium,
    touch: false,
    context: { viewport: { width: 1280, height: 720 } },
    role: 'host',
  },
  {
    id: 'webkit-iphone',
    label: 'WebKit iPhone 13',
    name: WEBKIT_NAME,
    browserType: webkit,
    touch: true,
    context: mobileContext('iPhone 13'),
    role: 'guest',
  },
  {
    id: 'firefox-desktop',
    label: 'Firefox desktop 1280x720',
    name: FIREFOX_NAME,
    browserType: firefox,
    touch: false,
    context: { viewport: { width: 1280, height: 720 } },
    role: 'guest',
  },
  {
    id: 'chromium-pixel',
    label: 'Chromium Pixel 7',
    name: PIXEL_NAME,
    browserType: chromium,
    touch: true,
    context: mobileContext('Pixel 7'),
    role: 'guest',
  },
];

/** Device descriptor as-is, unless E2E_MOBILE_DPR=1 forces DPR 1. */
function mobileContext(deviceName) {
  const base = { ...devices[deviceName] };
  if (MOBILE_DPR === 'native') return base;
  return { ...base, deviceScaleFactor: MOBILE_DPR };
}

const CLIENT_FILTER = (process.env.E2E_CLIENTS || '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);
const selectedSpecs = CLIENT_FILTER.length
  ? specs.filter((spec) => CLIENT_FILTER.includes(spec.id) || spec.role === 'host')
  : specs;

const BENIGN_PATTERNS = [
  /WebSocket connection to .* failed/i,
  /\bMQTT\b/i,
  /\bmqtt\b/i,
  /ws:\/\/|wss:\/\//,
  /broker\.emqx\.io|broker\.hivemq\.com|test\.mosquitto\.org/i,
  /net::ERR_(NAME_NOT_RESOLVED|CONNECTION_REFUSED|CONNECTION_RESET|TIMED_OUT)/i,
  /NotAllowedError|AudioContext|play\(\) request was interrupted|The operation was aborted/i,
  /ICE failed|WebRTC/i,
  /downloadable font: download failed|font.*download failed/i,
  /favicon/i,
];

function classifyError(error, benign) {
  const text = `${error.text || ''} ${error.location || ''}`;
  return benign.some((pattern) => pattern.test(text));
}

function attachErrorCollectors(client) {
  const page = client.page;
  page.on('crash', () => {
    client.crashed = true;
    client.pageCrashes = client.pageCrashes || [];
    client.pageCrashes.push({ atMs: nowMs(), url: page.url() });
    log(`${client.id} renderer crashed at ${page.url()}`);
    void recoverClient(client).catch((error) => {
      log(`${client.id} crash recovery failed: ${error.message}`);
      client.recoveryError = error.message;
    });
  });
  page.on('pageerror', (error) => {
    const entry = {
      client: client.id,
      text: error.stack || error.message || String(error),
      atMs: nowMs(),
    };
    client.pageErrors.push(entry);
    report.errors.pageErrors.push(entry);
  });
  page.on('console', (message) => {
    if (/Canvas area exceeds/i.test(message.text())) {
      client.canvasLimitWarnings = (client.canvasLimitWarnings || 0) + 1;
      report.errors.canvasLimitWarnings += 1;
    }
    if (/通信待ち/.test(message.text())) {
      client.commWaitSignals = (client.commWaitSignals || 0) + 1;
      report.commWaitSignals = (report.commWaitSignals || 0) + 1;
    }
    if (message.type() === 'error') {
      const entry = {
        client: client.id,
        text: message.text(),
        location: message.location()?.url || '',
        atMs: nowMs(),
      };
      if (classifyError(entry, BENIGN_PATTERNS)) {
        client.ignorableConsole.push(entry);
        report.errors.ignorableConsole.push(entry);
      } else {
        client.consoleErrors.push(entry);
        report.errors.consoleErrors.push(entry);
      }
      return;
    }
    if (message.type() === 'warning') {
      client.warnings.push({ text: message.text().slice(0, 300), atMs: nowMs() });
      if (client.warnings.length > 120) client.warnings.shift();
    }
  });
}

async function newPage(client) {
  const context = client.context;
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  page.setDefaultNavigationTimeout(35_000);
  client.page = page;
  attachErrorCollectors(client);
  return page;
}

async function launchClient(spec, webkitPreload) {
  const client = {
    ...spec,
    browser: null,
    context: null,
    page: null,
    seat: null,
    character: null,
    paused: false,
    stopped: false,
    pageErrors: [],
    pageCrashes: [],
    consoleErrors: [],
    ignorableConsole: [],
    warnings: [],
    canvasLimitWarnings: 0,
    maxModals: 0,
    maxModalsNonActor: 0,
    screenshots: [],
    transports: [],
    result: null,
    cityOpen: false,
    cityVisit: 0,
    cityBought: false,
  };
  const windowLayout = {
    'host-chromium': { position: '0,0', size: '960,540' },
    'chromium-pixel': { position: '980,560', size: '430,900' },
  };
  const layout = windowLayout[spec.id];
  const launchOptions = { headless: !HEADFUL, slowMo: SLOWMO };
  if (spec.browserType === chromium) {
    launchOptions.args = [
      '--mute-audio',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      // This workstation runs ~6 GB of other apps; keep four headless
      // browsers inside the remaining headroom so the kernel OOM killer does
      // not take down the authoritative host mid-game.
      '--js-flags=--max-old-space-size=768',
      '--renderer-process-limit=2',
    ];
    if (HEADFUL && layout) {
      launchOptions.args.push(
        `--window-position=${layout.position}`,
        `--window-size=${layout.size}`,
      );
    }
  }
  if (spec.browserType === firefox) {
    launchOptions.firefoxUserPrefs = {
      'media.volume_scale': '0.0',
      'media.autoplay.default': 5,
      // Keep the four-browser run inside this workstation's RAM headroom.
      'javascript.options.mem.max': 768 * 1024,
    };
    if (HEADFUL) launchOptions.args = ['-width', '960', '-height', '540'];
  }
  if (spec.id === 'webkit-iphone') {
    launchOptions.env = {
      ...process.env,
      LD_PRELOAD: webkitPreload || '',
      // No audio sink at all for WebKit's WPE process.
      PULSE_SERVER: 'unix:/nonexistent',
    };
  }
  client.browser = await spec.browserType.launch(launchOptions);
  client.context = await client.browser.newContext({
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    reducedMotion: 'reduce',
    ...spec.context,
  });
  await client.context.addInitScript(() => {
    window.__e2eCopied = null;
    try {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text) => {
            window.__e2eCopied = String(text);
          },
        },
      });
    } catch {
      /* ignore */
    }
    // Report (once per canvas/property) when code allocates a canvas close to
    // WebKit/Chromium's max area, so a renderer crash has a precise cause.
    try {
      const proto = HTMLCanvasElement.prototype;
      for (const prop of ['width', 'height']) {
        const descriptor = Object.getOwnPropertyDescriptor(proto, prop);
        if (!descriptor?.set) continue;
        Object.defineProperty(proto, prop, {
          configurable: true,
          get() {
            return descriptor.get.call(this);
          },
          set(value) {
            try {
              const other = prop === 'width' ? this.height : this.width;
              const area = Number(value) * Number(other);
              if (area > 64_000_000 || Number(value) > 16_384) {
                this.__e2eCanvasLogged = this.__e2eCanvasLogged || {};
                if (!this.__e2eCanvasLogged[prop]) {
                  this.__e2eCanvasLogged[prop] = true;
                  console.warn(
                    `[canvas-oversize] ${prop}=${value} other=${other} area=${area} class=${this.className} id=${this.id} stack=${(new Error()).stack?.split('\n').slice(1, 5).join(' | ')}`,
                  );
                }
              }
            } catch {
              /* instrumentation only */
            }
            return descriptor.set.call(this, value);
          },
        });
      }
    } catch {
      /* ignore */
    }
  });
  await newPage(client);
  report.clients.push({
    id: client.id,
    label: client.label,
    name: client.name,
    role: client.role,
    seat: null,
    character: null,
    transports: [],
    result: null,
    screenshots: client.screenshots,
    pageErrors: client.pageErrors,
    pageCrashes: client.pageCrashes,
    consoleErrors: client.consoleErrors,
    ignorableConsole: client.ignorableConsole,
    warnings: client.warnings,
  });
  return client;
}

async function press(client, locator) {
  const target = locator.first();
  await target.waitFor({ state: 'attached', timeout: 12_000 });
  await target.scrollIntoViewIfNeeded().catch(() => undefined);
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // The lobby is re-rendered on every presence/lobby message, so an element
      // can be detached between actionability checks. `force` skips stability
      // waiting and still dispatches a real pointer event at the element.
      if (client.touch) {
        await target.tap({ timeout: 5000, force: true });
      } else {
        await target.click({ timeout: 5000, force: true });
      }
      return;
    } catch (error) {
      lastError = error;
      await sleep(120);
    }
  }
  // Last resort for a detached/rebuilt node: click the current match directly.
  const clicked = await target
    .evaluate((element) => {
      if (!(element instanceof HTMLElement)) return false;
      element.click();
      return true;
    })
    .catch(() => false);
  if (clicked) return;
  throw lastError;
}

async function domClick(locator) {
  const target = locator.first();
  await target.waitFor({ state: 'attached', timeout: 12_000 });
  const clicked = await target
    .evaluate((element) => {
      if (!(element instanceof HTMLElement)) return false;
      element.click();
      return true;
    })
    .catch(() => false);
  if (!clicked) throw new Error('DOM click failed: element not clickable');
}

async function isVisible(locator) {
  try {
    if ((await locator.count()) === 0) return false;
    return await locator.first().isVisible();
  } catch {
    return false;
  }
}

async function screenshot(client, name, { optional = false } = {}) {
  const page = client.page;
  if (!page || page.isClosed()) {
    if (optional) return null;
    throw new Error(`cannot screenshot closed page for ${client.id}`);
  }
  const file = path.join(OUT, `${RUN_LABEL}-${name}.png`);
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await page.screenshot({
        path: file,
        animations: 'disabled',
        scale: 'css',
        timeout: 15_000,
      });
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      await sleep(400);
    }
  }
  if (lastError) {
    if (optional) return null;
    throw lastError;
  }
  screenshots.push(file);
  client.screenshots.push(file);
  log(`screenshot ${path.relative(ROOT, file)}`);
  return file;
}

let liveScreenshotTimer = null;

async function captureLiveScreenshots() {
  for (const client of clients) {
    if (client.stopped || client.paused || !client.page || client.page.isClosed()) continue;
    const file = path.join(OUT, `live-${client.id}.png`);
    await client.page
      .screenshot({ path: file, animations: 'disabled', scale: 'css', timeout: 8000 })
      .catch(() => undefined);
  }
}

function startLiveScreenshots() {
  if (liveScreenshotTimer !== null) return;
  void captureLiveScreenshots();
  liveScreenshotTimer = setInterval(() => {
    void captureLiveScreenshots();
  }, 30_000);
}

function stopLiveScreenshots() {
  if (liveScreenshotTimer !== null) {
    clearInterval(liveScreenshotTimer);
    liveScreenshotTimer = null;
  }
}

async function sampleModalDepth(client) {
  const page = client.page;
  if (!page || page.isClosed() || client.stopped) return;
  const sample = await page
    .evaluate(() => {
      const visibleModals = [...document.querySelectorAll('.modal-backdrop')].filter((el) => {
        if (el.hidden) return false;
        const style = getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden';
      }).length;
      const status = (document.querySelector('.status-chip')?.textContent || '').trim();
      const banner = (document.querySelector('.game-banner')?.textContent || '').trim();
      return { visibleModals, status, banner };
    })
    .catch(() => null);
  if (!sample) return;
  client.modalSamples = (client.modalSamples || 0) + 1;
  if (/通信待ち/.test(sample.banner) || /通信待ち/.test(sample.status)) {
    client.commWaitUi = (client.commWaitUi || 0) + 1;
    report.commWaitUi = (report.commWaitUi || 0) + 1;
  }
  if (sample.visibleModals > (client.maxModals || 0)) client.maxModals = sample.visibleModals;
  // status-chip shows "あなたの番" only for the acting client; anything else
  // ("<name> の番", "観戦中") means this client is a non-actor right now.
  const isActorTurn = /あなたの番/.test(sample.status);
  if (!isActorTurn && sample.visibleModals > (client.maxModalsNonActor || 0)) {
    client.maxModalsNonActor = sample.visibleModals;
    if (sample.visibleModals > 1) {
      log(`${client.id}: ${sample.visibleModals} stacked modals while not acting (${sample.status || 'no status'})`);
    }
  }
}

async function pageDiagnostics(client) {
  const page = client.page;
  if (!page || page.isClosed()) return { closed: true };
  return page
    .evaluate(() => {
      const text = (selector) => {
        const el = document.querySelector(selector);
        if (!el || el.hidden) return null;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return null;
        return (el.textContent || '').trim().slice(0, 300);
      };
      return {
        url: location.href,
        title: document.title,
        year: text('.game-year-chip'),
        turn: text('.game-turn-chip, .game-topbar .chip:nth-child(2)'),
        status: text('.status-chip'),
        primary: text('.dice-primary'),
        primaryDisabled: document.querySelector('.dice-primary')?.disabled ?? null,
        moveChips: document.querySelectorAll('.move-options .move-chip').length,
        moveOptionsHidden: document.querySelector('.move-options')?.hidden ?? null,
        selectedMove: document.querySelectorAll('.move-chip.is-selected').length,
        modals: [...document.querySelectorAll('.modal-backdrop')].map((el) => ({
          visible: !el.hidden && getComputedStyle(el).display !== 'none',
          text: (el.textContent || '').trim().slice(0, 240),
        })),
        banners: [...document.querySelectorAll('.game-banner,.conn-banner,.migrate-banner')]
          .filter((el) => !el.hidden && getComputedStyle(el).display !== 'none')
          .map((el) => ({ cls: el.className, text: (el.textContent || '').trim().slice(0, 200) })),
        resultVisible: !!document.querySelector('.result-screen'),
        rankRows: document.querySelectorAll('.rank-row').length,
        chatTail: [...document.querySelectorAll('.chat-text,.chat-system')]
          .slice(-8)
          .map((el) => (el.textContent || '').trim()),
      };
    })
    .catch((error) => ({ error: error.message }));
}

// ---------------------------------------------------------------- lobby / UI flow

async function openOnlineEntry(client) {
  const page = client.page;
  await page.goto(`${BASE}/?speed=${SPEED}`, { waitUntil: 'domcontentloaded' });
  await waitFor(
    () => isVisible(page.locator('.title-screen, .title-menu-btn')),
    { timeout: 35_000, label: `${client.id} title screen` },
  );
  const online = page
    .locator('.title-menu-btn')
    .filter({ hasText: 'オンライン' })
    .first();
  if (!(await isVisible(online))) {
    await press(client, page.getByRole('button', { name: /オンライン/ }).first());
  } else {
    await press(client, online);
  }
  await waitFor(() => isVisible(page.locator('.online-screen')), {
    timeout: 20_000,
    label: `${client.id} online entry`,
  });
  const nameInput = page
    .locator('.online-name-field input, input[aria-label="プレイヤー名"]')
    .first();
  await nameInput.fill(client.name);
}

async function readInviteFromLobby(client) {
  const page = client.page;
  await waitFor(() => isVisible(page.locator('.lobby-room-code')), {
    timeout: 35_000,
    label: `${client.id} lobby room code`,
  });
  const roomCode = ((await page.locator('.lobby-room-code').first().textContent()) || '')
    .replace(/\s+/g, '')
    .trim();
  if (!/^[A-Z0-9-]{6,16}$/.test(roomCode)) {
    throw new Error(`unexpected room code "${roomCode}" from lobby`);
  }
  let inviteUrl = null;
  const copyButton = page.getByRole('button', { name: /招待URL/ }).first();
  if (await isVisible(copyButton)) {
    await copyButton.click({ timeout: 8_000 }).catch(() => undefined);
    inviteUrl = await page
      .waitForFunction(() => window.__e2eCopied, null, { timeout: 3000 })
      .then((handle) => handle.jsonValue())
      .catch(() => null);
  }
  if (inviteUrl) {
    // The invite must carry the host-key prefix; guests pin it on load. A URL
    // without `k` would silently downgrade the check to TOFU.
    try {
      const parsed = new URL(inviteUrl);
      const room = (parsed.searchParams.get('room') || '').replace(/\s+/g, '');
      if (room !== roomCode) {
        throw new Error(`invite room "${room}" does not match lobby code "${roomCode}"`);
      }
      if (!/^[0-9a-f]{16}$/i.test(parsed.searchParams.get('k') || '')) {
        throw new Error(`invite URL is missing a 16-hex host key: ${inviteUrl}`);
      }
    } catch (error) {
      throw new Error(`unusable invite URL from lobby: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!inviteUrl) {
    // Clipboard unavailable in this browser: rebuild the URL from the lobby's
    // visible host-check code so the invite still pins the host key.
    const checkCode = ((await page.locator('.lobby-host-key').first().textContent().catch(() => '')) || '')
      .replace(/[^0-9a-f]/gi, '')
      .slice(0, 16);
    const query = new URLSearchParams({ room: roomCode });
    if (/^[0-9a-f]{16}$/i.test(checkCode)) query.set('k', checkCode.toLowerCase());
    inviteUrl = `${BASE}/?${query.toString()}`;
  }
  return { roomCode, inviteUrl: withSpeed(inviteUrl) };
}

function withSpeed(url) {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('speed', SPEED);
    return parsed.toString();
  } catch {
    return `${url}${url.includes('?') ? '&' : '?'}speed=${SPEED}`;
  }
}

async function ensureSeated(client, inviteUrl = null) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const page = client.page;
    if (await isVisible(page.locator('.lobby-seat.is-self'))) {
      client.seat = Number(await page.locator('.lobby-seat.is-self').first().getAttribute('data-seat'));
      return;
    }
    if (await isVisible(page.locator('.conn-banner'))) {
      // A heartbeat can paint the lobby while the guest is still reconnecting.
      await waitFor(() => !isVisible(page.locator('.conn-banner')), {
        timeout: 12_000,
        interval: 300,
        label: `${client.id} lobby connection open`,
      }).catch(() => undefined);
    }
    if (await isVisible(page.locator('.lobby-seat.is-self'))) {
      client.seat = Number(await page.locator('.lobby-seat.is-self').first().getAttribute('data-seat'));
      return;
    }
    const seatButton = page.getByRole('button', { name: '座る', exact: true }).first();
    if (await isVisible(seatButton)) {
      await domClick(seatButton).catch((error) => {
        lastError = error;
      });
    }
    try {
      await waitFor(() => isVisible(page.locator('.lobby-seat.is-self')), {
        timeout: 15_000,
        label: `${client.id} seat`,
      });
      client.seat = Number(await page.locator('.lobby-seat.is-self').first().getAttribute('data-seat'));
      log(`${client.id} seated at ${client.seat}`);
      return;
    } catch (error) {
      lastError = error;
      if (!inviteUrl) break;
      log(`${client.id} seat attempt ${attempt + 1} failed; re-entering the room`);
      await joinGuest(client, inviteUrl);
    }
  }
  throw new Error(`${client.id} could not take a seat: ${lastError?.message || 'unknown'}`);
}

async function addCpuSeat(host) {
  const openSeat = host.page.locator('.lobby-seat-open').first();
  if ((await openSeat.count()) === 0) return false;
  const openBefore = await host.page.locator('.lobby-seat-open').count();
  const cpuButton = openSeat
    .locator('button')
    .filter({ hasText: /CPU Lv2/ })
    .first();
  if (!(await isVisible(cpuButton))) {
    throw new Error('CPU seat button not found in an open lobby seat');
  }
  await domClick(cpuButton);
  await waitFor(async () => (await host.page.locator('.lobby-seat-open').count()) < openBefore, {
    timeout: 8000,
    label: 'CPU seat filled',
  }).catch(() => undefined);
  await sleep(500);
  return true;
}

async function fillCpuSeats(host, humanCount) {
  const openCount = await host.page.locator('.lobby-seat-open').count();
  const wanted = Math.min(Math.max(0, 4 - humanCount), openCount);
  log(`filling ${wanted} CPU seat(s) for ${humanCount} human(s)`);
  for (let attempt = 0; attempt < wanted; attempt += 1) {
    if (!(await addCpuSeat(host))) break;
  }
  const remaining = await host.page.locator('.lobby-seat-open').count();
  if (remaining > 0) throw new Error(`${remaining} open seat(s) remain after adding CPUs`);
}

async function pickCharacter(client) {
  const page = client.page;
  const own = page.locator('.lobby-seat.is-self').first();
  const charText = async () => {
    try {
      return ((await own.locator('.lobby-seat-character').first().textContent()) || '').trim();
    } catch {
      return '';
    }
  };
  if ((await charText()) && !/未選択|おまかせ/.test(await charText())) return;
  const pickButton = own
    .locator('button')
    .filter({ hasText: /キャラクター/ })
    .first();
  const pickerOpen = isVisible(page.locator('.char-picker-modal'));
  if (!(await pickerOpen) && !(await isVisible(pickButton))) {
    throw new Error(`${client.id}: character pick button not found`);
  }
  if (!(await pickerOpen)) {
    await domClick(pickButton);
  }
  await waitFor(
    () => isVisible(page.locator('.char-picker-modal .char-card, .char-card')),
    { timeout: 15_000, label: `${client.id} character picker` },
  );
  const card = page.locator('.char-card:not([disabled])').first();
  await domClick(card);
  const confirm = page.locator('.char-picker-modal .char-confirm:not([disabled])').first();
  await waitFor(
    async () => isVisible(confirm),
    { timeout: 5_000, label: `${client.id} character confirm` },
  );
  await domClick(confirm);
  await waitFor(
    async () => {
      const text = await charText();
      return !!text && !/未選択|おまかせ/.test(text);
    },
    { timeout: 15_000, label: `${client.id} character selected` },
  );
  client.character = await charText();
  log(`${client.id} character: ${client.character}`);
}

async function submitJoin(client) {
  const page = client.page;
  const joinButton = page
    .locator('.online-panel:not([hidden]) .online-main-btn')
    .filter({ hasText: /参加/ })
    .first();
  if (!(await isVisible(joinButton))) {
    // The panel button's only child is aria-hidden, so role-name lookup is empty.
    const anyJoin = page.locator('.online-main-btn').filter({ hasText: /参加/ }).first();
    await press(client, anyJoin);
    return;
  }
  await press(client, joinButton);
}

/**
 * The room-exists probe has a 5-second budget. On a cold WebKit/mobile WSS
 * connection the probe can lose that race even though the room exists, so a
 * real user retries 参加する. Mirror that behavior and record the retry.
 */
async function joinAndWait(client, expected, inviteUrl = null) {
  const page = client.page;
  let lastFeedback = '';
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    if (attempt > 1 && inviteUrl) {
      // A half-open transport can leave the UI showing a lobby fed only by
      // heartbeats. Reloading gives the guest a clean MQTT/WebRTC connection.
      await page.goto(inviteUrl, { waitUntil: 'domcontentloaded' });
      await waitFor(() => isVisible(page.locator('.online-screen')), {
        timeout: 25_000,
        label: `${client.id} join retry entry`,
      });
      await page
        .locator('.online-name-field input, input[aria-label="プレイヤー名"]')
        .first()
        .fill(client.name);
    }
    const feedbackBefore = (
      (await page.locator('.online-feedback').textContent().catch(() => '')) || ''
    ).trim();
    await submitJoin(client);
    let outcome;
    try {
      outcome = await waitFor(
        async () => {
          const lobbyVisible = await isVisible(page.locator('.lobby-room-code'));
          if (lobbyVisible) {
            if (expected === 'game') return false; // wait for the snapshot that enters the game
            // A heartbeat can paint the lobby before `welcome`; keep waiting until
            // the reconnect banner clears so the host has actually accepted us.
            if (await isVisible(page.locator('.conn-banner'))) return false;
            return 'lobby';
          }
          if (await isVisible(page.locator('.game-screen'))) return 'game';
          const feedback = ((await page.locator('.online-feedback').textContent().catch(() => '')) || '').trim();
          if (
            feedback &&
            feedback !== feedbackBefore &&
            /入れません|見つかりません|作成できません/.test(feedback)
          ) {
            lastFeedback = feedback;
            return 'error';
          }
          return false;
        },
        { timeout: 25_000, interval: 200, label: `${client.id} join outcome` },
      );
    } catch (error) {
      lastFeedback = `connection timed out (${error.message})`;
      log(`${client.id} join attempt ${attempt} timed out`);
      await sleep(Math.min(12_000, 1500 * attempt));
      continue;
    }
    if (outcome === expected) {
      if (attempt > 1) log(`${client.id} joined on attempt ${attempt} (cold probe retry)`);
      return;
    }
    log(`${client.id} join attempt ${attempt} failed: ${lastFeedback || outcome}`);
    await sleep(Math.min(12_000, 1500 * attempt));
  }
  throw new Error(`${client.id} failed to join after retries: ${lastFeedback}`);
}

async function joinGuest(client, inviteUrl) {
  const page = client.page;
  await page.goto(inviteUrl, { waitUntil: 'domcontentloaded' });
  await waitFor(() => isVisible(page.locator('.online-screen')), {
    timeout: 35_000,
    label: `${client.id} join entry`,
  });
  const nameInput = page
    .locator('.online-name-field input, input[aria-label="プレイヤー名"]')
    .first();
  await nameInput.fill(client.name);
  await joinAndWait(client, 'lobby', inviteUrl);
}

async function ensureResumedSeat(client, inviteUrl) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const restored = await waitFor(
      async () => (await client.page.locator('.rank-row.is-mine').count()) === 1,
      { timeout: 15_000, interval: 250, label: `${client.id} resume seat` },
    )
      .then(() => true)
      .catch(() => false);
    if (restored) return;
    log(`${client.id} rejoined as spectator; reloading the invite URL (attempt ${attempt + 1})`);
    await client.page.goto(inviteUrl, { waitUntil: 'domcontentloaded' });
    await waitFor(() => isVisible(client.page.locator('.online-screen')), {
      timeout: 25_000,
      label: `${client.id} rejoin retry entry`,
    });
    await client.page
      .locator('.online-name-field input, input[aria-label="プレイヤー名"]')
      .first()
      .fill(client.name);
    await joinAndWait(client, 'game', inviteUrl);
  }
  throw new Error(`${client.id} could not reclaim its seat after reopening`);
}

async function recoverClient(client) {
  if (client.recovering) return client.recovering;
  if (client.role !== 'guest' || !client.inviteUrl) {
    throw new Error(`${client.id}: no recoverable invite URL`);
  }
  client.paused = true;
  client.recovering = (async () => {
    log(`${client.id} recovering after renderer crash`);
    await client.page?.close().catch(() => undefined);
    await newPage(client);
    await client.page.goto(client.inviteUrl, { waitUntil: 'domcontentloaded' });
    await waitFor(() => isVisible(client.page.locator('.online-screen')), {
      timeout: 25_000,
      label: `${client.id} crash rejoin entry`,
    });
    await client.page
      .locator('.online-name-field input, input[aria-label="プレイヤー名"]')
      .first()
      .fill(client.name);
    await joinAndWait(client, 'game', client.inviteUrl);
    await waitFor(() => isVisible(client.page.locator('.game-screen')), {
      timeout: 30_000,
      label: `${client.id} crash rejoin game`,
    });
    await ensureResumedSeat(client, client.inviteUrl);
    client.crashed = false;
    log(`${client.id} recovered its seat after the crash`);
  })().finally(() => {
    client.paused = false;
    client.recovering = null;
  });
  return client.recovering;
}

async function openChat(client) {
  const page = client.page;
  if (!(await isVisible(page.locator('.chat-panel.is-open')))) {
    try {
      await press(client, page.locator('.chat-fab').first());
    } catch (error) {
      // The opening panel can intercept the same click that opened it on WebKit.
      if (!(await isVisible(page.locator('.chat-panel.is-open')))) throw error;
    }
    await waitFor(() => isVisible(page.locator('.chat-panel.is-open')), {
      timeout: 8000,
      label: `${client.id} chat panel`,
    });
  }
}

async function closeChat(client) {
  const page = client.page;
  const close = page.locator('.chat-close').first();
  if (await isVisible(close)) await close.click({ timeout: 5000 }).catch(() => undefined);
}

async function openEmoteTab(client, tabName) {
  const page = client.page;
  if (!(await isVisible(page.locator('.emote-palette.is-open')))) {
    try {
      await press(client, page.locator('.emote-fab').first());
    } catch (error) {
      if (!(await isVisible(page.locator('.emote-palette.is-open')))) throw error;
    }
    await waitFor(() => isVisible(page.locator('.emote-palette.is-open')), {
      timeout: 8000,
      label: `${client.id} emote palette`,
    });
  }
  const tab = page
    .locator('.emote-tab')
    .filter({ hasText: tabName })
    .first();
  await press(client, tab);
  await waitFor(async () => (await page.locator('.emote-btn').count()) > 0, {
    timeout: 8000,
    label: `${client.id} emote grid`,
  });
}

async function readTransport(client) {
  const page = client.page;
  const text = await page
    .locator('.transport-chip')
    .evaluateAll((chips) =>
      chips.map((chip) => {
        const visible = (selector) => {
          const el = chip.querySelector(selector);
          if (!el) return null;
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return null;
          return (el.textContent || '').replace(/\s+/g, ' ').trim();
        };
        return visible('.transport-chip-long') ?? visible('.transport-chip-short') ?? '';
      }),
    )
    .catch(() => []);
  const cleaned = text.filter(Boolean);
  if (cleaned.length) client.transports.push({ atMs: nowMs(), text: cleaned });
  return cleaned;
}

// ---------------------------------------------------------------- game bot

async function actOnce(client) {
  const page = client.page;
  if (!page || page.isClosed()) return false;

  if (await isVisible(page.locator('.result-screen'))) return 'result';

  // Track how long each cutscene (演出中) actually lasts. Tap-to-skip is the
  // same affordance a human has, but it is only used after a real stall, and
  // every duration/skip is recorded so the report can answer "was it stuck?".
  if (await isVisible(page.locator('.skip-hint:not([hidden])'))) {
    const now = Date.now();
    if (!client.fxBusySince) {
      client.fxBusySince = now;
      client.fxBusyMaxSeen = client.fxBusyMaxSeen || 0;
    }
    const busyFor = now - client.fxBusySince;
    if (busyFor > (client.fxBusyMaxSeen || 0)) client.fxBusyMaxSeen = busyFor;
    if (SKIP_AFTER_MS > 0 && busyFor > SKIP_AFTER_MS) {
      const canvas = page.locator('.map-canvas').first();
      if (await isVisible(canvas)) {
        await canvas.click({ position: { x: 60, y: 60 }, timeout: 5000, force: true }).catch(() => undefined);
        client.stuckSkips = (client.stuckSkips || 0) + 1;
        client.skipLog = client.skipLog || [];
        if (client.skipLog.length < 60) {
          client.skipLog.push({ atMs: nowMs(), busyFor, primary: ((await page.locator('.dice-primary').textContent().catch(() => '')) || '').trim() });
        }
        log(`${client.id}: skipped a ${Math.round(busyFor / 1000)}s cutscene`);
        client.fxBusySince = 0;
        return 'skip_fx';
      }
    }
  } else if (client.fxBusySince) {
    client.fxDurations = client.fxDurations || [];
    if (client.fxDurations.length < 500) {
      client.fxDurations.push(Date.now() - client.fxBusySince);
    }
    client.fxBusySince = 0;
  }

  // Year-end acknowledgement. A stale city-buy modal can sit above it, so use a
  // DOM click to reach the enabled ack (reported UI bug).
  const ack = page.locator('.yearend-ack:not([disabled])').first();
  if (await isVisible(ack)) {
    const modals = await page.locator('.modal-backdrop').count();
    if (modals > 1) {
      client.modalOverlaps = (client.modalOverlaps || []) + 1;
      log(`${client.id}: ${modals} modals stacked; acknowledging year end through the overlay`);
    }
    await domClick(ack);
    return 'yearend_ack';
  }

  // Event choices (only enabled for the actor).
  const choice = page.locator('.event-choice:not([disabled])').first();
  if (await isVisible(choice)) {
    await press(client, choice);
    return 'event_choice';
  }

  // City / property purchase sheet.
  if (await isVisible(page.locator('.city-sheet'))) {
    if (!client.cityOpen) {
      client.cityOpen = true;
      client.cityVisit += 1;
      client.cityBought = false;
    }
    const endBuy = page.locator('.city-end-buy:not([disabled])').first();
    if (client.cityBought) {
      if (await isVisible(endBuy)) {
        await press(client, endBuy);
        return 'end_buy';
      }
      return false;
    }
    const rows = page.locator('.property-row');
    const rowCount = await rows.count();
    let cheapestIndex = -1;
    let cheapestPrice = Number.POSITIVE_INFINITY;
    for (let index = 0; index < rowCount; index += 1) {
      const row = rows.nth(index);
      const buy = row.locator('.property-buy').first();
      if (!(await isVisible(buy))) continue;
      if (!(await buy.isEnabled().catch(() => false))) continue;
      const priceText = (await row.locator('.property-price').first().textContent().catch(() => '')) || '';
      const match = priceText.match(/([\d,.]+)/);
      const price = match ? Number(match[1].replace(/,/g, '')) : Number.POSITIVE_INFINITY;
      if (price < cheapestPrice) {
        cheapestPrice = price;
        cheapestIndex = index;
      }
    }
    // "Sometimes" buy: every other city visit, at most one property per stop.
    if (cheapestIndex >= 0 && client.cityVisit % 2 === 1) {
      const buy = rows.nth(cheapestIndex).locator('.property-buy').first();
      await press(client, buy);
      client.cityBought = true;
      return 'buy';
    }
    if (await isVisible(endBuy)) {
      await press(client, endBuy);
      return 'end_buy';
    }
    return false;
  }
  if (client.cityOpen) {
    client.cityOpen = false;
    client.cityBought = false;
  }

  // Card shop.
  if (await isVisible(page.locator('.shop-dialog'))) {
    const leave = page.locator('.shop-leave:not([disabled])').first();
    if (await isVisible(leave)) {
      await press(client, leave);
      return 'leave_shop';
    }
    return false;
  }

  // Card target dialog.
  if (await isVisible(page.locator('.target-dialog'))) {
    const target = page.locator('.target-item:not([disabled])').first();
    if (await isVisible(target)) {
      await press(client, target);
      return 'target';
    }
    return false;
  }

  // Discard overflow.
  if (await isVisible(page.locator('.discard-dialog'))) {
    const discard = page.locator('.discard-row .btn-red:not([disabled])').first();
    if (await isVisible(discard)) {
      await press(client, discard);
      return 'discard';
    }
    return false;
  }

  // Forced sale.
  if (await isVisible(page.locator('.sell-dialog'))) {
    const sell = page.locator('.sell-button:not([disabled])').first();
    if (await isVisible(sell)) {
      await press(client, sell);
      return 'sell';
    }
    return false;
  }

  // Movement choices: first tap only selects; the primary button then confirms.
  const selectedMove = page.locator('.move-options:not([hidden]) .move-chip.is-selected').first();
  if (!(await isVisible(selectedMove))) {
    const move = page.locator('.move-options:not([hidden]) .move-chip').first();
    if (await isVisible(move)) {
      await press(client, move);
      return 'select_move';
    }
  }

  // Primary action: roll, or confirm the selected destination (ここへ移動).
  const primary = page.locator('.dice-primary:not([disabled])').first();
  if (await isVisible(primary)) {
    const text = ((await primary.textContent()) || '').trim();
    await press(client, primary);
    return /ここへ移動|移動/.test(text) ? 'confirm_move' : 'primary';
  }
  return false;
}

async function playLoop(client) {
  while (!client.stopped) {
    if (client.paused) {
      await sleep(250);
      continue;
    }
    const page = client.page;
    if (!page || page.isClosed()) {
      await sleep(300);
      continue;
    }
    let action = false;
    try {
      action = await actOnce(client);
      if ((Date.now() - (client.lastModalSampleAt || 0)) > 1500) {
        client.lastModalSampleAt = Date.now();
        await sampleModalDepth(client);
      }
    } catch (error) {
      if (!page.isClosed()) {
        client.actionError = error.message;
      }
    }
    if (action === 'result') {
      await sleep(500);
      continue;
    }
    await sleep(action ? 120 : 220);
  }
}

// ---------------------------------------------------------------- evidence helpers

async function installBannerRecorder(client) {
  const page = client.page;
  if (!page || page.isClosed()) return;
  await page.evaluate(() => {
    window.__e2eBannerLog = [];
    const record = (el) => {
      if (!el) return;
      const text = (el.textContent || '').trim();
      if (!text) return;
      if (el.hidden) return;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      const last = window.__e2eBannerLog[window.__e2eBannerLog.length - 1];
      if (last && last.text === text) return;
      window.__e2eBannerLog.push({ at: Date.now(), cls: el.className, text });
      if (window.__e2eBannerLog.length > 200) window.__e2eBannerLog.shift();
    };
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        const node = mutation.target;
        const element = node.nodeType === 1 ? node : node.parentElement;
        if (!element) continue;
        for (const selector of ['.game-banner', '.migrate-banner', '.conn-banner', '.chat-system', '.chat-text']) {
          const hit = element.closest ? element.closest(selector) : null;
          if (hit) record(hit);
        }
      }
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['hidden', 'class', 'style'],
    });
  });
}

async function clearBannerLog(client) {
  const page = client.page;
  if (!page || page.isClosed()) return;
  await page.evaluate(() => {
    window.__e2eBannerLog = [];
  }).catch(() => undefined);
}

async function readBannerLog(client) {
  const page = client.page;
  if (!page || page.isClosed()) return [];
  return page.evaluate(() => window.__e2eBannerLog || []).catch(() => []);
}

const MIGRATION_RE = /ホスト|引き継ぎ|切断|代行|戻ってきました|再接続|接続を回復|host/i;

async function waitMigrationEvidence(clients, since) {
  const evidence = [];
  const deadline = Date.now() + MIGRATION_TIMEOUT_MS;
  const captured = new Set();
  while (Date.now() < deadline) {
    for (const client of clients) {
      if (client.stopped || !client.page || client.page.isClosed()) continue;
      const entries = await readBannerLog(client);
      for (const entry of entries) {
        if (!MIGRATION_RE.test(entry.text)) continue;
        const key = `${client.id}:${entry.text}`;
        if (captured.has(key)) continue;
        captured.add(key);
        evidence.push({ client: client.id, atMs: nowMs(), ...entry });
        log(`migration evidence ${client.id}: ${entry.text.slice(0, 120)}`);
      }
    }
    if (evidence.length > 0) {
      // Let the banner settle for a readable screenshot, then capture once.
      await sleep(600);
      for (const client of clients) {
        if (client.paused || client.stopped || !client.page || client.page.isClosed()) continue;
        await screenshot(client, `migration-${client.id}`, { optional: true });
      }
      return evidence;
    }
    await sleep(500);
  }
  return evidence;
}

async function waitForResult(client) {
  const deadline = Date.now() + RESULT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (client.stopped) return null;
    const page = client.page;
    if (page && !page.isClosed()) {
      try {
        if (await isVisible(page.locator('.result-screen'))) {
          await waitFor(async () => (await page.locator('.result-row').count()) >= 2, {
            timeout: 20_000,
            interval: 250,
            label: `${client.id} result rows`,
          });
          const rows = await page.$$eval('.result-row', (elements) =>
            elements.map((row) => ({
              rank: (row.querySelector('.result-rank-badge')?.textContent || '').trim(),
              name: (row.querySelector('.result-row-name strong')?.textContent || '').trim(),
              assets: (row.querySelector('.result-row-stats strong')?.textContent || '').trim(),
              full: (row.textContent || '').replace(/\s+/g, ' ').trim(),
            })),
          );
          const winner = ((await page.locator('.result-winner-name').first().textContent()) || '').trim();
          return { rows, winner, atMs: nowMs() };
        }
      } catch {
        /* page navigating */
      }
    }
    await sleep(500);
  }
  throw new Error(`${client.id} did not reach the result screen within ${RESULT_TIMEOUT_MS}ms`);
}

async function waitForMonth(targetMonth, timeout = 240_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const client of clients) {
      if (client.stopped) continue;
      const page = client.page;
      if (!page || page.isClosed()) continue;
      const text = await page.locator('.game-year-chip').first().textContent().catch(() => '');
      const match = (text || '').match(/(\d+)月/);
      if (match && Number(match[1]) >= targetMonth) return Number(match[1]);
    }
    await sleep(500);
  }
  throw new Error(`game did not reach month ${targetMonth} within ${timeout}ms`);
}

// ---------------------------------------------------------------- result comparison

function normalizeRanking(result) {
  return result.rows.map((row) => ({
    rank: row.rank,
    name: row.name,
    assets: row.assets,
  }));
}

function rankingsEqual(results) {
  const first = JSON.stringify(normalizeRanking(results[0].result));
  return results.every((entry) => JSON.stringify(normalizeRanking(entry.result)) === first);
}

// ---------------------------------------------------------------- main

const clients = [];
let preview = null;
let webkitPreload = null;

async function main() {
  await mkdir(OUT, { recursive: true });
  for (const entry of await readdir(OUT)) {
    if (entry === 'report.json' || entry.startsWith(`${RUN_LABEL}-`)) {
      await rm(path.join(OUT, entry), { force: true });
    }
  }
  process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS ||= '1';

  if (!SKIP_BUILD) {
    timings.buildMs = runVite(['build'], 'build');
  } else {
    timings.buildMs = 0;
  }
  preview = await startPreview();
  timings.previewMs = 0;

  webkitPreload = selectedSpecs.some((spec) => spec.browserType === webkit)
    ? await prepareWebkitLibs()
    : null;
  if (webkitPreload) log('WebKit fallback libraries ready');

  phase('launch_browsers');
  await Promise.all(
    selectedSpecs.map(async (spec) => {
      const client = await launchClient(spec, webkitPreload);
      clients.push(client);
      log(`launched ${client.label}`);
    }),
  );
  // Sort by spec order for deterministic reports.
  clients.sort((a, b) => selectedSpecs.findIndex((spec) => spec.id === a.id) - selectedSpecs.findIndex((spec) => spec.id === b.id));
  if (HEADFUL) startLiveScreenshots();
  const host = clients.find((client) => client.role === 'host');
  const webkitClient = clients.find((client) => client.id === 'webkit-iphone');
  const firefoxClient = clients.find((client) => client.id === 'firefox-desktop');
  const pixelClient = clients.find((client) => client.id === 'chromium-pixel');
  const activeGuests = clients.filter((client) => client.role === 'guest');
  const chatSender = activeGuests[0] ?? host;
  const chatReceiver = activeGuests[1] ?? host;
  let pokeTarget = host;
  if (activeGuests.length < 2) {
    log(`only ${activeGuests.length} guest(s); chat/emote/poke checks use the host as peer`);
  }
  report.webkitOmitted = !webkitClient;

  phase('host_create_room');
  await openOnlineEntry(host);
  const nameInput = host.page
    .locator('.online-name-field input, input[aria-label="プレイヤー名"]')
    .first();
  await nameInput.fill(HOST_NAME);
  const createButton = host.page
    .locator('.online-panel:not([hidden]) .online-main-btn')
    .filter({ hasText: /ルームをつくる|ルームを作る/ })
    .first();
  const createFallback = host.page.getByRole('button', { name: /ルームをつくる|ルームを作る/ }).first();
  await press(host, (await isVisible(createButton)) ? createButton : createFallback);
  const { roomCode, inviteUrl } = await readInviteFromLobby(host);
  report.roomCode = roomCode;
  report.inviteUrl = inviteUrl;
  for (const client of clients) client.inviteUrl = inviteUrl;
  log(`room ${roomCode} invite ${inviteUrl}`);

  // The host must claim seat 0 before guests arrive, otherwise the lobby's
  // host marker can land on a guest seat.
  await ensureSeated(host);
  if (CPU_GAP) {
    phase('cpu_gap_seat');
    await addCpuSeat(host);
  }

  phase('guests_join');
  for (const guest of activeGuests) {
    await joinGuest(guest, inviteUrl);
    await ensureSeated(guest, inviteUrl);
    await pickCharacter(guest);
  }
  await pickCharacter(host);
  if (activeGuests.length < 3) {
    await fillCpuSeats(host, clients.length);
  }

  await waitFor(
    async () => (await host.page.locator('.lobby-seat.is-self').count()) === 1,
    { timeout: 10_000, label: 'host self seat stable' },
  );
  const seatSummary = await host.page
    .locator('.lobby-seats-panel .badge')
    .first()
    .textContent()
    .catch(() => '');
  log(`lobby seats: ${seatSummary}`);
  const seatLayout = await host.page.$$eval('.lobby-seat', (elements) =>
    elements.map((element) => ({
      seat: Number(element.dataset.seat),
      kind: element.classList.contains('lobby-seat-human')
        ? 'human'
        : element.classList.contains('lobby-seat-cpu')
          ? 'cpu'
          : 'open',
      name: (element.querySelector('.lobby-seat-name')?.textContent || '').trim(),
    })),
  );
  report.seatLayout = seatLayout;
  report.humanSeats = seatLayout.filter((seat) => seat.kind === 'human').map((seat) => seat.seat);
  report.cpuSeats = seatLayout.filter((seat) => seat.kind === 'cpu').map((seat) => seat.seat);
  report.openSeats = seatLayout.filter((seat) => seat.kind === 'open').map((seat) => seat.seat);
  log(`seat layout: ${JSON.stringify(seatLayout)}`);
  if (CPU_GAP) {
    if (JSON.stringify(report.humanSeats) !== JSON.stringify([0, 2, 3])) {
      throw new Error(`expected human seats [0,2,3], got ${JSON.stringify(report.humanSeats)}`);
    }
    if (JSON.stringify(report.cpuSeats) !== JSON.stringify([1])) {
      throw new Error(`expected CPU seat [1], got ${JSON.stringify(report.cpuSeats)}`);
    }
    if (report.openSeats.length !== 0) {
      throw new Error(`expected no open seats, got ${JSON.stringify(report.openSeats)}`);
    }
  }

  pokeTarget = activeGuests.find((candidate) => candidate.seat !== chatSender.seat) ?? host;
  log(`chat ${chatSender.id} -> ${chatReceiver.id}; poke -> ${pokeTarget.id}`);

  // Transport chips need a moment for the WebRTC upgrade.
  await sleep(5000);
  for (const client of clients) {
    const text = await readTransport(client);
    log(`${client.id} transport: ${text.join(' | ') || '(none)'}`);
  }

  phase('lobby_screenshots');
  for (const client of clients) {
    await screenshot(client, `lobby-${client.id}`);
  }

  // Chat: chatSender -> chatReceiver.
  const chatText = `E2Eこんにちは-${Date.now().toString(36)}`;
  phase('chat_test', { text: chatText, from: chatSender.id, to: chatReceiver.id });
  await openChat(chatReceiver);
  await openChat(chatSender);
  const receivedChat = () =>
    isVisible(chatReceiver.page.locator('.chat-text').filter({ hasText: chatText }).first());
  let delivered = false;
  for (let attempt = 1; attempt <= 4 && !delivered; attempt += 1) {
    const sendText = attempt === 1 ? chatText : `${chatText}-${attempt}`;
    if (attempt > 1) log(`${chatSender.id}: resending chat (attempt ${attempt})`);
    await chatSender.page.locator('.chat-input').first().fill(sendText);
    await press(chatSender, chatSender.page.locator('.chat-send').first());
    delivered = await waitFor(receivedChat, {
      timeout: 25_000,
      interval: 250,
      label: `${chatReceiver.id} receives chat`,
    })
      .then(() => true)
      .catch(() => false);
  }
  if (!delivered) throw new Error(`${chatReceiver.id} never received chat after 4 sends`);
  await closeChat(chatSender);
  await closeChat(chatReceiver);
  log(`chat delivered to ${chatReceiver.id}: ${chatText}`);
  // Let the chat speech bubble expire so the emote assertion is not satisfied
  // by the chat bubble we just created.
  await waitFor(
    () =>
      !isVisible(
        chatReceiver.page.locator(
          `.lobby-seat[data-seat="${chatSender.seat}"] .lobby-seat-bubble`,
        ),
      ),
    { timeout: 7000, interval: 250, label: 'chat bubble cleared before emote' },
  ).catch(() => undefined);

  // Emote in the lobby (DOM bubbles exist here; in-game emotes are canvas-only).
  phase('emote_test', { from: chatSender.id });
  await openEmoteTab(chatSender, '喜怒哀楽');
  await press(chatSender, chatSender.page.locator('.emote-btn').first());
  const emoteBubble = chatReceiver.page.locator(
    `.lobby-seat[data-seat="${chatSender.seat}"] .lobby-seat-bubble`,
  );
  await waitFor(() => isVisible(emoteBubble.first()), {
    timeout: 10_000,
    label: `${chatReceiver.id} receives emote bubble`,
  });
  const emoteText = ((await emoteBubble.first().textContent()) || '').trim();
  if (!emoteText || emoteText === chatText) {
    throw new Error(`emote bubble did not show a distinct emote line: "${emoteText}"`);
  }
  await waitFor(() => isVisible(host.page.locator(`.lobby-seat[data-seat="${chatSender.seat}"] .lobby-seat-bubble`)), {
    timeout: 10_000,
    label: 'Host receives emote bubble',
  });
  log(`emote delivered: ${emoteText}`);

  // Targeted poke. Global emote gate is 2.5 s.
  await sleep(2800);
  phase('poke_test', { target: pokeTarget.id });
  await openEmoteTab(chatSender, 'ちょっかい');
  await press(
    chatSender,
    chatSender.page.getByRole('button', { name: /トマト投げ/ }).first(),
  );
  await waitFor(() => isVisible(chatSender.page.locator('.emote-targets:not([hidden])')), {
    timeout: 8000,
    label: 'poke target list',
  });
  const targetButton = chatSender.page
    .locator('.emote-target')
    .filter({ hasText: pokeTarget.name })
    .first();
  await press(chatSender, targetButton);
  const ownBubble = pokeTarget.page.locator(
    '.lobby-seat.is-self .lobby-seat-bubble',
  );
  await waitFor(() => isVisible(ownBubble.first()), {
    timeout: 12_000,
    label: `${pokeTarget.id} receives poked hit bubble`,
  });
  const pokeHitText = ((await ownBubble.first().textContent()) || '').trim();
  await waitFor(
    () => isVisible(host.page.locator(`.lobby-seat[data-seat="${pokeTarget.seat}"] .lobby-seat-bubble`)),
    { timeout: 10_000, label: 'Host sees poke hit bubble' },
  );
  log(`poke delivered: ${pokeHitText}`);

  // Host settings: 1 year, 20-second turns, selected humans + CPU fill.
  phase('start_game');
  const oneYear = host.page.getByRole('button', { name: '1年', exact: true }).first();
  const twentySeconds = host.page.getByRole('button', { name: '20秒', exact: true }).first();
  await domClick(oneYear);
  await waitFor(
    async () => (await oneYear.getAttribute('aria-pressed')) === 'true',
    { timeout: 8000, label: '1 year selected' },
  );
  await domClick(twentySeconds);
  await waitFor(
    async () => (await twentySeconds.getAttribute('aria-pressed')) === 'true',
    { timeout: 8000, label: '20 second turns selected' },
  );
  const startButton = host.page.locator('.lobby-bottom-start, .lobby-start-btn').first();
  await waitFor(
    async () => (await startButton.count()) > 0 && (await startButton.isEnabled().catch(() => false)),
    { timeout: 25_000, label: 'start button enabled' },
  );
  await domClick(startButton);

  await Promise.all(
    clients.map((client) =>
      waitFor(
        async () => {
          const page = client.page;
          if (!page || page.isClosed()) return false;
          return isVisible(page.locator('.game-screen'));
        },
        { timeout: 60_000, interval: 250, label: `${client.id} game screen` },
      ),
    ),
  );
  await Promise.all(
    clients.map((client) =>
      waitFor(
        () => {
          const page = client.page;
          if (!page || page.isClosed()) return false;
          return page
            .evaluate(() => {
              const loading = document.querySelector('.game-loading');
              const loadingVisible = !!loading && !loading.hidden;
              const rankRows = document.querySelectorAll('.rank-row').length;
              // The loading cover can linger behind an already-applied state
              // (map assets are large); treat a rendered HUD as ready.
              return !!document.querySelector('.dice-primary') && (!loadingVisible || rankRows > 0);
            })
            .catch(() => false);
        },
        { timeout: 180_000, interval: 300, label: `${client.id} map loaded` },
      ),
    ),
  );
  timings.gameStartAtMs = nowMs();
  phase('game_playing');

  const resultHolders = [];
  for (const client of clients) {
    client.stopped = false;
    client.loop = playLoop(client);
    if (client.role !== 'host' || SKIP_HOST_KILL) {
      resultHolders.push({ client, promise: waitForResult(client) });
    }
  }

  await waitForMonth(5);
  timings.midGameAtMs = nowMs();
  phase('midgame_screenshots');
  for (const client of clients) {
    if (client.recovering) await client.recovering.catch(() => undefined);
    if (client.crashed || !client.page || client.page.isClosed()) {
      await recoverClient(client).catch((error) => log(`${client.id} recovery before screenshot failed: ${error.message}`));
    }
    if (client.page && !client.page.isClosed()) {
      await screenshot(client, `midgame-${client.id}`, { optional: true });
    }
  }

  // ---- Firefox tab close/reopen: same browser context, same localStorage identity.
  phase('firefox_rejoin_start');
  const firefoxSeatBefore = firefoxClient?.seat ?? null;
  if (!firefoxClient) {
    log('Firefox not selected; skipping close/reopen check');
  } else {
  await firefoxClient.page.close();
  await sleep(2500);
  firefoxClient.page = null;
  await newPage(firefoxClient);
  await firefoxClient.page.goto(inviteUrl, { waitUntil: 'domcontentloaded' });
  await waitFor(() => isVisible(firefoxClient.page.locator('.online-screen')), {
    timeout: 35_000,
    label: 'Firefox rejoin entry',
  });
  await firefoxClient.page
    .locator('.online-name-field input, input[aria-label="プレイヤー名"]')
    .first()
    .fill(FIREFOX_NAME);
  await joinAndWait(firefoxClient, 'game', inviteUrl);
  await waitFor(() => isVisible(firefoxClient.page.locator('.game-screen')), {
    timeout: 30_000,
    label: 'Firefox resumes game screen',
  });
  await ensureResumedSeat(firefoxClient, inviteUrl);
  await waitFor(
    async () =>
      (await firefoxClient.page.locator('.rank-row').count()) === 4 &&
      (await firefoxClient.page.locator('.rank-row.is-mine').count()) === 1,
    { timeout: 20_000, label: 'Firefox sees four seats with itself once' },
  );
  timings.firefoxRejoinMs = nowMs();
  phase('firefox_rejoined', { seatBefore: firefoxSeatBefore, atMs: nowMs() });
  await screenshot(firefoxClient, 'firefox-rejoined');
  await installBannerRecorder(firefoxClient);
  await waitFor(
    () => isVisible(firefoxClient.page.locator('.status-chip.is-mine')),
    { timeout: 90_000, label: 'Firefox gets a resumed turn' },
  );
  log('Firefox resumed seat and reached its own turn');
  }

  if (!SKIP_HOST_KILL) {
    const watcher = firefoxClient ?? activeGuests[0] ?? null;
    // Kill while the host is the acting player so migration has to take over an
    // in-flight host turn (NetRoom's kill-while-actor path).
    await waitFor(
      async () => {
        if (!watcher) return false;
        const text = ((await watcher.page.locator('.status-chip').textContent().catch(() => '')) || '').trim();
        return text.includes(`${HOST_NAME} の番`);
      },
      { timeout: 90_000, interval: 300, label: 'host acting before kill' },
    ).catch(() => log('host was not the acting player before kill; continuing'));

    // If any client saw a newer host generation before our kill, the browser we
    // are about to close may no longer be the authority.
    const generationDrops = clients.flatMap((client) =>
      client.warnings
        .filter((warning) => /old generation|host migration|step.?down|new host/i.test(warning.text))
        .map((warning) => ({ client: client.id, ...warning })),
    );
    report.generationDrops = generationDrops;
    if (generationDrops.length > 0) {
      throw new Error(
        `host authority changed before the kill test (${generationDrops.length} generation warnings)`,
      );
    }
  }

  if (SKIP_HOST_KILL) {
    phase('host_kill_skipped');
    report.migration = { skipped: true };
  } else {
    // ---- Host kill: no unload handler, so this is a real host disappearance.
    phase('host_kill');
    for (const client of clients) {
      if (client.role === 'host') continue;
      await installBannerRecorder(client);
    }
    for (const client of clients) {
      if (client.role === 'host') continue;
      await clearBannerLog(client);
    }
    host.paused = true;
    host.stopped = true;
    const killAt = Date.now();
    timings.hostKillAtMs = nowMs();
    await host.browser.close().catch(() => undefined);
    log('host browser closed');
    const migrationEvidence = await waitMigrationEvidence(
      clients.filter((client) => client.role !== 'host'),
      killAt,
    );
    timings.migrationDetectedMs = nowMs();
    report.migration = {
      hostKilledAtMs: timings.hostKillAtMs,
      evidence: migrationEvidence,
      bannerObserved: migrationEvidence.length > 0,
      screenshots: screenshots.filter((file) => file.includes('migration-')),
    };
    if (migrationEvidence.length === 0) {
      log('WARN: no explicit migration banner/chat evidence was observed');
    } else {
      phase('migration_detected', { count: migrationEvidence.length });
    }
  }

  // Remaining three clients continue to the result screen.
  const settled = await Promise.allSettled(resultHolders.map((holder) => holder.promise));
  const failures = settled.filter((entry) => entry.status === 'rejected');
  const remainingResults = [];
  for (let index = 0; index < settled.length; index += 1) {
    const holder = resultHolders[index];
    const outcome = settled[index];
    if (outcome.status === 'fulfilled' && outcome.value) {
      remainingResults.push({ client: holder.client, result: outcome.value });
      phase('client_result', {
        client: holder.client.id,
        atMs: nowMs(),
        winner: outcome.value.winner,
        rows: outcome.value.rows.length,
      });
    } else if (outcome.status === 'rejected') {
      log(`result failure ${holder.client.id}: ${outcome.reason.message}`);
    }
  }
  const expectedRemaining = SKIP_HOST_KILL ? clients.length : activeGuests.length;
  if (remainingResults.length !== expectedRemaining) {
    throw new Error(
      `expected ${expectedRemaining} remaining results after host kill, got ${remainingResults.length}; failures: ${failures
        .map((entry) => entry.reason?.message)
        .join(' | ')}`,
    );
  }

  phase('result_screenshots');
  for (const entry of remainingResults) {
    await screenshot(entry.client, `result-${entry.client.id}`);
  }
  if (HEADFUL) {
    log('holding result screens for 20s');
    await sleep(20_000);
  }

  for (const { client, result } of remainingResults) {
    if (result.rows.length !== 4) {
      throw new Error(`${client.id}: expected 4 final ranking rows, got ${result.rows.length}`);
    }
  }
  const ranks = remainingResults.map(({ client, result }) => ({
    client: client.id,
    result,
  }));
  const equal = rankingsEqual(ranks);
  report.rankingsEqual = equal;
  report.rankings = ranks.map(({ client, result }) => ({
    client,
    winner: result.winner,
    rows: normalizeRanking(result),
  }));
  report.transports = Object.fromEntries(
    clients.map((client) => [client.id, client.transports]),
  );
  report.migration = {
    ...(report.migration || {}),
    continued: true,
  };
  report.rejoin = {
    firefoxSeatBefore,
    firefoxSeatAfter: firefoxClient.seat,
    resumedAtMs: timings.firefoxRejoinMs,
  };

  for (const client of clients) {
    client.stopped = true;
    if (client.loop) await Promise.race([client.loop, sleep(1000)]);
  }

  phase('cleanup');
  if (!equal) {
    throw new Error(
      `final rankings differ between clients:\n${JSON.stringify(
        ranks.map(({ client, result }) => ({ client, rows: normalizeRanking(result) })),
        null,
        2,
      )}`,
    );
  }
  const pageErrors = report.errors.pageErrors;
  if (pageErrors.length > 0) {
    throw new Error(`uncaught page errors: ${pageErrors.map((entry) => entry.text).join(' | ')}`);
  }
  if (report.errors.consoleErrors.length > 0) {
    throw new Error(
      `non-benign console errors: ${report.errors.consoleErrors
        .map((entry) => entry.text)
        .join(' | ')}`,
    );
  }
  report.ok = true;
}

async function dumpFailure(error) {
  report.error = error?.stack || error?.message || String(error);
  log(`FAIL: ${report.error}`);
  for (const client of clients) {
    try {
      const diagnostics = await pageDiagnostics(client);
      report.failureDiagnostics = report.failureDiagnostics || {};
      report.failureDiagnostics[client.id] = diagnostics;
      await screenshot(client, `failure-${client.id}`, { optional: true });
    } catch (screenshotError) {
      log(`could not capture failure state for ${client.id}: ${screenshotError.message}`);
    }
  }
}

async function cleanup() {
  stopLiveScreenshots();
  for (const client of clients) {
    client.stopped = true;
    client.paused = true;
    try {
      await client.browser?.close();
    } catch {
      /* already closed */
    }
  }
  await stopPreview(preview);
}

try {
  await main();
} catch (error) {
  await dumpFailure(error);
  process.exitCode = 1;
} finally {
  timings.totalMs = nowMs();
  report.durationMs = nowMs();
  report.timings = { ...timings, completedAt: new Date().toISOString() };
  report.screenshots = screenshots.map((file) => path.relative(ROOT, file));
  report.maxModals = Math.max(0, ...clients.map((client) => client.maxModals || 0));
  report.maxModalsNonActor = Math.max(0, ...clients.map((client) => client.maxModalsNonActor || 0));
  report.canvasLimitWarnings = report.errors.canvasLimitWarnings;
  report.cutscene = {
    skipAfterMs: SKIP_AFTER_MS,
    totalSkips: clients.reduce((sum, client) => sum + (client.stuckSkips || 0), 0),
    perClient: Object.fromEntries(
      clients.map((client) => [
        client.id,
        {
          skips: client.stuckSkips || 0,
          maxBusyMs: client.fxBusyMaxSeen || 0,
          normalFxCount: (client.fxDurations || []).length,
          normalFxMaxMs: Math.max(0, ...(client.fxDurations || [])),
        },
      ]),
    ),
  };
  report.clients = clients.map((client) => ({
    id: client.id,
    label: client.label,
    name: client.name,
    role: client.role,
    seat: client.seat,
    character: client.character,
    transports: client.transports,
    result: client.result,
    screenshots: client.screenshots.map((file) => path.relative(ROOT, file)),
    pageErrors: client.pageErrors,
    pageCrashes: client.pageCrashes,
    consoleErrors: client.consoleErrors,
    ignorableConsole: client.ignorableConsole,
    warnings: client.warnings,
    canvasLimitWarnings: client.canvasLimitWarnings,
    maxModals: client.maxModals || 0,
    maxModalsNonActor: client.maxModalsNonActor || 0,
    stuckSkips: client.stuckSkips || 0,
    fxBusyMaxMs: client.fxBusyMaxSeen || 0,
    skipLog: client.skipLog || [],
    fxDurationsMs: client.fxDurations || [],
  }));
  await writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  await cleanup();
  if (report.ok) {
    const duration = Math.round(report.durationMs / 1000);
    console.log(`\nE2E OK in ${duration}s`);
    console.log(`rankings equal: ${report.rankingsEqual}`);
    console.log(`migration banner: ${report.migration?.bannerObserved}`);
    console.log(`screenshots: ${report.screenshots.length} in .tmp/e2e/`);
    console.log(`report: ${path.join(OUT, 'report.json')}`);
  } else {
    console.log(`\nE2E FAILED in ${Math.round(report.durationMs / 1000)}s — see ${path.join(OUT, 'report.json')}`);
  }
  await sleep(100);
  process.exit(report.ok ? 0 : 1);
}