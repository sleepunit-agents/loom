import { once } from 'node:events';
import { WebSocket } from 'ws';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startLoom } from '../../foundation.js';
import { fixture, installFixture } from '../../fixture.js';
import { FakeClock } from '../clock.js';
import { HouseholdDatabase } from './document.js';
import { HouseholdRows } from './rows.js';
import { TokenDatabase } from './tokens.js';
import { SharingDatabase } from './sharing.js';
import { changeHouseholdMember } from './members.js';
import { signin } from '../signin/index.js';
import type { Viewer } from '../../policy.js';

const homes: string[] = [], closes: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
const owner: Viewer = { kind: 'member', id: 'jonathan' };
async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'household-members-')); homes.push(home); fixture(home);
  const clock = new FakeClock();
  const app = await startLoom({ next: true, home, clock, install: installFixture }); closes.push(app.close);
  const household = new HouseholdDatabase(app.db), tokens = new TokenDatabase(app.db);
  return { app, home, clock, household, tokens };
}

it('adds, changes and removes members only through household-owner policy on all doors', async () => {
  const { app, home, household } = await setup();
  const before = household.document();
  for (const operation of ['household.setMember', 'household.removeMember']) {
    for (const door of ['http', 'socket', 'mcp', 'direct'] as const) {
      for (const viewer of [{kind:'member',id:'pollock'}, {kind:'member',id:'missing'}, {kind:'agent',id:'art'}, {kind:'runner',id:'box'}, {kind:'service',id:'sharing'}] as Viewer[]) {
        expect(app.operations.call(door, viewer, operation, {person:'guest', ...(operation.endsWith('setMember') ? {agents:['art']} : {})}, `${operation}:${door}:${viewer.id}`)).toMatchObject({code:'denied'});
      }
    }
  }
  expect(household.document()).toEqual(before);
  expect(() => changeHouseholdMember(app.db, home, 'guest', ['art'])).toThrow('transaction');
  for (const door of ['http', 'socket', 'mcp', 'direct'] as const) {
    expect(app.operations.call(door, owner, 'household.setMember', {person:'guest',agents:['art','art']}, `add:${door}`)).toMatchObject({ok:true,value:expect.arrayContaining([{person:'guest',role:'owner',agents:['art']}])});
    expect(new SharingDatabase(app.db, home).sharing().members.guest).toEqual({owner:false,agents:['art']});
    expect(app.operations.call(door, {kind:'member',id:'guest'}, 'household.removeMember', {person:'pollock'}, `scoped:${door}`)).toMatchObject({code:'denied'});
    expect(app.operations.call(door, owner, 'household.removeMember', {person:'guest'}, `remove:${door}`)).toMatchObject({ok:true});
    expect(household.document()).toEqual(before);
  }
});

it('preserves raw fields, projects and credentials; supports ordinary members and owner-only legacy fallback', async () => {
  const { app, home, household, tokens } = await setup();
  app.db.transaction(() => household.change(home, raw => {
    raw.extra={nested:['retain']}; raw.default='mark';
    (raw.members as Array<Record<string,unknown>>)[1].extra={member:true};
  }))();
  const before=household.document()!, projects=new HouseholdRows(app.db,'projects').entries(), credentials=tokens.document();
  const set=(person:string,agents:'*'|string[])=>app.operations.call('direct',owner,'household.setMember',{person,agents},`set:${person}:${JSON.stringify(agents)}`);
  expect(set('pollock',[])).toMatchObject({ok:true});
  expect(household.document()).toEqual({...before,members:[(before.members as unknown[])[0],{...(before.members as Array<Record<string,unknown>>)[1],agents:[]}]});
  expect(set('pollock','*')).toMatchObject({ok:true});
  expect(new SharingDatabase(app.db,home).sharing().members.pollock.owner).toBe(true);
  expect(household.household(home)?.members[1].role).toBe('owner');
  expect(set('pollock',['mark'])).toMatchObject({ok:true});
  expect(household.household(home)?.members[1]).toEqual({person:'pollock',role:'owner',agents:['mark']});
  expect(new HouseholdRows(app.db,'projects').entries()).toEqual(projects);
  expect(tokens.document()).toEqual(credentials);
  app.db.transaction(()=>household.replace(home,{v:1,agents:['art'],owner:'legacy',extra:{retain:true}}))();
  expect(app.operations.call('direct',{kind:'member',id:'legacy'},'household.setMember',{person:'new-owner',agents:'*'},'legacy-add')).toMatchObject({ok:true});
  expect(household.document()).toEqual({v:1,agents:['art'],owner:'legacy',extra:{retain:true},members:[{person:'legacy',role:'owner',agents:'*'},{person:'new-owner',role:'owner',agents:'*'}]});
});

