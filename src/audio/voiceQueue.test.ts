// WebAudio behaviour tests for the voice queue and the BGM lifecycle.
//
// A tiny fake AudioContext stands in for the browser: sources fire `onended` on a (fake) timer and
// the context clock is advanced by the test. That is enough to prove the two rules the game
// depends on:
//
//  1. 標準/じっくり never cut a line — a new `playVoice` waits for the speaking one.
//  2. A BGM request made before the first gesture still starts once the context exists.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AudioModule from './audio';
import { voiceHash } from './voicekey';

type AudioApi = typeof AudioModule.Audio;

class FakeParam {
  value = 1;
  setValueAtTime(v: number): void {
    this.value = v;
  }
  linearRampToValueAtTime(v: number): void {
    this.value = v;
  }
  setTargetAtTime(v: number): void {
    this.value = v;
  }
  cancelScheduledValues(): void {}
}

class FakeNode {
  readonly gain = new FakeParam();
  readonly connections: FakeNode[] = [];
  connect(node: FakeNode): FakeNode {
    this.connections.push(node);
    return node;
  }
  disconnect(): void {
    this.connections.length = 0;
  }
}

class FakeSource extends FakeNode {
  buffer: { duration: number } | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  readonly playbackRate = { value: 1 };
  onended: (() => void) | null = null;
  started = false;
  stopRequested = false;
  startedAt = 0;
  private endTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

  constructor(private readonly ctx: FakeAudioContext) {
    super();
  }

  start(): void {
    this.started = true;
    this.startedAt = this.ctx.currentTime;
    this.scheduleEnd(((this.buffer?.duration ?? 0) * 1000) / (this.playbackRate.value || 1));
  }

  stop(when?: number): void {
    this.stopRequested = true;
    const at = when === undefined ? this.ctx.currentTime : when;
    this.scheduleEnd(Math.max(0, (at - this.ctx.currentTime) * 1000));
  }

  private scheduleEnd(ms: number): void {
    if (this.endTimer !== null) globalThis.clearTimeout(this.endTimer);
    this.endTimer = globalThis.setTimeout(() => this.onended?.(), Math.max(1, ms));
  }
}

class FakeAudioContext {
  state = 'running';
  now = 0;
  readonly destination = new FakeNode();
  readonly sources: FakeSource[] = [];
  onstatechange: (() => void) | null = null;

  get currentTime(): number {
    return this.now / 1000;
  }

  createGain(): FakeNode {
    return new FakeNode();
  }

  createBufferSource(): FakeSource {
    const source = new FakeSource(this);
    this.sources.push(source);
    return source;
  }

  createBuffer(): { length: number } {
    return { length: 1 };
  }

  resume(): Promise<void> {
    this.state = 'running';
    this.onstatechange?.();
    return Promise.resolve();
  }

  suspend(): Promise<void> {
    this.state = 'suspended';
    this.onstatechange?.();
    return Promise.resolve();
  }

  decodeAudioData(bytes: ArrayBuffer): Promise<{ duration: number }> {
    return Promise.resolve({ duration: Number(new DataView(bytes).getUint16(0)) / 1000 });
  }
}

interface FakeEnv {
  ctx: FakeAudioContext;
  fetched: string[];
}

/**
 * Installs the fake browser audio stack, then imports a fresh module instance so its module-level
 * state (context, queue, remembered track) starts empty. Static import cannot do that: the queue
 * and the AudioContext are module singletons by design.
 */
async function loadAudio(lines: Record<string, string>): Promise<{ Audio: AudioApi; at: FakeEnv }> {
  const ctx = new FakeAudioContext();
  const fetched: string[] = [];
  vi.stubGlobal('window', {
    AudioContext: function AudioContextCtor() {
      return ctx;
    },
  });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined });
  const manifest: Record<string, string> = {};
  for (const [key, text] of Object.entries(lines)) manifest[voiceHash(key, text)] = `voice/${voiceHash(key, text)}.mp3`;
  vi.stubGlobal('fetch', (url: string) => {
    fetched.push(url);
    if (url.endsWith('voice/manifest.json')) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(manifest) });
    }
    if (url.endsWith('bgm/bgm.json')) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    }
    const bytes = new Uint8Array(2);
    // A deterministic clip length for every requested file.
    new DataView(bytes.buffer).setUint16(0, 200 + (url.length % 7) * 100);
    return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(bytes.buffer) });
  });
  vi.resetModules();
  const mod = await import('./audio');
  return { Audio: mod.Audio, at: { ctx, fetched } };
}

/** Advances the fake context clock and every pending timer by `ms` milliseconds. */
async function advance(ctx: FakeAudioContext, ms: number): Promise<void> {
  ctx.now += ms;
  await vi.advanceTimersByTimeAsync(ms);
}

const nonScratchSources = (ctx: FakeAudioContext) => ctx.sources.filter((s) => s.started && !s.loop && s.buffer !== null);

