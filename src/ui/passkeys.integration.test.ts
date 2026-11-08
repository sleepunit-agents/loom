/**
 * Passkeys (docs/specs/passkeys.md), through the real HTTP server, with an
 * authenticator simulated by node:crypto: a P-256 key pair, and the bytes a
 * device would send (authenticatorData, clientDataJSON, an ES256 signature).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { LINK_TOKEN, sessionStore, signinLink } from './sessions.js';
import BetterSqlite3 from 'better-sqlite3';
import { createConversationTables } from '../backends/conversations.js';
import { closeAllBackends } from '../backends/index.js';
import { agentDir, createToken, loadHousehold, loadTokens, removeMember, revokeToken, type Household } from '../household.js';

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

describe('passkeys', () => {
  let stack: string;
  let handle: HttpServeHandle;
  let saved: string | undefined;

  function call(method: string, path: string, opts: { cookie?: string; json?: unknown; form?: Record<string, string>; host?: string; accept?: string } = {}): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const body = opts.json !== undefined ? JSON.stringify(opts.json) : opts.form ? new URLSearchParams(opts.form).toString() : undefined;
      const req = request({ host: '127.0.0.1', port: handle.port, method, path, headers: {
        host: opts.host ?? HOST, 'sec-fetch-site': 'same-origin',
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
        ...(opts.accept ? { accept: opts.accept } : {}),
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
  // The Passkeys page's data, as the app asks for it (docs/specs/ui-app.md): `add` is its form token where a passkey
  // can be added here, or the reason it can't.
  interface PasskeysView { view: string; page: { title: string; refresh?: number; sections: Array<{ id: string; blocks: Array<{ type: string; items?: Array<{ text: string; act?: { action: string; label: string; tone?: string; confirm?: string; fields?: Record<string, string> } }> }> }> }; ctx: { csrf: string }; add: { csrf: string } | { note: string } }
  const passkeys = async (cookie: string, host?: string) => JSON.parse((await call('GET', '/passkeys', { cookie, host, accept: 'application/json' })).body) as PasskeysView;
  const csrfOf = (v: PasskeysView) => v.ctx.csrf;

  async function signIn(): Promise<string> {
    return cookieOf(await call('POST', '/login', { form: { token: TOKEN } }));
  }

  async function addPasskey(cookie: string, device: Device, label = 'Test phone'): Promise<Reply> {
    const csrf = csrfOf(await passkeys(cookie));
    const o = JSON.parse((await call('POST', '/passkeys/options', { cookie, json: { _csrf: csrf } })).body);
    return call('POST', '/passkeys', { cookie, json: { _csrf: csrf, label, ...device.register(o.challenge) } });
  }

  async function passkeySignIn(device: Device, o: Parameters<Device['assert']>[1] = {}): Promise<Reply> {
    const { challenge } = JSON.parse((await call('POST', '/login/passkey/options', { json: {} })).body);
    return call('POST', '/login/passkey', { json: device.assert(challenge, o) });
  }

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
    expect(JSON.parse((await passkeySignIn(device)).body).error).toMatch(/token that added this passkey was revoked/);
    // Removed from the page: gone.
    const csrf = csrfOf(await passkeys(cookie));
    expect((await passkeys(cookie)).page.sections[0].blocks[0].items![0].act?.fields).toEqual({ id: pk.id });
    expect((await call('POST', '/act/loom', { cookie, form: { _csrf: csrf, _action: 'passkey-remove', _path: 'passkeys', id: pk.id } })).status).toBe(303);
    expect(store.passkeys()).toEqual([]);
    expect(JSON.parse((await passkeySignIn(device)).body).error).toMatch(/doesn't know that passkey/);
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
 * In a household (t-1969): a passkey signs its person in with a token of its own, not the adding session's. Revoking
 * the page sign-in links (as on 2026-11-07) or any other token leaves it working; removing the person's membership,
 * or the passkey, stops it. A passkey made before this moves onto its own token when loom-http starts.
 */
