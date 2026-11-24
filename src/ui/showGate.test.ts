import { describe, expect, it, vi } from 'vitest';
import { ShowGate } from './showGate';

describe('ShowGate', () => {
  it('resolves a pending show on settle and only once', async () => {
    const gate = new ShowGate();
    const onDone = vi.fn();
    void gate.begin().then(onDone);
    expect(gate.pending).toBe(true);
    expect(gate.settle()).toBe(true);
    await Promise.resolve();
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(gate.settle()).toBe(false);
    expect(gate.pending).toBe(false);
  });

  it('resolves the previous show when a new one begins', async () => {
    const gate = new ShowGate();
    const first = vi.fn();
    const second = vi.fn();
    void gate.begin().then(first);
    void gate.begin().then(second);
    await Promise.resolve();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    gate.settle();
    await Promise.resolve();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('cancel/settle resolves a never-ending show (dice cancel regression)', async () => {
    const gate = new ShowGate();
    let settled = false;
    void gate.begin().then(() => {
      settled = true;
    });
    gate.settle();
    await Promise.resolve();
    expect(settled).toBe(true);
  });
});
