// Vehicle sprites for rides, warps and ambient traffic.
// Images are side views facing RIGHT; drawVehicle flips them for leftward travel.
// Until the generated webp files exist, each kind has a readable vector fallback.

export type VehicleKind =
  | 'train'
  | 'express'
  | 'bullet_train'
  | 'ferry'
  | 'plane'
  | 'rocket'
  | 'carpet'
  | 'sailboat';

export const VEHICLE_KINDS: readonly VehicleKind[] = [
  'train', 'express', 'bullet_train', 'ferry', 'plane', 'rocket', 'carpet', 'sailboat',
];

export const VEHICLE_FILES: Record<VehicleKind, string> = {
  train: 'train.webp',
  express: 'express.webp',
  bullet_train: 'bullet_train.webp',
  ferry: 'ferry.webp',
  plane: 'plane.webp',
  rocket: 'rocket.webp',
  carpet: 'carpet.webp',
  sailboat: 'sailboat.webp',
};

const FALLBACK_HEIGHT: Record<VehicleKind, number> = {
  train: 0.44,
  express: 0.4,
  bullet_train: 0.34,
  ferry: 0.38,
  plane: 0.3,
  rocket: 0.42,
  carpet: 0.18,
  sailboat: 0.46,
};

export interface VehicleMetrics {
  w: number;
  h: number;
  /** Character feet should sit around this local y (negative = above ground). */
  rideY: number;
  /** Draw the vehicle in front of the rider (lower body hidden in the vehicle). */
  inFront: boolean;
}

export function vehicleMetrics(kind: VehicleKind, length: number, img?: HTMLImageElement | null): VehicleMetrics {
  let h: number;
  if (img && img.naturalWidth > 0 && img.naturalHeight > 0) {
    h = length * (img.naturalHeight / img.naturalWidth);
  } else {
    h = length * FALLBACK_HEIGHT[kind];
  }
  const inFront = kind !== 'carpet' && kind !== 'sailboat';
  const rideY = kind === 'carpet' ? -h * 0.9 : -h * 0.42;
  return { w: length, h, rideY, inFront };
}

/** Bottom-centre anchored vehicle. `tilt` radians, `facing` ±1. */
export function drawVehicle(
  ctx: CanvasRenderingContext2D,
  kind: VehicleKind,
  x: number,
  y: number,
  length: number,
  facing: number,
  img: HTMLImageElement | undefined,
  tilt = 0,
): void {
  const metrics = vehicleMetrics(kind, length, img);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(tilt);
  ctx.scale(facing < 0 ? -1 : 1, 1);
  if (img && img.naturalWidth > 0 && img.naturalHeight > 0) {
    ctx.drawImage(img, -metrics.w / 2, -metrics.h, metrics.w, metrics.h);
  } else {
    drawFallback(ctx, kind, length, metrics.h);
  }
  ctx.restore();
}

