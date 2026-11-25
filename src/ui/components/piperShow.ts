// 取り立て屋の演出 (2026-11 fun overhaul).
//
// 3 つの fx を担当する:
//   piper_roulette  … 3 体の肖像ルーレットが回って止まる（憑依・変身・月替わり）
//   piper_disaster  … キングの大災害。赤フラッシュ + 画面揺れ + 巨大タイトル + 被害額のカウントアップ
//   piper_gift      … 気まぐれな善行。キラキラのカードで風刺タイトルと獲得額
//
// どの演出も `PlaybackControl.wait()` の予算内で必ず終わる。実時間の内訳は
// `FX_MS[fx.t] / control.speed` から計算し、`onSkip` でタイマーと DOM を必ず片付ける。
// 動きを減らす設定 (`motionReduced()`) では最終フレームだけを出す。

import type { Fx } from '../../core/types';
import { PIPER_FORMS } from '../../core/piperLines';
import { FX_MS } from '../../net/session-types';
import { h } from '../dom';
import { animateCounter, motionReduced } from '../motion';
import { assetUrl, formatOkuShort } from '../format';

/** FxPlayer の PlaybackControl のうち、この部品が使う面だけ。 */
export interface PiperShowControl {
  readonly speed: number;
  readonly skipped: boolean;
  wait(ms: number): Promise<void>;
  onSkip(callback: () => void): () => void;
}

export type PiperRouletteFx = Extract<Fx, { t: 'piper_roulette' }>;
export type PiperDisasterFx = Extract<Fx, { t: 'piper_disaster' }>;
export type PiperGiftFx = Extract<Fx, { t: 'piper_gift' }>;

const DISASTER_ICON: Readonly<Record<string, string>> = {
  city_fire_sale: '🔥',
  charity_gala: '🥂',
  trophy_sale: '🔨',
  abduction: '✈️',
  card_confiscation: '🗂️',
  king_tax: '👑',
  hell_ride: '😈',
};

const GIFT_ICON: Readonly<Record<string, string>> = {
  '借金、まさかの全額チャラ': '🧾',
  '身代わり投資、勝手に購入': '🏠',
  '路地裏で現金を拾った': '💰',
};

/** ルーレットの 1 コマ。3 体ぶんを固定で並べ、当選コマを光らせる。 */
interface ReelCell {
  level: 1 | 2 | 3;
  root: HTMLElement;
}

export class PiperShow {
  readonly el: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly kicker: HTMLElement;
  private readonly reel: HTMLElement;
  private readonly cells: ReelCell[];
  private readonly resultName: HTMLElement;
  private readonly resultNote: HTMLElement;
  private readonly disaster: HTMLElement;
  private readonly disasterIcon: HTMLElement;
  private readonly disasterTitle: HTMLElement;
  private readonly disasterAmount: HTMLElement;
  private readonly disasterVictim: HTMLElement;
  private readonly victimImg: HTMLImageElement;
  private readonly victimName: HTMLElement;
  private readonly gift: HTMLElement;
  private readonly giftIcon: HTMLElement;
  private readonly giftTitle: HTMLElement;
  private readonly giftAmount: HTMLElement;
  private readonly giftNote: HTMLElement;
  private timers = new Set<ReturnType<typeof globalThis.setTimeout>>();
  private disposed = false;

