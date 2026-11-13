import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFoundation } from '../../core/app.js';
import { FakeClock, type Viewer } from '../../core/index.js';
import { builtinServices } from '../../core/services.js';
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
 const config:{projects:Project[];attribution:Attribution;agents:string[];service:boolean}={service:true,agents:['art'],projects:[{slug:'pond',name:'Pond',repos:['acme/app']}],attribution:{agents:{art:{logins:['art-bot'],branches:[]}},ownerLogins:[]}};
 const sharing=()=>{const value=fixtureSharing();value.services=config.service?builtinServices(app.db):{};return value;};
 installChanges(app.db,app.operations,app.live,sharing,{onRefresh:()=>job.wake()});
 job=startChangesJob(app,{knownAgents:()=>config.agents,clock,sharing,projects:{list:()=>config.projects},attribution:()=>config.attribution,read});cleanup.push(job.close);
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
 for(const viewer of [{kind:'member',id:'jonathan'},{kind:'member',id:'pollock'},{kind:'agent',id:'art'},{kind:'service',id:'other'},{kind:'runner',id:'art'}] as Viewer[])expect(app.operations.call('direct',viewer,'changes.commit-sync',input,viewer.kind)).toMatchObject({ok:false,code:'denied'});
 expect(loadChanges(app.db)).toEqual([before]);expect(app.db.prepare('SELECT due FROM changes_jobs').get()).toEqual({due:clock.now()});
});
it('backs off configuration/commit failures instead of scheduling a millisecond retry loop',async()=>{
 const {job,config,clock}=setup(async()=>[]);config.projects=[{slug:'broken',name:'Broken',repos:['invalid']}];
 const list=vi.spyOn(config,'projects','get');await job.run();const calls=list.mock.calls.length;clock.advance(59999);await Promise.resolve();expect(list.mock.calls).toHaveLength(calls);
});
it('does not attribute a stale mapping to an agent that is absent from the destination household',async()=>{
 const {app,job,config}=setup(async()=>[change()]);config.agents=[];await job.run();
 expect(loadChanges(app.db)[0].agent).toBeUndefined();
});
it('keeps expired closed detail through successful and unavailable daemon reads while hiding it from lists',async()=>{
 let fail=false;const {app,job,clock}=setup(async()=>{if(fail)throw Error('unavailable');return [];});
 const closed=change({state:'merged',closed:new Date(clock.now()).toISOString()});replaceChanges(app.db,[closed]);
 clock.advance(7*86400_000);await job.run();
 expect(app.operations.call('direct',owner,'changes.list',{})).toEqual({ok:true,value:[]});
 expect(app.operations.call('direct',owner,'changes.show',{id:closed.id})).toMatchObject({ok:true,value:{state:'merged'}});
 fail=true;app.operations.call('direct',owner,'changes.refresh',{},'failed');await job.run();
 expect(app.operations.call('direct',owner,'changes.show',{id:closed.id})).toMatchObject({ok:true,value:{state:'merged',syncError:'GitHub read unavailable'}});
});
it('rechecks service registration after it is removed during an in-flight read',async()=>{
 let release!:(rows:Change[])=>void;const {app,job,config}=setup(()=>new Promise<Change[]>(resolve=>{release=resolve;}));
 const before=change({title:'Retain prior snapshot'});replaceChanges(app.db,[before]);const state=app.db.prepare('SELECT * FROM changes_jobs').all();
 const running=job.run();config.service=false;release([change({title:'Unauthorized replacement'})]);await running;
 expect(loadChanges(app.db)).toEqual([before]);expect(app.db.prepare('SELECT * FROM changes_jobs').all()).toEqual(state);
});

it('allows the installed service and refuses commits after close',()=>{
 const {app,job,clock}=setup(async()=>[]);
 const input={records:[],due:clock.now()+180000,requested:0,error:false};
 expect(app.operations.call('direct',{kind:'service',id:'changes'},'changes.commit-sync',input,'installed')).toMatchObject({ok:true});
 job.close();
 const before=app.db.prepare('SELECT * FROM changes_jobs').all();
 expect(app.operations.call('direct',{kind:'service',id:'changes'},'changes.commit-sync',input,'closed')).toMatchObject({ok:false,code:'denied'});
 expect(app.db.prepare('SELECT * FROM changes_jobs').all()).toEqual(before);
});
