/** `changeFilePatch`, one changed file's patch for the pull brick (docs/specs/boards.md, "The pull brick's file
 * patches"), over the real root, door and credential path, with GitHub faked: no network. People and code are fictional. */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, expect, it, vi } from 'vitest';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import * as s from './core/data/schema.js';
import { sharedRoot } from './shared-root.js';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { serveShared } from './shared-serve.js';
import { capPatch, GITHUB_AT_ONCE, GITHUB_WAITING_MAX, LISTING_KEEP_BYTES, LISTING_KEEP_MS, PATCH_ANSWER_MS, PATCH_BYTES_MAX, PATCH_PAGES_MAX, UNAVAILABLE_KEEP_MS } from './pieces/changes/file-patch.js';
import { githubListingReader, LISTING_BYTES_MAX } from './pieces/changes/github.js';

const clean: (() => unknown)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const close of clean.splice(0).reverse()) await close(); });
const hash = (t: string) => createHash('sha256').update(t).digest('hex');
const GITHUB_TOKEN = 'FICTITIOUS_FORGE_TOKEN';
const alice = 'a'.repeat(64), bob = 'b'.repeat(64), mark = 'k'.repeat(64);
const change = 'github:acme/app#7';
const patch = '@@ -1,3 +1,3 @@\n context\n-old line\n+new line';

function fixture() {
  const client = new Database(':memory:'); clean.push(() => client.close());
  const clock = new FakeClock(Date.parse('2026-11-27T18:00:00Z')), at = () => new Date(clock.now()).toISOString();
  const db = createDataSchema(client, at);
  db.insert(s.members).values([{ id: 'alice', role: 'member', joinedAt: at() }, { id: 'bob', role: 'member', joinedAt: at() }]).run();
  db.insert(s.agents).values([{ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }, { id: 'mark', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }]).run();
  db.insert(s.projects).values([{ id: 'pond', name: 'Pond' }]).run();
  db.insert(s.projectMembers).values({ project: 'pond', member: 'alice' }).run();
  db.insert(s.tokens).values([
    { fingerprint: hash(alice), label: 'Alice', kind: 'owner', member: 'alice', createdAt: at() },
    { fingerprint: hash(bob), label: 'Bob', kind: 'owner', member: 'bob', createdAt: at() },
    { fingerprint: hash(mark), label: 'Mark', kind: 'agent', agent: 'mark', createdAt: at() },
  ]).run();
  db.insert(s.changes).values({ id: change, repository: 'acme/app', number: 7, title: 'Read the pump twice', body: '', url: 'https://github.com/acme/app/pull/7', state: 'open', draft: false,
    authorLogin: 'someone', project: 'pond', agent: 'art', branch: 'pump', headCommit: 'a'.repeat(40), baseBranch: 'next', checks: 'running', review: 'required', mergeable: 'unknown', waitingOn: 'ci', openedAt: at(), updatedAt: at() }).run();
  db.insert(s.changeFiles).values([{ change, path: 'src/pump.ts', additions: 1, deletions: 1 }, { change, path: 'assets/logo.png', additions: 0, deletions: 0 }]).run();
  // GitHub's files list, faked: the pages of each pull request, by number; a hold to keep requests waiting.
  let pages: Record<number, unknown[][]> = { 7: [[{ filename: 'src/pump.ts', patch }, { filename: 'assets/logo.png' }]] }, fail = false;
  let hold: Promise<void> | undefined, running = 0, mostRunning = 0;
  const request = vi.fn<typeof fetch>(async (url, init) => {
    const at = new URL(String(url));
    expect(at.origin + at.pathname).toMatch(/^https:\/\/api\.github\.com\/repos\/acme\/app\/pulls\/\d+\/files$/);
    expect(init?.redirect).toBe('manual');
    expect(init?.headers).toMatchObject({ authorization: 'Bearer ' + GITHUB_TOKEN });
    running++; mostRunning = Math.max(mostRunning, running);
    try {
      await hold;
      if (fail) return new Response('{}', { status: 502 });
      const number = Number(at.pathname.split('/')[5]), page = Number(at.searchParams.get('page'));
      return Response.json(pages[number]?.[page - 1] ?? []);
    } finally { running--; }
  });
  // The poll's own credential path: the holder's bytes, the owner's binding and the same request function.
  const root = sharedRoot({ db, clock, originAllowed: () => true, reportError: () => {},
    changes: { rule: () => undefined, github: { source: { read: async () => Buffer.from(GITHUB_TOKEN) }, bindings: { acme: 'forge' }, request } } });
  clean.push(() => root.close());
  const post = async (body: string, token?: string) => {
    const response = await root.http.request('/graphql', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body });
    return { status: response.status, ...await response.json() as { data?: Record<string, unknown>; errors?: { message: string }[] } };
  };
  const field = (path: string, id = change) => `changeFilePatch(change:${JSON.stringify(id)},path:${JSON.stringify(path)}){state patch cut}`;
  const query = async (path: string, token?: string, id = change) => await post(JSON.stringify({ query: `{${field(path, id)}}` }), token);
  /** Another pull request of the same repository, with these files and these pages on GitHub. */
  const add = (number: number, paths: string[], listed: unknown[][]) => {
    const id = `github:acme/app#${number}`;
    db.insert(s.changes).values({ ...db.select().from(s.changes).where(eq(s.changes.id, change)).get()!, id, number, url: `https://github.com/acme/app/pull/${number}` }).run();
    if (paths.length) db.insert(s.changeFiles).values(paths.map(path => ({ change: id, path, additions: 1, deletions: 0 }))).run();
    pages[number] = listed;
    return id;
  };
  let release = () => {};
  clean.push(() => { hold = undefined; release(); });
  return { db, clock, root, request, query, post, field, add, list: (rows: unknown[]) => { pages[7] = [rows]; }, failing: (value: boolean) => { fail = value; },
    hold: () => { hold = new Promise(go => { release = go; }); }, release: () => { hold = undefined; release(); }, mostRunning: () => mostRunning };
}

