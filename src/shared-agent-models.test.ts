import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { eq, asc } from 'drizzle-orm';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { agents, members, boxes, agentModels, agentBoxes, agentRunSettings, memberAgents, modelAccounts, modelAccountWindows, modelAccountBoxes, jobs, tokens, operationResults, inbox, sessions, boxFacts, jobNeeds, turns } from './core/data/schema.js';
import { sharedRoot } from './shared-root.js';
import { setupCall } from '../test/fixtures/setup-call.js';
import { httpWorkerControl } from './runtime/worker-http.js';
const privateCalls=vi.hoisted(()=>{
 const fail=()=>{throw new Error('Provider execution forbidden in metadata commands');};
 return{spawn:vi.fn(fail),spawnSync:vi.fn(fail),exec:vi.fn(fail),execSync:vi.fn(fail),execFile:vi.fn(fail),execFileSync:vi.fn(fail),fork:vi.fn(fail),signIn:vi.fn(fail)};
});
vi.mock('node:child_process',async original=>{const api={...await original<typeof import('node:child_process')>(),...privateCalls};return{...api,default:api};});
vi.mock('./runtime/account-signin.js',()=>({signInAccount:privateCalls.signIn}));
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close();vi.unstubAllGlobals(); });
const credential = 'a'.repeat(64), otherCredential = 'b'.repeat(64), ownerCredential = 'c'.repeat(64), agentCredential = 'd'.repeat(64);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture(tempo?: Parameters<typeof sharedRoot>[0]['tempo'], commsKey?: Parameters<typeof sharedRoot>[0]['commsKey']) {
  const client = new Database(':memory:'); cleanup.push(() => { if (client.open) client.close(); });
  const clock = new FakeClock(), now = () => new Date(clock.now()).toISOString();
  const db = createDataSchema(client, now);
  db.insert(members).values({ id: 'owner', role: 'owner', joinedAt: now() }).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(memberAgents).values({ member: 'owner', agent: 'art' }).run();
  for (const id of ['worker', 'other']) db.insert(boxes).values({ id, name: id, owner: 'owner', hostsAny: true, sameMachineAsLoom: false, reportOnly: false, alwaysOn: false, enrolledAt: now(), lastSeenAt: now() }).run();
  for (const [value, box] of [[credential, 'worker'], [otherCredential, 'other']]) db.insert(tokens).values({ fingerprint: hash(value), label: box, kind: 'runner', box, createdAt: now() }).run();
  db.insert(tokens).values({ fingerprint: hash(ownerCredential), label: 'Owner', kind: 'owner', member: 'owner', createdAt: now() }).run();
  db.insert(tokens).values({ fingerprint: hash(agentCredential), label: 'Agent', kind: 'agent', agent: 'art', createdAt: now() }).run();
  db.insert(agentBoxes).values({ agent: 'art', box: 'worker', position: 0 }).run();
  db.insert(agentModels).values({ agent: 'art', model: 'model', position: 0 }).run();
  db.insert(agentRunSettings).values({ agent: 'art', houseRepository: 'repo', houseFile: 'Housefile', houseBranch: 'next', nestedContainers: false, gpu: false }).run();
  db.insert(modelAccounts).values({ id: 'account', owner: 'owner', provider: 'provider', label: 'Subscription', hasRoom: true }).run();
  db.insert(modelAccountWindows).values({ account: 'account', window: 'week', usage: 0.2, usageReadAt: now(), resetsAt: new Date(clock.now() + 7 * 86400_000).toISOString(), durationMs: 7 * 86400_000 }).run();
  db.insert(modelAccountBoxes).values({ account: 'account', box: 'worker' }).run();
  const ended = vi.fn((id: string) => { expect(client.inTransaction).toBe(false); const job = db.select().from(jobs).where(eq(jobs.id, id)).get()!; expect(job.endedAt).toBe(now());
    if (job.state === 'done' || job.state === 'failed') expect(db.select().from(operationResults).all().some(row => row.operation === 'runtime.finish')).toBe(true); });
  const errors = vi.fn(); let roles = ['model', 'second'].map(model => ({ model, provider: 'provider', harness: 'codex', series: 'series' }));
  const root = sharedRoot({ db, clock, originAllowed: () => true, reportError: errors, tempo, commsKey, modelRoles: () => roles, runtimeJobEnded: ended });
  cleanup.push(() => root.close());
  const models = () => db.select().from(agentModels).where(eq(agentModels.agent, 'art')).orderBy(asc(agentModels.position)).all();
  const set = (models: string[], bearer=ownerCredential, id:string=randomUUID()) => call('agentModelsSet', {agent:'art',models}, id, bearer);
  const send = (venue: 'loom' | 'handoff' = 'loom', place = 'thread') => {
    const conversation = root.services.conversations.open({ agent: 'art', venue, place, label: place });
    const mail = root.services.conversations.send({ toKind: 'agent', to: 'art', conversation: conversation.id, source: 'thread', fromKind: 'person', fromId: 'owner', words: 'Private work instructions' });
    expect(root.services.runtime.admit({ kind: 'agent', id: 'art' }, [mail])).toBe(true);
    return db.select().from(jobs).where(eq(jobs.conversation, conversation.id)).get()!;
  };
  const call = async (name: string, input: unknown, id = `${name}-id`, bearer = credential) => setupCall(root, name, input) ?? root.http.request(`http://loom/api/runtime/${name}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + bearer }, body: JSON.stringify({ input, id }),
  });
  const control = httpWorkerControl({ url: 'https://loom.example', token: credential, signal: new AbortController().signal,
    fetch: async (input, init) => root.http.fetch(new Request(input, init)) });
  return { root, client, db, clock, now, send, call, control, errors, ended, models, set, setRoles: (value: typeof roles) => { roles = value; } };
}

it('reorders the future claim through the owner command without changing an already running job',async()=>{
 const f=fixture();
 expect((await f.set(['second','model'])).status).toBe(200);
 const queued=f.send();expect(queued.model).toBe('second');
 expect((await f.set(['model','second'])).status).toBe(200);
 expect(await f.control.next()).toMatchObject({id:queued.id,model:'model'});
 expect((await f.set(['second'])).status).toBe(200);
 expect(f.db.select().from(jobs).where(eq(jobs.id,queued.id)).get()).toMatchObject({model:'model',state:'starting'});
 expect(f.models()).toMatchObject([{model:'second',position:0}]);expect(f.errors).not.toHaveBeenCalled();
});
it('wakes settled mail when the first model preference is configured',async()=>{
 const f=fixture();f.db.delete(agentModels).run();
 f.root.services.tempo.volume.setTimings({kind:'agent',id:'art'},{settleSeconds:0});
 const cv=f.root.services.conversations.open({agent:'art',venue:'handoff',place:'waiting',label:'Waiting'});
 f.root.writes.run(()=>f.root.services.conversations.send({toKind:'agent',to:'art',conversation:cv.id,source:'thread',fromKind:'person',fromId:'owner',words:'Waiting for setup'}));
 f.clock.advance(1);expect(f.db.select().from(jobs).all()).toEqual([]);
 expect((await f.set(['model'])).status).toBe(200);f.clock.advance(1);
 expect(await f.control.next()).toMatchObject({conversation:cv.id,model:'model'});expect(f.errors).not.toHaveBeenCalled();
});
it.each([[],[''],['model','model'],['unknown']].map(models=>({models})))('rejects invalid choices atomically: $models',async ({models})=>{
 const f=fixture();expect((await f.set(models)).status).toBe(400);expect(f.models()).toMatchObject([{model:'model',position:0}]);
});
it('rejects extra identity fields and nonexistent agents',async()=>{
 const f=fixture();
 expect((await f.call('agentModelsSet',{agent:'art',models:['second'],owner:'owner'},'extra',ownerCredential)).status).toBe(400);
 expect((await f.call('agentModelsSet',{agent:'missing',models:['second']},'missing',ownerCredential)).status).toBe(400);
});

it('accepts 64 configured models and refuses 65 without changing the list',async()=>{
 const f=fixture(),models=Array.from({length:65},(_,i)=>'model-'+i);
 f.setRoles(models.map(model=>({model,provider:'provider',harness:'codex',series:'series'})));
 expect((await f.set(models.slice(0,64))).status).toBe(200);expect(f.models().map(row=>row.model)).toEqual(models.slice(0,64));
 expect((await f.set(models)).status).toBe(400);expect(f.models().map(row=>row.model)).toEqual(models.slice(0,64));
});

it('changes setup without provider traffic or a private native program',async()=>{
 const network=vi.fn(async()=>{throw new Error('Provider network forbidden');});vi.stubGlobal('fetch',network);for(const spy of Object.values(privateCalls))spy.mockClear();
 const f=fixture();expect((await f.set(['second','model'])).status).toBe(200);expect(f.models()).toMatchObject([{model:'second',position:0},{model:'model',position:1}]);
 expect(network).not.toHaveBeenCalled();for(const spy of Object.values(privateCalls))expect(spy).not.toHaveBeenCalled();
});
