/** A single-owner promise gate used by presentation overlays (e.g. the 3D dice). */
export class ShowGate {
  private resolveFn: (() => void) | null = null;

  get pending(): boolean {
    return this.resolveFn !== null;
  }

  /** Starts a new show; a previous pending show resolves immediately. */
  begin(): Promise<void> {
    this.settle();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.resolveFn = resolve;
    return promise;
  }

  /** Resolves the pending show exactly once. Returns true when it was pending. */
  settle(): boolean {
    const resolve = this.resolveFn;
    if (!resolve) return false;
    this.resolveFn = null;
    resolve();
    return true;
  }
}
