import { once } from 'node:events';
import { WebSocket } from 'ws';
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startLoom } from '../../foundation.js';
import { FakeClock, type Viewer } from '../../core/index.js';
import { fixtureSharing } from '../../fixture.js';
import { importClock } from './importer.js';
import { wake, wakes, type Wake } from './store.js';
import { load } from '../approvals/store.js';
import { installApprovals } from '../approvals/index.js';
import { approvalsRole } from '../approvals/role.js';
import { installClock } from './index.js';
import { clockVouchApplication } from './role.js';
const owner: Viewer = { kind: 'member', id: 'jonathan' };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const ids = ['w-aaaaaa', 'w-bbbbbb', 'w-cccccc'];
async function setup(preinstalled = false, noFiling = false) {
  const home = mkdtempSync(join(tmpdir(), 'clock-vouch-'));
  const source = join(home, 'old'); mkdirSync(join(source, 'art'), {recursive:true});
  writeFileSync(join(source, 'art', 'spool.jsonl'), ids.map(id => JSON.stringify({ id, kind:'wake', for:'-',
    at:'2026-11-13 07:00:00', created:'2026-11-13 05:00:00', prompt:'Review my queue', note:'unknown work', origin:'agent:art', fails:3 })).join('\n'));
  const clock = new FakeClock(Date.parse('2026-11-13T12:00:00Z'));
  const access = fixtureSharing();
  access.services.approvals = {types:['approval'],operations:['approvals.piece-request','approvals.piece-group-vouch']};
  access.services.clock = {types:['approval'],operations:['approvals.piece-request']};
  let first = true;
  const options = {home, clock, next:true, authenticate: (req: import('node:http').IncomingMessage) => ({viewer:req.headers['x-fixture-agent'] ? {kind:'agent' as const,id:'art'} : owner, valid:()=>true}), sharing:()=>access, stdout:()=>{}, install(app: Parameters<NonNullable<Parameters<typeof startLoom>[0]['install']>>[0]) {
    if (first) { importClock(app.db, source, clock.now()); first = false; }
    if (noFiling) { const jobs = installClock(app.db, app.operations, app.live, ()=>access); app.onClose(jobs.close); }
    if (preinstalled) installApprovals(app.db, app.operations, app.live, ()=>access);
  }};
  let app = await startLoom(options);
  cleanups.push(async () => { await app.close(); rmSync(home,{recursive:true,force:true}); });
  const call = (name:string, input:object, viewer = owner, receipt = randomUUID()) => app.operations.call('direct',viewer,name,input,receipt);
  const value = <T>(name:string, input:object, viewer = owner): T => { const r = call(name,input,viewer); if (!r.ok) throw Error(JSON.stringify(r)); return r.value as T; };
  const change = (id:string, patch: Partial<Wake>) => {
    app.db.prepare('UPDATE clock_wakes SET record=? WHERE id=?').run(JSON.stringify({...wake(app.db,id),...patch}),id);
  };
  const request = (which = ids.slice(0,2)) => {
    const r = approvalsRole(app.operations,'clock').call('request',{who:{agent:'art',where:'clock'},for:'owner'}, {
      kind:'vouch-wake', target:`art:${which.join(',')}`, ask:'Count these unknown wakes as your work?', why:'The imported work has no verified owner.',
      if_yes:'The eligible wakes become your work.', if_no:'The wakes remain held.', details:which.map(id=>`${id} fires at the saved time`).join('\n')
    },randomUUID());
    if (!r.ok) throw Error(JSON.stringify(r)); return r.value as {id:string};
  };
  return { get app(){return app;}, call,value,change,request,clock,access,
    async restart(){await app.close();app=await startLoom(options);} };
}
const automatic = (s: Awaited<ReturnType<typeof setup>>, id: string) => {
  const w = wake(s.app.db,id)!;
  s.change(id,{legacy:{...w.legacy,for_why:'none'}});
};
const cards = (s: Awaited<ReturnType<typeof setup>>) => load(s.app.db).approvals;
const settle = async () => {for(let n=0;n<6;n++)await Promise.resolve();};
it('adopts unknown imports with the actual owner and retains words, deadline, archival data and retry receipt across restart', async () => {
  const s = await setup(), before = wake(s.app.db,ids[0])!;
  expect(before.failures).toBe(3);
  const input = {target:`art:${ids[0]}`}, receipt = randomUUID();
  const result = s.call('clock.vouch',input,owner,receipt);
  expect(result).toEqual({ok:true,value:{done:[ids[0]],gone:[]}});
  const adopted = wake(s.app.db,ids[0])!;
  expect(adopted).toEqual({...before,by:owner,state:'pending',hold:undefined,outcome:'Owner vouched for unknown imported work',vouched:{by:'jonathan',at:s.clock.now()}});
  expect(s.call('clock.vouch',input,owner,receipt)).toEqual(result);
  expect(s.app.db.prepare('SELECT * FROM clock_events').all()).toHaveLength(1);
  await s.restart(); expect(wake(s.app.db,ids[0])).toEqual(adopted);
  s.clock.advance(3600_000); await settle();
  expect(wake(s.app.db,ids[0])).toMatchObject({state:'held',hold:'staging',by:owner});
  expect(s.call('clock.vouch',input).ok).toBe(false);
});
it('applies an owner Allow and spends the exact card atomically, while Deny changes no wakes', async () => {
  const s = await setup(), card = s.request();
  const before = wake(s.app.db,ids[2]);
  expect(s.call('approvals.answer',{id:card.id,action:'allow'}).ok).toBe(true);
  expect(load(s.app.db).approvals.find(a=>a.id===card.id)).toMatchObject({state:'used',by:'jonathan'});
  for (const id of ids.slice(0,2)) expect(wake(s.app.db,id)).toMatchObject({state:'pending',by:owner});
  const denial = s.request([ids[2]]);
  expect(s.call('approvals.answer',{id:denial.id,action:'deny'}).ok).toBe(true);
  expect(wake(s.app.db,ids[2])).toEqual(before);
  expect(s.call('approvals.answer',{id:card.id,action:'allow'}).ok).toBe(false);
});
it('rolls back all adopted rows, approval answer, spend and events if the second row cannot commit', async () => {
  const s = await setup(), card = s.request(), before = wakes(s.app.db), approvals = load(s.app.db);
  s.app.db.exec(`CREATE TRIGGER abort_vouch BEFORE UPDATE ON clock_wakes WHEN NEW.id='w-bbbbbb' BEGIN SELECT RAISE(ABORT,'fixture'); END`);
  expect(s.call('approvals.answer',{id:card.id,action:'allow'})).toMatchObject({ok:false});
  expect(wakes(s.app.db)).toEqual(before); expect(load(s.app.db)).toEqual(approvals);
  expect(s.app.db.prepare('SELECT * FROM clock_events').all()).toEqual([]);
  s.app.db.exec('DROP TRIGGER abort_vouch');
  expect(s.call('approvals.answer',{id:card.id,action:'allow'}).ok).toBe(true);
});
it('keeps gone rows unchanged, adopts only eligible ids, and refuses spending when none remain', async () => {
  const s = await setup(); s.change(ids[1],{state:'cancelled'});
  const gone = wake(s.app.db,ids[1]);
  expect(s.value('clock.vouch',{target:`art:${ids.slice(0,2).join(',')}`})).toEqual({done:[ids[0]],gone:[ids[1]]});
  expect(wake(s.app.db,ids[1])).toEqual(gone);
  const card = s.request([ids[2]]); s.change(ids[2],{hold:'uncertain',attempt:'intent'});
  const before = wakes(s.app.db), approvals = load(s.app.db);
  expect(s.call('approvals.answer',{id:card.id,action:'allow'}).ok).toBe(false);
  expect(wakes(s.app.db)).toEqual(before); expect(load(s.app.db)).toEqual(approvals);
});
it('refuses agents, members, runners and services even when a request body claims owner', async () => {
  const s = await setup(), before = wakes(s.app.db);
  for (const viewer of [{kind:'agent',id:'art'},{kind:'member',id:'pollock'},{kind:'runner',id:'clock-import:unverified'},{kind:'service',id:'clock'}] as Viewer[]) {
    expect(s.call('clock.vouch',{target:`art:${ids[0]}`},viewer)).toMatchObject({ok:false,code:'denied'});
    expect(s.call('clock.vouch',{target:`art:${ids[0]}`,by:owner,for:'owner'},viewer).ok).toBe(false);
  }
  expect(wakes(s.app.db)).toEqual(before);
});
it('rechecks the deciding owner and target create policy, refuses cross-agent and private mixed targets', async () => {
  const s = await setup(), card = s.request();
  const before = wakes(s.app.db);
  s.access.members.jonathan.agents = [];
  expect(s.call('clock.vouch',{target:`art:${ids[0]}`}).ok).toBe(false);
  expect(s.call('approvals.answer',{id:card.id,action:'allow'}).ok).toBe(false);
  expect(wakes(s.app.db)).toEqual(before);
  s.access.members.jonathan.agents = ['art','mark'];
  for (const patch of [{agent:'mark'},{member:'pollock'}]) {
    s.change(ids[1],patch);
    const snapshot = wakes(s.app.db);
    expect(s.call('clock.vouch',{target:`art:${ids.slice(0,2).join(',')}`}).ok).toBe(false);
    expect(wakes(s.app.db)).toEqual(snapshot);
    s.change(ids[1],before[1]);
  }
  s.access.members.jonathan.owner = false;
  expect(s.call('clock.vouch',{target:`art:${ids[0]}`}).ok).toBe(false);
});
it('does not adopt uncertain, recurring, parked, already attributed or capability-bearing work', async () => {
  const s = await setup(), original = wake(s.app.db,ids[0])!;
  const patches: Partial<Wake>[] = [
    {hold:'uncertain'}, {state:'firing'}, {state:'fired'}, {state:'failed'}, {state:'cancelled'}, {state:'pending'},
    {schedule:'art/review'}, {wait:{id:'a-12345678',until:s.clock.now()}}, {attempt:'old-intent'},
    {by:owner}, {by:{kind:'agent',id:'art'}}, {continuation:'cont-x'}, {approval:'a-12345678'}, {slot:'review'}, {place:'alert:x'},
    {prompt:'<!-- house: local -->\nDo work'}, {file:'../outside',prompt:undefined},
    ...['for','kind','schedule','on','continuation','approval','slot','place','_firing','local_approval','standing','standing_target','standing_digest','delivery','deliver_place','prompt'].map(key=>({legacy:{...original.legacy,[key]: key==='for'?'owner':key==='prompt'?'<!-- house: local -->':true}})),
  ];
  for (const patch of patches) {
    s.app.db.prepare('UPDATE clock_wakes SET record=? WHERE id=?').run(JSON.stringify({...original,...patch}),ids[0]); const before = wake(s.app.db,ids[0]);
    expect(s.call('clock.vouch',{target:`art:${ids[0]}`}).ok,JSON.stringify(patch)).toBe(false);
    expect(wake(s.app.db,ids[0])).toEqual(before);
  }
});
it('fails closed with preinstalled uncomposed approvals and rejects malformed application calls', async () => {
  const s = await setup(true), card = s.request(), before = wakes(s.app.db);
  expect(s.call('approvals.answer',{id:card.id,action:'allow'})).toMatchObject({ok:false,code:'unavailable'});
  expect(wakes(s.app.db)).toEqual(before);
  const approval = load(s.app.db).approvals.find(a=>a.id===card.id)!;
  const role = clockVouchApplication(s.app.operations);
  for (const a of [approval,{...approval,state:'allowed',by:'other'},{...approval,kind:'merge',state:'allowed',by:'jonathan'}])
    expect(role.apply(a as typeof approval,'jonathan').ok).toBe(false);
});

