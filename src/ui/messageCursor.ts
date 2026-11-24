/** Queue/advance state machine for the message window, independent of the DOM. */

export interface CursorEntry<T> {
  value: T;
  resolve: () => void;
}

export class MessageCursor<T> {
  private queue: CursorEntry<T>[] = [];
  private head: CursorEntry<T> | null = null;

  get current(): T | null {
    return this.head?.value ?? null;
  }

  get busy(): boolean {
    return this.head !== null || this.queue.length > 0;
  }

  get pending(): number {
    return this.queue.length + (this.head ? 1 : 0);
  }

  /** Enqueue and immediately make it current when idle. Resolves when advanced past. */
  push(value: T): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.queue.push({ value, resolve });
    this.pull();
    return promise;
  }

  /**
   * Advance: `true` when the current entry has no more pages, so the next entry becomes current.
   * Returns the entry that just finished, or null.
   */
  advance(): T | null {
    const finished = this.head?.value ?? null;
    this.head?.resolve();
    this.head = null;
    this.pull();
    return finished;
  }

  /** Drop everything, resolving every pending promise so no caller waits forever. */
  clear(): void {
    const entries = this.head ? [this.head, ...this.queue] : [...this.queue];
    this.head = null;
    this.queue = [];
    for (const entry of entries) entry.resolve();
  }

  private pull(): void {
    if (this.head) return;
    this.head = this.queue.shift() ?? null;
  }
}