describe('passkeys in a household', () => {
  let h: Household;
  let handle: HttpServeHandle;
  const saved: Record<string, string | undefined> = {};

  function call(method: string, path: string, opts: { cookie?: string; json?: unknown; form?: Record<string, string>; accept?: string } = {}): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const body = opts.json !== undefined ? JSON.stringify(opts.json) : opts.form ? new URLSearchParams(opts.form).toString() : undefined;
      const req = request({ host: '127.0.0.1', port: handle.port, method, path, headers: {
        host: HOST, 'sec-fetch-site': 'same-origin',
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
        ...(opts.accept ? { accept: opts.accept } : {}),
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
  const csrfOf = async (cookie: string) => (JSON.parse((await call('GET', '/passkeys', { cookie, accept: 'application/json' })).body) as { ctx: { csrf: string } }).ctx.csrf;
  /** Signed in the way Jonathan was: a one-time sign-in link, so the session is the page sign-in links token's. */
  const linkSignIn = async (member?: string) => cookieOf(await call('POST', `/login/${signinLink(h, 600, member)}`));
  const signedIn = async (cookie: string) => (await call('GET', '/', { cookie, accept: 'application/json' })).status === 200;
  async function addPasskey(cookie: string, device: Device, label = 'Phone'): Promise<Reply> {
    const csrf = await csrfOf(cookie);
    const o = JSON.parse((await call('POST', '/passkeys/options', { cookie, json: { _csrf: csrf } })).body);
    return call('POST', '/passkeys', { cookie, json: { _csrf: csrf, label, ...device.register(o.challenge) } });
  }
  async function passkeySignIn(device: Device): Promise<Reply> {
    const { challenge } = JSON.parse((await call('POST', '/login/passkey/options', { json: {} })).body);
    return call('POST', '/login/passkey', { json: device.assert(challenge) });
  }
  const start = async () => { handle = await startHttpServer({ contextDir: agentDir(h, 'art'), host: '127.0.0.1', port: 0, household: h }); };
  const digest = (t: string) => createHash('sha256').update(t).digest('hex');

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
    // Its own token, Jonathan's, not the links token the browser signed in with.
    const linkDigest = loadTokens(h.home).find((t) => t.label === LINK_TOKEN)!.sha256;
    expect(pk.tokenLabel).toMatch(/^passkey · jonathan · [0-9a-f]{12}$/);
    expect(pk.secret).not.toBe(linkDigest);
    expect(loadTokens(h.home).find((t) => t.label === pk.tokenLabel)).toMatchObject({ role: 'owner', member: 'jonathan', sha256: pk.secret });

    revokeToken(h, LINK_TOKEN);
    expect(await signedIn(cookie)).toBe(false);
    const r = await passkeySignIn(device);
    expect([r.status, r.body]).toEqual([200, '{"ok":true,"to":"/"}']);
    expect(await signedIn(cookieOf(r))).toBe(true);
    // Any other token too: the one a browser pasted.
    const pasted = createToken(h, { role: { kind: 'owner' }, label: 'laptop' }).token;
    const viaPaste = cookieOf(await call('POST', '/login', { form: { token: pasted } }));
    const other = new Device();
    expect((await addPasskey(viaPaste, other, 'Laptop')).status).toBe(200);
    revokeToken(h, 'laptop');
    expect((await passkeySignIn(other)).status).toBe(200);
  });

  it('removing the member stops their passkey; removing a passkey stops it and its token', async () => {
    const sam = await linkSignIn('sam');
    const samKey = new Device();
    expect((await addPasskey(sam, samKey, 'Sam phone')).status).toBe(200);
    expect(sessionStore(h.home).passkeys()[0].tokenLabel).toMatch(/^passkey · sam · /);
    expect((await passkeySignIn(samKey)).status).toBe(200);
    removeMember(h, 'sam');
    const r = await passkeySignIn(samKey);
    expect(r.status).toBe(401);
    expect(JSON.parse(r.body).error).toMatch(/isn't a member/);

    const jon = await linkSignIn();
    const device = new Device();
    await addPasskey(jon, device);
    const pk = sessionStore(h.home).passkeys().find((k) => k.tokenLabel?.startsWith('passkey · jonathan'))!;
    const viaKey = cookieOf(await passkeySignIn(device));
    expect(await signedIn(viaKey)).toBe(true);
    const csrf = await csrfOf(jon);
    expect((await call('POST', '/act/loom', { cookie: jon, form: { _csrf: csrf, _action: 'passkey-remove', _path: 'passkeys', id: pk.id } })).status).toBe(303);
    expect(JSON.parse((await passkeySignIn(device)).body).error).toMatch(/doesn't know that passkey/);
    // Its token is revoked with it, so the session it opened ends too; the link's session stays.
    expect(loadTokens(h.home).find((t) => t.label === pk.tokenLabel)?.revoked).toBeTruthy();
    expect(await signedIn(viaKey)).toBe(false);
    expect(await signedIn(jon)).toBe(true);
  });

  it('a passkey made before moves onto its own token at start, even with the links token revoked', async () => {
    // Before t-1969: three passkeys signing in as the adding session's token. Jonathan's, the links token's (revoked,
    // as on 2026-11-07); one whose pasted token was revoked (stays stopped); and Sam's, who has since left.
    signinLink(h, 600);
    const linkDigest = loadTokens(h.home).find((t) => t.label === LINK_TOKEN)!.sha256;
    const pasted = createToken(h, { role: { kind: 'owner' }, label: 'old laptop' }).token;
    const samToken = createToken(h, { role: { kind: 'owner', member: 'sam' }, label: 'sam' }).token;
    const [jon, lost, sam] = [new Device(), new Device(), new Device()];
    const store = sessionStore(h.home);
    const legacy = (d: Device, label: string, secret: string) => {
      const reg = d.register('x');
      store.addPasskey({ id: reg.id, publicKey: reg.publicKey, alg: -7, counter: 0, label, created: 1, secret });
      return reg.id;
    };
    const jonId = legacy(jon, 'Jonathan', linkDigest);
    const lostId = legacy(lost, 'Lost', digest(pasted));
    const samId = legacy(sam, 'Sam', digest(samToken));
    revokeToken(h, LINK_TOKEN);
    revokeToken(h, 'old laptop');
    removeMember(h, 'sam');
    expect(JSON.parse((await passkeySignIn(jon)).body).error).toMatch(/token that added this passkey was revoked/);

    await handle.close();
    await start();
    const after = Object.fromEntries(sessionStore(h.home).passkeys().map((k) => [k.id, k]));
    expect(after[jonId].tokenLabel).toMatch(/^passkey · jonathan · /);
    expect(after[lostId].tokenLabel).toBeUndefined();
    expect(after[samId].tokenLabel).toBeUndefined();
    const r = await passkeySignIn(jon);
    expect(r.status).toBe(200);
    expect(await signedIn(cookieOf(r))).toBe(true);
    expect((await passkeySignIn(lost)).status).toBe(401);
    expect((await passkeySignIn(sam)).status).toBe(401);
    // Once: another start mints nothing more.
    const count = loadTokens(h.home).length;
    await handle.close();
    await start();
    expect(loadTokens(h.home).length).toBe(count);
    expect(JSON.parse(readFileSync(join(h.home, 'ui-sessions.json'), 'utf-8')).passkeys[jonId].secret).toBe(after[jonId].secret);
  });
});
