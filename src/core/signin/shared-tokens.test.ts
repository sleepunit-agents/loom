import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, expect, it } from 'vitest';
import { FakeClock } from '../clock.js';
import { createDataSchema } from '../data/database.js';
import { agents, boxes, jobs, members, tokens } from '../data/schema.js';
import { sharedRoot } from '../../shared-root.js';
const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function fixture() {
  const client = new Database(':memory:'); clean.push(() => client.close());
  const clock = new FakeClock(), at = new Date(clock.now()).toISOString(), db = createDataSchema(client, () => new Date(clock.now()).toISOString());
  db.insert(members).values([{ id: 'owner', role: 'owner', joinedAt: at }, { id: 'sam', role: 'member', joinedAt: at }]).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(boxes).values({ id: 'box', name: 'Fixture', owner: 'sam', hostsAny: false, sameMachineAsLoom: false, reportOnly: false, alwaysOn: false, enrolledAt: at, lastSeenAt: at }).run();
  const raw = { owner: 'a'.repeat(64), sam: 'b'.repeat(64), art: 'c'.repeat(64) };
  for (const member of ['owner', 'sam'] as const) db.insert(tokens).values({ fingerprint: hash(raw[member]), label: member, kind: 'owner', member, createdAt: at }).run();
  db.insert(tokens).values({ fingerprint: hash(raw.art), label: 'Art', kind: 'agent', agent: 'art', createdAt: at }).run();
  const root = sharedRoot({ db, clock, originAllowed: () => true, reportError: () => {} }); clean.push(() => root.close());
  const issue = (input: unknown, actor: keyof typeof raw = 'owner', extra = {}) => root.http.request('http://loom/api/signin/token', { method: 'POST', headers: { authorization: 'Bearer '+raw[actor], 'content-type': 'application/json', ...extra }, body: JSON.stringify(input) });
  return { client, db, clock, at, root, raw, issue };
}
it('issues canonical member, agent and machine tokens, stores fingerprints only, and never caches credentials', async () => {
  const f = fixture();
  for (const identity of [{kind:'owner',member:'sam'}, {kind:'agent',agent:'art'}, {kind:'runner',box:'box'}]) {
    const response = await f.issue({ ...identity, label: 'New '+identity.kind });
    expect(response.status).toBe(200);
    const { value } = await response.json();
    expect(value.fingerprint).toBe(hash(value.token));
    expect(f.root.credentials.authenticate(new Request('http://loom/graphql', {headers:{authorization:'Bearer '+value.token}}))?.viewer)
      .toEqual(identity.kind==='owner'?{kind:'member',id:'sam'}:identity.kind==='agent'?{kind:'agent',id:'art'}:{kind:'runner',id:'box'});
    expect(JSON.stringify(f.client.prepare('SELECT * FROM tokens').all())).not.toContain(value.token);
    expect(f.client.prepare('SELECT * FROM operation_results').all()).toEqual([]);
  }
});
it('checks owner authority, strict identities, active machines and live label uniqueness', async () => {
  const f = fixture(), input = { kind: 'runner', box: 'box', label: 'Machine' };
  for (const actor of ['sam','art'] as const) expect((await f.issue(input,actor)).status).toBe(403);
  expect((await f.issue(input,'owner',{origin:'http://evil'})).status).toBe(403);
  expect((await f.issue({...input,member:'owner'})).status).toBe(400);
  expect((await f.issue({...input,box:'missing'})).status).toBe(400);
  expect((await f.issue({...input,expiresAt:f.at})).status).toBe(400);
  expect((await f.issue(input)).status).toBe(200);
  expect((await f.issue(input)).status).toBe(409);
  f.db.update(boxes).set({revokedAt:f.at}).run();
  expect((await f.issue({...input,label:'Other machine'})).status).toBe(400);
});
it('revokes current credentials at the shared door and rechecks ownership on replay', async () => {
  const f = fixture();
  const { value } = await (await f.issue({kind:'owner',member:'sam',label:'Browser token'})).json();
  const request = new Request('http://loom/graphql',{headers:{authorization:'Bearer '+value.token}});
  const auth = f.root.credentials.authenticate(request)!;
  const call = (actor:'owner'|'sam', id='revoke') => f.root.http.request('http://loom/api/token/revoke',{method:'POST',headers:{authorization:'Bearer '+f.raw[actor],'content-type':'application/json'},body:JSON.stringify({input:{fingerprint:value.fingerprint},id})});
  expect((await call('sam')).status).toBe(403);
  expect((await call('owner')).status).toBe(200);
  expect(auth.valid()).toBe(false);
  expect(f.root.credentials.authenticate(request)).toBeUndefined();
  f.root.writes.run(()=>f.db.update(members).set({role:'member'}).where(eq(members.id,'owner')).run());
  expect((await call('owner')).status).toBe(403);
});
it('allows trusted machine enrollment in the same transaction without an internal permission gate', () => {
  const f = fixture();
  const value = f.root.writes.run(()=>f.root.services.signin.issue({kind:'runner',box:'box',label:'Enrolled'})).value;
  expect(f.root.credentials.authenticate(new Request('http://loom',{headers:{authorization:'Bearer '+value.token}}))?.viewer).toEqual({kind:'runner',id:'box'});
});

it('binds job credentials only to assigned current work for the named agent', async () => {
  const f = fixture(), issue = (job: string, label = job) => f.issue({kind:'agent',agent:'art',job,label});
  f.db.insert(agents).values({id:'mark',about:'',markBg:'#000',markFg:'#fff',faceShape:'pebble',faceEyes:'dot'}).run();
  const base={agent:'art',box:'box',title:'Fixture job',brief:'Work',model:'fixture',state:'running' as const,startedByKind:'member',startedBy:'owner',houseRepository:'repo',houseFile:'Housefile',houseBranch:'next',queuedAt:f.at};
  f.db.insert(jobs).values([{...base,id:'current'},{...base,id:'other',agent:'mark'},{...base,id:'finished',state:'done'},{...base,id:'unassigned',box:null}]).run();
  for(const job of ['missing','other','finished','unassigned']) expect((await issue(job)).status).toBe(400);
  const response=await issue('current');expect(response.status).toBe(200);
  const {value}=await response.json();
  expect(f.db.select().from(tokens).where(eq(tokens.fingerprint,value.fingerprint)).get()).toMatchObject({kind:'agent',agent:'art',job:'current'});
  const auth=f.root.credentials.authenticate(new Request('http://loom',{headers:{authorization:'Bearer '+value.token}}));
  expect(auth?.viewer).toEqual({kind:'agent',id:'art'});
  f.root.writes.run(()=>f.db.update(jobs).set({state:'done'}).where(eq(jobs.id,'current')).run());
  expect(auth?.valid()).toBe(false);
});
