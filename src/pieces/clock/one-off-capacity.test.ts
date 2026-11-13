import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { startLoom } from '../../foundation.js';
import { FakeClock, type Viewer } from '../../core/index.js';
import { installClock } from './index.js';
import { wakes } from './store.js';
const owner:Viewer={kind:'member',id:'jonathan'},agent:Viewer={kind:'agent',id:'art'};
const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function setup(){
 const home=mkdtempSync(join(tmpdir(),'clock-one-off-capacity-'));
 cleanup.push(()=>rmSync(home,{recursive:true,force:true}));
 const clock=new FakeClock();let conversation:string|undefined;
 const open=async()=>{
  const app=await startLoom({home,clock,install(app){const jobs=installClock(app.db,app.operations,app.live,()=>({members:{jonathan:{owner:true,agents:['art','fish']}},projects:{},services:{}}),{capacityConversation:()=>conversation,approvals:{check:()=>({state:'pending',kind:'fixture',target:'fixture'}),subscribe:()=>()=>{}}});app.onClose(jobs.close);}});
  const close=app.close;let closed=false;app.close=async()=>{if(!closed){closed=true;await close();}};cleanup.push(app.close);return app;
 };
 const app=await open();
 const set=(viewer:Viewer=agent,extra:object={},name='in')=>app.operations.call('direct',viewer,`clock.${name}`,{agent:viewer.kind==='agent'?viewer.id:'art',when:'1h',on:'a-fixture',prompt:'Continue',note:'',...extra},randomUUID());
 return {app,open,set,cv:(value?:string)=>{conversation=value;}};
}
function fill(set:Awaited<ReturnType<typeof setup>>['set'],count=20,viewer=agent){for(let i=0;i<count;i++)expect(set(viewer).ok).toBe(true);}
it('enforces the shared unknown conversation share atomically for agent calls and generated commands',async()=>{
 const {app,set}=await setup();fill(set);
 const before={rows:wakes(app.db),events:app.db.prepare('SELECT * FROM clock_events').all()};
 expect(set()).toMatchObject({ok:false,code:'invalid',message:expect.stringContaining('20 API-origin')});
 expect(set(agent,{conversation:'forged',apiCapacity:{origin:'owner',bucket:'forged'}})).toMatchObject({ok:false,code:'invalid'});
 expect(app.operations.call('direct',agent,'clock.command',{agent:'art',argv:['in','1h','-p','Continue']},randomUUID())).toMatchObject({ok:true,value:{exit:1,stderr:expect.stringContaining('20 API-origin')}});
 expect({rows:wakes(app.db),events:app.db.prepare('SELECT * FROM clock_events').all()}).toEqual(before);
 expect(before.rows.every(w=>w.apiCapacity?.origin==='art'&&w.apiCapacity.bucket===undefined)).toBe(true);
});
it('allows two proven conversation shares but stops all API one-offs at forty, reserving room for members',async()=>{
 const {app,set,cv}=await setup();cv('private-one');fill(set);expect(set().ok).toBe(false);
 cv('private-two');fill(set);cv('private-three');
 expect(set()).toMatchObject({ok:false,code:'invalid',message:expect.stringContaining('40 API-origin')});
 fill(set,10,owner);expect(set(owner)).toMatchObject({ok:false,code:'invalid',message:expect.stringContaining('50 pending')});
 const rows=wakes(app.db);expect(rows).toHaveLength(50);
 expect(rows.filter(w=>w.apiCapacity)).toHaveLength(40);
 expect(JSON.stringify(rows)).not.toContain('private-one');
 expect(new Set(rows.filter(w=>w.apiCapacity).map(w=>w.apiCapacity!.bucket)).size).toBe(2);
});
it('counts parked and held work, frees cancelled capacity, and preserves the boundary across restart',async()=>{
 const {app,set,open}=await setup();fill(set,19);expect(set(agent,{},'park').ok).toBe(true);
 const held=wakes(app.db).find(w=>w.state==='pending')!;
 app.db.prepare("UPDATE clock_wakes SET record=json_set(record,'$.state','held','$.hold','uncertain') WHERE id=?").run(held.id);
 expect(set().ok).toBe(false);
 const parked=wakes(app.db).find(w=>w.state==='parked')!;
 expect(app.operations.call('direct',owner,'clock.cancel',{id:parked.id},randomUUID()).ok).toBe(true);
 expect(set().ok).toBe(true);await app.close();const again=await open();
 expect(again.operations.call('direct',agent,'clock.in',{agent:'art',when:'1h',prompt:'Continue',note:''},randomUUID())).toMatchObject({ok:false,code:'invalid'});
 expect(wakes(again.db).filter(w=>w.state!=='cancelled')).toHaveLength(20);
});
it('does not infer API provenance from historical viewer or archived origin and keeps agents separate',async()=>{
 const {app,set}=await setup();fill(set);
 const row=wakes(app.db)[0];delete row.apiCapacity;
 Object.assign(row,{legacy:{origin:'agent:art',for_in:'cv-123456789abc'}});
 app.db.prepare('UPDATE clock_wakes SET record=? WHERE id=?').run(JSON.stringify(row),row.id);
 expect(set().ok).toBe(true);expect(set().ok).toBe(false);
 expect(set({kind:'agent',id:'fish'}).ok).toBe(true);
 expect(wakes(app.db).find(w=>w.id===row.id)?.apiCapacity).toBeUndefined();
});
it('does not charge ordinary recurring occurrences against one-off conversation capacity',async()=>{
 const {app,set}=await setup();
 for(let n=0;n<20;n++)expect(app.operations.call('direct',agent,'clock.scheduleSet',{id:`s-${n}`,agent:'art',at:'12:31',prompt:'Repeat',note:''},randomUUID()).ok).toBe(true);
 fill(set);expect(set().ok).toBe(false);expect(wakes(app.db)).toHaveLength(40);
});

