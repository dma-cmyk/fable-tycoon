#!/usr/bin/env node
// Downloads the game's BGM from incompetech.com (CC BY 4.0), verifies the license page, cuts a
// bar-aligned loop with a short crossfade, normalizes to -22 LUFS and writes:
//   public/assets/bgm/<id>.mp3
//   public/assets/bgm/bgm.json  ({ id: { file, loopStart, loopEnd } })
//
// The ids must match BgmName in src/audio/audio.ts. Procedural audio_gen.py tracks are only used
// as a fallback when an official download or conversion fails.
//
// Usage: node tools/fetch-bgm.mjs

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BGM_DIR = path.join(ROOT, 'public/assets/bgm');
const CACHE_DIR = path.join(ROOT, '.tmp/bgm-source');
const PYTHON = process.env.PYTHON ?? 'python3';
const AUDIO_GEN = path.join(
  process.env.HOME ?? '',
  '.omp/agent/skills/game-production/scripts/audio_gen.py',
);
const CATALOG_URL = 'https://incompetech.com/music/royalty-free/pieces.json';
const TRACK_PAGE = 'https://incompetech.com/music/royalty-free/index.html?isrc=';
const MP3_BASE = 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/';
const CROSSFADE_SECONDS = 3;
const LOOP_BARS = 32;
const TARGET_LUFS = -22;
const TARGET_TRUE_PEAK = -1.5;

// id -> track. BPM/bars decide a bar-aligned loop; the actual file may be longer.
const TRACKS = [
  {
    id: 'title',
    isrc: 'USUAN1100768',
    title: 'Fluffing a Duck',
    fit: 'cute comedic title theme',
    bpm: 122,
    fallback: { style: 'chip', bpm: 122, key: 'C', mode: 'major', progression: 'I V vi IV', seed: 11 },
  },
  {
    id: 'lobby',
    isrc: 'USUAN1400054',
    title: 'Life of Riley',
    fit: 'welcoming lobby / setup',
    bpm: 102,
    fallback: { style: 'soft', bpm: 102, key: 'G', mode: 'major', progression: 'I V vi IV', seed: 12 },
  },
  {
    id: 'board_a',
    isrc: 'USUAN1400011',
    title: 'Monkeys Spinning Monkeys',
    fit: 'upbeat board rotation A',
    bpm: 144,
    fallback: { style: 'chip', bpm: 144, key: 'G', mode: 'major', progression: 'I vi IV V', seed: 13 },
  },
  {
    id: 'board_b',
    isrc: 'USUAN1100833',
    title: 'Pixel Peeker Polka - faster',
    fit: 'bouncy board rotation B',
    bpm: 144,
    fallback: { style: 'chip', bpm: 144, key: 'D', mode: 'major', progression: 'I V vi IV', seed: 14 },
  },
  {
    id: 'board_c',
    isrc: 'USUAN1400037',
    title: 'Carefree',
    fit: 'light board rotation C',
    bpm: 96,
    fallback: { style: 'soft', bpm: 96, key: 'F', mode: 'major', progression: 'I IV V I', seed: 15 },
  },
  {
    id: 'event_news',
    isrc: 'USUAN1100646',
    title: 'Investigations',
    fit: 'news event, curious/comic',
    bpm: 94,
    fallback: { style: 'drive', bpm: 94, key: 'A', mode: 'minor', progression: 'i VI III VII', seed: 16 },
  },
  {
    id: 'event_history',
    isrc: 'USUAN1400020',
    title: 'Teller of the Tales',
    fit: 'history event, storytelling',
    bpm: 130,
    fallback: { style: 'soft', bpm: 130, key: 'D', mode: 'minor', progression: 'i VI III VII', seed: 17 },
  },
  {
    id: 'event_fable',
    isrc: 'USUAN1100085',
    title: 'Scheming Weasel (faster version)',
    fit: 'fable event, cartoonish and dark',
    bpm: 168,
    fallback: { style: 'chip', bpm: 168, key: 'A', mode: 'minor', progression: 'i VI III VII', seed: 18 },
  },
  {
    id: 'event_crisis',
    isrc: 'USUAN1400039',
    title: 'Volatile Reaction',
    fit: 'crash / bubble burst / bank run',
    bpm: 155,
    fallback: { style: 'drive', bpm: 155, key: 'E', mode: 'minor', progression: 'i VI III VII', seed: 19 },
  },
  {
    id: 'piper',
    isrc: 'USUAN1100772',
    title: 'Sneaky Snitch',
    fit: 'collection agent, sinister comic',
    bpm: 87,
    fallback: { style: 'chip', bpm: 87, key: 'C', mode: 'minor', progression: 'i VI III VII', seed: 20 },
  },
  {
    id: 'yearend',
    isrc: 'USUAN1300012',
    title: 'Local Forecast - Elevator',
    fit: 'calm year-end settlement',
    bpm: 82,
    fallback: { style: 'soft', bpm: 82, key: 'F', mode: 'major', progression: 'I IV V I', seed: 21 },
  },
  {
    id: 'result',
    isrc: 'USUAN1100843',
    title: 'Wallpaper',
    fit: 'results screen, bright and calm',
    bpm: 92,
    fallback: { style: 'soft', bpm: 92, key: 'G', mode: 'major', progression: 'I V vi IV', seed: 22 },
  },
];

