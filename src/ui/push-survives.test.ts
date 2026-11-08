// t-1978: a device's notifications belong to its person and the device, not to the session it was turned on in.
// The cause, reproduced in the first test: a subscription was kept under its session, and the watch dropped any whose
// session was no longer on file. Agent screenshot sign-ins (about 20 a day) filled the 50-session cap, each new one
// evicting the oldest, so Jonathan's phone session went within days, and with it his phone's subscription. The phone
// itself still held its subscription, so Profile said "On" and nothing ever sent it again.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_SESSION_MAX_AGE_S, MAX_SESSIONS, SessionStore } from './sessions.js';

const phone = { endpoint: 'https://web.push.apple.com/QJ-phone', keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } };
const laptop = { endpoint: 'https://fcm.googleapis.com/fcm/send/laptop', keys: { p256dh: 'C'.repeat(87), auth: 'b'.repeat(22) } };

describe('a device\'s notifications outlive the session they were turned on in (t-1978)', () => {
  let dir: string;
  let s: SessionStore;
  const his = Buffer.alloc(32, 1);
  const links = Buffer.alloc(32, 2);
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'loom-push-survives-')); s = new SessionStore(dir); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const endpoints = () => s.takePushWatch(0)!.subs.map((x) => x.endpoint).sort();

  it('fifty agent sign-ins after he turns it on: his phone still gets notifications', () => {
    const mine = s.create(his, 1000, { device: 'Safari on iPhone', via: 'passkey' });
    s.addPushSub(mine, phone, 1000);
    for (let i = 0; i < MAX_SESSIONS + 5; i++) s.create(links, 2000 + i, { device: 'HeadlessChrome on Linux', via: 'link', label: `screenshots t-${i}` });
    expect(endpoints()).toEqual([phone.endpoint]);
  });

  it('fifty sign-ins of his own (no agent among them) push his old session out, and still his phone keeps them', () => {
    const mine = s.create(his, 1000);
    s.addPushSub(mine, phone, 1000);
    for (let i = 0; i < MAX_SESSIONS + 5; i++) s.create(his, 2000 + i);
    expect(s.get(mine)).toBeNull();
    expect(endpoints()).toEqual([phone.endpoint]);
  });

  it('revoking an unrelated session keeps his; signing that device out on purpose (Profile, loom sessions revoke) drops it', () => {
    const mine = s.create(his, 1000);
    const other = s.create(links, 1001);
    s.addPushSub(mine, phone, 1000);
    s.addPushSub(other, laptop, 1001);
    s.revoke(s.refOf(other));
    expect(endpoints()).toEqual([phone.endpoint]);
    // A stolen phone, signed out on Profile: it gets nothing more.
    s.revoke(s.refOf(mine));
    expect(endpoints()).toEqual([]);
  });

  it('housekeeping keeps it: the session past its time or signed out on the device (delete) leaves the device on', () => {
    const mine = s.create(his, 1000);
    s.addPushSub(mine, phone, 1000);
    s.delete(mine);
    expect(endpoints()).toEqual([phone.endpoint]);
  });

  it('a token revoked as compromised takes the devices signed in with it; others stay', () => {
    const mine = s.create(his, 1000);
    const viaLink = s.create(links, 1001);
    s.addPushSub(mine, phone, 1000);
    s.addPushSub(viaLink, laptop, 1001);
    expect(s.removePushByTokens([links.toString('hex')])).toBe(1);
    expect(endpoints()).toEqual([phone.endpoint]);
  });

  it('an agent\'s session, or a headless browser\'s, can never turn notifications on', () => {
    const agent = s.create(links, 1000, { agent: true, label: 'screenshots t-1' });
    const headless = s.create(links, 1001, { device: 'HeadlessChrome on Linux' });
    expect(s.addPushSub(agent, phone, 1000)).toBe('agent');
    expect(s.addPushSub(headless, laptop, 1001)).toBe('agent');
    expect(endpoints()).toEqual([]);
  });

  it('signing in again on the same device keeps it, one entry, now under the new session', () => {
    const first = s.create(his, 1000);
    s.addPushSub(first, phone, 1000);
    s.delete(first);
    const again = s.create(his, 5000);
    s.addPushSub(again, phone, 5000);
    expect(endpoints()).toEqual([phone.endpoint]);
    const dev = s.pushDevices(undefined);
    expect(dev).toHaveLength(1);
    expect(dev[0]).toMatchObject({ at: 1000, session: s.refOf(again) });
  });

  it('turning it off on the device removes it, and only it', () => {
    const mine = s.create(his, 1000);
    s.addPushSub(mine, phone, 1000);
    s.addPushSub(mine, laptop, 1000);
    s.removePushSub(phone.endpoint);
    expect(endpoints()).toEqual([laptop.endpoint]);
  });

  it('removing the device on Profile removes it, and the device can\'t put it back by itself; turning it on again can', () => {
    const mine = s.create(his, 1000);
    s.addPushSub(mine, phone, 1000);
    const ref = s.pushDevices(undefined)[0].ref;
    expect(s.removePushDevice(ref, 'someone-else')).toBe(false);   // only its own person's
    expect(s.removePushDevice(ref, undefined)).toBe(true);
    expect(endpoints()).toEqual([]);
    // The device, still signed in, re-sends what it holds on its next page: refused, and told so.
    expect(s.addPushSub(mine, phone, 2000, undefined, { again: true })).toBe('removed');
    expect(endpoints()).toEqual([]);
    // Its person turns it on there again: back.
    expect(s.addPushSub(mine, phone, 3000)).toBe('added');
    expect(endpoints()).toEqual([phone.endpoint]);
  });

  it('a person no longer in the household loses their devices at the next watch; the others stay', () => {
    const mine = s.create(his, 1000);
    s.addPushSub(mine, phone, 1000);                                  // the first owner's (no member)
    s.addPushSub(mine, laptop, 1000, 'gone-person');
    const w = s.takePushWatch(0, undefined, (m) => m !== 'gone-person');
    expect(w!.subs.map((x) => x.endpoint)).toEqual([phone.endpoint]);
    const raw = JSON.parse(readFileSync(join(dir, 'ui-sessions.json'), 'utf-8'));
    expect(Object.keys(raw.push.subs)).toEqual([phone.endpoint]);
  });
});

