// Ambient world motion: drifting cloud shadows, sea/air/rail traffic and birds.
// Drawn under city labels/tokens by MapView. MapView decides the 30fps ambient
// cadence and reduced-motion/hidden-tab pauses.

import { MAP_H, MAP_W, wrapDx } from '../core/geo';
import type { GameData } from '../core/types';
import type { Camera } from './camera';
import { drawVehicle, type VehicleKind } from './vehicles';

const TAU = Math.PI * 2;

interface TrafficRoute {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  phase: number;
  duration: number;
  kind: VehicleKind;
  lane: number;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function cloudSprite(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 260;
  c.height = 140;
  const ctx = c.getContext('2d');
  if (!ctx) return c;
  const blobs: Array<[number, number, number]> = [
    [80, 80, 58],
    [128, 62, 68],
    [180, 84, 52],
    [110, 96, 42],
    [196, 100, 30],
  ];
  for (const [x, y, r] of blobs) {
    const g = ctx.createRadialGradient(x, y, r * 0.12, x, y, r);
    g.addColorStop(0, 'rgba(9, 48, 68, 0.55)');
    g.addColorStop(0.7, 'rgba(9, 48, 68, 0.22)');
    g.addColorStop(1, 'rgba(9, 48, 68, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  return c;
}

export class AmbientWorld {
  private readonly cloud = cloudSprite();
  private readonly seaRoutes: TrafficRoute[] = [];
  private readonly railRoutes: TrafficRoute[] = [];
  private readonly airRoutes: TrafficRoute[] = [];

  constructor(data: GameData, private readonly vehicles?: Map<string, HTMLImageElement>) {
    const nodes = new Map(data.board.nodes.map((n) => [n.id, n]));
    const sea: TrafficRoute[] = [];
    const rail: TrafficRoute[] = [];
    for (const edge of data.board.edges) {
      const a = nodes.get(edge.a);
      const b = nodes.get(edge.b);
      if (!a || !b || a.realm || b.realm) continue;
      if (Math.hypot(wrapDx(a.x, b.x), b.y - a.y) < 18) continue;
      const base = hash(`${edge.a}|${edge.b}`);
      const route: TrafficRoute = {
        ax: a.x,
        ay: a.y,
        bx: b.x,
        by: b.y,
        phase: (base % 1000) / 1000,
        duration: 14000 + (base % 9000),
        kind: 'ferry',
        lane: base % 7,
      };
      if (edge.mode === 'sea') sea.push(route);
      else rail.push(route);
    }
    sea.sort((a, b) => a.phase - b.phase);
    rail.sort((a, b) => a.phase - b.phase);
    const seaKinds: VehicleKind[] = ['ferry', 'sailboat', 'ferry', 'sailboat'];
    const railKinds: VehicleKind[] = ['train', 'express', 'bullet_train', 'train'];
    const shipCount = Math.min(9, Math.max(4, Math.round(sea.length * 0.03)));
    const trainCount = Math.min(8, Math.max(3, Math.round(rail.length * 0.02)));
    for (let i = 0; i < Math.min(shipCount, sea.length); i++) {
      const r = { ...sea[Math.floor((i * sea.length) / shipCount)] };
      r.kind = seaKinds[i % seaKinds.length];
      r.phase = (r.phase + i * 0.17) % 1;
      r.duration = 18000 + (i % 4) * 4000;
      this.seaRoutes.push(r);
    }
    for (let i = 0; i < Math.min(trainCount, rail.length); i++) {
      const r = { ...rail[Math.floor((i * rail.length) / trainCount)] };
      r.kind = railKinds[i % railKinds.length];
      r.phase = (r.phase + i * 0.23) % 1;
      r.duration = 9000 + (i % 3) * 2500;
      this.railRoutes.push(r);
    }

    const airports = data.cities
      .map((c) => ({ c, n: nodes.get(`c:${c.id}`) }))
      .filter((v): v is { c: (typeof data.cities)[number]; n: NonNullable<ReturnType<typeof nodes.get>> } => !!v.n && v.c.airport && !v.c.realm);
    for (let i = 0; i < Math.min(4, airports.length); i++) {
      const a = airports[i];
      const b = airports[(i * 3 + 5) % airports.length];
      if (!b || a.c.id === b.c.id) continue;
      const base = hash(`${a.c.id}|${b.c.id}`);
      this.airRoutes.push({
        ax: a.n.x,
        ay: a.n.y,
        bx: b.n.x,
        by: b.n.y,
        phase: (base % 1000) / 1000,
        duration: 24000 + (base % 9000),
        kind: 'plane',
        lane: i,
      });
    }
  }

  /** Draw ambient shadows and traffic. `detail` is the MapView LOD (0/1/2). */
  draw(
    ctx: CanvasRenderingContext2D,
    cam: Camera,
    now: number,
    detail: number,
    isLand?: (x: number, y: number) => boolean,
  ): void {
    this.drawClouds(ctx, cam, now);
    this.drawOceanDecor(ctx, cam, now, isLand);
    this.drawRoutes(ctx, cam, now, this.seaRoutes, 'sea');
    this.drawRoutes(ctx, cam, now, this.airRoutes, 'air');
    if (detail >= 1) {
      this.drawRoutes(ctx, cam, now, this.railRoutes, 'rail');
      this.drawBirds(ctx, cam, now);
    }
  }

  private drawOceanDecor(
    ctx: CanvasRenderingContext2D,
    cam: Camera,
    now: number,
    isLand?: (x: number, y: number) => boolean,
  ): void {
    const whaleScale = Math.min(36, Math.max(14, 8 + cam.zoom * 12));
    const candidates = [
      { fx: 0.12, fy: 0.58, phase: 0.0 },
      { fx: 0.56, fy: 0.46, phase: 2.1 },
      { fx: 0.82, fy: 0.66, phase: 4.2 },
    ];
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const wx = (c.fx + Math.sin(now / 24000 + c.phase) * 0.035) * MAP_W;
      const wy = (c.fy + Math.cos(now / 30000 + c.phase) * 0.03) * MAP_H;
      if (isLand?.(wx, wy)) continue;
      const x = cam.screenX(wx);
      const y = cam.screenY(wy);
      if (x < -60 || x > cam.vw + 60 || y < -60 || y > cam.vh + 60) continue;
      ctx.save();
      ctx.translate(x, y);
      const bob = Math.sin(now / 900 + i * 2) * 2;
      // whale body + tail + spout
      ctx.fillStyle = '#31597d';
      ctx.beginPath();
      ctx.ellipse(0, bob, whaleScale * 0.55, whaleScale * 0.2, 0, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(whaleScale * 0.45, bob);
      ctx.lineTo(whaleScale * 0.72, bob - whaleScale * 0.18);
      ctx.lineTo(whaleScale * 0.72, bob + whaleScale * 0.18);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(235, 252, 255, 0.85)';
      ctx.lineWidth = 1.6;
      const spout = 0.4 + 0.6 * Math.abs(Math.sin(now / 2600 + i));
      for (let k = 0; k < 3; k++) {
        ctx.beginPath();
        ctx.moveTo(-whaleScale * 0.1, bob - whaleScale * 0.15);
        ctx.quadraticCurveTo(
          -whaleScale * (0.2 + k * 0.06),
          bob - whaleScale * (0.5 + spout * 0.5),
          -whaleScale * (0.05 + k * 0.12),
          bob - whaleScale * (0.8 + spout * 0.5),
        );
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(0, bob + whaleScale * 0.2, whaleScale * 0.7, whaleScale * 0.12, 0, 0, TAU);
      ctx.stroke();
      ctx.restore();
      if (i === 0) {
        const sx = x + Math.sin(now / 17000) * 50;
        const sy = y + 44;
        drawVehicle(ctx, 'sailboat', sx, sy, Math.max(18, whaleScale * 1.1), 1, this.vehicles?.get('sailboat'));
      }
    }
  }

  private drawClouds(ctx: CanvasRenderingContext2D, cam: Camera, now: number): void {
    const count = 5;
    ctx.save();
    ctx.globalAlpha = 0.16;
    for (let i = 0; i < count; i++) {
      const wx = (now * 0.005 + (i * MAP_W) / count + i * 1300) % MAP_W;
      const wy = ((i + 0.5) / count) * MAP_H + Math.sin(now / 6000 + i * 1.9) * 55;
      const sx = cam.screenX(wx);
      const sy = cam.screenY(wy);
      if (sx < -260 || sx > cam.vw + 260 || sy < -180 || sy > cam.vh + 180) continue;
      const scale = 1.2 + (i % 3) * 0.45;
      ctx.drawImage(this.cloud, sx - 130 * scale, sy - 70 * scale, 260 * scale, 140 * scale);
    }
    ctx.restore();
  }

  private drawRoutes(
    ctx: CanvasRenderingContext2D,
    cam: Camera,
    now: number,
    routes: TrafficRoute[],
    kind: 'sea' | 'air' | 'rail',
  ): void {
    const length = Math.min(42, Math.max(16, 10 + cam.zoom * 12));
    for (const r of routes) {
      const ax = cam.screenX(r.ax);
      const ay = cam.screenY(r.ay);
      const bx = ax + wrapDx(r.ax, r.bx) * cam.zoom;
      const by = ay + (r.by - r.ay) * cam.zoom;
      const p = ((now / r.duration + r.phase) % 1 + 1) % 1;
      let x = ax + (bx - ax) * p;
      let y = ay + (by - ay) * p;
      const facing = bx >= ax ? 1 : -1;
      let lift = 0;
      if (kind === 'air') {
        lift = Math.sin(p * Math.PI) * (26 + (r.lane % 2) * 18);
        y -= lift;
      } else if (kind === 'sea') {
        y += Math.sin(now / 520 + r.phase * 9) * 1.8;
      } else {
        y += Math.sin(now / 90 + r.phase * 20) * 0.7;
      }
      if (x < -70 || x > cam.vw + 70 || y < -70 || y > cam.vh + 70) continue;
      const angle = kind === 'air' ? Math.atan2(by - ay, bx - ax) : 0;
      const tilt = kind === 'air' ? angle : Math.atan2(by - ay, bx - ax) * 0.15;
      drawVehicle(ctx, r.kind, x, y, length, facing, this.vehicles?.get(r.kind), tilt);
      // Ambience particles are intentionally cheap: a few strokes/blips.
      if (kind === 'sea') {
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.lineWidth = 1.3;
        for (let i = 1; i <= 3; i++) {
          const wx = x - facing * length * (0.45 + i * 0.13);
          ctx.beginPath();
          ctx.arc(wx, y + 1, length * 0.08 * i, 0.15, Math.PI - 0.15);
          ctx.stroke();
        }
        ctx.restore();
      } else if (kind === 'rail') {
        ctx.save();
        ctx.globalAlpha = 0.65;
        ctx.fillStyle = '#ffffff';
        for (let i = 1; i <= 2; i++) {
          ctx.beginPath();
          ctx.arc(x - facing * length * (0.35 + i * 0.12), y - length * (0.28 + i * 0.04) - (now / 30 + i * 3) % 6, 1.8, 0, Math.PI * 2);
          ctx.fill();
        }
        if (r.kind === 'bullet_train') {
          ctx.strokeStyle = 'rgba(255,255,255,0.65)';
          ctx.lineWidth = 1;
          for (let i = 1; i <= 3; i++) {
            ctx.beginPath();
            ctx.moveTo(x - facing * length * (0.45 + i * 0.12), y - length * 0.2);
            ctx.lineTo(x - facing * length * (0.6 + i * 0.18), y - length * 0.2);
            ctx.stroke();
          }
        }
        ctx.restore();
      } else if (kind === 'air') {
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.45)';
        ctx.lineWidth = 1.2;
        ctx.setLineDash([2, 5]);
        ctx.beginPath();
        ctx.moveTo(x - facing * length * 0.5, y + length * 0.1);
        ctx.lineTo(x - facing * length * 2.2, y + length * 0.1 + 4);
        ctx.stroke();
        ctx.restore();
        ctx.save();
        ctx.globalAlpha = 0.18;
        ctx.fillStyle = '#06314a';
        ctx.beginPath();
        ctx.ellipse(x, y + lift + 2, length * 0.25, length * 0.06, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
  }

  private drawBirds(ctx: CanvasRenderingContext2D, cam: Camera, now: number): void {
    ctx.save();
    ctx.strokeStyle = 'rgba(28, 48, 72, 0.72)';
    ctx.lineWidth = 1.6;
    ctx.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      const cycle = 22000 + i * 6000;
      const local = (now + i * 7300) % cycle;
      if (local > 7000) continue;
      const p = local / 7000;
      const x = -40 + p * (cam.vw + 80);
      const y = cam.vh * (0.18 + i * 0.08) + Math.sin(now / 520 + i * 2) * 7;
      const flap = Math.sin(now / 90 + i) * 3.5;
      ctx.beginPath();
      ctx.moveTo(x - 7, y + flap);
      ctx.quadraticCurveTo(x - 3, y - 2, x, y);
      ctx.quadraticCurveTo(x + 3, y - 2, x + 7, y + flap);
      ctx.stroke();
    }
    ctx.restore();
  }
}
