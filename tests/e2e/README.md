# Online end-to-end test (real browsers)

`online.e2e.mjs` is deliberately **not** a vitest file. It builds `dist`, serves it
with `vite preview` on `127.0.0.1:5195`, launches **four separate browser
processes**, and plays a complete 1-year online game through the real UI.

```bash
npm run e2e:online
```

| Client | Browser process | Emulation |
|---|---|---|
| Host | Chromium | desktop 1280×720 |
| Guest | WebKit | iPhone 13 (`isMobile`, touch) |
| Guest | Firefox | desktop 1280×720 |
| Guest | Chromium (second process) | Pixel 7 (`isMobile`, touch) |

The test also:

1. Creates the room through the title → オンライン → ルームをつくる UI and reads
   the invite URL via the lobby copy button.
2. Joins with `?room=<CODE>` in each browser, takes seats and picks characters
   through the UI, sets **1 year / 20-second turns / 4 human seats**, and starts.
3. Plays every turn with UI clicks/taps (roll, first move chip, cheapest
   property on every other city visit, end buying, first event choice, shop
   leave, year-end acknowledge, discard/sell/target dialogs).
4. Sends chat from WebKit and asserts Firefox receives it; sends an emote and a
   targeted tomato poke and asserts the DOM bubbles on the other clients.
5. Closes the Firefox **page** mid-game and reopens the invite URL in the same
   browser context (same `localStorage` identity) and asserts it resumes the
   same seat.
6. Kills the host browser mid-game, asserts migration/reconnect evidence, and
   asserts the remaining three clients reach the result screen.
7. Compares final rankings (rank, name, total assets) across the three clients
   and fails on uncaught page errors or non-benign console errors.

## Artifacts

Everything is written under `.tmp/e2e/`:

- `lobby-*.png`, `midgame-*.png`, `migration-*.png`, `result-*.png`,
  `firefox-rejoined.png`
- `report.json`: timings, room code/invite URL, seats, characters, transport
  chip text (`P2P 直結` / `中継`), final rankings, migration evidence,
  console/page errors, and screenshot paths. It also records
  `maxModals`/`maxModalsNonActor` (visible `.modal-backdrop` depth sampled
  during play), `canvasLimitWarnings` (browser `Canvas area exceeds` messages),
  `mobileDpr`, `events.byClient`/`events.unique` (event ids seen), and
  `fxObserved` (counts of `piper_roulette` / `piper_disaster` / `skill` /
  `buyout` / `final_year`).

## Environment

- Browsers run **headless and muted** by default: Chromium gets
  `--mute-audio`, Firefox `media.volume_scale=0.0`, and WebKit
  `PULSE_SERVER=unix:/nonexistent`. `E2E_HEADFUL=1` shows the four windows for
  live viewing (slowMo 150 ms, speed 4, result held 20 s).
- `E2E_CLIENTS` limits browsers for a quick/watch run, e.g.
  `E2E_CLIENTS=host-chromium,firefox-desktop,chromium-pixel` (3 humans + 1 CPU).
  The default is all four browsers. The host is always included.
- `E2E_CPU_GAP=1` fills seat 1 with a CPU **before** guests join so guests land
  on seats 2 and 3 (humans 0,2,3 + CPU 1; exercises seat↔player mapping).
  `E2E_RUN_LABEL` prefixes screenshots/reports; `E2E_SCENARIO` tags the report.
- `E2E_SKIP_HOST_KILL=1` plays the full game with the host alive (no migration);
  default `0` kills the host mid-game and requires migration evidence.
- `E2E_SKIP_AFTER_MS` (default `15000`) taps the map when a cutscene stays in
  `演出中` longer than this, mirroring the in-game “タップでスキップ”. Set `0`
  to disable auto-skip and measure stalls; `report.cutscene` records skips and
  the max continuous cutscene per client either way.
- `E2E_MOBILE_DPR` selects mobile emulation DPR: `native` (**default**, real
  device descriptor: iPhone 13 = 3, Pixel 7 = 2.625) or `1`. Use `1` only as a
  temporary workaround for the map-canvas over-allocation crash
  (`Canvas area exceeds the maximum limit`), which is reported to the renderer
  owner; the chosen value is recorded as `mobileDpr` in `report.json`.
- `E2E_SKIP_BUILD=1` reuses the existing `dist/`.
- `E2E_PORT` (default `5195`), `E2E_SPEED` (default `4` headful / `8`
  headless), `E2E_SLOWMO` (default `150` headful / `0` headless),
  `E2E_RESULT_TIMEOUT_MS`, `E2E_MIGRATION_TIMEOUT_MS`.
- `?speed=N` only accelerates client-side fx playback. Online turn deadlines,
  CPU pacing, and host migration timers stay host-driven.
- `live-<client>.png` is overwritten every 30 seconds during the run so the
  desktop can be watched (and a run can be followed remotely).
- Public MQTT brokers are used exactly as in production. Transient
  WebSocket/MQTT reconnect errors are classified as benign and recorded
  separately in `report.json`.

### WebKit on Arch Linux

Playwright's WebKit bundle targets Ubuntu 24.04 (`libicu74`, `libxml2.so.2`).
On Arch, the harness downloads those two Ubuntu `.deb` packages once into
`.tmp/e2e/weblibs`/`.tmp/e2e/webkit-debs` and launches WebKit with
`LD_PRELOAD`. No system packages are modified. If the download fails, WebKit is
still attempted; the resulting launch error is reported verbatim.