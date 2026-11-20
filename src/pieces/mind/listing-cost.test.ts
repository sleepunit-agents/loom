/** One call of the projects or the activity reader reads the household's sharing facts once.
 *
 * The facts are a read of six whole tables (shared-sharing.ts) and every live selection is read again after
 * a change. As listing people did before them (people-list-cost.test.ts), these readers asked for the facts
 * for every project, agent and conversation row, and a project listing listed all the people once a project. */
import BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { PeopleStore } from '../../backends/people.js';
import { ProjectsStore } from '../../backends/projects.js';
import { FakeClock } from '../../core/clock.js';
import type { Sharing, Viewer } from '../../core/index.js';
import { createActivityReader } from './activity.js';
import type { ActivityRun } from './activity-role.js';
import { peopleReader } from './people.js';
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

it('reads a visible source in two statements when listing either two or ten paused cards', () => {
  const memories = join(home(), 'memories.db');
  const store = new ProjectsStore({ dbPath: memories });
  closes.push(() => store.close());
  const {state, sharing} = facts();
  let directoryReads = 0;
  const reader = createProjectsReader(new FakeClock(now), {
    get agents() { directoryReads++; return [{agent: 'fiction', memories}]; }, sharing,
  });
  closes.push(() => reader.close());
  const measure = () => {
    directoryReads = 0;
    const prepared = vi.spyOn(BetterSqlite3.prototype, 'prepare');
    try {
      const rows = reader.list(viewer);
      return {slugs: rows.map(row => row.slug), statements: prepared.mock.calls.length, directoryReads};
    } finally { prepared.mockRestore(); }
  };
  const slugs: string[] = [];
  for (let i = 0; i < 10; i++) {
    const slug = 'pond-' + i;
    store.write({slug, name: 'Pond ' + i, status: 'paused'});
    slugs.push(slug);
    if (i === 1 || i === 9) expect.soft(measure()).toEqual({slugs: [...slugs], statements: 2, directoryReads: 2});
  }
  state.owns = false;
  expect(measure()).toEqual({slugs: [], statements: 0, directoryReads: 1});
});

it('reads the sharing facts and the people once for a whole listing of projects, and afresh for the next', () => {
  const memories = join(home(), 'memories.db'), store = new ProjectsStore({ dbPath: memories });
  for (let n = 0; n < 9; n++) store.write({ slug: `pond-${n}`, name: `Fictional pond ${n}` });
  store.close();
  const people = new PeopleStore({ dbPath: memories, actor: 'fiction' });
  for (let n = 0; n < 4; n++) people.write({ slug: `friend-${n}`, name: `Fictional friend ${n}`, where: { pond_0: { value: 'Fictional' } } });
  people.close();
  const { state, sharing } = facts();
  // The real people reader, given the same facts as the projects reader, as shared-memory.ts gives them.
  const peopleReaderReal = peopleReader({ agents: [{ agent: 'fiction', memories }], sharing, now: () => now });
  let peopleListed = 0;
  const reader = createProjectsReader(new FakeClock(now), { agents: [{ agent: 'fiction', memories }], sharing,
    people: { list: (v, read) => { peopleListed++; return peopleReaderReal.list(v, read); } } });
  closes.push(() => reader.close(), () => peopleReaderReal.close());
  const listed = reader.list(viewer);
  expect(listed).toHaveLength(9);
  expect(listed[0]!.sections.find(section => section.key === 'people')?.items).toHaveLength(4);
  // Once for the whole listing, the people reader's own reading included.
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
  let timezone='UTC', timezoneReads=0, githubReads=0;
  const reader = createActivityReader(new FakeClock(now), { agents: [{ agent: 'fiction', memories }], sharing, timezone: () => { timezoneReads++; return timezone; }, github: () => { githubReads++; return undefined; }, owner: 'owner',
    conversations: { list: () => ({ available: true, rows: runs }), read: (_viewer, _agent, _kind, key) => runs.find(run => run.key === key), conversation: (_viewer, _agent, id) => runs.find(run => run.conversation.id === id)?.conversation } });
  closes.push(() => reader.close());
  timezoneReads=0;
  const window = reader.window('recent', viewer);
  expect(window?.entries.length).toBeGreaterThanOrEqual(12);
  expect(state.asked).toBe(1);
  expect(timezoneReads).toBe(1);
  expect(githubReads).toBe(1);
  timezone='Pacific/Honolulu';
  const changed=reader.window('recent',viewer);
  expect(changed?.entries[0]?.hour).not.toBe(window?.entries[0]?.hour);
  expect(timezoneReads).toBe(2);
  expect(githubReads).toBe(2);
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
  // A time written without a zone is UTC to the store and this machine's time to the reader. West of UTC the
  // store reads such an episode as hours old; it still sets the deadline the reader gives it.
  const zone = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    db.prepare("DELETE FROM memories WHERE ref IN ('ahead','unreadable')").run();
    expect(reader.nextDeadline()).toBe(now + 90_000);
    const local = new Date(now + 70_000), two = (n: number) => String(n).padStart(2, '0');
    const zoneless = `${local.getFullYear()}-${two(local.getMonth() + 1)}-${two(local.getDate())}T${two(local.getHours())}:${two(local.getMinutes())}:${two(local.getSeconds())}`;
    expect(Date.parse(zoneless)).toBe(now + 70_000); expect(Date.parse(zoneless + 'Z')).toBe(now + 70_000 - 8 * 3600_000);
    add.run('zoneless', 'Zoneless', zoneless, null);
    expect(reader.nextDeadline()).toBe(now + 10_000);
  } finally { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; }
});

