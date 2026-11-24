// Pure state-reconciliation helpers used by MapView's authoritative setState.
// Keeping these DOM-free makes the resync invariants unit-testable.

/**
 * Decide whether an in-flight move/warp must be cancelled because an adopted
 * snapshot places its player somewhere other than the animation's end node.
 */
export function shouldCancelForSnapshot(
  animationEndNodeId: string,
  snapshotNodeId: string | undefined,
): boolean {
  return snapshotNodeId === undefined || snapshotNodeId !== animationEndNodeId;
}

export interface BoardRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BoardSafeArea {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * Compute the unobstructed board rectangle left free by safe-area insets and HUD obstacles.
 * Keeps a sane minimum (120x96px, clamped to canvas) so small landscape phones (e.g. 844x390)
 * still respect both the top ranking strip and bottom move-option list without hiding markers.
 */
export function computeFreeBoardBox(
  cssW: number,
  cssH: number,
  safeArea: BoardSafeArea,
  obstacles: ReadonlyArray<BoardRect>,
  inset = 0,
): BoardRect {
  const minW = Math.min(cssW, 120);
  const minH = Math.min(cssH, 96);
  const top = Math.max(0, safeArea.top);
  const right = Math.max(0, safeArea.right);
  const bottom = Math.max(0, safeArea.bottom);
  const left = Math.max(0, safeArea.left);

  let x0 = Math.min(Math.max(0, cssW - minW), left);
  let y0 = Math.min(Math.max(0, cssH - minH), top);
  let x1 = Math.max(x0 + minW, cssW - right);
  let y1 = Math.max(y0 + minH, cssH - bottom);
  // If right/bottom pushed past the canvas edge because top+bottom exceeded cssH-minH,
  // keep the box strictly inside [0, cssW] x [0, cssH].
  if (x1 > cssW) {
    x1 = cssW;
    x0 = Math.max(0, Math.min(x0, x1 - minW));
  }
  if (y1 > cssH) {
    y1 = cssH;
    y0 = Math.max(0, Math.min(y0, y1 - minH));
  }

  x0 += inset;
  y0 += inset;
  x1 -= inset;
  y1 -= inset;

  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const o of obstacles) {
      if (o.w <= 0 || o.h <= 0) continue;
      const overlapW = Math.min(x1, o.x + o.w) - Math.max(x0, o.x);
      const overlapH = Math.min(y1, o.y + o.h) - Math.max(y0, o.y);
      if (overlapW <= 0 || overlapH <= 0) continue;
      const cutLeft = o.x + o.w - x0;
      const cutRight = x1 - o.x;
      const cutTop = o.y + o.h - y0;
      const cutBottom = y1 - o.y;
      const cut = Math.min(cutLeft, cutRight, cutTop, cutBottom);
      if (cut <= 0) continue;
      if (cut === cutLeft) x0 = Math.min(x1 - 60, o.x + o.w + 2);
      else if (cut === cutRight) x1 = Math.max(x0 + 60, o.x - 2);
      else if (cut === cutTop) y0 = Math.min(y1 - 60, o.y + o.h + 2);
      else y1 = Math.max(y0 + 60, o.y - 2);
      changed = true;
    }
    if (!changed) break;
  }
  return { x: x0, y: y0, w: Math.max(60, x1 - x0), h: Math.max(60, y1 - y0) };
}

/**
 * True when a candidate square's entire highlight ring fits inside the HUD-free board box.
 * Any candidate whose ring would dip under the move list or ranking HUD is treated as off-board
 * so it is rendered as a numbered edge badge instead of being clipped/hidden behind HUD chrome.
 */
export function isCandidateRingVisible(
  x: number,
  y: number,
  freeBox: BoardRect,
  ringRadius: number,
): boolean {
  const pad = Math.max(0, ringRadius);
  const rx = Math.min(pad, Math.max(0, freeBox.w / 2 - 4));
  const ry = Math.min(pad, Math.max(0, freeBox.h / 2 - 4));
  return (
    x >= freeBox.x + rx &&
    x <= freeBox.x + freeBox.w - rx &&
    y >= freeBox.y + ry &&
    y <= freeBox.y + freeBox.h - ry
  );
}

/**
 * Resolve a token position when an animation is cancelled.
 *
 * `applyEnd = true` is used when a *new* animation intentionally displaces the
 * old one (settle it at its old end). `applyEnd = false` is required when an
 * authoritative snapshot has just been adopted: the snapshot position must win
 * over the stale animation end.
 */
export function resolveCancelledToken(
  snapshotNodeId: string | undefined,
  animationEndNodeId: string,
  applyEnd: boolean,
): string | undefined {
  return applyEnd ? animationEndNodeId : snapshotNodeId;
}