describe('agent sign-ins never push the owner\'s sessions out (t-1936)', () => {
  let dir: string;
  let s: SessionStore;
  const his = Buffer.alloc(32, 1);
  const links = Buffer.alloc(32, 2);
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'loom-agent-sessions-')); s = new SessionStore(dir); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('at the cap an agent\'s session goes first, oldest first, however new his are', () => {
    const phoneS = s.create(his, 1000, { device: 'Safari on iPhone' });
    const shots = Array.from({ length: MAX_SESSIONS - 1 }, (_, i) => s.create(links, 2000 + i, { agent: true, label: `screenshots t-${i}` }));
    const more = s.create(links, 9000, { agent: true });
    expect(s.get(phoneS)).not.toBeNull();
    expect(s.get(shots[0])).toBeNull();
    expect(s.get(more)).not.toBeNull();
    // One of his own at the cap: still an agent's goes.
    const laptopS = s.create(his, 9001);
    expect(s.get(phoneS)).not.toBeNull();
    expect(s.get(laptopS)).not.toBeNull();
    expect(s.get(shots[1])).toBeNull();
  });

  it('a headless browser counts as an agent\'s, labelled or not', () => {
    const phoneS = s.create(his, 1000, { device: 'Safari on iPhone' });
    for (let i = 0; i < MAX_SESSIONS; i++) s.create(links, 2000 + i, { device: 'HeadlessChrome on Linux' });
    expect(s.get(phoneS)).not.toBeNull();
  });

  it('a session whose token no longer works goes before any live one', () => {
    const dead = Buffer.alloc(32, 3);
    const old = s.create(his, 1000);
    const deadOnes = Array.from({ length: MAX_SESSIONS - 1 }, (_, i) => s.create(dead, 2000 + i));
    s.create(his, 9000, {}, (secret) => !secret.equals(dead));
    expect(s.get(old)).not.toBeNull();
    expect(s.get(deadOnes[0])).toBeNull();
  });

  it('an agent session is labelled, listed as one, and lasts hours, not a month', () => {
    const code = s.createLink(links, 600, 1000, 'screenshots t-1936', undefined, true);
    const spent = s.spendLink(code, 1001)!;
    expect(spent.agent).toBe(true);
    const id = s.create(spent.secret, 1001, { label: spent.label, via: 'link', agent: spent.agent });
    expect(s.list()[0]).toMatchObject({ label: 'screenshots t-1936', agent: true });
    expect(s.get(id)).toMatchObject({ agent: true });
    expect(AGENT_SESSION_MAX_AGE_S).toBeLessThanOrEqual(12 * 3600);
  });

  it('an agent ends its own sessions by label, and only agent ones', () => {
    const mine = s.create(his, 1000, { label: 'screenshots t-1' });
    const shot = s.create(links, 1001, { agent: true, label: 'screenshots t-1' });
    const other = s.create(links, 1002, { agent: true, label: 'screenshots t-2' });
    expect(s.revokeAgent('screenshots t-1')).toBe(1);
    expect(s.get(shot)).toBeNull();
    expect(s.get(mine)).not.toBeNull();
    expect(s.get(other)).not.toBeNull();
  });
});
