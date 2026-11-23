#!/usr/bin/env node
// Generates every SFX with game-production/audio_gen.py, then encodes the result as mp3 for the
// browser. All names here must match SfxName in src/audio/audio.ts. BGM is sourced separately by
// tools/fetch-bgm.mjs (incompetech CC BY tracks).
//
// Usage: node tools/gen-sfx.mjs

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SFX_DIR = path.join(ROOT, 'public/assets/sfx');
const PYTHON = process.env.PYTHON ?? 'python3';
const AUDIO_GEN = path.join(
  process.env.HOME ?? '',
  '.omp/agent/skills/game-production/scripts/audio_gen.py',
);

// Each layer is one audio_gen.py preset take. Multiple layers are delayed and mixed by ffmpeg.
const SFX_RECIPES = {
  click: [{ preset: 'ui_click', pitch: 1.0 }],
  dice_roll: [
    { preset: 'footstep', pitch: 1.55, gainDb: 0, delayMs: 0, seed: 101 },
    { preset: 'footstep', pitch: 1.3, gainDb: -2, delayMs: 70, seed: 102 },
    { preset: 'footstep', pitch: 1.75, gainDb: -1, delayMs: 135, seed: 103 },
    { preset: 'footstep', pitch: 1.45, gainDb: -3, delayMs: 205, seed: 104 },
    { preset: 'footstep', pitch: 1.65, gainDb: -2, delayMs: 285, seed: 105 },
    { preset: 'footstep', pitch: 1.5, gainDb: -4, delayMs: 375, seed: 106 },
    { preset: 'impact', pitch: 1.7, gainDb: -4, delayMs: 465, seed: 107 },
  ],
  dice_land: [
    { preset: 'impact', pitch: 1.5, seed: 111 },
    { preset: 'ui_confirm', pitch: 1.2, gainDb: -6, delayMs: 40, seed: 112 },
  ],
  step: [{ preset: 'footstep', pitch: 1.0 }],
  coin_gain: [{ preset: 'coin', pitch: 1.05 }],
  coin_loss: [
    { preset: 'ui_cancel', pitch: 0.85, seed: 121 },
    { preset: 'coin', pitch: 0.6, gainDb: -6, delayMs: 70, seed: 122 },
  ],
  buy: [
    { preset: 'coin', pitch: 1.0, seed: 131 },
    { preset: 'ui_confirm', pitch: 0.95, gainDb: -2, delayMs: 60, seed: 132 },
  ],
  monopoly: [
    { preset: 'powerup', pitch: 1.0, seed: 141 },
    { preset: 'coin', pitch: 1.2, gainDb: -6, delayMs: 220, seed: 142 },
  ],
  card_get: [
    { preset: 'ui_confirm', pitch: 1.25, seed: 151 },
    { preset: 'ui_click', pitch: 1.8, gainDb: -8, delayMs: 30, seed: 152 },
  ],
  card_use: [
    { preset: 'blip', pitch: 1.3, seed: 161 },
    { preset: 'swing', pitch: 1.4, gainDb: -10, delayMs: 20, seed: 162 },
  ],
  event: [{ preset: 'powerup', pitch: 0.9, seed: 171 }],
  goal_fanfare: [
    { preset: 'ui_confirm', pitch: 0.75, delayMs: 0, seed: 181 },
    { preset: 'ui_confirm', pitch: 1.0, delayMs: 120, seed: 182 },
    { preset: 'ui_confirm', pitch: 1.25, delayMs: 240, seed: 183 },
    { preset: 'ui_confirm', pitch: 1.5, delayMs: 360, seed: 184 },
    { preset: 'coin', pitch: 1.1, gainDb: -4, delayMs: 480, seed: 185 },
  ],
  piper: [
    { preset: 'hurt', pitch: 0.55, seed: 191 },
    { preset: 'hurt', pitch: 0.56, gainDb: -4, delayMs: 180, seed: 192 },
  ],
  bad: [
    { preset: 'hurt', pitch: 0.85, seed: 201 },
    { preset: 'impact', pitch: 0.9, gainDb: -8, delayMs: 20, seed: 202 },
  ],
  year_end: [
    { preset: 'ui_confirm', pitch: 0.9, seed: 211 },
    { preset: 'coin', pitch: 0.9, gainDb: -4, delayMs: 110, seed: 212 },
  ],
  win: [
    { preset: 'ui_confirm', pitch: 0.75, delayMs: 0, seed: 221 },
    { preset: 'ui_confirm', pitch: 1.0, delayMs: 140, seed: 222 },
    { preset: 'ui_confirm', pitch: 1.25, delayMs: 280, seed: 223 },
    { preset: 'ui_confirm', pitch: 1.5, delayMs: 420, seed: 224 },
    { preset: 'ui_confirm', pitch: 2.0, delayMs: 600, seed: 225 },
    { preset: 'coin', pitch: 1.0, gainDb: -4, delayMs: 760, seed: 226 },
  ],
  lose: [
    { preset: 'death', pitch: 0.8, seed: 231 },
    { preset: 'death', pitch: 0.8, gainDb: -8, delayMs: 220, seed: 232 },
  ],
  stamp: [
    { preset: 'impact', pitch: 2.0, seed: 241 },
    { preset: 'ui_click', pitch: 0.8, gainDb: -6, delayMs: 15, seed: 242 },
  ],
  timer_tick: [{ preset: 'ui_hover', pitch: 1.0, gainDb: 6, seed: 251 }],
  error: [
    { preset: 'ui_cancel', pitch: 0.9, seed: 261 },
    { preset: 'ui_cancel', pitch: 0.9, delayMs: 150, seed: 262 },
  ],
  emote_pop: [
    { preset: 'blip', pitch: 1.7, seed: 271 },
    { preset: 'ui_click', pitch: 2.0, gainDb: -6, delayMs: 15, seed: 272 },
  ],
  throw: [{ preset: 'swing', pitch: 1.1, gainDb: 2, seed: 281 }],
  hit: [
    { preset: 'impact', pitch: 1.4, seed: 291 },
    { preset: 'hurt', pitch: 1.5, gainDb: -6, delayMs: 15, seed: 292 },
  ],
  chat: [{ preset: 'ui_confirm', pitch: 1.5, gainDb: -4, seed: 301 }],
  shop_bell: [
    { preset: 'ui_confirm', pitch: 2.0, seed: 311 },
    { preset: 'coin', pitch: 1.9, gainDb: -6, delayMs: 35, seed: 312 },
  ],
  tornado: [
    { preset: 'swing', pitch: 0.5, gainDb: 5, seed: 321 },
    { preset: 'swing', pitch: 0.75, gainDb: -1, delayMs: 250, seed: 322 },
    { preset: 'explosion', pitch: 0.55, gainDb: -12, delayMs: 120, seed: 323 },
  ],
  portal: [
    { preset: 'powerup', pitch: 1.35, seed: 331 },
    { preset: 'laser', pitch: 1.6, gainDb: -4, delayMs: 40, seed: 332 },
    { preset: 'blip', pitch: 2.2, gainDb: -8, delayMs: 140, seed: 333 },
  ],
  rocket_launch: [
    { preset: 'explosion', pitch: 0.5, gainDb: -4, seed: 341 },
    { preset: 'powerup', pitch: 0.6, gainDb: -2, delayMs: 60, seed: 342 },
    { preset: 'shoot', pitch: 0.7, gainDb: -8, delayMs: 150, seed: 343 },
  ],
  train_horn: [
    { preset: 'death', pitch: 0.35, seed: 351 },
    { preset: 'death', pitch: 0.44, gainDb: -3, delayMs: 30, seed: 352 },
    { preset: 'powerup', pitch: 0.3, gainDb: -6, seed: 353 },
  ],
  ship_horn: [
    { preset: 'death', pitch: 0.22, seed: 361 },
    { preset: 'death', pitch: 0.28, gainDb: -2, delayMs: 60, seed: 362 },
    { preset: 'explosion', pitch: 0.4, gainDb: -16, delayMs: 40, seed: 363 },
  ],
  plane_whoosh: [
    { preset: 'swing', pitch: 1.0, gainDb: 3, seed: 371 },
    { preset: 'shoot', pitch: 1.1, gainDb: -4, delayMs: 80, seed: 372 },
  ],
  roulette_tick: [{ preset: 'ui_click', pitch: 2.2, gainDb: -2, seed: 381 }],
  roulette_stop: [
    { preset: 'impact', pitch: 1.15, seed: 391 },
    { preset: 'ui_confirm', pitch: 0.75, gainDb: -5, delayMs: 25, seed: 392 },
  ],
};