const none = { state: 'none', patch: null, cut: false }, unlisted = { state: 'unlisted', patch: null, cut: false }, unavailable = { state: 'unavailable', patch: null, cut: false };
const answer = (r: { data?: Record<string, unknown> }) => r.data?.changeFilePatch;

it('gives a changed file\'s patch to a member who can see the change, and to nobody else', async () => {
  const f = fixture();
  const mine = await f.query('src/pump.ts', alice);
  expect(mine.errors).toBeUndefined();
  expect(answer(mine)).toEqual({ state: 'patch', patch, cut: false });
  // Another member, not in the project; another agent: the same as no such file, and GitHub is not asked.
  expect(f.request).toHaveBeenCalledTimes(1);
  for (const token of [bob, mark]) expect((await f.query('src/pump.ts', token)).data, token).toEqual({ changeFilePatch: null });
  expect((await f.query('src/pump.ts', bob, 'github:acme/app#8')).data).toEqual({ changeFilePatch: null });
  // Nobody signed in: the door refuses before any field is read.
  const outside = await f.query('src/pump.ts');
  expect(outside.status).toBe(401);
  expect(outside.data).toBeUndefined();
  expect(f.request).toHaveBeenCalledTimes(1);
});

it('reads only a path that is one of the change\'s files', async () => {
  const f = fixture();
  for (const path of ['src/other.ts', '../etc/passwd', '', 'SRC/PUMP.TS']) expect((await f.query(path, alice)).data, path).toEqual({ changeFilePatch: null });
  expect((await f.query('src/pump.ts', alice, 'github:acme/app#8')).data).toEqual({ changeFilePatch: null });
  expect(f.request).not.toHaveBeenCalled();
});

