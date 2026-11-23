import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeStorage {
  private readonly data = new Map<string, string>();

  get length(): number {
    return this.data.size;
  }

  clear(): void {
    this.data.clear();
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  setItem(key: string, value: string): void {
    this.data.set(key, String(value));
  }
}

describe('persistent signing identity', () => {
  let storage: FakeStorage;

  beforeEach(() => {
    storage = new FakeStorage();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: storage,
    });
    vi.resetModules();
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'localStorage');
  });

  it('restores the same fingerprint after a fresh module load (page reload)', async () => {
    const first = await import('./identity');
    const generated = await first.generateIdentity();
    expect(storage.getItem('fable.identity')).toBeTruthy();

    // Simulate a page reload: fresh module instance, same localStorage.
    vi.resetModules();
    const reloaded = await import('./identity');
    const restored = await reloaded.loadIdentity('reload-test-client');

    expect(restored.fingerprint).toBe(generated.fingerprint);
    expect(restored.publicJwk.x).toBe(generated.publicJwk.x);
    expect(restored.publicJwk.y).toBe(generated.publicJwk.y);
  });
});