/** In-process next-mode proof of Home's Runtime projection; no browser or runner process. */
import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../../../src/foundation';
import { FakeClock, type RecordType, type Viewer } from '../../../../src/core';
import { fixture, fixtureSharing, installFixture } from '../../../../src/fixture';
import { runtimeStore } from '../../../../src/pieces/runtime/store';
import { currentRuntimeJobs, type RuntimeJob } from './home-model';
it('projects actual next-mode Runtime queue/report/finish records with each original member’s visibility',async()=>{
  const home=mkdtempSync(join(tmpdir(),'home-runtime-'));fixture(home);
  const types=new Map<string,RecordType>(),clock=new FakeClock(1);
  const app=await startLoom({home,next:true,clock,sharing:fixtureSharing,install(app){
    const register=app.live.register.bind(app.live);app.live.register=type=>{types.set(type.name,type);register(type);};installFixture(app);
  }});
  try {
    const store=runtimeStore(app.db),owner:Viewer={kind:'member',id:'jonathan'},pollock:Viewer={kind:'member',id:'pollock'},runner:Viewer={kind:'runner',id:'fixture-worker'};
    app.db.transaction(()=>{
      store.put('box',{id:runner.id,name:'Fixture',owner:owner.id,local:false,mayHost:'*',lentTo:['pond-bot'],facts:[],labels:[],alwaysOn:false,reportOnly:false,createdAt:1},1);
      for(const agent of ['art','pond-bot'])store.put('settings',{id:agent,agent,boxes:[runner.id]},1);
      store.put('job',{id:'old-owner-job',agent:'pond-bot',title:'Owner-private work',project:'pond',member:'jonathan',runner:runner.id,box:runner.id,state:'waiting',createdAt:1},1);
    })();
    let serial=0;
    const queue=(viewer:Viewer,agent:string,project?:string)=>app.operations.call('direct',viewer,'runtime.queueBody',{agent,title:'Concurrent work',brief:'PRIVATE INPUT',...(project?{project}:{})},`queue:${++serial}`);
    expect(queue(owner,'pond-bot','pond')).toMatchObject({ok:false,code:'denied'});
    const job=(r:ReturnType<typeof queue>)=>{expect(r.ok).toBe(true);if(!r.ok)throw Error('Queue failed');return (r.value as {job:string}).job;};
    const art=job(queue(owner,'art'));job(queue(owner,'art'));job(queue(pollock,'pond-bot','pond'));
    const jobs=(viewer:Viewer,agent:string)=>{
      const type=types.get('runtime.job')!;
      return currentRuntimeJobs(type.ids(undefined).flatMap(id=>{const r=type.read(id,viewer);return r?[r as RuntimeJob]:[];}),agent);
    };
    expect(jobs(owner,'art')).toHaveLength(2);expect(jobs(pollock,'art')).toEqual([]);
    expect(jobs(pollock,'pond-bot')).toMatchObject([{title:'Concurrent work',state:'queued'}]);
    expect(JSON.stringify(jobs(pollock,'pond-bot'))).not.toContain('Owner-private work');
    expect(app.operations.call('direct',owner,'runtime.configureHouse',{agent:'art',house:{repo:'/fixture/art'}},'configure').ok).toBe(true);
    expect(app.operations.call('direct',runner,'runtime.claimJob',{job:art},'claim').ok).toBe(true);
    for(const state of ['running','waiting'] as const){
      expect(app.operations.call('direct',runner,'runtime.reportJob',{job:art,state,log:'PRIVATE LOG'},state).ok).toBe(true);
      expect(jobs(owner,'art').find(j=>j.id===art)?.state).toBe(state);
    }
    expect(JSON.stringify(jobs(owner,'art'))).not.toMatch(/PRIVATE INPUT|PRIVATE LOG/);
    expect(app.operations.call('direct',runner,'runtime.finishJob',{job:art,state:'done'},'finish').ok).toBe(true);
    expect(jobs(owner,'art')).toHaveLength(1);expect(jobs(owner,'art').some(j=>j.id===art)).toBe(false);
  }finally{await app.close();rmSync(home,{recursive:true,force:true});}
});
