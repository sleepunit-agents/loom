import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { setupLocal, caller, prompt, value } from '../../__fixtures__/clock-local.js';
import { clockLocalRecovery } from './role.js';
import { startLoom } from '../../foundation.js';
import { FakeClock, type Sharing, type Viewer } from '../../core/index.js';
import { installClock } from './index.js';
import { schedules, wakes, type Schedule } from './store.js';
const owner:Viewer={kind:'member',id:'jonathan'}, agent:Viewer={kind:'agent',id:'art'};
const sharing:Sharing={members:{jonathan:{owner:true,agents:['art','fish']}},projects:{},services:{}};
const cleanup:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function setup(){
 const home=mkdtempSync(join(tmpdir(),'clock-schedule-capacity-'));
 cleanup.push(()=>rmSync(home,{recursive:true,force:true}));
 const access=structuredClone(sharing), clock=new FakeClock();
 const starts=vi.fn(async (_input:Parameters<import('./role.js').Runtime['startBody']>[0])=>({state:'held' as const,reason:'Fixture staging hold'}));
 const open=async()=>{const app=await startLoom({home,clock,install(app){const jobs=installClock(app.db,app.operations,app.live,()=>access,{runtime:{startBody:starts}});app.onClose(jobs.close);}});const close=app.close;let closed=false;app.close=async()=>{if(!closed){closed=true;await close();}};cleanup.push(app.close);return app;};
 const app=await open();
 const set=(id:string,viewer:Viewer=agent,extra:object={})=>app.operations.call('direct',viewer,'clock.scheduleSet',{id,agent:'art',at:'12:31',prompt:'Continue work',note:'schedule',...extra},randomUUID());
 return {app,open,set,access,clock,starts};
}
function fillApiShare(set:Awaited<ReturnType<typeof setup>>['set']) {
 for(let n=0;n<20;n++)expect(set(`api-${n}`).ok).toBe(true);
}
it('rejects the twenty-first new API-origin schedule without recording any part of it',async()=>{
 const {app,set}=await setup();
 fillApiShare(set);
 const before={s:schedules(app.db),w:wakes(app.db),events:app.db.prepare('SELECT * FROM clock_events').all()};
 expect(set('overflow')).toMatchObject({ok:false,code:'invalid',message:expect.stringContaining('20 API-origin schedules')});
 expect({s:schedules(app.db),w:wakes(app.db),events:app.db.prepare('SELECT * FROM clock_events').all()}).toEqual(before);
 expect(before.s.every(s=>s.apiOrigin==='art')).toBe(true);
 const command=app.operations.call('direct',agent,'clock.command',{agent:'art',argv:['schedule','set','overflow','--at','12:31','-p','Continue']},randomUUID());
 expect(command).toMatchObject({ok:true,value:{exit:1,stderr:expect.stringContaining('20 API-origin schedules')}});
 expect(schedules(app.db)).toEqual(before.s);
});
it('allows owner schedules beyond twenty without consuming the API share',async()=>{
 const {app,set}=await setup();
 for(let n=0;n<21;n++)expect(set(`owner-${n}`,owner).ok).toBe(true);
 fillApiShare(set);
 expect(schedules(app.db)).toHaveLength(41);
 expect(set('overflow').ok).toBe(false);
 expect(set('owner-extra',owner).ok).toBe(true);
});
it('allows replacement at capacity and frees a slot only after removal',async()=>{
 const {app,set}=await setup();
 fillApiShare(set);
 expect(set('api-0',agent,{prompt:'Replacement'}).ok).toBe(true);
 expect(set('overflow').ok).toBe(false);
 expect(app.operations.call('direct',owner,'clock.scheduleRemove',{id:'api-1'},randomUUID()).ok).toBe(true);
 expect(set('new-slot').ok).toBe(true);
 expect(set('overflow').ok).toBe(false);
});
it('counts disabled origin-bearing schedules but ignores historical rows without authenticated origin',async()=>{
 const {app,set,open}=await setup();
 fillApiShare(set);
 for(const row of schedules(app.db))app.db.prepare('UPDATE clock_schedules SET record=? WHERE id=?').run(JSON.stringify({...row,enabled:false}),row.id);
 expect(set('overflow').ok).toBe(false);
 const historical=schedules(app.db)[0];delete historical.apiOrigin;
 Object.assign(historical,{legacy:{origin:'agent:art',for_in:'cv-123456789abc'}});
 app.db.prepare('UPDATE clock_schedules SET record=? WHERE id=?').run(JSON.stringify(historical),historical.id);
 expect(set('new-slot').ok).toBe(true);
 await app.close();const reopened=await open();
 const old=schedules(reopened.db).find(s=>s.id===historical.id)!;
 expect(old.apiOrigin).toBeUndefined();
 expect(old).toMatchObject({legacy:{origin:'agent:art',for_in:'cv-123456789abc'},by:agent});
 expect(schedules(reopened.db).filter(s=>s.apiOrigin)).toHaveLength(20);
});
it('derives origin from the viewer, ignores caller-supplied origin, and keeps target-agent shares separate',async()=>{
 const {app,set}=await setup();
 for(let n=0;n<20;n++)expect(set(`api-${n}`,agent,{apiOrigin:undefined}).ok).toBe(true);
 expect(set('forged',agent,{apiOrigin:'someone-else'}).ok).toBe(false);
 const result=set('other-agent',{kind:'agent',id:'fish'},{agent:'fish',apiOrigin:'art'});
 expect(result.ok).toBe(true);
 expect((result as {value:Schedule}).value.apiOrigin).toBe('fish');
 const own=set('owner-origin',owner,{apiOrigin:'art'});
 expect(own.ok).toBe(true);
 expect((own as {value:Schedule}).value.apiOrigin).toBeUndefined();
 expect(schedules(app.db).filter(s=>s.agent==='art'&&s.apiOrigin)).toHaveLength(20);
});
it('retains the capacity boundary across restart',async()=>{
 const {app,set,open}=await setup();
 fillApiShare(set);
 await app.close();const reopened=await open();
 expect(reopened.operations.call('direct',agent,'clock.scheduleSet',{id:'overflow',agent:'art',at:'12:31',prompt:'Continue',note:''},randomUUID())).toMatchObject({ok:false,code:'invalid'});
 expect(schedules(reopened.db)).toHaveLength(20);
});

