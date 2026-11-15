import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { HouseholdDatabase } from '../../core/household/document.js';
import { fixture } from '../../fixture.js';
import { startLoom } from '../../foundation.js';
import { FakeClock, operation, migrate, type RecordType, type Viewer } from '../../core/index.js';
import { installAttention } from './index.js';
import { attentionMigrations } from './schema/index.js';
import { installTasks } from '../tasks/index.js';
import type { ActionOutcome } from './outcomes.js';
const cleanup: (()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const alice:Viewer={kind:'member',id:'alice'},bob:Viewer={kind:'member',id:'bob'};
async function setup(upgrade=false, householdMembers=false) {
  const home=mkdtempSync(join(tmpdir(),'attention-outcomes-'));fixture(home);
  const clock=new FakeClock(), types=new Map<string,RecordType>();
  // Keep installed maintenance admitted while receipt tests advance thirty days.
  const access={members:{alice:{owner:true,agents:['art']},bob:{owner:false,agents:['art']}},projects:{},services:{attention:{types:['attention.ask'],operations:['attention.sweepWaits','attention.pendingWaits']}}};
  const app=await startLoom({home,next:true,host:'127.0.0.1',port:0,stdout:()=>{},clock,sharing:()=>access,
    authenticate:req=>({viewer:req.headers.authorization==='bob'?bob:alice,window:req.headers.authorization!=='api',valid:()=>true}),
    install:app=>{if(householdMembers)new HouseholdDatabase(app.db).change(home,raw=>{raw.members=[{person:'alice',role:'owner',agents:'*'},{person:'bob',role:'owner',agents:'*'}];delete raw.owner;});const register=app.live.register.bind(app.live);app.live.register=t=>{types.set(t.name,t);register(t);};if(upgrade){migrate(app.db,'attention',attentionMigrations.filter(m=>m.number<=6));app.db.prepare('INSERT INTO attention_asks VALUES (?,?)').run('old',JSON.stringify({id:'old',agent:'art',ask:'Existing question',source:{kind:'piece',id:'fixture'},state:'open',createdAt:1,changedAt:1}));}installAttention(app.db,app.operations,app.live,()=>access);installTasks(app.db,app.operations,app.live,()=>access);},
  });
  cleanup.push(async()=>{await app.close();rmSync(home,{recursive:true,force:true});});
  const list=(viewer=alice)=>{const result=app.operations.call('direct',viewer,'attention.outcomes',{});expect(result.ok).toBe(true);return (result as {value:ActionOutcome[]}).value;};
  async function socket(identity='alice') {
    const ws=new WebSocket(app.url.replace('http:','ws:')+'/live',{headers:{authorization:identity}});
    const messages:any[]=[]; // wire fixtures, not domain data
    const listeners=new Set<()=>void>();
    ws.on('message',data=>{messages.push(JSON.parse(data.toString()));for(const f of listeners)f();});
    await once(ws,'open');cleanup.push(async()=>{ws.terminate();});
    const receive=(predicate:(m:any)=>boolean)=>new Promise<any>(resolve=>{const check=()=>{const n=messages.findIndex(predicate);if(n>=0){listeners.delete(check);resolve(messages.splice(n,1)[0]);}};listeners.add(check);check();});
    let n=0;
    return {ws,receive,async call(name:string,input:unknown,id=`write-${++n}`){const request=`req-${++n}`;ws.send(JSON.stringify({kind:'call',request,name,input,id}));return (await receive(m=>m.kind==='result'&&m.request===request)).result;}};
  }
  return {app,home,clock,access,types,list,socket};
}
it('retains real task success and domain/transport errors for the window member, without result or input words',async()=>{
  const {app,list,socket,types}=await setup(),client=await socket();
  expect(await client.call('tasks.create',{cli:true,title:'private draft words',goal:'goal',why:'why'},'create')).toMatchObject({ok:true,value:{result:{ok:true}}});
  const first=list();expect(first).toMatchObject([{ok:true,member:'alice',source:'tasks',sourceLabel:'Tasks',page:'/p/tasks-preview',text:'Create task: saved.'}]);
  expect(JSON.stringify(first)).not.toContain('private draft words');
  expect(await client.call('tasks.create',{},'bad-domain')).toMatchObject({ok:true,value:{result:{ok:false}}});
  expect(list()[0]).toMatchObject({ok:false,text:'Create task: could not be saved.'});
  expect(await client.call('attention.answer',{id:'hidden',answer:{kind:'words',text:'SECRET'}},'bad-transport')).toMatchObject({ok:false});
  expect(list()[0]).toMatchObject({ok:false,text:'Record answer: could not be saved.'});
  expect(JSON.stringify(list())).not.toMatch(/SECRET|Permission denied|hidden/);
  expect(list(bob)).toEqual([]);
  const type=types.get('attention.outcome')!;
  for(const id of type.ids(undefined)){expect(type.read(id,bob)).toBeUndefined();expect(type.read(id,{kind:'agent',id:'art'})).toBeUndefined();}
  const id=list()[0].id;
  expect(app.operations.call('direct',bob,'attention.readOutcome',{id},'forged')).toMatchObject({ok:false,code:'denied'});
  expect(app.operations.call('direct',alice,'attention.readOutcome',{id,member:'bob'},'forged2')).toMatchObject({ok:false,code:'invalid'});
  expect(app.operations.call('direct',alice,'attention.readOutcome',{id},'read')).toMatchObject({ok:true,value:{read:true}});
});
it('publishes to a second window, persists across reopening, and never creates an ask',async()=>{
  const {app,home,clock,list,socket,types}=await setup();const writer=await socket(),reader=await socket();
  writer.ws.send(JSON.stringify({kind:'subscribe',type:'attention.outcome'}));await writer.receive(m=>m.kind==='set');
  reader.ws.send(JSON.stringify({kind:'subscribe',type:'attention.outcome'}));expect((await reader.receive(m=>m.kind==='set')).records).toEqual([]);
  await writer.call('tasks.create',{cli:true,title:'A task',goal:'goal',why:'why'},'one');
  const change=await reader.receive(m=>m.kind==='put'&&m.type==='attention.outcome');expect(change.record).toEqual(list()[0]);
  expect(types.get('attention.ask')!.ids(undefined)).toEqual([]);
  const outcomeId=list()[0].id;
  expect(await reader.call('attention.readOutcome',{id:outcomeId},'read-persist')).toMatchObject({ok:true,value:{read:true}});
  const readChange=await writer.receive(m=>m.kind==='put'&&m.type==='attention.outcome'&&m.record.readAt!==undefined);
  expect(readChange.record).toMatchObject({id:outcomeId,readAt:clock.now()});
  const firstRead=list()[0].readAt;clock.advance(1000);
  expect(await reader.call('attention.readOutcome',{id:outcomeId},'read-again')).toMatchObject({ok:true});
  expect(list()[0].readAt).toBe(firstRead);
  expect(app.db.prepare('SELECT * FROM attention_read_marks').all()).toEqual([]);
  const expected=list();await app.close();
  const next=await startLoom({home,next:true,clock,stdout:()=>{},sharing:()=>({members:{alice:{owner:true,agents:['art']}},projects:{},services:{attention:{types:['attention.ask'],operations:['attention.sweepWaits','attention.pendingWaits']}}})});
  cleanup.push(next.close);
  expect(next.operations.call('direct',alice,'attention.outcomes',{})).toEqual({ok:true,value:expected});
});
it('keeps newest 50 per member at the same clock tick and does not resurrect a trimmed retry',async()=>{
  const {app,list,socket}=await setup(),a=await socket(),b=await socket('bob');
  const input={id:'missing',answer:{kind:'yes'}};
  for(let n=0;n<53;n++) await a.call('attention.answer',input,`attempt-${n}`);
  expect(list()).toHaveLength(50);expect(list().map(record=>record.order)).toEqual(Array.from({length:50},(_,i)=>53-i));const first=list()[0];
  await a.call('attention.answer',input,'attempt-0');expect(list()).toHaveLength(50);expect(list()[0]).toEqual(first);
  await b.call('attention.answer',input,'attempt-0');expect(list(bob)).toHaveLength(1);expect(list()).toHaveLength(50);
  expect(app.db.prepare('SELECT count(*) AS n FROM attention_outcomes').get()).toEqual({n:51});
});
it('excludes background/API calls, unknown operations, reads, private Comms and secret output; revoked members lose history',async()=>{
  const {app,list,socket,types,access}=await setup(),a=await socket(),api=await socket('api');
  app.operations.register(operation({name:'secrets.show',write:true,input:z.object({}),output:z.string(),may:()=>true,run:()=> 'one-time-secret'}));
  expect(await a.call('secrets.show',{})).toEqual({ok:true,value:'one-time-secret'});
  await a.call('comms.replyToAsk',{ref:'hidden',text:'private words'});
  await a.call('attention.markRead',{id:'hidden'});
  await a.call('attention.outcomes',{});
  await api.call('attention.answer',{id:'hidden',answer:{kind:'yes'}});
  app.operations.call('direct',alice,'attention.answer',{id:'hidden',answer:{kind:'yes'}},'direct');
  expect(list()).toEqual([]);
  await a.call('attention.answer',{id:'hidden',answer:{kind:'yes'}});
  const record=list()[0];delete (access.members as Record<string,unknown>).alice;
  expect(types.get('attention.outcome')!.read(record.id,alice)).toBeUndefined();
  expect(app.operations.call('direct',alice,'attention.outcomes',{})).toMatchObject({ok:false,code:'denied'});
});

it('adds schema seven to a version-six home without changing held asks and reapplies without deleting outcomes',async()=>{
  const {app,list,socket}=await setup(true);
  const before=app.db.prepare('SELECT * FROM attention_asks').all();
  expect(before).toHaveLength(1);
  expect(app.db.prepare("SELECT max(number) AS n FROM core_migrations WHERE piece='attention'").get()).toEqual({n:7});
  const client=await socket();await client.call('attention.answer',{id:'missing',answer:{kind:'yes'}},'upgrade');
  const outcomes=list();expect(outcomes).toHaveLength(1);
  migrate(app.db,'attention',attentionMigrations);
  expect(list()).toEqual(outcomes);expect(app.db.prepare('SELECT * FROM attention_asks').all()).toEqual(before);
});

it('records every advertised Tasks mutation with its real result and commit order',async()=>{
  const {list,socket}=await setup(),client=await socket();let serial=0;
  const run=async(verb:string,input:object)=>{const result=await client.call(`tasks.${verb}`,{cli:true,...input},`task-action-${++serial}`);expect(result).toMatchObject({ok:true,value:{result:{ok:true}}});expect(list()[0]).toMatchObject({operation:`tasks.${verb}`,ok:true});return result.value.result;};
  const first=await run('create',{title:'First task',goal:'goal',why:'why'});
  const second=await run('create',{title:'Second task',goal:'goal',why:'why'});
  for(const verb of ['claim','unclaim'])await run(verb,{id:first.id});
  await run('close',{id:first.id,reason:'Finished'});await run('reopen',{id:first.id});
  await run('update',{id:first.id,set:{title:'Updated task'}});
  await run('comment',{id:first.id,text:'Comment words stay in Tasks'});
  await run('link',{id:first.id,dependsOn:second.id,type:'blocks'});
  await run('unlink',{id:first.id,dependsOn:second.id,type:'blocks'});
  await run('delete',{id:second.id});
  expect(list().map(record=>record.operation)).toEqual(['delete','unlink','link','comment','update','reopen','close','unclaim','claim','create','create'].map(verb=>`tasks.${verb}`));
  expect(JSON.stringify(list())).not.toContain('Comment words stay in Tasks');
});
it('captures a new action after retry expiry even if the old outcome remains in the newest fifty',async()=>{
  const {clock,list,socket}=await setup(),client=await socket();
  let now=clock.now();clock.now=()=>now;
  const input={cli:true,title:'An ordinary task',goal:'goal',why:'why'};
  const before=await client.call('tasks.create',input,'reusable');expect(before).toMatchObject({ok:true,value:{result:{ok:true}}});
  const first=list()[0];now+=30*86400_000;
  const after=await client.call('tasks.create',input,'reusable');expect(after).toMatchObject({ok:true,value:{result:{ok:true}}});
  expect(after.value.result.id).not.toBe(before.value.result.id);
  expect(list()).toHaveLength(2);expect(list()[0].id).not.toBe(first.id);expect(list()[1]).toEqual(first);
  expect(await client.call('tasks.create',input,'reusable')).toEqual(after);expect(list()).toHaveLength(2);
});
it('keeps already-answered fresh-id conflicts quiet',async()=>{
  const {app,list,socket}=await setup(),client=await socket();
  app.operations.call('direct',alice,'attention.raise',{id:'question',agent:'art',ask:'Continue?',source:{kind:'piece',id:'test'}},'raise-question');
  const input={id:'question',answer:{kind:'yes'}};
  expect(await client.call('attention.answer',input,'first-answer')).toMatchObject({ok:true});
  const before=list();expect(before).toHaveLength(1);
  expect(await client.call('attention.answer',input,'duplicate-answer')).toMatchObject({ok:false,code:'conflict'});
  expect(list()).toEqual(before);
});
it('preserves committed action and socket result when the optional notice transaction fails',async()=>{
  const {app,list,socket}=await setup(),client=await socket();
  app.db.exec("CREATE TRIGGER reject_notice BEFORE INSERT ON attention_outcomes BEGIN SELECT RAISE(ABORT, 'Fixture notice failure'); END;");
  const result=await client.call('tasks.create',{cli:true,title:'Keep this task',goal:'goal',why:'why'},'survive');
  expect(result).toMatchObject({ok:true,value:{result:{ok:true,created:true}}});
  expect(app.operations.call('direct',alice,'tasks.show',{id:result.value.result.id})).toMatchObject({ok:true});
  expect(list()).toEqual([]);
  expect(app.db.prepare('SELECT * FROM attention_outcome_seen').all()).toEqual([]);
  app.db.exec('DROP TRIGGER reject_notice');
  // The retry repairs its notice without repeating the committed action.
  expect(await client.call('tasks.create',{cli:true,title:'Keep this task',goal:'goal',why:'why'},'survive')).toEqual(result);
  expect(list()).toMatchObject([{operation:'tasks.create',ok:true}]);
});

it('uses the original retry deadline when a notice is repaired late, then captures reused-id work',async()=>{
  const {app,clock,list,socket}=await setup(),client=await socket();
  let now=clock.now();clock.now=()=>now;
  const input={cli:true,title:'Delayed notice task',goal:'goal',why:'why'};
  app.db.exec("CREATE TRIGGER reject_late_notice BEFORE INSERT ON attention_outcomes BEGIN SELECT RAISE(ABORT, 'Fixture notice failure'); END;");
  const first=await client.call('tasks.create',input,'late-repair');expect(first).toMatchObject({ok:true,value:{result:{ok:true}}});expect(list()).toEqual([]);
  now+=29*86400_000;app.db.exec('DROP TRIGGER reject_late_notice');
  expect(await client.call('tasks.create',input,'late-repair')).toEqual(first);expect(list()).toHaveLength(1);
  const originalDeadline=app.operations.retryDeadline(alice,'late-repair','tasks.create')!;
  expect(app.db.prepare('SELECT expires FROM attention_outcome_seen').get()).toEqual({expires:originalDeadline});
  now+=86400_000;
  const second=await client.call('tasks.create',input,'late-repair');expect(second.value.result.id).not.toBe(first.value.result.id);expect(list()).toHaveLength(2);
});
it('retains a later success for the same id after an unreceipted rejection',async()=>{
  const {app,list,socket}=await setup(),client=await socket();
  const input={id:'later-ask',answer:{kind:'yes'}};
  expect(await client.call('attention.answer',input,'recover-rejected')).toMatchObject({ok:false});
  app.operations.call('direct',alice,'attention.raise',{id:'later-ask',agent:'art',ask:'Continue?',source:{kind:'piece',id:'test'}},'raise-later');
  expect(await client.call('attention.answer',input,'recover-rejected')).toMatchObject({ok:true});
  expect(list().map(item=>item.ok)).toEqual([true,false]);
});

it('does not let a conflicting-input retry poison repair of the original successful outcome',async()=>{
  const {app,list,socket}=await setup(),client=await socket();
  const input={cli:true,title:'Original successful task',goal:'goal',why:'why'};
  app.db.exec("CREATE TRIGGER reject_conflict_notice BEFORE INSERT ON attention_outcomes BEGIN SELECT RAISE(ABORT, 'Fixture notice failure'); END;");
  const first=await client.call('tasks.create',input,'repair-conflict');expect(first).toMatchObject({ok:true,value:{result:{ok:true}}});expect(list()).toEqual([]);
  app.db.exec('DROP TRIGGER reject_conflict_notice');
  expect(await client.call('tasks.create',{...input,title:'Conflicting new input'},'repair-conflict')).toMatchObject({ok:false,code:'conflict'});
  expect(list()).toMatchObject([{ok:false}]);
  expect(await client.call('tasks.create',input,'repair-conflict')).toEqual(first);
  expect(list().map(record=>record.ok)).toEqual([true,false]);
  expect(await client.call('tasks.create',input,'repair-conflict')).toEqual(first);expect(list()).toHaveLength(2);
});
it('expires unreceipted rejection deduplication at exactly thirty days',async()=>{
  const {clock,list,socket}=await setup(),client=await socket();const input={id:'absent',answer:{kind:'yes'}};
  // Move the receipt wall clock without running thirty days of unrelated
  // periodic jobs. Incoming real socket calls still exercise the boundary.
  let now=clock.now();clock.now=()=>now;
  await client.call('attention.answer',input,'rejection-expiry');const first=list()[0];
  now+=30*86400_000-1;await client.call('attention.answer',input,'rejection-expiry');expect(list()).toEqual([first]);
  now+=1;await client.call('attention.answer',input,'rejection-expiry');expect(list()).toHaveLength(2);expect(list()[1]).toEqual(first);
});

it('files other apps’ actual window mutations with fixed owning links, without authored result or error words',async()=>{
  const {list,socket}=await setup(false,true),client=await socket();
  const examples: [string,object,string,string][] = [
    ['household.setProfile',{agent:'art',text:'Sensitive authored description'},'Household setup','/p/setup-preview'],
    ['household.createProject',{slug:'receipt-fixture',name:'Private project title',repositories:[],members:['alice'],agents:['art']},'Sharing','/p/sharing-preview'],
    ['clock.pause',{agent:'art'},'Clock','/p/clock-preview'],
    ['clock.resume',{agent:'art'},'Clock','/p/clock-preview'],
    ['changes.refresh',{},'Changes','/p/changes-preview'],
  ];
  for (const [name,input,sourceLabel,page] of examples) {
    expect(await client.call(name,input,`actual-${name}`),name).toMatchObject({ok:true});
    expect(list()[0]).toMatchObject({operation:name,ok:true,sourceLabel,page});
    const count=list().length;
    await client.call(name,input,`actual-${name}`);expect(list()).toHaveLength(count);
  }
  for (const [name,input,sourceLabel,page] of [
    ['approvals.answer',{id:'a-12345678',action:'allow'},'Approvals','/p/approvals-preview'],
    ['mind.knowledgeVerify',{slug:'absent-private-title'},'Knowledge','/p/knowledge-preview'],
    ['mind.personAdd',{},'People','/p/people-preview'],
    ['bridges.putRoutes',{},'Bridges','/p/bridges-preview'],
    ['core.releaseEffect',{id:'absent-effect'},'Staging','/p/staging'],
  ] as [string,object,string,string][]) {
    expect(await client.call(name,input,`rejected-${name}`)).toMatchObject({ok:false});
    expect(list()[0]).toMatchObject({operation:name,ok:false,sourceLabel,page});
  }
  expect(JSON.stringify(list())).not.toMatch(/Sensitive authored|Private project|absent-private|absent-effect|not found|Permission/);
});
it('keeps credentials, private messaging, refresh checks and unlisted commands out of lasting history',async()=>{
  const {socket,list}=await setup(),client=await socket();
  const excluded = [
    'secrets.set','secrets.answer','secrets.grant','secrets.revoke','secrets.describe','secrets.startup','secrets.always','secrets.remove',
    'token.create','token.revoke','session.revoke','account.removePasskey','account.revokeSession','household.bootstrapAgent',
    'comms.open','comms.send','comms.answer','comms.replyToAsk','comms.change','comms.retryStart','comms.resend',
    'approvals.open','approvals.rules','approvals.history','changes.confirm','attention.get','attention.markRead','attention.readOutcome',
    'clock.status','clock.rearm','clock.dispatch','clock.outcome','clock.deadman','mind.knowledgeRead','mind.peopleList',
    'tasks.command','clock.command','approvals.command','bridges.command','household.futureMutation',
  ];
  for (const name of excluded) await client.call(name,{},`excluded-${name}`);
  expect(list()).toEqual([]);
});