it('rejects malformed, unordered, repeated or oversized targets without altering rows', async () => {
  const s = await setup(), before = wakes(s.app.db);
  const oversized = 'art:' + [ids[0], ...Array.from({length:5}, (_,i) => `w-${String(i).padStart(8,'0')}-0000-0000-0000-000000000000`)].sort().join(',');
  expect(oversized.length).toBeGreaterThan(200);
  for (const target of ['art:', 'art:w-AAAAAA', 'art:w-zzzzzz', `art:${ids[1]},${ids[0]}`, `art:${ids[0]},${ids[0]}`,
    oversized])
    expect(s.call('clock.vouch',{target}).ok).toBe(false);
  expect(wakes(s.app.db)).toEqual(before);
});
it('adopts overdue work without bypassing pause, then rechecks authority before dispatch', async () => {
  const s = await setup(); s.clock.advance(3600_000); await settle();
  s.value('clock.pause',{agent:'art'});
  s.value('clock.vouch',{target:`art:${ids[0]}`}); s.clock.advance(0); await settle();
  expect(wake(s.app.db,ids[0])).toMatchObject({state:'held',hold:'paused',by:owner});
  s.value('clock.resume',{agent:'art'});
  s.access.members.jonathan.agents = [];
  s.clock.advance(60_000); await settle();
  expect(wake(s.app.db,ids[0])).toMatchObject({state:'held',hold:'permission'});
});

