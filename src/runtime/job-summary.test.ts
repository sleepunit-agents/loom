import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { graphql, GraphQLObjectType, GraphQLSchema } from 'graphql/index.js';
import { createDataSchema } from '../core/data/database.js';
import type { QueryVisibility } from '../core/data/queries.js';
import { agents, boxes, jobs, members, jobUsage, conversations, inbox, inboxRefs } from '../core/data/schema.js';
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
  f.add('old', 'running', { queuedAt: '2026-11-14T17:00:00.000Z' });
  for (const state of ['done', 'failed', 'stopped', 'lost'] as const) f.add(state, state);
  f.add('mark-job', 'running', { agent: 'mark' });
  expect(f.summaries.current('art').map(j => j.id)).toEqual(['old', 'a', 'b', 'z']);
  expect(await f.read()).toEqual({ data: { currentJobs: [
    { id: 'old', agent: 'art', title: 'old', state: 'running', box: null, queuedAt: '2026-11-14T17:00:00.000Z' },
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
    expect(statements[0]).toMatch(/from "jobs" where \(.*"jobs"\."member" is null/);
    expect(statements[0]).toContain('"jobs"."agent" = ?');
    expect(statements[0]).toContain('"jobs"."state" in (?, ?, ?)');
    expect(statements[0]).not.toMatch(/\b(?:join|boxes)\b/i);
    expect(statements[0]).not.toMatch(/"(?:brief|log_tail|account|house_repository|build)"/);
  } finally { prepared.mockRestore(); }
});
it('names the stage a failed job failed in only for a code one of loom\'s programs chose', async () => {
  const f = fixture();
  f.add('a-build', 'failed', { exitCode: 22, exitBy: 'worker' }); f.add('b-harness', 'failed', { exitCode: 14, exitBy: 'body' }); f.add('c-own', 'failed', { exitCode: 2, exitBy: 'runner' });
  f.add('c-killed', 'failed', { exitCode: 29, exitBy: 'worker' }); f.add('d-done', 'done', { exitCode: 0, exitBy: 'body' }); f.add('e-unplaced', 'failed', { exitCode: 31, exitBy: 'loom' });
  // A machine's own runner that exits by itself with loom's numbers: 14 is not "body harness", 29 not "body killed", 31 not "loom unplaced".
  f.add('f-runner-14', 'failed', { exitCode: 14, exitBy: 'runner' }); f.add('g-runner-29', 'failed', { exitCode: 29, exitBy: 'runner' }); f.add('h-runner-31', 'failed', { exitCode: 31, exitBy: 'runner' });
  // Nobody said whose code it is (a job ended before the column): no stage is guessed. Nor is one program's number read as another's.
  f.add('i-unsaid', 'failed', { exitCode: 14 }); f.add('j-body-22', 'failed', { exitCode: 22, exitBy: 'body' });
  const schema = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: jobSummaryFields(f.summaries) }) });
  const result = await graphql({ schema, source: '{jobHistory(agent:"art", first: 20){id exitCode exitBy exitStage}}' });
  expect(result.data?.jobHistory).toEqual([
    { id: 'j-body-22', exitCode: 22, exitBy: 'body', exitStage: null }, { id: 'i-unsaid', exitCode: 14, exitBy: null, exitStage: null },
    { id: 'h-runner-31', exitCode: 31, exitBy: 'runner', exitStage: null }, { id: 'g-runner-29', exitCode: 29, exitBy: 'runner', exitStage: null }, { id: 'f-runner-14', exitCode: 14, exitBy: 'runner', exitStage: null },
    { id: 'e-unplaced', exitCode: 31, exitBy: 'loom', exitStage: 'loom unplaced' }, { id: 'd-done', exitCode: 0, exitBy: 'body', exitStage: null }, { id: 'c-own', exitCode: 2, exitBy: 'runner', exitStage: null },
    { id: 'c-killed', exitCode: 29, exitBy: 'worker', exitStage: 'body killed' }, { id: 'b-harness', exitCode: 14, exitBy: 'body', exitStage: 'body harness' }, { id: 'a-build', exitCode: 22, exitBy: 'worker', exitStage: 'worker build' }]);
});

