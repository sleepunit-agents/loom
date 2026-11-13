import { afterEach, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { startLoom, createFoundation } from '../../foundation.js';
import { FakeClock } from '../clock.js';
import { migrateHouseholdTables } from '../household/schema.js';
import { HouseholdRows } from '../household/rows.js';
import { HouseholdDatabase } from '../household/document.js';
import { importHousehold } from '../../cli/household-importer.js';
import { runSigninLink } from './client.js';
import { requestLocalLink } from './operator.js';
import { signin, Signin, hash } from './index.js';
import * as database from '../db/index.js';
const fault = vi.hoisted(() => ({ wrongOwner: '' }));
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
    const stat = fs.lstatSync(...args);
    if (args[0] === fault.wrongOwner) Object.assign(stat, { uid: Number(stat.uid) + 1 });
    return stat;
  } };
});
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); fault.wrongOwner = ''; for (const f of cleanup.splice(0).reverse()) await f(); });
function home() { const path = mkdtempSync(join(tmpdir(), 'local-signin-')); cleanup.push(() => rmSync(path, { recursive: true, force: true })); return path; }
async function setup() {
  const path = home(), clock = new FakeClock();
  const seed = createFoundation({ home: path, clock }); migrateHouseholdTables(seed.db);
  seed.db.transaction(() => new HouseholdDatabase(seed.db).replace(path, { v: 1, agents: ['art'], owner: 'jonathan', members: [{ person: 'jonathan', role: 'owner', agents: '*' }, { person: 'guest', role: 'member', agents: ['art'] }] }))();
  new HouseholdRows(seed.db, 'settings').put('signin-first-link-printed', true); seed.close();
  const app = await startLoom({ home: path, next: true, clock, stdout: () => {} }); cleanup.push(() => app.close());
  return { path, clock, app };
}
function raw(path: string, text: string) {
  return new Promise<string>((ok, no) => {
    const socket = createConnection(join(path, 'operator.sock')); let reply = '';
    socket.on('error', no); socket.on('connect', () => socket.write(text)); socket.on('data', chunk => { reply += chunk; }); socket.on('end', () => ok(reply));
  });
}
function cli(args: string[]) {
  let output = '', error = '';
  return runSigninLink(['--next', '--local', ...args], { stdin: Readable.from([]), stdinIsTTY: false, env: {}, stdout: text => { output += text; }, stderr: text => { error += text; } }).then(code => ({ code, output, error }));
}
it('local CLI makes an audited, member-bound link without a bearer; browser redemption succeeds exactly once', async () => {
  const f = await setup();
  expect(lstatSync(f.path).mode & 0o777).toBe(0o700); expect(lstatSync(join(f.path, 'operator.sock')).mode & 0o777).toBe(0o600);
  const result = await cli(['--home', f.path, '--member', 'guest', '--label', 'Tablet', '--ttl', '900']);
  expect(result.code).toBe(0); expect(result.output.trim()).toMatch(new RegExp('^' + f.app.url + '/login/[0-9a-f]{64}$'));
  const url = result.output.trim(); expect((await fetch(url)).status).toBe(200);
  const res = await fetch(url, { method: 'POST', redirect: 'manual' }); expect(res.status).toBe(303);
  const cookie = res.headers.get('set-cookie')!.split(';')[0];
  expect((await (await fetch(f.app.url + '/auth/session', { headers: { cookie } })).json()).viewer).toEqual({ kind: 'member', id: 'guest' });
  expect((await fetch(url, { method: 'POST' })).status).toBe(401);
  const audit = f.app.db.prepare('SELECT * FROM signin_audit').all();
  expect(audit).toEqual([{ id: 1, at: f.clock.now() / 1000, os_uid: userInfo().uid, os_user: userInfo().username, member: 'guest', label: 'Tablet', expires: f.clock.now() / 1000 + 900 }]);
  const code = new URL(url).pathname.split('/').pop()!;
  expect(JSON.stringify(audit)).not.toContain(code);
  expect(JSON.stringify(f.app.db.prepare('SELECT * FROM core_operations').all())).not.toContain(code);
  const override = await cli(['--home', f.path, '--member', 'jonathan', '--page-url', 'https://loom.example/']); expect(override.code).toBe(0); expect(override.output).toMatch(/^https:\/\/loom.example\/login\//);
});
it('refuses unknown members, invalid TTL and all other operations or extra keys without writing', async () => {
  const f = await setup(); const before = signin(f.app).sessions.read();
  for (const input of [
    { request: 'link', member: 'missing' }, { request: 'link', member: 'guest', ttl: 901 },
    { request: 'link', member: 'guest', ttl: 0 }, { request: 'link', member: 'guest', ttl: 1.5 },
    { request: 'token', member: 'guest' }, { request: 'read', member: 'guest' },
    { request: 'link', member: 'guest', agent: true }, { request: 'link', member: 'guest', code: 'chosen' },
  ]) expect(JSON.parse(await raw(f.path, JSON.stringify(input) + '\n'))).toEqual({ ok: false });
  expect(JSON.parse(await raw(f.path, '{}\n{}\n'))).toEqual({ ok: false });
  expect(JSON.parse(await raw(f.path, 'x'.repeat(4097)))).toEqual({ ok: false });
  expect(signin(f.app).sessions.read()).toEqual(before); expect(f.app.db.prepare('SELECT * FROM signin_audit').all()).toEqual([]);
});
it('the client and daemon refuse an unsafe home or socket on a later connection', async () => {
  const f = await setup(); expect((await cli(['--home', f.path, '--member', 'guest'])).code).toBe(0);
  chmodSync(f.path, 0o755);
  expect((await cli(['--home', f.path, '--member', 'guest'])).code).toBe(1);
  expect(JSON.parse(await raw(f.path, '{"request":"link","member":"guest"}\n'))).toEqual({ ok: false });
  chmodSync(f.path, 0o700); chmodSync(join(f.path, 'operator.sock'), 0o666);
  expect((await cli(['--home', f.path, '--member', 'guest'])).code).toBe(1);
  expect(JSON.parse(await raw(f.path, '{"request":"link","member":"guest"}\n'))).toEqual({ ok: false });
  chmodSync(join(f.path, 'operator.sock'), 0o600);
  const alias = home(); symlinkSync(f.path, join(alias, 'alias'));
  expect((await cli(['--home', join(alias, 'alias'), '--member', 'guest'])).code).toBe(1);
  expect(f.app.db.prepare('SELECT count(*) AS n FROM signin_audit').get()).toEqual({ n: 1 });
});
it('wrong socket ownership is refused before connecting', async () => {
  const f = await setup(); fault.wrongOwner = join(f.path, 'operator.sock');
  await expect(requestLocalLink(f.path, { request: 'link', member: 'guest' })).rejects.toThrow('Unsafe operator path');
});
it('TTL expiry and audit failure leave no usable unaudited credential', async () => {
  const f = await setup();
  const link = await requestLocalLink(f.path, { request: 'link', member: 'guest', ttl: 1 }); f.clock.advance(1000);
  expect((await fetch(f.app.url + link.path, { method: 'POST' })).status).toBe(401);
  const before = signin(f.app).sessions.read();
  f.app.db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON signin_audit BEGIN SELECT RAISE(ABORT, 'fail'); END");
  expect((await cli(['--home', f.path, '--member', 'guest'])).code).toBe(1); expect(signin(f.app).sessions.read()).toEqual(before);
});
it('close removes the socket, destroys idle connections and permits a restart', async () => {
  const f = await setup(); const idle = createConnection(join(f.path, 'operator.sock'));
  await new Promise<void>((ok, no) => { idle.once('connect', ok); idle.once('error', no); });
  await f.app.close(); expect(existsSync(join(f.path, 'operator.sock'))).toBe(false);
  const next = await startLoom({ home: f.path, next: true, stdout: () => {} }); await next.close();
  expect(existsSync(join(f.path, 'operator.sock'))).toBe(false);
});
it('replaces a stale socket, refuses other files, and releases listeners and the home lock on failure', async () => {
  const path = home(), endpoint = join(path, 'operator.sock');
  // Move a listening path away before closing it, leaving a real unbound socket inode.
  const { renameSync } = await import('node:fs'); const stale = createServer(); const original = join(path, 'stale.sock');
  await new Promise<void>(ok => stale.listen(original, ok)); renameSync(original, endpoint); chmodSync(endpoint, 0o600);
  await new Promise<void>(ok => stale.close(() => ok()));
  const app = await startLoom({ home: path, next: true, stdout: () => {} }); await app.close();
  writeFileSync(endpoint, 'preserve');
  await expect(startLoom({ home: path, next: true, stdout: () => {} })).rejects.toThrow('Unsafe operator path');
  expect(existsSync(endpoint)).toBe(true); rmSync(endpoint);
  const again = await startLoom({ home: path, next: true, stdout: () => {} }); await again.close();
});
it('first start creates a household and prints one owner link, with no second print after restart', async () => {
  const path = home(), clock = new FakeClock(); let output = '';
  const first = await startLoom({ home: path, next: true, clock, stdout: text => { output += text; } });
  const member = signin(first).household()!.members[0].person;
  expect(first.db.prepare('SELECT member, label, expires FROM signin_audit').all()).toEqual([{ member, label: 'First sign-in', expires: clock.now() / 1000 + 300 }]);
  expect(JSON.stringify(first.db.prepare('SELECT * FROM signin_audit').all())).not.toContain(new URL(output.trim()).pathname.slice('/login/'.length));
  expect(output.trim()).toMatch(/^http:\/\/127.0.0.1:\d+\/login\/[0-9a-f]{64}$/);
  expect(existsSync(join(path, 'household.json'))).toBe(false);
  const linkPath = new URL(output.trim()).pathname; await first.close();
  output = ''; const second = await startLoom({ home: path, next: true, clock, stdout: text => { output += text; } }); cleanup.push(() => second.close());
  expect(output).toBe('');
  const res = await fetch(second.url + linkPath, { method: 'POST', redirect: 'manual' }); expect(res.status).toBe(303);
  const cookie = res.headers.get('set-cookie')!.split(';')[0]; expect((await (await fetch(second.url + '/auth/session', { headers: { cookie } })).json()).viewer.id).toBe(member);
});
it('an imported session suppresses bootstrap output but local links still work', async () => {
  const path = home(), old = home(), clock = new FakeClock();
  writeFileSync(join(old, 'household.json'), JSON.stringify({ v: 1, agents: ['art'], owner: 'jonathan' }));
  writeFileSync(join(old, 'ui-sessions.json'), JSON.stringify({ v: 1, sessions: { ['a'.repeat(64)]: { issuedAt: 0, secret: 'b'.repeat(64) } } }));
  writeFileSync(join(old, 'ui-cookie.key'), Buffer.alloc(32, 1));
  const app = createFoundation({ home: path }); importHousehold(app.db, path, old, clock.now()); app.close();
  let output = ''; const daemon = await startLoom({ home: path, next: true, clock, stdout: text => { output += text; } }); cleanup.push(() => daemon.close());
  expect(output).toBe(''); expect((await cli(['--home', path, '--member', 'jonathan'])).code).toBe(0);
});

it('records the actual credential expiry even if clock time advances while making the link', async () => {
  const f = await setup();
  vi.spyOn(Signin.prototype, 'now').mockImplementation(() => { const now = Math.floor(f.clock.now() / 1000); f.clock.advance(1000); return now; });
  const answer = await requestLocalLink(f.path, { request: 'link', member: 'guest' });
  const credential = signin(f.app).sessions.get('links', hash(answer.path.slice('/login/'.length)))!;
  expect(f.app.db.prepare('SELECT expires FROM signin_audit').get()).toEqual({ expires: credential.expires });
});
it('default TTL is exactly five minutes and the local CLI does not open the database', async () => {
  const f = await setup();
  const opening = vi.spyOn(database, 'openDb').mockImplementation(() => { throw new Error('Client must not open SQLite'); });
  const result = await cli(['--home', f.path, '--member', 'guest']); expect(result.code).toBe(0); expect(opening).not.toHaveBeenCalled();
  expect(f.app.db.prepare('SELECT expires FROM signin_audit').get()).toEqual({ expires: f.clock.now() / 1000 + 300 });
  f.clock.advance(299000);
  const path = new URL(result.output.trim()).pathname, code = path.slice('/login/'.length);
  expect(signin(f.app).sessions.get('links', hash(code))!.expires).toBe(f.clock.now() / 1000 + 1);
  f.clock.advance(1000); expect((await fetch(f.app.url + path, { method: 'POST' })).status).toBe(401);
});
it('a lost local response is never retried and prints no credential', async () => {
  const path = home(); let requests = 0, connections = 0;
  const server = createServer(socket => {
    connections++; socket.on('data', () => { requests++; socket.destroy(); });
  });
  await new Promise<void>(ok => server.listen(join(path, 'operator.sock'), ok)); chmodSync(join(path, 'operator.sock'), 0o600);
  try {
    const result = await cli(['--home', path, '--member', 'guest']); expect(result.code).toBe(1); expect(result.output).toBe('');
    expect(requests).toBe(1); expect(connections).toBe(1);
  } finally { await new Promise<void>(ok => server.close(() => ok())); }
});

it('the CLI and daemon startup refuse a home owned by a different OS user', async () => {
  const f = await setup(); fault.wrongOwner = f.path;
  expect((await cli(['--home', f.path, '--member', 'guest'])).code).toBe(1);
  const path = home(); fault.wrongOwner = path;
  await expect(startLoom({ home: path, next: true, stdout: () => {} })).rejects.toThrow('Operator home must belong');
  expect(existsSync(join(path, 'loom.db'))).toBe(false); expect(existsSync(join(path, 'operator.sock'))).toBe(false);
});
