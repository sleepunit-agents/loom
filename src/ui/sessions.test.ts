import { describe, it, expect, beforeEach, afterEach, onTestFinished } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_SESSIONS, SEEN_GAP_S, SessionStore, prefsOf } from './sessions.js';

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

describe('a look kept from before Low Light and Daylight', () => {
  it('reads back as the look nearest it: Daylight if its mode was light, else Low Light; the others as they are', async () => {
    // A file written before 2026-11-05: the household's owner on 000h light, a member on 000h dark.
    const dir = mkdtempSync(join(tmpdir(), 'loom-prefs-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'ui-sessions.json'), JSON.stringify({ v: 1, sessions: {}, prefs: { look: '000h', mode: 'light', at: 1 }, members: { sam: { prefs: { look: '000h', mode: 'dark', at: 1 } } } }));
    const store = new SessionStore(dir);
    expect(store.prefs()).toMatchObject({ look: 'daylight' });
    expect(store.prefs('sam')).toMatchObject({ look: 'lowlight' });
    // Another choice saved leaves the 000h on disk as it was (an app that knew 000h still finds it), read back mapped.
    expect(store.setPrefs({ sound: true })).toMatchObject({ look: 'daylight', sound: true });
    expect(JSON.parse(readFileSync(join(dir, 'ui-sessions.json'), 'utf-8')).prefs).toMatchObject({ look: '000h', mode: 'light', sound: true });
  });
});

describe('One window at a time kept from before tiling was the only desktop (docs/specs/desk-tiling.md)', () => {
  it('a saved tiling: false reads back as oneWindow: true until the person chooses; tiling: true or none is off', () => {
    // A file written before 2026-11-06: the owner chose One window at a time under Appearance's Desktop, sam Tiling.
    const dir = mkdtempSync(join(tmpdir(), 'loom-prefs-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'ui-sessions.json'), JSON.stringify({ v: 1, sessions: {}, prefs: { tiling: false, at: 1 },
      members: { sam: { prefs: { tiling: true, at: 1 } }, kim: { prefs: { look: 'neon', at: 1 } } } }));
    const store = new SessionStore(dir);
    expect(store.prefs()).toMatchObject({ oneWindow: true });
    expect(store.prefs('sam').oneWindow).toBeUndefined();
    expect(store.prefs('kim').oneWindow).toBeUndefined();
    // Another choice saved keeps it; the stored key stays as it was.
    expect(store.setPrefs({ sound: true })).toMatchObject({ oneWindow: true, sound: true });
    expect(JSON.parse(readFileSync(join(dir, 'ui-sessions.json'), 'utf-8')).prefs).toMatchObject({ tiling: false, sound: true });
    expect(JSON.parse(readFileSync(join(dir, 'ui-sessions.json'), 'utf-8')).prefs.oneWindow).toBeUndefined();
    // Their own choice in Accessibility wins.
    expect(store.setPrefs({ oneWindow: false })).toMatchObject({ oneWindow: false });
    expect(store.prefs()).toMatchObject({ oneWindow: false });
  });

  it('an older app still saving tiling gets no error; oneWindow is taken too, and nothing else', () => {
    expect(prefsOf({ tiling: false })).toEqual({ tiling: false });
    expect(prefsOf({ tiling: true, _csrf: 'x' })).toEqual({ tiling: true });
    expect(prefsOf({ oneWindow: true })).toEqual({ oneWindow: true });
    expect(prefsOf({ oneWindow: 'yes' })).toBeNull();
  });
});