it('reads historical usage and counts only visible jobs over a half-open queue-time range', async () => {
  const f = fixture();
  f.add('old', 'done');
  f.add('retry', 'failed', { retryOf: 'old' });
  f.add('private', 'failed', { member: 'owner' });
  f.add('later', 'failed', { queuedAt: '2026-11-15T00:00:00.000Z' });
  f.policy({ jobs: fields => sql`${fields.member} is null` });
  const schema = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: jobSummaryFields(f.summaries) }) });
  const result = await graphql({schema, source: `{
    jobUsage(id:"private"){id}
    old:jobUsage(id:"old"){usage{source tokensIn tools{name}} observations}
    retry:jobUsage(id:"retry"){observations}
    jobUsageRollup(from:"2026-11-14T00:00:00Z",to:"2026-11-15T00:00:00Z",groupBy:"day"){key jobCount retryCount totalTokens}
  }`});
  expect(result).toEqual({data:{jobUsage:null,old:{usage:{source:'none',tokensIn:null,tools:null},observations:[]},
    retry:{observations:['This job was a retry.']},jobUsageRollup:[{key:'2026-11-14',jobCount:2,retryCount:1,totalTokens:null}]}});
});

it('counts complete firings in a reused wake conversation, with all retries and earlier history outside the window',async()=>{
  const f = fixture();
  f.db.insert(conversations).values({id:'cv',agent:'art',venue:'wake',place:'lane',label:'Night shift',startedAt:f.at,lastAt:f.at,turnCount:0}).run();
  function add(id:string,day:number,input:number,output:number|null,delivery?:string,retryOf?:string) {
    const at = `2026-11-${day}T01:00:00Z`;
    f.add(id,'done',{conversation:'cv',queuedAt:at,retryOf});
    f.db.insert(jobUsage).values({job:id,source:'report',tokensIn:input,tokensOut:output,model:'reported',cacheRead:2,
      largestContext:32768,toolCalls:0,tools:{}}).run();
    if (delivery) {
      f.db.insert(inbox).values({id:delivery,job:id,conversation:'cv',toKind:'agent',to:'art',source:'trigger',sourceId:'lane:'+delivery,
        fromKind:'schedule',state:'done',at,changedAt:at}).run();
      f.db.insert(inboxRefs).values({item:delivery,ref:'lane'}).run();
    }
  }
  add('one',10,5,5,'d1'); add('two',11,10,20,'d2'); add('partial',12,500,null,'d3');
  add('latest',13,20,0); add('latest-retry',14,0,20,'d4','latest');
  const schema = new GraphQLSchema({query:new GraphQLObjectType({name:'Query',fields:jobSummaryFields(f.summaries)})});
  const query = `{
    conversationJobUsage(conversation:"cv",from:"2026-11-14T01:00:00Z",to:"2026-11-15T00:00:00Z"){id observations usage{tools{name count} totalTokens}}
    byTrigger:jobUsageRollup(from:"2026-11-10T00:00:00Z",to:"2026-11-20T00:00:00Z",groupBy:"trigger"){key jobCount retryCount tokensIn tokensOut cacheRead totalTokens largestContext}
    byModel:jobUsageRollup(from:"2026-11-10T00:00:00Z",to:"2026-11-20T00:00:00Z",groupBy:"model"){key}
    byConversation:jobUsageRollup(from:"2026-11-10T00:00:00Z",to:"2026-11-20T00:00:00Z",groupBy:"conversation"){key title}
  }`;
  const large = 'This job used a large context and made no tool calls.';
  expect(await graphql({schema,source:query})).toEqual({data:{
    conversationJobUsage:[{id:'latest-retry',observations:[large,'This job was a retry.','This trigger’s latest run used at least twice its earlier median tokens.'],usage:{tools:[],totalTokens:20}}],
    byTrigger:[{key:'lane',jobCount:5,retryCount:1,tokensIn:535,tokensOut:45,cacheRead:10,totalTokens:580,largestContext:32768}],
    byModel:[{key:'reported'}],byConversation:[{key:'cv',title:'Night shift'}],
  }});
  add('unknown-latest',15,1000,null,'d5');
  const jobs = (await graphql({schema,source:'{conversationJobUsage(conversation:"cv"){observations}}'})).data?.conversationJobUsage;
  expect(JSON.stringify(jobs)).not.toContain('median');
});
