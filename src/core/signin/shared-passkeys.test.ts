import Database from 'better-sqlite3';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, expect, it } from 'vitest';
import { FakeClock } from '../clock.js';
import { createDataSchema } from '../data/database.js';
import { members, passkeys, sessions, tokens } from '../data/schema.js';
import { sharedRoot } from '../../shared-root.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const origin = 'https://loom', rpId = 'loom', credential = 'a'.repeat(64);
/** A household with one member who has one passkey, and a software authenticator that holds its key. */
function fixture(counter = 0) {
  const client = new Database(':memory:'); cleanup.push(() => { client.close(); });
  const clock = new FakeClock(), at = new Date(clock.now()).toISOString(), db = createDataSchema(client, () => new Date(clock.now()).toISOString());
  db.insert(members).values({ id: 'sam', role: 'member', joinedAt: at }).run();
  db.insert(tokens).values({ fingerprint: hash(credential), kind: 'owner', member: 'sam', label: 'sam', createdAt: at }).run();
  const pair = generateKeyPairSync('ed25519'), id = Buffer.from('passkey-1').toString('base64url');
  db.insert(passkeys).values({ id, token: hash(credential), label: 'Key', publicKey: JSON.stringify({ publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'), alg: -8 }), counter, createdAt: at }).run();
  const root = sharedRoot({ db, clock, publicOrigin: origin, originAllowed: () => true, reportError: () => {} }); cleanup.push(() => root.close());
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => root.http.request(origin + path, { method: 'POST', headers: { 'content-type': 'application/json', origin, ...headers }, body: JSON.stringify(body) });
  const challenge = async () => (await (await post('/login/passkey/options', {})).json() as { challenge: string }).challenge;
  /** What navigator.credentials.get would post for this challenge, signed by the authenticator's key. */
  const assertion = (value: string, count: number, key: KeyObject = pair.privateKey) => {
    const data = Buffer.alloc(37); createHash('sha256').update(rpId).digest().copy(data); data[32] = 0x05; data.writeUInt32BE(count, 33);
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: value, origin }));
    return { id, authenticatorData: data.toString('base64url'), clientDataJSON: clientData.toString('base64url'),
      signature: sign(null, Buffer.concat([data, createHash('sha256').update(clientData).digest()]), key).toString('base64url') };
  };
  const login = async (count: number, headers: Record<string, string> = {}) => post('/login/passkey', assertion(await challenge(), count), headers);
  return { db, clock, root, post, challenge, assertion, login, id };
}

it('signs a browser in by passkey with the same session a link would give it', async () => {
  const f = fixture(), signed = await f.login(1, { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15' });
  expect(signed.status).toBe(200);
  const header = signed.headers.get('set-cookie')!;
  expect(header).toContain('HttpOnly'); expect(header).toContain('SameSite=Strict'); expect(header).toContain('; Secure'); expect(header).toContain('Max-Age=2592000');
  const cookie = header.split(';', 1)[0].slice('loom_ui='.length);
  expect(f.db.select().from(sessions).get()).toMatchObject({ id: hash(cookie), token: hash(credential), via: 'passkey', passkey: f.id, isAgent: false, device: 'Safari on Mac' });
  const headless = await f.login(2, { 'user-agent': 'Mozilla/5.0 HeadlessChrome/140.0' });
  expect(headless.headers.get('set-cookie')).toContain('Max-Age=21600');
});
it('signs in again and again with an authenticator that keeps no counter, and refuses one whose counter went back', async () => {
  // A synced passkey reports 0 every time.
  const synced = fixture(0);
  for (let n = 0; n < 3; n++) expect((await synced.login(0)).status).toBe(200);
  expect(synced.db.select().from(sessions).all()).toHaveLength(3);
  const counting = fixture(5);
  expect((await counting.login(5)).status).toBe(401); expect((await counting.login(3)).status).toBe(401); expect((await counting.login(0)).status).toBe(401);
  expect((await counting.login(6)).status).toBe(200);
  expect(counting.db.select().from(passkeys).where(eq(passkeys.id, counting.id)).get()?.counter).toBe(6);
  expect((await counting.login(6)).status).toBe(401);
});
it('spends a challenge once, and takes no signature but the passkey\'s own', async () => {
  const f = fixture(), value = await f.challenge(), body = f.assertion(value, 1);
  expect((await f.post('/login/passkey', f.assertion(await f.challenge(), 1, generateKeyPairSync('ed25519').privateKey))).status).toBe(401);
  expect((await f.post('/login/passkey', body)).status).toBe(200);
  expect((await f.post('/login/passkey', f.assertion(value, 2))).status).toBe(401);
  expect(f.db.select().from(sessions).all()).toHaveLength(1);
});
it('keeps sign-in and passkey enrolment open while a stranger floods the challenge door', async () => {
  const f = fixture();
  for (let n = 0; n < 1100; n++) expect((await f.post('/login/passkey/options', {})).status).toBe(200);
  // More challenges than are kept have been asked for. A person can still sign in,
  const signed = await f.login(1); expect(signed.status).toBe(200);
  // and their freshly signed-in browser can still be given a challenge for adding a passkey.
  const cookie = signed.headers.get('set-cookie')!.split(';', 1)[0];
  expect((await f.post('/passkeys/options', {}, { cookie })).status).toBe(200);
});
