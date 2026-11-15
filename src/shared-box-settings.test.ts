import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { eq, asc } from 'drizzle-orm';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { agents, members, boxes, agentModels, agentBoxes, agentRunSettings, memberAgents, modelAccounts, modelAccountWindows, modelAccountBoxes, jobs, tokens, operationResults, inbox, sessions, boxFacts, boxAgents, jobNeeds, turns } from './core/data/schema.js';
import { registerBuiltinService } from './core/services.js';
import { sharedRoot } from './shared-root.js';
import { httpWorkerControl } from './runtime/worker-http.js';
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const credential = 'a'.repeat(64), otherCredential = 'b'.repeat(64), ownerCredential = 'c'.repeat(64), agentCredential = 'd'.repeat(64);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture() {
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
  const errors = vi.fn(); const roles = ['model', 'second'].map(model => ({ model, provider: 'provider', harness: 'codex', series: 'series' }));
  const root = sharedRoot({ db, clock, originAllowed: () => true, reportError: errors,  modelRoles: () => roles, runtimeJobEnded: ended });
  cleanup.push(() => root.close());
  const settings=(extra:Record<string,unknown>={},bearer=ownerCredential,id:string=randomUUID())=>call('boxSettingsSet',{box:'worker',name:'Worker',hostsAny:false,reportOnly:false,alwaysOn:false,agents:[],facts:[],...extra},id,bearer);
  const send = (venue: 'loom' | 'handoff' = 'loom', place = 'thread') => {
    const conversation = root.services.conversations.open({ agent: 'art', venue, place, label: place });
    const mail = root.services.conversations.send({ toKind: 'agent', to: 'art', conversation: conversation.id, source: 'thread', fromKind: 'person', fromId: 'owner', words: 'Private work instructions' });
    expect(root.services.runtime.admit({ kind: 'agent', id: 'art' }, [mail])).toBe(true);
    return db.select().from(jobs).where(eq(jobs.conversation, conversation.id)).get()!;
  };
  const call = (name: string, input: unknown, id = `${name}-id`, bearer = credential) => root.http.request(`http://loom/api/runtime/${name}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + bearer }, body: JSON.stringify({ input, id }),
  });
  const control = httpWorkerControl({ url: 'https://loom.example', token: credential, signal: new AbortController().signal,
    fetch: async (input, init) => root.http.fetch(new Request(input, init)) });
  return { root, client, db, clock, now, send, call, control, errors, ended, settings };
}

it('lets the current owner configure hosting, lending and facts through the actual worker claim',async()=>{
 const f=fixture();f.root.writes.run(()=>{
  f.db.update(members).set({role:'member'}).where(eq(members.id,'owner')).run();
  f.db.insert(members).values({id:'bob',role:'member',joinedAt:f.now()}).run();
  f.db.insert(tokens).values({fingerprint:hash('e'.repeat(64)),label:'Bob',kind:'owner',member:'bob',createdAt:f.now()}).run();
  f.db.update(boxes).set({owner:'bob',hostsAny:false}).where(eq(boxes.id,'worker')).run();
 });
 const queued=f.send();expect(await f.control.next()).toBeUndefined();
 expect((await f.settings({agents:[{agent:'art',lent:true}]},'e'.repeat(64))).status).toBe(200);
 expect(await f.control.next()).toMatchObject({id:queued.id,box:'worker'});
 expect(f.db.select().from(boxAgents).all()).toEqual([{box:'worker',agent:'art',lent:true}]);
 expect((await f.settings({},ownerCredential)).status).toBe(403);expect(f.errors).not.toHaveBeenCalled();
});
it('report-only machines keep reporting health and never claim jobs',async()=>{
 const f=fixture(),queued=f.send();expect((await f.settings({hostsAny:true,reportOnly:true,alwaysOn:true})).status).toBe(200);
 expect(await f.control.next()).toBeUndefined();
 expect((await f.call('health',{facts:['gpu:5090']},'health')).status).toBe(200);
 expect(f.db.select().from(jobs).where(eq(jobs.id,queued.id)).get()?.state).toBe('queued');
 f.clock.advance(150001);
 expect(f.db.select().from(inbox).all().filter(row=>row.source==='notice')).toHaveLength(1);
});
it('replaces owner facts without deleting worker reports and lets owner facts survive heartbeats',async()=>{
 const f=fixture();expect((await f.call('health',{facts:['cpu:amd','gpu:5090']},'health')).status).toBe(200);
 expect((await f.settings({facts:['gpu:5090','rack:attic']})).status).toBe(200);
 expect(f.db.select().from(boxFacts).all()).toEqual(expect.arrayContaining([{box:'worker',fact:'cpu:amd',fromOwner:false},{box:'worker',fact:'gpu:5090',fromOwner:true},{box:'worker',fact:'rack:attic',fromOwner:true}]));
 expect((await f.call('health',{facts:[]},'health2')).status).toBe(200);
 expect(f.db.select().from(boxFacts).all()).toHaveLength(2);
 expect((await f.settings({facts:['rack:den']})).status).toBe(200);expect(f.db.select().from(boxFacts).all()).toEqual([{box:'worker',fact:'rack:den',fromOwner:true}]);
});
it('requires current ownership and rejects agents runners and services',async()=>{
 const f=fixture();for(const bearer of[credential,agentCredential])expect((await f.settings({},bearer)).status).toBe(403);
 const input={box:'worker',name:'Worker',hostsAny:false,reportOnly:false,alwaysOn:false,agents:[],facts:[]};
 const service=registerBuiltinService(f.root.operations,'machine-settings',['runtime.box'],'runtime');
 expect(f.root.operations.call('http',service,'runtime.boxSettingsSet',input,'service')).toMatchObject({ok:false,code:'denied'});
 expect((await f.settings({},ownerCredential,'recheck')).status).toBe(200);
 f.root.writes.run(()=>{f.db.update(members).set({role:'member'}).where(eq(members.id,'owner')).run();f.db.insert(members).values({id:'other-owner',role:'member',joinedAt:f.now()}).run();f.db.update(boxes).set({owner:'other-owner'}).where(eq(boxes.id,'worker')).run();});
 expect((await f.settings({},ownerCredential,'recheck')).status).toBe(403);
});
it('allows a current household owner but withdraws that authority with the role',async()=>{
 const f=fixture();f.db.insert(members).values({id:'bob',role:'member',joinedAt:f.now()}).run();f.db.update(boxes).set({owner:'bob'}).where(eq(boxes.id,'worker')).run();
 expect((await f.settings()).status).toBe(200);f.root.writes.run(()=>f.db.update(members).set({role:'member'}).where(eq(members.id,'owner')).run());
 expect((await f.settings()).status).toBe(403);
});
it.each([{owner:'other'},{lastSeenAt:'2026-11-15T00:00:00.000Z'},{agents:[{agent:'missing',lent:false}]},{agents:[{agent:'art',lent:false},{agent:'art',lent:false}]},{facts:['duplicate','duplicate']},{facts:Array.from({length:129},(_,i)=>'fact:'+i)},{facts:['x'.repeat(257)]},{facts:['']},{facts:['bad\nvalue']},{name:'other'}])('rejects invalid setup atomically: %j',async extra=>{
 const f=fixture(),before=f.db.select().from(boxes).all();expect([400,409]).toContain((await f.settings(extra)).status);expect(f.db.select().from(boxes).all()).toEqual(before);expect(f.db.select().from(boxAgents).all()).toEqual([]);
});
it('refuses missing and revoked machines',async()=>{
 const f=fixture();expect((await f.settings({box:'missing'})).status).toBe(403);f.root.writes.run(()=>f.db.update(boxes).set({revokedAt:f.now()}).where(eq(boxes.id,'worker')).run());expect((await f.settings()).status).toBe(403);
});
it('commits settings and their receipt together, without notifying on rollback or replay',async()=>{
 // Keep this receipt/job predicate local; record here and assert after dispatch.
 const f=fixture();expect((await f.call('health',{facts:['cpu:amd']},'prior-health')).status).toBe(200);expect((await f.settings({agents:[{agent:'art',lent:false}],facts:['rack:old']})).status).toBe(200);const before={boxes:f.db.select().from(boxes).all(),agents:f.db.select().from(boxAgents).all(),facts:f.db.select().from(boxFacts).all()},observed:{transaction:boolean;receipt:boolean}[]=[],notify=f.root.services.tempo.capacityChanged.bind(f.root.services.tempo),changed=vi.spyOn(f.root.services.tempo,'capacityChanged').mockImplementation(()=>{observed.push({transaction:f.client.inTransaction,receipt:f.db.select().from(operationResults).all().some(row=>row.id==='once'||row.id==='later')});notify();});
 f.client.exec("CREATE TEMP TRIGGER fail_settings_receipt BEFORE INSERT ON operation_results WHEN NEW.id='rollback' BEGIN SELECT RAISE(ABORT,'fixture'); END");
 const extra={name:'Changed',agents:[{agent:'art',lent:false}],facts:['rack:attic']};
 expect((await f.settings(extra,ownerCredential,'rollback')).status).toBe(503);expect({boxes:f.db.select().from(boxes).all(),agents:f.db.select().from(boxAgents).all(),facts:f.db.select().from(boxFacts).all()}).toEqual(before);expect(changed).not.toHaveBeenCalled();
 expect((await f.settings(extra,ownerCredential,'once')).status).toBe(200);expect((await f.settings({},ownerCredential,'later')).status).toBe(200);expect((await f.settings(extra,ownerCredential,'once')).status).toBe(200);
 expect(f.db.select().from(boxes).where(eq(boxes.id,'worker')).get()?.name).toBe('Worker');expect(f.db.select().from(boxAgents).all()).toEqual([]);expect(f.db.select().from(boxFacts).all()).toEqual([{box:'worker',fact:'cpu:amd',fromOwner:false}]);expect(changed).toHaveBeenCalledTimes(2);expect(observed).toEqual([{transaction:false,receipt:true},{transaction:false,receipt:true}]);
});

it('applies owner hosting changes independently of other placement requirements',async()=>{
 const f=fixture(),queued=f.send();
 expect((await f.settings()).status).toBe(200);expect(await f.control.next()).toBeUndefined();
 expect((await f.settings({hostsAny:true})).status).toBe(200);expect(await f.control.next()).toMatchObject({id:queued.id,box:'worker'});
});
it('applies owner machine facts to a queued claim',async()=>{
 const f=fixture(),queued=f.send();f.db.insert(jobNeeds).values({job:queued.id,need:'gpu:5090'}).run();
 expect((await f.settings({hostsAny:true})).status).toBe(200);expect(await f.control.next()).toBeUndefined();
 expect((await f.settings({hostsAny:true,facts:['gpu:5090']})).status).toBe(200);expect(await f.control.next()).toMatchObject({id:queued.id,box:'worker'});
});

it('requires an explicit lending grant for a foreign agent even when an old non-lending row exists',async()=>{
 const f=fixture();f.db.insert(members).values({id:'bob',role:'member',joinedAt:f.now()}).run();f.db.update(boxes).set({owner:'bob',hostsAny:false}).where(eq(boxes.id,'worker')).run();f.db.insert(boxAgents).values({box:'worker',agent:'art',lent:false}).run();const queued=f.send();
 expect(await f.control.next()).toBeUndefined();
 expect((await f.settings({agents:[{agent:'art',lent:false}]})).status).toBe(400);
 expect((await f.settings({agents:[{agent:'art',lent:true}]})).status).toBe(200);expect(await f.control.next()).toMatchObject({id:queued.id,box:'worker'});
});
