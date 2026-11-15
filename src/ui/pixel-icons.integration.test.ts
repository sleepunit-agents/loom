/**
 * The household's pixel icons (Jonathan, 2026-11-05): a set installed per household (`loom household icons install`),
 * kept at icons/<set>/, served only to someone signed in, and worn in place of the line icons by whoever turns
 * Appearance's "Pixel icons" on (off unless they do). Each icon is recoloured to its key's ramp (web/src/pixel-ramp.ts):
 * a line-only icon is inverted first on a dark key, and not on the lit one. An app without one keeps its line icon.
 *
 * The set here is made in the test (pixel-ramp's arithmetic needs known pixels): Home has black, grey and white bands;
 * Inbox is line-only (black ink, a white strip); Activity, Members and People (yellow) are plain. Knowledge has none.
 */
import { requestTrace } from './request-trace.fixture.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { agentDir, createToken, loadHousehold, type Household } from '../household.js';
import { runHousehold } from '../cli/household.js';
import { iconSetOf, lineOnly } from '../icon-set.js';
import { decodePng } from '../png.js';
import { encodePng } from '../png.fixture.js';


/** A 32×32 RGBA PNG, each row one colour. */
function png(row: (y: number) => [number, number, number, number]): Buffer {
  const raw = Buffer.alloc((32 * 4 + 1) * 32);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) raw.set(row(y), y * (32 * 4 + 1) + 1 + x * 4);
  const chunk = (type: string, data: Buffer) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0); return Buffer.concat([len, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(32, 0); ihdr.writeUInt32BE(32, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const BLACK: [number, number, number, number] = [0, 0, 0, 255];
const GREY: [number, number, number, number] = [128, 128, 128, 255];
const WHITE: [number, number, number, number] = [255, 255, 255, 255];
// Home: black (rows 0-9), grey (10-21), white (22-31). Mostly light: not line-only.
const HOME = png((y) => (y < 10 ? BLACK : y < 22 ? GREY : WHITE));
// Inbox: black ink with a white strip at the bottom (4 rows of 32: an eighth light). Line-only.
const INBOX = png((y) => (y < 28 ? BLACK : WHITE));
const PLAIN = png((y) => (y < 16 ? GREY : WHITE));

describe('the household\'s pixel icons', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let base: string;
  let token: string;
  let samToken: string;
  let set: string;
  const saved = process.env.LOOM_HOME;
  const savedXdg = process.env.XDG_CONFIG_HOME;

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-pixicons-'));
    mkdirSync(join(home, 'agents', 'art'), { recursive: true });
    writeFileSync(join(home, 'agents', 'art', 'IDENTITY.md'), '# Art E Fish\n');
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art'], default: 'art', members: [{ person: 'jonathan', role: 'owner', agents: '*' }, { person: 'sam', role: 'owner', agents: ['art'] }] }));
    process.env.LOOM_HOME = home;
    // No pieces from this machine: the page is this household's alone.
    process.env.XDG_CONFIG_HOME = join(home, 'xdg');
    h = loadHousehold(home)!;
    token = createToken(h, { role: { kind: 'owner' }, label: 'jonathan' }).token;
    samToken = createToken(h, { role: { kind: 'owner', member: 'sam' }, label: 'sam' }).token;
    set = mkdtempSync(join(tmpdir(), 'loom-pixicons-set-'));
    writeFileSync(join(set, 'home.png'), HOME);
    writeFileSync(join(set, 'inbox.png'), INBOX);
    writeFileSync(join(set, 'activity.png'), PLAIN);
    writeFileSync(join(set, 'members.png'), PLAIN);
    writeFileSync(join(set, 'people.png'), PLAIN);
    handle = await startHttpServer({ contextDir: agentDir(h, 'art'), host: '127.0.0.1', port: 0, household: h });
    base = `http://127.0.0.1:${handle.port}`;
  }, 60_000);
  afterAll(async () => {
    await handle.close();
    if (saved === undefined) delete process.env.LOOM_HOME; else process.env.LOOM_HOME = saved;
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedXdg;
    rmSync(h.home, { recursive: true, force: true });
    rmSync(set, { recursive: true, force: true });
  });

  const cli = async (...argv: string[]) => {
    let out = '', err = '';
    const code = await runHousehold(argv, { stdout: (s: string) => { out += s; }, stderr: (s: string) => { err += s; }, env: { ...process.env, LOOM_HOME: h.home } } as never);
    return { code, out, err };
  };
  const signIn = async () => ((await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `token=${encodeURIComponent(token)}`, redirect: 'manual' })).headers.get('set-cookie') ?? '').split(';')[0];

  it('a line-only icon is one whose drawn pixels are mostly dark', () => {
    expect(lineOnly(decodePng(INBOX).rgba)).toBe(true);
    expect(lineOnly(decodePng(HOME).rgba)).toBe(false);
  });

  it('installs from a folder of <app>.png, works out the line-only ones, and wears the set', async () => {
    const r = await cli('icons', 'install', set, '--name', 'test');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain('Icon set test: 5 icons (activity, home, inbox, members, people), in use.');
    expect(r.out).toContain('Line-only, inverted on a dark key: inbox.');
    expect(JSON.parse(readFileSync(join(h.home, 'icons', 'test', 'manifest.json'), 'utf-8'))).toEqual({
      icons: { activity: 'activity.png', home: 'home.png', inbox: 'inbox.png', members: 'members.png', people: 'people.png' }, line: ['inbox'] });
    expect(iconSetOf(h)?.apps).toEqual({ activity: {}, home: {}, inbox: { line: true }, members: {}, people: {} });
    expect((await cli('icons', 'list')).out).toBe('test (in use: 5 icons)\n');
  });

  it('refuses an icon that isn\'t 32×32, by name and size, writing nothing', async () => {
    const bad = mkdtempSync(join(tmpdir(), 'loom-pixicons-bad-'));
    writeFileSync(join(bad, 'home.png'), encodePng(16, 16, new Uint8Array(16 * 16 * 4).fill(255), 4));
    const r = await cli('icons', 'install', bad, '--name', 'bad');
    expect(r.code).toBe(1);
    expect(r.err).toBe('home.png is 16×16; an icon is 32×32\n');
    expect(existsSync(join(h.home, 'icons', 'bad'))).toBe(false);
    rmSync(bad, { recursive: true, force: true });
  });

  it('serves the set to someone signed in, and not to anyone else', async () => {
    const trace = requestTrace();
    const anon = await trace.fetch(`${base}/pixel-icons/home.png`, { redirect: 'manual' });
    expect(anon.status).not.toBe(200);
    expect(anon.headers.get('content-type') ?? '').not.toMatch(/image/);
    const forged = await trace.fetch(`${base}/pixel-icons/home.png`, { redirect: 'manual', headers: { cookie: 'loom_ui=' + '0'.repeat(64) } });
    expect(forged.status).not.toBe(200);
    trace.mark('Jonathan sign-in start');
    const cookie = await signIn();
    trace.mark('Jonathan sign-in complete');
    const ok = await trace.fetch(`${base}/pixel-icons/home.png?v=1`, { headers: { cookie } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/png');
    expect(ok.headers.get('cache-control')).toMatch(/^private/);
    trace.mark('Home icon body start');
    expect(Buffer.from(await ok.arrayBuffer()).equals(HOME)).toBe(true);
    expect((await trace.fetch(`${base}/pixel-icons/knowledge.png`, { headers: { cookie } })).status).toBe(404);
    // Nothing but an app's icon: a PNG that is there, beside the set and at the household's top, is never served by a path
    // that climbs out to it, however it's spelled.
    writeFileSync(join(h.home, 'icons', 'secret.png'), HOME);
    writeFileSync(join(h.home, 'secret.png'), HOME);
    for (const climb of ['..%2Fsecret.png', '%2E%2E%2Fsecret.png', '..%2F..%2Fsecret.png', '..%5Csecret.png', 'test%2F..%2F..%2Fsecret.png']) {
      const r = await trace.fetch(`${base}/pixel-icons/${climb}`, { headers: { cookie } });
      expect(r.headers.get('content-type') ?? '', climb).not.toMatch(/image/);
    }
    // An agent owner is a member too: their shell names the icons, and they can fetch them.
    const samCookie = ((await trace.fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(samToken)}`, redirect: 'manual' })).headers.get('set-cookie') ?? '').split(';')[0];
    const sam = await trace.fetch(`${base}/pixel-icons/home.png?v=1`, { headers: { cookie: samCookie } });
    expect(sam.status).toBe(200);
    expect(sam.headers.get('content-type')).toBe('image/png');
    // The shell names the set for the page, with each line-only icon.
    trace.mark('shell JSON start');
    const page = await (await trace.fetch(`${base}/`, { headers: { cookie, accept: 'application/json' } })).json() as { chrome: { shell: { icons?: { v: string; apps: Record<string, unknown> } } } };
    trace.mark('shell JSON complete');
    expect(page.chrome.shell.icons?.apps).toEqual({ activity: {}, home: {}, inbox: { line: true }, members: {}, people: {} });
  });

});
