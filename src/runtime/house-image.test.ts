import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { DockerResponseError, type DockerEngine } from './docker-engine.js';
import { UnmetHouseError } from './worker.js';
import { buildCore, buildHouse, coreImage, coreImageName, houseBuilt, houseCore, houseImage, houseImageName, houseStart, pruneHouses, CORE_ARGUMENT, HOUSE_IMAGES_KEPT, HOUSE_IMAGES_PER_HOUSE } from './house-image.js';
import { LISTING_MAX } from './docker-engine.js';

const house = { repository: 'https://example.com/org/house.git', file: 'house/Housefile', branch: 'main' }, commit = 'c'.repeat(40);
/** The core house of one definition in one week, and the same definition a week later. */
const core = coreImage('e'.repeat(64), '2026w47'), nextCore = coreImage('e'.repeat(64), '2026w48');
const image = houseImage(house, commit, core), id = `sha256:${'a'.repeat(64)}`;
const never = () => new AbortController().signal;
/** A guard that lets every image go but these. */
const keeping = (names: readonly string[]) => ({ take: (name: string) => !names.includes(name), done: () => {}, used: () => undefined });
function engine(answer: (method: string, path: string) => unknown = () => undefined) {
  const json = vi.fn(async (method: string, path: string, _body: unknown, _signal: AbortSignal) => answer(method, path));
  const build = vi.fn(async (_path: string, context: PassThrough, _signal: AbortSignal) => { context.resume(); });
  return { json, build, attach: vi.fn() } as unknown as DockerEngine & { json: typeof json; build: typeof build };
}
const labelled = (labels: Record<string, unknown>, config: Record<string, unknown> = {}) => ({ Id: id, Config: { WorkingDir: '/home/agent/house', Labels: labels, ...config } });
const good = { 'loom.house': '2', 'loom.house.harnesses': 'claude codex' };

