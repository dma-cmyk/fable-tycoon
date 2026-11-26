// イベント関連動画の契約テスト。
// 実データにはまだ動画を付けない（仕組みだけ動くことを確かめる）。
// 1) embedUrl が youtube-nocookie の埋め込みURLを組み立てる
// 2) iframe はクリックするまで作られない（プライバシーと速度）
// 3) GameEventDef.video が型として通り、バリデータの規則（11文字ID・非負のstart）に合う

import { describe, expect, it } from 'vitest';
import type { GameEventDef } from '../../core/types';
import { embedUrl, eventVideoBlock } from './eventVideo';

describe('event video', () => {
  it('builds a privacy-preserving embed url', () => {
    expect(embedUrl({ youtubeId: 'dQw4w9WgXcQ', title: 't' })).toBe(
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    );
    expect(embedUrl({ youtubeId: 'dQw4w9WgXcQ', start: 42, title: 't' })).toBe(
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=42',
    );
    expect(embedUrl({ youtubeId: 'dQw4w9WgXcQ', start: 0, title: 't' })).toBe(
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    );
  });

  it('accepts an optional video on an event def', () => {
    const event: GameEventDef = {
      id: 'sample',
      title: '見本',
      kind: 'fable',
      satireNote: '見本',
      weight: 1,
      lines: [{ speaker: 'narrator', text: '見本' }],
      video: { youtubeId: 'dQw4w9WgXcQ', start: 12, title: '関連動画' },
    };
    expect(event.video?.youtubeId).toBe('dQw4w9WgXcQ');
    const without: GameEventDef = { ...event, video: undefined };
    expect(without.video).toBeUndefined();
  });
});

describe.skipIf(typeof document === 'undefined')('event video block (DOM)', () => {
  it('creates the iframe only after a click', () => {
    const block = eventVideoBlock({ youtubeId: 'dQw4w9WgXcQ', title: '関連動画' });
    expect(block.querySelectorAll('iframe')).toHaveLength(0);
    const btn = block.querySelector('button');
    expect(btn).toBeTruthy();
    btn!.dispatchEvent(new Event('click'));
    const frame = block.querySelector('iframe');
    expect(frame?.getAttribute('src')).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    btn!.dispatchEvent(new Event('click'));
    expect(block.querySelectorAll('iframe')).toHaveLength(0);
  });
});