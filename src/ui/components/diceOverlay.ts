import { h } from '../dom';
import { motionReduced } from '../motion';
import {
  DICE_FACES,
  faceTransform,
  landingTransform,
  pipPositions,
  tumbleKeyframes,
} from '../dice3d';

interface DieView {
  value: number;
  root: HTMLElement;
  cube: HTMLElement;
}

/** 桃鉄風の立体サイコロ。投げて転がり、出目の面を手前に向けて着地する。 */
export class DiceOverlay {
  readonly el: HTMLElement;
  private readonly diceHost: HTMLElement;
  private readonly totalEl: HTMLElement;
  private settle: (() => void) | null = null;
  private timers: number[] = [];
  private spins: Animation[] = [];

  constructor() {
    this.diceHost = h('div', { class: 'dice-host' });
    this.totalEl = h('div', { class: 'dice-total' });
    this.el = h(
      'div',
      { class: 'dice-overlay', attrs: { 'aria-hidden': 'true' } },
      h('div', { class: 'dice-overlay-inner' }, this.diceHost, this.totalEl),
    );
  }

  /** Resolves after the dice settle, or immediately when skip() is called. */
  show(values: number[], totalMs: number): Promise<void> {
    this.cancel();
    this.totalEl.textContent = '';
    const reduced = motionReduced();
    const dice = values.map((value) => this.buildDie(value));
    this.diceHost.dataset.count = String(dice.length);
    this.diceHost.replaceChildren(...dice.map((die) => die.root));
    this.el.classList.remove('is-settled');
    this.el.classList.toggle('is-rolling', !reduced);
    this.el.classList.add('is-visible');
    this.el.setAttribute('aria-hidden', 'false');

    const total = values.reduce((sum, value) => sum + value, 0);
    // totalMs は再生速度で割られた「この演出の予算」。予算 = 転がり + 着地の見せ場 + 退場。
    // タイマー連鎖の遅れ（実測 20〜40ms）を reserve として先に引き、残りを配分するので、
    // 8倍速（約163ms）でも予算内に resolve し、等倍では従来どおり約1.3秒見せられる。
    const budget = Math.max(64, Math.round(totalMs));
    const fadeMs = Math.max(16, Math.round(budget * 0.1));
    const reserve = Math.min(80, Math.max(16, Math.round(budget * 0.2)));
    const schedule = Math.max(40, budget - fadeMs - reserve);
    const rollMs = Math.round(schedule * 0.62);
    const holdMs = Math.max(24, schedule - rollMs);
    this.el.style.setProperty('--dice-fade', `${fadeMs}ms`);
    this.el.style.setProperty('--dice-land', `${Math.max(40, Math.min(320, holdMs))}ms`);
    const { promise, resolve } = Promise.withResolvers<void>();
    let done = false;

    const land = (): void => {
      if (done) return;
      for (const animation of this.spins) animation.cancel();
      this.spins = [];
      for (const die of dice) die.cube.style.transform = landingTransform(die.value);
      this.el.classList.remove('is-rolling');
      this.el.classList.add('is-settled');
      this.totalEl.textContent = values.length > 1 ? `合計 ${total}` : String(total);
    };

    const dismiss = (): void => {
      if (done) return;
      done = true;
      this.settle = null;
      this.clearTimers();
      this.el.classList.remove('is-visible');
      this.el.setAttribute('aria-hidden', 'true');
      this.timers.push(window.setTimeout(() => resolve(), fadeMs));
    };

    if (reduced) {
      land();
    } else {
      for (const die of dice) {
        // 2〜4 回転ぶん余分に回して、着地姿勢は出目の面に一致させる。
        const spinsX = 2 + Math.random() * 2;
        const spinsY = 2 + Math.random() * 2;
        this.spins.push(
          die.cube.animate(tumbleKeyframes(die.value, spinsX, spinsY), {
            duration: rollMs,
            easing: 'cubic-bezier(0.18, 0.62, 0.32, 1)',
            fill: 'forwards',
          }),
        );
      }
      this.timers.push(window.setTimeout(land, rollMs));
    }
    this.settle = () => {
      land();
      this.timers.push(window.setTimeout(dismiss, holdMs));
    };
    this.timers.push(window.setTimeout(dismiss, rollMs + holdMs));
    return promise;
  }

  skip(): void {
    this.settle?.();
  }

  cancel(): void {
    this.clearTimers();
    for (const animation of this.spins) animation.cancel();
    this.spins = [];
    this.settle = null;
    this.el.classList.remove('is-visible', 'is-rolling', 'is-settled');
    this.el.setAttribute('aria-hidden', 'true');
    this.diceHost.replaceChildren();
    this.totalEl.textContent = '';
  }

  destroy(): void {
    this.cancel();
    this.el.remove();
  }

  private clearTimers(): void {
    for (const timer of this.timers) window.clearTimeout(timer);
    this.timers = [];
  }

  private buildDie(value: number): DieView {
    const cube = h('div', { class: 'die-cube' });
    for (const face of DICE_FACES) {
      const faceEl = h('div', {
        class: `die-face die-face-${face.value}`,
        attrs: { style: faceTransform(face) },
      });
      for (const [col, row] of pipPositions(face.value)) {
        faceEl.append(
          h('span', {
            class: 'die-pip',
            attrs: { style: `grid-column:${col};grid-row:${row}` },
          }),
        );
      }
      cube.append(faceEl);
    }
    const root = h(
      'div',
      { class: 'die', role: 'img', attrs: { 'aria-label': `${value} の目` } },
      h('div', { class: 'die-shadow', attrs: { 'aria-hidden': 'true' } }),
      h('div', { class: 'die-hop' }, h('div', { class: 'die-scene' }, cube)),
    );
    return { value, root, cube };
  }
}