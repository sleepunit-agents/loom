import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:net';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { bodyMounts, BODY_PROGRAM, BODY_PROGRAM_TARGET, NESTED_SOCKET_TARGET, type AccountLogins, type FixedMount } from './worker-mounts.js';
import { UnservedJobError } from './worker.js';
import { WORKER_STOP, WorkerStop, workerStopLine } from './worker-stop.js';
import { HOUSE_HOME, HOUSE_NODE, HOUSE_REPOSITORY, houseBodyFile, houseLogin, houseMount } from './house-layout.js';


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
/** Where a Claude sign-in appears in every house: loom's to say, not the configuration's. */
const home = '/run/loom/login/claude';
const logins: AccountLogins = { a: { claude: { source: a }, codex: { source: codex } }, b: { claude: { source: b } } };
const fixed: FixedMount[] = [{ source: stamps, target: 'house/stamps', readOnly: false }, { source: mirror, target: 'house/mirror' }];
const job = (account: string, harness: string, agent = 'art') => ({ agent, account, harness });
const nestedJob = (account: string, harness: string) => ({ agent: 'art', account, harness, run: { policy: { word: 'own' as const, people: [], deniedTools: [] }, gpu: false, nestedContainers: true, ports: [] } });
const stopped = (config: Parameters<typeof bodyMounts>[0], files?: Parameters<typeof bodyMounts>[1]) => {
  try { bodyMounts(config, files); } catch (error) { return error; }
  return undefined;
};

it('gives a job its own account and harness sign-in directory, read-write, and never another one', () => {
  const mounts = bodyMounts({ accountLogins: logins, mounts: { art: fixed } });
  expect(mounts(job('a', 'claude'))).toEqual([{ source: a, target: home, readOnly: false },
    { source: stamps, target: '/home/agent/house/stamps', readOnly: false }, { source: mirror, target: '/home/agent/house/mirror', readOnly: true }]);
  expect(mounts(job('b', 'claude'))[0]).toEqual({ source: b, target: home, readOnly: false });
  expect(mounts(job('a', 'codex'))[0]).toEqual({ source: codex, target: '/run/loom/login/codex', readOnly: false });
  for (const [account, harness, others] of [['a', 'claude', [b, codex]], ['b', 'claude', [a, codex]], ['a', 'codex', [a, b]]] as const)
    for (const other of others) expect(JSON.stringify(mounts(job(account, harness)))).not.toContain(other);
});
it('refuses a job with no exact sign-in entry once the map is present, the way a missing account runner is refused', () => {
  const mounts = bodyMounts({ accountLogins: logins, mounts: { art: fixed } });
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
  expect(bodyMounts({ mounts: { art: fixed } })(job('anyone', 'anything'))).toEqual([
    { source: stamps, target: '/home/agent/house/stamps', readOnly: false }, { source: mirror, target: '/home/agent/house/mirror', readOnly: true }]);
});
it('fixes the paths when it is made: a later change to the configuration object changes nothing', () => {
  const changing = { accountLogins: { a: { claude: { source: a } } }, mounts: { art: [{ source: mirror, target: 'house/mirror' }] } };
  const mounts = bodyMounts(changing);
  changing.accountLogins.a.claude.source = b; changing.mounts.art[0].target = 'elsewhere'; changing.mounts.art.push({ source: stamps, target: 'more' });
  expect(mounts(job('a', 'claude'))).toEqual([{ source: a, target: home, readOnly: false }, { source: mirror, target: '/home/agent/house/mirror', readOnly: true }]);
});