async function run(command, args) {
  return execFileAsync(command, args, { maxBuffer: 20 * 1024 * 1024 });
}

function db(value) {
  return value === 0 ? '' : `volume=${value}dB,`;
}

async function main() {
  await mkdir(SFX_DIR, { recursive: true });

  try {
    await run(PYTHON, [AUDIO_GEN, 'list']);
    await run('ffmpeg', ['-version']);
  } catch (error) {
    console.error(`gen-sfx: missing dependency (${error.message})`);
    console.error(`audio_gen.py: ${AUDIO_GEN}`);
    process.exit(1);
  }

  const tmpDir = await mkdtemp(path.join(tmpdir(), 'fable-sfx-'));
  const layerCache = new Map();

  async function layerFile(layer) {
    const pitch = layer.pitch ?? 1;
    const gainDb = layer.gainDb ?? 0;
    const seed = layer.seed ?? 1;
    const key = `${layer.preset}|${pitch}|${gainDb}|${seed}`;
    const cached = layerCache.get(key);
    if (cached) return cached;

    const dir = path.join(tmpDir, `layer-${layerCache.size}`);
    await mkdir(dir, { recursive: true });
    await run(PYTHON, [
      AUDIO_GEN,
      'sfx',
      layer.preset,
      '--out',
      dir,
      '--seed',
      String(seed),
      '--pitch',
      String(pitch),
      '--gain',
      String(gainDb),
    ]);
    const file = path.join(dir, `${layer.preset}.wav`);
    layerCache.set(key, file);
    return file;
  }

  try {
    let sfxBytes = 0;
    for (const [name, layers] of Object.entries(SFX_RECIPES)) {
      const files = [];
      for (const layer of layers) files.push(await layerFile(layer));

      const inputs = files.flatMap((file) => ['-i', file]);
      const chains = layers.map((layer, index) => {
        const delay = layer.delayMs ?? 0;
        return `[${index}:a]adelay=delays=${delay}:all=1,${db(layer.gainDb ?? 0)}anull[l${index}]`;
      });

      let filter;
      if (layers.length === 1) {
        filter = `${chains[0].replace(/\[l0\]$/, '')},alimiter=limit=0.6:level=false[out]`;
      } else {
        const labels = layers.map((_, index) => `[l${index}]`).join('');
        const compensation = 20 * Math.log10(layers.length);
        filter =
          `${chains.join(';')};` +
          `${labels}amix=inputs=${layers.length}:duration=longest:normalize=1,` +
          `volume=${compensation.toFixed(1)}dB,alimiter=limit=0.6:level=false[out]`;
      }

      const outPath = path.join(SFX_DIR, `${name}.mp3`);
      await run('ffmpeg', [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        ...inputs,
        '-filter_complex',
        filter,
        '-map',
        '[out]',
        '-ac',
        '1',
        '-ar',
        '44100',
        '-c:a',
        'libmp3lame',
        '-b:a',
        '96k',
        '-map_metadata',
        '-1',
        outPath,
      ]);
      const info = await stat(outPath);
      sfxBytes += info.size;
      console.log(`sfx  ${name.padEnd(14)} ${(info.size / 1024).toFixed(1)} KB`);
    }

    console.log('');
    console.log(`sfx: ${Object.keys(SFX_RECIPES).length} files, ${(sfxBytes / 1024 / 1024).toFixed(2)} MB`);

    const sfxFiles = (await readdir(SFX_DIR)).filter((file) => file.endsWith('.mp3'));
    console.log(`present: ${sfxFiles.length} sfx`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

await main();