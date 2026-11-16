import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { agents, members, boxes, agentModels, agentBoxes, agentRunSettings, memberAgents, modelAccounts, modelAccountWindows, modelAccountBoxes, jobs, tokens, operationResults, inbox, boxAgents, agentHousePorts, secrets } from './core/data/schema.js';
import { registerBuiltinService } from './core/services.js';
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
  const errors = vi.fn(); const roles = ['model'].map(model => ({ model, provider: 'provider', harness: 'codex', series: 'series' }));
  const root = sharedRoot({ db, clock, originAllowed: () => true, reportError: errors,  modelRoles: () => roles });
  cleanup.push(() => root.close());
  const settings=(extra:Record<string,unknown>={},bearer=ownerCredential,id:string=randomUUID())=>call('agentRunSettingsSet',{agent:'art',houseRepository:'https://example.com/house.git',houseFile:'Housefile',houseBranch:'next',nestedContainers:false,gpu:false,boxes:['worker'],ports:[],...extra},id,bearer);
  const send = () => {
    const conversation = root.services.conversations.open({ agent: 'art', venue:'loom', place:'thread', label:'thread' });
    const mail = root.services.conversations.send({ toKind: 'agent', to: 'art', conversation: conversation.id, source: 'thread', fromKind: 'person', fromId: 'owner', words: 'Private work instructions' });
    expect(root.services.runtime.admit({ kind: 'agent', id: 'art' }, [mail])).toBe(true);
    return db.select().from(jobs).where(eq(jobs.conversation, conversation.id)).get()!;
  };
  const call = async (name: string, input: unknown, id = `${name}-id`, bearer = credential) => setupCall(root, name, input) ?? root.http.request(`http://loom/api/runtime/${name}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + bearer }, body: JSON.stringify({ input, id }),
  });
  const control = httpWorkerControl({ url: 'https://loom.example', token: credential, signal: new AbortController().signal,
    fetch: async (input, init) => root.http.fetch(new Request(input, init)) });
  return { root, client, db, clock, now, send, call, control, errors, settings };
}

it('configures a house before inbox admission and projects its ports and capabilities on the actual worker claim',async()=>{
 const f=fixture();f.db.delete(agentRunSettings).run();
 expect((await f.settings({houseRepository:'https://example.com/new.git',houseFile:'worker/Housefile',houseBranch:'work',nestedContainers:true,ports:[{address:'127.0.0.1',port:9000}]})).status).toBe(200);
 const queued=f.send();expect(await f.control.next()).toMatchObject({id:queued.id,house:{repository:'https://example.com/new.git',file:'worker/Housefile',branch:'work'},run:{nestedContainers:true,gpu:false,ports:[{address:'127.0.0.1',port:9000}]}});expect(f.errors).not.toHaveBeenCalled();
});
it('reconsiders settled mail when the first house settings are configured',async()=>{
 const f=fixture();f.db.delete(agentRunSettings).run();f.root.services.tempo.volume.setTimings({kind:'agent',id:'art'},{settleSeconds:0});
 const cv=f.root.services.conversations.open({agent:'art',venue:'handoff',place:'waiting',label:'Waiting'});f.root.writes.run(()=>f.root.services.conversations.send({toKind:'agent',to:'art',conversation:cv.id,source:'thread',fromKind:'person',fromId:'owner',words:'Waiting for house'}));
 f.clock.advance(1);expect(f.db.select().from(jobs).all()).toEqual([]);expect((await f.settings()).status).toBe(200);f.clock.advance(1);expect(await f.control.next()).toMatchObject({conversation:cv.id});
});
it('uses ordered preferred machines and preserves a claimed assignment across later edits',async()=>{
 const f=fixture();f.db.insert(modelAccountBoxes).values({account:'account',box:'other'}).run();const queued=f.send();
 expect((await f.settings({boxes:['other','worker']})).status).toBe(200);expect(await f.control.next()).toBeUndefined();
 const other=httpWorkerControl({url:'https://loom.example',token:otherCredential,signal:new AbortController().signal,fetch:async(input,init)=>f.root.http.fetch(new Request(input,init))});
 const claimed=await other.next();expect(claimed).toMatchObject({id:queued.id,box:'other',house:{repository:'repo'}});
 expect((await f.settings({boxes:['worker'],houseRepository:'new-repo',houseFile:'Newfile',houseBranch:'new-branch',ports:[{address:'127.0.0.1',port:9001}]})).status).toBe(200);expect(claimed).toMatchObject({box:'other',house:{repository:'repo',file:'Housefile',branch:'next'},run:{ports:[]}});expect(f.db.select().from(jobs).get()).toMatchObject({box:'other',houseRepository:'repo',houseFile:'Housefile',houseBranch:'next'});
});
it('accepts a machine explicitly lent to the agent without exposing its registry and refuses unrelated or revoked machines',async()=>{
 const f=fixture();f.db.insert(members).values({id:'bob',role:'member',joinedAt:f.now()}).run();f.root.writes.run(()=>{f.db.update(members).set({role:'member'}).where(eq(members.id,'owner')).run();f.db.update(boxes).set({owner:'bob'}).where(eq(boxes.id,'worker')).run();});
 expect((await f.settings()).status).toBe(400);f.db.insert(boxAgents).values({box:'worker',agent:'art',lent:false}).run();expect((await f.settings()).status).toBe(400);f.db.update(boxAgents).set({lent:true}).run();expect((await f.settings()).status).toBe(200);
 f.root.writes.run(()=>f.db.update(boxes).set({revokedAt:f.now()}).where(eq(boxes.id,'worker')).run());expect((await f.settings()).status).toBe(400);
});
it('preserves the existing Secrets-owned repository reference and rejects overposting it',async()=>{
 const f=fixture();f.db.insert(secrets).values({name:'repository-key',description:'',changedAt:f.now(),changedBy:'owner'}).run();f.db.update(agentRunSettings).set({repositorySecret:'repository-key'}).run();
 expect((await f.settings()).status).toBe(200);expect(f.db.select().from(agentRunSettings).get()?.repositorySecret).toBe('repository-key');expect((await f.settings({repositorySecret:'another'})).status).toBe(400);
});
it.each([{boxes:['missing']},{boxes:['worker','worker']},{ports:[{address:'bad',port:8000}]},{ports:[{address:'::1',port:9000},{address:'0:0:0:0:0:0:0:1',port:9000}]},{houseRepository:'ht'+String.fromCharCode(9)+'tps://user:password@example.com/repo'},{ports:[{address:'127.0.0.1',port:0}]},{ports:[{address:'127.0.0.1',port:8000.5}]},{ports:[{address:'127.0.0.1',port:65536}]},{ports:[{address:'127.0.0.1',port:8000},{address:'127.0.0.1',port:8000}]},{houseRepository:'https://user:password@example.com/repo'},{houseRepository:'//user:password@example.com/repo'},{houseRepository:'//user@example.com/repo'},{houseRepository:'https:user:password@example.com/repo'},{houseRepository:'https:example.com/repo?token=private'},{houseRepository:'https:example.com/repo#private'},{houseRepository:'https://user@example.com/repo'},{houseRepository:'https://example.com/repo#private'},{houseRepository:'user:password@example.com:path'},{houseRepository:'https://example.com/repo?token=private'},{houseFile:'../outside'},{houseFile:'/absolute'},{houseBranch:'-option'},{agent:'missing'},{owner:'other'},{houseRepository:'x'.repeat(2049)},{houseFile:'x'.repeat(513)},{houseBranch:'x'.repeat(201)},{houseRepository:''},{houseFile:''},{houseBranch:''}])('rejects invalid or unauthorized setup atomically: %j',async extra=>{
 const f=fixture(),before=f.db.select().from(agentRunSettings).all();expect([400,403]).toContain((await f.settings(extra)).status);expect(f.db.select().from(agentRunSettings).all()).toEqual(before);
});
it('requires GPU placement when an owner enables GPU after work was queued',async()=>{
 const f=fixture(),queued=f.send();expect((await f.settings({gpu:true})).status).toBe(200);expect(await f.control.next()).toBeUndefined();
 expect((await f.call('health',{facts:['gpu:5090']},'gpu-health')).status).toBe(200);expect(await f.control.next()).toMatchObject({id:queued.id,run:{gpu:true}});
});

it('accepts bounded machine and port lists, including IPv6 and the highest port, without external execution',async()=>{
 const network=vi.fn(async()=>{throw new Error('Network forbidden');});vi.stubGlobal('fetch',network);for(const spy of Object.values(privateCalls))spy.mockClear();
 const f=fixture(),ids=Array.from({length:129},(_,i)=>'machine-'+i),ports=Array.from({length:129},(_,i)=>({address:'127.0.0.1',port:i+1}));
 f.db.insert(boxes).values(ids.map(id=>({id,name:id,owner:'owner',sameMachineAsLoom:false,hostsAny:true,reportOnly:false,alwaysOn:false,enrolledAt:f.now()}))).run();
 expect((await f.settings({boxes:ids.slice(0,128),ports:ports.slice(0,128)})).status).toBe(200);expect(f.db.select().from(agentBoxes).all()).toHaveLength(128);expect(f.db.select().from(agentHousePorts).all()).toHaveLength(128);
 expect((await f.settings({boxes:ids})).status).toBe(400);expect((await f.settings({ports})).status).toBe(400);expect(f.db.select().from(agentBoxes).all()).toHaveLength(128);expect(f.db.select().from(agentHousePorts).all()).toHaveLength(128);
 expect((await f.settings({ports:[{address:'0:0:0:0:0:0:0:1',port:65535}]})).status).toBe(200);expect(f.db.select().from(agentHousePorts).all()).toEqual([{agent:'art',address:'::1',port:65535}]);
 expect(network).not.toHaveBeenCalled();for(const spy of Object.values(privateCalls))expect(spy).not.toHaveBeenCalled();
});
it('allows a current co-owner to configure the agent without a household owner role',async()=>{
 const f=fixture();f.db.insert(members).values({id:'co-owner',role:'member',joinedAt:f.now()}).run();f.db.insert(memberAgents).values({member:'co-owner',agent:'art'}).run();f.db.insert(tokens).values({fingerprint:hash('e'.repeat(64)),label:'Co-owner',kind:'owner',member:'co-owner',createdAt:f.now()}).run();
 expect((await f.settings({boxes:[]},'e'.repeat(64))).status).toBe(200);expect(f.db.select().from(agentBoxes).all()).toEqual([]);
});

it('listing an owned visible machine never grants it execution permission',async()=>{
 const f=fixture();f.db.update(boxes).set({hostsAny:false}).where(eq(boxes.id,'worker')).run();const queued=f.send();
 expect((await f.settings({boxes:['worker']})).status).toBe(200);expect(f.db.select().from(boxAgents).all()).toEqual([]);expect(await f.control.next()).toBeUndefined();expect(f.db.select().from(jobs).where(eq(jobs.id,queued.id)).get()?.state).toBe('queued');
});
