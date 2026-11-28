import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createDataSchema, type DataDatabase } from '../core/data/database.js';
import { eq } from 'drizzle-orm';
import { agents, agentAccounts, changeFiles, projects, projectRepositories, tasks } from '../core/data/schema.js';
import { changeService } from './changes.js';
import type { Change, Rule } from '../pieces/changes/model.js';

let db: DataDatabase;
let client: Database.Database, service: ReturnType<typeof changeService>, rule: Rule | undefined;
const at = '2026-11-14T20:00:00.000Z';
function change(n = 1): Change {
  return { id: `github:house/loom#${n}`, repo: 'github:house/loom', number: n, page: '', title: 'Finish t-1', body: 'Also t-999', url: `https://github.com/house/loom/pull/${n}`,
    state: 'open', draft: false, author: { login: 'ART-E-FISH' }, created: at, updated: at, closed: null,
    head: { ref: 'task/t-2-pond', id: 'a'.repeat(40) }, base: { ref: 'main' }, checks: { state: 'passing', failing: [], running: [], total: 2 },
    review: { state: 'approved', by: [] }, mergeable: 'yes', conflicts: false, people: [{ login: 'art-e-fish', role: 'reviewer' }, { login: 'art-e-fish', role: 'commenter' }] };
}
beforeEach(() => {
  client = new Database(':memory:'); db = createDataSchema(client, () => at);
  db.insert(agents).values({ id: 'art', about: '', markBg: '#fff', markFg: '#000', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(agentAccounts).values({ agent: 'art', service: 'github', login: 'art-e-fish' }).run();
  db.insert(projects).values({ id: 'loom', name: 'Loom' }).run();
  db.insert(projectRepositories).values({ project: 'loom', repository: 'House/Loom' }).run();
  for (const n of [1, 2]) db.insert(tasks).values({ id: `t-${n}`, title: `Task ${n}`, ownerKind: 'household', createdByKind: 'agent', createdBy: 'art', createdAt: at, changedAt: at }).run();
  rule = undefined;
  service = changeService(db, () => rule, () => at);
});
afterEach(() => client.close());

it('files copies by repository and GitHub login and links only existing tasks named by the PR', () => {
  service.put(change());
  expect(service.get(change().id)).toMatchObject({ project: 'loom', agent: 'art', waitingOn: 'you', tasks: [{ id: 't-1' }, { id: 't-2' }] });
  expect(service.get(change().id).people).toHaveLength(3);
  const updated = change(); updated.title = 'No task'; updated.head.ref = 'plain'; updated.body = ''; updated.people = [];
  service.put(updated);
  expect(service.get(updated.id).tasks).toEqual([]);
  expect(service.get(updated.id).people).toHaveLength(1);
  updated.author.login = 'someone';
  expect(service.put(updated)).toMatchObject({ agent: null, waitingOn: 'author' });
});

it('shows pending checks and every waiting group in the page’s order', () => {
  const a = change(1); a.state = 'merged'; a.closed = at; service.put(a);
  const b = change(2); b.checks = { state: 'running', failing: [], running: ['Tests'], total: 1 }; service.put(b);
  const c = change(3); service.put(c);
  rule = { tier: 'do' }; const d = change(4); service.put(d);
  const e = change(5); e.review.state = 'required'; service.put(e);
  const f = change(6); f.checks = { state: 'failing', failing: ['Lint'], running: ['Tests'], total: 2 }; service.put(f);
  expect(service.list().map(c => c.waitingOn)).toEqual(['you', 'agent', 'ci', 'reviewer', 'author', 'done']);
  expect(service.get(b.id).checksDetail).toEqual([{ change: b.id, name: 'Tests', state: 'running' }]);
  expect(service.get(f.id).checksDetail).toHaveLength(2);
});

it('reads configured repositories once, caches complete snapshots and reports failure without losing the previous copy', async () => {
  const seen: string[] = [];
  await service.sync(async repo => { seen.push(repo); return [change()]; }, '2026-11-14T20:05:00.000Z');
  expect(seen).toEqual(['house/loom']);
  expect(service.syncStatus()).toMatchObject({ readAt: at, failed: false });
  await expect(service.sync(async () => { throw new Error('provider unavailable'); }, '2026-11-14T20:10:00.000Z')).rejects.toThrow('GitHub read unavailable');
  expect(service.syncStatus()).toMatchObject({ readAt: at, failed: true, nextAt: '2026-11-14T20:10:00.000Z' });
  expect(service.list()).toHaveLength(1);
  const bad = change(2); bad.created = 'invalid';
  await expect(service.sync(async () => [change(3), bad], '2026-11-14T20:15:00.000Z')).rejects.toThrow();
  expect(service.list().map(c => c.number)).toEqual([1]);
});

it('evaluates merge rules for the exact current head and rejects a mismatched snapshot', () => {
  const c = change(); let target = '';
  service = changeService(db, value => { target = value; return rule; }, () => at);
  expect(() => service.put({ ...c, id: 'github:other/repo#1' })).toThrow('identity');
  expect(service.list()).toEqual([]);
  rule = { tier: 'ask', approval: { state: 'allowed' } };
  expect(service.put(c).waitingOn).toBe('agent');
  expect(target).toBe(`${c.id}@${'a'.repeat(40)}`);
  rule = { tier: 'ask' };
  c.head.id = 'b'.repeat(40);
  expect(service.put(c).waitingOn).toBe('you');
  expect(target).toBe(`${c.id}@${'b'.repeat(40)}`);
});

it('refuses ambiguous account attribution instead of assigning a copy to the wrong agent', () => {
  db.insert(agents).values({ id: 'mark', about: '', markBg: '#fff', markFg: '#000', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(agentAccounts).values({ agent: 'mark', service: 'github', login: 'ART-E-FISH' }).run();
  expect(() => service.put(change())).toThrow('more than one agent');
  expect(service.list()).toEqual([]);
});

it('replaces only complete batches of submitted forge reviews, preserving distinct revisions on retry',()=>{
 const input=change(), report={id:'R1',login:'fixture',submittedAt:at,state:'CHANGES_REQUESTED' as const,headCommit:'a'.repeat(40),body:'First report',url:input.url+'#pullrequestreview-1'};
 const next={...report,id:'R2',state:'APPROVED' as const,headCommit:'b'.repeat(40),body:'Fixed',url:input.url+'#pullrequestreview-2'};
 const read=()=>client.prepare('select id,body from github_reviews order by id').all();
 for(let i=0;i<2;i++)service.put({...input,submittedReviews:[report,next]});
 expect(read()).toEqual([{id:'R1',body:'First report'},{id:'R2',body:'Fixed'}]);
 service.put(input);expect(read()).toHaveLength(2);
 expect(()=>service.put({...input,submittedReviews:[next,next]})).toThrow();
 expect(read()).toHaveLength(2);
 service.put({...input,submittedReviews:[]});
 expect(read()).toEqual([]);
});

it('keeps the files a read lists, replacing them on the next read that lists them and keeping them on one that does not', () => {
  const stored = () => db.select().from(changeFiles).where(eq(changeFiles.change, change().id)).all().sort((a, b) => a.path.localeCompare(b.path));
  service.put({ ...change(), files: [{ path: 'src/a.ts', additions: 4, deletions: 1 }, { path: 'src/b.ts', additions: 0, deletions: 7 }] });
  expect(stored()).toEqual([{ change: change().id, path: 'src/a.ts', additions: 4, deletions: 1 }, { change: change().id, path: 'src/b.ts', additions: 0, deletions: 7 }]);
  service.put(change());
  expect(stored()).toHaveLength(2);
  service.put({ ...change(), files: [{ path: 'src/c.ts', additions: 2, deletions: 2 }] });
  expect(stored()).toEqual([{ change: change().id, path: 'src/c.ts', additions: 2, deletions: 2 }]);
  service.put({ ...change(), files: [] });
  expect(stored()).toEqual([]);
});
