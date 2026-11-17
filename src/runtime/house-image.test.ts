import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { DockerResponseError, type DockerEngine } from './docker-engine.js';
import { UnmetHouseError as HouseImageError } from './worker.js';
import { buildHouse, houseBuilt, houseImage, houseStart, pruneHouses, HOUSE_IMAGES_KEPT, HOUSE_IMAGES_PER_HOUSE } from './house-image.js';

const house = { repository: 'https://example.com/org/house.git', file: 'house/Housefile', branch: 'main' }, commit = 'c'.repeat(40);
const image = houseImage(house, commit), id = `sha256:${'a'.repeat(64)}`;
const never = () => new AbortController().signal;
function engine(answer: (method: string, path: string) => unknown = () => undefined) {
  const json = vi.fn(async (method: string, path: string, _body: unknown, _signal: AbortSignal) => answer(method, path));
  const build = vi.fn(async (_path: string, context: PassThrough, _signal: AbortSignal) => { context.resume(); });
  return { json, build, attach: vi.fn() } as unknown as DockerEngine & { json: typeof json; build: typeof build };
}
const labelled = (labels: Record<string, unknown>, config: Record<string, unknown> = {}) => ({ Id: id, Config: { WorkingDir: '/home/agent/house', Labels: labels, ...config } });
const good = { 'loom.house': '1', 'loom.house.node': '/usr/local/bin/node', 'loom.house.body.claude': '/etc/loom/body/claude.json', 'loom.house.body.codex': '/etc/loom/body/codex.json' };