  constructor() {
    this.kicker = h('span', { class: 'piper-show-kicker', text: '🎺 取り立て屋ルーレット' });
    this.resultName = h('span', { class: 'piper-show-result-name' });
    this.resultNote = h('span', { class: 'piper-show-result-note' });
    this.cells = PIPER_FORMS.map((form) => {
      const img = h('img', {
        class: 'piper-show-face',
        attrs: { src: assetUrl(`assets/npcs/${form.npcId}.webp`), alt: '', draggable: 'false' },
      });
      const root = h(
        'div',
        { class: 'piper-show-cell', dataset: { level: String(form.level) } },
        img,
        h('span', { class: 'piper-show-cell-name', text: form.shortJa }),
      );
      return { level: form.level as 1 | 2 | 3, root };
    });
    this.reel = h('div', { class: 'piper-show-reel' }, ...this.cells.map((cell) => cell.root));
    this.panel = h(
      'div',
      { class: 'piper-show-panel' },
      this.kicker,
      this.reel,
      h('div', { class: 'piper-show-result' }, this.resultName, this.resultNote),
    );

    this.disasterIcon = h('span', { class: 'piper-show-disaster-icon', text: '👑' });
    this.disasterTitle = h('strong', { class: 'piper-show-disaster-title' });
    this.disasterAmount = h('span', { class: 'piper-show-disaster-amount' });
    this.victimImg = h('img', {
      class: 'piper-show-victim-img',
      attrs: { alt: '', draggable: 'false' },
    });
    this.victimName = h('span', { class: 'piper-show-victim-name' });
    this.disasterVictim = h(
      'div',
      { class: 'piper-show-victim' },
      this.victimImg,
      this.victimName,
    );
    this.disaster = h(
      'div',
      { class: 'piper-show-disaster' },
      h('div', { class: 'piper-show-disaster-crown', text: '👑' }),
      h('div', { class: 'piper-show-disaster-flash', attrs: { 'aria-hidden': 'true' } }),
      h(
        'div',
        { class: 'piper-show-disaster-card' },
        this.disasterIcon,
        h('span', { class: 'piper-show-disaster-kicker', text: 'キング取り立て屋の大災害' }),
        this.disasterTitle,
        this.disasterAmount,
        this.disasterVictim,
      ),
    );

    this.giftIcon = h('span', { class: 'piper-show-gift-icon', text: '💰' });
    this.giftTitle = h('strong', { class: 'piper-show-gift-title' });
    this.giftAmount = h('span', { class: 'piper-show-gift-amount' });
    this.giftNote = h('span', { class: 'piper-show-gift-note', text: '気まぐれな善行' });
    this.gift = h(
      'div',
      { class: 'piper-show-gift' },
      h('div', { class: 'piper-show-gift-card' }, this.giftIcon, this.giftTitle, this.giftAmount, this.giftNote),
    );

    this.el = h(
      'div',
      { class: 'piper-show', attrs: { hidden: 'hidden', 'aria-live': 'polite' } },
      this.panel,
      this.disaster,
      this.gift,
    );
  }

  /** 変身ルーレットを回して `fx.to` で止める。 */
  async playRoulette(fx: PiperRouletteFx, control: PiperShowControl): Promise<void> {
    const budget = FX_MS.piper_roulette / Math.max(1, control.speed);
    this.reset();
    this.el.hidden = false;
    this.el.dataset.kind = 'roulette';
    this.panel.hidden = false;
    this.kicker.textContent =
      fx.from === fx.to ? '🎺 取り立て屋が憑いた' : '🎺 取り立て屋ルーレット';
    this.resultName.textContent = '';
    this.resultNote.textContent = '';
    this.el.classList.add('is-roulette');
    this.setBeat(budget);

    for (const cell of this.cells) cell.root.classList.remove('is-hit', 'is-current');
    const reduced = motionReduced();
    const spinMs = reduced ? 0 : Math.round(budget * 0.62);
    const stopDelay = reduced ? 0 : Math.round(budget * 0.72);
    const finishDelay = reduced ? 0 : Math.round(budget * 0.9);

    const spin = (): void => {
      if (this.disposed) return;
      // 回転中は 3 コマを順にハイライトする（当選コマは最後まで伏せる）。
      const order = this.cells.filter((cell) => cell.level !== fx.to);
      let index = 0;
      const stepMs = Math.max(40, Math.min(110, Math.round(budget / 22)));
      const tick = (): void => {
        if (this.disposed || control.skipped) return;
        for (const cell of this.cells) cell.root.classList.remove('is-current');
        order[index % order.length].root.classList.add('is-current');
        index += 1;
      };
      tick();
      if (reduced) return;
      const timer = globalThis.setInterval(() => {
        if (this.disposed || control.skipped || Date.now() - start > spinMs) {
          globalThis.clearInterval(timer);
          this.timers.delete(timer as unknown as ReturnType<typeof globalThis.setTimeout>);
          return;
        }
        tick();
      }, stepMs);
      this.timers.add(timer as unknown as ReturnType<typeof globalThis.setTimeout>);
      this.onTeardown(() => globalThis.clearInterval(timer));
    };

    const start = Date.now();
    spin();
    this.later(stopDelay, () => {
      for (const cell of this.cells) cell.root.classList.remove('is-current');
      const hit = this.cells.find((cell) => cell.level === fx.to);
      hit?.root.classList.add('is-hit', 'is-current');
      this.el.classList.add('is-landed');
      this.resultName.textContent = PIPER_FORMS[fx.to - 1].nameJa;
      this.resultNote.textContent =
        fx.from === fx.to
          ? `${PIPER_FORMS[fx.to - 1].shortJa}が取り憑いた。`
          : `${PIPER_FORMS[fx.from - 1].shortJa} が ${PIPER_FORMS[fx.to - 1].shortJa} に変身した！`;
    });
    this.later(finishDelay, () => this.el.classList.add('is-finishing'));

    control.onSkip(() => this.hide());
    try {
      await control.wait(FX_MS.piper_roulette);
    } finally {
      this.hide();
    }
  }

