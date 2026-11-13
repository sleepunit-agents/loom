import { once } from 'node:events';
import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { setupLocal, owner, caller, prompt, value } from '../../__fixtures__/clock-local.js';
import { exportDatabase, openDb, type Viewer } from '../../core/index.js';
import { load } from '../approvals/store.js';
import { clockLocalRecovery, clockLocalStanding } from './role.js';
import { wakes } from './store.js';
const privateCaller={...caller,member:'jonathan',people:['jonathan'],project:'pond'};
const call=(s:Awaited<ReturnType<typeof setupLocal>>,v:Viewer,name:string,input={})=>s.app.operations.call('direct',v,name,input,randomUUID());
const windowCall=(s:Awaited<ReturnType<typeof setupLocal>>,v:Viewer,name:string,input={})=>s.app.operations.callAsync('socket',v,name,input,randomUUID(),true);
const outsiders:Viewer[]=[{kind:'member',id:'second-owner'},{kind:'member',id:'pollock'},{kind:'agent',id:'art'},{kind:'agent',id:'pond-bot'},{kind:'service',id:'clock'},{kind:'runner',id:'runner'}];
function secondOwner(s:Awaited<ReturnType<typeof setupLocal>>) {s.access.members['second-owner']={owner:true,agents:['art']};}
it.each(['once','standing'] as const)('persists %s private local authority and wake without widening read or answer access across restart',async mode=>{
 const s=await setupLocal(mode);secondOwner(s);
 const id=value<{id:string}>(s.request(prompt,'PRIVATE note',privateCaller)).id;
 expect(load(s.app.db).approvals[0]).toMatchObject({member:'jonathan',project:'pond',people:['jonathan'],conversation:caller.conversation});
 for(const v of outsiders) {
  expect(JSON.stringify(call(s,v,'approvals.list'))).not.toContain('PRIVATE note');
  expect(call(s,v,'approvals.answer',{id,action:'allow'}).ok).toBe(false);
 }
 value(await windowCall(s,owner,mode==='once'?'approvals.answer':'approvals.every-time',{id,action:'allow'}));
 await s.restart();
 const role=mode==='once'?clockLocalRecovery(s.app.operations):clockLocalStanding(s.app.operations);
 const input={approval:id,mode:'in' as const,when:'1h'},receipt=randomUUID();
 const result=role.schedule(privateCaller,input,receipt);
 expect(value(result)).toMatchObject({member:'jonathan',project:'pond',prompt,note:'PRIVATE note',by:{kind:'agent',id:'art'}});
 expect(role.schedule(privateCaller,input,receipt)).toEqual(result);
 expect(wakes(s.app.db)).toHaveLength(1);
 for(const v of outsiders) {
  const r=call(s,v,'clock.list',{agent:'art'});if(r.ok)expect(JSON.stringify(r.value)).not.toContain('PRIVATE note');
  const log=call(s,v,'clock.log');expect(JSON.stringify(log)).not.toContain('PRIVATE note');
  const rules=call(s,v,'approvals.rules');expect(JSON.stringify(rules)).not.toContain('PRIVATE note');
 }
 expect(JSON.stringify(await windowCall(s,owner,'clock.list',{agent:'art'}))).toContain('PRIVATE note');
 expect(JSON.stringify(call(s,owner,'clock.list',{agent:'art'}))).not.toContain('PRIVATE note');
 if(mode==='standing') {
  const j=load(s.app.db).standing[0];expect(j).toMatchObject({member:'jonathan',project:'pond'});
  expect(call(s,{kind:'member',id:'second-owner'},'approvals.standing-off',{id:j.id}).ok).toBe(false);
  value(await windowCall(s,owner,'approvals.standing-off',{id:j.id}));
 }
});
it('refuses a non-owner private local request without exposing it to an owner',async()=>{
 const s=await setupLocal('once');s.access.members.pollock.agents.push('art');
 for(const c of [{...privateCaller,member:'pollock',people:['pollock'],for:'pollock'},
  {...privateCaller,member:'pollock',people:['pollock']},{...privateCaller,member:'missing',people:['missing']},
  {...privateCaller,people:[]},{...privateCaller,people:['pollock']},{...privateCaller,conversation:undefined}])
  expect(s.request(prompt,'PRIVATE refused',c).ok).toBe(false);
 expect(load(s.app.db).approvals).toEqual([]);expect(wakes(s.app.db)).toEqual([]);
});
it('separates private targets from another owner and from owner work with no member',async()=>{
 const s=await setupLocal('standing');secondOwner(s);
 const cs=[privateCaller,{...privateCaller,member:'second-owner',people:['second-owner']},caller];
 for(const c of cs){const id=value<{id:string}>(s.request(prompt,'PRIVATE independent',c)).id;
  value(await windowCall(s,{kind:'member',id:c.member??'jonathan'},'approvals.every-time',{id}));
  value(clockLocalStanding(s.app.operations).schedule(c,{approval:id,mode:'in',when:'1h'}));
 }
 expect(load(s.app.db).approvals).toHaveLength(3);expect(load(s.app.db).standing).toHaveLength(3);expect(wakes(s.app.db)).toHaveLength(3);
});
it('refuses member substitution and current ownership loss before spending private authority',async()=>{
 const s=await setupLocal('once');secondOwner(s);
 const id=value<{id:string}>(s.request(prompt,'PRIVATE',privateCaller)).id;value(await windowCall(s,owner,'approvals.answer',{id,action:'allow'}));
 const before=load(s.app.db),role=clockLocalRecovery(s.app.operations),input={approval:id,mode:'in' as const,when:'1h'};
 for(const c of [caller,{...privateCaller,member:'second-owner',people:['second-owner']},{...privateCaller,conversation:'cv-aaaaaaaaaaaa'}])expect(role.schedule(c,input).ok).toBe(false);
 s.access.members.jonathan.owner=false;expect(role.schedule(privateCaller,input).ok).toBe(false);
 expect(load(s.app.db)).toEqual(before);expect(wakes(s.app.db)).toEqual([]);
});
it('omits private approval/wake, words, metadata, audit and all retry copies from exports, retaining public work',async()=>{
 const s=await setupLocal('standing');
 const id=value<{id:string}>(s.request(prompt,'UNEXPORTABLE_PRIVATE_NOTE',privateCaller)).id;
 value(await windowCall(s,owner,'approvals.every-time',{id}));
 const w=value<{id:string}>(clockLocalStanding(s.app.operations).schedule(privateCaller,{approval:id,mode:'in',when:'1h'}));
 value(call(s,owner,'clock.in',{agent:'art',prompt:'PUBLIC_PROMPT',note:'PUBLIC_NOTE',when:'2h'}));
 // A command can flatten private records to rendered text; its receipt must go too.
 value(call(s,owner,'clock.command',{argv:['list'],agent:'art'}));
 const exported=JSON.stringify(exportDatabase(s.app.db));
 for(const secret of ['UNEXPORTABLE_PRIVATE_NOTE',prompt,id,w.id,'local-filing:'+id])expect(exported).not.toContain(secret);
 expect(exported).toContain('PUBLIC_NOTE');expect(exported).toContain('PUBLIC_PROMPT');
 await s.restart();expect(JSON.stringify(exportDatabase(s.app.db))).not.toContain('UNEXPORTABLE_PRIVATE_NOTE');
});
it('closes the generic standing bypass and retains private exclusions after standing history disappears',async()=>{
 const s=await setupLocal('standing');
 s.access.services.clock.operations.push('approvals.standing');
 const id=value<{id:string;target:string}>(s.request(prompt,'PRIVATE_TRIMMED',privateCaller)).id;
 value(await windowCall(s,owner,'approvals.every-time',{id}));
 const original=load(s.app.db),j=original.standing[0];
 for(const c of [privateCaller,{...privateCaller,project:'other'},caller]) {
  const r=s.app.operations.call('direct',{kind:'service',id:'clock'},'approvals.standing',{caller:c,kind:'local-wake',target:j.target,digest:j.digest},randomUUID());
  expect(r.ok).toBe(false);
 }
 value(clockLocalStanding(s.app.operations).schedule(privateCaller,{approval:id,mode:'in',when:'1h'}));
 s.app.db.prepare('DELETE FROM approvals_rules WHERE id=?').run(j.id);
 expect(JSON.stringify(exportDatabase(s.app.db))).not.toContain(j.id);
 expect(JSON.stringify(exportDatabase(s.app.db))).not.toContain('PRIVATE_TRIMMED');
});

