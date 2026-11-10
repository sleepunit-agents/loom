/**
 * Passkeys (docs/specs/passkeys.md), through the real HTTP server, with an
 * authenticator simulated by node:crypto: a P-256 key pair, and the bytes a
 * device would send (authenticatorData, clientDataJSON, an ES256 signature).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { request } from 'node:http';
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { LINK_TOKEN, sessionStore, signinLink } from './sessions.js';
import BetterSqlite3 from 'better-sqlite3';
import { createConversationTables } from '../backends/conversations.js';
import { closeAllBackends } from '../backends/index.js';
import { agentDir, createToken, isLive as isLiveTok, loadHousehold, loadTokens, removeMember, revokeToken, type Household } from '../household.js';
import { migratePasskeys, PasskeyTokenLeft, passkeyToken, removePasskey } from './passkey-tokens.js';
import { runToken } from '../cli/household.js';

const TOKEN = 'passkey-test-token';
const HOST = 'loom.test';
const ORIGIN = `https://${HOST}`;

interface Reply { status: number; headers: Record<string, string | string[] | undefined>; body: string }

class Device {
  readonly id = randomBytes(16);
  private readonly keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  counter = 0;
  readonly publicKey: KeyObject = this.keys.publicKey;

  authData(flags: number, rpId = HOST, attested = false): Buffer {
    const head = Buffer.alloc(37);
    createHash('sha256').update(rpId).digest().copy(head, 0);
    head[32] = flags;
    head.writeUInt32BE(this.counter, 33);
    if (!attested) return head;
    const len = Buffer.alloc(2);
    len.writeUInt16BE(this.id.length);
    return Buffer.concat([head, Buffer.alloc(16), len, this.id, Buffer.from([0xa0])]);
  }

  register(challenge: string, o: { origin?: string; rpId?: string; flags?: number } = {}) {
    const cd = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin: o.origin ?? ORIGIN }));
    return {
      id: this.id.toString('base64url'),
      clientDataJSON: cd.toString('base64url'),
      authenticatorData: this.authData(o.flags ?? 0x45, o.rpId, true).toString('base64url'),
      publicKey: this.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
      publicKeyAlgorithm: -7,
    };
  }

  assert(challenge: string, o: { origin?: string; rpId?: string; flags?: number; bump?: boolean; forge?: boolean } = {}) {
    if (o.bump !== false) this.counter += 1;
    const cd = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: o.origin ?? ORIGIN }));
    const ad = this.authData(o.flags ?? 0x05, o.rpId);
    let signature = sign('sha256', Buffer.concat([ad, createHash('sha256').update(cd).digest()]), this.keys.privateKey);
    if (o.forge) signature = sign('sha256', Buffer.from('something else'), this.keys.privateKey);
    return { id: this.id.toString('base64url'), clientDataJSON: cd.toString('base64url'), authenticatorData: ad.toString('base64url'), signature: signature.toString('base64url') };
  }
}

/** `fetch`: as the page's own script posts an action, for its answer as JSON (x-loom-fetch). */
type CallOpts = { cookie?: string; json?: unknown; form?: Record<string, string>; host?: string; accept?: string; fetch?: boolean };
/** A request to the server on `port`, as a same-origin browser at HOST would send it. */
function callAt(port: number, method: string, path: string, opts: CallOpts = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const body = opts.json !== undefined ? JSON.stringify(opts.json) : opts.form ? new URLSearchParams(opts.form).toString() : undefined;
    const req = request({ host: '127.0.0.1', port, method, path, headers: {
      host: opts.host ?? HOST, 'sec-fetch-site': 'same-origin',
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.accept ? { accept: opts.accept } : {}),
      ...(opts.fetch ? { 'x-loom-fetch': '1' } : {}),
      ...(body !== undefined ? { 'content-type': opts.json !== undefined ? 'application/json' : 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } : {}),
    } }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const cookieOf = (r: Reply) => String(r.headers['set-cookie'] ?? '').split(';')[0];
type Call = (method: string, path: string, opts?: CallOpts) => Promise<Reply>;
/** Add a passkey from the browser with this cookie: the page's form token, the options, the registration. */
async function addPasskeyWith(call: Call, cookie: string, device: Device, label: string): Promise<Reply> {
  const csrf = (JSON.parse((await call('GET', '/passkeys', { cookie, accept: 'application/json' })).body) as { ctx: { csrf: string } }).ctx.csrf;
  const opts = await call('POST', '/passkeys/options', { cookie, json: { _csrf: csrf } });
  const o = JSON.parse(opts.body);
  // Refused at the options (a stale session, a stale form): that reply, as the server sent it.
  if (opts.status !== 200) return opts;
  return call('POST', '/passkeys', { cookie, json: { _csrf: csrf, label, ...device.register(o.challenge) } });
}
async function passkeySignInWith(call: Call, device: Device, o: Parameters<Device['assert']>[1] = {}): Promise<Reply> {
  const { challenge } = JSON.parse((await call('POST', '/login/passkey/options', { json: {} })).body);
  return call('POST', '/login/passkey', { json: device.assert(challenge, o) });
}

describe('passkeys', () => {
  let stack: string;
  let handle: HttpServeHandle;
  let saved: string | undefined;

  const call: Call = (method, path, opts) => callAt(handle.port, method, path, opts);
  // The Passkeys page's data, as the app asks for it (docs/specs/ui-app.md): `add` is its form token where a passkey
  // can be added here, or the reason it can't.
  interface PasskeysView { view: string; page: { title: string; refresh?: number; sections: Array<{ id: string; blocks: Array<{ type: string; items?: Array<{ text: string; act?: { action: string; label: string; tone?: string; confirm?: string; fields?: Record<string, string> } }> }> }> }; ctx: { csrf: string }; add: { csrf: string } | { note: string } }
  const passkeys = async (cookie: string, host?: string) => JSON.parse((await call('GET', '/passkeys', { cookie, host, accept: 'application/json' })).body) as PasskeysView;
  const csrfOf = (v: PasskeysView) => v.ctx.csrf;

  async function signIn(): Promise<string> {
    return cookieOf(await call('POST', '/login', { form: { token: TOKEN } }));
  }

  const addPasskey = (cookie: string, device: Device, label = 'Test phone') => addPasskeyWith(call, cookie, device, label);
  const passkeySignIn = (device: Device, o: Parameters<Device['assert']>[1] = {}) => passkeySignInWith(call, device, o);

  beforeEach(async () => {
    stack = await mkdtemp(join(tmpdir(), 'loom-passkeys-'));
    await writeFile(join(stack, 'IDENTITY.md'), '# Test Agent\n\nCreed.');
    saved = process.env.LOOM_PUBLIC_URL;
    process.env.LOOM_PUBLIC_URL = ORIGIN;
    handle = await startHttpServer({ contextDir: stack, host: '127.0.0.1', port: 0, token: TOKEN });
  });
  afterEach(async () => {
    await handle.close();
    if (saved === undefined) delete process.env.LOOM_PUBLIC_URL;
    else process.env.LOOM_PUBLIC_URL = saved;
    await rm(stack, { recursive: true, force: true });
  });

  it('public passkey options share an async wait and leave the sign-in page responsive', async () => {
    const lock = join(stack, 'ui-sessions.lock');
    writeFileSync(lock, String(process.pid));
    try {
      const began = performance.now();
      const options = Array.from({ length: 5 }, () => call('POST', '/login/passkey/options', { json: {} }));
      await delay(100);
      expect((await call('GET', '/login')).status).toBe(200);
      expect(performance.now() - began).toBeLessThan(1000);
      expect(await Promise.race([options[0].then(() => false), delay(20).then(() => true)])).toBe(true);
      rmSync(lock);
      expect((await Promise.all(options)).every((r) => r.status === 200)).toBe(true);
    } finally { rmSync(lock, { force: true }); }
  }, 20_000);

  it('a passkey removed during its lock wait cannot open a session', async () => {
    const cookie = await signIn();
    const device = new Device();
    expect((await addPasskey(cookie, device)).status).toBe(200);
    const { challenge } = JSON.parse((await call('POST', '/login/passkey/options', { json: {} })).body);
    const lock = join(stack, 'ui-sessions.lock');
    writeFileSync(lock, String(process.pid));
    try {
      const signin = call('POST', '/login/passkey', { json: device.assert(challenge) });
      await delay(100);
      expect(await Promise.race([signin.then(() => false), delay(20).then(() => true)])).toBe(true);
      // The lock holder removes the key before releasing it, as another listener can.
      const path = join(stack, 'ui-sessions.json');
      const file = JSON.parse(readFileSync(path, 'utf8'));
      delete file.passkeys[device.id.toString('base64url')];
      writeFileSync(path, JSON.stringify(file));
      rmSync(lock);
      const denied = await signin;
      expect(denied.status).toBe(401);
      expect(denied.headers['set-cookie']).toBeUndefined();
    } finally { rmSync(lock, { force: true }); }
  }, 20_000);

  it('a verified passkey waits asynchronously for the sessions lock, then signs in', async () => {
    const cookie = await signIn();
    const device = new Device();
    expect((await addPasskey(cookie, device)).status).toBe(200);
    const { challenge } = JSON.parse((await call('POST', '/login/passkey/options', { json: {} })).body);
    const lock = join(stack, 'ui-sessions.lock');
    writeFileSync(lock, String(process.pid));
    try {
      const began = performance.now();
      const signin = call('POST', '/login/passkey', { json: device.assert(challenge) });
      await delay(100);
      expect((await call('GET', '/login')).status).toBe(200);
      expect(performance.now() - began).toBeLessThan(1000);
      expect(await Promise.race([signin.then(() => false), delay(20).then(() => true)])).toBe(true);
      rmSync(lock);
      expect((await signin).status).toBe(200);
    } finally { rmSync(lock, { force: true }); }
  }, 20_000);

  it('adds one from a signed-in browser, then signs in with it alone', async () => {
    const cookie = await signIn();
    // A signed-in browser on loom's public address may add one: the page hands the app its form token for it.
    const page = await passkeys(cookie);
    expect(page.view).toBe('passkeys');
    expect(page.add).toEqual({ csrf: page.ctx.csrf });
    expect(page.ctx.csrf).toMatch(/^[0-9a-f]{64}$/);
    // The app that draws it: script only from loom itself.
    const shell = await call('GET', '/passkeys', { cookie });
    expect(shell.body).toContain('<div id="root">');
    expect(String(shell.headers['content-security-policy'])).toContain("script-src 'self'");
    expect(String(shell.headers['content-security-policy'])).not.toMatch(/script-src[^;]*unsafe/);
    // No minute refresh: it would cut off a passkey being made.
    expect(page.page.refresh).toBeUndefined();
    const device = new Device();
    const added = await addPasskey(cookie, device);
    expect([added.status, added.body]).toEqual([200, '{"ok":true}']);
    const listed = await passkeys(cookie);
    // The board's order: the passkeys first, each a row with an inline Remove (asking first); the app puts Add after them.
    expect(listed.page.sections[0].id).toBe('passkeys');
    const [row] = listed.page.sections[0].blocks[0].items!;
    expect(row).toMatchObject({ text: 'Test phone', act: { action: 'passkey-remove', label: 'Remove', tone: 'danger', confirm: expect.stringMatching(/.+/) } });
    expect(listed.add).toEqual({ csrf: listed.ctx.csrf });

    const login = await call('GET', '/login');
    expect(login.body).toContain('id="passkey-signin"');
    // Sign in per its board: loom's mark, then at the bottom the passkey, "or", and a token with Go.
    expect(login.body.indexOf('class="signin-mark"')).toBeLessThan(login.body.indexOf('id="passkey-signin"'));
    expect(login.body.indexOf('id="passkey-signin"')).toBeLessThan(login.body.indexOf('class="token-row"'));
    expect(login.body).toContain('<button type="submit">Go</button>');
    const r = await passkeySignIn(device);
    expect(r.status).toBe(200);
    const fresh = cookieOf(r);
    expect(fresh).toMatch(/^loom_ui=[0-9a-f]{64}$/);
    expect(String(r.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Strict/);
    expect((await call('GET', '/', { cookie: fresh })).status).toBe(200);
    // Every page: script only from loom itself, never inline or eval.
    const csp = String((await call('GET', '/', { cookie: fresh })).headers['content-security-policy']);
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    expect((await call('GET', '/login/passkey.js')).body).toContain('navigator.credentials.get');
  });

  it('refuses a replay, a copied key, the wrong origin or site, no verification, and a forged signature', async () => {
    const device = new Device();
    await addPasskey(await signIn(), device);
    // A replayed answer: its challenge is spent.
    const { challenge } = JSON.parse((await call('POST', '/login/passkey/options', { json: {} })).body);
    const answer = device.assert(challenge);
    expect((await call('POST', '/login/passkey', { json: answer })).status).toBe(200);
    const replay = await call('POST', '/login/passkey', { json: answer });
    expect([replay.status, JSON.parse(replay.body).error]).toEqual([401, 'that sign-in expired or was already used; try again']);
    // A counter that didn't go up: a copy.
    const clone = await passkeySignIn(device, { bump: false });
    expect(JSON.parse(clone.body).error).toMatch(/counter went backwards/);
    for (const [o, msg] of [
      [{ origin: 'https://evil.example' }, /answered for https:\/\/evil.example/],
      [{ rpId: 'evil.example' }, /isn't for loom.test/],
      [{ flags: 0x01 }, /wasn't verified/],
      [{ forge: true }, /signature doesn't verify/],
    ] as const) {
      const r = await passkeySignIn(device, o);
      expect(r.status).toBe(401);
      expect(JSON.parse(r.body).error).toMatch(msg);
    }
    expect((await passkeySignIn(new Device())).status).toBe(401);
  });

  it('a passkey signs in as its token, only while that token is live, and stops when removed', async () => {
    const cookie = await signIn();
    const device = new Device();
    await addPasskey(cookie, device, 'Phone');
    // Its token revoked: here, the stored digest no longer names a live token.
    const store = sessionStore(stack);
    const [pk] = store.passkeys();
    expect(pk.secret).toBe(createHash('sha256').update(TOKEN).digest('hex'));
    const raw = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(join(stack, 'ui-sessions.json'), 'utf-8')));
    raw.passkeys[pk.id].secret = '00'.repeat(32);
    await writeFile(join(stack, 'ui-sessions.json'), JSON.stringify(raw));
    expect(JSON.parse((await passkeySignIn(device)).body).error).toMatch(/stopped working: the token it was added with was revoked/);
    // Removed from the page: gone.
    const csrf = csrfOf(await passkeys(cookie));
    expect((await passkeys(cookie)).page.sections[0].blocks[0].items![0].act?.fields).toEqual({ id: pk.id });
    expect((await call('POST', '/act/loom', { cookie, form: { _csrf: csrf, _action: 'passkey-remove', _path: 'passkeys', id: pk.id } })).status).toBe(303);
    expect(store.passkeys()).toEqual([]);
    expect(JSON.parse((await passkeySignIn(device)).body).error).toMatch(/doesn't know that passkey/);
  });

  it('a browser that signed in more than 10 minutes ago can\'t add one, here too', async () => {
    const old = `loom_ui=${sessionStore(stack).create(createHash('sha256').update(TOKEN).digest(), Math.floor(Date.now() / 1000) - 11 * 60)}`;
    expect((await call('GET', '/', { cookie: old })).status).toBe(200);
    expect((await passkeys(old)).add).toEqual({ note: expect.stringMatching(/within 10 minutes of signing in/) });
    const r = await addPasskey(old, new Device());
    expect(r.status).toBe(403);
    const csrf = csrfOf(await passkeys(old));
    const posted = await call('POST', '/passkeys', { cookie: old, json: { _csrf: csrf, label: 'x', ...new Device().register('bm90LWlzc3VlZA') } });
    expect([posted.status, JSON.parse(posted.body).error]).toEqual([403, expect.stringMatching(/within 10 minutes/)]);
    expect(sessionStore(stack).passkeys()).toEqual([]);
  });

  it('adding one needs the session\'s form token, a browser session, and loom\'s public address', async () => {
    const cookie = await signIn();
    expect((await call('POST', '/passkeys/options', { cookie, json: { _csrf: '0'.repeat(64) } })).status).toBe(403);
    expect((await call('POST', '/passkeys/options', { json: {} })).status).toBe(401);
    // On another address (the tailnet IP), passkeys aren't offered: their origin is LOOM_PUBLIC_URL's.
    const elsewhere = await passkeys(cookie, '100.64.0.1:8787');
    expect(elsewhere.add).toEqual({ note: expect.stringContaining('Passkeys work at https://loom.test') });
    expect(JSON.stringify(elsewhere.add)).not.toContain('csrf');
    expect((await call('GET', '/login', { host: '100.64.0.1:8787' })).body).not.toContain('passkey-signin');
    // A registration whose challenge was never issued.
    const csrf = csrfOf(await passkeys(cookie));
    const r = await call('POST', '/passkeys', { cookie, json: { _csrf: csrf, label: 'x', ...new Device().register('bm90LWlzc3VlZA') } });
    expect(r.status).toBe(401);
  });
});

/**
 * In a household (t-1969): a passkey signs its person in with a token of its own, made from the adding browser's and
 * saying so. Revoking the page sign-in links (as on 2026-11-07) or any other token leaves it working, unless asked to
 * take its passkeys too; removing the person's membership, or the passkey, stops it. One is added only within 10
 * minutes of signing in. A passkey made before moves onto its own token when loom-http starts, if its token is live.
 */
describe('passkeys in a household', () => {
  let h: Household;
  let handle: HttpServeHandle;
  const saved: Record<string, string | undefined> = {};
  const call: Call = (method, path, opts) => callAt(handle.port, method, path, opts);
  /** Signed in the way Jonathan was: a one-time sign-in link, so the session is the page sign-in links token's. */
  const linkSignIn = async (member?: string) => cookieOf(await call('POST', `/login/${signinLink(h, 600, member)}`));
  const signedIn = async (cookie: string, path = '/') => (await call('GET', path, { cookie, accept: 'application/json' })).status === 200;
  const addPasskey = (cookie: string, device: Device, label = 'Phone') => addPasskeyWith(call, cookie, device, label);
  const passkeySignIn = (device: Device) => passkeySignInWith(call, device);
  const start = async (token?: string) => { handle = await startHttpServer({ contextDir: agentDir(h, 'art'), host: '127.0.0.1', port: 0, household: h, ...(token ? { token } : {}) }); };
  const restart = async (token?: string) => { await handle.close(); await start(token); };
  const digest = (t: string) => createHash('sha256').update(t).digest('hex');
  const tokenOf = (label: string) => loadTokens(h.home).find((t) => t.label === label);
  /** A passkey as code before t-1969 stored it: signing in as `secret`, the adding session's token digest. */
  const legacy = (d: Device, label: string, secret: string) => {
    const reg = d.register('x');
    sessionStore(h.home).addPasskey({ id: reg.id, publicKey: reg.publicKey, alg: -7, counter: 0, label, created: 1, secret });
    return reg.id;
  };
  const byId = () => Object.fromEntries(sessionStore(h.home).passkeys().map((k) => [k.id, k]));

  beforeEach(async () => {
    const home = await mkdtemp(join(tmpdir(), 'loom-passkeys-hh-'));
    for (const a of ['art', 'mark']) {
      mkdirSync(join(home, 'agents', a), { recursive: true });
      writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a}\n`);
      const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db')); createConversationTables(db); db.close();
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art',
      members: [{ person: 'jonathan', role: 'owner', agents: '*' }, { person: 'sam', role: 'owner', agents: ['mark'] }] }));
    for (const k of ['LOOM_HOME', 'XDG_CONFIG_HOME', 'LOOM_PUBLIC_URL']) saved[k] = process.env[k];
    process.env.LOOM_HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, 'xdg');
    process.env.LOOM_PUBLIC_URL = ORIGIN;
    h = loadHousehold(home)!;
    await start();
  });
  afterEach(async () => {
    await handle?.close();
    await closeAllBackends();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await rm(h.home, { recursive: true, force: true });
  });

  it('revoking the sign-in links token leaves a passkey signing its person in', async () => {
    const cookie = await linkSignIn();
    const device = new Device();
    expect((await addPasskey(cookie, device)).status).toBe(200);
    const [pk] = sessionStore(h.home).passkeys();
    const link = tokenOf(LINK_TOKEN)!;
    // Its own token, Jonathan's, saying it's a passkey's and what it was made from; not the links token itself.
    expect(pk.secret).not.toBe(link.sha256);
    expect(pk.tokenLabel).toMatch(/^Passkey: Phone · jonathan · [0-9a-f]{12}$/);
    expect(tokenOf(pk.tokenLabel!)).toMatchObject({ role: 'owner', member: 'jonathan', sha256: pk.secret, passkey: createHash('sha256').update(pk.id).digest('hex'), from: LINK_TOKEN, from_sha256: link.sha256 });

    revokeToken(h, LINK_TOKEN);
    expect(await signedIn(cookie)).toBe(false);
    const r = await passkeySignIn(device);
    expect([r.status, r.body]).toEqual([200, '{"ok":true,"to":"/"}']);
    const viaKey = cookieOf(r);
    expect(await signedIn(viaKey)).toBe(true);
    // Its session says what it signed in as: the passkey's token, by its plain label.
    const profile = (await call('GET', '/account', { cookie: viaKey, accept: 'application/json' })).body;
    expect(profile).toContain('as Passkey: Phone · jonathan');
    // Any other token too: the one a browser pasted.
    const pasted = createToken(h, { role: { kind: 'owner' }, label: 'laptop' }).token;
    const viaPaste = cookieOf(await call('POST', '/login', { form: { token: pasted } }));
    const other = new Device();
    expect((await addPasskey(viaPaste, other, 'Laptop')).status).toBe(200);
    revokeToken(h, 'laptop');
    expect((await passkeySignIn(other)).status).toBe(200);
  });

  it('adds one only within 10 minutes of signing in', async () => {
    signinLink(h, 600);
    const secret = Buffer.from(tokenOf(LINK_TOKEN)!.sha256, 'hex');
    const old = `loom_ui=${sessionStore(h.home).create(secret, Math.floor(Date.now() / 1000) - 11 * 60, { via: 'link' })}`;
    expect(await signedIn(old)).toBe(true);
    const view = JSON.parse((await call('GET', '/passkeys', { cookie: old, accept: 'application/json' })).body) as { add: { note?: string } };
    expect(view.add.note).toMatch(/within 10 minutes of signing in/);
    const r = await addPasskeyWith(call, old, new Device(), 'Old');
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body).error).toMatch(/within 10 minutes of signing in/);
    // The registration itself is refused too, before its challenge is even looked at.
    const csrf = (JSON.parse((await call('GET', '/passkeys', { cookie: old, accept: 'application/json' })).body) as { ctx: { csrf: string } }).ctx.csrf;
    const posted = await call('POST', '/passkeys', { cookie: old, json: { _csrf: csrf, label: 'Old', ...new Device().register('bm90LWlzc3VlZA') } });
    expect(posted.status).toBe(403);
    expect(JSON.parse(posted.body).error).toMatch(/within 10 minutes of signing in/);
    // A sign-in link the stale browser makes for itself opens a session no fresher than it: no way round.
    const made = await call('POST', '/act/loom', { cookie: old, fetch: true, form: { _csrf: csrf, _action: 'signin-link', _path: 'passkeys' } });
    const code = /\/login\/([0-9a-f]{64})/.exec(made.body)![1];
    const relinked = cookieOf(await call('POST', `/login/${code}`));
    expect(await signedIn(relinked)).toBe(true);
    expect((await addPasskeyWith(call, relinked, new Device(), 'Relinked')).status).toBe(403);
    expect(sessionStore(h.home).passkeys()).toEqual([]);
    expect(loadTokens(h.home).filter((t) => t.passkey)).toEqual([]);
    // Nor one it makes on Members for another member: no fresh session for anyone, to add a passkey through.
    const forSam = await call('POST', '/act/loom', { cookie: old, fetch: true, form: { _csrf: csrf, _action: 'member-link', _path: 'members', person: 'sam' } });
    const samCode = /\/login\/([0-9a-f]{64})/.exec(forSam.body)![1];
    const asSam = cookieOf(await call('POST', `/login/${samCode}`));
    expect(await signedIn(asSam, '/a/mark')).toBe(true);
    expect((await addPasskeyWith(call, asSam, new Device(), 'Sam?')).status).toBe(403);
    // A link made on loom's machine (`loom token link`) is a fresh sign-in.
    expect((await addPasskeyWith(call, await linkSignIn(), new Device(), 'Fresh')).status).toBe(200);
  });

  it('removing the member stops their passkey, which never reaches past them; removing a passkey stops it and its token', async () => {
    const sam = await linkSignIn('sam');
    const samKey = new Device();
    expect((await addPasskey(sam, samKey, 'Sam phone')).status).toBe(200);
    expect(sessionStore(h.home).passkeys()[0].tokenLabel).toMatch(/^Passkey: Sam phone · sam · /);
    const samSession = cookieOf(await passkeySignIn(samKey));
    // Sam's agent, not the household's pages: exactly what Sam reaches.
    expect(await signedIn(samSession, '/a/mark')).toBe(true);
    expect((await call('GET', '/members', { cookie: samSession })).status).toBe(403);
    removeMember(h, 'sam');
    const r = await passkeySignIn(samKey);
    expect(r.status).toBe(401);
    expect(JSON.parse(r.body).error).toMatch(/isn't a member/);
    expect(await signedIn(samSession)).toBe(false);

    const jon = await linkSignIn();
    const device = new Device();
    await addPasskey(jon, device);
    const pk = sessionStore(h.home).passkeys().find((k) => k.tokenLabel?.includes(' · jonathan · '))!;
    const viaKey = cookieOf(await passkeySignIn(device));
    expect(await signedIn(viaKey)).toBe(true);
    const csrf = (JSON.parse((await call('GET', '/passkeys', { cookie: jon, accept: 'application/json' })).body) as { ctx: { csrf: string } }).ctx.csrf;
    expect((await call('POST', '/act/loom', { cookie: jon, form: { _csrf: csrf, _action: 'passkey-remove', _path: 'passkeys', id: pk.id } })).status).toBe(303);
    expect(JSON.parse((await passkeySignIn(device)).body).error).toMatch(/doesn't know that passkey/);
    // Its token is revoked with it, so the session it opened ends too; the link's session stays.
    expect(tokenOf(pk.tokenLabel!)?.revoked).toBeTruthy();
    expect(await signedIn(viaKey)).toBe(false);
    expect(await signedIn(jon)).toBe(true);
  });

  it('a member is told to exclude only their own credentials', async () => {
    const jonKey = new Device();
    await addPasskey(await linkSignIn(), jonKey, 'Jonathan');
    const sam = await linkSignIn('sam');
    const csrf = (JSON.parse((await call('GET', '/passkeys', { cookie: sam, accept: 'application/json' })).body) as { ctx: { csrf: string } }).ctx.csrf;
    const o = JSON.parse((await call('POST', '/passkeys/options', { cookie: sam, json: { _csrf: csrf } })).body) as { excludeCredentials: Array<{ id: string }> };
    expect(o.excludeCredentials).toEqual([]);
    expect((await addPasskey(sam, new Device(), 'Sam')).status).toBe(200);
    const again = JSON.parse((await call('POST', '/passkeys/options', { cookie: sam, json: { _csrf: csrf } })).body) as { excludeCredentials: Array<{ id: string }> };
    expect(again.excludeCredentials.map((x) => x.id)).toEqual(sessionStore(h.home).passkeys().filter((k) => k.label === 'Sam').map((k) => k.id));
  });

  it('an agent owner sees, and can remove, their own passkey once it has stopped', async () => {
    const sam = await linkSignIn('sam');
    const samKey = new Device();
    await addPasskey(sam, samKey, 'Sam phone');
    const pk = sessionStore(h.home).passkeys()[0];
    revokeToken(h, pk.tokenLabel!);
    const view = JSON.parse((await call('GET', '/passkeys', { cookie: sam, accept: 'application/json' })).body) as { ctx: { csrf: string }; page: { sections: Array<{ id: string; blocks: Array<{ items?: Array<{ text: string; meta?: string }> }> }> } };
    const row = view.page.sections.find((x) => x.id === 'passkeys')!.blocks[0].items![0];
    expect(row).toMatchObject({ text: 'Sam phone', meta: expect.stringMatching(/stopped working/) });
    expect((await call('POST', '/act/loom', { cookie: sam, form: { _csrf: view.ctx.csrf, _action: 'passkey-remove', _path: 'passkeys', id: pk.id } })).status).toBe(303);
    expect(sessionStore(h.home).passkeys()).toEqual([]);
  });

  it('revoking a token leaves its passkeys alone, unless asked to take them too', async () => {
    const cookie = await linkSignIn();
    const [a, b] = [new Device(), new Device()];
    await addPasskey(cookie, a, 'A');
    await addPasskey(cookie, b, 'B');
    const out: string[] = [];
    const io = { stdout: (x: string) => out.push(x), stderr: (x: string) => out.push(x), env: process.env } as unknown as Parameters<typeof runToken>[1];
    // `loom token revoke` keeps them, and says so.
    expect(await runToken(['revoke', LINK_TOKEN], io)).toBe(0);
    expect(out.join('')).toMatch(/2 passkeys made from it keep working/);
    expect((await passkeySignIn(a)).status).toBe(200);
    // A pasted token's passkeys, taken with it.
    const pasted = createToken(h, { role: { kind: 'owner' }, label: 'laptop' }).token;
    const viaPaste = cookieOf(await call('POST', '/login', { form: { token: pasted } }));
    const c = new Device();
    await addPasskey(viaPaste, c, 'C');
    const cToken = sessionStore(h.home).passkeys().find((k) => k.label === 'C')!.tokenLabel!;
    out.length = 0;
    expect(await runToken(['revoke', 'laptop', '--with-passkeys'], io)).toBe(0);
    expect(out.join('')).toMatch(/Removed the passkey made from it/);
    expect(sessionStore(h.home).passkeys().map((k) => k.label).sort()).toEqual(['A', 'B']);
    expect(tokenOf(cToken)?.revoked).toBeTruthy();
    expect((await passkeySignIn(c)).status).toBe(401);
    expect((await passkeySignIn(b)).status).toBe(200);
  });

  it('Setup offers to revoke a token with its passkeys, and plain Revoke keeps them', async () => {
    const pasted = createToken(h, { role: { kind: 'owner' }, label: 'laptop' }).token;
    const viaPaste = cookieOf(await call('POST', '/login', { form: { token: pasted } }));
    const [a, b] = [new Device(), new Device()];
    await addPasskey(viaPaste, a, 'A');
    await addPasskey(viaPaste, b, 'B');
    const admin = await linkSignIn();
    type Item = { text: string; meta?: string; act?: { action: string; label: string; confirm?: string; fields?: Record<string, string> } };
    type Block = { type: string; summary?: string; items?: Item[]; blocks?: Block[] };
    const setup = JSON.parse((await call('GET', '/a/art/setup', { cookie: admin, accept: 'application/json' })).body) as { ctx: { csrf: string }; page: { sections: Array<{ id: string; blocks: Block[] }> } };
    const tokens = setup.page.sections.find((x) => x.id === 'tokens')!.blocks;
    // The passkeys' own tokens are rows saying what they were made from; the laptop's says two were made from it.
    const rows = tokens.filter((x) => x.type === 'list').flatMap((x) => x.items!);
    expect(rows.find((i) => i.text.startsWith('Passkey: A · jonathan'))?.meta).toContain('made from "laptop"');
    expect(rows.find((i) => i.text === 'laptop')?.meta).toContain('2 passkeys made from it');
    const fold = tokens.find((x) => x.type === 'details' && x.summary === 'Revoke a token with its passkeys')!;
    const offer = fold.blocks![0].items!.find((i) => i.text === 'laptop')!;
    expect(offer.act).toMatchObject({ action: 'revoke-token', fields: { label: 'laptop', passkeys: 'with' }, confirm: expect.stringMatching(/the 2 passkeys made from it are removed/) });
    const r = await call('POST', '/act/loom', { cookie: admin, fetch: true, form: { _csrf: setup.ctx.csrf, _action: 'revoke-token', _path: 'a/art/setup', ...offer.act!.fields! } });
    expect(JSON.parse(r.body).message).toMatch(/The 2 passkeys made from it are removed/);
    expect(sessionStore(h.home).passkeys()).toEqual([]);
    expect((await passkeySignIn(a)).status).toBe(401);
    // Plain Revoke, on another: its passkey stays.
    const other = createToken(h, { role: { kind: 'owner' }, label: 'desk' }).token;
    const c = new Device();
    await addPasskey(cookieOf(await call('POST', '/login', { form: { token: other } })), c, 'C');
    const plain = await call('POST', '/act/loom', { cookie: admin, fetch: true, form: { _csrf: setup.ctx.csrf, _action: 'revoke-token', _path: 'a/art/setup', label: 'desk' } });
    expect(JSON.parse(plain.body).message).toMatch(/The passkey made from it keeps working/);
    expect((await passkeySignIn(c)).status).toBe(200);
  });

  it('removing a passkey can take the passkeys added from its sessions, down the line', async () => {
    const [first, second, third, apart] = [new Device(), new Device(), new Device(), new Device()];
    await addPasskey(await linkSignIn(), first, 'First');
    // Signed in with the first, a browser adds the second; signed in with that, the third.
    await addPasskey(cookieOf(await passkeySignIn(first)), second, 'Second');
    await addPasskey(cookieOf(await passkeySignIn(second)), third, 'Third');
    await addPasskey(await linkSignIn(), apart, 'Apart');
    const keys = Object.fromEntries(sessionStore(h.home).passkeys().map((k) => [k.label, k]));
    expect(tokenOf(keys.Second.tokenLabel!)?.from).toBe(keys.First.tokenLabel);
    const admin = await linkSignIn();
    type Item = { text: string; meta?: string; act?: { fields?: Record<string, string> } };
    const view = JSON.parse((await call('GET', '/account', { cookie: admin, accept: 'application/json' })).body) as { ctx: { csrf: string }; page: { sections: Array<{ id: string; blocks: Array<{ type: string; summary?: string; items?: Item[]; blocks?: Array<{ items?: Item[] }> }> }> } };
    const blocks = view.page.sections.find((x) => x.id === 'passkeys')!.blocks;
    expect(blocks[0].items!.find((i) => i.text === 'Second')?.meta).toContain(`from "${keys.First.tokenLabel}"`);
    const offer = blocks.find((b) => b.summary === 'Remove a passkey with the ones added from it')!.blocks![0].items!.find((i) => i.text === 'First')! as Item & { act: { confirm?: string } };
    expect(offer.act?.fields).toEqual({ id: keys.First.id, made: 'with' });
    // It counts what it takes, down the line: the second and the third.
    expect(offer.act.confirm).toMatch(/the 2 passkeys added from it are removed/);
    expect(offer.meta).toMatch(/^2 passkeys/);
    expect((await call('POST', '/act/loom', { cookie: admin, form: { _csrf: view.ctx.csrf, _action: 'passkey-remove', _path: 'passkeys', ...offer.act!.fields! } })).status).toBe(303);
    expect(sessionStore(h.home).passkeys().map((k) => k.label)).toEqual(['Apart']);
    for (const d of [first, second, third]) expect((await passkeySignIn(d)).status).toBe(401);
    expect((await passkeySignIn(apart)).status).toBe(200);
  });

  it('a passkey made before moves onto its own token at start only if its token is live, once', async () => {
    // Before t-1969: passkeys signing in as the adding session's token. A live pasted token's (moves); the env owner
    // token's (moves); the links token's, since revoked (stays stopped, shown so); a member's who has since left (stays).
    signinLink(h, 600);
    const link = tokenOf(LINK_TOKEN)!;
    const pasted = createToken(h, { role: { kind: 'owner' }, label: 'old laptop' }).token;
    const samToken = createToken(h, { role: { kind: 'owner', member: 'sam' }, label: 'sam' }).token;
    const ENV = 'env-owner-token-for-the-test';
    const [laptop, env, jon, sam] = [new Device(), new Device(), new Device(), new Device()];
    const laptopId = legacy(laptop, 'Laptop', digest(pasted));
    const envId = legacy(env, 'Env', digest(ENV));
    const jonId = legacy(jon, 'Jonathan', link.sha256);
    const samId = legacy(sam, 'Sam', digest(samToken));
    revokeToken(h, LINK_TOKEN);
    removeMember(h, 'sam');

    await restart(ENV);
    const after = byId();
    expect(after[laptopId].tokenLabel).toMatch(/^Passkey: Laptop · jonathan · /);
    expect(tokenOf(after[laptopId].tokenLabel!)).toMatchObject({ member: 'jonathan', from: 'old laptop', from_sha256: digest(pasted) });
    expect(after[envId].tokenLabel).toMatch(/^Passkey: Env · jonathan · /);
    expect(tokenOf(after[envId].tokenLabel!)?.from).toMatch(/env owner token/);
    expect(after[jonId]).toMatchObject({ secret: link.sha256 });
    expect(after[jonId].tokenLabel).toBeUndefined();
    expect(after[samId].tokenLabel).toBeUndefined();
    // The migrated one works, and no longer needs the token it was made with.
    revokeToken(h, 'old laptop');
    expect((await passkeySignIn(laptop)).status).toBe(200);
    expect((await passkeySignIn(env)).status).toBe(200);
    const stopped = await passkeySignIn(jon);
    expect(stopped.status).toBe(401);
    expect(JSON.parse(stopped.body).error).toMatch(/stopped working.*add a new one/);
    expect((await passkeySignIn(sam)).status).toBe(401);
    // Once: another start mints nothing more and moves nothing.
    const count = loadTokens(h.home).length;
    await restart(ENV);
    expect(loadTokens(h.home).length).toBe(count);
    expect(byId()[laptopId].secret).toBe(after[laptopId].secret);
  });

  it('two listeners minting the one passkey\'s token at once end with one token', async () => {
    const pasted = createToken(h, { role: { kind: 'owner' }, label: 'old laptop' }).token;
    const id = legacy(new Device(), 'Laptop', digest(pasted));
    const from = { label: 'old laptop', sha256: digest(pasted) };
    let theirs: { secret: string } | undefined;
    // Between our look and our mint, the other listener mints it: ours is refused as a duplicate, and adopts theirs.
    const ours = passkeyToken(h, 'jonathan', id, 'Laptop', from, () => { theirs = passkeyToken(h, 'jonathan', id, 'Laptop', from); });
    expect(ours.secret).toBe(theirs!.secret);
    expect(loadTokens(h.home).filter((t) => t.passkey && isLiveTok(t))).toHaveLength(1);
  });

  it('a passkey that can\'t be stored leaves no live token behind', async () => {
    for (let i = 0; i < 20; i++) legacy(new Device(), `Old ${i}`, digest(createToken(h, { role: { kind: 'owner' }, label: `t${i}` }).token));
    revokeToken(h, 't0');
    // Past the cap of 20: refused after its token was minted, which is revoked again.
    const r = await addPasskey(await linkSignIn(), new Device(), 'One too many');
    expect(r.status).toBe(409);
    expect(loadTokens(h.home).filter((t) => t.passkey && isLiveTok(t))).toEqual([]);
  });

  it('a Remove the store can\'t take is no removal: the passkey and its token stay, and it isn\'t passed off as one', async () => {
    const cookie = await linkSignIn();
    const d = new Device();
    await addPasskey(cookie, d);
    const pk = sessionStore(h.home).passkeys()[0];
    // Another process holds the store's lock past its wait.
    writeFileSync(join(h.home, 'ui-sessions.lock'), '1');
    let err: unknown;
    try { removePasskey(h, pk.id, false); } catch (e) { err = e; }
    rmSync(join(h.home, 'ui-sessions.lock'), { force: true });
    // Not PasskeyTokenLeft (the page's "Removed, but its token…"): the page says "Not removed".
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PasskeyTokenLeft);
    expect(sessionStore(h.home).passkey(pk.id)).not.toBeNull();
    expect(tokenOf(pk.tokenLabel!)?.revoked).toBeUndefined();
    expect((await passkeySignIn(d)).status).toBe(200);
  });

  it('the migration adopts a token minted by a start that died before binding, and binds at most once', async () => {
    const pasted = createToken(h, { role: { kind: 'owner' }, label: 'old laptop' }).token;
    const d = new Device();
    const id = legacy(d, 'Laptop', digest(pasted));
    // A start that minted the passkey's token, then died.
    const minted = passkeyToken(h, 'jonathan', id, 'Laptop', { label: 'old laptop', sha256: digest(pasted) });
    const count = loadTokens(h.home).length;
    // Two listeners starting at once: one moves it, the other finds it moved and leaves the token be.
    const first = migratePasskeys(h);
    const second = migratePasskeys(h);
    expect([first.moved, second.moved, first.failed, second.failed]).toEqual([[id], [], [], []]);
    expect(loadTokens(h.home).length).toBe(count);
    expect(byId()[id]).toMatchObject({ secret: minted.secret, tokenLabel: minted.tokenLabel });
    // The compare-and-set: a second bind, from the old token or onto another, changes nothing.
    expect(sessionStore(h.home).bindPasskey(id, digest(pasted), { secret: '11'.repeat(32), tokenLabel: 'x' })).toBe(false);
    expect(tokenOf(minted.tokenLabel)?.revoked).toBeUndefined();
    expect((await passkeySignIn(d)).status).toBe(200);
  });
});