it.each([20,40,50])('rechecks retained capacity when owner fire-now reactivates failed one-off work at limit %s',async limit=>{
 const {app,set,cv}=await setup();cv('original');
 const viewer=limit===50?owner:agent;
 const failed=(set(viewer) as {value:{id:string}}).value;
 const original=wakes(app.db).find(w=>w.id===failed.id)!;
 app.db.prepare("UPDATE clock_wakes SET record=json_set(record,'$.state','failed') WHERE id=?").run(failed.id);
 fill(set,limit===50?50:20,viewer);
 if(limit===40){cv('second');fill(set);}
 const before={rows:wakes(app.db),events:app.db.prepare('SELECT * FROM clock_events').all()};
 expect(app.operations.call('direct',owner,'clock.now',{id:failed.id},randomUUID())).toMatchObject({ok:false,code:'invalid',message:expect.stringContaining(String(limit))});
 expect({rows:wakes(app.db),events:app.db.prepare('SELECT * FROM clock_events').all()}).toEqual(before);
 const cancel=before.rows.find(w=>w.state==='pending' && (limit!==40 || w.apiCapacity?.bucket===original.apiCapacity?.bucket))!;
 expect(app.operations.call('direct',owner,'clock.cancel',{id:cancel.id},randomUUID()).ok).toBe(true);
 expect(app.operations.call('direct',owner,'clock.now',{id:failed.id},randomUUID()).ok).toBe(true);
 expect(wakes(app.db).find(w=>w.id===failed.id)?.state).toBe('pending');
 expect(wakes(app.db).find(w=>w.id===failed.id)?.apiCapacity).toEqual(original.apiCapacity);
 // Accelerating already-active work adds no capacity and must not count it twice.
 expect(app.operations.call('direct',owner,'clock.now',{id:failed.id},randomUUID()).ok).toBe(true);
});
