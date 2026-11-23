import { uiSettings } from './settings';

/** True when UI motion should be reduced by the app setting or the OS preference. */
export function motionReduced(): boolean {
  if (uiSettings().reducedMotion) return true;
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

/** Mirrors the effective preference onto <body> for CSS-only motion. */
export function applyMotionPreference(): void {
  document.body.classList.toggle('reduced-motion', motionReduced());
  document.dispatchEvent(new CustomEvent('fable:motion-changed'));
}

export function watchMotionPreference(callback: () => void): () => void {
  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  const onChange = (): void => callback();
  media.addEventListener?.('change', onChange);
  document.addEventListener('fable:motion-changed', onChange);
  return () => {
    media.removeEventListener?.('change', onChange);
    document.removeEventListener('fable:motion-changed', onChange);
  };
}

export function animateCounter(
  el: HTMLElement,
  from: number,
  to: number,
  format: (n: number) => string,
  durationMs = 620,
): void {
  if (motionReduced() || Math.abs(to - from) < 0.5) {
    el.textContent = format(to);
    return;
  }
  el.textContent = format(from);
  const start = performance.now();
  const step = (now: number): void => {
    if (!el.isConnected) return;
    const t = Math.min(1, (now - start) / durationMs);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = format(from + (to - from) * eased);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** CSS/DOM confetti burst inside a host element. */
export function confettiBurst(host: HTMLElement, count = 18): void {
  if (motionReduced()) return;
  const colors = ['#ffd23f', '#ff6b6b', '#5fc8ff', '#6fe095', '#c084ff', '#fff3bf'];
  for (let i = 0; i < count; i++) {
    const bit = document.createElement('span');
    bit.className = 'confetti-bit';
    bit.style.setProperty('--dx', `${(Math.random() - 0.5) * 260}px`);
    bit.style.setProperty('--dy', `${-60 - Math.random() * 220}px`);
    bit.style.setProperty('--rot', `${Math.random() * 720 - 360}deg`);
    bit.style.setProperty('--delay', `${Math.random() * 0.15}s`);
    bit.style.setProperty('--dur', `${0.9 + Math.random() * 0.8}s`);
    bit.style.background = colors[i % colors.length];
    host.append(bit);
    window.setTimeout(() => bit.remove(), 2200);
  }
}