function drawFallback(ctx: CanvasRenderingContext2D, kind: VehicleKind, L: number, H: number): void {
  const x0 = -L / 2;
  const x1 = L / 2;
  const line = Math.max(1, L * 0.022);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = line;
  ctx.strokeStyle = '#1d3155';
  const round = (x: number, y: number, w: number, h: number, r: number): void => {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  };
  switch (kind) {
    case 'train':
    case 'express':
    case 'bullet_train': {
      const bullet = kind === 'bullet_train';
      const express = kind === 'express';
      const bodyTop = -H * (bullet ? 0.92 : 0.82);
      const grad = ctx.createLinearGradient(0, bodyTop, 0, 0);
      if (bullet) {
        grad.addColorStop(0, '#f7fbff');
        grad.addColorStop(0.55, '#d9ecff');
        grad.addColorStop(1, '#9fc8ee');
      } else if (express) {
        grad.addColorStop(0, '#fff3d2');
        grad.addColorStop(1, '#ffb147');
      } else {
        grad.addColorStop(0, '#fff6d5');
        grad.addColorStop(1, '#f2c64c');
      }
      // wheels
      ctx.fillStyle = '#26344f';
      for (const wx of [-L * 0.3, 0, L * 0.3]) {
        ctx.beginPath();
        ctx.arc(wx, -H * 0.1, H * 0.1, 0, Math.PI * 2);
        ctx.fill();
      }
      // body / nose
      if (bullet) {
        ctx.beginPath();
        ctx.moveTo(x0, -H * 0.22);
        ctx.lineTo(x0 + L * 0.78, -H * 0.22);
        ctx.quadraticCurveTo(x1, -H * 0.28, x1, -H * 0.58);
        ctx.quadraticCurveTo(x1 - L * 0.03, bodyTop, x0 + L * 0.72, bodyTop);
        ctx.lineTo(x0, bodyTop);
        ctx.closePath();
      } else {
        round(x0, bodyTop, L, -bodyTop - H * 0.12, H * 0.18);
      }
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.stroke();
      // cab window on the right
      ctx.fillStyle = 'rgba(37, 89, 145, 0.85)';
      round(x0 + L * 0.62, bodyTop + H * 0.12, L * 0.2, H * 0.28, H * 0.08);
      ctx.fill();
      // passenger windows
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      const winCount = bullet ? 5 : 4;
      for (let i = 0; i < winCount; i++) {
        round(x0 + L * (0.09 + i * 0.11), bodyTop + H * 0.15, L * 0.065, H * 0.22, H * 0.04);
        ctx.fill();
      }
      // stripe
      ctx.fillStyle = bullet ? '#2f7bd8' : express ? '#d93636' : '#3b8d5a';
      ctx.fillRect(x0 + L * 0.03, -H * 0.34, L * 0.86, H * 0.075);
      break;
    }
    case 'ferry': {
      ctx.beginPath();
      ctx.moveTo(x0, -H * 0.28);
      ctx.lineTo(x1, -H * 0.28);
      ctx.lineTo(x1 - L * 0.16, 0);
      ctx.lineTo(x0 + L * 0.13, 0);
      ctx.closePath();
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#2a6da8';
      ctx.fillRect(x0 + L * 0.1, -H * 0.46, L * 0.34, H * 0.2);
      ctx.fillRect(x0 + L * 0.5, -H * 0.55, L * 0.27, H * 0.29);
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      for (let i = 0; i < 3; i++) ctx.fillRect(x0 + L * (0.54 + i * 0.07), -H * 0.44, L * 0.045, H * 0.08);
      ctx.fillStyle = '#e34a4a';
      ctx.fillRect(x0 + L * 0.06, -H * 0.34, L * 0.82, H * 0.07);
      break;
    }
    case 'sailboat': {
      ctx.beginPath();
      ctx.moveTo(x0, -H * 0.22);
      ctx.lineTo(x1, -H * 0.22);
      ctx.lineTo(x1 - L * 0.18, 0);
      ctx.lineTo(x0 + L * 0.18, 0);
      ctx.closePath();
      ctx.fillStyle = '#8b5a32';
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = '#2a3448';
      ctx.lineWidth = line * 1.4;
      ctx.beginPath();
      ctx.moveTo(-L * 0.05, -H * 0.22);
      ctx.lineTo(-L * 0.05, -H * 0.98);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-L * 0.02, -H * 0.92);
      ctx.lineTo(L * 0.38, -H * 0.28);
      ctx.lineTo(-L * 0.02, -H * 0.28);
      ctx.closePath();
      ctx.fillStyle = '#fff7e4';
      ctx.fill();
      ctx.strokeStyle = '#2a3448';
      ctx.lineWidth = line;
      ctx.stroke();
      break;
    }
    case 'plane': {
      ctx.beginPath();
      ctx.ellipse(-L * 0.02, -H * 0.42, L * 0.42, H * 0.28, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#f9fdff';
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-L * 0.12, -H * 0.42);
      ctx.lineTo(-L * 0.34, -H * 0.97);
      ctx.lineTo(L * 0.2, -H * 0.42);
      ctx.closePath();
      ctx.fillStyle = '#d7ecff';
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-L * 0.36, -H * 0.68);
      ctx.lineTo(-L * 0.5, -H * 0.78);
      ctx.lineTo(-L * 0.27, -H * 0.62);
      ctx.closePath();
      ctx.fillStyle = '#e34a4a';
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = 'rgba(57, 117, 180, 0.9)';
      round(L * 0.12, -H * 0.52, L * 0.1, H * 0.08, H * 0.03);
      ctx.fill();
      break;
    }
    case 'rocket': {
      ctx.beginPath();
      ctx.moveTo(x0 + L * 0.05, -H * 0.18);
      ctx.quadraticCurveTo(x1, -H * 0.62, x1 + L * 0.04, -H * 0.52);
      ctx.quadraticCurveTo(x1, -H * 0.22, x0 + L * 0.05, -H * 0.08);
      ctx.closePath();
      ctx.fillStyle = '#f2f7ff';
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#e34a4a';
      ctx.beginPath();
      ctx.moveTo(x0, -H * 0.2);
      ctx.lineTo(x0 - L * 0.16, -H * 0.5);
      ctx.lineTo(x0 + L * 0.02, -H * 0.46);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x0, -H * 0.1);
      ctx.lineTo(x0 - L * 0.16, H * 0.08);
      ctx.lineTo(x0 + L * 0.02, -H * 0.02);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.arc(L * 0.18, -H * 0.38, H * 0.1, 0, Math.PI * 2);
      ctx.fillStyle = '#5ab8ff';
      ctx.fill();
      ctx.strokeStyle = '#2a3448';
      ctx.stroke();
      break;
    }
    case 'carpet': {
      ctx.beginPath();
      ctx.moveTo(x0, -H * 0.3);
      ctx.quadraticCurveTo(-L * 0.2, -H * 0.95, 0, -H * 0.3);
      ctx.quadraticCurveTo(L * 0.2, H * 0.15, x1, -H * 0.3);
      ctx.lineTo(x1 - L * 0.05, 0);
      ctx.quadraticCurveTo(0, H * 0.45, x0 + L * 0.05, 0);
      ctx.closePath();
      const grad = ctx.createLinearGradient(x0, 0, x1, 0);
      grad.addColorStop(0, '#a04ad8');
      grad.addColorStop(0.5, '#e15aa8');
      grad.addColorStop(1, '#7b4dd8');
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.strokeStyle = '#ffe066';
      ctx.lineWidth = line * 1.6;
      ctx.stroke();
      break;
    }
  }
}
