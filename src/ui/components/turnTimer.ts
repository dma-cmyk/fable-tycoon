import { Audio } from '../../audio/audio';
import { h, svg } from '../dom';

export interface TurnTimerState {
  deadline: number | null;
  totalSeconds: number;
  isMine: boolean;
}

const RADIUS = 24;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** Circular online turn timer. Renders nothing while there is no deadline. */
export class TurnTimer {
  readonly el: HTMLElement;
  private readonly ring: SVGElement;
  private readonly valueEl: HTMLElement;
  private deadline: number | null = null;
  private totalSeconds = 30;
  private isMine = false;
  private interval = 0;
  private lastTickSecond = -1;
  private lastDeadline: number | null = null;

  constructor() {
    this.ring = svg('circle', {
      cx: 30,
      cy: 30,
      r: RADIUS,
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 7,
      'stroke-linecap': 'round',
      'stroke-dasharray': `${CIRCUMFERENCE}`,
      'stroke-dashoffset': 0,
      transform: 'rotate(-90 30 30)',
    });
    const back = svg('circle', {
      cx: 30,
      cy: 30,
      r: RADIUS,
      fill: 'none',
      stroke: 'rgba(255,255,255,0.18)',
      'stroke-width': 7,
    });
    this.valueEl = h('span', { class: 'timer-value', text: '30' });
    this.el = h(
      'div',
      { class: 'turn-timer', attrs: { role: 'timer', 'aria-label': '手番の残り時間', hidden: 'hidden' } },
      svg('svg', { viewBox: '0 0 60 60', class: 'timer-svg' }, back, this.ring),
      this.valueEl,
    );
  }

  set(state: TurnTimerState): void {
    this.isMine = state.isMine;
    this.totalSeconds = Math.max(1, state.totalSeconds);
    this.deadline = state.deadline;
    if (state.deadline === null || state.totalSeconds <= 0) {
      this.stop();
      this.el.hidden = true;
      this.lastDeadline = null;
      return;
    }
    this.el.hidden = false;
    if (this.lastDeadline !== state.deadline) {
      this.lastDeadline = state.deadline;
      this.lastTickSecond = -1;
    }
    this.update();
    if (this.interval === 0) {
      this.interval = window.setInterval(() => this.update(), 250);
    }
  }

  stop(): void {
    if (this.interval !== 0) {
      window.clearInterval(this.interval);
      this.interval = 0;
    }
  }

  destroy(): void {
    this.stop();
    this.el.remove();
  }

  private update(): void {
    if (this.deadline === null) return;
    const remainingMs = Math.max(0, this.deadline - Date.now());
    const remaining = remainingMs / 1000;
    const ratio = Math.min(1, remaining / this.totalSeconds);
    this.ring.setAttribute('stroke-dashoffset', String(CIRCUMFERENCE * (1 - ratio)));
    this.valueEl.textContent = String(Math.ceil(remaining));
    this.el.classList.toggle('is-warning', remaining <= 10 && remaining > 5);
    this.el.classList.toggle('is-danger', remaining <= 5);
    this.el.classList.toggle('is-mine', this.isMine);

    const second = Math.ceil(remaining);
    if (this.isMine && second !== this.lastTickSecond && second > 0 && second <= 5) {
      this.lastTickSecond = second;
      Audio.sfx('timer_tick');
    }
    if (remaining <= 0) {
      this.ring.setAttribute('stroke-dashoffset', String(CIRCUMFERENCE));
      this.valueEl.textContent = '0';
    }
  }
}