async function run(command, args, options = {}) {
  return execFileAsync(command, args, { maxBuffer: 64 * 1024 * 1024, ...options });
}

async function curlText(url) {
  const { stdout } = await run('curl', [
    '-sSL',
    '--fail',
    '--retry',
    '2',
    '--retry-delay',
    '2',
    '-A',
    'fable-tycoon/0.1 (audio asset fetch)',
    url,
  ]);
  return stdout;
}

async function probeDuration(file) {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=nw=1:nk=1',
    file,
  ]);
  const duration = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`bad duration for ${file}`);
  return duration;
}

async function measureLoudness(file) {
  const { stderr } = await run('ffmpeg', [
    '-hide_banner',
    '-i',
    file,
    '-af',
    `loudnorm=I=${TARGET_LUFS}:TP=${TARGET_TRUE_PEAK}:print_format=json`,
    '-f',
    'null',
    '-',
  ]);
  const match = stderr.match(/\{[^{}]*"input_i"[^{}]*\}/);
  if (!match) throw new Error(`could not read loudness from ffmpeg for ${file}`);
  const data = JSON.parse(match[0]);
  const inputI = Number.parseFloat(data.input_i);
  const inputTp = Number.parseFloat(data.input_tp);
  if (!Number.isFinite(inputI)) throw new Error(`no integrated loudness for ${file}`);
  const gain = Math.min(
    TARGET_LUFS - inputI,
    Number.isFinite(inputTp) ? TARGET_TRUE_PEAK - inputTp : Infinity,
  );
  return { inputI, inputTp, gainDb: gain };
}

const LOOP_CANDIDATE_BARS = Array.from({ length: 57 }, (_, index) => 8 + index);
const ANALYSIS_RATE = 22050;
const SILENCE_DB = -45;

async function analyzeTrack(track, sourceFile) {
  const { stdout } = await run(
    'ffmpeg',
    ['-v', 'error', '-i', sourceFile, '-ac', '1', '-ar', String(ANALYSIS_RATE), '-f', 'f32le', '-'],
    { encoding: 'buffer' },
  );
  const pcm = new Float32Array(
    stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + stdout.byteLength),
  );
  const window = Math.max(1, Math.floor(ANALYSIS_RATE * 0.1));
  const silenceThreshold = 10 ** (SILENCE_DB / 20);
  let offsetSamples = 0;
  while (
    offsetSamples < pcm.length &&
    offsetSamples < ANALYSIS_RATE * 2 &&
    Math.abs(pcm[offsetSamples]) <= silenceThreshold
  ) {
    offsetSamples += 1;
  }

  const db = (start, end) => {
    const from = Math.max(0, start);
    const to = Math.min(pcm.length, end);
    if (to <= from) return Number.NEGATIVE_INFINITY;
    let sum = 0;
    for (let i = from; i < to; i += 1) sum += pcm[i] * pcm[i];
    const rms = Math.sqrt(sum / (to - from));
    return rms > 0 ? 20 * Math.log10(rms) : Number.NEGATIVE_INFINITY;
  };

  const headDb = db(offsetSamples, offsetSamples + window);
  let best = null;
  for (const bars of LOOP_CANDIDATE_BARS) {
    const loopLength = (bars * 4 * 60) / track.bpm;
    if (!Number.isFinite(loopLength) || loopLength <= 0) continue;
    const end = offsetSamples + Math.round(loopLength * ANALYSIS_RATE);
    if (end + Math.round(CROSSFADE_SECONDS * ANALYSIS_RATE) > pcm.length) continue;
    const preDb = db(end - window, end);
    const postDb = db(end, end + window);
    if (!Number.isFinite(preDb) || !Number.isFinite(postDb) || preDb < -50 || postDb < -50) continue;
    const score =
      Math.abs(preDb - postDb) +
      Math.abs(postDb - headDb) * 0.35 +
      Math.abs(bars - LOOP_BARS) * 0.08;
    if (!best || score < best.score) best = { bars, loopLength, preDb, postDb, score };
  }
  if (!best) {
    const fallbackLength = Math.min(
      (LOOP_BARS * 4 * 60) / track.bpm,
      pcm.length / ANALYSIS_RATE - CROSSFADE_SECONDS - 0.25,
    );
    best = {
      bars: LOOP_BARS,
      loopLength: fallbackLength,
      preDb: Number.NEGATIVE_INFINITY,
      postDb: Number.NEGATIVE_INFINITY,
      score: Infinity,
    };
  }

  return {
    offset: offsetSamples / ANALYSIS_RATE,
    loopLength: best.loopLength,
    bars: best.bars,
    headDb,
    preDb: best.preDb,
    postDb: best.postDb,
  };
}

