#!/usr/bin/env node
// Pre-generates every voiced line with VOICEVOX and writes public/assets/voice/<hash>.mp3 plus
// manifest.json. Data files are read directly; narrator texts and hashes come from the TypeScript
// modules the client uses, so audio and subtitles can never drift apart.
//
// Usage: node tools/gen-voice.mjs [--dry-run] [--only=char|npc|event|narration|emote]

import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { allNarrationTexts } from '../src/audio/narration.ts';
import { voiceHash } from '../src/audio/voicekey.ts';

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'src/data');
const VOICE_DIR = path.join(ROOT, 'public/assets/voice');
const ENGINE = 'http://127.0.0.1:50021';
const CONCURRENCY = 2;
const GROUPS = ['char', 'npc', 'event', 'narration', 'emote'];

const args = process.argv.slice(2);
let dryRun = false;
let only = null;
for (const arg of args) {
  if (arg === '--dry-run') {
    dryRun = true;
  } else if (arg.startsWith('--only=')) {
    only = arg.slice('--only='.length);
    if (!GROUPS.includes(only)) {
      console.error(`unknown --only value "${only}" (expected ${GROUPS.join('|')})`);
      process.exit(2);
    }
  } else if (arg === '--help' || arg === '-h') {
    console.log('usage: node tools/gen-voice.mjs [--dry-run] [--only=char|npc|event|narration|emote]');
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

function inGroup(item, group) {
  return group === null || item.groups.has(group);
}

function mp3Path(item) {
  return path.join(VOICE_DIR, `${item.hash}.mp3`);
}

function isPresent(item) {
  try {
    return statSync(mp3Path(item)).size > 0;
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
const missing = selected.filter((item) => !isPresent(item));
const present = items.filter(isPresent);

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
  const response = await fetch(`${ENGINE}/speakers`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  speakerNames = new Map();
  for (const speaker of await response.json()) {
    for (const style of speaker.styles ?? []) speakerNames.set(style.id, speaker.name);
  }
} catch (error) {
  console.error(`gen-voice: VOICEVOX is not reachable at ${ENGINE} (${error.message})`);
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
const runnable = missing.filter((item) => speakerNames.has(item.voice.speaker));

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

async function synthesize(item) {
  const queryUrl = `${ENGINE}/audio_query?${new URLSearchParams({
    speaker: String(item.voice.speaker),
    text: item.text,
  })}`;
  const queryResponse = await fetch(queryUrl, {
    method: 'POST',
    signal: AbortSignal.timeout(60_000),
  });
  if (!queryResponse.ok) {
    throw new Error(`audio_query HTTP ${queryResponse.status}: ${(await queryResponse.text()).slice(0, 200)}`);
  }
  const query = await queryResponse.json();
  query.speedScale = 1.0;
  query.pitchScale = 1.0;
  query.intonationScale = 1.0;
  query.volumeScale = 1.0;
  query.prePhonemeLength = 0.05;
  query.postPhonemeLength = 0.12;

  const synthesisResponse = await fetch(
    `${ENGINE}/synthesis?${new URLSearchParams({ speaker: String(item.voice.speaker) })}`,
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

  const wavPath = path.join(tmpDir, `${item.hash}.wav`);
  const outPath = mp3Path(item);
  const tempPath = `${outPath}.tmp.mp3`;
  await writeFile(wavPath, Buffer.from(await synthesisResponse.arrayBuffer()));
  try {
    await execFileAsync('ffmpeg', [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      wavPath,
      '-af',
      'loudnorm=I=-18:TP=-1.5:LRA=11',
      '-ac',
      '1',
      '-ar',
      '24000',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '40k',
      tempPath,
    ]);
    const info = await stat(tempPath);
    if (info.size < 100) throw new Error(`ffmpeg produced an empty mp3 (${info.size} bytes)`);
    await rename(tempPath, outPath);
    return info.size;
  } finally {
    await rm(wavPath, { force: true });
    await rm(tempPath, { force: true });
  }
}

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
    } catch (error) {
      const failure = { voiceKey: item.voiceKey, text: item.text, error: String(error?.message ?? error) };
      failures.push(failure);
      console.error(`  FAILED ${item.voiceKey}: ${failure.error} :: ${item.text.slice(0, 40)}`);
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

// Manifest: every current item that actually has a file (not just this scope).
const manifest = {};
for (const item of items) {
  if (isPresent(item)) manifest[item.hash] = `voice/${item.hash}.mp3`;
}
const manifestPath = path.join(VOICE_DIR, 'manifest.json');
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

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
  if (!isPresent(item)) continue;
  const name = speakerNames.get(item.voice.speaker);
  if (name) usedSpeakers.set(`${name}\t${item.voice.speaker}`, name);
}

console.log('');
console.log(`generated: ${generated} (${(generatedBytes / 1024 / 1024).toFixed(2)} MB)`);
console.log(`skipped already present: ${selected.length - missing.length} in scope, ${present.length} total`);
console.log(`failures: ${failures.length}`);
console.log(`orphan mp3 removed: ${removedOrphans}`);
console.log(`manifest entries: ${Object.keys(manifest).length} -> ${path.relative(ROOT, manifestPath)}`);
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