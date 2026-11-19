/** One call of the projects or the activity reader reads the household's sharing facts once.
 *
 * The facts are a read of six whole tables (shared-sharing.ts) and every live selection is read again after
 * a change. As listing people did before them (people-list-cost.test.ts), these readers asked for the facts
 * for every project, agent and conversation row, and a project listing listed all the people once a project. */
import BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ProjectsStore } from '../../backends/projects.js';
import { FakeClock } from '../../core/clock.js';
import type { Sharing, Viewer } from '../../core/index.js';
import { createActivityReader } from './activity.js';
import type { ActivityRun } from './activity-role.js';
import { createProjectsReader } from './projects.js';

const homes: string[] = [], closes: Array<() => void> = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const home = () => { const made = mkdtempSync(join(tmpdir(), 'loom-listing-cost-')); homes.push(made); return made; };
const viewer: Viewer = { kind: 'member', id: 'owner' }, now = Date.parse('2026-11-19T18:00:00Z');
function facts() {
  const state = { asked: 0, owns: true };
  const sharing = (): Sharing => { state.asked++; return { members: { owner: { owner: false, agents: state.owns ? ['fiction'] : [] } }, projects: {}, agents: ['fiction'] }; };
  return { state, sharing };
}

it('reads the sharing facts and the people once for a whole listing of projects, and afresh for the next', () => {
  const memories = join(home(), 'memories.db'), store = new ProjectsStore({ dbPath: memories });
  for (let n = 0; n < 9; n++) store.write({ slug: `pond-${n}`, name: `Fictional pond ${n}` });
  store.close();
  const { state, sharing } = facts();
  let peopleListed = 0;
  const reader = createProjectsReader(new FakeClock(now), { agents: [{ agent: 'fiction', memories }], sharing, people: { list: () => { peopleListed++; return []; } } });
  closes.push(() => reader.close());
  const listed = reader.list(viewer);
  expect(listed).toHaveLength(9);
  expect(listed[0]!.sections.map(section => section.key)).toContain('people');
  expect(state.asked).toBe(1); expect(peopleListed).toBe(1);
  state.asked = 0;
  expect(reader.read('fiction:pond-0', viewer)?.name).toBe('Fictional pond 0'); expect(state.asked).toBe(1);
  state.asked = 0;
  expect(reader.access(viewer)).toMatchObject({ allowed: true, agents: ['fiction'] }); expect(state.asked).toBe(1);
  // Nothing is kept past a call: a change of who has the agent shows in the very next one.
  state.owns = false;
  expect(reader.list(viewer)).toEqual([]);
  expect(reader.read('fiction:pond-0', viewer)).toBeUndefined();
  expect(reader.readIndex('fiction:pond-0', viewer)).toBeUndefined();
  expect(reader.access(viewer)).toMatchObject({ allowed: false, agents: [] });
  state.owns = true;
  expect(reader.list(viewer)).toHaveLength(9);
});

it('reads the sharing facts once for a whole window of activity, and afresh for the next', () => {
  const memories = join(home(), 'memories.db'), db = new BetterSqlite3(memories);
  db.exec('CREATE TABLE memories(ref TEXT PRIMARY KEY,title TEXT,content TEXT,created TEXT,project TEXT,metadata TEXT,expires_at TEXT,category TEXT,archived INTEGER)');
  const add = db.prepare(`INSERT INTO memories VALUES(?,?,'A complete fictional story.',?,NULL,'{"where":"terminal"}',?,'episode',0)`);
  for (let n = 0; n < 12; n++) add.run(`episode-${n}`, `Episode ${n}`, new Date(now - (n + 1) * 3600_000).toISOString(), null);
  db.close();
  const runs: ActivityRun[] = Array.from({ length: 12 }, (_, n) => ({ kind: 'digest', key: `run-${n}`, at: new Date(now - (n + 1) * 1800_000).toISOString(),
    conversation: { id: `cv-${String(n).padStart(12, '0')}`, agent: 'fiction', venue: 'terminal', place: 'terminal', label: `Fictional run ${n}`, people: ['owner'] },
    summary: 'Did a fictional thing.', asked: [], decided: [], tasks: [], links: [], more: [] }));
  const { state, sharing } = facts();
  const reader = createActivityReader(new FakeClock(now), { agents: [{ agent: 'fiction', memories }], sharing, timezone: 'UTC', owner: 'owner',
    conversations: { list: () => ({ available: true, rows: runs }), read: (_viewer, _agent, _kind, key) => runs.find(run => run.key === key), conversation: (_viewer, _agent, id) => runs.find(run => run.conversation.id === id)?.conversation } });
  closes.push(() => reader.close());
  const window = reader.window('recent', viewer);
  expect(window?.entries.length).toBeGreaterThanOrEqual(12);
  expect(state.asked).toBe(1);
  state.asked = 0;
  expect(reader.read(window!.entries[0]!.id, viewer)).toMatchObject({ agent: 'fiction' }); expect(state.asked).toBe(1);
  state.asked = 0;
  expect(reader.access(viewer)).toMatchObject({ allowed: true }); expect(state.asked).toBe(1);
  state.owns = false;
  expect(reader.window('recent', viewer)).toBeUndefined();
  expect(reader.read(window!.entries[0]!.id, viewer)).toBeUndefined();
  expect(reader.allowed(viewer)).toBe(false);
  state.owns = true;
  expect(reader.window('recent', viewer)?.entries.length).toBe(window!.entries.length);
});

it('finds the next activity deadline without carrying every old episode out of the store', () => {
  const memories = join(home(), 'memories.db'), db = new BetterSqlite3(memories);
  db.exec('CREATE TABLE memories(ref TEXT PRIMARY KEY,title TEXT,content TEXT,created TEXT,project TEXT,metadata TEXT,expires_at TEXT,category TEXT,archived INTEGER)');
  const add = db.prepare(`INSERT INTO memories VALUES(?,?,'Fictional.',?,NULL,'{}',?,'episode',0)`);
  const midnight = Date.parse('2026-11-20T00:00:00Z');
  const reader = createActivityReader(new FakeClock(now), { agents: [{ agent: 'fiction', memories }], sharing: facts().sharing, timezone: 'UTC' });
  closes.push(() => { reader.close(); db.close(); });
  for (let n = 0; n < 50; n++) add.run(`old-${n}`, 'Old', new Date(now - (n + 1) * 86400_000).toISOString(), null);
  add.run('ended', 'Ended', new Date(now - 86400_000).toISOString(), new Date(now - 1000).toISOString());
  expect(reader.nextDeadline()).toBe(midnight);
  // An old episode that ends, and one whose writer's clock runs ahead, still set the deadline.
  add.run('ending', 'Ending', new Date(now - 30 * 86400_000).toISOString(), new Date(now + 90_000).toISOString());
  expect(reader.nextDeadline()).toBe(now + 90_000);
  add.run('ahead', 'Ahead', new Date(now + 80_000).toISOString(), null);
  expect(reader.nextDeadline()).toBe(now + 20_000);
  add.run('unreadable', 'Unreadable', 'not a time', null);
  expect(reader.nextDeadline()).toBe(now + 20_000);
});
