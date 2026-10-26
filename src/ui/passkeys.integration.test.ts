/**
 * Passkeys (docs/specs/passkeys.md), through the real HTTP server, with an
 * authenticator simulated by node:crypto: a P-256 key pair, and the bytes a
 * device would send (authenticatorData, clientDataJSON, an ES256 signature).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { sessionStore } from './sessions.js';

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

  function call(method: string, path: string, opts: { cookie?: string; json?: unknown; form?: Record<string, string>; host?: string } = {}): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const body = opts.json !== undefined ? JSON.stringify(opts.json) : opts.form ? new URLSearchParams(opts.form).toString() : undefined;
      const req = request({ host: '127.0.0.1', port: handle.port, method, path, headers: {
        host: opts.host ?? HOST, 'sec-fetch-site': 'same-origin',
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
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
  const csrfOf = (html: string) => /data-csrf="([0-9a-f]{64})"/.exec(html)?.[1] ?? /name="_csrf" value="([0-9a-f]{64})"/.exec(html)?.[1] ?? '';

  async function signIn(): Promise<string> {
    return cookieOf(await call('POST', '/login', { form: { token: TOKEN } }));
  }

  async function addPasskey(cookie: string, device: Device, label = 'Test phone'): Promise<Reply> {
    const csrf = csrfOf((await call('GET', '/passkeys', { cookie })).body);
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
    const page = await call('GET', '/passkeys', { cookie });
    expect(page.body).toContain('id="passkey-add"');
    expect(page.body).toContain('<script src="/login/passkey.js" defer></script>');
    expect(String(page.headers['content-security-policy'])).toContain("script-src 'self'");
    // No minute refresh: it would cut off a passkey being made.
    expect(page.body).not.toContain('http-equiv="refresh"');
    const device = new Device();
    const added = await addPasskey(cookie, device);
    expect([added.status, added.body]).toEqual([200, '{"ok":true}']);
    expect((await call('GET', '/passkeys', { cookie })).body).toContain('Test phone');

    const login = await call('GET', '/login');
    expect(login.body).toContain('id="passkey-signin"');
    const r = await passkeySignIn(device);
    expect(r.status).toBe(200);
    const fresh = cookieOf(r);
    expect(fresh).toMatch(/^loom_ui=[0-9a-f]{64}$/);
    expect(String(r.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Strict/);
    expect((await call('GET', '/', { cookie: fresh })).status).toBe(200);
    // Every other page keeps the no-script policy.
    expect(String((await call('GET', '/', { cookie: fresh })).headers['content-security-policy'])).not.toContain('script-src');
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
    const csrf = csrfOf((await call('GET', '/passkeys', { cookie })).body);
    expect((await call('POST', '/act/loom', { cookie, form: { _csrf: csrf, _action: 'passkey-remove', _path: 'passkeys', id: pk.id } })).status).toBe(303);
    expect(store.passkeys()).toEqual([]);
    expect(JSON.parse((await passkeySignIn(device)).body).error).toMatch(/doesn't know that passkey/);
  });

  it('adding one needs the session\'s form token, a browser session, and loom\'s public address', async () => {
    const cookie = await signIn();
    expect((await call('POST', '/passkeys/options', { cookie, json: { _csrf: '0'.repeat(64) } })).status).toBe(403);
    expect((await call('POST', '/passkeys/options', { json: {} })).status).toBe(401);
    // On another address (the tailnet IP), passkeys aren't offered: their origin is LOOM_PUBLIC_URL's.
    const elsewhere = await call('GET', '/passkeys', { cookie, host: '100.64.0.1:8787' });
    expect(elsewhere.body).toContain('Passkeys work at https://loom.test');
    expect(elsewhere.body).not.toContain('<script');
    expect((await call('GET', '/login', { host: '100.64.0.1:8787' })).body).not.toContain('passkey-signin');
    // A registration whose challenge was never issued.
    const csrf = csrfOf((await call('GET', '/passkeys', { cookie })).body);
    const r = await call('POST', '/passkeys', { cookie, json: { _csrf: csrf, label: 'x', ...new Device().register('bm90LWlzc3VlZA') } });
    expect(r.status).toBe(401);
  });
});
