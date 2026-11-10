import { it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadHousehold, setAbout, aboutOf } from '../household.js';
import { withNonblockingSqlite } from '../sqlite.js';
import { FileLockBusy } from '../file-lock.js';
import { startHttpServer } from './http-server.js';

it('household contention fails before mutation in daemon scope, preserving the holder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loom-household-lock-'));
  try {
    writeFileSync(join(dir, 'household.json'), JSON.stringify({ v: 1, agents: ['art'], default: 'art' }));
    const h = loadHousehold(dir)!;
    const lock = join(dir, '.household.lock');
    writeFileSync(lock, String(process.pid));
    const start = performance.now();
    let error: unknown;
    try { withNonblockingSqlite(() => setAbout(h, 'art', 'should not save')); } catch (e) { error = e; }
    const elapsed = performance.now() - start;
    console.log(`held household lock: ${Math.round(elapsed)} ms`);
    expect(elapsed).toBeLessThan(500);
    expect(error).toBeInstanceOf(FileLockBusy);
    expect(readFileSync(lock, 'utf8')).toBe(String(process.pid));
    expect(aboutOf(h, 'art')).toBeUndefined();
    rmSync(lock);
    setAbout(h, 'art', 'saved after release');
    expect(aboutOf(h, 'art')).toBe('saved after release');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('a held session lock cannot freeze /login or issue a session; release permits sign-in', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loom-session-lock-'));
  const handle = await startHttpServer({ contextDir: dir, host: '127.0.0.1', port: 0, token: 'test-lock-token' });
  const base = `http://127.0.0.1:${handle.port}`;
  const lock = join(dir, 'ui-sessions.lock');
  try {
    writeFileSync(lock, String(process.pid));
    const start = performance.now();
    const post = fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'token=test-lock-token', redirect: 'manual' });
    // Let the POST reach its critical section before the GET. A synchronous lock wait blocks this timer too.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const login = await fetch(`${base}/login`);
    const failed = await post;
    const elapsed = performance.now() - start;
    console.log(`held session lock, POST plus /login: ${Math.round(elapsed)} ms, POST ${failed.status}`);
    expect(elapsed).toBeLessThan(700);
    expect(login.status).toBe(200);
    expect(failed.status).toBe(503);
    expect(failed.headers.get('retry-after')).toBe('1');
    expect(failed.headers.get('set-cookie')).toBeNull();
    expect(existsSync(join(dir, 'ui-sessions.json'))).toBe(false);
    expect(readFileSync(lock, 'utf8')).toBe(String(process.pid));
    rmSync(lock);
    const signed = await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'token=test-lock-token', redirect: 'manual' });
    expect(signed.status).toBe(303);
    expect(signed.headers.get('set-cookie')).toContain('HttpOnly');
  } finally { await handle.close(); rmSync(dir, { recursive: true, force: true }); }
});