describe('voice queue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('standard: a new line waits for the speaking one instead of cutting it', async () => {
    const { Audio, at } = await loadAudio({ narrator: 'あ'.repeat(40), 'npc:piper1': 'い'.repeat(40) });
    Audio.unlock();
    await advance(at.ctx, 10);

    const first = Audio.playVoice('narrator', 'あ'.repeat(40), {});
    await advance(at.ctx, 50);
    const speaking = nonScratchSources(at.ctx).at(-1);
    expect(speaking?.started).toBe(true);

    const second = Audio.playVoice('npc:piper1', 'い'.repeat(40), {});
    await advance(at.ctx, 50);
    // The first line is still speaking: the second one queued instead of stopping it.
    expect(speaking?.stopRequested).toBe(false);
    expect(nonScratchSources(at.ctx).at(-1)).toBe(speaking);

    Audio.stopVoice();
    await advance(at.ctx, 10);
    await Promise.all([first, second]);
  });

  it('queued lines start only after the previous one ends', async () => {
    const { Audio, at } = await loadAudio({ narrator: 'あ'.repeat(10), 'npc:piper1': 'い'.repeat(10) });
    Audio.unlock();
    await advance(at.ctx, 10);
    const first = Audio.playVoice('narrator', 'あ'.repeat(10), {});
    await advance(at.ctx, 20);
    const started = nonScratchSources(at.ctx).length;
    const second = Audio.playVoice('npc:piper1', 'い'.repeat(10), {});
    await advance(at.ctx, 20);
    expect(nonScratchSources(at.ctx).length).toBe(started);
    // Buffer length is 200..800 ms; after it ends the queued line starts.
    await advance(at.ctx, 900);
    expect(nonScratchSources(at.ctx).length).toBe(started + 1);
    Audio.stopVoice();
    await advance(at.ctx, 900);
    await Promise.all([first, second]);
  });

  it('fade hand-over (さくさく) stops the speaking line', async () => {
    const { Audio, at } = await loadAudio({ narrator: 'あ'.repeat(40), 'npc:piper1': 'い'.repeat(40) });
    Audio.unlock();
    await advance(at.ctx, 10);
    const first = Audio.playVoice('narrator', 'あ'.repeat(40), { handover: 'fade' });
    await advance(at.ctx, 30);
    const speaking = nonScratchSources(at.ctx).at(-1);
    const second = Audio.playVoice('npc:piper1', 'い'.repeat(40), { handover: 'fade' });
    await advance(at.ctx, 30);
    expect(speaking?.stopRequested).toBe(true);
    Audio.stopVoice();
    await advance(at.ctx, 10);
    await Promise.all([first, second]);
  });

  it('stopVoice drops queued lines and resolves every caller', async () => {
    const { Audio, at } = await loadAudio({
      narrator: 'あ'.repeat(10),
      'npc:piper1': 'い'.repeat(10),
      'npc:piper2': 'う'.repeat(10),
    });
    Audio.unlock();
    await advance(at.ctx, 10);
    const first = Audio.playVoice('narrator', 'あ'.repeat(10), {});
    await advance(at.ctx, 20);
    const started = nonScratchSources(at.ctx).length;
    const second = Audio.playVoice('npc:piper1', 'い'.repeat(10), {});
    const third = Audio.playVoice('npc:piper2', 'う'.repeat(10), {});
    Audio.stopVoice();
    await advance(at.ctx, 200);
    await Promise.all([first, second, third]);
    // The two queued lines never started: dropping is not cutting.
    expect(nonScratchSources(at.ctx).length).toBe(started);
  });
});

describe('bgm lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('a track requested before the first gesture starts on unlock', async () => {
    const { Audio, at } = await loadAudio({});
    // Title screen: asks for music while the context does not exist yet.
    Audio.bgm('title');
    expect(at.ctx.sources.length).toBe(0);
    Audio.unlock();
    await advance(at.ctx, 50);
    const playing = at.ctx.sources.filter((s) => s.loop && s.started);
    expect(playing.length).toBe(1);
  });

  it('a transient load failure is retried instead of silencing the track forever', async () => {
    const { Audio, at } = await loadAudio({});
    Audio.unlock();
    const realFetch = globalThis.fetch;
    let failures = 2;
    vi.stubGlobal('fetch', (url: string) => {
      if (failures > 0 && String(url).includes('/assets/bgm/')) {
        failures -= 1;
        return Promise.reject(new Error('offline'));
      }
      return realFetch(url);
    });
    Audio.bgm('board_a');
    await advance(at.ctx, 50);
    expect(at.ctx.sources.filter((s) => s.loop).length).toBe(0);
    // The retry backoff (0.8 s, then 1.6 s) must bring the track up on its own.
    await advance(at.ctx, 4000);
    const playing = at.ctx.sources.filter((s) => s.loop && s.started);
    expect(playing.length).toBe(1);
  });

  it('a repeated request for the playing track does not stack sources', async () => {
    const { Audio, at } = await loadAudio({});
    Audio.unlock();
    Audio.bgm('title');
    await advance(at.ctx, 50);
    Audio.bgm('title');
    await advance(at.ctx, 50);
    expect(at.ctx.sources.filter((s) => s.loop).length).toBe(1);
  });
});