it('names an image by its repository, Housefile, commit and the core house it was built on, and by nothing else of the worker', () => {
  expect(core).toBe(`localhost/loom-core:${'e'.repeat(16)}-2026w47`);
  expect(image).toBe(`localhost/loom-house-${image.slice('localhost/loom-house-'.length, 'localhost/loom-house-'.length + 16)}:${'c'.repeat(40)}-${'e'.repeat(16)}-2026w47`);
  expect(image).toMatch(/^localhost\/loom-house-[0-9a-f]{16}:c{40}-e{16}-2026w47$/);
  expect(houseImage({ ...house }, commit, core)).toBe(image);
  // The branch is how the commit was found, not part of what was built.
  expect(houseImage({ ...house, branch: 'other' }, commit, core)).toBe(image);
  // A new commit, another Housefile, another repository, no Housefile at all, a core of another week or another definition: each is another image.
  const others = [houseImage({ ...house, repository: 'https://example.com/org/other.git' }, commit, core), houseImage({ ...house, file: 'Housefile' }, commit, core), houseImage({ ...house, file: '' }, commit, core),
    houseImage(house, 'd'.repeat(40), core), houseImage(house, commit, nextCore), houseImage(house, commit, coreImage('f'.repeat(64), '2026w47'))];
  expect(new Set([image, ...others]).size).toBe(7);
  // Two parts that would run together under a plain joining are still told apart.
  expect(houseImage({ ...house, repository: 'https://example.com/a', file: 'b/c' }, commit, core)).not.toBe(houseImage({ ...house, repository: 'https://example.com/a/b', file: 'c' }, commit, core));
  // An image says which core it was built on, and the two kinds of name are never taken for each other.
  expect(houseCore(image)).toBe(core); expect(houseCore(houseImage(house, commit, nextCore))).toBe(nextCore);
  expect([houseImageName(image), coreImageName(image), houseImageName(core), coreImageName(core)]).toEqual([true, false, false, true]);
  for (const name of [`localhost/loom-house-${'a'.repeat(16)}:${'c'.repeat(40)}`, `${image}x`, `localhost/loom-core:${'e'.repeat(16)}`, 'localhost/loom-core:latest', `localhost/loom-core:${'e'.repeat(16)}-2026w47:x`, 7, undefined])
    expect([houseImageName(name), coreImageName(name)], String(name)).toEqual([false, false]);
  expect(() => houseImage(house, commit, 'docker.io/library/debian:trixie')).toThrow('Invalid core house image');
  expect(() => coreImage('not hex', '2026w47')).toThrow(); expect(() => coreImage('e'.repeat(64), 'this week')).toThrow();
});
it('finds an image that is there and one that is not, and takes no other answer for either', async () => {
  expect(await houseBuilt(engine(() => ({ Id: id })), image, never())).toBe(true);
  expect(await houseBuilt(engine(() => { throw new DockerResponseError(404); }), image, never())).toBe(false);
  await expect(houseBuilt(engine(() => { throw new DockerResponseError(500); }), image, never())).rejects.toThrow();
  await expect(houseBuilt(engine(), 'docker.io/library/busybox', never())).rejects.toThrow('Invalid house image');
});
it('has the engine build from the context and the Housefile\'s path, adding nothing, and believes only an image that is there', async () => {
  const there = engine(() => ({ Id: id })), context = new PassThrough();
  await buildHouse(there, image, house.file, context, never());
  const [path] = there.build.mock.calls[0];
  // One build argument, the core house the image is named for; nothing else is added.
  expect(Object.fromEntries(new URL(path, 'http://engine').searchParams)).toEqual({ t: image, dockerfile: 'house/Housefile', buildargs: JSON.stringify({ LOOM_CORE: core }), q: '1', rm: '1', forcerm: '1' });
  expect(CORE_ARGUMENT).toBe('LOOM_CORE');
  expect(there.build.mock.calls[0][1]).toBe(context);
  // An engine that says nothing went wrong and has no image.
  await expect(buildHouse(engine(() => { throw new DockerResponseError(404); }), image, house.file, new PassThrough(), never())).rejects.toThrow('House image was not built');
  const failing = engine(); failing.build.mockRejectedValue(new Error('Docker build failed'));
  await expect(buildHouse(failing, image, house.file, new PassThrough(), never())).rejects.toThrow('Docker build failed'); expect(failing.json).not.toHaveBeenCalled();
  for (const file of ['/etc/passwd', '../Housefile', 'a\nb']) {
    const unused = engine(), given = new PassThrough();
    await expect(buildHouse(unused, image, file, given, never())).rejects.toThrow('Invalid house image'); expect(unused.build).not.toHaveBeenCalled(); expect(given.destroyed).toBe(true);
  }
});
it('takes an image that says it is a house of this layout and serves the job\'s harness, and reads nothing else from it', async () => {
  const found = engine(() => labelled(good, { WorkingDir: '/somewhere/of/its/own', Env: ['HOME=/root'] }));
  // Only which image: where node, the body file and the repository are is the layout's, the same in every house.
  expect(await houseStart(found, image, 'claude', never())).toEqual({ id });
  expect(await houseStart(found, image, 'codex', never())).toEqual({ id });
  expect(found.json).toHaveBeenCalledWith('GET', `/images/${image}/json`, undefined, expect.any(AbortSignal));
  // The labels of the first layout say nothing now: a house built for it is refused, and says which label.
  const old = { 'loom.house': '1', 'loom.house.node': '/usr/local/bin/node', 'loom.house.body.claude': '/etc/loom/body/claude.json' };
  expect((await houseStart(engine(() => labelled(old)), image, 'claude', never()).catch(error => error as UnmetHouseError)).rule).toBe('loom.house');
});
it.each([
  ['no labels', labelled({}, { Labels: null })], ['no contract version', labelled({ ...good, 'loom.house': undefined })], ['an earlier contract version', labelled({ ...good, 'loom.house': '1' })],
  ['a later contract version', labelled({ ...good, 'loom.house': '3' })], ['no list of harnesses', labelled({ ...good, 'loom.house.harnesses': undefined })],
  ['a list of harnesses that is not text', labelled({ ...good, 'loom.house.harnesses': ['claude'] })], ['a list that names other harnesses', labelled({ ...good, 'loom.house.harnesses': 'codex agy' })],
  ['a list in which the harness is only part of a name', labelled({ ...good, 'loom.house.harnesses': 'claude-code xclaude' })], ['no configuration', { Id: id }],
])('refuses an image with %s, as the house\'s fault', async (_what, inspected) => {
  await expect(houseStart(engine(() => inspected), image, 'claude', never())).rejects.toThrow(UnmetHouseError);
});
it('names the label or the rule an image breaks, and never anything else', async () => {
  const rule = async (inspected: unknown, harness = 'claude') => (await houseStart(engine(() => inspected), image, harness, never()).catch(error => error as UnmetHouseError)).rule;
  expect(await rule(labelled({ ...good, 'loom.house': '1' }))).toBe('loom.house');
  expect(await rule(labelled(good), 'agy')).toBe('loom.house.harnesses');
  expect(await rule(labelled(good, { Volumes: { '/data': {} } }))).toBe('VOLUME');
  expect(await rule(labelled(good, { Labels: null }))).toBe('loom.house');
  // A harness that is no label's name is said as the rule, not echoed.
  expect(await rule(labelled(good), 'a b\nc')).toBe('loom.house.harnesses');
});
it.each([
  ['a volume of its own', { Volumes: { '/data': {} } }], ['a volume its base image declared', { Volumes: { '/var/lib/x': {}, '/data': {} } }],
])('refuses an image that declares %s before any container is made of it', async (_what, config) => {
  const failure = await houseStart(engine(() => labelled(good, config)), image, 'claude', never()).catch(error => error as UnmetHouseError);
  expect(failure).toBeInstanceOf(UnmetHouseError); expect(failure.rule).toBe('VOLUME');
  // No volumes, said either way an engine says it.
  for (const Volumes of [null, {}, undefined]) expect(await houseStart(engine(() => labelled(good, { Volumes })), image, 'claude', never())).toMatchObject({ id });
});
it('takes one shape for a house image\'s name, wherever one is asked about', async () => {
  expect(houseImageName(image)).toBe(true);
  for (const other of ['docker.io/library/busybox', 'image', `${image}?x`, `${image} `, image.replace('localhost/', ''), image.slice(0, -1), 7, undefined]) expect(houseImageName(other)).toBe(false);
  await expect(houseStart(engine(() => labelled(good)), 'docker.io/library/busybox', 'claude', never())).rejects.toThrow('Invalid house image');
});
it('refuses a harness the image has no body file for, and one that is no label\'s name', async () => {
  for (const harness of ['agy', 'constructor', 'toString', '__proto__', 'Claude', 'a b', '', 'claude.x'])
    await expect(houseStart(engine(() => labelled(good)), image, harness, never())).rejects.toThrow(UnmetHouseError);
  // An engine's failure, or an answer that is not an image, is not the house's fault.
  const broken = await houseStart(engine(() => { throw new DockerResponseError(500); }), image, 'claude', never()).catch(error => error as Error);
  expect(broken).not.toBeInstanceOf(UnmetHouseError);
  expect(await houseStart(engine(() => ({ Id: '../x', Config: { Labels: good } })), image, 'claude', never()).catch(error => error as Error)).not.toBeInstanceOf(UnmetHouseError);
});