it('allows an owner replacement to stop consuming the API share',async()=>{
 const {app,set}=await setup();
 fillApiShare(set);
 expect(set('api-0',owner).ok).toBe(true);
 expect(schedules(app.db).find(s=>s.id==='api-0')?.apiOrigin).toBeUndefined();
 expect(set('new-slot').ok).toBe(true);
 expect(set('overflow').ok).toBe(false);
});

it('matching origin cannot bypass revoked mutation policy or dispatch admission',async()=>{
 const {app,set,access,clock,starts}=await setup();
 access.projects.pond={members:[],agents:['art']};
 expect(set('revoked',agent,{project:'pond'}).ok).toBe(true);
 expect(set('control').ok).toBe(true);
 const original=schedules(app.db).find(s=>s.id==='revoked')!;
 expect(original.apiOrigin).toBe(agent.id);
 access.projects.pond.agents=[];
 expect(set('revoked',agent,{project:'pond',prompt:'Changed'})).toMatchObject({ok:false,code:'denied'});
 expect(app.operations.call('direct',agent,'clock.scheduleRemove',{id:'revoked'},randomUUID())).toMatchObject({ok:false,code:'denied'});
 expect(schedules(app.db).find(s=>s.id==='revoked')).toEqual(original);
 const due=wakes(app.db).find(w=>w.schedule==='revoked')!;
 expect(app.operations.call('direct',agent,'clock.cancel',{id:due.id},randomUUID())).toMatchObject({ok:false,code:'denied'});
 clock.advance(due.due-clock.now());
 await Promise.resolve();await Promise.resolve();
 expect(starts).toHaveBeenCalledTimes(1);
 expect(starts.mock.calls[0][0].wake.schedule).toBe('control');
 expect(wakes(app.db).find(w=>w.id===due.id)).toMatchObject({state:'held',hold:'permission'});
 expect(app.db.prepare('SELECT record FROM clock_events WHERE wake=?').all(due.id).some(row=>JSON.parse((row as {record:string}).record).kind==='intent')).toBe(false);
});
it('matching origin metadata cannot release a private local wake or reveal it to an agent',async()=>{
 const starts=vi.fn(async (_input:Parameters<import('./role.js').Runtime['startBody']>[0])=>({state:'started' as const,body:'fixture-body'}));
 const s=await setupLocal('once',{startBody:starts});
 const privateCaller={...caller,member:'jonathan',people:['jonathan'],project:'pond'};
 const card=value<{id:string}>(s.request(prompt,'PRIVATE note',privateCaller));
 value(await s.app.operations.callAsync('socket',owner,'approvals.answer',{id:card.id,action:'allow'},randomUUID(),true));
 const row=value<{id:string;due:number}>(clockLocalRecovery(s.app.operations).schedule(privateCaller,{approval:card.id,mode:'in',when:'1h'}));
 const privateWake=wakes(s.app.db).find(w=>w.id===row.id)!;
 // Capacity metadata is deliberately copied onto protected work; it must do nothing to authority.
 s.app.db.prepare('UPDATE clock_wakes SET record=? WHERE id=?').run(JSON.stringify({...privateWake,apiOrigin:agent.id}),row.id);
 const dispatch=s.app.operations.call('direct',agent,'clock.dispatch',{id:row.id,attempt:randomUUID()},randomUUID());
 expect(dispatch).toMatchObject({ok:false,code:'denied'});
 expect(JSON.stringify(s.app.operations.call('direct',agent,'clock.list',{agent:'art'},randomUUID()))).not.toContain('PRIVATE note');
 value(s.app.operations.call('direct',owner,'clock.in',{agent:'art',when:'1m',prompt:'Ordinary positive control',note:'control'},randomUUID()));
 s.clock.advance(row.due-s.clock.now());await Promise.resolve();await Promise.resolve();
 expect(starts).toHaveBeenCalledTimes(1);
 expect(starts.mock.calls[0][0].wake.note).toBe('control');
 expect(wakes(s.app.db).find(w=>w.id===row.id)).toMatchObject({state:'held',hold:'permission',prompt,note:'PRIVATE note'});
 expect(s.app.db.prepare('SELECT record FROM clock_events WHERE wake=?').all(row.id).some(r=>JSON.parse((r as {record:string}).record).kind==='intent')).toBe(false);
});
