import {afterEach,expect,it} from 'vitest';
import {and,eq,inArray} from 'drizzle-orm';
import {bodyFixture,bodyCredentials as raw} from '../test/fixtures/conversation-body.js';
import * as s from './core/data/schema.js';
import {Jobs} from './runtime/jobs.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const stop of clean.splice(0).reverse())await stop();});
async function fixture(){const f=await bodyFixture(clean);expect((await f.call('status',{state:'working',work:'Reported active turn'},'working')).status).toBe(200);f.root.writes.run(()=>f.root.services.comms!.threads.requestStop(f.thread.id));return f;}
it.each(['finish','stop','lost'] as const)('ends the exact Comms working interval on actual runtime %s, preserving unobserved Stop and reported state',async how=>{
 const f=await fixture(),reported=f.db.select().from(s.agentStatus).get()!;
 if(how==='finish')expect((await f.root.http.request('/api/runtime/finish',{method:'POST',headers:{authorization:'Bearer '+raw.runner,'content-type':'application/json'},body:JSON.stringify({input:{job:'job',exitCode:0,logTail:'PRIVATE DISCARDED'},id:'finished'})})).status).toBe(200);
 else if(how==='stop')f.root.services.runtime.stop('job','alice','reset');
 else {f.root.writes.run(()=>f.db.update(s.jobs).set({heardAt:new Date(f.clock.now()-120001).toISOString()}).where(eq(s.jobs.id,'job')).run());f.root.services.runtime.sweep();expect(f.db.select().from(s.jobs).where(eq(s.jobs.id,'job')).get()?.state).toBe('lost');}
 expect(f.db.select().from(s.threads).get()).toMatchObject({working:false,workingSince:null,workingBeat:null,stopRequested:true});expect(f.db.select({id:s.jobs.id}).from(s.jobs).where(and(eq(s.jobs.conversation,f.thread.conversation),inArray(s.jobs.state,['queued','starting','running','waiting']))).all()).toEqual([]);expect(f.db.select().from(s.agentStatus).get()).toEqual(reported);expect((await f.call('status',{state:'working',work:'Late'},'late')).status).toBe(401);
});
it('rolls back working cleanup together with the ending job and leaves other conversations active',async()=>{
 const f=await fixture(),other=f.root.services.comms!.threads.open({member:'alice',agent:'art',title:'Other'});f.root.services.comms!.threads.working(other.id,true);
 expect(()=>f.root.writes.run(()=>{new Jobs(f.db,()=>new Date(f.clock.now()).toISOString()).finish('job','box',0);throw Error('Fictitious receipt failure');})).toThrow('Fictitious receipt failure');
 expect(f.db.select().from(s.jobs).get()?.state).toBe('running');expect(f.db.select({id:s.jobs.id}).from(s.jobs).where(and(eq(s.jobs.conversation,f.thread.conversation),inArray(s.jobs.state,['queued','starting','running','waiting']))).all()).toEqual([{id:'job'}]);expect(f.root.services.comms!.threads.thread(f.thread.id).working).toBe(true);
 f.root.services.runtime.stop('job','alice','reset');expect(f.root.services.comms!.threads.thread(f.thread.id).working).toBe(false);expect(f.root.services.comms!.threads.thread(other.id).working).toBe(true);
});
