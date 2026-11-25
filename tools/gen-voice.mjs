#!/usr/bin/env node
// Pre-generates every voiced line with VOICEVOX and writes public/assets/voice/<hash>.mp3 plus
// manifest.json. Data files are read directly; narrator texts and hashes come from the TypeScript
// modules the client uses, so audio and subtitles can never drift apart.
//
// Usage: node tools/gen-voice.mjs [--dry-run] [--only=char|npc|event|narration|emote]

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { allNarrationTexts } from '../src/audio/narration.ts';
import { piperNarrationTexts, piperVoiceLines } from '../src/core/piperLines.ts';
import { voiceHash } from '../src/audio/voicekey.ts';
import { buildVoiceManifest, voiceMetaMatches } from '../src/audio/voice-manifest.ts';

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'src/data');
const VOICE_DIR = process.env.VOICE_OUT_DIR
  ? path.resolve(process.env.VOICE_OUT_DIR)
  : path.join(ROOT, 'public/assets/voice');
const VOICE_META_PATH = path.join(VOICE_DIR, 'voices.json');
const CANARY_PATH = path.join(ROOT, 'tools/voice-canary.json');
const DEFAULT_ENGINE = 'http://127.0.0.1:50021';
const CONCURRENCY = 2;
const MAX_ATTEMPTS = 3;
const VOICE_REVISION = 2;
const ENCODE_BITRATE = '64k';
const CHECK_RATE = 16000;
const CHECK_WINDOW = 1024;
const CHECK_HOP = 512;
const CHECK_MAX_SECONDS = 3;
const GROUPS = ['char', 'npc', 'event', 'narration', 'emote'];

const args = process.argv.slice(2);
let dryRun = false;
let force = false;
let only = null;
let limit = Infinity;
let checkOnly = false;
let failFirst = 0;
let engine = DEFAULT_ENGINE;
for (const arg of args) {
  if (arg === '--dry-run') {
    dryRun = true;
  } else if (arg === '--check-only') {
    checkOnly = true;
  } else if (arg.startsWith('--fail-first=')) {
    failFirst = Number.parseInt(arg.slice('--fail-first='.length), 10);
    if (!Number.isFinite(failFirst) || failFirst < 0) {
      console.error(`invalid --fail-first value "${arg}"`);
      process.exit(2);
    }
  } else if (arg.startsWith('--engine=')) {
    engine = arg.slice('--engine='.length).replace(/\/$/, '');
  } else if (arg === '--force') {
    force = true;
  } else if (arg.startsWith('--limit=')) {
    limit = Number.parseInt(arg.slice('--limit='.length), 10);
    if (!Number.isFinite(limit) || limit < 0) {
      console.error(`invalid --limit value "${arg}"`);
      process.exit(2);
    }
  } else if (arg.startsWith('--only=')) {
    only = arg.slice('--only='.length);
    if (!GROUPS.includes(only)) {
      console.error(`unknown --only value "${only}" (expected ${GROUPS.join('|')})`);
      process.exit(2);
    }
  } else if (arg === '--help' || arg === '-h') {
    console.log(
      'usage: node tools/gen-voice.mjs [--dry-run] [--force] [--check-only] [--limit=N] [--only=char|npc|event|narration|emote]',
    );
    process.exit(0);
  } else {
    console.error(`unknown argument "${arg}"`);
    process.exit(2);
  }
}

const items = [];
const itemsByHash = new Map();
const collectionErrors = [];

function addItem(groups, voiceKey, text, voice) {
  if (typeof text !== 'string' || text.trim().length === 0) return;
  if (!voice || typeof voice.speaker !== 'number') {
    collectionErrors.push({ voiceKey, text, error: 'missing or invalid VoiceSpec' });
    return;
  }
  const hash = voiceHash(voiceKey, text);
  const existing = itemsByHash.get(hash);
  if (existing) {
    for (const group of groups) existing.groups.add(group);
    if (existing.text !== text || existing.voiceKey !== voiceKey) {
      collectionErrors.push({
        voiceKey,
        text,
        error: `FNV-1a collision with ${existing.voiceKey}: "${existing.text}"`,
      });
    }
    return;
  }
  const item = { hash, voiceKey, text, voice, groups: new Set(groups) };
  itemsByHash.set(hash, item);
  items.push(item);
}