const tag = (houseHex: string, commitLetter: string, on = core) => `localhost/loom-house-${houseHex.repeat(16)}:${commitLetter.repeat(40)}-${on.slice(on.indexOf(':') + 1)}`;
/** Which commit a tag made above is of: its one letter. */
const letter = (name: string) => name[name.indexOf(':') + 1];
function listing(rows: { name: string; built: number }[], refuse: string[] = []) {
  const removed: string[] = [], asked: string[] = [];
  const made = engine((method, path) => {
    asked.push(`${method} ${decodeURIComponent(path)}`);
    // Two listings: the house images, and the core houses.
    const cores = decodeURIComponent(path).includes('"localhost/loom-core"');
    if (method === 'GET') return rows.filter(row => row.name.startsWith('localhost/loom-core:') === cores).map(row => ({ Id: `sha256:${row.name}`, RepoTags: [row.name], Created: row.built }));
    if (method === 'DELETE') { const name = path.slice('/images/'.length); if (refuse.includes(name)) throw new DockerResponseError(409); removed.push(name); }
    return undefined;
  });
  return { made, removed, asked };
}
it('keeps the two newest images of each house and removes the older, never the one in hand and never by force', async () => {
  expect([HOUSE_IMAGES_PER_HOUSE, HOUSE_IMAGES_KEPT]).toEqual([2, 10]);
  const rows = [{ name: tag('a', '1'), built: 10 }, { name: tag('a', '2'), built: 20 }, { name: tag('a', '3'), built: 30 }, { name: tag('a', '4'), built: 40 },
    { name: tag('b', '1'), built: 5 }, { name: tag('b', '2'), built: 15 }, { name: 'localhost/loom-house-art-new:abc', built: 1 }, { name: 'docker.io/library/node:22', built: 2 }];
  const all = listing(rows); await pruneHouses(all.made, keeping([tag('a', '1')]), false, never());
  // Of house a: the two newest, and the oldest because a job holds it. Of house b: both. Nothing that is not a house image of this naming.
  expect(all.removed).toEqual([tag('a', '2')]);
  expect(all.asked[0]).toBe('GET /images/json?filters={"reference":["localhost/loom-house-*"]}');
  expect(all.asked.filter(call => call.startsWith('DELETE')).every(call => !call.includes('force'))).toBe(true);
  expect(all.asked.some(call => call.includes('prune'))).toBe(false);
});
it('keeps ten house images in all, the most recently built', async () => {
  const houses = 'abcdef0123456'.split(''), rows = houses.map((hex, index) => ({ name: tag(hex, '1'), built: index }));
  const all = listing(rows); await pruneHouses(all.made, keeping([]), false, never());
  expect(all.removed.sort()).toEqual(rows.slice(0, 3).map(row => row.name).sort());
});
it('reads a listing longer than one ordinary answer, and says so when it cannot list at all', async () => {
  // Images carry their labels in a listing: many of them, or one with a long label, are a long answer.
  const rows = [1, 2, 3, 4].map(n => ({ name: tag('a', String(n)), built: n })), long = listing(rows);
  expect(await pruneHouses(long.made, keeping([]), false, never())).toBe(true);
  expect(long.made.json.mock.calls[0][4]).toBe(LISTING_MAX);
  expect(long.removed).toEqual([tag('a', '2'), tag('a', '1')]);
  // An answer the client will not read, an engine that is down, an answer that is no list: nothing is
  // removed, nothing is thrown, and whoever asked is told that the disk was not looked at.
  for (const answer of [() => { throw new Error('Docker response exceeded limit'); }, () => ({ message: 'not a list' })]) {
    const unread = engine(answer); expect(await pruneHouses(unread, keeping([]), true, never())).toBe(false);
    expect(unread.json).toHaveBeenCalledOnce();
  }
});
it('leaves an image the engine will not remove, goes on, and never fails', async () => {
  const rows = [1, 2, 3, 4].map(n => ({ name: tag('a', String(n)), built: n }));
  const some = listing(rows, [tag('a', '2')]); await pruneHouses(some.made, keeping([]), false, never());
  expect(some.removed).toEqual([tag('a', '1')]);
  await expect(pruneHouses(engine(() => [null, { RepoTags: 'x' }, { RepoTags: [7] }]), [], true, never())).resolves.toBe(true);
});
it('asks the engine to forget what builds left behind only when told no build is running', async () => {
  const all = listing([]); await pruneHouses(all.made, keeping([]), true, never());
  expect(all.asked.slice(2)).toEqual(['POST /images/prune?filters={"dangling":["true"],"until":["24h"]}', 'POST /build/prune?filters={"until":["168h"]}']);
});

