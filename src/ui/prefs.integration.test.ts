/**
 * A person's Appearance follows them (Jonathan, 2026-11-04: "if every device I login I have to go and change the
 * theme, that sucks"): a choice saved from one browser is what every other browser they sign in on is told, on every
 * page's chrome, each household member their own. Only Appearance's own fields and values are kept, with the session's
 * form token, from loom's own page.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { agentDir, createToken, loadHousehold, type Household } from '../household.js';

const TOKEN = 'prefs-test-token';

describe('Appearance, kept per person', () => {
  let tmp: string;
  let handle: HttpServeHandle;
  let base: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'loom-prefs-'));
    for (const k of ['LOOM_HOME', 'XDG_CONFIG_HOME']) saved[k] = process.env[k];
    process.env.LOOM_HOME = join(tmp, 'home');
    process.env.XDG_CONFIG_HOME = join(tmp, 'xdg');
    const stack = join(tmp, 'stack');
    await mkdir(stack);
    await writeFile(join(stack, 'IDENTITY.md'), '# Art E Fish\n\nCreed.');
    handle = await startHttpServer({ contextDir: stack, host: '127.0.0.1', port: 0, token: TOKEN });
    base = `http://127.0.0.1:${handle.port}`;
  });
  afterEach(async () => {
    await handle.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(tmp, { recursive: true, force: true });
  });

  // A device: its own session cookie, from signing in with the token.
  async function signIn(): Promise<string> {
    const res = await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${TOKEN}`, redirect: 'manual' });
    return (res.headers.get('set-cookie') ?? '').split(';')[0];
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const view = async (cookie: string): Promise<any> => (await fetch(`${base}/`, { headers: { cookie, accept: 'application/json' } })).json();
  const save = (cookie: string, body: Record<string, unknown>, origin = base) => fetch(`${base}/appearance/prefs`, {
    method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  it('a choice saved by one session is what a second session, another device, gets', async () => {
    const phone = await signIn();
    const laptop = await signIn();
    expect(phone).not.toBe(laptop);
    // Nothing chosen yet: nothing said, so a device paints its default (Neon) or its own copy.
    expect((await view(laptop)).chrome.prefs).toEqual({});
    const csrf = (await view(phone)).chrome.csrf;
    const r = await save(phone, { _csrf: csrf, look: '000h', mode: 'light' });
    expect(r.status).toBe(200);
    const first = (await view(laptop)).chrome.prefs;
    expect(first).toMatchObject({ look: '000h', mode: 'light' });
    // A later choice changes only what it names, and its version moves on (a device applies only a newer one).
    expect((await save(laptop, { _csrf: (await view(laptop)).chrome.csrf, sound: true })).status).toBe(200);
    const second = (await view(phone)).chrome.prefs;
    expect(second).toMatchObject({ look: '000h', mode: 'light', sound: true });
    expect(second.at).toBeGreaterThan(first.at);
  });

  it('keeps only Appearance\'s own choices, with the form token, from loom\'s own page', async () => {
    const cookie = await signIn();
    const csrf = (await view(cookie)).chrome.csrf;
    expect((await save(cookie, { _csrf: csrf, look: 'glass' })).status).toBe(400);
    expect((await save(cookie, { _csrf: csrf, look: 'neon', visited: '/inbox' })).status).toBe(400);
    // Its own keys only: not the object's ("constructor", "__proto__"), not the version loom keeps itself.
    for (const k of ['constructor', 'toString', '__proto__', 'at']) {
      expect((await fetch(`${base}/appearance/prefs`, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' },
        body: `{"_csrf":"${csrf}","${k}":1}` })).status, k).toBe(400);
    }
    expect((await save(cookie, { _csrf: csrf })).status).toBe(400);
    expect((await save(cookie, { _csrf: 'stale', look: '000h' })).status).toBe(403);
    expect((await save(cookie, { _csrf: csrf, look: '000h' }, 'https://elsewhere.example')).status).toBe(403);
    expect((await fetch(`${base}/appearance/prefs`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: '{"look":"000h"}', redirect: 'manual' })).status).not.toBe(200);
    expect((await view(cookie)).chrome.prefs).toEqual({});
  });
});

describe('Appearance, kept per member of a household', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let base: string;
  const tokens: Record<string, string> = {};
  const saved = process.env.LOOM_HOME;

  beforeEach(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-prefs-hh-'));
    mkdirSync(join(home, 'agents', 'art'), { recursive: true });
    writeFileSync(join(home, 'agents', 'art', 'IDENTITY.md'), '# Art E Fish\n');
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art'], default: 'art',
      members: [{ person: 'jonathan', role: 'owner', agents: '*' }, { person: 'sam', role: 'owner', agents: '*' }] }));
    process.env.LOOM_HOME = home;
    h = loadHousehold(home)!;
    tokens.jonathan = createToken(h, { role: { kind: 'owner', member: 'jonathan' }, label: 'jonathan' }).token;
    tokens.sam = createToken(h, { role: { kind: 'owner', member: 'sam' }, label: 'sam' }).token;
    handle = await startHttpServer({ contextDir: agentDir(h, 'art'), host: '127.0.0.1', port: 0, household: h });
    base = `http://127.0.0.1:${handle.port}`;
  });
  afterEach(async () => {
    await handle.close();
    if (saved === undefined) delete process.env.LOOM_HOME; else process.env.LOOM_HOME = saved;
    rmSync(h.home, { recursive: true, force: true });
  });

  const signIn = async (who: string) => ((await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `token=${encodeURIComponent(tokens[who])}`, redirect: 'manual' })).headers.get('set-cookie') ?? '').split(';')[0];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const view = async (cookie: string): Promise<any> => (await fetch(`${base}/`, { headers: { cookie, accept: 'application/json' } })).json();
  const save = async (cookie: string, body: Record<string, unknown>) => fetch(`${base}/appearance/prefs`, {
    method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ _csrf: (await view(cookie)).chrome.csrf, ...body }) });

  it('each member\'s own, on each of their devices: one member\'s choice is never another\'s', async () => {
    const [jPhone, jLaptop, sPhone, sLaptop] = [await signIn('jonathan'), await signIn('jonathan'), await signIn('sam'), await signIn('sam')];
    expect((await save(jPhone, { look: '000h', mode: 'light' })).status).toBe(200);
    expect((await save(sPhone, { look: 'neon', sound: true })).status).toBe(200);
    const j = (await view(jLaptop)).chrome.prefs, s = (await view(sLaptop)).chrome.prefs;
    expect(j).toMatchObject({ look: '000h', mode: 'light' });
    expect(j.sound).toBeUndefined();
    expect(s).toMatchObject({ look: 'neon', sound: true });
    expect(s.mode).toBeUndefined();
  });
});