it('refuses the last household owner, unknown removals and invalid input without writes', async () => {
  const {app,household}=await setup(), before=household.document();
  for (const input of [{person:'jonathan',agents:['art']},{person:'jonathan',agents:[]},{person:'guest',agents:['missing']},{person:'../bad',agents:'*'},{person:'guest',agents:[]},{person:'guest',agents:'*',role:'owner'}]) {
    expect(app.operations.call('direct',owner,'household.setMember',input,'invalid')).toMatchObject({code:'invalid'});
  }
  expect(app.operations.call('direct',owner,'household.removeMember',{person:'jonathan'},'last')).toMatchObject({code:'invalid'});
  expect(app.operations.call('direct',owner,'household.removeMember',{person:'absent'},'absent')).toMatchObject({code:'not-found'});
  expect(household.document()).toEqual(before);
});

it.each(['remove','narrow'] as const)('pins first-owner token bindings before %s and never transfers browser credentials', async action => {
  const {app,home,household,tokens}=await setup();
  const unbound='a'.repeat(64), revoked='b'.repeat(64), explicit='c'.repeat(64), other='d'.repeat(64);
  tokens.change(rows=>rows.push(...[
    {sha256:unbound,role:'owner',label:'old',created:'2026-01-01'},
    {sha256:revoked,role:'owner',label:'revoked',created:'2026-01-01',revoked:'2026-02-01'},
    {sha256:explicit,role:'owner',member:'pollock',label:'explicit',created:'2026-01-01'},
    {sha256:other,role:'agent:art',label:'agent',created:'2026-01-01'},
  ]));
  const s=signin(app), sessionId='e'.repeat(64);
  // Imported browser sessions resolve their original credential digest on every use.
  const { createHash } = await import('node:crypto');
  new HouseholdRows(app.db,'sessions').put(createHash('sha256').update(sessionId).digest('hex'),{secret:unbound,issuedAt:s.now()});
  expect(s.token(unbound)?.viewer).toEqual(owner); expect(s.session(sessionId)?.viewer).toEqual(owner);
  expect(app.operations.call('direct',owner,'household.setMember',{person:'second',agents:'*'},'second')).toMatchObject({ok:true});
  const before=tokens.document()!;
  const refreshes:boolean[]=[], refresh=app.live.refreshAccess.bind(app.live);
  app.live.refreshAccess=()=>{refreshes.push(app.db.inTransaction);refresh();};
  const result=app.operations.call('http',owner,action==='remove'?'household.removeMember':'household.setMember',{person:'jonathan',...(action==='narrow'?{agents:['art']}: {})},'first-change');
  expect(result).toMatchObject({ok:true}); expect(refreshes).toEqual([false]);
  expect(household.household(home)?.members.find(m=>m.agents==='*')?.person).toBe('second');
  expect(tokens.document()).toEqual({...before,tokens:before.tokens.map(t=>t.role==='owner'&&t.member===undefined?{...t,member:'jonathan'}:t)});
  expect(s.token(unbound)?.viewer).toEqual(action==='remove'?undefined:owner);
  expect(s.session(sessionId)?.viewer).toEqual(action==='remove'?undefined:owner);
  expect(s.token(explicit)?.viewer).toEqual({kind:'member',id:'pollock'});
  expect(s.token(other)?.viewer).toEqual({kind:'agent',id:'art'});
  expect(s.token(revoked)).toBeUndefined();
});

