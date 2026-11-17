import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { bodyMounts, NESTED_SOCKET_TARGET, type AccountLogins, type FixedMount } from './worker-mounts.js';
import { UnservedJobError } from './worker.js';
import { WORKER_STOP, WorkerStop, workerStopLine } from './worker-stop.js';

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
const stateDirectory = directory('worker/state'), tokenFile = join(directory('worker/secret'), 'token'); writeFileSync(tokenFile, 'x');
// A directory of links that lead out of it: to the socket, the state directory, the token file, nothing.
const linkHome = directory('links');
symlinkSync(socket, join(linkHome, 'to-socket')); symlinkSync(stateDirectory, join(linkHome, 'to-state'));
symlinkSync(tokenFile, join(linkHome, 'to-token')); symlinkSync(join(root, 'nowhere'), join(linkHome, 'to-nothing'));
const home = '/home/agent/.claude';
const logins: AccountLogins = { a: { claude: { source: a, target: home }, codex: { source: codex, target: '/home/agent/.codex' } }, b: { claude: { source: b, target: home } } };
const fixed: FixedMount[] = [{ source: stamps, target: '/house/stamps', readOnly: false }, { source: mirror, target: '/house/mirror' }];
const job = (account: string, harness: string) => ({ account, harness });
const nestedJob = (account: string, harness: string) => ({ account, harness, run: { gpu: false, nestedContainers: true, ports: [] } });
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
  // One rule for every pair of mounted directories, fixed mounts among themselves included.
  ['one directory mounted twice', { mounts: [{ source: mirror, target: '/one' }, { source: mirror, target: '/two' }] }],
  ['a read-only mount whose source is writable under a second name', { mounts: [{ source: join(root, 'house'), target: '/house' }, { source: stamps, target: '/stamps', readOnly: false }] }],
  ['a mount whose source holds an earlier mount\'s', { mounts: [{ source: stamps, target: '/stamps' }, { source: join(root, 'house'), target: '/house' }] }],
  // The engine's own socket is never mounted, and no mount may be a way to it.
  ['an engine socket that is missing', { socket: join(root, 'no.sock') }],
  ['an engine socket that is a directory', { socket: engineDirectory }],
  ['a relative engine socket', { socket: 'engine/engine.sock' }],
  ['an engine socket that is not written plainly', { socket: `${engineDirectory}//engine.sock` }],
  ['a fixed mount of the directory that holds the engine socket', { ...mount(engineDirectory), socket }],
  ['a fixed mount above the engine socket', { ...mount(root), socket }],
  ['a sign-in directory that holds the engine socket', { ...login(a), socket: socketInLogin }],
  ['an engine socket inside a fixed mount\'s source', { ...mount(mirror), socket: socketInMount }],
  // A socket may be named through a link (`/var/run` is one on most machines); it is where it really is.
  ['a mount of the real directory of an engine socket named through a linked directory', { ...mount(engineDirectory), socket: join(engineLink, 'engine.sock') }],
  ['a mount of the real directory of an engine socket named by a link', { ...mount(engineDirectory), socket: socketLink }],
  ['a mount of the real directory of a nested socket named through a linked directory', { ...mount(engineDirectory), nestedSocket: join(engineLink, 'engine.sock') }],
  ['a mount of the directory that holds the link an engine socket is named by', { ...mount(linkHome), socket: join(linkHome, 'to-socket') }],
  ['an engine socket named by a link that ends at a directory', { socket: link }],
  ['an engine socket named by a link that ends nowhere', { socket: join(linkHome, 'to-nothing') }],
  // The nested socket's place, under either of the two names most images have for it.
  ['a mount at /run, where /var/run leads in most images', mount(mirror, '/run')],
  ['a mount at /run/docker.sock', mount(mirror, '/run/docker.sock')],
  ['a sign-in directory at /run', login(a, '/run')],
  // The worker's own files, as they are written and where they really are.
  ['a state directory written as a link inside a mount, pointing outside it', { ...mount(linkHome), state: join(linkHome, 'to-state') }],
  ['a token file written as a link inside a mount, pointing outside it', { ...mount(linkHome), tokenFile: join(linkHome, 'to-token') }],
  ['a state directory written through a link whose real place is inside a mount', { ...mount(stateDirectory), state: join(linkHome, 'to-state') }],
  // The worker's own files.
  ['a mount of the worker\'s state directory', { ...mount(stateDirectory), state: stateDirectory }],
  ['a mount that holds the state directory', { ...mount(join(root, 'worker')), state: stateDirectory }],
  ['a mount inside the state directory', { ...mount(stateDirectory), state: join(root, 'worker') }],
  ['a mount that will hold a state directory not made yet', { ...mount(mirror), state: join(mirror, 'later', 'state') }],
  ['a mount that holds a state directory named through a symbolic link', { ...mount(stamps), state: join(link, 'inner') }],
  ['a sign-in directory that holds the state directory', { ...login(stateDirectory), state: stateDirectory }],
  ['a mount of the directory that holds the token file', { ...mount(join(root, 'worker', 'secret')), tokenFile }],
  ['a mount above the token file', { ...mount(join(root, 'worker')), tokenFile }],
  // The nested engine socket is a source like the others: a real socket, and apart from every directory.
  ['a nested socket that is missing', { nestedSocket: join(root, 'no.sock') }],
  ['a nested socket that is a directory', { nestedSocket: engineDirectory }],
  ['a nested socket that is a plain file', { nestedSocket: file }],
  ['a relative nested socket', { nestedSocket: 'engine/engine.sock' }],
  ['a nested socket that is not written plainly', { nestedSocket: `${engineDirectory}/../engine/engine.sock` }],
  ['a nested socket that is a directory holding the sign-in directories', { ...login(a), nestedSocket: join(root, 'logins') }],
  ['a nested socket that is a sign-in directory', { ...login(a), nestedSocket: a }],
  ['a nested socket inside a sign-in directory', { ...login(a), nestedSocket: socketInLogin }],
  ['a nested socket inside a fixed mount\'s source', { ...mount(mirror), nestedSocket: socketInMount }],
  ['a fixed mount of the directory that holds the nested socket', { ...mount(engineDirectory), nestedSocket: socket }],
])('stops the worker at start over %s', (_what, config) => {
  const error = stopped(config) as WorkerStop;
  expect(error).toBeInstanceOf(WorkerStop); expect(error.stage).toBe('mounts');
  // Its own words and the configuration key at fault: never the path it refused.
  expect(error.message).toBe(WORKER_STOP.mounts[1]);
  expect(error.key).toMatch(/^(container\.(mounts\[[01]\]\.(source|target)|socket|nestedSocket)|accountLogins\.[ab]\.claude\.(source|target))$/);
  expect(workerStopLine('mounts', error.key)).toBe(`Worker stopped: ${WORKER_STOP.mounts[1]} (${error.key})\n`);
  expect(workerStopLine('mounts', error.key)).not.toContain(root);
});
it('names the configuration key at fault, the later of two that overlap, and never what is written under it', () => {
  const key = (config: Parameters<typeof bodyMounts>[0]) => (stopped(config) as WorkerStop | undefined)?.key;
  expect(key({ mounts: [{ source: mirror, target: '/ok' }, { source: join(root, 'missing'), target: '/x' }] })).toBe('container.mounts[1].source');
  expect(key({ mounts: [{ source: mirror, target: 'relative' }] })).toBe('container.mounts[0].target');
  expect(key({ mounts: [{ source: mirror, target: '/x' }, { source: stamps, target: '/x/y' }] })).toBe('container.mounts[1].target');
  expect(key({ mounts: [{ source: mirror, target: '/x' }, { source: mirror, target: '/y' }] })).toBe('container.mounts[1].source');
  expect(key({ mounts: [{ source: mirror, target: '/var/run' }] })).toBe('container.mounts[0].target');
  expect(key({ ...login(a), mounts: [{ source: mirror, target: home }] })).toBe('accountLogins.a.claude.target');
  expect(key({ ...login(a), mounts: [{ source: a, target: '/x' }] })).toBe('accountLogins.a.claude.source');
  expect(key({ accountLogins: { 'sub-1@example.com': { codex: { source: a, target: 'relative' } } } })).toBe('accountLogins.sub-1@example.com.codex.target');
  expect(key({ accountLogins: { a: { claude: { source: a, target: home } }, b: { claude: { source: a, target: home } } } })).toBe('accountLogins.b.claude.source');
  // A name that is not an ordinary one is quoted, so it cannot break the line it is printed on.
  expect(key({ accountLogins: { 'two\nlines': { 'a harness': { source: join(root, 'missing'), target: home } } } })).toBe('accountLogins."two\\nlines"."a harness".source');
  expect(key({ socket: join(root, 'no.sock') })).toBe('container.socket');
  expect(key({ socket, nestedSocket: engineDirectory })).toBe('container.nestedSocket');
  expect(key({ ...mount(engineDirectory), socket })).toBe('container.mounts[0].source');
  expect(key({ ...mount(stateDirectory), state: stateDirectory })).toBe('container.mounts[0].source');
  expect(key({ ...mount(join(root, 'worker')), tokenFile })).toBe('container.mounts[0].source');
  // No stage but this one carries a key, and a line without one is as it was.
  expect(new WorkerStop('left').key).toBeUndefined(); expect(workerStopLine('left')).toBe(`Worker stopped: ${WORKER_STOP.left[1]}\n`);
});
it('stops the worker over a directory that belongs to another user, or where the user cannot be told', () => {
  const mine = process.getuid!();
  expect(stopped(login(a), { uid: () => mine })).toBeUndefined();
  expect(stopped(login(a), { uid: () => mine + 1 })).toMatchObject({ stage: 'mounts' });
  expect(stopped(mount(mirror), { uid: () => mine + 1 })).toMatchObject({ stage: 'mounts' });
  expect(stopped(mount(mirror), { uid: () => undefined })).toMatchObject({ stage: 'mounts' });
});
it('takes a nested socket that is a real socket apart from every mounted directory', () => {
  expect(stopped({ accountLogins: logins, mounts: fixed, nestedSocket: socket })).toBeUndefined();
  // A socket is the engine's, often root's: it need not belong to the worker's user.
  expect(stopped({ nestedSocket: socket }, { uid: () => process.getuid!() + 1 })).toBeUndefined();
  // Only a job allowed nested containers is given it, first and writable, at the one place.
  const mounts = bodyMounts({ accountLogins: logins, mounts: fixed, socket, nestedSocket: socket, state: stateDirectory, tokenFile });
  expect(mounts(job('a', 'claude')).map(found => found.source)).toEqual([a, stamps, mirror]);
  expect(mounts(nestedJob('a', 'claude'))).toEqual([{ source: socket, target: NESTED_SOCKET_TARGET, readOnly: false },
    { source: a, target: home, readOnly: false }, { source: stamps, target: '/house/stamps', readOnly: false }, { source: mirror, target: '/house/mirror', readOnly: true }]);
  // A nested job on a machine with no nested socket is not run, and not for want of a runner.
  const without = bodyMounts({ mounts: fixed, socket });
  expect(() => without(nestedJob('a', 'claude'))).toThrow('Nested containers unavailable');
  expect(() => { try { without(nestedJob('a', 'claude')); } catch (error) { if (error instanceof UnservedJobError) throw error; } }).not.toThrow();
});
it('takes the engine socket and the worker\'s own files when no mount reaches them, existing or not', () => {
  // A socket named through a linked directory, or by a link, is taken, and mounted as it was written.
  for (const through of [join(engineLink, 'engine.sock'), socketLink]) {
    expect(stopped({ accountLogins: logins, mounts: fixed, socket: through, nestedSocket: through, state: stateDirectory, tokenFile })).toBeUndefined();
    expect(bodyMounts({ socket: through, nestedSocket: through })(nestedJob('a', 'claude'))).toEqual([{ source: through, target: NESTED_SOCKET_TARGET, readOnly: false }]);
  }
  // The engine socket and the nested socket are commonly the same socket.
  expect(stopped({ accountLogins: logins, mounts: fixed, socket, nestedSocket: socket, state: stateDirectory, tokenFile })).toBeUndefined();
  expect(stopped({ accountLogins: logins, mounts: fixed, socket, state: join(root, 'not-made-yet'), tokenFile: join(root, 'no-token') })).toBeUndefined();
  // With nothing mounted the worker's own files are not looked at.
  expect(stopped({ socket, state: stateDirectory, tokenFile })).toBeUndefined();
});
it('reads anything but an exact false as read-only', () => {
  const made = bodyMounts({ mounts: [{ source: stamps, target: '/a', readOnly: 'no' as unknown as boolean }, { source: mirror, target: '/b', readOnly: 0 as unknown as boolean }] })(job('a', 'claude'));
  expect(made.map(found => found.readOnly)).toEqual([true, true]);
});
it('lets several accounts use one path inside their own containers', () => {
  // Only one sign-in directory is ever in a container, so the same target twice is not a collision.
  expect(stopped({ accountLogins: logins, mounts: fixed })).toBeUndefined();
});
