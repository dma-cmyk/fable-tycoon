import { h } from '../dom';

/** Big cartoon dice that spin, then settle on the rolled values. */
export class DiceOverlay {
  readonly el: HTMLElement;
  private readonly diceHost: HTMLElement;
  private readonly totalEl: HTMLElement;
  private settle: (() => void) | null = null;
  private timer = 0;

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
    this.diceHost.replaceChildren();
    this.totalEl.textContent = '';
    for (const value of values) {
      this.diceHost.append(diceFace(value, true));
    }
    this.el.classList.remove('is-settled');
    this.el.classList.add('is-rolling');
    this.el.classList.add('is-visible');

    const { promise, resolve } = Promise.withResolvers<void>();
    let done = false;
    const finish = (snap: boolean): void => {
        if (done) return;
        done = true;
        this.settle = null;
        window.clearTimeout(this.timer);
        if (snap) {
          this.diceHost.replaceChildren();
          for (const value of values) this.diceHost.append(diceFace(value, false));
        }
        this.el.classList.remove('is-rolling');
        this.el.classList.add('is-settled');
        const total = values.reduce((sum, value) => sum + value, 0);
        this.totalEl.textContent = values.length > 1 ? `合計 ${total}` : String(total);
        window.setTimeout(() => {
          this.el.classList.remove('is-visible');
          window.setTimeout(() => resolve(), 140);
      }, 320);
    };
    this.settle = () => finish(true);
    const revealAt = Math.max(240, totalMs - 520);
    window.setTimeout(() => {
      if (done) return;
      this.diceHost.replaceChildren();
      for (const value of values) this.diceHost.append(diceFace(value, false));
      this.el.classList.remove('is-rolling');
      this.el.classList.add('is-settled');
      if (values.length > 1) {
        const total = values.reduce((sum, value) => sum + value, 0);
        this.totalEl.textContent = `合計 ${total}`;
      }
    }, revealAt);
    this.timer = window.setTimeout(() => finish(false), Math.max(revealAt + 260, totalMs));
    return promise;
  }

  skip(): void {
    this.settle?.();
  }

  cancel(): void {
    window.clearTimeout(this.timer);
    this.settle = null;
    this.el.classList.remove('is-visible', 'is-rolling', 'is-settled');
    this.diceHost.replaceChildren();
  }

  destroy(): void {
    this.cancel();
    this.el.remove();
  }
}

const PIP_POSITIONS: Record<number, [number, number][]> = {
  1: [[2, 2]],
  2: [[1, 1], [3, 3]],
  3: [[1, 1], [2, 2], [3, 3]],
  4: [[1, 1], [3, 1], [1, 3], [3, 3]],
  5: [[1, 1], [3, 1], [2, 2], [1, 3], [3, 3]],
  6: [[1, 1], [3, 1], [1, 2], [3, 2], [1, 3], [3, 3]],
};

function diceFace(value: number, rolling: boolean): HTMLElement {
  const face = h('div', {
    class: `dice-face ${rolling ? 'is-spin' : ''}`.trim(),
    attrs: { 'aria-label': `${value} の目` },
  });
  for (const [col, row] of PIP_POSITIONS[value] ?? PIP_POSITIONS[1]) {
    face.append(
      h('span', {
        class: 'dice-pip',
        attrs: { style: `grid-column:${col};grid-row:${row}` },
      }),
    );
  }
  return face;
}