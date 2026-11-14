import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { startLoom } from '../../foundation.js';
import { FakeClock, exportDatabase, mayFilePrivateWork, maySee, type Viewer, type Sharing } from '../../core/index.js';
import type { ClockProvenance } from '../runtime/role.js';
import { installClock } from './index.js';
import { wakes } from './store.js';
const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const body:Viewer={kind:'agent',id:'art'},owner:Viewer={kind:'member',id:'jonathan'};
async function setup(){
 const home=mkdtempSync(join(tmpdir(),'clock-authorship-'));cleanup.push(()=>rmSync(home,{recursive:true,force:true}));
 const clock=new FakeClock();let proof:ClockProvenance|undefined={agent:'art',conversation:'cv-proof',member:'jonathan',project:'pond',service:'bridge',principal:{for:'?',people:['pollock']}};
 const access:Sharing={members:{jonathan:{owner:true,agents:['art']},other:{owner:true,agents:['art']},pollock:{owner:false,agents:['art']}},projects:{pond:{members:['jonathan','other','pollock'],agents:['art']}},services:{}};
 let starts=0;
 const open=async()=>{
  const app=await startLoom({home,clock,install(app){const jobs=installClock(app.db,app.operations,app.live,()=>access,{provenance:v=>v===body?proof:undefined,
   approvals:{check:()=>({state:'pending',kind:'fixture',target:'fixture'}),subscribe:()=>()=>{}},
   runtime:{startBody:async()=>{starts++;return {state:'started',body:'fixture'};}}});app.onClose(jobs.close);}});
  const close=app.close;let closed=false;app.close=async()=>{if(!closed){closed=true;await close();}};cleanup.push(app.close);return app;
 };
 const app=await open();
 const call=(name='in',extra:object={},viewer=body,id=randomUUID())=>app.operations.call('direct',viewer,`clock.${name}`,{agent:'art',when:'1h',on:'a-fixture',prompt:'PRIVATE_PROMPT',note:'PRIVATE_NOTE',...extra},id);
 return {app,clock,call,open,access,get proof(){return proof;},set proof(value){proof=value;},get starts(){return starts;}};
}
it.each(['at','in','park'])('persists %s original scope without returning words or widening policy',async name=>{
 const f=await setup(),id=randomUUID(),extra=name==='at'?{when:'2026-11-12 01:00'}:{};
 const ack=f.call(name,extra,body,id);expect(ack).toMatchObject({ok:true,value:{id:expect.any(String),private:true,state:name==='park'?'parked':'pending'}});
 expect(JSON.stringify(ack)).not.toMatch(/PRIVATE_|pollock|bridge|cv-proof/);
 const row=wakes(f.app.db)[0];expect(row).toMatchObject({member:'jonathan',project:'pond',authorship:{origin:'art',conversation:'cv-proof',member:'jonathan',project:'pond',service:'bridge',principal:{for:'?',people:['pollock']}}});
 expect(f.call(name,extra,body,id)).toEqual(ack);expect(wakes(f.app.db)).toHaveLength(1);
 const original = f.proof!;f.proof={...original,conversation:'cv-other',member:'other'};
 expect(f.call(name,extra,body,id)).toMatchObject({ok:false,code:'conflict'});
 f.proof=original;expect(f.call(name,extra,{...body},id)).toMatchObject({ok:false,code:'conflict'});
 for(const viewer of [body,owner,{kind:'member',id:'other'}] as Viewer[]){
  expect(JSON.stringify(f.app.operations.call('direct',viewer,'clock.list',{},randomUUID()))).not.toContain('PRIVATE_');
  expect(JSON.stringify(f.app.operations.call('direct',viewer,'clock.log',{},randomUUID()))).not.toContain('PRIVATE_');
 }
 expect(JSON.stringify(await f.app.operations.callAsync('socket',owner,'clock.list',{},randomUUID(),true))).toContain('PRIVATE_PROMPT');
 expect(JSON.stringify(await f.app.operations.callAsync('socket',{kind:'member',id:'other'},'clock.list',{},randomUUID(),true))).not.toContain('PRIVATE_');
 const exported=JSON.stringify(exportDatabase(f.app.db));expect(exported).not.toContain('PRIVATE_');expect(exported).not.toContain(row.id);
 f.proof!.principal.people.push('other');expect(wakes(f.app.db)[0].authorship!.principal.people).toEqual(['pollock']);
 await f.app.close();const again=await f.open();expect(wakes(again.db)[0].authorship).toEqual(row.authorship);
});
it('retains unknown and member principals without inferring ownership from membership or capacity',async()=>{
 const f=await setup();f.proof={...f.proof!,member:'pollock',principal:{for:'owner',people:[]}};
 expect(f.call().ok).toBe(true);expect(wakes(f.app.db)[0]).toMatchObject({member:'pollock',authorship:{member:'pollock',principal:{for:'owner',people:[]}}});
 // A principal describes steering, not record ownership or an owner permission.
 expect(JSON.stringify(await f.app.operations.callAsync('socket',owner,'clock.list',{},randomUUID(),true))).not.toContain('PRIVATE_');
 expect(f.app.operations.call('direct',body,'clock.requestLocal',{agent:'art',prompt:'<!-- house: local --> hi',note:''},randomUUID()).ok).toBe(false);
});
it('keeps unbound and copied viewers unknown, ignores forged evidence and refuses mismatched scope or target',async()=>{
 const f=await setup();
 expect(f.call('in',{project:'elsewhere'}).ok).toBe(false);expect(f.call('in',{agent:'fish'}).ok).toBe(false);
 expect(f.call('in',{member:'other'}).ok).toBe(false);expect(wakes(f.app.db)).toEqual([]);
 expect(f.call('in',{authorship:{origin:'owner',conversation:'forged',principal:{for:'owner',people:[]}},principal:'owner',conversation:'forged'}, {...body}).ok).toBe(true);
 expect(wakes(f.app.db)[0]).toMatchObject({authorship:{origin:'art',principal:{for:'?',people:[]}}});expect(wakes(f.app.db)[0].member).toBeUndefined();expect(wakes(f.app.db)[0].authorship!.conversation).toBeUndefined();
 expect(f.call('in',{},owner).ok).toBe(true);expect(wakes(f.app.db).find(w=>w.by.kind==='member')!.authorship).toEqual({principal:{for:'owner',people:['jonathan']}});
});
it('rechecks private filing policy before replay and holds private delivery without borrowing member attribution',async()=>{
 const f=await setup(),id=randomUUID();expect(f.call('in',{},body,id).ok).toBe(true);const first=wakes(f.app.db)[0].id;
 const command=f.app.operations.call('direct',body,'clock.command',{agent:'art',argv:['in','2h','-p','PRIVATE_COMMAND','--note','PRIVATE_COMMAND_NOTE']},randomUUID());
 expect(command).toMatchObject({ok:true,value:{exit:0}});expect(JSON.stringify(command)).not.toContain('PRIVATE_');
 expect(JSON.stringify(exportDatabase(f.app.db))).not.toContain('PRIVATE_COMMAND');
 f.access.members.jonathan.agents=[];expect(f.call('in',{},body,id)).toMatchObject({ok:false,code:'denied'});
 f.access.members.jonathan.agents=['art'];await f.clock.advance(3600_000);
 await Promise.resolve();expect(f.starts).toBe(0);expect(wakes(f.app.db).find(w=>w.id===first)).toMatchObject({state:'held',hold:'permission',member:'jonathan'});
});

it('limits central private filing to the proved own body, member relationship and current project without granting reads',async()=>{
 const f=await setup(),scope={type:'wake',agent:'art',member:'jonathan',project:'pond',privateControl:true};
 expect(mayFilePrivateWork(body,scope,f.access)).toBe(true);expect(maySee(body,scope,f.access)).toBe(false);
 for(const change of [{privateControl:false},{type:'approval'},{agent:'fish'},{member:'missing'},{member:undefined},{project:'missing'}])
  expect(mayFilePrivateWork(body,{...scope,...change},f.access)).toBe(false);
 for(const v of [owner,{kind:'service',id:'clock'},{kind:'runner',id:'runner'}] as Viewer[])
  expect(mayFilePrivateWork(v,scope,f.access)).toBe(false);
});
