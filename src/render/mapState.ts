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