it('cuts a patch over 200 KB at its last whole line, or inside a line longer than that, and says so', async () => {
  const f = fixture();
  const long = '@@ -1,9000 +1,9000 @@\n' + Array.from({ length: 9000 }, (_, i) => `+line ${i} ${'x'.repeat(20)}`).join('\n');
  expect(Buffer.byteLength(long)).toBeGreaterThan(PATCH_BYTES_MAX);
  f.list([{ filename: 'src/pump.ts', patch: long }]);
  const cut = answer(await f.query('src/pump.ts', alice)) as { state: string; patch: string; cut: boolean };
  expect(cut.state).toBe('patch');
  expect(cut.cut).toBe(true);
  expect(Buffer.byteLength(cut.patch)).toBeLessThanOrEqual(PATCH_BYTES_MAX);
  expect(long.startsWith(cut.patch + '\n')).toBe(true);
  // One line longer than the cap (a minified file): cut inside it. A two-byte character the cut splits is left out
  // whole, with no replacement character: one byte of ASCII first puts the cut in the middle of an é.
  const wide = capPatch('+' + 'é'.repeat(PATCH_BYTES_MAX / 2));
  expect(wide.cut).toBe(true);
  expect(wide.patch).toBe('+' + 'é'.repeat(PATCH_BYTES_MAX / 2 - 1));
  expect(wide.patch).not.toContain('�');
  expect(capPatch(patch)).toEqual({ patch, cut: false });
});

it('gives the patch text exactly as GitHub does, never searched for credentials', async () => {
  const f = fixture();
  // Words that look like a token pattern are source code, and stay as they are.
  const code = '+const highs_and_lows = weighs_in(x)\n+const sample = "ghp_example"\n+const pat = "github_pat_fixture"';
  f.list([{ filename: 'src/pump.ts', patch: code }]);
  expect(answer(await f.query('src/pump.ts', alice))).toEqual({ state: 'patch', patch: code, cut: false });
});

it('says no patch where GitHub lists the file with none, and not listed where it does not list it', async () => {
  const f = fixture();
  expect(answer(await f.query('assets/logo.png', alice))).toEqual(none);
  // GitHub gives `patch: null`: the same as left out, and the rest of the page is still read.
  f.db.update(s.changes).set({ headCommit: 'b'.repeat(40) }).where(eq(s.changes.id, change)).run();
  f.list([{ filename: 'src/pump.ts', patch }, { filename: 'assets/logo.png', patch: null }]);
  expect(answer(await f.query('assets/logo.png', alice))).toEqual(none);
  expect(answer(await f.query('src/pump.ts', alice))).toEqual({ state: 'patch', patch, cut: false });
  // A push not polled yet: GitHub's list no longer has the file. That page is kept only the short while.
  f.db.update(s.changes).set({ headCommit: 'c'.repeat(40) }).where(eq(s.changes.id, change)).run();
  f.list([{ filename: 'src/elsewhere.ts', patch }]);
  const asked = f.request.mock.calls.length;
  expect(answer(await f.query('src/pump.ts', alice))).toEqual(unlisted);
  f.list([{ filename: 'src/pump.ts', patch }]);
  f.clock.advance(UNAVAILABLE_KEEP_MS - 1);
  expect(answer(await f.query('src/pump.ts', alice))).toEqual(unlisted);
  f.clock.advance(1);
  expect(answer(await f.query('src/pump.ts', alice))).toEqual({ state: 'patch', patch, cut: false });
  expect(f.request.mock.calls.length).toBe(asked + 2);
});

it('keeps a page of the files list for the same head commit a short while, and asks again for a new head', async () => {
  const f = fixture();
  await f.query('src/pump.ts', alice);
  await f.query('assets/logo.png', alice);
  expect(f.request).toHaveBeenCalledTimes(1);
  // A new push: the stored head commit moves, and the next read asks GitHub again.
  f.list([{ filename: 'src/pump.ts', patch: patch + '\n+pushed' }]);
  f.db.update(s.changes).set({ headCommit: 'c'.repeat(40) }).where(eq(s.changes.id, change)).run();
  expect(answer(await f.query('src/pump.ts', alice))).toEqual({ state: 'patch', patch: patch + '\n+pushed', cut: false });
  expect(f.request).toHaveBeenCalledTimes(2);
  // After its time to live, the same head is asked again too.
  f.clock.advance(LISTING_KEEP_MS - 1);
  await f.query('src/pump.ts', alice);
  expect(f.request).toHaveBeenCalledTimes(2);
  f.clock.advance(1);
  await f.query('src/pump.ts', alice);
  expect(f.request).toHaveBeenCalledTimes(3);
});