it('batches memory summaries and ranked previews by active card and its aliases', () => {
  const memories=join(home(),'memories.db'), store=new ProjectsStore({dbPath:memories});
  const db=new BetterSqlite3(memories);
  db.exec('CREATE TABLE memories(id INTEGER PRIMARY KEY,ref TEXT,category TEXT,title TEXT,content TEXT,created TEXT,updated TEXT,project TEXT,archived INTEGER,expires_at TEXT)');
  const insert=db.prepare("INSERT INTO memories(ref,category,title,content,created,project,archived,expires_at) VALUES(?,'project','Title','Body',?,?,0,?)");
  const {state,sharing}=facts();
  const clock=new FakeClock(now);
  const reader=createProjectsReader(clock,{agents:[{agent:'fiction',memories}],sharing});
  closes.push(()=>db.close(),()=>store.close(),()=>reader.close());
  const deadline=new Date(now+1000).toISOString(), created=new Date(now-5000).toISOString();
  let small:number|undefined;
  for(let i=0;i<10;i++){
    const slug='pond-'+i, alias='alias-'+i;
    store.write({slug,name:slug,links:{aliases:[alias]}});
    insert.run('memory-'+i,created,alias,deadline);
    if(i!==1&&i!==9)continue;
    const prepared=vi.spyOn(BetterSqlite3.prototype,'prepare');
    try{
      const rows=reader.list(viewer);
      expect(rows).toHaveLength(i+1);
      for(const row of rows){
        const section=row.sections.find(s=>s.key==='memories');
        expect(section).toMatchObject({total:1,counts:{project:1},activity:created,expires:now+1000,items:[{ref:'memory-'+row.slug.slice(5)}]});
      }
      const statements=prepared.mock.calls.length;
      small??=statements;
      expect(statements).toBe(small);
      expect(statements).toBeLessThan(10);
    }finally{prepared.mockRestore();}
  }
  state.owns=false;
  expect(reader.list(viewer)).toEqual([]);
  state.owns=true;
  clock.advance(1000);
  for(const row of reader.list(viewer))expect(row.sections.find(s=>s.key==='memories')).toMatchObject({total:0,items:[]});
});
