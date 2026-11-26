// 寄り道依頼の小カットイン (fun overhaul 第2弾)。
//
// 目的地ルーレットほど大げさにせず、依頼主の立ち絵と依頼名・距離・報酬だけを短く見せる。
// 読み上げはナレーターの固定音声（`ERRAND_NARRATION`）で、字幕もこのカードに出す。

import type { Character, Fx } from '../../core/types';
import { Audio } from '../../audio/audio';
import { FX_MS } from '../../net/session-types';
import { h } from '../dom';
import { characterSprite, formatOku } from '../format';
import { motionReduced } from '../motion';
import '../../styles/errand.css';

export type ErrandFx = Extract<Fx, { t: 'errand' }>;

export interface ErrandCutinOptions {
  /** カードを載せる親（ゲーム画面のルート）。 */
  host: HTMLElement;
  /** 依頼主。 */
  requester: Character;
  /** 依頼名（例: 「赤ずきんのお使い：ワインを届けて」）。 */
  title: string;
  /** 依頼都市の名前。 */
  cityName: string;
  /** 依頼都市までの歩数（不明は null）。 */
  steps: number | null;
  /** 達成報酬（億円）。 */
  bonus: number;
  /** 読み上げる固定ナレーション（字幕もカード内に出す）。 */
  narration: string;
  /** 自動で閉じるまでの ms。 */
  durationMs?: number;
}

export interface ErrandCutinHandle {
  readonly root: HTMLElement;
  /** カードが閉じたときに解決する（早送り・タップ・時間切れのいずれでも）。 */
  readonly done: Promise<void>;
  close(): void;
}

const DEFAULT_DURATION_MS = FX_MS.errand;

/** 依頼の発表カードを出す。タップで早送りでき、時間が来たら自動で閉じる。 */
export function showErrandCutin(options: ErrandCutinOptions): ErrandCutinHandle {
  const reduced = motionReduced();
  const portrait = h('img', {
    class: 'errand-cutin-portrait',
    attrs: { alt: '', draggable: 'false', src: characterSprite(options.requester) },
  });
  portrait.addEventListener('error', () => {
    portrait.style.visibility = 'hidden';
  });
  const stepsText =
    options.steps === null ? '距離不明' : options.steps === 0 ? 'いますぐ寄れる' : `あと${options.steps}マス`;
  const meta = h(
    'div',
    { class: 'errand-cutin-meta' },
    h('span', { class: 'errand-cutin-city', text: `📍 ${options.cityName}` }),
    h('span', { class: 'errand-cutin-steps', text: stepsText }),
    h('span', { class: 'errand-cutin-reward', text: `+${formatOku(options.bonus)}` }),
  );
  const root = h(
    'div',
    {
      class: `errand-cutin ${reduced ? 'is-reduced' : ''}`.trim(),
      attrs: { role: 'status', 'aria-live': 'polite', 'aria-label': '寄り道依頼の発表' },
      on: { click: () => close() },
    },
    h(
      'div',
      { class: 'errand-cutin-card' },
      h('div', { class: 'errand-cutin-ribbon', attrs: { 'aria-hidden': 'true' }, text: '📜' }),
      h('div', { class: 'errand-cutin-head' }, h('span', { text: '寄り道の依頼' })),
      h(
        'div',
        { class: 'errand-cutin-body' },
        h('div', { class: 'errand-cutin-art' }, portrait),
        h(
          'div',
          { class: 'errand-cutin-text' },
          h('div', { class: 'errand-cutin-requester', text: options.requester.nameJa }),
          h('div', { class: 'errand-cutin-title', text: options.title }),
          meta,
        ),
      ),
      h('p', { class: 'errand-cutin-line', text: options.narration }),
    ),
  );

  let closed = false;
  let closeTimer = 0;
  const { promise: done, resolve: resolveDone } = Promise.withResolvers<void>();
  const close = (): void => {
    if (closed) return;
    closed = true;
    window.clearTimeout(closeTimer);
    root.classList.add('is-closing');
    window.setTimeout(() => root.remove(), reduced ? 0 : 180);
    resolveDone();
  };
  options.host.append(root);
  // 字幕が出ている間に声を当てる（事前生成済みのナレーター音声）。
  void Audio.playVoice('narrator', options.narration);
  closeTimer = window.setTimeout(close, options.durationMs ?? DEFAULT_DURATION_MS);
  return { root, done, close };
}