it('asks whether an image may go at the moment it is about to remove it, and says when each removal is over', async () => {
  const rows = [1, 2, 3, 4, 5].map(n => ({ name: tag('a', String(n)), built: n })), all = listing(rows), events: string[] = [];
  // A job takes hold of the oldest image while the removals before it are under way.
  let held = false;
  const guard = { used: () => undefined, take: (name: string) => { events.push(`ask ${letter(name)}`); if (name === tag('a', '2')) held = true; return !(held && name === tag('a', '1')); },
    done: (name: string) => { events.push(`done ${letter(name)}`); } };
  await pruneHouses(all.made, guard, false, never());
  expect(all.removed).toEqual([tag('a', '3'), tag('a', '2')]);
  // Asked one at a time, each just before its own removal, and told when that removal has been answered. Never asked about one it keeps anyway.
  expect(events).toEqual(['ask 3', 'done 3', 'ask 2', 'done 2', 'ask 1']);
  // Told the removal is over when the engine refuses it too.
  const refusing = listing(rows.slice(0, 3), [tag('a', '1')]), told: string[] = [];
  await pruneHouses(refusing.made, { take: () => true, done: name => told.push(name), used: () => undefined }, false, never()); expect(told).toEqual([tag('a', '1')]);
});
it('ranks images by when this worker last built or took them, and only then by the engine\'s own time', async () => {
  // An image built again from the engine's cache keeps its old time there: the engine's clock says it is the oldest.
  const rows = [{ name: tag('a', '1'), built: 1 }, { name: tag('a', '7'), built: 7 }, { name: tag('a', '8'), built: 8 }, { name: tag('a', '9'), built: 9 }], all = listing(rows);
  const recent = new Map([[tag('a', '1'), 2], [tag('a', '7'), 1]]);
  await pruneHouses(all.made, { take: () => true, done: () => {}, used: name => recent.get(name) }, false, never());
  // The two this worker used most recently stay, the newer of them first; what it never touched goes, however new the engine says it is.
  expect(all.removed).toEqual([tag('a', '9'), tag('a', '8')]);
  // With nothing known of any of them (a worker just started), the engine's time decides, as before.
  const fresh = listing(rows); await pruneHouses(fresh.made, keeping([]), false, never());
  expect(fresh.removed).toEqual([tag('a', '7'), tag('a', '1')]);
});