it('reports invalid executable imports as gone without rolling back other eligible work on the same card', async () => {
  const s = await setup();
  s.change(ids[1],{prompt:undefined,file:'../outside',legacy:{...wake(s.app.db,ids[1])!.legacy,prompt:undefined,prompt_file:'../outside'}});
  const bad = wake(s.app.db,ids[1])!, card = s.request();
  const answer = s.call('approvals.answer',{id:card.id,action:'allow'});
  expect(answer.ok).toBe(true);
  expect(wake(s.app.db,ids[0])).toMatchObject({state:'pending',by:owner,failures:3});
  expect(wake(s.app.db,ids[1])).toEqual(bad);
  const receipt = s.app.db.prepare("SELECT result FROM core_operations WHERE name='clock.vouch'").get() as {result:string};
  expect(JSON.parse(receipt.result)).toEqual({ok:true,value:{done:[ids[0]],gone:[ids[1]]}});
  expect(load(s.app.db).approvals.find(a=>a.id===card.id)?.state).toBe('used');
});

it('offers the live adoption hint only to the current owner for executable eligible work and refreshes it on access loss', async () => {
  const s = await setup();
  s.change(ids[1],{continuation:'unverified-handle'});
  s.change(ids[2],{prompt:undefined,file:'../outside'});
  const sockets: WebSocket[] = [];
  try {
    for (const agent of [false,true]) {
      const ws = new WebSocket(s.app.url.replace('http:','ws:')+'/live',{headers:agent ? {'x-fixture-agent':'art'} : {}}); sockets.push(ws);
      await once(ws,'open');
      const initial = once(ws,'message'); ws.send(JSON.stringify({kind:'subscribe',type:'wake'}));
      const [raw] = await initial;
      const records = JSON.parse(raw.toString()).records as Array<{id:string;canVouch:boolean;canAskVouch:boolean}>;
      expect(records.find(w=>w.id===ids[0])?.canVouch).toBe(!agent);
      expect(records.find(w=>w.id===ids[0])?.canAskVouch).toBe(true);
      expect(records.filter(w=>w.id!==ids[0]).every(w=>w.canVouch===false)).toBe(true);
    }
    const changed = once(sockets[0],'message');
    s.access.members.jonathan.owner = false; s.app.live.refreshAccess();
    const [raw] = await changed;
    expect(JSON.parse(raw.toString()).records.every((w:{canVouch:boolean})=>!w.canVouch)).toBe(true);
    expect(JSON.parse(raw.toString()).records.every((w:{canAskVouch:boolean})=>!w.canAskVouch)).toBe(true);
    expect(s.call('clock.vouch',{target:`art:${ids[0]}`}).ok).toBe(false);
  } finally { for (const ws of sockets) { const closed = once(ws,'close'); ws.terminate(); await closed; } }
});