  /** キングの大災害。赤フラッシュ・揺れ・巨大タイトル・被害額カウントアップ。 */
  async playDisaster(
    fx: PiperDisasterFx,
    victim: { name: string; sprite?: string },
    control: PiperShowControl,
  ): Promise<void> {
    const speed = Math.max(1, control.speed);
    const budget = FX_MS.piper_disaster / speed;
    this.reset();
    this.el.hidden = false;
    this.el.dataset.kind = 'disaster';
    this.disaster.hidden = false;
    this.disasterIcon.textContent = DISASTER_ICON[fx.kind] ?? '👑';
    this.disasterTitle.textContent = fx.title;
    this.disasterAmount.dataset.negative = 'true';
    this.disasterAmount.textContent = `▲0億`;
    this.victimName.textContent = victim.name;
    if (victim.sprite) {
      this.victimImg.src = victim.sprite;
      this.victimImg.hidden = false;
    } else {
      this.victimImg.removeAttribute('src');
      this.victimImg.hidden = true;
    }
    const reduced = motionReduced();
    this.el.classList.toggle('is-slam', !reduced);
    this.el.classList.add('is-disaster');
    this.setBeat(budget);

    const countMs = reduced ? 0 : Math.max(120, Math.round(budget * 0.45));
    this.later(Math.max(0, Math.round(budget * 0.12)), () => {
      animateCounter(
        this.disasterAmount,
        fx.amount * 0.82,
        fx.amount,
        (value) => `▲${formatOkuShort(Math.max(0, value))}`,
        countMs,
      );
    });
    this.later(Math.max(0, Math.round(budget * 0.3)), () => this.el.classList.add('is-settled'));

    control.onSkip(() => this.hide());
    try {
      await control.wait(FX_MS.piper_disaster);
    } finally {
      this.disasterAmount.textContent = fx.amount > 0 ? `▲${formatOkuShort(fx.amount)}` : '±0億';
      this.hide();
    }
  }

  /** 気まぐれな善行。 */
  async playGift(fx: PiperGiftFx, control: PiperShowControl): Promise<void> {
    const speed = Math.max(1, control.speed);
    const budget = FX_MS.piper_gift / speed;
    this.reset();
    this.el.hidden = false;
    this.el.dataset.kind = 'gift';
    this.gift.hidden = false;
    this.giftIcon.textContent = GIFT_ICON[fx.title] ?? '🎁';
    this.giftTitle.textContent = fx.title;
    this.giftAmount.textContent = `+${formatOkuShort(fx.amount)}`;
    this.giftAmount.dataset.positive = 'true';
    const reduced = motionReduced();
    this.el.classList.toggle('is-pop', !reduced);
    this.setBeat(budget);

    const countMs = reduced ? 0 : Math.max(120, Math.round(budget * 0.4));
    this.later(Math.max(0, Math.round(budget * 0.1)), () => {
      animateCounter(this.giftAmount, 0, fx.amount, (value) => `+${formatOkuShort(Math.max(0, value))}`, countMs);
    });

    control.onSkip(() => this.hide());
    try {
      await control.wait(FX_MS.piper_gift);
    } finally {
      this.giftAmount.textContent = `+${formatOkuShort(fx.amount)}`;
      this.hide();
    }
  }

  /** リサイズやリセット（スナップショット受信）で演出を即座に片付ける。 */
  hide(): void {
    for (const timer of this.timers) globalThis.clearTimeout(timer);
    this.timers.clear();
    this.teardowns.forEach((fn) => fn());
    this.teardowns.clear();
    this.el.hidden = true;
    this.el.classList.remove('is-roulette', 'is-disaster', 'is-gift', 'is-landed', 'is-finishing');
    this.el.classList.remove('is-slam', 'is-settled', 'is-pop');
  }

  private readonly teardowns = new Set<() => void>();

  /** CSS アニメーションの長さを演出予算に合わせる（8 倍速でも引き伸ばさない）。 */
  private setBeat(budgetMs: number): void {
    this.el.style.setProperty('--piper-beat', `${Math.max(60, Math.round(budgetMs * 0.28))}ms`);
    this.el.style.setProperty('--piper-beat-2', `${Math.max(80, Math.round(budgetMs * 0.55))}ms`);
  }

  private onTeardown(fn: () => void): void {
    this.teardowns.add(fn);
  }

  private later(ms: number, fn: () => void): void {
    if (this.disposed) return;
    const timer = globalThis.setTimeout(() => {
      this.timers.delete(timer);
      if (!this.disposed) fn();
    }, Math.max(0, ms));
    this.timers.add(timer);
  }

  private reset(): void {
    this.hide();
    this.panel.hidden = true;
    this.disaster.hidden = true;
    this.gift.hidden = true;
  }
}