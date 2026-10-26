import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_SESSIONS, SEEN_GAP_S, SessionStore } from './sessions.js';

describe('the page\'s sessions on disk', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'loom-ui-sessions-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const digest = Buffer.alloc(32, 7);

  it('a session outlives its process: a new store on the same dir still knows it', () => {
    const id = new SessionStore(dir).create(digest, 1000);
    const after = new SessionStore(dir);
    expect(after.get(id)).toEqual({ issuedAt: 1000, secret: digest });
    expect(after.get('f'.repeat(64))).toBeNull();
  });

  it('keeps only a hash of each id, in 0600 files', () => {
    const id = new SessionStore(dir).create(digest);
    const raw = readFileSync(join(dir, 'ui-sessions.json'), 'utf-8');
    expect(raw).not.toContain(id);
    expect(statSync(join(dir, 'ui-sessions.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'ui-cookie.key')).mode & 0o777).toBe(0o600);
  });

  it('logout from any process ends it everywhere', () => {
    const a = new SessionStore(dir);
    const id = a.create(digest);
    new SessionStore(dir).delete(id);
    expect(a.get(id)).toBeNull();
  });

  it('keeps the newest sessions past the cap', () => {
    const s = new SessionStore(dir);
    const ids = Array.from({ length: MAX_SESSIONS + 3 }, (_, i) => s.create(digest, 1000 + i));
    expect(s.get(ids[0])).toBeNull();
    expect(s.get(ids[2])).toBeNull();
    expect(s.get(ids[3])).not.toBeNull();
    expect(s.get(ids.at(-1)!)).not.toBeNull();
  });

  it('the anti-forgery key is the same across processes and restarts', () => {
    const k = new SessionStore(dir).key;
    expect(k.length).toBe(32);
    expect(new SessionStore(dir).key.equals(k)).toBe(true);
  });
  it('a sign-in link is good once, within its minutes, and kept only by hash', () => {
    const s = new SessionStore(dir);
    const code = s.createLink(digest, 600, 1000);
    expect(readFileSync(join(dir, 'ui-sessions.json'), 'utf-8')).not.toContain(code);
    expect(new SessionStore(dir).useLink(code, 1100)).toEqual(digest);
    expect(s.useLink(code, 1100)).toBeNull();
    const late = s.createLink(digest, 600, 1000);
    expect(s.useLink(late, 1601)).toBeNull();
    expect(s.useLink('0'.repeat(64), 1000)).toBeNull();
  });

  it('"since you last looked" moves up only after 15 minutes away', () => {
    const store = new SessionStore(dir);
    const t0 = 1_800_000_000;
    expect(store.lookedAt(t0)).toBe(t0);                 // first visit: nothing is new
    expect(store.lookedAt(t0 + 60)).toBe(t0);            // a reload a minute later keeps the boundary
    expect(store.lookedAt(t0 + 60 + SEEN_GAP_S)).toBe(t0 + 60); // back after a while: new since the last look
    expect(store.lookedAt(t0 + 120 + SEEN_GAP_S)).toBe(t0 + 60);
  });
});