it('offers a live ask hint only for eligible executable unscoped work under current filing authority', async () => {
  const s = await setup();
  s.change(ids[1],{legacy:{...wake(s.app.db,ids[1])!.legacy,for_why:'steered'}});
  s.change(ids[2],{project:'pond'});
  const ws = new WebSocket(s.app.url.replace('http:','ws:')+'/live',{headers:{'x-fixture-agent':'art'}});
  try {
    await once(ws,'open'); const initial = once(ws,'message');
    ws.send(JSON.stringify({kind:'subscribe',type:'wake'}));
    const [raw] = await initial;
    const records = JSON.parse(raw.toString()).records;
    expect(records.find((w:{id:string})=>w.id===ids[0])?.canAskVouch).toBe(true);
    expect(records.filter((w:{id:string})=>w.id!==ids[0]).every((w:{canAskVouch:boolean})=>w.canAskVouch===false)).toBe(true);
    const changed = once(ws,'message');
    // Malformed executable words remove the hint and the mutation refuses them.
    s.change(ids[0],{prompt:undefined,file:'../outside'}); s.app.live.refreshAccess();
    const [updated] = await changed;
    expect(JSON.parse(updated.toString()).records.every((w:{canAskVouch:boolean})=>!w.canAskVouch)).toBe(true);
    expect(s.call('clock.askVouch',{target:`art:${ids[0]}`},{kind:'agent',id:'art'}).ok).toBe(false);
  } finally { const closed = once(ws,'close'); ws.terminate(); await closed; }
});