async function processTrack(track, sourceFile, outPath) {
  const duration = await probeDuration(sourceFile);
  const analysis = await analyzeTrack(track, sourceFile);
  const start = analysis.offset;
  const loopLength = Math.min(analysis.loopLength, duration - start - CROSSFADE_SECONDS - 0.2);
  if (!Number.isFinite(loopLength) || loopLength < 10) {
    throw new Error(`could not find a usable loop for ${track.id}`);
  }
  const x = CROSSFADE_SECONDS;
  const edgeFade = 0.02;
  const loopWav = path.join(path.dirname(outPath), `${track.id}-loop.wav`);

  const filter = [
    `[0:a]atrim=start=${start.toFixed(4)}:end=${(start + loopLength).toFixed(4)},asetpts=PTS-STARTPTS[head]`,
    `[0:a]atrim=start=${(start + loopLength).toFixed(4)}:end=${(start + loopLength + x).toFixed(4)},asetpts=PTS-STARTPTS[tail]`,
    '[head]asplit=2[headA][headB]',
    `[tail]afade=t=out:st=0:d=${x}[tailF]`,
    `[headA]atrim=start=0:end=${x},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${x}[headF]`,
    '[headF][tailF]amix=inputs=2:duration=longest:normalize=0[blend]',
    `[blend]atrim=start=0:end=${x},asetpts=PTS-STARTPTS[blendTrim]`,
    `[headB]atrim=start=${x}:end=${loopLength},asetpts=PTS-STARTPTS[rest]`,
    '[blendTrim][rest]concat=n=2:v=0:a=1,' +
      `afade=t=in:st=0:d=${edgeFade},` +
      `afade=t=out:st=${Math.max(0, loopLength - edgeFade).toFixed(4)}:d=${edgeFade},` +
      'alimiter=limit=0.98:level=false[loop]',
  ].join(';');

  await run('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    sourceFile,
    '-filter_complex',
    filter,
    '-map',
    '[loop]',
    '-ac',
    '2',
    '-ar',
    '44100',
    '-c:a',
    'pcm_s16le',
    loopWav,
  ]);

  const loudness = await measureLoudness(loopWav);
  console.log(
    `  offset ${start.toFixed(3)}s, ${analysis.bars} bars -> loop ${loopLength.toFixed(2)}s ` +
      `(source head ${analysis.headDb.toFixed(1)}, pre ${analysis.preDb.toFixed(1)}, ` +
      `post ${analysis.postDb.toFixed(1)} dBFS), ` +
      `loudness ${loudness.inputI.toFixed(1)} LUFS, gain ${loudness.gainDb.toFixed(1)} dB`,
  );

  await run('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    loopWav,
    '-af',
    `volume=${loudness.gainDb.toFixed(2)}dB`,
    '-ac',
    '2',
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
  await rm(loopWav, { force: true });
  return Number(loopLength.toFixed(3));
}

