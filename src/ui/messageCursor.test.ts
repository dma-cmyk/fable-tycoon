import { describe, expect, it } from 'vitest';
import { MessageCursor } from './messageCursor';

describe('MessageCursor', () => {
  it('shows one entry at a time and resolves on advance', async () => {
    const cursor = new MessageCursor<string>();
    let firstDone = false;
    void cursor.push('one').then(() => { firstDone = true; });
    void cursor.push('two');
    expect(cursor.current).toBe('one');
    expect(cursor.pending).toBe(2);
    await Promise.resolve();
    expect(firstDone).toBe(false);
    expect(cursor.advance()).toBe('one');
    await Promise.resolve();
    expect(firstDone).toBe(true);
    expect(cursor.current).toBe('two');
    expect(cursor.advance()).toBe('two');
    expect(cursor.busy).toBe(false);
  });

  it('clear resolves every pending entry', async () => {
    const cursor = new MessageCursor<string>();
    let a = false;
    let b = false;
    void cursor.push('a').then(() => { a = true; });
    void cursor.push('b').then(() => { b = true; });
    cursor.clear();
    await Promise.resolve();
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(cursor.busy).toBe(false);
  });

  it('starts the next queued entry after advancing the last', () => {
    const cursor = new MessageCursor<number>();
    void cursor.push(1);
    void cursor.push(2);
    cursor.advance();
    expect(cursor.current).toBe(2);
  });
});