it('files an exact owning request, deduplicates retries and overlapping sets, and applies only on owner Allow', async () => {
  const s = await setup(); const agent: Viewer = {kind:'agent',id:'art'};
  const before = wakes(s.app.db), receipt = randomUUID(), input = {target:`art:${ids.slice(0,2).join(',')}`};
  const first = s.call('clock.askVouch',input,agent,receipt);
  expect(first.ok).toBe(true); if (!first.ok) return;
  const card = first.value as {id:string;state:string;target:string};
  expect(card).toMatchObject({state:'pending',target:input.target});
  expect(s.call('clock.askVouch',input,agent,receipt)).toEqual(first);
  expect(s.call('clock.askVouch',input,agent)).toEqual(first);
  expect(load(s.app.db).approvals).toHaveLength(1);
  expect(wakes(s.app.db)).toEqual(before);
  const filed = load(s.app.db).approvals[0];
  expect(filed).toMatchObject({for:'owner',who:{agent:'art',where:"loom's clock"},target:input.target});
  for (const id of ids.slice(0,2)) expect(filed.details).toContain(`${id} fires ${new Date(before.find(w=>w.id===id)!.due).toISOString()}`);
  expect(s.call('clock.askVouch',{target:`art:${ids.slice(1).join(',')}`},agent).ok).toBe(false);
  await s.restart();
  expect(s.call('clock.askVouch',input,agent)).toEqual(first);
  expect(s.call('clock.askVouch',{target:`art:${ids.slice(1).join(',')}`},agent).ok).toBe(false);
  expect(s.call('approvals.answer',{id:card.id,action:'allow'}).ok).toBe(true);
  for (const id of ids.slice(0,2)) expect(wake(s.app.db,id)).toMatchObject({by:owner,state:'pending'});
  expect(wake(s.app.db,ids[2])).toEqual(before[2]);
  expect(load(s.app.db).approvals[0].state).toBe('used');
});
it('keeps denial suppression across restart and different target sets', async () => {
  const s = await setup(), agent: Viewer = {kind:'agent',id:'art'};
  const card = s.value<{id:string}>('clock.askVouch',{target:`art:${ids[0]}`},agent);
  const before = wakes(s.app.db);
  expect(s.call('approvals.answer',{id:card.id,action:'deny'}).ok).toBe(true);
  await s.restart();
  for (const target of [`art:${ids[0]}`,`art:${ids.slice(0,2).join(',')}`]) {
    const r = s.call('clock.askVouch',{target},agent);
    expect(r).toMatchObject({ok:false,code:'denied'});
  }
  expect(load(s.app.db).approvals).toHaveLength(1);
  expect(wakes(s.app.db)).toEqual(before);
});
it('refuses private, other-agent, known-person, capability, malformed and steered requests without filing', async () => {
  const s = await setup(); const input = {target:`art:${ids[0]}`};
  for (const viewer of [{kind:'agent',id:'other'},{kind:'member',id:'guest'},{kind:'runner',id:'runner'},{kind:'service',id:'clock'}] as Viewer[]) {
    expect(s.call('clock.askVouch',input,viewer).ok).toBe(false);
  }
  const original = wake(s.app.db,ids[0])!;
  for (const patch of [
    {member:'private'}, {agent:'other'}, {continuation:'opaque'}, {prompt:'../bad'},
    {legacy:{...original.legacy,for:'person'}}, {legacy:{...original.legacy,continuation:'archived-handle'}}, {legacy:{...original.legacy,for_people:['person']}},
    {legacy:{...original.legacy,for_why:'steered'}}, {legacy:{...original.legacy,for_why:'other-agent'}},
  ] as Partial<Wake>[]) {
    s.change(ids[0],{...original,...patch});
    expect(s.call('clock.askVouch',input,{kind:'agent',id:'art'}).ok).toBe(false);
  }
  expect(load(s.app.db).approvals).toHaveLength(0);
});
it('fails closed when the owning filing role cannot file and rolls back a failed request', async () => {
  const s = await setup(), input={target:`art:${ids[0]}`};
  delete s.access.services.approvals;
  expect(s.call('clock.askVouch',input,{kind:'agent',id:'art'})).toMatchObject({ok:false,code:'denied'});
  expect(load(s.app.db).approvals).toHaveLength(0);
});