it('rolls back membership, token pinning, receipt and events, and replays after restart without reverting a later change', async () => {
  const {app,home,clock,household,tokens}=await setup();
  tokens.change(rows=>rows.push({sha256:'a'.repeat(64),role:'owner',label:'unbound',created:'2026-01-01'}));
  expect(app.operations.call('direct',owner,'household.setMember',{person:'second',agents:'*'},'second')).toMatchObject({ok:true});
  const before=household.document(), credentials=tokens.document(), events:unknown[]=[];
  app.live.observe(changes=>{if(changes.length)events.push({changes,inTransaction:app.db.inTransaction});});
  for (const [name,sql] of [
    ['fail_member',"BEFORE DELETE ON household_members WHEN OLD.id='jonathan'"],
    ['fail_receipt',"BEFORE INSERT ON core_operations WHEN NEW.id='remove-first'"],
  ]) {
    app.db.exec(`CREATE TRIGGER ${name} ${sql} BEGIN SELECT RAISE(ABORT, 'failure'); END`);
    expect(app.operations.call('direct',owner,'household.removeMember',{person:'jonathan'},'remove-first')).toMatchObject({code:'unavailable'});
    expect(household.document()).toEqual(before); expect(tokens.document()).toEqual(credentials); expect(events).toEqual([]);
    expect(app.db.prepare("SELECT * FROM core_operations WHERE id='remove-first'").get()).toBeUndefined();
    app.db.exec(`DROP TRIGGER ${name}`);
  }
  const result=app.operations.call('direct',owner,'household.removeMember',{person:'jonathan'},'remove-first');
  expect(result).toMatchObject({ok:true});
  expect(events).toEqual([{inTransaction:false,changes:[{type:'household.sharing',id:'household'},{type:'core.access',id:'household'}]}]);
  await app.close();
  const reopened=await startLoom({next:true,home,clock,install:installFixture}); closes.push(reopened.close);
  expect(signin(reopened).token('a'.repeat(64))).toBeUndefined();
  const second:Viewer={kind:'member',id:'second'};
  expect(reopened.operations.call('direct',second,'household.setMember',{person:'third',agents:['mark']},'later')).toMatchObject({ok:true});
  const current=new HouseholdDatabase(reopened.db).document(), replayEvents:unknown[]=[];
  reopened.live.observe(changes=>{if(changes.length)replayEvents.push(changes);});
  // The stored response survives caller removal; transport authentication still refuses their token.
  expect(reopened.operations.call('mcp',owner,'household.removeMember',{person:'jonathan'},'remove-first')).toEqual(result);
  expect(new HouseholdDatabase(reopened.db).document()).toEqual(current); expect(replayEvents).toEqual([]);
});

it('evicts removed-member records from an open window after commit', async () => {
  const member:Viewer={kind:'member',id:'pollock'};
  // Trusted fixture authentication stays valid to isolate policy refresh itself.
  const home=mkdtempSync(join(tmpdir(),'member-window-'));homes.push(home);fixture(home);
  const liveApp=await startLoom({next:true,home,clock:new FakeClock(),install:installFixture,authenticate:()=>({viewer:member,valid:()=>true})});closes.push(liveApp.close);
  const ws=new WebSocket(liveApp.url.replace('http:','ws:')+'/live');closes.push(()=>ws.terminate());
  const messages:unknown[]=[],pending:Array<(v:unknown)=>void>=[];
  ws.on('message',raw=>{const v:unknown=JSON.parse(raw.toString()),receive=pending.shift();if(receive)receive(v);else messages.push(v);});
  const next=()=>messages.length?Promise.resolve(messages.shift()):new Promise<unknown>(resolve=>pending.push(resolve));
  await once(ws,'open');ws.send(JSON.stringify({kind:'subscribe',type:'example.record'}));
  expect(await next()).toMatchObject({kind:'set',records:expect.arrayContaining([expect.objectContaining({id:'pollock-thread'})])});
  const refreshes:boolean[]=[],refresh=liveApp.live.refreshAccess.bind(liveApp.live);
  liveApp.live.refreshAccess=()=>{refreshes.push(liveApp.db.inTransaction);refresh();};
  expect(liveApp.operations.call('direct',owner,'household.removeMember',{person:'pollock'},'remove')).toMatchObject({ok:true});
  expect(refreshes).toEqual([false]);
  expect(await next()).toMatchObject({kind:'set',records:[]});
});

it('refuses a removed member over HTTP and closes their authenticated socket immediately', async () => {
  const {app,tokens}=await setup();
  const {createHash}=await import('node:crypto'), bearer='fixture-member-bearer';
  tokens.change(rows=>rows.push({sha256:createHash('sha256').update(bearer).digest('hex'),role:'owner',member:'pollock',label:'Pollock',created:'2026-01-01'}));
  const headers={authorization:`Bearer ${bearer}`,'content-type':'application/json'};
  const response=()=>fetch(`${app.url}/api/tasks/list`,{method:'POST',headers,body:JSON.stringify({input:{}})});
  expect((await response()).status).toBe(200);
  const ws=new WebSocket(app.url.replace('http:','ws:')+'/live',{headers});closes.push(()=>ws.terminate());
  await once(ws,'open');const closed=once(ws,'close');
  expect(app.operations.call('direct',owner,'household.removeMember',{person:'pollock'},'remove-pollock')).toMatchObject({ok:true});
  await closed;
  expect((await response()).status).toBe(401);
});
