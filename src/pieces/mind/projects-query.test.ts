import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphQLObjectType, GraphQLSchema, graphql } from 'graphql/index.js';
import { sql } from 'drizzle-orm';
import Database from 'better-sqlite3';
import { createFoundation } from '../../core/app.js';
import { FakeClock, type Sharing, type Viewer } from '../../core/index.js';
import { createDataSchema } from '../../core/data/database.js';
import { dataQueries } from '../../core/data/queries.js';
import { ProjectsStore } from '../../backends/projects.js';
import { installMindProjects } from './projects.js';
import { mindRole, type Mind } from './role.js';
import { projectsQueryFields } from './projects-query.js';
import type { ProjectSectionRole } from './projects-roles.js';

const closes: Array<() => void> = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); });
function fixture(roles: { notes?: ProjectSectionRole; conversations?: ProjectSectionRole; changes?: ProjectSectionRole } = {}) {
 const home = mkdtempSync(join(tmpdir(), 'projects-query-')); closes.push(() => rmSync(home, { recursive: true, force: true }));
 const clock = new FakeClock(Date.parse('2026-11-14T18:00:00Z'));
 const app = createFoundation({ home, clock }); closes.push(() => app.close());
 const shared = new Database(':memory:'); closes.push(() => shared.close()); createDataSchema(shared);
 const store = new ProjectsStore({ dbPath: join(home, 'fiction.db'), now: () => clock.now() }); closes.push(() => store.close());
 const other = new ProjectsStore({ dbPath: join(home, 'other.db') }); closes.push(() => other.close());
 let sharing: Sharing = { members: { owner: { owner: true, agents: [] }, member: { owner: false, agents: ['fiction'] }, peer: { owner: false, agents: [] } }, projects: { team: { members: ['peer'], agents: ['fiction'] } }, services: {} };
 const database = new Database(join(home, 'fiction.db')); closes.push(() => database.close());
 const missing = join(home, 'absent.db');
 const installed = installMindProjects(app.operations, app.live, { agents: [{ agent: 'fiction', memories: join(home, 'fiction.db') }, { agent: 'other', memories: join(home, 'other.db') }, { agent: 'missing', memories: missing }], sharing: () => sharing, ...roles });
 closes.push(() => installed.close());
 const generated = dataQueries(shared, { tables: ['tasks'], visibility: { tasks: () => sql`true` } });
 const schema = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: { ...generated.getQueryType()!.toConfig().fields, ...projectsQueryFields(mindRole(app.operations)) } }) });
 const query = (source: string, viewer: Viewer = { kind: 'member', id: 'owner' }) => graphql({ schema, source, contextValue: { viewer } });
 return { query, store, other, database, clock, missing, generated, schema, sharing, replaceSharing(next: Sharing) { sharing = next; } };
}

it('composes generated fields with typed complete cards, canonical aliases, sections and destinations', async () => {
 const f = fixture({ notes: { read: () => ({ available: true, items: [{ title: 'Fictional note', href: '/note/fiction', who: ['friend'], new: true }], total: 1 }) }, conversations: { read: () => ({ available: true, conversationIds: ['cv-123456abcdef'], items: [{ title: 'Conversation', ref: 'cv-123456abcdef', href: '/conversation/cv-123456abcdef' }] }) }, changes: { read: () => ({ available: true, groups: [{ title: 'Waiting', waiting: true, items: [{ title: 'PR', ref: 'owner/repo#1', status: 'CI red', href: '/change/1' }] }] }) } });
 f.store.write({ slug: 'pond', name: 'Fictional pond', summary: 'A summary', goal: 'A goal', where: { hose: { value: '25 mm', verified_at: '2026-11-13T18:00:00Z', stale_after_days: 30, source: 'Fictional source' } }, links: { aliases: ['on-pond'], notes: ['pond/research'], epic: 't-1', repos: ['owner/repo'], venues: ['fiction'] } });
 expect((await graphql({ schema: f.generated, source: '{ memoryProjects { id } }' })).errors?.[0].message).toContain('Cannot query field');
 const result = await f.query(`{ tasks { id } memoryProject(id:"fiction:on-pond") {
  id agent now card { slug name status summary goal where { key value verified_at stale_after_days source } links { aliases notes epic repos venues } }
  sections { key available error total counts { category total } conversationIds items { title href who new } groups { title waiting items { title ref href status } } }
  waiting { title href } people changes { open failing running } fields { key value state } spark
 } }`);
 expect(result.errors).toBeUndefined();
 expect(result.data).toMatchObject({ tasks: [], memoryProject: { id: 'fiction:pond', agent: 'fiction', now: f.clock.now(), card: { slug: 'pond', name: 'Fictional pond', status: 'active', summary: 'A summary', goal: 'A goal', where: [{ key: 'hose', value: '25 mm', verified_at: '2026-11-13T18:00:00Z', stale_after_days: 30, source: 'Fictional source' }], links: { aliases: ['on-pond'], notes: ['pond/research'], epic: 't-1', repos: ['owner/repo'], venues: ['fiction'] } }, sections: expect.arrayContaining([{ key: 'notes', available: true, error: null, total: 1, counts: [], conversationIds: null, items: [{ title: 'Fictional note', href: '/note/fiction', who: ['friend'], new: true }], groups: [] }, expect.objectContaining({ key: 'conversations', conversationIds: ['cv-123456abcdef'] })]), waiting: [{ title: 'PR', href: '/change/1' }], people: ['fiction', 'friend'], changes: { open: 1, failing: 1, running: 0 }, fields: [{ key: 'hose', value: '25 mm', state: 'checked 1 day ago' }], spark: [0, 0, 0, 0, 0, 0, 0] } });
});