// The core house.
it('builds the core house from its own context with no argument, and holds what was built to the image contract', async () => {
  const there = engine(() => labelled(good)), context = new PassThrough();
  await buildCore(there, core, context, never());
  expect(Object.fromEntries(new URL(there.build.mock.calls[0][0], 'http://engine').searchParams)).toEqual({ t: core, dockerfile: 'Housefile', q: '1', rm: '1', forcerm: '1' });
  expect(there.build.mock.calls[0][1]).toBe(context);
  expect(await houseBuilt(there, core, never())).toBe(true);
  // What an engine built that is no house: removed again, and the build has failed. Never an UnmetHouseError: no job's house is at fault.
  for (const inspected of [labelled({}), labelled({ ...good, 'loom.house': '1' }), labelled({ 'loom.house': '2' }), labelled(good, { Volumes: { '/data': {} } })]) {
    const calls: string[] = [], bad = engine((method, path) => { calls.push(`${method} ${path}`); return method === 'GET' ? inspected : undefined; });
    const failure = await buildCore(bad, core, new PassThrough(), never()).catch(error => error as Error);
    expect(failure.message).toBe('Core house image was not built'); expect(failure).not.toBeInstanceOf(UnmetHouseError);
    expect(calls).toEqual([`GET /images/${core}/json`, `DELETE /images/${core}`]);
  }
  // An engine that says nothing went wrong and has no image, and one whose build failed.
  await expect(buildCore(engine(() => { throw new DockerResponseError(404); }), core, new PassThrough(), never())).rejects.toThrow('Core house image was not built');
  const failing = engine(); failing.build.mockRejectedValue(new Error('Docker build failed'));
  await expect(buildCore(failing, core, new PassThrough(), never())).rejects.toThrow('Docker build failed');
  const unused = engine(), given = new PassThrough();
  await expect(buildCore(unused, image, given, never())).rejects.toThrow('Invalid core house image'); expect(unused.build).not.toHaveBeenCalled(); expect(given.destroyed).toBe(true);
});
it('keeps a core house while a house image that is kept was built on it, removes the others, and counts none of them among the ten', async () => {
  const older = coreImage('e'.repeat(64), '2026w45'), other = coreImage('d'.repeat(64), '2026w47');
  // Ten houses on this week's core and three older ones on last week's: the ten newest stay, and with them only their core.
  const houses = 'abcdef0123'.split('').map((hex, index) => ({ name: tag(hex, '1', nextCore), built: 100 + index }));
  const old = '456'.split('').map((hex, index) => ({ name: tag(hex, '2', core), built: index }));
  const rows = [...houses, ...old, { name: core, built: 1 }, { name: nextCore, built: 2 }, { name: older, built: 0 }, { name: other, built: 3 }, { name: 'localhost/loom-core:latest', built: 4 }];
  const all = listing(rows); expect(await pruneHouses(all.made, keeping([]), false, never())).toBe(true);
  expect(all.removed.sort()).toEqual([...old.map(row => row.name), core, older, other].sort());
  expect(all.asked[1 + old.length]).toBe('GET /images/json?filters={"reference":["localhost/loom-core"]}');
  // A house of last week's core that is kept keeps that core beside this week's: a body in it is not disturbed, and the next job builds on the new one.
  const mixed = listing([{ name: tag('a', '1', core), built: 1 }, { name: tag('a', '2', nextCore), built: 2 }, { name: core, built: 1 }, { name: nextCore, built: 2 }, { name: older, built: 0 }]);
  await pruneHouses(mixed.made, keeping([]), false, never()); expect(mixed.removed).toEqual([older]);
  // A core the guard holds back (it is being built, or a house is being built on it) stays though no image names it yet.
  const building = listing([{ name: nextCore, built: 2 }, { name: older, built: 0 }]), told: string[] = [];
  await pruneHouses(building.made, { take: name => name !== nextCore, done: name => told.push(name), used: () => undefined }, false, never());
  expect(building.removed).toEqual([older]); expect(told).toEqual([older]);
  // The cores cannot be listed: nothing of them is removed, and whoever asked is told the disk was not looked at.
  const unlisted = engine((method, path) => { if (decodeURIComponent(path).includes('loom-core')) throw new Error('engine down'); return method === 'GET' ? [] : undefined; });
  expect(await pruneHouses(unlisted, keeping([]), true, never())).toBe(false);
});