it('names an image by its repository, Housefile and commit, and by nothing of the worker', () => {
  expect(image).toMatch(/^localhost\/loom-house-[0-9a-f]{16}:c{40}$/);
  expect(houseImage({ ...house }, commit)).toBe(image);
  // The branch is how the commit was found, not part of what was built.
  expect(houseImage({ ...house, branch: 'other' }, commit)).toBe(image);
  const others = [houseImage({ ...house, repository: 'https://example.com/org/other.git' }, commit), houseImage({ ...house, file: 'Housefile' }, commit), houseImage(house, 'd'.repeat(40))];
  expect(new Set([image, ...others]).size).toBe(4);
  // Two parts that would run together under a plain joining are still told apart.
  expect(houseImage({ ...house, repository: 'https://example.com/a', file: 'b/c' }, commit)).not.toBe(houseImage({ ...house, repository: 'https://example.com/a/b', file: 'c' }, commit));
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
  expect(Object.fromEntries(new URL(path, 'http://engine').searchParams)).toEqual({ t: image, dockerfile: 'house/Housefile', q: '1', rm: '1', forcerm: '1' });
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
it('reads from the image how a body starts in it, for the job\'s harness', async () => {
  const found = engine(() => labelled(good));
  expect(await houseStart(found, image, 'claude', never())).toEqual({ id, node: '/usr/local/bin/node', body: '/etc/loom/body/claude.json', cwd: '/home/agent/house' });
  expect(await houseStart(found, image, 'codex', never())).toMatchObject({ body: '/etc/loom/body/codex.json' });
  expect(found.json).toHaveBeenCalledWith('GET', `/images/${image}/json`, undefined, expect.any(AbortSignal));
});
it.each([
  ['no labels', labelled({}, { Labels: null })], ['no contract version', labelled({ ...good, 'loom.house': undefined })], ['a later contract version', labelled({ ...good, 'loom.house': '2' })],
  ['no node', labelled({ ...good, 'loom.house.node': undefined })], ['a relative node', labelled({ ...good, 'loom.house.node': 'node' })],
  ['a node that is not written plainly', labelled({ ...good, 'loom.house.node': '/usr/bin/../bin/node' })], ['a body file that is not text', labelled({ ...good, 'loom.house.body.claude': 7 })],
  ['a relative body file', labelled({ ...good, 'loom.house.body.claude': 'claude.json' })], ['no working directory', labelled(good, { WorkingDir: '' })],
  ['the root as working directory', labelled(good, { WorkingDir: '/' })], ['no configuration', { Id: id }],
])('refuses an image with %s, as the house\'s fault', async (_what, inspected) => {
  await expect(houseStart(engine(() => inspected), image, 'claude', never())).rejects.toThrow(HouseImageError);
});
it('refuses a harness the image has no body file for, and one that is no label\'s name', async () => {
  for (const harness of ['agy', 'constructor', 'toString', '__proto__', 'Claude', 'a b', '', 'claude.x'])
    await expect(houseStart(engine(() => labelled(good)), image, harness, never())).rejects.toThrow(HouseImageError);
  // An engine's failure, or an answer that is not an image, is not the house's fault.
  const broken = await houseStart(engine(() => { throw new DockerResponseError(500); }), image, 'claude', never()).catch(error => error as Error);
  expect(broken).not.toBeInstanceOf(HouseImageError);
  expect(await houseStart(engine(() => ({ Id: '../x', Config: { Labels: good } })), image, 'claude', never()).catch(error => error as Error)).not.toBeInstanceOf(HouseImageError);
});

const tag = (houseHex: string, commitLetter: string) => `localhost/loom-house-${houseHex.repeat(16)}:${commitLetter.repeat(40)}`;
function listing(rows: { name: string; built: number }[], refuse: string[] = []) {
  const removed: string[] = [], asked: string[] = [];
  const made = engine((method, path) => {
    asked.push(`${method} ${decodeURIComponent(path)}`);
    if (method === 'GET') return rows.map(row => ({ Id: `sha256:${row.name}`, RepoTags: [row.name], Created: row.built }));
    if (method === 'DELETE') { const name = path.slice('/images/'.length); if (refuse.includes(name)) throw new DockerResponseError(409); removed.push(name); }
    return undefined;
  });
  return { made, removed, asked };
}
it('keeps the two newest images of each house and removes the older, never the one in hand and never by force', async () => {
  expect([HOUSE_IMAGES_PER_HOUSE, HOUSE_IMAGES_KEPT]).toEqual([2, 10]);
  const rows = [{ name: tag('a', '1'), built: 10 }, { name: tag('a', '2'), built: 20 }, { name: tag('a', '3'), built: 30 }, { name: tag('a', '4'), built: 40 },
    { name: tag('b', '1'), built: 5 }, { name: tag('b', '2'), built: 15 }, { name: 'localhost/loom-house-art-new:abc', built: 1 }, { name: 'docker.io/library/node:22', built: 2 }];
  const all = listing(rows); await pruneHouses(all.made, [tag('a', '1')], false, never());
  // Of house a: the two newest, and the oldest because a job holds it. Of house b: both. Nothing that is not a house image of this naming.
  expect(all.removed).toEqual([tag('a', '2')]);
  expect(all.asked[0]).toBe('GET /images/json?filters={"reference":["localhost/loom-house-*"]}');
  expect(all.asked.filter(call => call.startsWith('DELETE')).every(call => !call.includes('force'))).toBe(true);
  expect(all.asked.some(call => call.includes('prune'))).toBe(false);
});
it('keeps ten house images in all, the most recently built', async () => {
  const houses = 'abcdef0123456'.split(''), rows = houses.map((hex, index) => ({ name: tag(hex, '1'), built: index }));
  const all = listing(rows); await pruneHouses(all.made, [], false, never());
  expect(all.removed.sort()).toEqual(rows.slice(0, 3).map(row => row.name).sort());
});
it('leaves an image the engine will not remove, goes on, and never fails', async () => {
  const rows = [1, 2, 3, 4].map(n => ({ name: tag('a', String(n)), built: n }));
  const some = listing(rows, [tag('a', '2')]); await pruneHouses(some.made, [], false, never());
  expect(some.removed).toEqual([tag('a', '1')]);
  for (const answer of [() => { throw new Error('engine is down'); }, () => ({ message: 'not a list' }), () => [null, { RepoTags: 'x' }, { RepoTags: [7] }]])
    await expect(pruneHouses(engine(answer), [], true, never())).resolves.toBeUndefined();
});
it('asks the engine to forget what builds left behind only when told no build is running', async () => {
  const all = listing([]); await pruneHouses(all.made, [], true, never());
  expect(all.asked.slice(1)).toEqual(['POST /images/prune?filters={"dangling":["true"],"until":["24h"]}', 'POST /build/prune?filters={"until":["168h"]}']);
});
