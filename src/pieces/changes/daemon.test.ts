import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFoundation } from '../../core/app.js';
import { FakeClock } from '../../core/clock.js';
import { migrateHouseholdTables } from '../../core/household/schema.js';
import { HouseholdRows } from '../../core/household/rows.js';
import { HouseholdDatabase } from '../../core/household/document.js';
import { SharingDatabase } from '../../core/household/sharing.js';
import { installChangesDaemon, householdProjects } from './daemon.js';
import { change } from './fixture.js';
import { replaceChanges } from './store.js';

const closes:(()=>void)[]=[],homes:string[]=[];
afterEach(()=>{for(const close of closes.splice(0).reverse())close();for(const h of homes.splice(0))rmSync(h,{recursive:true,force:true});});
function setup(staging=false, request:typeof fetch=vi.fn() as unknown as typeof fetch) {
 const home=mkdtempSync(join(tmpdir(),'changes-daemon-'));homes.push(home);
 const clock=new FakeClock(),app=createFoundation({home,clock});closes.push(app.close);
 migrateHouseholdTables(app.db);
 app.db.transaction(()=>new HouseholdDatabase(app.db).replace(home,{v:1,agents:['art'],members:[{person:'jonathan',role:'owner',agents:'*'}]}))();
 const store=new SharingDatabase(app.db,home);
 const project={slug:'pond',name:'Pond',repositories:['acme/app'],members:[],agents:['art']};
 app.db.transaction(()=>store.create(project))();
 const secrets={resolveGitHub:vi.fn(async()=>'github-acme'),withValue:async<T>(_ref:string,use:(token:string)=>Promise<T>)=>use('fake-test-token')};
 const job=installChangesDaemon(app,{home,clock,sharing:()=>store.sharing(),attribution:()=>({agents:{art:{logins:['art-bot'],branches:[]}},ownerLogins:[]}),secrets,staging,request});closes.push(job.close);
 return {app,clock,store,job,secrets,home};
}
it('reads destination household projects dynamically and holds all credential and forge access in staging',async()=>{
 const {app,clock,store,secrets}=setup(true);
 replaceChanges(app.db,[change({project:'spoof'})]);
 expect(householdProjects(store).list()).toEqual([{slug:'pond',name:'Pond',repos:['acme/app']}]);
 app.db.transaction(()=>store.create({slug:'other',name:'Other',repositories:['else/app'],members:[],agents:[]}))();
 expect(householdProjects(store).list()).toHaveLength(2);
 expect(app.operations.call('direct',{kind:'member',id:'jonathan'},'changes.refresh',{},'refresh')).toMatchObject({ok:true});
 clock.advance(0);await Promise.resolve();
 expect(secrets.resolveGitHub).not.toHaveBeenCalled();
 expect(app.operations.call('direct',{kind:'member',id:'jonathan'},'changes.list',{})).toMatchObject({ok:true,value:[{project:'pond'}]});
});
it('stops scheduling and discards an in-flight read before the foundation closes',async()=>{
 let release!:(response:Response)=>void;
 const empty=()=>Response.json({data:{repository:{pullRequests:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}}}});
 const request=vi.fn(async()=>empty()).mockImplementationOnce(()=>new Promise<Response>(resolve=>{release=resolve;})) as unknown as typeof fetch;
 const {app,job,clock,secrets}=setup(false,request);
 const running=job.run();
 await vi.waitFor(()=>expect(request).toHaveBeenCalledOnce());
 app.close();
 release(Response.json({data:{repository:{pullRequests:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}}}}));
 await running;
 clock.advance(3600000);
 expect(secrets.resolveGitHub).toHaveBeenCalledOnce();
 expect(app.db.open).toBe(false);
});
it('invalidates derived changes when approval standing rules change',()=>{
 const {app}=setup(true);replaceChanges(app.db,[change()]);
 const events:unknown[]=[];app.live.observe(changes=>events.push(...changes));
 app.live.changed([{type:'approval-rule',id:'merge-rule'}]);
 expect(events).toContainEqual({type:'change',id:change().id});
});
it('does not start another repository read when an in-flight request fails after shutdown',async()=>{
 let reject!:(error:Error)=>void;
 const request=vi.fn().mockImplementationOnce(()=>new Promise<Response>((_resolve,no)=>{reject=no;})).mockResolvedValue(Response.json({data:{repository:{pullRequests:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}}}})) as unknown as typeof fetch;
 const {app,store,job,secrets}=setup(false,request);
 app.db.transaction(()=>store.create({slug:'second',name:'Second',repositories:['else/app'],members:[],agents:[]}))();
 const running=job.run();await vi.waitFor(()=>expect(request).toHaveBeenCalledOnce());
 app.close();reject(Error('unavailable'));await running;
 expect(secrets.resolveGitHub).toHaveBeenCalledOnce();expect(request).toHaveBeenCalledOnce();
});
it('discards a late response after closing only the job with the foundation still open',async()=>{
 let release!:(response:Response)=>void;
 const request=vi.fn().mockImplementationOnce(()=>new Promise<Response>(resolve=>{release=resolve;})) as unknown as typeof fetch;
 const {app,job}=setup(false,request);const c=change({project:'pond'});replaceChanges(app.db,[c]);
 const before=app.db.prepare('SELECT * FROM changes_jobs').all(),running=job.run();await vi.waitFor(()=>expect(request).toHaveBeenCalledOnce());
 job.close();release(Response.json({data:{repository:{pullRequests:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}}}}));await running;
 expect(app.db.open).toBe(true);expect(app.db.prepare('SELECT record FROM changes_changes').get()).toEqual({record:JSON.stringify(c)});expect(app.db.prepare('SELECT * FROM changes_jobs').all()).toEqual(before);
});
it('projects current destination mappings and agent membership before another forge refresh',()=>{
 const {app,store,home}=setup(true);replaceChanges(app.db,[change({project:'pond'})]);
 app.db.transaction(()=>{new HouseholdRows(app.db,'projects').remove('pond');store.create({slug:'private',name:'Private',repositories:['acme/app'],members:[],agents:[]});})() ;
 expect(app.operations.call('direct',{kind:'member',id:'jonathan'},'changes.show',{id:change().id})).toMatchObject({ok:true,value:{project:'private',agent:'art'}});
 app.db.transaction(()=>new HouseholdDatabase(app.db).replace(home,{v:1,agents:['other'],members:[{person:'jonathan',role:'owner',agents:'*'}]}))();
 const result=app.operations.call('direct',{kind:'member',id:'jonathan'},'changes.show',{id:change().id});expect(result).toMatchObject({ok:true});if(result.ok)expect((result.value as {agent?:string}).agent).toBeUndefined();
});

it('commits with the installed service even after the original household owner is replaced',async()=>{
 const {app,job,home,clock}=setup(true);
 replaceChanges(app.db,[change({project:'pond'})]);
 app.db.transaction(()=>new HouseholdDatabase(app.db).replace(home,{v:1,agents:['art'],members:[{person:'replacement',role:'owner',agents:'*'}]}))();
 await job.run();
 expect(app.db.prepare("SELECT value FROM changes_meta WHERE key='sync-status'").get()).toBeDefined();
 expect(app.db.prepare('SELECT due FROM changes_jobs').get()).toEqual({due:clock.now()+180000});
});