async function fallbackTrack(track, outPath) {
  const loopWav = path.join(path.dirname(outPath), `${track.id}-fallback.wav`);
  const f = track.fallback;
  await run(PYTHON, [
    AUDIO_GEN,
    'music',
    '--out',
    loopWav,
    '--style',
    f.style,
    '--bpm',
    String(f.bpm),
    '--bars',
    '8',
    '--key',
    f.key,
    '--mode',
    f.mode,
    '--progression',
    f.progression,
    '--seed',
    String(f.seed),
    '--gain',
    '-5',
  ]);
  const loudness = await measureLoudness(loopWav);
  await run('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    loopWav,
    '-af',
    `volume=${loudness.gainDb.toFixed(2)}dB,alimiter=limit=0.98`,
    '-ac',
    '2',
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
  await rm(loopWav, { force: true });
  return Number((await probeDuration(outPath)).toFixed(3));
}

async function main() {
  await mkdir(BGM_DIR, { recursive: true });
  await mkdir(CACHE_DIR, { recursive: true });
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'fable-bgm-'));

  try {
    console.log('fetching incompetech catalog...');
    const catalog = JSON.parse(await curlText(CATALOG_URL));
    const byIsrc = new Map(catalog.map((track) => [track.isrc, track]));

    const manifest = {};
    const credits = [];
    let failed = 0;

    for (const track of TRACKS) {
      const meta = byIsrc.get(track.isrc);
      if (!meta) {
        console.warn(`missing catalog entry for ${track.id} (${track.isrc}); using fallback`);
        failed += 1;
        const outPath = path.join(BGM_DIR, `${track.id}.mp3`);
        manifest[track.id] = {
          file: `bgm/${track.id}.mp3`,
          loopStart: 0,
          loopEnd: await fallbackTrack(track, outPath),
        };
        continue;
      }
      if (meta.title !== track.title) {
        console.warn(`title mismatch for ${track.id}: catalog "${meta.title}" vs "${track.title}"`);
      }

      const pageUrl = `${TRACK_PAGE}${track.isrc}`;
      const page = await curlText(pageUrl);
      if (!/Creative Commons:\s*By Attribution 4\.0/i.test(page)) {
        console.error(`license text not found on ${pageUrl}; refusing to use this track`);
        failed += 1;
        continue;
      }

      const sourceFile = path.join(CACHE_DIR, `${track.id}.mp3`);
      const mp3Url = `${MP3_BASE}${encodeURIComponent(meta.filename)}`;
      const cached = await stat(sourceFile).catch(() => null);
      if (cached && cached.size >= 200 * 1024) {
        console.log(`cached ${track.id}: ${meta.title} [${meta.feel ?? 'no feel tag'}] ${meta.length}`);
      } else {
        console.log(`download ${track.id}: ${meta.title} [${meta.feel ?? 'no feel tag'}] ${meta.length}`);
        await run('curl', [
          '-sSL',
          '--fail',
          '--retry',
          '2',
          '--retry-delay',
          '2',
          '-A',
          'fable-tycoon/0.1 (audio asset fetch)',
          '-o',
          sourceFile,
          mp3Url,
        ]);
        const sourceInfo = await stat(sourceFile);
        if (sourceInfo.size < 200 * 1024) {
          throw new Error(`suspiciously small download: ${sourceInfo.size} bytes`);
        }
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }

      const outPath = path.join(BGM_DIR, `${track.id}.mp3`);
      const loopEnd = await processTrack(track, sourceFile, outPath);
      manifest[track.id] = { file: `bgm/${track.id}.mp3`, loopStart: 0, loopEnd };
      credits.push({
        title: meta.title,
        isrc: meta.isrc,
        page: pageUrl,
        feel: meta.feel,
      });
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }

    await writeFile(
      path.join(BGM_DIR, 'bgm.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    const keep = new Set(TRACKS.map((track) => `${track.id}.mp3`));
    for (const file of await readdir(BGM_DIR)) {
      if (file.endsWith('.mp3') && !keep.has(file)) {
        await rm(path.join(BGM_DIR, file), { force: true });
        console.log(`removed stale bgm ${file}`);
      }
    }

    let totalBytes = 0;
    for (const file of await readdir(BGM_DIR)) {
      if (file.endsWith('.mp3')) totalBytes += (await stat(path.join(BGM_DIR, file))).size;
    }
    console.log('');
    console.log(`bgm: ${Object.keys(manifest).length}/${TRACKS.length} entries, ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
    console.log('credits:');
    for (const credit of credits) {
      console.log(
        `- "${credit.title}" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: ` +
          `By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/  (${credit.page})`,
      );
    }
    if (failed > 0) {
      console.log(`fallbacks / failures: ${failed}`);
      process.exitCode = 1;
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

await main();