function addDialogue(lines, line) {
  const speaker = line?.speaker;
  const text = line?.text;
  if (speaker === 'self') {
    console.warn(`gen-voice: skipping a "self" event line (${JSON.stringify(text)})`);
    return;
  }
  if (speaker === 'narrator') {
    addItem(lines, 'narrator', text, narratorVoice);
    return;
  }
  if (typeof speaker !== 'string') return;
  if (speaker.startsWith('char:')) {
    const id = speaker.slice('char:'.length);
    const character = characterById.get(id);
    if (!character) {
      collectionErrors.push({ voiceKey: speaker, text, error: `unknown character "${id}"` });
      return;
    }
    addItem([...lines, 'char'], speaker, text, character.voice);
    return;
  }
  if (speaker.startsWith('npc:')) {
    const id = speaker.slice('npc:'.length);
    const npc = npcById.get(id);
    if (!npc) {
      collectionErrors.push({ voiceKey: speaker, text, error: `unknown npc "${id}"` });
      return;
    }
    addItem([...lines, 'npc'], speaker, text, npc.voice);
    return;
  }
  collectionErrors.push({ voiceKey: String(speaker), text, error: 'unknown speaker' });
}

async function readJson(name, fallback) {
  try {
    return JSON.parse(await readFile(path.join(DATA_DIR, name), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw error;
  }
}

const characters = await readJson('characters.json');
const npcs = await readJson('npcs.json');
const events = await readJson('events.json');
const cities = await readJson('cities.json');
const emotes = await readJson('emotes.json', null);

const characterById = new Map(characters.map((character) => [character.id, character]));
const npcById = new Map(npcs.map((npc) => [npc.id, npc]));
const narratorNpc = npcById.get('narrator');
const narratorVoice = narratorNpc?.voice;

if (!narratorVoice) {
  console.error('gen-voice: npcs.json has no "narrator" entry with a voice spec');
  process.exit(1);
}

// characters.json fixed lines
for (const character of characters) {
  for (const text of Object.values(character.lines ?? {})) {
    addItem(['char'], `char:${character.id}`, text, character.voice);
  }
}

// turnLines.json: 状況別の手番開始ボイス。character と同じ char:<id> キーで登録する
const turnLines = await readJson('turnLines.json', {});
if (!turnLines || typeof turnLines !== 'object' || Array.isArray(turnLines)) {
  console.warn('gen-voice: src/data/turnLines.json is not an object; skipping turn lines');
} else {
  for (const character of characters) {
    const situations = turnLines[character.id];
    if (!situations || typeof situations !== 'object') continue;
    for (const lines of Object.values(situations)) {
      if (!Array.isArray(lines)) continue;
      for (const text of lines) addItem(['char'], `char:${character.id}`, text, character.voice);
    }
  }
}

// events.json: intro lines + choice replies
for (const event of events) {
  for (const line of event.lines ?? []) addDialogue(['event'], line);
  for (const choice of event.choices ?? []) {
    for (const line of choice.reply ?? []) addDialogue(['event'], line);
  }
}

// emotes.json: every character gets a line (unique emotes: owner only); hitLines: all characters
if (Array.isArray(emotes)) {
  for (const emote of emotes) {
    const unique = emote.category === 'unique';
    const speakers = unique
      ? characters.filter((character) => character.id === emote.characterId)
      : characters;
    if (unique && speakers.length === 0) {
      console.warn(`gen-voice: unique emote "${emote.id}" has no known characterId; skipped`);
      continue;
    }
    for (const character of speakers) {
      const text = emote.lines?.[character.id] ?? emote.lines?.default;
      addItem(['emote'], `char:${character.id}`, text, character.voice);
    }
    if (emote.targeted && emote.hitLines) {
      for (const character of characters) {
        const text = emote.hitLines[character.id] ?? emote.hitLines.default;
        addItem(['emote'], `char:${character.id}`, text, character.voice);
      }
    }
  }
} else {
  console.warn('gen-voice: src/data/emotes.json not found; skipping emote lines');
}

// narration.ts: all 150 cities + generic lines
for (const text of allNarrationTexts(cities)) {
  addItem(['narration'], 'narrator', text, narratorVoice);
}

// 取り立て屋 (2026-11 fun overhaul): NPC の固定台詞 + 災害/善行/示談のナレーション。
// piperLines.ts が唯一の出典なので、字幕と音声がずれない。
for (const line of piperVoiceLines()) addDialogue(['npc'], line);
for (const text of piperNarrationTexts()) addDialogue(['narration'], { speaker: 'narrator', text });

function inGroup(item, group) {
  return group === null || item.groups.has(group);
}

/** Clarity-first VOICEVOX params. Per-character speed/pitch/intonation are ignored: 1.0/0/1.0
 * measured better CER than a global 0.95 slowdown, and extreme pitch/intonation values can hurt
 * intelligibility. Character identity still comes from the speaker style id. */
function voiceMeta(item) {
  return {
    speaker: item.voice.speaker,
    speed: 1.0,
    pitch: 0,
    intonation: 1.0,
    rev: VOICE_REVISION,
  };
}

function metaMatches(a, b) {
  return voiceMetaMatches(a, b);
}

let previousMeta = {};
try {
  const raw = JSON.parse(await readFile(VOICE_META_PATH, 'utf8'));
  if (raw && typeof raw === 'object') previousMeta = raw;
} catch {
  /* first run after this change: no sidecar yet */
}

let previousManifest = {};
try {
  const raw = JSON.parse(await readFile(path.join(VOICE_DIR, 'manifest.json'), 'utf8'));
  if (raw && typeof raw === 'object') previousManifest = raw;
} catch {
  /* no manifest yet */
}

const currentMeta = { ...previousMeta };

function mp3Path(item) {
  return path.join(VOICE_DIR, `${item.hash}.mp3`);
}

function isPresent(item) {
  try {
    if (statSync(mp3Path(item)).size <= 0) return false;
    return metaMatches(currentMeta[item.hash], voiceMeta(item));
  } catch {
    return false;
  }
}

function groupCounts() {
  const counts = Object.fromEntries(GROUPS.map((group) => [group, 0]));
  for (const item of items) {
    for (const group of item.groups) counts[group] += 1;
  }
  return counts;
}

const selected = items.filter((item) => inGroup(item, only));
const missing = selected.filter((item) => force || !isPresent(item));
const present = force
  ? items.filter((item) => !inGroup(item, only) && isPresent(item))
  : items.filter(isPresent);

if (dryRun) {
  const counts = groupCounts();
  console.log(`voice items: ${items.length} unique (${selected.length} in scope${only ? `: ${only}` : ''})`);
  console.log(`groups: ${GROUPS.map((group) => `${group}=${counts[group]}`).join('  ')}`);
  console.log(`present: ${present.length}  missing: ${missing.length}`);
  console.log(`collection problems: ${collectionErrors.length}`);
  for (const problem of collectionErrors.slice(0, 10)) {
    console.error(`  - ${problem.voiceKey}: ${problem.error}: ${problem.text}`);
  }
  process.exit(0);
}

// Engine preflight: fail fast with the exact command to start VOICEVOX.
let speakerNames;
try {
  const response = await fetch(`${engine}/speakers`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  speakerNames = new Map();
  for (const speaker of await response.json()) {
    for (const style of speaker.styles ?? []) speakerNames.set(style.id, speaker.name);
  }
} catch (error) {
  console.error(`gen-voice: VOICEVOX is not reachable at ${engine} (${error.message})`);
  console.error(
    'Start it with: podman run -d --rm --name voicevox -p 127.0.0.1:50021:50021 docker.io/voicevox/voicevox_engine:cpu-latest',
  );
  process.exit(1);
}

// Validate speaker ids before spending synthesis calls.
const badVoices = items.filter((item) => !speakerNames.has(item.voice.speaker));
for (const item of badVoices) {
  collectionErrors.push({
    voiceKey: item.voiceKey,
    text: item.text,
    error: `speaker style id ${item.voice.speaker} does not exist in VOICEVOX`,
  });
}
const runnable = missing
  .filter((item) => speakerNames.has(item.voice.speaker))
  .slice(0, limit);

console.log(
  `gen-voice: ${items.length} unique lines, ${present.length} present, ` +
    `${missing.length} missing, ${runnable.length} to generate (concurrency ${CONCURRENCY})`,
);

await mkdir(VOICE_DIR, { recursive: true });
const tmpDir = await mkdtemp(path.join(tmpdir(), 'fable-voice-'));

try {
  await execFileAsync('ffmpeg', ['-version']);
} catch {
  console.error('gen-voice: ffmpeg is required but was not found on PATH');
  process.exit(1);
}

async function synthesizeToWav(text, speaker, params) {
  const queryUrl = `${engine}/audio_query?${new URLSearchParams({
    speaker: String(speaker),
    text,
  })}`;
  const queryResponse = await fetch(queryUrl, {
    method: 'POST',
    signal: AbortSignal.timeout(60_000),
  });
  if (!queryResponse.ok) {
    throw new Error(`audio_query HTTP ${queryResponse.status}: ${(await queryResponse.text()).slice(0, 200)}`);
  }
  const query = await queryResponse.json();
  query.speedScale = params.speed;
  query.pitchScale = params.pitch;
  query.intonationScale = params.intonation;
  query.volumeScale = 1.0;
  query.prePhonemeLength = 0.05;
  query.postPhonemeLength = 0.12;

  const synthesisResponse = await fetch(
    `${engine}/synthesis?${new URLSearchParams({ speaker: String(speaker) })}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(query),
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!synthesisResponse.ok) {
    throw new Error(
      `synthesis HTTP ${synthesisResponse.status}: ${(await synthesisResponse.text()).slice(0, 200)}`,
    );
  }
  return Buffer.from(await synthesisResponse.arrayBuffer());
}

const CHECK_HANN = new Float64Array(CHECK_WINDOW);
for (let i = 0; i < CHECK_WINDOW; i += 1) {
  CHECK_HANN[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (CHECK_WINDOW - 1));
}
const CHECK_BIN_LO = Math.ceil((100 * CHECK_WINDOW) / CHECK_RATE);
const CHECK_BIN_HI = Math.floor((8000 * CHECK_WINDOW) / CHECK_RATE);

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let tmp = re[i];
      re[i] = re[j];
      re[j] = tmp;
      tmp = im[i];
      im[i] = im[j];
      im[j] = tmp;
    }
  }
  for (let length = 2; length <= n; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    const half = length >> 1;
    for (let start = 0; start < n; start += length) {
      let cr = 1;
      let ci = 0;
      for (let offset = 0; offset < half; offset += 1) {
        const a = start + offset;
        const b = a + half;
        const vr = re[b] * cr - im[b] * ci;
        const vi = re[b] * ci + im[b] * cr;
        const ur = re[a];
        const ui = im[a];
        re[a] = ur + vr;
        im[a] = ui + vi;
        re[b] = ur - vr;
        im[b] = ui - vi;
        const nextCr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nextCr;
      }
    }
  }
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))];
}

function std(values) {
  if (values.length === 0) return 0;
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

/** Cheap speech-vs-noise check used after synthesis and after MP3 encoding. */
async function analyzeSpeech(file) {
  const { stdout } = await execFileAsync(
    'ffmpeg',
    ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(CHECK_RATE), '-f', 'f32le', '-'],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
  );
  const pcm = new Float32Array(
    stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + stdout.byteLength),
  );
  const maxSamples = Math.min(pcm.length, CHECK_RATE * CHECK_MAX_SECONDS);
  const flat = [];
  const centroids = [];
  const zcrs = [];
  const rmsValues = [];

  for (let start = 0; start + CHECK_WINDOW <= maxSamples; start += CHECK_HOP) {
    const re = new Float64Array(CHECK_WINDOW);
    const im = new Float64Array(CHECK_WINDOW);
    let sum = 0;
    let sumSq = 0;
    let crossings = 0;
    let previousSign = pcm[start] >= 0;
    for (let i = 0; i < CHECK_WINDOW; i += 1) {
      const sample = pcm[start + i];
      sum += sample;
      sumSq += sample * sample;
      const sign = sample >= 0;
      if (sign !== previousSign) crossings += 1;
      previousSign = sign;
    }
    const frameMean = sum / CHECK_WINDOW;
    const rms = Math.sqrt(sumSq / CHECK_WINDOW);
    if (rms < 1e-3) continue;
    for (let i = 0; i < CHECK_WINDOW; i += 1) {
      re[i] = (pcm[start + i] - frameMean) * CHECK_HANN[i];
    }
    fft(re, im);

    let logSum = 0;
    let powerSum = 0;
    let centroidWeighted = 0;
    let bins = 0;
    for (let bin = CHECK_BIN_LO; bin <= CHECK_BIN_HI; bin += 1) {
      const power = re[bin] * re[bin] + im[bin] * im[bin] + 1e-20;
      logSum += Math.log(power);
      powerSum += power;
      centroidWeighted += power * ((bin * CHECK_RATE) / CHECK_WINDOW);
      bins += 1;
    }
    flat.push(Math.exp(logSum / bins) / (powerSum / bins));
    centroids.push(centroidWeighted / powerSum);
    zcrs.push(crossings / CHECK_WINDOW);
    rmsValues.push(rms);
  }

  if (flat.length < 3) {
    return { ok: false, reasons: ['too little speech energy'], frames: flat.length };
  }
  const flatMean = mean(flat);
  const flatMed = median(flat);
  const centroidMean = mean(centroids);
  const centroidStd = std(centroids);
  const zcrMean = mean(zcrs);
  const rmsDb = 20 * Math.log10(mean(rmsValues) + 1e-12);
  const rmsCv = std(rmsValues) / (mean(rmsValues) + 1e-12);
  const reasons = [];
  if (flatMed > 0.055) reasons.push(`flat_med ${flatMed.toFixed(3)} > 0.055`);
  if (centroidStd < 700 && flatMed > 0.04) reasons.push('stationary/high-flat spectrum');
  if (zcrMean > 0.35) reasons.push(`zcr ${zcrMean.toFixed(2)} > 0.35`);
  if (rmsDb < -38) reasons.push(`rms ${rmsDb.toFixed(1)} dB < -38`);
  if (rmsCv > 1.3) reasons.push(`rms_cv ${rmsCv.toFixed(2)} > 1.30`);
  return {
    ok: reasons.length === 0,
    reasons,
    frames: flat.length,
    features: {
      flatMean,
      flatMed,
      flatP90: percentile(flat, 90),
      centroidMean,
      centroidStd,
      zcrMean,
      rmsDb,
      rmsCv,
    },
  };
}

async function checkCanary() {
  let spec;
  try {
    spec = JSON.parse(await readFile(CANARY_PATH, 'utf8'));
  } catch {
    console.error(`gen-voice: missing canary ${path.relative(ROOT, CANARY_PATH)}; refusing to batch-generate`);
    process.exit(1);
  }
  const wav = await synthesizeToWav(spec.text, spec.speaker, {
    speed: spec.speed,
    pitch: spec.pitch,
    intonation: spec.intonation,
  });
  const hash = createHash('sha256').update(wav).digest('hex');
  if (hash !== spec.sha256) {
    console.error('gen-voice: VOICEVOX canary mismatch — the engine is returning corrupted/not-speech audio.');
    console.error(`  expected ${spec.sha256}`);
    console.error(`  got      ${hash}`);
    console.error('Restart the engine and retry: podman restart voicevox');
    process.exit(1);
  }
  const canaryPath = path.join(tmpDir, 'canary.wav');
  await writeFile(canaryPath, wav);
  const check = await analyzeSpeech(canaryPath);
  await rm(canaryPath, { force: true });
  if (!check.ok) {
    console.error(`gen-voice: VOICEVOX canary failed speech check: ${check.reasons.join('; ')}`);
    console.error('Restart the engine and retry: podman restart voicevox');
    process.exit(1);
  }
  console.log('gen-voice: canary OK');
}

let forcedFailuresRemaining = failFirst;

async function synthesize(item) {
  const meta = voiceMeta(item);
  const outPath = mp3Path(item);
  const tempPath = `${outPath}.tmp.mp3`;
  const wavPath = path.join(tmpDir, `${item.hash}.wav`);
  let lastError;
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        if (forcedFailuresRemaining > 0) {
          forcedFailuresRemaining -= 1;
          throw new Error('forced failure (--fail-first)');
        }
        const wav = await synthesizeToWav(item.text, meta.speaker, meta);
        await writeFile(wavPath, wav);
        const wavCheck = await analyzeSpeech(wavPath);
        if (!wavCheck.ok) {
          throw new Error(`speech check failed (wav): ${wavCheck.reasons.join('; ')}`);
        }
        await execFileAsync('ffmpeg', [
          '-y',
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          wavPath,
          '-af',
          'loudnorm=I=-18:TP=-2.0:LRA=11',
          '-ac',
          '1',
          '-ar',
          '24000',
          '-c:a',
          'libmp3lame',
          '-b:a',
          ENCODE_BITRATE,
          tempPath,
        ]);
        const info = await stat(tempPath);
        if (info.size < 100) throw new Error(`ffmpeg produced an empty mp3 (${info.size} bytes)`);
        const mp3Check = await analyzeSpeech(tempPath);
        if (!mp3Check.ok) {
          throw new Error(`speech check failed (mp3): ${mp3Check.reasons.join('; ')}`);
        }
        await rename(tempPath, outPath);
        metaFallback.delete(item.hash);
        currentMeta[item.hash] = meta;
        return info.size;
      } catch (error) {
        lastError = error;
        await rm(wavPath, { force: true });
        await rm(tempPath, { force: true });
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
      }
    }
    throw new Error(`all ${MAX_ATTEMPTS} attempts failed: ${lastError?.message ?? lastError}`);
  } finally {
    await rm(wavPath, { force: true });
    await rm(tempPath, { force: true });
  }
}

await checkCanary();

if (checkOnly) {
  const targets = items.filter((item) => {
    try {
      return statSync(mp3Path(item)).size > 0;
    } catch {
      return false;
    }
  });
  let cursor = 0;
  let checked = 0;
  let bad = 0;
  async function checkWorker() {
    for (;;) {
      const index = cursor++;
      if (index >= targets.length) return;
      const item = targets[index];
      checked += 1;
      const result = await analyzeSpeech(mp3Path(item));
      if (!result.ok) {
        bad += 1;
        console.log(`BAD ${item.voiceKey}: ${result.reasons.join('; ')} :: ${item.text.slice(0, 30)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, targets.length) }, () => checkWorker()));
  console.log(`speech check: ${checked - bad}/${checked} OK, ${bad} bad`);
  await rm(tmpDir, { recursive: true, force: true });
  process.exit(bad > 0 ? 1 : 0);
}

async function checkpointMeta() {
  await writeFile(VOICE_META_PATH, `${JSON.stringify(currentMeta, null, 2)}\n`);
}

/** Hash -> true when a failed regeneration left an existing mp3 that passed speech QC. */
const metaFallback = new Map();

const failures = [...collectionErrors];
let generated = 0;
let generatedBytes = 0;
const startedAt = Date.now();
let nextIndex = 0;
let processed = 0;

async function worker() {
  for (;;) {
    const index = nextIndex++;
    if (index >= runnable.length) return;
    const item = runnable[index];
    try {
      generatedBytes += await synthesize(item);
      generated += 1;
      if (generated % 20 === 0) await checkpointMeta();
    } catch (error) {
      const failure = { voiceKey: item.voiceKey, text: item.text, error: String(error?.message ?? error) };
      failures.push(failure);
      console.error(`  FAILED ${item.voiceKey}: ${failure.error} :: ${item.text.slice(0, 40)}`);
      try {
        if (statSync(mp3Path(item)).size > 0) {
          const existing = await analyzeSpeech(mp3Path(item));
          if (existing.ok) metaFallback.set(item.hash, true);
        }
      } catch {
        /* no existing file: nothing to keep */
      }
    }
    processed += 1;
    if (processed % 10 === 0 || processed === runnable.length) {
      const elapsed = (Date.now() - startedAt) / 1000;
      const rate = processed / Math.max(elapsed, 0.001);
      process.stdout.write(
        `  [${processed}/${runnable.length}] ${elapsed.toFixed(1)}s, ${rate.toFixed(2)} lines/s, ` +
          `${failures.length} failures\n`,
      );
    }
  }
}

await Promise.all(Array.from({ length: Math.min(CONCURRENCY, runnable.length) }, () => worker()));

const elapsed = (Date.now() - startedAt) / 1000;

// Manifest: verified files plus failed items whose existing mp3 passes speech QC now, plus
// previously-published stale entries that were outside this partial run (--only / --limit).
// Anything else (missing file, or unverified old noise) stays out of the manifest.
const attemptedHashes = new Set(runnable.map((item) => item.hash));
const candidates = [];
for (const item of items) {
  let hasFile = false;
  try {
    hasFile = statSync(mp3Path(item)).size > 0;
  } catch {
    hasFile = false;
  }
  const desired = voiceMeta(item);
  const prev = currentMeta[item.hash];
  const wasAttempted = attemptedHashes.has(item.hash);
  const preservedStale =
    hasFile &&
    !wasAttempted &&
    prev?.stale === true &&
    typeof previousManifest[item.hash] === 'string' &&
    previousManifest[item.hash].length > 0;
  candidates.push({
    hash: item.hash,
    desired,
    hasFile,
    verified: hasFile && metaMatches(prev, desired),
    fallbackVerified: hasFile && metaFallback.get(item.hash) === true,
    preservedStale,
    previousMeta: prev,
  });
}
const { manifest, meta: nextMeta, stale: staleHashes } = buildVoiceManifest(candidates);
const manifestPath = path.join(VOICE_DIR, 'manifest.json');
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(VOICE_META_PATH, `${JSON.stringify(nextMeta, null, 2)}\n`);

// Remove stale mp3s that no current item references.
let removedOrphans = 0;
const keep = new Set(items.map((item) => `${item.hash}.mp3`));
for (const file of await readdir(VOICE_DIR)) {
  if (file.endsWith('.mp3') && !keep.has(file)) {
    await rm(path.join(VOICE_DIR, file), { force: true });
    removedOrphans += 1;
  }
}

let voiceBytes = 0;
let voiceFiles = 0;
for (const file of await readdir(VOICE_DIR)) {
  if (!file.endsWith('.mp3')) continue;
  voiceBytes += (await stat(path.join(VOICE_DIR, file))).size;
  voiceFiles += 1;
}

const usedSpeakers = new Map();
for (const item of items) {
  if (!manifest[item.hash]) continue;
  const name = speakerNames.get(item.voice.speaker);
  if (name) usedSpeakers.set(`${name}\t${item.voice.speaker}`, name);
}

console.log('');
console.log(`generated: ${generated} (${(generatedBytes / 1024 / 1024).toFixed(2)} MB)`);
console.log(`skipped already present: ${selected.length - missing.length} in scope, ${present.length} total`);
console.log(`failures: ${failures.length}`);
console.log(`orphan mp3 removed: ${removedOrphans}`);
console.log(`manifest entries: ${Object.keys(manifest).length} -> ${path.relative(ROOT, manifestPath)}`);
console.log(`parameter sidecar: ${Object.keys(nextMeta).length} -> ${path.relative(ROOT, VOICE_META_PATH)}`);
console.log(`stale entries kept for retry: ${staleHashes.length}`);
console.log(
  `voice library: ${voiceFiles} files, ${(voiceBytes / 1024 / 1024).toFixed(2)} MB ` +
    `(avg ${(voiceBytes / Math.max(voiceFiles, 1) / 1024).toFixed(1)} KB/file)`,
);
console.log(`elapsed: ${elapsed.toFixed(1)}s (${(elapsed / Math.max(generated, 1)).toFixed(2)} s/line generated)`);
console.log(
  `speakers used: ${[...new Set(usedSpeakers.values())].map((name) => `VOICEVOX:${name}`).join(', ')}`,
);
if (failures.length > 0) {
  console.log('failures:');
  for (const failure of failures.slice(0, 40)) {
    console.log(`  - ${failure.voiceKey}: ${failure.error} :: ${failure.text.slice(0, 40)}`);
  }
  if (failures.length > 40) console.log(`  ... and ${failures.length - 40} more`);
}

await rm(tmpDir, { recursive: true, force: true });
process.exit(failures.length > 0 ? 1 : 0);