it('says GitHub is unavailable when it cannot be read, and keeps that answer 30 s', async () => {
  const f = fixture();
  f.failing(true);
  expect(answer(await f.query('src/pump.ts', alice))).toEqual(unavailable);
  f.failing(false);
  expect(answer(await f.query('src/pump.ts', alice))).toEqual(unavailable);
  expect(f.request).toHaveBeenCalledTimes(1);
  f.clock.advance(UNAVAILABLE_KEEP_MS);
  expect(answer(await f.query('src/pump.ts', alice))).toEqual({ state: 'patch', patch, cut: false });
  expect(f.request).toHaveBeenCalledTimes(2);
});

it('reads one page for every path of one pull request in one request, however many are asked', async () => {
  const f = fixture();
  const paths = Array.from({ length: 100 }, (_, i) => `src/file-${i}.ts`);
  const id = f.add(9, paths, [paths.map(filename => ({ filename, patch: '+' + filename }))]);
  const body = JSON.stringify({ query: '{' + paths.map((path, i) => `f${i}:${f.field(path, id)}`).join(' ') + '}' });
  const first = await f.post(body, alice);
  expect(first.errors).toBeUndefined();
  expect(first.data?.f42).toEqual({ state: 'patch', patch: '+src/file-42.ts', cut: false });
  expect(f.request).toHaveBeenCalledTimes(1);
  await f.post(body, alice);
  expect(f.request).toHaveBeenCalledTimes(1);
});

it('reads past the first page when the file is not on it, and no further than three pages', async () => {
  const f = fixture();
  const full = (from: number) => Array.from({ length: 100 }, (_, i) => ({ filename: `src/f${from + i}.ts`, patch: '+' }));
  const id = f.add(10, ['src/late.ts', 'src/never.ts'], [full(0), [...full(100).slice(0, 99), { filename: 'src/late.ts', patch: '+late' }], full(200), [{ filename: 'src/never.ts', patch: '+' }]]);
  expect(answer(await f.query('src/late.ts', alice, id))).toEqual({ state: 'patch', patch: '+late', cut: false });
  expect(f.request.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('page'))).toEqual(['1', '2']);
  expect(answer(await f.query('src/never.ts', alice, id))).toEqual(unlisted);
  expect(f.request.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('page'))).toEqual(['1', '2', String(PATCH_PAGES_MAX)]);
});

it('makes at most two GitHub requests at once, and answers unavailable without asking when too many wait', async () => {
  const f = fixture();
  const ids = Array.from({ length: GITHUB_AT_ONCE + GITHUB_WAITING_MAX + 2 }, (_, i) => f.add(20 + i, ['src/pump.ts'], [[{ filename: 'src/pump.ts', patch }]]));
  f.hold();
  const asked = ids.map(id => f.query('src/pump.ts', alice, id));
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(GITHUB_AT_ONCE));
  f.release();
  const answers = (await Promise.all(asked)).map(answer);
  expect(f.mostRunning()).toBe(GITHUB_AT_ONCE);
  expect(answers.filter(a => (a as { state: string }).state === 'patch')).toHaveLength(GITHUB_AT_ONCE + GITHUB_WAITING_MAX);
  expect(answers.slice(-2)).toEqual([unavailable, unavailable]);
  expect(f.request).toHaveBeenCalledTimes(GITHUB_AT_ONCE + GITHUB_WAITING_MAX);
  // Nothing was sent for those two, so nothing was kept: asked again, they are read.
  expect(answer(await f.query('src/pump.ts', alice, ids.at(-1)))).toEqual({ state: 'patch', patch, cut: false });
});