it('uses the authenticated viewer and current sharing; a shared project never opens private cards', async () => {
 const f = fixture(); f.store.write({ slug: 'pond', name: 'Private' }); f.other.write({ slug: 'pond', name: 'Other private' });
 const query = '{ memoryProjects { id } memoryProject(id:"fiction:pond") { name } memoryProjectMemory(id:"fiction:secret") { content } }';
 expect(await f.query(query, { kind: 'member', id: 'peer' })).toEqual({ data: { memoryProjects: [], memoryProject: null, memoryProjectMemory: null } });
 expect(await f.query('{ memoryProjects { id } }', { kind: 'agent', id: 'fiction' })).toEqual({ data: { memoryProjects: [{ id: 'fiction:pond' }] } });
 expect(await f.query('{ memoryProjects { id } }', { kind: 'member', id: 'member' })).toEqual({ data: { memoryProjects: [{ id: 'fiction:pond' }] } });
 f.replaceSharing({ ...f.sharing, members: { ...f.sharing.members, member: { owner: false, agents: [] } } });
 expect(await f.query(query, { kind: 'member', id: 'member' })).toEqual({ data: { memoryProjects: [], memoryProject: null, memoryProjectMemory: null } });
 expect(await graphql({ schema: f.schema, source: query })).toEqual({ data: { memoryProjects: [], memoryProject: null, memoryProjectMemory: null } });
 expect((await f.query('{ memoryProjects(viewer:"owner") { id } }')).errors).toBeDefined();
});

it('keeps previews separate from full memory stories, reads current commits and expires at the exact deadline', async () => {
 const f = fixture(); f.store.write({ slug: 'pond', name: 'Before' });
 const content = 'Full fictional story '.repeat(30);
 f.database.exec('CREATE TABLE memories(id INTEGER PRIMARY KEY,ref TEXT,category TEXT,title TEXT,content TEXT,created TEXT,updated TEXT,project TEXT,archived INTEGER,expires_at TEXT,salience REAL)');
 const deadline = f.clock.now() + 1000;
 f.database.prepare('INSERT INTO memories VALUES(1,?,?,?,?,?,NULL,?,0,?,1)').run('m-story', 'project', 'Story', content, '2026-11-14T17:00:00Z', 'pond', new Date(deadline).toISOString());
 const query = '{ memoryProject(id:"fiction:pond") { name sections { key total counts { category total } items { title ref } } } memoryProjectMemory(id:"fiction:m-story") { ref content expires } }';
 const first = await f.query(query); expect(first.errors).toBeUndefined();
 expect(first.data).toMatchObject({ memoryProject: { name: 'Before', sections: expect.arrayContaining([expect.objectContaining({ key: 'memories', total: 1, counts: [{ category: 'project', total: 1 }], items: [{ title: expect.any(String), ref: 'm-story' }] })]) }, memoryProjectMemory: { ref: 'm-story', content, expires: deadline } });
 const sections = (first.data!.memoryProject as { sections: Array<{ key: string; items: Array<{ title: string }> }> }).sections;
 expect(sections.find(s => s.key === 'memories')!.items[0].title.length).toBe(200);
 f.store.write({ slug: 'pond', name: 'After' }); f.clock.advance(1000);
 expect((await f.query(query)).data).toMatchObject({ memoryProject: { name: 'After', sections: expect.arrayContaining([expect.objectContaining({ key: 'memories', total: 0, items: [] })]) }, memoryProjectMemory: null });
});

it('leaves missing sources absent, keeps quiet index cheap and preserves per-section failure isolation', async () => {
 let calls = 0;
 const f = fixture({ notes: { read() { calls++; throw Error('PRIVATE SQL /private/path'); } } });
 f.store.write({ slug: 'quiet', name: 'Quiet', status: 'paused' });
 expect(await f.query('{ memoryProjects { sections { key } } memoryProject(id:"missing:pond") { id } invalid: memoryProject(id:"invalid") { id } }')).toEqual({ data: { memoryProjects: [{ sections: [] }], memoryProject: null, invalid: null } });
 expect(calls).toBe(0); expect(existsSync(f.missing)).toBe(false);
 const result = await f.query('{ memoryProject(id:"fiction:quiet") { sections { key available error } } }');
 expect(result.errors).toBeUndefined();
 expect(result.data).toMatchObject({ memoryProject: { sections: expect.arrayContaining([{ key: 'notes', available: true, error: "Notes couldn't answer" }, { key: 'tasks', available: false, error: null }]) } });
 expect(calls).toBe(1); expect(JSON.stringify(result)).not.toContain('PRIVATE');
});

it('forwards the exact viewer and sanitizes failed or thrown role errors', async () => {
 const viewer: Viewer = { kind: 'agent', id: 'fiction' }; let seen: Viewer | undefined;
 const role: Mind = { call(v) { seen = v; throw Error('PRIVATE SOURCE'); } };
 const schema = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: projectsQueryFields(role) }) });
 const query = () => graphql({ schema, source: '{ memoryProjects { id } }', contextValue: { viewer } });
 const result = await query(); expect(seen).toBe(viewer); expect(result.data).toEqual({ memoryProjects: null }); expect(result.errors?.[0].message).toBe('Projects are unavailable'); expect(JSON.stringify(result)).not.toContain('PRIVATE');
 role.call = () => ({ ok: false, code: 'unavailable', message: 'PRIVATE SQL' });
 expect((await query()).errors?.[0].message).toBe('Projects are unavailable');
});