it('sends private words only to that member’s authenticated window, never a member token or another owner',async()=>{
 const s=await setupLocal('once',undefined,req=>({viewer:{kind:'member',id:req.headers['x-fixture-viewer']==='other'?'second-owner':'jonathan'},window:req.headers['x-fixture-window']==='yes',valid:()=>true}));secondOwner(s);
 const id=value<{id:string}>(s.request(prompt,'PRIVATE_LIVE_WORDS',privateCaller)).id;
 const receipt=randomUUID();value(await s.app.operations.callAsync('socket',owner,'approvals.answer',{id,action:'allow'},receipt,true));
 // A token cannot replay a browser response containing the private card.
 expect(s.app.operations.call('http',owner,'approvals.answer',{id,action:'allow'},receipt).ok).toBe(false);
 value(clockLocalRecovery(s.app.operations).schedule(privateCaller,{approval:id,mode:'in',when:'1h'}));
 for(const [viewer,window,visible] of [['self','yes',true],['other','yes',false],['self','no',false]]) {
  const ws=new WebSocket(s.app.url.replace('http:','ws:')+'/live',{headers:{'x-fixture-viewer':viewer,'x-fixture-window':window}});
  try{await once(ws,'open');const result=once(ws,'message');ws.send(JSON.stringify({kind:'subscribe',type:'wake'}));
   const [raw]=await result;expect(String(raw).includes('PRIVATE_LIVE_WORDS')).toBe(visible);
  }finally{ws.terminate();}
 }
});

it('requires owning export filters after reopening instead of exporting an uncomposed private database',async()=>{
 const s=await setupLocal('once');value(s.request(prompt,'PRIVATE_REOPEN',privateCaller));
 expect(s.app.db.prepare("SELECT number FROM core_migrations WHERE piece='core_export'").all()).toEqual([{number:1}]);
 await s.restart(()=>{const lease=openDb(s.home);
 try{expect(()=>exportDatabase(lease.db)).toThrow('Export requires the installed privacy filter');}finally{lease.close();}});
 expect(JSON.stringify(exportDatabase(s.app.db))).not.toContain('PRIVATE_REOPEN');
});

it('rechecks current private member ownership before replaying standing scheduling authority',async()=>{
 const s=await setupLocal('standing');secondOwner(s);
 const id=value<{id:string}>(s.request(prompt,'PRIVATE_REPLAY',privateCaller)).id;
 value(await windowCall(s,owner,'approvals.every-time',{id}));
 const role=clockLocalStanding(s.app.operations),input={approval:id,mode:'in' as const,when:'1h'},receipt=randomUUID();
 value(role.schedule(privateCaller,input,receipt));s.access.members.jonathan.owner=false;
 expect(role.schedule(privateCaller,input,receipt)).toMatchObject({ok:false,code:'denied'});
 expect(wakes(s.app.db)).toHaveLength(1);
});
