// Screen-edge indicator for an off-screen token. Pure geometry so the play view and its
// tests agree on where the portrait chip lands and which way the arrow points.

export interface EdgeHintBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type EdgeHintEdge = 'left' | 'right' | 'top' | 'bottom';

export interface EdgeHintPlacement {
  /** Centre of the chip, canvas CSS px. */
  x: number;
  y: number;
  /** CSS `rotate()` angle in radians (0 = right, clockwise). */
  angle: number;
  edge: EdgeHintEdge;
}

export interface EdgeHintInput {
  /** Usable board area (HUD-free) in canvas CSS px. */
  box: EdgeHintBox;
  /** Target position minus the box centre, canvas CSS px. */
  dx: number;
  dy: number;
  /** Chip size in CSS px. */
  width: number;
  height: number;
  /** Gap between the chip and the board edge. */
  margin?: number;
}

/** True when (x, y) is outside the box, optionally shrunk by `inset` on every side. */
export function isPointOutsideBox(box: EdgeHintBox, x: number, y: number, inset = 0): boolean {
  return x < box.left + inset || x > box.right - inset || y < box.top + inset || y > box.bottom - inset;
}

/**
 * Intersect the ray from the box centre toward the target with the inset board box and
 * return a chip centre on that edge plus the arrow angle. Returns null when the box is too
 * small for the chip or the direction is degenerate.
 */
export function placeEdgeHint(input: EdgeHintInput): EdgeHintPlacement | null {
  const { box, dx, dy, width, height } = input;
  const margin = input.margin ?? 8;
  const left = box.left + margin + width / 2;
  const right = box.right - margin - width / 2;
  const top = box.top + margin + height / 2;
  const bottom = box.bottom - margin - height / 2;
  if (right < left || bottom < top) return null;
  const length = Math.hypot(dx, dy);
  if (!(length > 0.5)) return null;
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  const ux = dx / length;
  const uy = dy / length;
  const halfW = (right - left) / 2;
  const halfH = (bottom - top) / 2;
  const tx = ux !== 0 ? halfW / Math.abs(ux) : Infinity;
  const ty = uy !== 0 ? halfH / Math.abs(uy) : Infinity;
  const t = Math.min(tx, ty);
  const x = Math.max(left, Math.min(right, cx + ux * t));
  const y = Math.max(top, Math.min(bottom, cy + uy * t));
  const gaps: Array<[EdgeHintEdge, number]> = [
    ['left', x - left],
    ['right', right - x],
    ['top', y - top],
    ['bottom', bottom - y],
  ];
  let edge: EdgeHintEdge = 'left';
  let gap = Infinity;
  for (const [candidate, value] of gaps) {
    if (value < gap) {
      gap = value;
      edge = candidate;
    }
  }
  return { x, y, angle: Math.atan2(dy, dx), edge };
}