const login = (source: string) => ({ accountLogins: { a: { claude: { source } } } });
const mount = (source: string, target = 'house/x') => ({ mounts: { art: [{ source, target }] } });
it.each([
  ['a sign-in directory that is missing', login(join(root, 'missing'))],
  ['a mount that is missing', mount(join(root, 'missing'))],
  ['a sign-in directory that is a symbolic link', login(link)],
  ['a mount that is a symbolic link', mount(link)],
  ['a sign-in directory reached through a symbolic link', login(through)],
  ['a mount that is a file', mount(file)],
  ['a relative sign-in source', login('logins/a-claude')],
  ['a relative mount source', mount('house/mirror')],
  ['an absolute mount target', mount(mirror, '/home/agent/house/mirror')],
  ['a mount at the repository', mount(mirror, 'repo')],
  ['a source that is not written plainly', mount(`${root}/house/../house/mirror`)],
  ['a target that is not written plainly', mount(mirror, 'house//mirror')],
  ['a target with a trailing slash', mount(mirror, 'house/mirror/')],
  ['a target that climbs', mount(mirror, 'house/../etc')],
  ['the root of the container as a target', mount(mirror, '/')],
  ['a null byte in a target', mount(mirror, 'house/\0')],
  ['an empty source', mount('')],
  ['two mounts at one target', { mounts: { art: [{ source: stamps, target: 'house/x' }, { source: mirror, target: 'house/x' }] } }],
  ['a mount inside another mount\'s target', { mounts: { art: [{ source: stamps, target: 'house' }, { source: mirror, target: 'house/mirror' }] } }],
  ['a mount whose target holds another\'s', { mounts: { art: [{ source: mirror, target: 'house/mirror' }, { source: stamps, target: 'house' }] } }],
  ['a mount at the nested engine socket', mount(mirror, NESTED_SOCKET_TARGET)],
  ['a mount over the nested engine socket', mount(mirror, '/var/run')],
  // What the contract's first point needs and no target check gives: a body must not be handed another
  // job's sign-in directory under a different name.
  ['a mount whose source is a sign-in directory', { ...login(a), mounts: { art: [{ source: a, target: 'house/x' }] } }],
  ['a mount whose source holds a sign-in directory', { ...login(a), mounts: { art: [{ source: join(root, 'logins'), target: 'house/x' }] } }],
  ['a mount whose source is inside a sign-in directory', { ...login(stamps), mounts: { art: [{ source: join(stamps, 'inner'), target: 'house/x' }] } }],
  ['two accounts on one sign-in directory', { accountLogins: { a: { claude: { source: a } }, b: { claude: { source: a } } } }],
  ['one account\'s sign-in directory inside another\'s', { accountLogins: { a: { claude: { source: stamps } }, b: { claude: { source: join(stamps, 'inner') } } } }],
  // One rule for every pair of mounted directories, fixed mounts among themselves included.
  ['one directory mounted twice', { mounts: { art: [{ source: mirror, target: 'one' }, { source: mirror, target: 'two' }] } }],
  ['a read-only mount whose source is writable under a second name', { mounts: { art: [{ source: join(root, 'house'), target: 'house' }, { source: stamps, target: 'stamps', readOnly: false }] } }],
  ['a mount whose source holds an earlier mount\'s', { mounts: { art: [{ source: stamps, target: 'stamps' }, { source: join(root, 'house'), target: 'house' }] } }],
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
  expect(error.key).toMatch(/^(container\.(mounts\.art\[[01]\]\.(source|target)|socket|nestedSocket)|accountLogins\.[ab]\.claude\.(source|target))$/);
  expect(workerStopLine('mounts', error.key)).toBe(`Worker stopped: ${WORKER_STOP.mounts[1]} (${error.key})\n`);
  expect(workerStopLine('mounts', error.key)).not.toContain(root);
});
it('names the configuration key at fault, the later of two that overlap, and never what is written under it', () => {
  const key = (config: Parameters<typeof bodyMounts>[0]) => (stopped(config) as WorkerStop | undefined)?.key;
  expect(key({ mounts: { art: [{ source: mirror, target: 'ok' }, { source: join(root, 'missing'), target: 'x' }] } })).toBe('container.mounts.art[1].source');
  expect(key({ mounts: { art: [{ source: mirror, target: '/absolute' }] } })).toBe('container.mounts.art[0].target');
  expect(key({ mounts: { art: [{ source: mirror, target: 'repo' }] } })).toBe('container.mounts.art[0].target');
  expect(key({ mounts: { art: [{ source: mirror, target: 'x' }, { source: stamps, target: 'x/y' }] } })).toBe('container.mounts.art[1].target');
  expect(key({ mounts: { art: [{ source: mirror, target: 'x' }, { source: mirror, target: 'y' }] } })).toBe('container.mounts.art[1].source');
  expect(key({ mounts: { art: [{ source: mirror, target: '/var/run' }] } })).toBe('container.mounts.art[0].target');
  expect(key({ ...login(a), mounts: { art: [{ source: a, target: 'x' }] } })).toBe('accountLogins.a.claude.source');
  expect(key({ accountLogins: { 'sub-1@example.com': { 'Codex CLI': { source: a } } } })).toBe('accountLogins.sub-1@example.com."Codex CLI"');
  expect(key({ accountLogins: { a: { claude: { source: a } }, b: { claude: { source: a } } } })).toBe('accountLogins.b.claude.source');
  // A name that is not an ordinary one is quoted, so it cannot break the line it is printed on.
  expect(key({ accountLogins: { 'two\nlines': { 'a harness': { source: join(root, 'missing') } } } })).toBe('accountLogins."two\\nlines"."a harness".source');
  expect(key({ socket: join(root, 'no.sock') })).toBe('container.socket');
  expect(key({ socket, nestedSocket: engineDirectory })).toBe('container.nestedSocket');
  expect(key({ ...mount(engineDirectory), socket })).toBe('container.mounts.art[0].source');
  expect(key({ ...mount(stateDirectory), state: stateDirectory })).toBe('container.mounts.art[0].source');
  expect(key({ ...mount(join(root, 'worker')), tokenFile })).toBe('container.mounts.art[0].source');
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
it('refuses the same engine, a different engine, and aliases of the engine for nested access', () => {
  for (const nestedSocket of [socket, socketInLogin, socketLink, join(engineLink, 'engine.sock')])
    expect(stopped({ socket, nestedSocket })).toMatchObject({ stage: 'mounts', key: 'container.nestedSocket' });
});
it('takes the engine socket and the worker\'s own files when no mount reaches them, existing or not', () => {
  // A socket named through a linked directory, or by a link, is taken, and mounted as it was written.
  for (const through of [join(engineLink, 'engine.sock'), socketLink]) {
    expect(stopped({ accountLogins: logins, mounts: { art: fixed }, socket: through, state: stateDirectory, tokenFile })).toBeUndefined();
  }
  expect(stopped({ accountLogins: logins, mounts: { art: fixed }, socket, state: stateDirectory, tokenFile })).toBeUndefined();
  expect(stopped({ accountLogins: logins, mounts: { art: fixed }, socket, state: join(root, 'not-made-yet'), tokenFile: join(root, 'no-token') })).toBeUndefined();
  // With nothing mounted the worker's own files are not looked at.
  expect(stopped({ socket, state: stateDirectory, tokenFile })).toBeUndefined();
});
it('reads anything but an exact false as read-only', () => {
  const made = bodyMounts({ mounts: { art: [{ source: stamps, target: 'a', readOnly: 'no' as unknown as boolean }, { source: mirror, target: 'b', readOnly: 0 as unknown as boolean }] } })(job('a', 'claude'));
  expect(made.map(found => found.readOnly)).toEqual([true, true]);
});
it('lets several accounts use one path inside their own containers', () => {
  // Only one sign-in directory is ever in a container, so the same target twice is not a collision.
  expect(stopped({ accountLogins: logins, mounts: { art: fixed } })).toBeUndefined();
});

// One worker, any agent: fixed mounts belong to an agent, and the worker's own directory goes to every body.
const programDirectory = directory('install/loom'), markState = directory('mark/state');
it('gives a body its own agent\'s mounts and never another agent\'s', () => {
  const mounts = bodyMounts({ accountLogins: logins, mounts: { art: fixed, mark: [{ source: markState, target: 'house/stamps', readOnly: false }] } });
  expect(mounts(job('a', 'claude', 'art')).map(found => found.source)).toEqual([a, stamps, mirror]);
  expect(mounts(job('a', 'claude', 'mark'))).toEqual([{ source: a, target: home, readOnly: false }, { source: markState, target: '/home/agent/house/stamps', readOnly: false }]);
  // An agent the machine has no list for gets none, and names an object has by itself are not agents.
  for (const agent of ['nobody', 'constructor', 'toString', '__proto__']) expect(mounts(job('a', 'claude', agent))).toEqual([{ source: a, target: home, readOnly: false }]);
  for (const [agent, others] of [['art', [markState]], ['mark', [stamps, mirror]], ['nobody', [stamps, mirror, markState]]] as const)
    for (const other of others) expect(JSON.stringify(mounts(job('a', 'claude', agent)))).not.toContain(other);
});
it('lets two agents use one place inside their own containers, and holds every agent\'s sources apart', () => {
  // Two agents' mounts never meet in one container: the same target is no collision.
  expect(stopped({ mounts: { art: [{ source: stamps, target: 'state' }], mark: [{ source: markState, target: 'state' }] } })).toBeUndefined();
  const key = (config: Parameters<typeof bodyMounts>[0]) => (stopped(config) as WorkerStop | undefined)?.key;
  // One agent's directory under another agent's name, whole, above or below: the later entry is at fault.
  expect(key({ mounts: { art: [{ source: stamps, target: 'state' }], mark: [{ source: stamps, target: 'other' }] } })).toBe('container.mounts.mark[0].source');
  expect(key({ mounts: { art: [{ source: stamps, target: 'state' }], mark: [{ source: join(root, 'house'), target: 'other' }] } })).toBe('container.mounts.mark[0].source');
  expect(key({ mounts: { art: [{ source: join(root, 'house'), target: 'house' }], mark: [{ source: mirror, target: 'other', readOnly: false }] } })).toBe('container.mounts.mark[0].source');
  // Within one agent's list the target rule is as it was; against a sign-in directory it holds for every agent.
  expect(key({ mounts: { art: [{ source: stamps, target: 'state' }, { source: mirror, target: 'state/inner' }] } })).toBe('container.mounts.art[1].target');
  expect(key({ ...login(a), mounts: { mark: [{ source: markState, target: '/run/loom/login/claude' }] } })).toBe('container.mounts.mark[0].target');
  expect(key({ mounts: { 'an agent': [{ source: join(root, 'missing'), target: 'x' }] } })).toBe('container.mounts."an agent"[0].source');
});
it('gives every body the worker\'s own directory, read-only, at one place no mount may cover', () => {
  const mounts = bodyMounts({ program: programDirectory, accountLogins: logins, mounts: { art: fixed }, socket });
  const program = { source: programDirectory, target: BODY_PROGRAM_TARGET, readOnly: true };
  expect(BODY_PROGRAM_TARGET).toBe('/opt/loom'); expect(BODY_PROGRAM).toBe('/opt/loom/dist/body.js');
  expect(mounts(job('a', 'claude', 'mark'))).toEqual([program, { source: a, target: home, readOnly: false }]);
  // It need not belong to the worker's user: a system-wide install is root's.
  expect(stopped({ program: programDirectory }, { uid: () => process.getuid!() + 1 })).toBeUndefined();
  const key = (config: Parameters<typeof bodyMounts>[0]) => (stopped(config) as WorkerStop | undefined)?.key;
  const itself = 'the directory the worker is installed in';
  for (const program of [join(root, 'missing'), file, link, 'install/loom', `${programDirectory}/`]) expect(key({ program })).toBe(itself);
  // No mount may hide the body program or put something in its place.
  for (const target of ['/opt/loom', '/opt', '/opt/loom/dist']) {
    expect(key({ program: programDirectory, mounts: { art: [{ source: mirror, target }] } })).toBe('container.mounts.art[0].target');
  }
  // No agent's mount, and no sign-in directory, may be the program, hold it or be inside it: a body that
  // could write there would change the program every other body runs.
  expect(key({ program: programDirectory, mounts: { art: [{ source: programDirectory, target: 'x', readOnly: false }] } })).toBe('container.mounts.art[0].source');
  expect(key({ program: programDirectory, mounts: { art: [{ source: join(root, 'install'), target: 'x' }] } })).toBe('container.mounts.art[0].source');
  expect(key({ program: join(root, 'logins'), ...login(a) })).toBe('accountLogins.a.claude.source');
  // Nor may the worker's own directory hold its token, its state directory or an engine socket.
  expect(key({ program: join(root, 'worker'), tokenFile })).toBe(itself);
  expect(key({ program: join(root, 'worker'), state: stateDirectory })).toBe(itself);
  expect(key({ program: engineDirectory, socket })).toBe(itself);
});
// One layout for every house: where things land is loom's to say (house-layout.ts).
it('mounts a sign-in at the one place every house looks for it, whatever the machine', () => {
  expect([HOUSE_HOME, HOUSE_REPOSITORY, HOUSE_NODE, houseLogin('claude'), houseBodyFile('codex'), houseMount('.local/state')])
    .toEqual(['/home/agent', '/home/agent/repo', '/usr/local/bin/node', '/run/loom/login/claude', '/etc/loom/body/codex.json', '/home/agent/.local/state']);
  const mounts = bodyMounts({ accountLogins: { one: { claude: { source: a }, codex: { source: codex } }, two: { claude: { source: b } } } });
  expect(mounts(job('one', 'claude'))).toEqual([{ source: a, target: '/run/loom/login/claude', readOnly: false }]);
  expect(mounts(job('two', 'claude'))).toEqual([{ source: b, target: '/run/loom/login/claude', readOnly: false }]);
  expect(mounts(job('one', 'codex'))).toEqual([{ source: codex, target: '/run/loom/login/codex', readOnly: false }]);
  // A place written in the configuration is not read: there is none to write.
  const stray = bodyMounts({ accountLogins: { one: { claude: { source: a, target: '/somewhere/else' } as { source: string } } } });
  expect(stray(job('one', 'claude'))[0].target).toBe('/run/loom/login/claude');
});
it('lands an agent\'s directories under the tenant\'s home, at the path the configuration gives, and never on the repository', () => {
  const mounts = bodyMounts({ mounts: { art: [{ source: stamps, target: '.local/state/tending', readOnly: false }, { source: mirror, target: 'repo/vendor/mirror' }] } });
  expect(mounts(job('a', 'claude'))).toEqual([{ source: stamps, target: '/home/agent/.local/state/tending', readOnly: false }, { source: mirror, target: '/home/agent/repo/vendor/mirror', readOnly: true }]);
  const key = (config: Parameters<typeof bodyMounts>[0]) => (stopped(config) as WorkerStop | undefined)?.key;
  for (const target of ['/home/agent/.local/state', '/etc/passwd', 'repo', '../outside', '.', '', 'a/../../b', 'a//b'])
    expect(key({ mounts: { art: [{ source: stamps, target }] } }), target).toBe('container.mounts.art[0].target');
  // Two of one agent's that would lie one inside the other, said under the home.
  expect(key({ mounts: { art: [{ source: stamps, target: 'state' }, { source: mirror, target: 'state/more' }] } })).toBe('container.mounts.art[1].target');
});
it('leaves everything inside a sign-in directory as it found it: a lock a harness holds, and files it knows nothing of', () => {
  const login = directory('logins/untouched');
  // What a harness's program keeps there: its sign-in, the lock it takes to renew, and anything else of its own.
  for (const [name, content] of [['.credentials.json', 'not read'], ['.oauth_refresh.lock', ''], ['auth.json', 'not read'], ['something-else', 'kept']] as const) writeFileSync(join(login, name), content, { mode: 0o600 });
  const before = readdirSync(login).sort().map(name => [name, statSync(join(login, name)).mtimeMs, statSync(join(login, name)).atimeMs, statSync(join(login, name)).mode]);
  const mounts = bodyMounts({ accountLogins: { account: { claude: { source: login } } } });
  for (let body = 0; body < 3; body++) expect(mounts(job('account', 'claude'))).toEqual([{ source: login, target: '/run/loom/login/claude', readOnly: false }]);
  expect(readdirSync(login).sort().map(name => [name, statSync(join(login, name)).mtimeMs, statSync(join(login, name)).atimeMs, statSync(join(login, name)).mode])).toEqual(before);
});


it('protects private directories from all mount types, including symlink aliases and future files', () => {
  for (const source of [stamps, join(stamps, 'inner')]) {
    for (const configured of [mount(source), login(source), { program: source }])
      expect(stopped({ ...configured, protectedPaths: [link] })).toBeInstanceOf(WorkerStop);
  }
  expect(stopped({ ...login(stamps), protectedPaths: [join(link, 'future.db')] })).toBeInstanceOf(WorkerStop);
  const future = join(root, 'future-private');
  symlinkSync(join(mirror, 'future-db'), future);
  expect(stopped({ ...mount(mirror), protectedPaths: [future] })).toBeInstanceOf(WorkerStop);
  symlinkSync(join(mirror, 'sidecar'), join(root, 'custom.db-wal'));
  expect(stopped({ ...mount(mirror), protectedPaths: [join(root, 'custom.db')] })).toBeInstanceOf(WorkerStop);
  expect(stopped({ ...mount(mirror), configFile: join(mirror, 'worker.json') })).toBeInstanceOf(WorkerStop);
  expect(stopped({ ...mount(mirror), protectedPaths: [stamps] })).toBeUndefined();
  expect(stopped({ protectedPaths: ['relative'] })).toBeInstanceOf(WorkerStop);
  expect(stopped({ nestedSocket: socket })).toBeInstanceOf(WorkerStop);
  expect(stopped({ nestedSocket: socket, protectedPaths: [] })).toBeInstanceOf(WorkerStop);
});

it('keeps intermediate links in a private path outside every mounted directory', () => {
  const through = join(mirror, 'private-hop');
  symlinkSync(stamps, through);
  const alias = join(root, 'private-alias');
  symlinkSync(through, alias);
  for (const configured of [mount(mirror), login(mirror), { program: mirror }])
    expect(stopped({ ...configured, protectedPaths: [join(alias, 'future.db')] })).toBeInstanceOf(WorkerStop);
});

it('protects default private homes and the backup directories for both installations', () => {
  const host = directory('dedicated-machine');
  vi.stubEnv('HOME', host);
  try {
    for (const name of ['loom', 'loom-new', 'loom-secrets', 'loom-new-credentials', 'loom-worker', 'loom-new-worker']) {
      const path = join(host, '.config', name);
      mkdirSync(path, { recursive: true });
      expect(stopped(mount(path))).toBeInstanceOf(WorkerStop);
    }
    for (const name of ['loom', 'loom-new']) {
      const backups = join(host, '.local/share', name, 'home-backups');
      mkdirSync(backups, { recursive: true });
      expect(stopped(mount(backups))).toBeInstanceOf(WorkerStop);
    }
  } finally { vi.unstubAllEnvs(); }
});


it('refuses an engine socket for own, owner, held, guest and older assignments', () => {
  const mounts = bodyMounts({ socket });
  const job = nestedJob('a', 'claude');
  const room = { deniedTools: [], people: [] };
  for (const policy of [undefined, room, { ...room, word: 'own' as const }, { ...room, word: 'owners' as const }, { ...room, word: 'others' as const },
    { ...room, word: 'owners' as const, people: [{ kind: 'outside' as const, person: 'guest', tier: 3 as const }] },
    { ...room, word: 'own' as const, people: [{ kind: 'unknown' as const, person: null, tier: null }] }])
    expect(() => mounts({ ...job, run: { ...job.run, policy } })).toThrow('Nested containers unavailable');
});
