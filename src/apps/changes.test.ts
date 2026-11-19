import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createDataSchema, type DataDatabase } from '../core/data/database.js';
import { agents, agentAccounts, projects, projectRepositories, tasks, triggers } from '../core/data/schema.js';
import { changeService, watchedChanges } from './changes.js';
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

it('reads a watched pull request of a repository no project lists, keeps only what is watched, and lets its failure stop nothing', async () => {
  const elsewhere = (n: number): Change => ({ ...change(n), id: `github:else/where#${n}`, repo: 'github:else/where', url: `https://github.com/else/where/pull/${n}` });
  const watch = (id: string, change: string, enabled = true) => db.insert(triggers).values({ id, ownerKind: 'agent', owner: 'art', sourceKind: 'pull-request', watches: `change:${change}`, lifespan: 'once',
    targetKind: 'inbox', target: 'wake', toKind: 'agent', to: 'art', note: 'Wake', enabled, state: enabled ? 'standing' : 'fired', createdAt: at, changedAt: at }).run();
  watch('w1', 'github:else/where#7'); watch('w2', 'github:gone/away#1'); watch('w3', 'github:else/where#9', false); watch('w4', 'github:house/loom#1');
  expect([...watchedChanges(db)].sort()).toEqual(['github:else/where#7', 'github:gone/away#1', 'github:house/loom#1']);
  const seen: string[] = [];
  await service.sync(async repo => { seen.push(repo); if (repo === 'gone/away') throw new Error('not readable'); return repo === 'else/where' ? [elsewhere(7), elsewhere(8), elsewhere(9)] : [change()]; }, '2026-11-14T20:05:00.000Z');
  // The projects' repositories first, each watched one once, and a project's repository never twice.
  expect(seen).toEqual(['house/loom', 'else/where', 'gone/away']);
  expect(service.list().map(c => c.id).sort()).toEqual(['github:else/where#7', 'github:house/loom#1']);
  expect(service.syncStatus()).toMatchObject({ failed: false });
  // With the watch over, the repository is read no more.
  db.update(triggers).set({ enabled: false }).run(); seen.length = 0;
  await service.sync(async repo => { seen.push(repo); return [change()]; }, '2026-11-14T20:10:00.000Z');
  expect(seen).toEqual(['house/loom']);
});