it('binds the generated client to one canonical owning request and rejects approval spending', async () => {
  const s = await setup(), agent: Viewer = {kind:'agent',id:'art'};
  const result = s.value<{exit:number;stdout:string}>('clock.command',{argv:['ask-vouch',ids[1],ids[0],ids[1]]},agent);
  expect(result.exit).toBe(0); expect(result.stdout).toContain('asked the owner on loom');
  expect(load(s.app.db).approvals).toHaveLength(1);
  expect(load(s.app.db).approvals[0].target).toBe(`art:${ids.slice(0,2).join(',')}`);
  const bad = s.value<{exit:number}>('clock.command',{argv:['ask-vouch','--approval','a-aaaaaaaa',ids[0]]},agent);
  expect(bad.exit).toBe(2);
  expect(wakes(s.app.db).every(w=>w.state==='held')).toBe(true);
});
it('lets the current owner file but rejects visible work without target give-work authority', async () => {
  const s = await setup(), input = {target:`art:${ids.slice(0,2).join(',')}`};
  s.access.members.jonathan.agents = [];
  expect(s.value<Wake[]>('clock.list',{agent:'art'}).map(w=>w.id)).toContain(ids[1]);
  expect(s.call('clock.askVouch',input)).toMatchObject({ok:false,code:'denied'});
  expect(load(s.app.db).approvals).toHaveLength(0);
  s.access.members.jonathan.agents = ['art'];
  expect(s.call('clock.askVouch',input)).toMatchObject({ok:true,value:{state:'pending'}});
});
it('rolls back a card persisted before an audit failure and permits retry of the same receipt', async () => {
  const s = await setup(), agent: Viewer = {kind:'agent',id:'art'}, receipt=randomUUID();
  const input={target:`art:${ids[0]}`}, before=load(s.app.db), rows=wakes(s.app.db);
  const receipts=s.app.db.prepare('SELECT * FROM core_operations ORDER BY viewer,id').all();
  s.app.db.exec("CREATE TRIGGER fail_filing BEFORE INSERT ON approvals_audit BEGIN SELECT RAISE(ABORT,'fixture'); END");
  expect(s.call('clock.askVouch',input,agent,receipt).ok).toBe(false);
  expect(load(s.app.db)).toEqual(before); expect(wakes(s.app.db)).toEqual(rows);
  expect(s.app.db.prepare('SELECT * FROM core_operations ORDER BY viewer,id').all()).toEqual(receipts);
  s.app.db.exec('DROP TRIGGER fail_filing');
  expect(s.call('clock.askVouch',input,agent,receipt)).toMatchObject({ok:true});
  expect(load(s.app.db).approvals).toHaveLength(1);
});
it('keeps every maximum-size selection id and due time under the owning details cap', async () => {
  const s = await setup(), base=wake(s.app.db,ids[0])!;
  const which=Array.from({length:12},(_,n)=>`w-${n.toString(16).padStart(6,'0')}`).sort();
  for(const id of which) s.app.db.prepare('INSERT INTO clock_wakes VALUES (?,?,?)').run(id,JSON.stringify({...base,id,note:'Ａ'.repeat(3000)}),s.clock.now());
  expect(s.call('clock.askVouch',{target:`art:${which.join(',')}`},{kind:'agent',id:'art'}).ok).toBe(true);
  const details=load(s.app.db).approvals[0].details!;
  expect(details.length).toBeLessThanOrEqual(1000);
  for(const id of which) {
    const line = details.split('\n').find(line => line.startsWith(id))!;
    expect(line).toContain(`${id} fires ${new Date(base.due).toISOString()}`);
    expect(line).toContain('runs: Review my queue');
    expect(line).toContain('...');
  }
});

it('does not copy private or project-scoped saved words into an agent-scoped approval even for an owner', async () => {
  const s=await setup(), original=wake(s.app.db,ids[0])!;
  for(const patch of [{member:'jonathan'},{project:'pond'}]) {
    s.change(ids[0],{...original,...patch,note:'private words'});
    expect(s.call('clock.askVouch',{target:`art:${ids[0]}`})).toMatchObject({ok:false,code:'invalid'});
    expect(load(s.app.db).approvals).toHaveLength(0);
  }
});

it('fails closed with no owning filing composition and leaves no card or receipt', async () => {
  const s=await setup(false,true), before=wakes(s.app.db), approvals=load(s.app.db);
  const receipts=s.app.db.prepare('SELECT * FROM core_operations ORDER BY viewer,id').all();
  expect(s.call('clock.askVouch',{target:`art:${ids[0]}`},{kind:'agent',id:'art'})).toMatchObject({ok:false,code:'unavailable'});
  expect(wakes(s.app.db)).toEqual(before); expect(load(s.app.db)).toEqual(approvals);
  expect(s.app.db.prepare('SELECT * FROM core_operations ORDER BY viewer,id').all()).toEqual(receipts);
});

