import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { z } from 'zod';
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
async function setup(upgrade=false) {
  const home=mkdtempSync(join(tmpdir(),'attention-outcomes-'));fixture(home);
  const clock=new FakeClock(), types=new Map<string,RecordType>();
  const access={members:{alice:{owner:true,agents:['art']},bob:{owner:true,agents:['art']}},projects:{},services:{}};
  const app=await startLoom({home,next:true,host:'127.0.0.1',port:0,stdout:()=>{},clock,sharing:()=>access,
    authenticate:req=>({viewer:req.headers.authorization==='bob'?bob:alice,window:req.headers.authorization!=='api',valid:()=>true}),
    install:app=>{const register=app.live.register.bind(app.live);app.live.register=t=>{types.set(t.name,t);register(t);};if(upgrade){migrate(app.db,'attention',attentionMigrations.filter(m=>m.number<=6));app.db.prepare('INSERT INTO attention_asks VALUES (?,?)').run('old',JSON.stringify({id:'old',agent:'art',ask:'Existing question',source:{kind:'piece',id:'fixture'},state:'open',createdAt:1,changedAt:1}));}installAttention(app.db,app.operations,app.live,()=>access);installTasks(app.db,app.operations,app.live,()=>access);},
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
  reader.ws.send(JSON.stringify({kind:'subscribe',type:'attention.outcome'}));expect((await reader.receive(m=>m.kind==='set')).records).toEqual([]);
  await writer.call('tasks.create',{cli:true,title:'A task',goal:'goal',why:'why'},'one');
  const change=await reader.receive(m=>m.kind==='put'&&m.type==='attention.outcome');expect(change.record).toEqual(list()[0]);
  expect(types.get('attention.ask')!.ids(undefined)).toEqual([]);
  const expected=list();await app.close();
  const next=await startLoom({home,next:true,clock,stdout:()=>{},sharing:()=>({members:{alice:{owner:true,agents:['art']}},projects:{},services:{}})});
  cleanup.push(next.close);
  expect(next.operations.call('direct',alice,'attention.outcomes',{})).toEqual({ok:true,value:expected});
});
it('keeps newest 50 per member at the same clock tick and does not resurrect a trimmed retry',async()=>{
  const {app,list,socket}=await setup(),a=await socket(),b=await socket('bob');
  const input={id:'missing',answer:{kind:'yes'}};
  for(let n=0;n<53;n++) await a.call('attention.answer',input,`attempt-${n}`);
  expect(list()).toHaveLength(50);const first=list()[0];
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
