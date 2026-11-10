import { describe, it, expect } from 'vitest';
import Sqlite, { withNonblockingSqlite, retrySqlite } from './sqlite.js';
import { retryWrite } from './backends/retry.js';

describe('daemon SQLite policy', () => {
  it('clamps constructor and PRAGMA timeouts only in daemon work', () => {
    const local = new Sqlite(':memory:', { timeout: 2345 });
    expect(local.pragma('busy_timeout', { simple: true })).toBe(2345);
    local.close();
    withNonblockingSqlite(() => {
      const db = new Sqlite(':memory:', { timeout: 5000 });
      expect(db.pragma('busy_timeout', { simple: true })).toBe(0);
      db.pragma('busy_timeout = 5000');
      expect(db.pragma('busy_timeout', { simple: true })).toBe(0);
      db.close();
    });
  });

  it('does not run the synchronous retry ladder in daemon work', () => {
    let calls = 0;
    const busy = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    expect(() => withNonblockingSqlite(() => retryWrite(() => { calls++; throw busy; }))).toThrow(busy);
    expect(calls).toBe(1);
  });

  it('waits asynchronously and retries only contention', async () => {
    let ready = false, calls = 0;
    const timer = setTimeout(() => { ready = true; }, 20);
    try {
      expect(await retrySqlite(() => {
        calls++;
        if (!ready) throw Object.assign(new Error('locked'), { code: 'SQLITE_BUSY' });
        return 'done';
      }, 500)).toBe('done');
      expect(calls).toBeGreaterThan(1);
      calls = 0;
      await expect(retrySqlite(() => { calls++; throw new Error('constraint'); })).rejects.toThrow('constraint');
      expect(calls).toBe(1);
      await expect(retrySqlite(() => { throw Object.assign(new Error('locked'), { code: 'SQLITE_BUSY' }); }, 20)).rejects.toThrow('locked');
    } finally { clearTimeout(timer); }
  });
});