it('answers unavailable after 20 s, and keeps the page when it does come', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const f = fixture();
  f.hold();
  const asked = f.query('src/pump.ts', alice);
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(1));
  await vi.advanceTimersByTimeAsync(PATCH_ANSWER_MS);
  expect(answer(await asked)).toEqual(unavailable);
  f.release();
  await vi.waitFor(async () => expect(answer(await f.query('src/pump.ts', alice))).toEqual({ state: 'patch', patch, cut: false }));
  expect(f.request).toHaveBeenCalledTimes(1);
});

it('drops the oldest kept pages past the bound on what is kept', async () => {
  const f = fixture();
  // Each page about a quarter of the bound, counted as JavaScript holds text.
  const big = (n: number) => Array.from({ length: 50 }, (_, i) => ({ filename: `src/b${n}-${i}.ts`, patch: 'x'.repeat(LISTING_KEEP_BYTES / 8 / 50 / 2 * 2 - 20) }));
  const ids = [0, 1, 2, 3, 4, 5].map(n => f.add(40 + n, ['src/b' + n + '-0.ts'], [big(n)]));
  for (const [n, id] of ids.entries()) await f.query(`src/b${n}-0.ts`, alice, id);
  expect(f.request).toHaveBeenCalledTimes(6);
  await f.query('src/b5-0.ts', alice, ids[5]);
  expect(f.request).toHaveBeenCalledTimes(6);
  await f.query('src/b0-0.ts', alice, ids[0]);
  expect(f.request).toHaveBeenCalledTimes(7);
});

it('answers a read a commit lands during as the door does any other, and the next ask is the kept answer', async () => {
  const f = fixture();
  f.hold();
  const asked = f.query('src/pump.ts', alice);
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(1));
  // A commit while GitHub is read: the door's own rule, one version an answer (the page asks again once on it).
  f.root.writes.run(() => f.db.update(s.changes).set({ title: 'Read the pump three times' }).where(eq(s.changes.id, change)).run());
  f.release();
  const first = await asked;
  expect(first.status).toBe(503);
  expect(first.errors?.[0]?.message).toBe('Data changed; retry the query');
  expect(answer(await f.query('src/pump.ts', alice))).toEqual({ state: 'patch', patch, cut: false });
  expect(f.request).toHaveBeenCalledTimes(1);
});

it('is refused as a live selection, over the real socket', async () => {
  const client = new Database(':memory:'); clean.push(() => client.close());
  const db = createDataSchema(client), at = new Date().toISOString();
  db.insert(s.members).values({ id: 'alice', role: 'member', joinedAt: at }).run();
  db.insert(s.tokens).values({ fingerprint: hash(alice), label: 'Alice', kind: 'owner', member: 'alice', createdAt: at }).run();
  const request = vi.fn<typeof fetch>();
  const loom = await serveShared({ db, clock: new FakeClock(Date.now()), originAllowed: () => true, reportError: () => {},
    changes: { rule: () => undefined, github: { source: { read: async () => Buffer.from(GITHUB_TOKEN) }, bindings: { acme: 'forge' }, request } } });
  clean.push(() => loom.close());
  const ws = new WebSocket(loom.url.replace('http:', 'ws:') + '/graphql', 'graphql-transport-ws', { headers: { authorization: 'Bearer ' + alice } });
  clean.push(() => ws.terminate());
  await once(ws, 'open');
  // Every frame, in order: two may come in one turn.
  const frames: { type: string; id?: string; payload?: { data?: unknown; errors?: unknown[] } }[] = [], waiting: (() => void)[] = [];
  ws.on('message', raw => { frames.push(JSON.parse(String(raw))); waiting.splice(0).forEach(go => go()); });
  const next = async () => { while (!frames.length) await new Promise<void>(go => waiting.push(go)); return frames.shift()!; };
  ws.send(JSON.stringify({ type: 'connection_init' }));
  expect(await next()).toEqual({ type: 'connection_ack' });
  const observe = (id: string, query: string) => ws.send(JSON.stringify({ id, type: 'subscribe', payload: { query: 'subscription($q:String!){observe(query:$q){revision}}', variables: { q: query } } }));
  // An ordinary selection opens on the same socket: the refusal is of the field, not of the socket.
  observe('ordinary', '{changes{id}}');
  expect(await next()).toMatchObject({ id: 'ordinary', type: 'next', payload: { data: { observe: { revision: 1 } } } });
  for (const query of [`{changeFilePatch(change:"${change}",path:"src/pump.ts"){state}}`, `query{...F} fragment F on Query{x:changeFilePatch(change:"${change}",path:"src/pump.ts"){state}}`]) {
    observe('outside', query);
    expect(await next(), query).toEqual({ id: 'outside', type: 'next', payload: { errors: [{ message: 'Data query could not complete' }] } });
    expect(await next(), query).toEqual({ id: 'outside', type: 'complete' });
  }
  // A direct read on the socket, asked once, is still a read.
  ws.send(JSON.stringify({ id: 'once', type: 'subscribe', payload: { query: `{changeFilePatch(change:"${change}",path:"src/pump.ts"){state}}` } }));
  expect(await next()).toEqual({ id: 'once', type: 'next', payload: { data: { changeFilePatch: null } } });
  expect(request).not.toHaveBeenCalled();
});

