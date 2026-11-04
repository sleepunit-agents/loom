/**
 * A person's Appearance follows them (Jonathan, 2026-11-04: "if every device I login I have to go and change the
 * theme, that sucks"): a choice saved from one browser is what every other browser they sign in on is told, on every
 * page's chrome. Only Appearance's own fields and values are kept, with the session's form token, from loom's own page.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';

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
    expect((await view(laptop)).chrome.prefs).toEqual({ look: '000h', mode: 'light' });
    // A later choice changes only what it names.
    expect((await save(laptop, { _csrf: (await view(laptop)).chrome.csrf, sound: true })).status).toBe(200);
    expect((await view(phone)).chrome.prefs).toEqual({ look: '000h', mode: 'light', sound: true });
  });

  it('keeps only Appearance\'s own choices, with the form token, from loom\'s own page', async () => {
    const cookie = await signIn();
    const csrf = (await view(cookie)).chrome.csrf;
    expect((await save(cookie, { _csrf: csrf, look: 'glass' })).status).toBe(400);
    expect((await save(cookie, { _csrf: csrf, look: 'neon', visited: '/inbox' })).status).toBe(400);
    expect((await save(cookie, { _csrf: 'stale', look: '000h' })).status).toBe(403);
    expect((await save(cookie, { _csrf: csrf, look: '000h' }, 'https://elsewhere.example')).status).toBe(403);
    expect((await fetch(`${base}/appearance/prefs`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: '{"look":"000h"}', redirect: 'manual' })).status).not.toBe(200);
    expect((await view(cookie)).chrome.prefs).toEqual({});
  });
});
