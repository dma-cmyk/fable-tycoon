// Uniform screen-space grid used for label collision and city hit testing.
// Keeps per-frame work near O(labels) instead of O(labels²) as the board grows.

export interface GridRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class RectGrid<T> {
  private readonly cellSize: number;
  private cells = new Map<number, T[]>();

  constructor(cellSize = 64) {
    this.cellSize = Math.max(8, cellSize);
  }

  clear(): void {
    if (this.cells.size > 0) this.cells.clear();
  }

  private key(cx: number, cy: number): number {
    // Screen coordinates are small; the offsets keep negative cells distinct.
    return (cx + 4096) * 16384 + (cy + 4096);
  }

  add(rect: GridRect, item: T): void {
    const cs = this.cellSize;
    const x0 = Math.floor(rect.x / cs);
    const y0 = Math.floor(rect.y / cs);
    const x1 = Math.floor((rect.x + rect.w) / cs);
    const y1 = Math.floor((rect.y + rect.h) / cs);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const key = this.key(cx, cy);
        const bucket = this.cells.get(key);
        if (bucket) bucket.push(item);
        else this.cells.set(key, [item]);
      }
    }
  }

  queryPoint(x: number, y: number): T[] {
    const cs = this.cellSize;
    return this.cells.get(this.key(Math.floor(x / cs), Math.floor(y / cs))) ?? [];
  }

  queryRect(rect: GridRect): T[] {
    const cs = this.cellSize;
    const x0 = Math.floor(rect.x / cs);
    const y0 = Math.floor(rect.y / cs);
    const x1 = Math.floor((rect.x + rect.w) / cs);
    const y1 = Math.floor((rect.y + rect.h) / cs);
    const out: T[] = [];
    const seen = new Set<T>();
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const bucket = this.cells.get(this.key(cx, cy));
        if (!bucket) continue;
        for (const item of bucket) {
          if (seen.has(item)) continue;
          seen.add(item);
          out.push(item);
        }
      }
    }
    return out;
  }
}
