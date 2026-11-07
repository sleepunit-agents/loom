import { describe, it, expect, beforeEach, afterEach, onTestFinished } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { MAX_SESSIONS, SEEN_EVERY_S, SEEN_GAP_S, SessionStore, deviceOf, prefsOf } from './sessions.js';

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

describe('one session ended alone (t-1871)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'loom-ui-sessions-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const links = Buffer.alloc(32, 9);

  it('lists each with a ref, never its id; revoking one leaves the rest, on the same token too', () => {
    const s = new SessionStore(dir);
    const phone = s.create(links, 1000, { device: 'Chrome on Android' });
    const shots = s.create(links, 1001, { device: 'HeadlessChrome on Linux', label: 'screenshots t-1871' });
    const all = s.list();
    expect(all.map((x) => x.device)).toEqual(['HeadlessChrome on Linux', 'Chrome on Android']);
    expect(all[0]).toMatchObject({ ref: s.refOf(shots), label: 'screenshots t-1871', issuedAt: 1001 });
    expect(all[0].secret.equals(links)).toBe(true);
    expect(JSON.stringify(all)).not.toContain(shots);
    // A ref is the start of the id's hash, never of the id: nothing of a live cookie is shown.
    expect(all[0].ref).toBe(createHash('sha256').update(shots).digest('hex').slice(0, 16));
    expect(all[0].ref).not.toBe(shots.slice(0, 16));
    expect(s.revoke(s.refOf(shots))).toBe(true);
    expect(s.get(shots)).toBeNull();
    expect(s.get(phone)).not.toBeNull();
    expect(s.revoke(s.refOf(shots))).toBe(false);
  });

  it('a ref must be exactly 16 hex: a prefix that could name several, or anything else, ends nothing', () => {
    const s = new SessionStore(dir);
    const id = s.create(links);
    for (const bad of ['', s.refOf(id).slice(0, 15), `${s.refOf(id)}0`, s.refOf(id).toUpperCase(), '*', id]) expect(s.revoke(bad), bad).toBe(false);
    expect(s.get(id)).not.toBeNull();
  });

  it('a ref two sessions share ends neither', () => {
    const s = new SessionStore(dir);
    s.create(links);
    // Two stored sessions whose hashes start alike (a collision in 64 bits: written by hand, as no real pair would be).
    const f = JSON.parse(readFileSync(join(dir, 'ui-sessions.json'), 'utf-8'));
    const ref = 'ab'.repeat(8);
    f.sessions = { [`${ref}${'0'.repeat(48)}`]: { issuedAt: 1, secret: links.toString('hex') }, [`${ref}${'1'.repeat(48)}`]: { issuedAt: 2, secret: links.toString('hex') } };
    writeFileSync(join(dir, 'ui-sessions.json'), JSON.stringify(f));
    expect(s.revoke(ref)).toBe(false);
    expect(s.list()).toHaveLength(2);
  });

  it('noting last use never waits on the lock nor fails, and never writes outside it', () => {
    const s = new SessionStore(dir);
    const id = s.create(links, 1000);
    // Another process holds the lock: the page's request goes on at once, and last use waits for a later one.
    writeFileSync(join(dir, 'ui-sessions.lock'), '1', { flag: 'wx' });
    const t0 = Date.now();
    expect(() => s.touch(id, 2000)).not.toThrow();
    expect(Date.now() - t0).toBeLessThan(200);
    expect(s.list()[0].seenAt).toBeUndefined();
    rmSync(join(dir, 'ui-sessions.lock'));
    // Under the lock it keeps what others wrote (a preference set between).
    s.setPrefs({ look: 'daylight' });
    s.touch(id, 2000);
    expect(s.list()[0].seenAt).toBe(2000);
    expect(s.prefs().look).toBe('daylight');
  });

  it('how it signed in is its own field: a link labelled "passkey" is still a link', () => {
    const s = new SessionStore(dir);
    s.create(links, 1000, { label: 'passkey', via: 'link' });
    expect(s.list()[0]).toMatchObject({ label: 'passkey', via: 'link' });
  });

  it('revoking one stops its notifications, and only its', () => {
    const s = new SessionStore(dir);
    const a = s.create(links), b = s.create(links);
    s.addPushSub(a, { endpoint: 'https://push.invalid/a', keys: { p256dh: 'x', auth: 'y' } });
    s.addPushSub(b, { endpoint: 'https://push.invalid/b', keys: { p256dh: 'x', auth: 'y' } });
    s.revoke(s.refOf(a));
    // Read from the file itself, before any watch (which prunes a gone session's subscriptions on its own).
    const subs = JSON.parse(readFileSync(join(dir, 'ui-sessions.json'), 'utf-8')).push.subs as Record<string, unknown>;
    expect(Object.keys(subs)).toEqual(['https://push.invalid/b']);
  });

  it('a sign-in link\'s label goes to the session it opens; a label is plain words, kept short', () => {
    const s = new SessionStore(dir);
    const code = s.createLink(links, 600, 1000, '  screenshots\nt-1871\u0007  ');
    expect(s.spendLink(code, 1001)).toEqual({ secret: links, label: 'screenshots t-1871' });
    expect(s.spendLink(code, 1001)).toBeNull();
    const bidi = s.createLink(links, 600, 1000, 'ok\u202Eevil\u200B\u2066x');
    expect(s.spendLink(bidi, 1001)!.label).toBe('ok evil x');
    const id = s.create(links, 1000, { label: 'x'.repeat(200) });
    expect(s.list().find((x) => x.ref === s.refOf(id))!.label).toHaveLength(60);
  });

  it('last used is noted at most every five minutes', () => {
    const s = new SessionStore(dir);
    const id = s.create(links, 1000);
    s.touch(id, 1010);
    s.touch(id, 1010 + SEEN_EVERY_S - 1);
    expect(s.list()[0].seenAt).toBe(1010);
    s.touch(id, 1010 + SEEN_EVERY_S);
    expect(s.list()[0].seenAt).toBe(1010 + SEEN_EVERY_S);
    s.touch('f'.repeat(64), 5000);
    expect(s.list()).toHaveLength(1);
  });

  it('names a device from its User-Agent, in a few words', () => {
    expect(deviceOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')).toBe('Safari on iPhone');
    expect(deviceOf('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36')).toBe('Chrome on Android');
    expect(deviceOf('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36')).toBe('HeadlessChrome on Linux');
    expect(deviceOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0')).toBe('Edge on Mac');
    expect(deviceOf('node')).toBeUndefined();
    expect(deviceOf(undefined)).toBeUndefined();
  });
});
