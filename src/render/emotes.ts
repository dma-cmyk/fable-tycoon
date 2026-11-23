// Cosmetic animation vocabulary for tokens. MapView owns scheduling/queueing;
// this module is stateless: given animation progress it returns the token transform
// and paints particles. All randomness is derived from a seed and progress, so frames
// stay deterministic and nothing has to be stored between draws.

import type { EmoteAnim, EmoteDef } from '../core/types';

export const HIT_DURATION_MS = 700;

export function emoteDuration(anim: EmoteAnim): number {
  switch (anim) {
    case 'jump':
      return 1600;
    case 'angry':
      return 1500;
    case 'cry':
      return 1900;
    case 'laugh':
      return 1500;
    case 'dance':
      return 2100;
    case 'taunt':
      return 1600;
    case 'dogeza':
      return 2100;
    case 'money_rain':
      return 2300;
    case 'flex':
      return 1700;
    case 'sleep':
      return 2500;
    case 'heart':
      return 1900;
    case 'throw':
      return 1700;
    case 'hit':
      return HIT_DURATION_MS;
    case 'spotlight':
      return 2400;
  }
}

export interface TokenTransform {
  dx: number;
  dy: number;
  scaleX: number;
  scaleY: number;
  rotate: number;
  alpha: number;
}

export interface DrawOpts {
  /** Token on-screen foot (x, y). */
  x: number;
  y: number;
  /** Token height in CSS px. */
  height: number;
  /** Animation progress 0..1. */
  t: number;
  seed: number;
  def?: EmoteDef;
}

function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function hash(n: number): number {
  let x = n | 0;
  x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d);
  x = Math.imul(x ^ (x >>> 12), 0x297a2d39);
  x ^= x >>> 15;
  return (x >>> 0) / 4294967296;
}

export function tokenEmoteTransform(anim: EmoteAnim, t: number, seed: number): TokenTransform {
  const sway = Math.sin(t * Math.PI * 6 + seed * 6.28);
  switch (anim) {
    case 'jump': {
      const hop = Math.abs(Math.sin(t * Math.PI * 3));
      return { dx: sway * 2, dy: -hop * 24, scaleX: 1 + hop * 0.04, scaleY: 1 - hop * 0.03, rotate: 0, alpha: 1 };
    }
    case 'angry':
      return { dx: Math.sin(t * 90) * (1 - t) * 3.5, dy: 0, scaleX: 1.03, scaleY: 0.98, rotate: Math.sin(t * 70) * 0.015, alpha: 1 };
    case 'cry':
      return { dx: 0, dy: 2 + Math.sin(t * 12) * 1.2, scaleX: 1, scaleY: 0.96, rotate: -0.05, alpha: 1 };
    case 'laugh':
      return { dx: Math.sin(t * Math.PI * 5) * 6, dy: -Math.abs(Math.sin(t * Math.PI * 4)) * 5, scaleX: 1.02, scaleY: 0.98, rotate: Math.sin(t * Math.PI * 5) * 0.075, alpha: 1 };
    case 'dance': {
      const spin = Math.cos(t * Math.PI * 4);
      const hop = Math.abs(Math.sin(t * Math.PI * 4));
      return { dx: sway * 4, dy: -hop * 15, scaleX: spin >= 0 ? 1 : -1, scaleY: 1, rotate: Math.sin(t * Math.PI * 2) * 0.08, alpha: 1 };
    }
    case 'taunt':
      return { dx: Math.sin(t * Math.PI * 5) * 13, dy: 0, scaleX: 1, scaleY: 1, rotate: Math.sin(t * Math.PI * 5) * 0.1, alpha: 1 };
    case 'dogeza': {
      const drop = Math.min(1, t * 6);
      return { dx: 0, dy: drop * 10 + Math.sin(t * 14) * 0.7, scaleX: 1.12, scaleY: 1 - 0.68 * drop, rotate: 0, alpha: 1 };
    }
    case 'money_rain':
      return { dx: Math.sin(t * 30) * 1.4, dy: 0, scaleX: 1.02, scaleY: 0.99, rotate: 0, alpha: 1 };
    case 'flex': {
      const pump = Math.sin(t * Math.PI * 4) * 0.06;
      return { dx: 0, dy: -3 - Math.abs(pump) * 20, scaleX: 1.08 + pump, scaleY: 1.08 - pump, rotate: -0.03, alpha: 1 };
    }
    case 'sleep':
      return { dx: 0, dy: Math.sin(t * Math.PI * 2) * 1.5, scaleX: 1, scaleY: 0.97 + Math.sin(t * Math.PI * 2) * 0.02, rotate: -0.08, alpha: 1 };
    case 'heart':
      return { dx: 0, dy: -Math.abs(Math.sin(t * Math.PI * 2)) * 4, scaleX: 1, scaleY: 1, rotate: Math.sin(t * Math.PI * 2) * 0.04, alpha: 1 };
    case 'throw':
      return { dx: -4 * Math.min(1, t * 4), dy: -2, scaleX: 1, scaleY: 1, rotate: -0.06, alpha: 1 };
    case 'hit':
      return { dx: Math.sin(t * Math.PI * 24) * (1 - t) * 6, dy: 0, scaleX: 1.02, scaleY: 0.96, rotate: Math.sin(t * Math.PI * 22) * 0.08, alpha: 1 };
    case 'spotlight': {
      const pose = Math.min(1, t * 5) * (1 - Math.max(0, (t - 0.82) / 0.18));
      return { dx: 0, dy: -9 * pose, scaleX: 1 + 0.1 * pose, scaleY: 1 + 0.1 * pose, rotate: -0.05 * pose, alpha: 1 };
    }
  }
}