it('shows what Allow would run alongside the saved note without changing held work', async () => {
  const s = await setup();
  s.change(ids[0], {note:'Queue review', prompt:'Review overdue tasks and report blockers'});
  s.change(ids[1], {note:'Lane review', prompt:undefined, file:'routines/review.md'});
  const before = wakes(s.app.db);
  expect(s.call('clock.askVouch', {target:`art:${ids.slice(0,2).join(',')}`} ).ok).toBe(true);
  const details = load(s.app.db).approvals[0].details!;
  expect(details).toContain('Queue review');
  expect(details).toContain('runs: Review overdue tasks and report blockers');
  expect(details).toContain('Lane review');
  expect(details).toContain('file: routines/review.md');
  expect(wakes(s.app.db)).toEqual(before);
});
it('keeps executable words visible when a note fills the card budget', async () => {
  const s = await setup();
  s.change(ids[0], {note:'Ａ'.repeat(3000), prompt:'Inspect the queue'});
  expect(s.call('clock.askVouch', {target:`art:${ids[0]}`} ).ok).toBe(true);
  const details = load(s.app.db).approvals[0].details!;
  expect(details).toContain('runs: Inspect the queue');
  expect(details).toContain('AAA');
  expect(details.length).toBeLessThanOrEqual(1000);
});

it('uses the card space for the executable excerpt when no note was saved', async () => {
  const s = await setup();
  s.change(ids[0], {note:'', prompt:'Inspect\n' + 'Ｂ'.repeat(2000)});
  expect(s.call('clock.askVouch', {target:`art:${ids[0]}`} ).ok).toBe(true);
  const details = load(s.app.db).approvals[0].details!;
  expect(details).toContain('runs: Inspect BBB');
  expect(details.endsWith('...')).toBe(true);
  expect(details).not.toContain('\n');
  expect(details.length).toBeLessThanOrEqual(1000);
});

