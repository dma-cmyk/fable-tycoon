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
    const revealAt = reduced ? 0 : Math.max(240, totalMs - 520);
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

    const finish = (): void => {
      if (done) return;
      done = true;
      this.settle = null;
      this.clearTimers();
      this.timers.push(
        window.setTimeout(() => {
          this.el.classList.remove('is-visible');
          this.el.setAttribute('aria-hidden', 'true');
          this.timers.push(window.setTimeout(() => resolve(), 140));
        }, 320),
      );
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
            duration: revealAt,
            easing: 'cubic-bezier(0.18, 0.62, 0.32, 1)',
            fill: 'forwards',
          }),
        );
      }
      this.timers.push(window.setTimeout(land, revealAt));
    }
    this.settle = () => {
      land();
      finish();
    };
    this.timers.push(
      window.setTimeout(() => {
        land();
        finish();
      }, Math.max(revealAt + 260, totalMs)),
    );
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