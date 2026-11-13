import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFoundation } from '../../core/app.js';
import { FakeClock, type Viewer } from '../../core/index.js';
import { fixtureSharing } from '../../fixture.js';
import { installChanges } from './index.js';
import { startChangesJob } from './jobs.js';
import { change } from './fixture.js';
import { loadChanges, replaceChanges } from './store.js';
import type { Attribution, Change, Project } from './model.js';
const cleanup:(()=>void)[]=[];
afterEach(()=>cleanup.splice(0).reverse().forEach(close=>close()));
const owner:Viewer={kind:'member',id:'jonathan'};
function setup(read:(repo:string,now:number)=>Promise<Change[]>) {
 const home=mkdtempSync(join(tmpdir(),'changes-job-'));cleanup.push(()=>rmSync(home,{recursive:true,force:true}));
 const clock=new FakeClock(),app=createFoundation({home,clock});cleanup.push(app.close);
 let job:ReturnType<typeof startChangesJob>;
 installChanges(app.db,app.operations,app.live,fixtureSharing,{onRefresh:()=>job.wake()});
 const config:{projects:Project[];attribution:Attribution}={projects:[{slug:'pond',name:'Pond',repos:['acme/app']}],attribution:{agents:{art:{logins:['art-bot'],branches:[]}},ownerLogins:[]}};
 job=startChangesJob(app,{clock,sharing:fixtureSharing,viewer:owner,projects:{list:()=>config.projects},attribution:()=>config.attribution,read});cleanup.push(job.close);
 return {app,clock,job,config};
}
it('reapplies current attribution to failed snapshots so a removed agent cannot authorize an answer',async()=>{
 const {app,job,config}=setup(async()=>{throw Error('unavailable');});
 replaceChanges(app.db,[change({agent:'art',mine:true,project:'pond'})]);config.attribution={agents:{},ownerLogins:[]};
 await job.run();expect(loadChanges(app.db)).toMatchObject([{mine:false,syncError:'GitHub read unavailable'}]);expect(loadChanges(app.db)[0].agent).toBeUndefined();
 expect(app.operations.call('direct',owner,'changes.answer',{id:change().id,head:change().head.id,action:'yes'},'answer')).toMatchObject({ok:false,code:'invalid'});
});
it('rechecks project mappings after the network wait and removes repos no longer mapped',async()=>{
 let release!:(rows:Change[])=>void;const read=vi.fn(()=>new Promise<Change[]>(resolve=>{release=resolve;}));
 const {app,job,config}=setup(read);const running=job.run();
 config.projects=[{slug:'private',name:'Private',repos:['acme/app']}];release([change({project:'pond'})]);await running;
 expect(loadChanges(app.db)).toMatchObject([{project:'private'}]);
 expect(app.operations.call('direct',{kind:'member',id:'pollock'},'changes.list',{})).toEqual({ok:true,value:[]});
 app.operations.call('direct',owner,'changes.refresh',{},'again');const removed=job.run();config.projects=[];release([change()]);await removed;expect(loadChanges(app.db)).toEqual([]);
});
it('retains a refresh requested during a read and prevents concurrent run or scheduled wake reads',async()=>{
 let release!:(rows:Change[])=>void;const read=vi.fn(()=>new Promise<Change[]>(resolve=>{release=resolve;}));
 const {app,job,clock}=setup(read);const first=job.run();await job.run();
 expect(app.operations.call('direct',owner,'changes.refresh',{},'during')).toMatchObject({ok:true});clock.advance(0);await Promise.resolve();expect(read).toHaveBeenCalledOnce();
 release([change()]);await first;
 expect(app.db.prepare('SELECT due,requested FROM changes_jobs').get()).toEqual({due:clock.now(),requested:1});
 const second=job.run();expect(read).toHaveBeenCalledTimes(2);release([change({title:'Requested later'})]);await second;
 expect(loadChanges(app.db)).toMatchObject([{title:'Requested later'}]);expect(app.db.prepare('SELECT due FROM changes_jobs').get()).toEqual({due:clock.now()+180000});
});
it('refuses external doors and unauthorized direct snapshot writes without changing data or due time',()=>{
 const {app,clock}=setup(async()=>[]);const before=change();replaceChanges(app.db,[before]);
 const input={records:[],due:clock.now()+999999,requested:0,error:false};
 for(const door of ['http','socket','mcp'] as const) {
  expect(app.operations.offered(door).some(op=>op.name==='changes.commit-sync')).toBe(false);
  expect(app.operations.call(door,owner,'changes.commit-sync',input,door)).toMatchObject({ok:false,code:'denied'});
 }
 for(const viewer of [{kind:'member',id:'pollock'},{kind:'agent',id:'art'},{kind:'service',id:'changes'},{kind:'runner',id:'art'}] as Viewer[])expect(app.operations.call('direct',viewer,'changes.commit-sync',input,viewer.kind)).toMatchObject({ok:false,code:'denied'});
 expect(loadChanges(app.db)).toEqual([before]);expect(app.db.prepare('SELECT due FROM changes_jobs').get()).toEqual({due:clock.now()});
});
it('backs off configuration/commit failures instead of scheduling a millisecond retry loop',async()=>{
 const {job,config,clock}=setup(async()=>[]);config.projects=[{slug:'broken',name:'Broken',repos:['invalid']}];
 const list=vi.spyOn(config,'projects','get');await job.run();const calls=list.mock.calls.length;clock.advance(59999);await Promise.resolve();expect(list.mock.calls).toHaveLength(calls);
});
