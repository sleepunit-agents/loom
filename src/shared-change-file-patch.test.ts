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
import { capPatch, PATCH_BYTES_MAX, PATCH_CACHE_MS } from './pieces/changes/file-patch.js';

const clean: (() => unknown)[] = [];
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); });
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
  let listing: unknown[] = [{ filename: 'src/pump.ts', patch }, { filename: 'assets/logo.png' }], fail = false;
  const request = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toMatch(/^https:\/\/api\.github\.com\/repos\/acme\/app\/pulls\/7\/files\?per_page=100&page=1$/);
    expect(init?.redirect).toBe('error');
    expect(init?.headers).toMatchObject({ authorization: 'Bearer ' + GITHUB_TOKEN });
    if (fail) return new Response('{}', { status: 502 });
    return Response.json(listing);
  });
  // The poll's own credential path: the holder's bytes, the owner's binding and the same request function.
  const root = sharedRoot({ db, clock, originAllowed: () => true, reportError: () => {},
    changes: { rule: () => undefined, github: { source: { read: async () => Buffer.from(GITHUB_TOKEN) }, bindings: { acme: 'forge' }, request } } });
  clean.push(() => root.close());
  const query = async (path: string, token?: string, id = change) => {
    const response = await root.http.request('/graphql', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify({ query: `{changeFilePatch(change:${JSON.stringify(id)},path:${JSON.stringify(path)}){state patch cut}}` }) });
    return await response.json() as { data?: { changeFilePatch: unknown }; errors?: unknown[] };
  };
  return { db, clock, request, query, list: (rows: unknown[]) => { listing = rows; }, failing: (value: boolean) => { fail = value; } };
}

it('gives a changed file\'s patch to a member who can see the change, and to nobody else', async () => {
  const f = fixture();
  const mine = await f.query('src/pump.ts', alice);
  expect(mine.errors).toBeUndefined();
  expect(mine.data).toEqual({ changeFilePatch: { state: 'patch', patch, cut: false } });
  // Another member, not in the project; another agent; nobody signed in: the same as no such file, and GitHub is not asked.
  expect(f.request).toHaveBeenCalledTimes(1);
  for (const token of [bob, mark]) expect((await f.query('src/pump.ts', token)).data, token).toEqual({ changeFilePatch: null });
  expect((await f.query('src/pump.ts')).data?.changeFilePatch ?? null).toBeNull();
  expect((await f.query('src/pump.ts', bob, 'github:acme/app#8')).data).toEqual({ changeFilePatch: null });
  expect(f.request).toHaveBeenCalledTimes(1);
});

it('reads only a path that is one of the change\'s files', async () => {
  const f = fixture();
  for (const path of ['src/other.ts', '../etc/passwd', '', 'SRC/PUMP.TS']) expect((await f.query(path, alice)).data, path).toEqual({ changeFilePatch: null });
  expect((await f.query('src/pump.ts', alice, 'github:acme/app#8')).data).toEqual({ changeFilePatch: null });
  expect(f.request).not.toHaveBeenCalled();
});

it('cuts a patch over 200 KB at its last whole line, and says so', async () => {
  const f = fixture();
  const long = '@@ -1,9000 +1,9000 @@\n' + Array.from({ length: 9000 }, (_, i) => `+line ${i} ${'x'.repeat(20)}`).join('\n');
  expect(Buffer.byteLength(long)).toBeGreaterThan(PATCH_BYTES_MAX);
  f.list([{ filename: 'src/pump.ts', patch: long }]);
  const answer = (await f.query('src/pump.ts', alice)).data?.changeFilePatch as { state: string; patch: string; cut: boolean };
  expect(answer.state).toBe('patch');
  expect(answer.cut).toBe(true);
  expect(Buffer.byteLength(answer.patch)).toBeLessThanOrEqual(PATCH_BYTES_MAX);
  expect(long.startsWith(answer.patch + '\n')).toBe(true);
  // A character split by the cut is left out whole, and a short patch is never cut.
  const wide = capPatch('é'.repeat(PATCH_BYTES_MAX));
  expect(wide.cut).toBe(true);
  expect(wide.patch).toBe('é'.repeat(PATCH_BYTES_MAX / 2));
  expect(capPatch(patch)).toEqual({ patch, cut: false });
});

it('says there is no patch where GitHub gives none, or no longer lists the file', async () => {
  const f = fixture();
  expect((await f.query('assets/logo.png', alice)).data).toEqual({ changeFilePatch: { state: 'none', patch: null, cut: false } });
  f.list([]);
  f.db.update(s.changes).set({ headCommit: 'b'.repeat(40) }).where(eq(s.changes.id, change)).run();
  expect((await f.query('src/pump.ts', alice)).data).toEqual({ changeFilePatch: { state: 'none', patch: null, cut: false } });
});

it('keeps an answer for the same head commit a short while, and asks again for a new head', async () => {
  const f = fixture();
  await f.query('src/pump.ts', alice);
  await f.query('src/pump.ts', alice);
  expect(f.request).toHaveBeenCalledTimes(1);
  // A new push: the stored head commit moves, and the next read asks GitHub again.
  f.list([{ filename: 'src/pump.ts', patch: patch + '\n+pushed' }]);
  f.db.update(s.changes).set({ headCommit: 'c'.repeat(40) }).where(eq(s.changes.id, change)).run();
  expect((await f.query('src/pump.ts', alice)).data).toEqual({ changeFilePatch: { state: 'patch', patch: patch + '\n+pushed', cut: false } });
  expect(f.request).toHaveBeenCalledTimes(2);
  // After its time to live, the same head is asked again too.
  f.clock.advance(PATCH_CACHE_MS - 1);
  await f.query('src/pump.ts', alice);
  expect(f.request).toHaveBeenCalledTimes(2);
  f.clock.advance(1);
  await f.query('src/pump.ts', alice);
  expect(f.request).toHaveBeenCalledTimes(3);
});

it('says GitHub is unavailable when it cannot be read, keeps no such answer, and never shows the credential', async () => {
  const f = fixture();
  f.failing(true);
  expect((await f.query('src/pump.ts', alice)).data).toEqual({ changeFilePatch: { state: 'unavailable', patch: null, cut: false } });
  f.failing(false);
  f.list([{ filename: 'src/pump.ts', patch: '+token = "' + GITHUB_TOKEN + '"' }]);
  expect((await f.query('src/pump.ts', alice)).data).toEqual({ changeFilePatch: { state: 'patch', patch: '+token = "[redacted]"', cut: false } });
  expect(f.request).toHaveBeenCalledTimes(2);
});
