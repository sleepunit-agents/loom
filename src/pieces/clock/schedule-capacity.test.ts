import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
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
 const open=async()=>{const app=await startLoom({home,clock:new FakeClock(),install(app){const jobs=installClock(app.db,app.operations,app.live,()=>sharing);app.onClose(jobs.close);}});const close=app.close;let closed=false;app.close=async()=>{if(!closed){closed=true;await close();}};cleanup.push(app.close);return app;};
 const app=await open();
 const set=(id:string,viewer:Viewer=agent,extra:object={})=>app.operations.call('direct',viewer,'clock.scheduleSet',{id,agent:'art',at:'12:31',prompt:'Continue work',note:'schedule',...extra},randomUUID());
 return {app,open,set};
}
it('rejects the twenty-first new API-origin schedule without recording any part of it',async()=>{
 const {app,set}=await setup();
 for(let n=0;n<20;n++)expect(set(`api-${n}`).ok).toBe(true);
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
 for(let n=0;n<20;n++)expect(set(`api-${n}`).ok).toBe(true);
 expect(schedules(app.db)).toHaveLength(41);
 expect(set('overflow').ok).toBe(false);
 expect(set('owner-extra',owner).ok).toBe(true);
});
it('allows replacement at capacity and frees a slot only after removal',async()=>{
 const {app,set}=await setup();
 for(let n=0;n<20;n++)expect(set(`api-${n}`).ok).toBe(true);
 expect(set('api-0',agent,{prompt:'Replacement'}).ok).toBe(true);
 expect(set('overflow').ok).toBe(false);
 expect(app.operations.call('direct',owner,'clock.scheduleRemove',{id:'api-1'},randomUUID()).ok).toBe(true);
 expect(set('new-slot').ok).toBe(true);
 expect(set('overflow').ok).toBe(false);
});
it('counts disabled origin-bearing schedules but ignores historical rows without authenticated origin',async()=>{
 const {app,set}=await setup();
 for(let n=0;n<20;n++)expect(set(`api-${n}`).ok).toBe(true);
 for(const row of schedules(app.db))app.db.prepare('UPDATE clock_schedules SET record=? WHERE id=?').run(JSON.stringify({...row,enabled:false}),row.id);
 expect(set('overflow').ok).toBe(false);
 const historical=schedules(app.db)[0];delete historical.apiOrigin;
 app.db.prepare('UPDATE clock_schedules SET record=? WHERE id=?').run(JSON.stringify(historical),historical.id);
 expect(set('new-slot').ok).toBe(true);
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
 for(let n=0;n<20;n++)expect(set(`api-${n}`).ok).toBe(true);
 await app.close();const reopened=await open();
 expect(reopened.operations.call('direct',agent,'clock.scheduleSet',{id:'overflow',agent:'art',at:'12:31',prompt:'Continue',note:''},randomUUID())).toMatchObject({ok:false,code:'invalid'});
 expect(schedules(reopened.db)).toHaveLength(20);
});

it('allows an owner replacement to stop consuming the API share',async()=>{
 const {app,set}=await setup();
 for(let n=0;n<20;n++)expect(set(`api-${n}`).ok).toBe(true);
 expect(set('api-0',owner).ok).toBe(true);
 expect(schedules(app.db).find(s=>s.id==='api-0')?.apiOrigin).toBeUndefined();
 expect(set('new-slot').ok).toBe(true);
 expect(set('overflow').ok).toBe(false);
});