/** Backlight that should be painted behind the token (spotlight). */
export function drawEmoteBackdrop(ctx: CanvasRenderingContext2D, anim: EmoteAnim, opts: DrawOpts): void {
  if (anim !== 'spotlight') return;
  const { x, y, height, t } = opts;
  const fade = Math.min(1, t * 5) * (t > 0.85 ? (1 - t) / 0.15 : 1);
  const top = y - height - 90;
  const grad = ctx.createLinearGradient(0, top, 0, y + 6);
  grad.addColorStop(0, `rgba(255, 250, 190, ${0.55 * fade})`);
  grad.addColorStop(0.75, `rgba(255, 240, 140, ${0.22 * fade})`);
  grad.addColorStop(1, `rgba(255, 240, 140, 0)`);
  ctx.save();
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(x - 8, top);
  ctx.lineTo(x + 8, top);
  ctx.lineTo(x + height * 0.72, y + 6);
  ctx.lineTo(x - height * 0.72, y + 6);
  ctx.closePath();
  ctx.fill();
  const ring = ctx.createRadialGradient(x, y + 2, 2, x, y + 2, height * 0.52);
  ring.addColorStop(0, `rgba(255, 232, 120, ${0.45 * fade})`);
  ring.addColorStop(1, 'rgba(255, 232, 120, 0)');
  ctx.fillStyle = ring;
  ctx.beginPath();
  ctx.ellipse(x, y + 3, height * 0.55, height * 0.2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Particles painted above the token (or around it). */
export function drawEmoteFx(ctx: CanvasRenderingContext2D, anim: EmoteAnim, opts: DrawOpts): void {
  const { x, y, height, t, seed } = opts;
  const headY = y - height + height * 0.08;
  switch (anim) {
    case 'jump': {
      if (t < 0.35) {
        for (let i = 0; i < 3; i++) {
          const p = (t * 3 + i / 3) % 1;
          ctx.globalAlpha = (1 - p) * 0.6;
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.arc(x + (hash(seed * 7 + i) - 0.5) * 30, y - p * 10, 2.5 + p * 4, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
      sparkles(ctx, x, headY, height, t, seed, '#fff8b0');
      break;
    }
    case 'angry': {
      for (let i = 0; i < 3; i++) {
        const p = ((t + i / 3) % 1);
        const sx = x + (hash(seed + i * 3) - 0.5) * height * 0.5;
        const sy = headY - p * 22;
        ctx.globalAlpha = (1 - p) * 0.85;
        ctx.fillStyle = '#fff4f4';
        ctx.beginPath();
        ctx.arc(sx, sy, 4 + p * 7, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      drawAngerMark(ctx, x + height * 0.3, headY - 6, 9 + Math.sin(t * 18) * 1.5);
      break;
    }
    case 'cry': {
      for (let i = 0; i < 6; i++) {
        const p = (t * 1.6 + i / 6) % 1;
        const side = i % 2 === 0 ? -1 : 1;
        const tx = x + side * height * 0.13 + (hash(seed + i * 9) - 0.5) * 5;
        const ty = headY + 6 + p * height * 0.9;
        ctx.globalAlpha = (1 - p) * 0.9;
        ctx.fillStyle = '#5fc9ff';
        ctx.beginPath();
        ctx.ellipse(tx, ty, 2.2, 4.2, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.beginPath();
        ctx.arc(tx - 0.5, ty - 1.4, 0.9, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      break;
    }
    case 'laugh': {
      for (let i = 0; i < 4; i++) {
        const p = (t * 1.2 + i / 4) % 1;
        const tx = x + (i % 2 === 0 ? -1 : 1) * (height * 0.35 + p * 18);
        const ty = headY + 4 - p * 26;
        ctx.globalAlpha = (1 - p) * 0.9;
        ctx.fillStyle = i % 2 === 0 ? '#ffd84d' : '#ffffff';
        ctx.font = `bold ${11 + i * 2}px "M PLUS Rounded 1c", sans-serif`;
        ctx.fillText(i % 2 === 0 ? '♪' : '♫', tx, ty);
      }
      ctx.globalAlpha = 1;
      break;
    }
    case 'dance':
      sparkles(ctx, x, headY, height, t, seed, '#ffe36b');
      break;
    case 'taunt': {
      ctx.save();
      ctx.globalAlpha = 0.92;
      ctx.font = `bold ${Math.round(height * 0.34)}px "M PLUS Rounded 1c", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('べー', x + height * 0.38, headY - 2);
      ctx.restore();
      break;
    }
    case 'dogeza': {
      for (let i = 0; i < 3; i++) {
        const p = (t * 2 + i / 3) % 1;
        ctx.globalAlpha = (1 - p) * 0.45;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(x - height * 0.3 + i * 14, y + 2 - p * 4, 4 + p * 6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      break;
    }
    case 'money_rain': {
      for (let i = 0; i < 16; i++) {
        const delay = i * 0.035;
        const p = (t - delay) / 0.72;
        if (p < 0 || p > 1) continue;
        const tx = x + (hash(seed + i * 13) - 0.5) * height * 1.1 + Math.sin(p * 12 + i) * 5;
        const ty = headY - height * 0.6 + p * height * 1.45;
        ctx.save();
        ctx.translate(tx, ty);
        ctx.rotate(hash(seed * 3 + i) * 6 + p * 7);
        ctx.globalAlpha = 1 - p * 0.65;
        ctx.fillStyle = '#4fd17b';
        ctx.strokeStyle = '#1d7a42';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(-7, -4, 14, 8, 1.5);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#eafff0';
        ctx.font = 'bold 6px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('¥', 0, 0.5);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
      break;
    }
    case 'flex': {
      sparkles(ctx, x, headY, height * 1.15, t, seed, '#fff1a0', 9);
      const s = 5 + Math.sin(t * 18) * 1.2;
      drawStar(ctx, x - height * 0.34, headY + height * 0.2, s, '#ffe14d');
      drawStar(ctx, x + height * 0.36, headY + height * 0.34, s * 0.8, '#fff6b8');
      break;
    }
    case 'sleep': {
      for (let i = 0; i < 3; i++) {
        const p = (t * 1.15 + i / 3) % 1;
        const tx = x + height * 0.2 + p * 20 + i * 2;
        const ty = headY - 4 - p * 30;
        ctx.globalAlpha = (1 - p) * 0.85;
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = 'rgba(40, 70, 110, 0.55)';
        ctx.lineWidth = 1.4;
        ctx.font = `bold ${10 + i * 4}px "M PLUS Rounded 1c", sans-serif`;
        ctx.strokeText('Z', tx, ty);
        ctx.fillText('Z', tx, ty);
      }
      ctx.globalAlpha = 1;
      break;
    }
    case 'heart': {
      for (let i = 0; i < 7; i++) {
        const p = (t * 1.4 + i / 7) % 1;
        const tx = x + (hash(seed + i * 5) - 0.5) * height * 0.75 + Math.sin(p * 8 + i) * 6;
        const ty = headY + 8 - p * height * 1.1;
        ctx.globalAlpha = (1 - p) * 0.9;
        drawHeart(ctx, tx, ty, 5 + (i % 3) * 2, p > 0.5 ? '#ff8aa8' : '#ff5577');
      }
      ctx.globalAlpha = 1;
      break;
    }
    case 'throw':
      // The projectile itself is painted by drawProjectile on top of the whole map.
      break;
    case 'hit': {
      if (t < 0.6) {
        drawStar(ctx, x, headY + height * 0.15, 10 * (1 - t), '#ffe14d');
        drawStar(ctx, x - 14, headY, 6, '#ff9f43');
        drawStar(ctx, x + 15, headY + 8, 5, '#ff6b6b');
      }
      break;
    }
    case 'spotlight': {
      sparkles(ctx, x, headY, height * 1.1, t, seed, '#fffbe0', 10);
      break;
    }
  }
}

/** Projectile arc for `throw`. `t` is full emote progress; returns false once landed. */
export function drawProjectile(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  height: number,
  tx: number,
  ty: number,
  targetHeight: number,
  t: number,
  icon: string,
): void {
  if (t < 0.04 || t > 0.68) {
    if (t >= 0.6 && t <= 0.85) {
      const p = (t - 0.6) / 0.25;
      ctx.save();
      ctx.globalAlpha = 1 - p;
      ctx.strokeStyle = '#fff6a8';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(tx, ty - targetHeight * 0.55, 4 + p * 24, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    return;
  }
  const p = (t - 0.04) / 0.56;
  const e = p * p * (3 - 2 * p);
  const sx = x;
  const sy = y - height * 0.75;
  const ex = tx;
  const ey = ty - targetHeight * 0.6;
  const px = sx + (ex - sx) * e;
  const py = sy + (ey - sy) * e - Math.sin(e * Math.PI) * 56;
  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(p * 9);
  ctx.font = '22px "M PLUS Rounded 1c", "Noto Color Emoji", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(icon || '🍅', 0, 0);
  ctx.restore();
}

/** Emoji pop above the head for every emote. */
export function drawEmoteIcon(ctx: CanvasRenderingContext2D, icon: string, x: number, y: number, t: number): void {
  const pop = t < 0.18 ? easeOutBack(t / 0.18) : 1;
  const fade = t > 0.82 ? (1 - t) / 0.18 : 1;
  const scale = Math.max(0.01, pop * fade);
  ctx.save();
  ctx.translate(x, y + (1 - pop) * 8);
  ctx.scale(scale, scale);
  ctx.fillStyle = 'rgba(255,255,255,0.96)';
  ctx.strokeStyle = 'rgba(26, 44, 92, 0.85)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, 15, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.font = '17px "M PLUS Rounded 1c", "Noto Color Emoji", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(icon, 0, 1);
  ctx.restore();
}

function sparkles(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  height: number,
  t: number,
  seed: number,
  color: string,
  count = 7,
): void {
  for (let i = 0; i < count; i++) {
    const p = (t * 1.5 + i / count) % 1;
    const angle = hash(seed + i * 17) * Math.PI * 2;
    const radius = height * (0.25 + p * 0.35);
    const px = x + Math.cos(angle) * radius;
    const py = y + Math.sin(angle) * radius * 0.75 - height * 0.35;
    ctx.globalAlpha = Math.sin(p * Math.PI) * 0.9;
    drawStar(ctx, px, py, 2 + (1 - p) * 3, color);
  }
  ctx.globalAlpha = 1;
}

function drawStar(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
  if (r <= 0.2) return;
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const angle = (Math.PI / 4) * i - Math.PI / 2;
    const radius = i % 2 === 0 ? r : r * 0.38;
    const px = x + Math.cos(angle) * radius;
    const py = y + Math.sin(angle) * radius;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawHeart(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y + r * 0.75);
  ctx.bezierCurveTo(x - r * 1.6, y - r * 0.35, x - r * 0.55, y - r * 1.35, x, y - r * 0.45);
  ctx.bezierCurveTo(x + r * 0.55, y - r * 1.35, x + r * 1.6, y - r * 0.35, x, y + r * 0.75);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawAngerMark(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  ctx.save();
  ctx.strokeStyle = '#ff3b3b';
  ctx.lineWidth = 2.4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let i = 0; i < 4; i++) {
    const a = (Math.PI / 2) * i + Math.PI / 4;
    ctx.moveTo(x + Math.cos(a) * size * 0.45, y + Math.sin(a) * size * 0.45);
    ctx.lineTo(x + Math.cos(a) * size, y + Math.sin(a) * size);
  }
  ctx.stroke();
  ctx.restore();
}

export function drawHitFlash(ctx: CanvasRenderingContext2D, x: number, y: number, height: number, t: number): void {
  const alpha = Math.max(0, 1 - t * 1.6);
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha * 0.55;
  ctx.fillStyle = '#ff5a5a';
  ctx.beginPath();
  ctx.ellipse(x, y - height * 0.48, height * 0.4, height * 0.55, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}