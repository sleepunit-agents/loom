import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { WebSocket } from 'ws';
import { expect, it, vi } from 'vitest';
import { setupLocal, owner, caller, prompt, value } from '../../__fixtures__/clock-local.js';
import { exportDatabase, type Result, type Viewer } from '../../core/index.js';
import { HouseholdDatabase } from '../../core/household/document.js';
import { signin, hash } from '../../core/signin/index.js';
import { load } from '../approvals/store.js';
import { filedLocal } from './local-filing.js';
import { wakes } from './store.js';
const privateCaller = {...caller, member:'jonathan',people:['jonathan'],project:'pond'};
const operation = 'clock.scheduleLocalFromWindow';
const privateNote = 'PRIVATE_WINDOW_NOTE ' + 'complete-note '.repeat(30);
const timing = {mode:'in',when:'1h'};
async function allowed(mode:'once'|'standing'='once') {
 const s=await setupLocal(mode);
 const id=value<{id:string}>(s.request(prompt,privateNote,privateCaller)).id;
 value(await s.app.operations.callAsync('socket',owner,mode==='once'?'approvals.answer':'approvals.every-time',{id,action:'allow'},randomUUID(),true));
 const input={approval:id,...timing,...(mode==='standing'?{standing:true}:{})};
 const call=(inputOverride:unknown=input,receipt=randomUUID(),viewer:Viewer=owner,window=true)=>s.app.operations.callAsync('socket',viewer,operation,inputOverride,receipt,window);
 return Object.assign(s,{id,input,call});
}
it.each(['once','standing'] as const)('recovers %s from the owning window without constructing Caller or changing saved scope',async mode=>{
 const s=await allowed(mode),original=filedLocal(s.app.db,s.id),receipt=randomUUID();
 const downstream=vi.spyOn(s.app.operations,'call');
 const result=await s.call(s.input,receipt),ack=value<{id:string;due:number}>(result);
 expect(downstream).toHaveBeenCalledWith('direct',{kind:'service',id:'clock'},mode==='once'?'clock.localSchedule':'clock.localStandingSchedule',{caller:privateCaller,approval:s.id,...timing},expect.any(String));
 downstream.mockRestore();
 expect(Object.keys(ack).sort()).toEqual(['due','id']);expect(ack.due).toBe(s.clock.now()+3600_000);
 expect(wakes(s.app.db)).toHaveLength(1);
 expect(wakes(s.app.db)[0]).toMatchObject({id:ack.id,prompt,note:privateNote,member:'jonathan',project:'pond',by:{kind:'agent',id:'art'},approval:s.id});
 expect(filedLocal(s.app.db,s.id)).toEqual(original);
 expect(await s.call(s.input,receipt)).toEqual(result);
 await s.restart();
 expect(await s.app.operations.callAsync('socket',owner,operation,s.input,receipt,true)).toEqual(result);
 s.clock.advance(31*86400_000);
 expect(await s.app.operations.callAsync('socket',owner,operation,s.input,receipt,true)).toEqual(result);
 expect(wakes(s.app.db)).toHaveLength(1);
 expect(await s.app.operations.callAsync('socket',owner,'clock.pause',{agent:'art'},receipt,true)).toMatchObject({ok:false,code:'conflict'});
 const exported=JSON.stringify(exportDatabase(s.app.db));
 for(const secret of [s.id,ack.id,'PRIVATE_WINDOW_NOTE',operation])expect(exported).not.toContain(secret);
 if(mode==='standing')expect(load(s.app.db).standing[0].uses).toBe(1);
});
it('requires the exact member’s signed-in window and refuses owner/no-people legacy filings',async()=>{
 const s=await allowed();s.access.members['other-owner']={owner:true,agents:['art']};
 const actors:Viewer[]=[{kind:'member',id:'other-owner'},{kind:'member',id:'pollock'},{kind:'agent',id:'art'},{kind:'service',id:'clock'},{kind:'runner',id:'runner'}];
 for(const viewer of actors)expect(await s.call(s.input,randomUUID(),viewer)).toMatchObject({ok:false,code:'denied'});
 expect(await s.call(s.input,randomUUID(),owner,false)).toMatchObject({ok:false,code:'denied'});
 for(const door of ['http','mcp','direct'] as const)expect(s.app.operations.call(door,owner,operation,s.input,randomUUID())).toMatchObject({ok:false,code:'denied'});
 const legacy=value<{id:string}>(s.request(prompt,'PUBLIC',caller)).id;
 expect(await s.call({...timing,approval:legacy})).toMatchObject({ok:false,code:'denied'});
 expect(wakes(s.app.db)).toEqual([]);
});
it.each(['owner','assignment','agent-project','clock','approvals'] as const)('rechecks %s policy before both new writes and cached/durable replay',async change=>{
 const s=await allowed('standing'),receipt=randomUUID();value(await s.call(s.input,receipt));
 const revoke=()=>{
  if(change==='owner')s.access.members.jonathan.owner=false;
  if(change==='assignment')s.access.members.jonathan.agents=[];
  if(change==='agent-project')s.access.projects.pond.agents=[];
  if(change==='clock')s.access.services.clock.operations=s.access.services.clock.operations.filter(op=>op!=='clock.localStandingSchedule');
  if(change==='approvals')s.access.services.clock.operations=s.access.services.clock.operations.filter(op=>op!=='approvals.piece-standing-local');
 };
 revoke();
 for(const id of [receipt,randomUUID()])expect(await s.call(s.input,id)).toMatchObject({ok:false,code:'denied'});
 s.clock.advance(31*86400_000);
 expect(await s.call(s.input,receipt)).toMatchObject({ok:false,code:'denied'});
 expect(wakes(s.app.db)).toHaveLength(1);expect(load(s.app.db).standing[0].uses).toBe(1);
});
it('rejects Caller, words, scope and executable overrides without spending anything',async()=>{
 const s=await allowed(),before=load(s.app.db);
 for(const extra of [{caller:privateCaller},{agent:'art'},{member:'jonathan'},{people:[]},{project:'pond'},{prompt},{note:'changed'},{file:'routine.md'},{model:'fast'},{slot:'local'},{continuation:'cv-other'},{place:'host'}])
  expect(await s.call({...s.input,...extra})).toMatchObject({ok:false,code:'invalid'});
 expect(wakes(s.app.db)).toEqual([]);expect(load(s.app.db)).toEqual(before);
});
it('rolls back approval use and wake when the durable window receipt cannot commit',async()=>{
 const s=await allowed(),before=load(s.app.db);
 s.app.db.exec("CREATE TRIGGER fail_window_receipt BEFORE INSERT ON clock_meta WHEN NEW.key LIKE 'local-standing-receipt:%' BEGIN SELECT RAISE(ABORT,'fixture'); END");
 expect(await s.call()).toMatchObject({ok:false,code:'unavailable'});
 expect(wakes(s.app.db)).toEqual([]);expect(load(s.app.db)).toEqual(before);
 s.app.db.exec('DROP TRIGGER fail_window_receipt');value(await s.call());expect(wakes(s.app.db)).toHaveLength(1);
});
it('keeps time validation and standing target exclusion ahead of spending',async()=>{
 const s=await allowed('standing');
 expect(await s.call({...s.input,when:'nonsense'})).toMatchObject({ok:false,code:'invalid'});
 expect(load(s.app.db).standing[0].uses).toBe(0);
 value(await s.call());
 expect(await s.call()).toMatchObject({ok:false,code:'invalid'});expect(load(s.app.db).standing[0].uses).toBe(1);
});
it('accepts real Signin cookie sockets, refuses bearer replay, other owners and ended sessions',async()=>{
 let auth:ReturnType<typeof signin>|undefined;
 const s=await setupLocal('once',undefined,req=>auth?.resolve(req));auth=signin(s.app);
 s.access.members['other-owner']={owner:true,agents:['art']};
 s.app.db.transaction(()=>{
  new HouseholdDatabase(s.app.db).replace(s.home,{v:1,agents:['art'],members:[{person:'jonathan',role:'owner',agents:'*'},{person:'other-owner',role:'owner',agents:'*'}]});
  auth!.tokens.replace({v:1,tokens:[]},{});
 })();
 const bearer=randomBytes(32).toString('hex');
 auth.tokens.change(tokens=>tokens.push({role:'owner',member:'jonathan',label:'window recovery',sha256:hash(bearer),created:new Date(s.clock.now()).toISOString()}));
 const cookie=auth.createSession(hash(bearer));
 const otherBearer=randomBytes(32).toString('hex');
 auth.tokens.change(tokens=>tokens.push({role:'owner',member:'other-owner',label:'other window',sha256:hash(otherBearer),created:new Date(s.clock.now()).toISOString()}));
 const otherCookie=auth.createSession(hash(otherBearer));
 const id=value<{id:string}>(s.request(prompt,'PRIVATE_COOKIE_NOTE',privateCaller)).id;
 value(await s.app.operations.callAsync('socket',owner,'approvals.answer',{id,action:'allow'},randomUUID(),true));
 const input={approval:id,...timing},receipt=randomUUID();
 async function socket(headers:Record<string,string>) {const ws=new WebSocket(s.app.url.replace('http:','ws:')+'/live',{headers:{origin:s.app.url,...headers}});await once(ws,'open');return ws;}
 async function call(ws:WebSocket) {const result=new Promise<Result>(resolve=>{const receive=(raw:unknown)=>{const m=JSON.parse(String(raw));if(m.kind==='result'&&m.request===receipt){ws.off('message',receive);resolve(m.result);}};ws.on('message',receive);});ws.send(JSON.stringify({kind:'call',name:operation,input,id:receipt,request:receipt}));return result;}
 const page=await socket({cookie:`loom_ui=${cookie}`}),token=await socket({authorization:`Bearer ${bearer}`,'x-loom-window':'true'}),other=await socket({cookie:`loom_ui=${otherCookie}`});
 try {
  const result=await call(page);expect(result).toMatchObject({ok:true});expect(JSON.stringify(result)).not.toContain('PRIVATE_COOKIE_NOTE');
  expect(await call(token)).toMatchObject({ok:false,code:'denied'});
  expect(await call(other)).toMatchObject({ok:false,code:'denied'});
  auth.tokens.change(tokens=>tokens.splice(0,tokens.length));
  expect(await s.app.operations.callAsync('socket',owner,operation,input,receipt,true,()=>auth!.resolve({headers:{cookie:`loom_ui=${cookie}`,origin:s.app.url},socket:{},method:'GET'} as IncomingMessage)?.valid()??false)).toMatchObject({ok:false,code:'denied'});
  expect(wakes(s.app.db)).toHaveLength(1);
 }finally{page.terminate();token.terminate();other.terminate();}
});
it.each(['pending','denied','expired','changed'] as const)('refuses %s one-shot decisions without scheduling',async state=>{
 const s=await setupLocal('once'),id=value<{id:string}>(s.request(prompt,'PRIVATE_REFUSED',privateCaller)).id;
 if(state!=='pending')value(await s.app.operations.callAsync('socket',owner,'approvals.answer',{id,action:state==='denied'?'deny':'allow'},randomUUID(),true));
 if(state==='expired')s.clock.advance(61*60_000);
 if(state==='changed')s.app.db.prepare('UPDATE approvals_approvals SET record=json_set(record,\'$.details\',\'changed\') WHERE id=?').run(id);
 const before=load(s.app.db);
 expect((await s.app.operations.callAsync('socket',owner,operation,{approval:id,...timing},randomUUID(),true)).ok).toBe(false);
 expect(load(s.app.db)).toEqual(before);expect(wakes(s.app.db)).toEqual([]);
});
it('does not reuse a spent one-shot or consume a turned-off standing job',async()=>{
 const once=await allowed();value(await once.call());expect((await once.call()).ok).toBe(false);expect(wakes(once.app.db)).toHaveLength(1);
 const standing=await allowed('standing'),j=load(standing.app.db).standing[0];
 value(await standing.app.operations.callAsync('socket',owner,'approvals.standing-off',{id:j.id},randomUUID(),true));
 expect((await standing.call()).ok).toBe(false);expect(wakes(standing.app.db)).toEqual([]);expect(load(standing.app.db).standing[0].uses).toBe(0);
});

it('keeps the shared fifty-wake capacity limit ahead of window standing use',async()=>{
 const s=await allowed('standing');
 for(let n=0;n<50;n++)value(s.app.operations.call('direct',owner,'clock.in',{agent:'art',prompt:'Ordinary work',note:String(n),when:'2h'},randomUUID()));
 expect(await s.call()).toMatchObject({ok:false,code:'invalid'});
 expect(wakes(s.app.db)).toHaveLength(50);expect(load(s.app.db).standing[0].uses).toBe(0);
});