it('reads a renamed repository through GitHub\'s redirect, on the same host and to the same list only', async () => {
  const secrets = { source: { read: async () => Buffer.from(GITHUB_TOKEN) }, bindings: { acme: 'forge' } };
  const moved = (location: string) => vi.fn<typeof fetch>(async url => String(url).includes('/repos/')
    ? new Response(null, { status: 301, headers: { location } }) : Response.json([{ filename: 'src/pump.ts', patch }]));
  const { sharedForgeSecrets } = await import('./shared-changes-reader.js');
  const follows = moved('https://api.github.com/repositories/12345/pulls/7/files?per_page=100&page=1');
  expect(await githubListingReader(sharedForgeSecrets({ ...secrets, request: follows } as never), follows)('acme/app', 7, 1)).toEqual([{ filename: 'src/pump.ts', patch }]);
  expect(follows).toHaveBeenCalledTimes(2);
  expect(follows.mock.calls[1][1]?.headers).toMatchObject({ authorization: 'Bearer ' + GITHUB_TOKEN });
  for (const location of ['https://evil.example/repositories/12345/pulls/7/files?per_page=100&page=1', 'https://api.github.com/repositories/12345/pulls/8/files?per_page=100&page=1',
    'https://api.github.com/repos/acme/other/pulls/7/files?per_page=100&page=1', 'https://api.github.com/repositories/12345/pulls/7/files?per_page=100&page=2']) {
    const refused = moved(location);
    await expect(githubListingReader(sharedForgeSecrets({ ...secrets, request: refused } as never), refused)('acme/app', 7, 1), location).rejects.toThrow('GitHub read unavailable');
    expect(refused, location).toHaveBeenCalledTimes(1);
  }
});

it('reads no more of a page than the bound, and refuses a repository name of dots', async () => {
  const { sharedForgeSecrets } = await import('./shared-changes-reader.js');
  const secrets = (request: typeof fetch) => sharedForgeSecrets({ source: { read: async () => Buffer.from(GITHUB_TOKEN) }, bindings: { acme: 'forge' }, request } as never);
  let pulled = 0;
  const endless = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ pull(c) { pulled += 1 << 20; c.enqueue(new Uint8Array(1 << 20).fill(32)); } })));
  await expect(githubListingReader(secrets(endless), endless)('acme/app', 7, 1)).rejects.toThrow('GitHub read unavailable');
  expect(pulled).toBeLessThanOrEqual(LISTING_BYTES_MAX + 2 * (1 << 20));
  const declared = vi.fn<typeof fetch>(async () => new Response('[]', { headers: { 'content-length': String(LISTING_BYTES_MAX + 1) } }));
  await expect(githubListingReader(secrets(declared), declared)('acme/app', 7, 1)).rejects.toThrow('GitHub read unavailable');
  const never = vi.fn<typeof fetch>();
  for (const repo of ['acme/..', 'acme/.']) await expect(githubListingReader(secrets(never), never)(repo, 7, 1), repo).rejects.toThrow();
  expect(never).not.toHaveBeenCalled();
});