it('automatically groups only unsteered own-agent candidates, refreshes for a new candidate, and keeps held rows unchanged', async () => {
  const s = await setup(); automatic(s,ids[0]);
  const before = wakes(s.app.db);
  s.clock.advance(0); await settle();
  const first = cards(s)[0];
  expect(first).toMatchObject({state:'pending',target:`art:${ids[0]}`,who:{where:"loom's clock"},for:'owner'});
  expect(first.details).toContain('runs: Review my queue');
  expect(wakes(s.app.db)).toEqual(before);
  s.clock.advance(60_000); await settle();
  expect(cards(s)).toHaveLength(1);
  automatic(s,ids[1]);
  const updated = wakes(s.app.db);
  s.clock.advance(60_000); await settle();
  expect(cards(s).find(a=>a.id===first.id)).toMatchObject({state:'withdrawn'});
  const second = cards(s).find(a=>a.state==='pending')!;
  expect(second.target).toBe(`art:${ids.slice(0,2).join(',')}`);
  expect(wakes(s.app.db)).toEqual(updated);
  expect(s.call('approvals.answer',{id:second.id,action:'allow'}).ok).toBe(true);
  for (const id of ids.slice(0,2)) expect(wake(s.app.db,id)).toMatchObject({by:owner,state:'pending'});
});
it('never asks denied ids again after restart and lets later candidates through', async () => {
  const s = await setup(); automatic(s,ids[0]);
  s.clock.advance(0); await settle();
  expect(s.call('approvals.answer',{id:cards(s)[0].id,action:'deny'}).ok).toBe(true);
  automatic(s,ids[1]);
  await s.restart(); s.clock.advance(0); await settle();
  expect(cards(s).filter(a=>a.state==='pending').map(a=>a.target)).toEqual([`art:${ids[1]}`]);
  expect(wake(s.app.db,ids[0])).toMatchObject({state:'held',hold:'provenance'});
});
it('automatic selection excludes unverified, steered, other-origin, people, private and invalid executable imports', async () => {
  const s = await setup(), original = wake(s.app.db,ids[0])!;
  for (const patch of [
    {legacy:{...original.legacy,for_why:'unverified'}},
    {legacy:{...original.legacy,for_why:'steered'}},
    {legacy:{...original.legacy,for_why:'none',origin:'agent:mark'}},
    {legacy:{...original.legacy,for_why:'none',for_people:['someone']}},
    {legacy:{...original.legacy,for_why:'none',member:'someone'}},
    {legacy:{...original.legacy,for_why:'none',project:'private'}},
    {legacy:{...original.legacy,for_why:'none'},member:'jonathan'},
    {legacy:{...original.legacy,for_why:'none'},project:'pond'},
    {legacy:{...original.legacy,for_why:'none'},prompt:undefined,file:'../escape'},
  ]) {
    s.change(ids[0],{...original,...patch});
    s.clock.advance(60_000); await settle();
    expect(cards(s)).toEqual([]);
  }
});
it('retains explicitly asked nonautomatic ids while adding automatic candidates, and drops an empty unanswered group', async () => {
  const s = await setup();
  const explicit = s.value<{id:string}>('clock.askVouch',{target:`art:${ids[0]}`},{kind:'agent',id:'art'});
  automatic(s,ids[1]); s.clock.advance(0); await settle();
  expect(cards(s).find(a=>a.id===explicit.id)).toMatchObject({state:'withdrawn'});
  const group = cards(s).find(a=>a.state==='pending')!;
  expect(group.target).toBe(`art:${ids.slice(0,2).join(',')}`);
  for (const id of ids.slice(0,2)) s.change(id,{state:'cancelled'});
  s.clock.advance(60_000); await settle();
  expect(cards(s).find(a=>a.id===group.id)).toMatchObject({state:'withdrawn'});
});
it('rolls back replacement and audit if grouped filing cannot commit', async () => {
  const s = await setup(); automatic(s,ids[0]); s.clock.advance(0); await settle();
  const before = load(s.app.db); automatic(s,ids[1]);
  s.app.db.exec("CREATE TRIGGER fail_group BEFORE INSERT ON approvals_approvals BEGIN SELECT RAISE(ABORT,'fixture'); END");
  s.clock.advance(60_000); await settle();
  expect(load(s.app.db)).toEqual(before);
  s.app.db.exec('DROP TRIGGER fail_group');
  s.clock.advance(60_000); await settle();
  expect(cards(s).find(a=>a.state==='pending')?.target).toBe(`art:${ids.slice(0,2).join(',')}`);
});
it('caps automatic groups at twelve, leaves overflow held, and asks it after the first card is answered', async () => {
  const s = await setup();
  const base = wake(s.app.db,ids[0])!;
  s.change(ids[0],{state:'cancelled'});
  const extra = Array.from({length:14},(_,n)=>`w-${n.toString(16).padStart(6,'0')}`);
  for (const id of extra) s.app.db.prepare('INSERT INTO clock_wakes(id,record,changed_at) VALUES (?,?,?)').run(id,JSON.stringify({...base,id,legacy:{...base.legacy,for_why:'none'}}),s.clock.now());
  s.clock.advance(0); await settle();
  const first = cards(s)[0];
  expect(first.target).toBe(`art:${extra.slice(0,12).join(',')}`);
  expect(first.details!.length).toBeLessThanOrEqual(1000);
  for (const id of extra.slice(0,12)) expect(first.details).toContain(`${id} fires`);
  expect(wake(s.app.db,extra[12])).toMatchObject({state:'held',hold:'provenance'});
  expect(s.call('approvals.answer',{id:first.id,action:'deny'}).ok).toBe(true);
  s.clock.advance(60_000); await settle();
  expect(cards(s).find(a=>a.state==='pending')?.target).toBe(`art:${extra.slice(12).join(',')}`);
});
it('fails closed when the automatic filing operation lacks service access and refuses body calls', async () => {
  const s = await setup(); automatic(s,ids[0]);
  const before = wakes(s.app.db);
  s.access.services.approvals.operations = ['approvals.piece-request'];
  s.clock.advance(0); await settle();
  expect(cards(s)).toEqual([]); expect(wakes(s.app.db)).toEqual(before);
  s.access.services.approvals.operations.push('approvals.piece-group-vouch');
  expect(s.call('approvals.piece-group-vouch',{caller:{who:{agent:'art',where:"loom's clock"},for:'owner'},candidates:[]},{kind:'agent',id:'art'})).toMatchObject({ok:false,code:'denied'});
  expect(cards(s)).toEqual([]); expect(wakes(s.app.db)).toEqual(before);
});

it('skips unsupported imported ids without blocking valid automatic candidates', async () => {
  const s = await setup(); automatic(s,ids[0]);
  const base = wake(s.app.db,ids[0])!;
  const bad={...base,id:'w-legacy'};
  s.app.db.prepare('INSERT INTO clock_wakes(id,record,changed_at) VALUES (?,?,?)').run(bad.id,JSON.stringify(bad),s.clock.now());
  s.clock.advance(0); await settle();
  expect(cards(s).map(a=>a.target)).toEqual([`art:${ids[0]}`]);
  expect(wake(s.app.db,bad.id)).toEqual(bad);
});
it('keeps grouping direct-only even for an otherwise authorized service', async () => {
  const s=await setup(), input={caller:{who:{agent:'art',where:"loom's clock"},for:'owner'},candidates:[]};
  const viewer: Viewer={kind:'service',id:'approvals'};
  expect(s.app.operations.call('direct',viewer,'approvals.piece-group-vouch',input,randomUUID())).toMatchObject({ok:true,value:null});
  for(const door of ['http','socket','mcp'] as const)
    expect(s.app.operations.call(door,viewer,'approvals.piece-group-vouch',input,randomUUID())).toMatchObject({ok:false});
  expect(cards(s)).toEqual([]);
});
