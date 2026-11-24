/**
 * 目的地方向矢印の配置計算（DOM 非依存）。
 *
 * 盤面の「空いている矩形」の辺上に置き、HUD（立ち絵・ミニマップ・資産欄など）の
 * 矩形とは絶対に重ねない。画面サイズと HUD の矩形を渡すだけで決まるので単体テストできる。
 */

export interface ArrowRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ArrowPlacementInput {
  /** 盤面（canvas）の大きさ。 */
  width: number;
  height: number;
  /** 矢印を置いてよい領域（HUD を除いた内側）。null なら配置しない。 */
  box: ArrowRect | null;
  /** 避けたい HUD 矩形。 */
  blockers: readonly ArrowRect[];
  /** 目的地方向のベクトル（画面座標系、+y は下）。 */
  dx: number;
  dy: number;
  /** 矢印自身の半幅・半高（はみ出し防止）。 */
  marginX?: number;
  marginY?: number;
}

export interface ArrowPlacement {
  x: number;
  y: number;
  angle: number;
}

function intersects(a: ArrowRect, b: ArrowRect, pad: number): boolean {
  return !(a.right + pad <= b.left || a.left - pad >= b.right || a.bottom + pad <= b.top || a.top - pad >= b.bottom);
}

/**
 * 楕円（盤面の空き領域）の縁へ置き、HUD と重なるなら同じ辺に沿って中央側へずらす。
 * それでも重なる場合は縦位置を HUD の上へ逃がす。最後に空き領域内へクランプする。
 */
export function placeDestinationArrow(input: ArrowPlacementInput): ArrowPlacement | null {
  const { width, height, box, blockers, dx, dy } = input;
  if (!box || width < 10 || height < 10) return null;
  if (box.right - box.left < 120 || box.bottom - box.top < 120) return null;
  if (Math.abs(dx) + Math.abs(dy) < 1) return null;
  const marginX = input.marginX ?? 30;
  const marginY = input.marginY ?? 26;
  const cx = (box.left + box.right) / 2;
  const cy = (box.top + box.bottom) / 2;
  const radiusX = Math.max(30, (box.right - box.left) / 2 - marginX);
  const radiusY = Math.max(30, (box.bottom - box.top) / 2 - marginY);
  const angle = Math.atan2(dy, dx);
  const scale = 1 / Math.max(Math.abs(Math.cos(angle)) / radiusX, Math.abs(Math.sin(angle)) / radiusY);
  let x = cx + Math.cos(angle) * scale;
  let y = cy + Math.sin(angle) * scale;
  const clampX = (value: number): number => Math.min(box.right - marginX, Math.max(box.left + marginX, value));
  const clampY = (value: number): number => Math.min(box.bottom - marginY, Math.max(box.top + marginY, value));
  x = clampX(x);
  y = clampY(y);

  const nearBottom = Math.abs(y - (box.bottom - marginY)) <= 2;
  const nearTop = Math.abs(y - (box.top + marginY)) <= 2;
  const arrowRect = (): ArrowRect => ({ left: x - marginX, right: x + marginX, top: y - marginY, bottom: y + marginY });

  for (const blocker of blockers) {
    if (!intersects(arrowRect(), blocker, 4)) continue;
    if (nearBottom || nearTop) {
      // 水平の辺にいるなら、HUD の左右どちらか近い側へ寄せる。
      const leftCandidate = blocker.left - marginX - 8;
      const rightCandidate = blocker.right + marginX + 8;
      const preferLeft = Math.abs(x - leftCandidate) <= Math.abs(x - rightCandidate);
      x = clampX(preferLeft ? leftCandidate : rightCandidate);
      if (intersects(arrowRect(), blocker, 4)) {
        y = clampY(nearBottom ? blocker.top - marginY - 8 : blocker.bottom + marginY + 8);
      }
    } else {
      y = clampY(blocker.top - marginY - 8);
    }
  }
  return { x, y, angle };
}