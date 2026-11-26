// 「元ネタ」内の関連動画。クリックするまで iframe を作らない（プライバシーと初回描画の速度）。
//
// youtube-nocookie.com を使い、自動再生はしない。動画が無いイベントでは何も描かない。

import type { EventVideo } from '../../core/types';
import { h } from '../dom';

const EMBED_BASE = 'https://www.youtube-nocookie.com/embed/';

/** Build the embed URL for a video (exported for tests). */
export function embedUrl(video: EventVideo): string {
  const start = video.start && video.start > 0 ? `?start=${Math.floor(video.start)}` : '';
  return `${EMBED_BASE}${video.youtubeId}${start}`;
}

/** Collapsible 「▶ 関連動画」 block; the player is created on first click. */
export function eventVideoBlock(video: EventVideo): HTMLElement {
  const host = h('div', { class: 'event-video-host' });
  const btn = h('button', {
    class: 'btn btn-ghost btn-small event-video-btn',
    text: '▶ 関連動画',
    attrs: { type: 'button', 'aria-expanded': 'false' },
    on: {
      click: () => {
        if (host.childElementCount > 0) {
          host.replaceChildren();
          btn.setAttribute('aria-expanded', 'false');
          return;
        }
        host.replaceChildren(
          h('iframe', {
            class: 'event-video-frame',
            attrs: {
              src: embedUrl(video),
              title: video.title,
              loading: 'lazy',
              allow: 'accelerometer; encrypted-media; gyroscope; picture-in-picture',
              referrerpolicy: 'strict-origin-when-cross-origin',
              allowfullscreen: 'true',
            },
          }),
        );
        btn.setAttribute('aria-expanded', 'true');
      },
    },
  });
  return h(
    'div',
    { class: 'event-meta-block event-video-block' },
    h('h4', { text: '関連動画' }),
    btn,
    h('p', { class: 'event-video-title', text: video.title }),
    host,
  );
}