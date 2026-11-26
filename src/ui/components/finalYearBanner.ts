// 最終年（1年制は最終盤）の開幕を告げる全画面バナー。
// ルール変更の一覧を大きく見せ、固定ナレーションをその場で読み上げる。

import { Audio } from '../../audio/audio';
import { h } from '../dom';
import { motionReduced } from '../motion';
import '../../styles/showdown.css';

export interface FinalYearBannerOptions {
  /** バナーを載せる親（ゲーム画面のルート）。 */
  host: HTMLElement;
  /** 「最終年」または「最終盤」。 */
  title: string;
  /** 告知する年（1年制は 1）。 */
  year: number;
  /** ルール変更の一覧。 */
  rules: string[];
  /** 読み上げる固定ナレーション（字幕もバナー内に出す）。 */
  narration: string;
  /** 自動で閉じるまでの ms（`FX_MS.final_year / fxSpeed` を渡す）。 */
  durationMs?: number;
  /** ナレーションの再生速度（1.2 倍で上限）。 */
  rate?: number;
}

export interface FinalYearBannerHandle {
  readonly root: HTMLElement;
  close(): void;
}

/** 1x でのバナー表示時間（ms）。fx 側は speed で割った値を渡す。 */
export const FINAL_YEAR_BANNER_MS = 3200;

/** 最終年バナーを出す。タップで早送りでき、時間が来たら自動で閉じる。 */
export function showFinalYearBanner(options: FinalYearBannerOptions): FinalYearBannerHandle {
  const reduced = motionReduced();
  const title = h('div', { class: 'final-year-title', text: options.title });
  const yearLabel = h('div', { class: 'final-year-year', text: `第 ${options.year} 年` });
  const rules = h(
    'ul',
    { class: 'final-year-rules' },
    ...options.rules.map((rule, index) =>
      h(
        'li',
        { class: 'final-year-rule', attrs: { style: `--rule-index:${index}` } },
        h('span', { class: 'final-year-rule-mark', text: '◆', attrs: { 'aria-hidden': 'true' } }),
        h('span', { class: 'final-year-rule-text', text: rule }),
      ),
    ),
  );
  const caption = h('p', { class: 'final-year-caption', text: options.narration });
  const root = h(
    'div',
    {
      class: `final-year-overlay ${reduced ? 'is-reduced' : ''}`.trim(),
      attrs: { role: 'dialog', 'aria-modal': 'false', 'aria-label': `${options.title}の告知` },
    },
    h(
      'div',
      { class: 'final-year-card' },
      h('div', { class: 'final-year-rays', attrs: { 'aria-hidden': 'true' } }),
      h('div', { class: 'final-year-kicker', text: 'ここからルールが変わる' }),
      title,
      yearLabel,
      h('div', { class: 'final-year-ribbon' }, h('span', { text: '目的地ボーナス' }), h('strong', { text: '×2' })),
      rules,
      caption,
      h('div', { class: 'final-year-hint', text: 'タップで進む' }),
    ),
  );

  let closed = false;
  let timer = 0;
  const close = (): void => {
    if (closed) return;
    closed = true;
    window.clearTimeout(timer);
    root.classList.add('is-closing');
    window.setTimeout(() => root.remove(), reduced ? 0 : 240);
  };
  root.addEventListener('click', close);
  options.host.append(root);
  // 字幕が出ている間に声を当てる（この行は事前生成済みのナレーター音声）。
  void Audio.playVoice('narrator', options.narration, { rate: options.rate });
  timer = window.setTimeout(close, options.durationMs ?? FINAL_YEAR_BANNER_MS);
  return { root, close };
}