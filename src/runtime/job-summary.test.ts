import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { graphql, GraphQLObjectType, GraphQLSchema } from 'graphql/index.js';
import { createDataSchema } from '../core/data/database.js';
import type { QueryVisibility } from '../core/data/queries.js';
import { agents, boxes, jobs, members } from '../core/data/schema.js';
import { JobSummaries, jobSummaryFields } from './job-summary.js';

const clients: Database.Database[] = [];
afterEach(() => { for (const c of clients.splice(0)) c.close(); });
function fixture() {
  const client = new Database(':memory:'); clients.push(client);
  const at = '2026-11-14T18:00:00.000Z', db = createDataSchema(client, () => at);
  db.insert(members).values({ id: 'owner', role: 'owner', joinedAt: at }).run();
  for (const id of ['art', 'mark']) db.insert(agents).values({ id, about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(boxes).values({ id: 'attic', name: 'Attic', owner: 'owner', enrolledAt: at,
    sameMachineAsLoom: true, hostsAny: true, reportOnly: false, alwaysOn: false }).run();
  const add = (id: string, state: typeof jobs.$inferInsert.state, extra: Partial<typeof jobs.$inferInsert> = {}) => db.insert(jobs).values({
    id, agent: 'art', state, title: id, brief: 'private instructions', model: 'primary',
    startedByKind: 'agent', startedBy: 'art', houseRepository: 'repo', houseFile: 'Housefile', houseBranch: 'next', queuedAt: at, ...extra,
  }).run();
  let policy: QueryVisibility = { jobs: () => sql`true` };
  const summaries = new JobSummaries(db, () => policy);
  const schema = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: jobSummaryFields(summaries) }) });
  const read = (agent = 'art') => graphql({ schema, source: 'query($agent:String!){currentJobs(agent:$agent){id agent title state box queuedAt}}', variableValues: { agent } });
  return { db, client, at, add, summaries, read, policy: (value: QueryVisibility) => { policy = value; } };
}
it('returns every current state in queue order with stable ties and excludes terminal jobs and other agents in SQL', async () => {
  const f = fixture();
  f.add('z', 'queued'); f.add('a', 'running', { box: 'attic' }); f.add('b', 'starting');
  f.add('old', 'waiting', { queuedAt: '2026-11-14T17:00:00.000Z' });
  for (const state of ['done', 'failed', 'stopped', 'lost'] as const) f.add(state, state);
  f.add('mark-job', 'running', { agent: 'mark' });
  expect(f.summaries.current('art').map(j => j.id)).toEqual(['old', 'a', 'b', 'z']);
  expect(await f.read()).toEqual({ data: { currentJobs: [
    { id: 'old', agent: 'art', title: 'old', state: 'waiting', box: null, queuedAt: '2026-11-14T17:00:00.000Z' },
    { id: 'a', agent: 'art', title: 'a', state: 'running', box: 'attic', queuedAt: f.at },
    { id: 'b', agent: 'art', title: 'b', state: 'starting', box: null, queuedAt: f.at },
    { id: 'z', agent: 'art', title: 'z', state: 'queued', box: null, queuedAt: f.at },
  ] } });
  expect(f.summaries.current('unknown')).toEqual([]);
});
it('applies current caller policy on every read and observes lifecycle changes on a retained schema', async () => {
  const f = fixture(); f.add('shared', 'running'); f.add('private', 'queued', { member: 'owner' });
  f.policy({ jobs: fields => sql`${fields.member} is null` });
  expect((await f.read()).data?.currentJobs).toHaveLength(1);
  expect(f.summaries.current('art').map(j => j.id)).toEqual(['shared']);
  f.policy({ jobs: () => sql`false` });
  expect(await f.read()).toEqual({ data: { currentJobs: [] } });
  f.policy({ jobs: () => sql`true` });
  f.db.update(jobs).set({ state: 'done' }).where(eq(jobs.id, 'shared')).run();
  expect(f.summaries.current('art').map(j => j.id)).toEqual(['private']);
});
it('fails closed for absent or invalid policies and never offers private execution fields', async () => {
  const f = fixture(); f.add('work', 'queued');
  f.policy({}); expect(() => f.summaries.current('art')).toThrow('SQL visibility required');
  expect((await f.read()).errors?.[0].message).toBe('SQL visibility required for jobs');
  f.policy({ jobs: () => undefined as never });
  expect(() => f.summaries.current('art')).toThrow('SQL visibility required');
  f.policy({ jobs: () => sql`true` });
  expect(Object.keys(f.summaries.current('art')[0])).toEqual(['id', 'agent', 'title', 'state', 'box', 'queuedAt']);
});

it('constrains the single SQL read before fetching rows and never reads machine metadata', async () => {
  const f = fixture(); f.add('shared', 'running', { box: 'attic' }); f.add('private', 'queued', { member: 'owner' });
  f.policy({ jobs: fields => sql`${fields.member} is null` });
  const prepared = vi.spyOn(f.client, 'prepare');
  try {
    const result = await f.read();
    expect(result.errors).toBeUndefined();
    expect(result.data?.currentJobs).toHaveLength(1);
    const statements = prepared.mock.calls.map(([query]) => query);
    // One jobs read: no later JS filtering, per-row lookups or box metadata.
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/from "jobs"(?: "jobs")? where \(.*"jobs"\."member" is null/);
    expect(statements[0]).toContain('"jobs"."agent" = ?');
    expect(statements[0]).toContain('"jobs"."state" in (?, ?, ?, ?)');
    expect(statements[0]).not.toMatch(/\b(?:join|boxes)\b/i);
    expect(statements[0]).not.toMatch(/"(?:brief|log_tail|account|house_repository|build)"/);
  } finally { prepared.mockRestore(); }
});

it('keeps one current-job statement as visible rows grow from two to ten',()=>{
 const f=fixture();
 for(let n=0;n<2;n++)f.add('job-'+n,'queued');
 const prepared=vi.spyOn(f.client,'prepare');
 try{
  expect(f.summaries.current('art')).toHaveLength(2);expect(prepared).toHaveBeenCalledTimes(1);prepared.mockClear();
  for(let n=2;n<10;n++)f.add('job-'+n,'queued');prepared.mockClear();
  expect(f.summaries.current('art')).toHaveLength(10);expect(prepared).toHaveBeenCalledTimes(1);
 }finally{prepared.mockRestore();}
});
