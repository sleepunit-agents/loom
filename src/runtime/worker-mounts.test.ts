import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { bodyMounts, NESTED_SOCKET_TARGET, type AccountLogins, type FixedMount } from './worker-mounts.js';
import { UnservedJobError } from './worker.js';
import { WORKER_STOP, WorkerStop } from './worker-stop.js';

// Real directories: the checks are about what is on the disk. The temporary directory is resolved first,
// because a source that passes through a symbolic link is itself refused.
const root = mkdtempSync(join(realpathSync(tmpdir()), 'loom-mounts-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const directory = (name: string) => { const path = join(root, name); mkdirSync(path, { recursive: true }); return path; };
const a = directory('logins/a-claude'), b = directory('logins/b-claude'), codex = directory('logins/a-codex');
const stamps = directory('house/stamps'), mirror = directory('house/mirror');
const file = join(root, 'plain-file'); writeFileSync(file, 'x');
const link = join(root, 'link'); symlinkSync(stamps, link);
const through = join(link, 'inner'); mkdirSync(join(stamps, 'inner'));
// Real Unix sockets, as an engine's is: one beside everything else, one inside a sign-in directory, one
// inside a fixed mount's source.
const engineDirectory = directory('engine'), socket = join(engineDirectory, 'engine.sock');
const socketInLogin = join(a, 'engine.sock'), socketInMount = join(mirror, 'engine.sock');
const socketLink = join(root, 'socket-link'); symlinkSync(socket, socketLink);
const engineLink = join(root, 'engine-link'); symlinkSync(engineDirectory, engineLink);
const servers: Server[] = [];
beforeAll(async () => { for (const path of [socket, socketInLogin, socketInMount]) await new Promise<void>(done => servers.push(createServer().listen(path, done))); });
afterAll(() => { for (const server of servers) server.close(); });
const home = '/home/agent/.claude';
const logins: AccountLogins = { a: { claude: { source: a, target: home }, codex: { source: codex, target: '/home/agent/.codex' } }, b: { claude: { source: b, target: home } } };
const fixed: FixedMount[] = [{ source: stamps, target: '/house/stamps', readOnly: false }, { source: mirror, target: '/house/mirror' }];
const job = (account: string, harness: string) => ({ account, harness });
const stopped = (config: Parameters<typeof bodyMounts>[0], files?: Parameters<typeof bodyMounts>[1]) => {
  try { bodyMounts(config, files); } catch (error) { return error; }
  return undefined;
};

it('gives a job its own account and harness sign-in directory, read-write, and never another one', () => {
  const mounts = bodyMounts({ accountLogins: logins, mounts: fixed });
  expect(mounts(job('a', 'claude'))).toEqual([{ source: a, target: home, readOnly: false },
    { source: stamps, target: '/house/stamps', readOnly: false }, { source: mirror, target: '/house/mirror', readOnly: true }]);
  expect(mounts(job('b', 'claude'))[0]).toEqual({ source: b, target: home, readOnly: false });
  expect(mounts(job('a', 'codex'))[0]).toEqual({ source: codex, target: '/home/agent/.codex', readOnly: false });
  for (const [account, harness, others] of [['a', 'claude', [b, codex]], ['b', 'claude', [a, codex]], ['a', 'codex', [a, b]]] as const)
    for (const other of others) expect(JSON.stringify(mounts(job(account, harness)))).not.toContain(other);
});
it('refuses a job with no exact sign-in entry once the map is present, the way a missing account runner is refused', () => {
  const mounts = bodyMounts({ accountLogins: logins, mounts: fixed });
  for (const [account, harness] of [['c', 'claude'], ['b', 'codex'], ['a', 'agy'], ['constructor', 'claude'], ['a', 'toString']]) {
    let thrown: unknown;
    try { mounts(job(account, harness)); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(UnservedJobError);
    expect((thrown as Error).message).not.toContain(root);
  }
  // An empty map is still a map: nothing runs.
  expect(() => bodyMounts({ accountLogins: {} })(job('a', 'claude'))).toThrow(UnservedJobError);
});
it('mounts nothing when nothing is configured, and only the fixed mounts when no sign-in map is', () => {
  expect(bodyMounts({})(job('a', 'claude'))).toEqual([]);
  expect(bodyMounts({ mounts: fixed })(job('anyone', 'anything'))).toEqual([
    { source: stamps, target: '/house/stamps', readOnly: false }, { source: mirror, target: '/house/mirror', readOnly: true }]);
});
it('fixes the paths when it is made: a later change to the configuration object changes nothing', () => {
  const changing = { accountLogins: { a: { claude: { source: a, target: home } } }, mounts: [{ source: mirror, target: '/house/mirror' }] };
  const mounts = bodyMounts(changing);
  changing.accountLogins.a.claude.source = b; changing.mounts[0].target = '/elsewhere'; changing.mounts.push({ source: stamps, target: '/more' });
  expect(mounts(job('a', 'claude'))).toEqual([{ source: a, target: home, readOnly: false }, { source: mirror, target: '/house/mirror', readOnly: true }]);
});

const login = (source: string, target = home) => ({ accountLogins: { a: { claude: { source, target } } } });
const mount = (source: string, target = '/house/x') => ({ mounts: [{ source, target }] });
it.each([
  ['a sign-in directory that is missing', login(join(root, 'missing'))],
  ['a mount that is missing', mount(join(root, 'missing'))],
  ['a sign-in directory that is a symbolic link', login(link)],
  ['a mount that is a symbolic link', mount(link)],
  ['a sign-in directory reached through a symbolic link', login(through)],
  ['a mount that is a file', mount(file)],
  ['a relative sign-in source', login('logins/a-claude')],
  ['a relative mount source', mount('house/mirror')],
  ['a relative sign-in target', login(a, 'home/agent/.claude')],
  ['a relative mount target', mount(mirror, 'house/mirror')],
  ['a source that is not written plainly', mount(`${root}/house/../house/mirror`)],
  ['a target that is not written plainly', mount(mirror, '/house//mirror')],
  ['a target with a trailing slash', mount(mirror, '/house/mirror/')],
  ['a target that climbs', mount(mirror, '/house/../etc')],
  ['the root of the container as a target', mount(mirror, '/')],
  ['a null byte in a target', mount(mirror, '/house/\0')],
  ['an empty source', mount('')],
  ['two mounts at one target', { mounts: [{ source: stamps, target: '/house/x' }, { source: mirror, target: '/house/x' }] }],
  ['a mount inside another mount\'s target', { mounts: [{ source: stamps, target: '/house' }, { source: mirror, target: '/house/mirror' }] }],
  ['a mount whose target holds another\'s', { mounts: [{ source: mirror, target: '/house/mirror' }, { source: stamps, target: '/house' }] }],
  ['a mount at a sign-in target', { ...login(a), mounts: [{ source: mirror, target: home }] }],
  ['a mount inside a sign-in target', { ...login(a), mounts: [{ source: mirror, target: `${home}/projects` }] }],
  ['a mount over a sign-in target', { ...login(a), mounts: [{ source: mirror, target: '/home/agent' }] }],
  ['a mount at the nested engine socket', mount(mirror, NESTED_SOCKET_TARGET)],
  ['a mount over the nested engine socket', mount(mirror, '/var/run')],
  ['a sign-in directory at the nested engine socket', login(a, NESTED_SOCKET_TARGET)],
  // What the contract's first point needs and no target check gives: a body must not be handed another
  // job's sign-in directory under a different name.
  ['a mount whose source is a sign-in directory', { ...login(a), mounts: [{ source: a, target: '/house/x' }] }],
  ['a mount whose source holds a sign-in directory', { ...login(a), mounts: [{ source: join(root, 'logins'), target: '/house/x' }] }],
  ['a mount whose source is inside a sign-in directory', { ...login(stamps), mounts: [{ source: join(stamps, 'inner'), target: '/house/x' }] }],
  ['two accounts on one sign-in directory', { accountLogins: { a: { claude: { source: a, target: home } }, b: { claude: { source: a, target: home } } } }],
  ['one account\'s sign-in directory inside another\'s', { accountLogins: { a: { claude: { source: stamps, target: home } }, b: { claude: { source: join(stamps, 'inner'), target: home } } } }],
  // The nested engine socket is a source like the others: a real socket, and apart from every directory.
  ['a nested socket that is missing', { nestedSocket: join(root, 'no.sock') }],
  ['a nested socket that is a directory', { nestedSocket: engineDirectory }],
  ['a nested socket that is a plain file', { nestedSocket: file }],
  ['a nested socket that is a symbolic link', { nestedSocket: socketLink }],
  ['a nested socket reached through a symbolic link', { nestedSocket: join(engineLink, 'engine.sock') }],
  ['a relative nested socket', { nestedSocket: 'engine/engine.sock' }],
  ['a nested socket that is not written plainly', { nestedSocket: `${engineDirectory}/../engine/engine.sock` }],
  ['a nested socket that is a directory holding the sign-in directories', { ...login(a), nestedSocket: join(root, 'logins') }],
  ['a nested socket that is a sign-in directory', { ...login(a), nestedSocket: a }],
  ['a nested socket inside a sign-in directory', { ...login(a), nestedSocket: socketInLogin }],
  ['a nested socket inside a fixed mount\'s source', { ...mount(mirror), nestedSocket: socketInMount }],
  ['a fixed mount of the directory that holds the nested socket', { ...mount(engineDirectory), nestedSocket: socket }],
])('stops the worker at start over %s', (_what, config) => {
  const error = stopped(config);
  expect(error).toEqual(new WorkerStop('mounts'));
  // Its own words only: never the path it refused.
  expect((error as Error).message).toBe(WORKER_STOP.mounts[1]);
  expect((error as Error).message).not.toContain(root);
});
it('stops the worker over a directory that belongs to another user, or where the user cannot be told', () => {
  const mine = process.getuid!();
  expect(stopped(login(a), { uid: () => mine })).toBeUndefined();
  expect(stopped(login(a), { uid: () => mine + 1 })).toEqual(new WorkerStop('mounts'));
  expect(stopped(mount(mirror), { uid: () => mine + 1 })).toEqual(new WorkerStop('mounts'));
  expect(stopped(mount(mirror), { uid: () => undefined })).toEqual(new WorkerStop('mounts'));
});
it('takes a nested socket that is a real socket apart from every mounted directory', () => {
  expect(stopped({ accountLogins: logins, mounts: fixed, nestedSocket: socket })).toBeUndefined();
  // A socket is the engine's, often root's: it need not belong to the worker's user.
  expect(stopped({ nestedSocket: socket }, { uid: () => process.getuid!() + 1 })).toBeUndefined();
  // The mounts a job gets from here do not include it: the worker adds it only for a job allowed nested containers.
  expect(bodyMounts({ mounts: fixed, nestedSocket: socket })(job('a', 'claude')).map(found => found.source)).toEqual([stamps, mirror]);
});
it('reads anything but an exact false as read-only', () => {
  const made = bodyMounts({ mounts: [{ source: stamps, target: '/a', readOnly: 'no' as unknown as boolean }, { source: mirror, target: '/b', readOnly: 0 as unknown as boolean }] })(job('a', 'claude'));
  expect(made.map(found => found.readOnly)).toEqual([true, true]);
});
it('lets several accounts use one path inside their own containers', () => {
  // Only one sign-in directory is ever in a container, so the same target twice is not a collision.
  expect(stopped({ accountLogins: logins, mounts: fixed })).toBeUndefined();
});
