import {afterEach,expect,it,vi} from 'vitest';
import {bodyFixture} from '../test/fixtures/conversation-body.js';
import {approvalService} from './apps/approvals.js';
import {DataWrites} from './core/data/writes.js';
import {workLifetime} from './shared-work-lifetime.js';
import {approvals,changes,members} from './core/data/schema.js';
import {eq} from 'drizzle-orm';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const stop of clean.splice(0).reverse())await stop();});
async function fixture(){
 const f=await bodyFixture(clean);await f.root.close();let time=f.clock.now();const now=()=>new Date(time).toISOString();
 f.db.insert(members).values({id:'pat',role:'owner',joinedAt:now()}).run();
 const head='a'.repeat(40),id='github:house/loom#1';
 f.db.insert(changes).values({id,repository:'house/loom',number:1,title:'Fixture',body:'',url:'',state:'open',draft:false,authorLogin:'art',agent:'art',project:'pond',branch:'work',headCommit:head,baseBranch:'next',checks:'passing',review:'approved',mergeable:'yes',waitingOn:'agent',openedAt:now(),updatedAt:now()}).run();
 const service=approvalService(f.db,new Map(),now),card=service.request({kind:'merge',target:id+'@'+head,what:'Fixture',why:'Fixture',agent:'art',askedFrom:'fixture',actingFor:'alice',project:'pond',member:'alice',conversation:f.thread.conversation,ask:'Merge?',ifYes:'Merge',ifNo:'Wait',minutes:1});service.allow(card.id,'pat');
 const writes=new DataWrites(f.db,{refreshAccess(){},changed(){}}),events=new Set<{at:number;fn:()=>void}>(),clock={now:()=>time,at(at:number,fn:()=>void){const event={at,fn};events.add(event);return()=>{events.delete(event);};}},errors=vi.fn();
 // What the lifetime registers is wrapped, so a test can tell whether a commit still reaches it.
 const heard=vi.fn(),observe=writes.observe.bind(writes);writes.observe=committed=>observe(()=>{heard();committed();});
 const lifetime=workLifetime(f.db,clock,writes,errors);clean.push(()=>lifetime.close());
 // A commit that wrote no row tells nobody (DataWrites.run), so an announcement here is a commit of a real row.
 const commit=()=>writes.run(()=>{f.db.update(members).set({joinedAt:now()}).where(eq(members.id,'pat')).run();});
 const drain=()=>{for(const event of [...events].sort((a,b)=>a.at-b.at)){if(event.at<=time&&events.delete(event))event.fn();}};
 return {...f,service,card,writes,lifetime,events,errors,drain,heard,commit,setTime:(value:number)=>{time=value;},now:()=>time};
}
it('repairs expiry committed by a competing late spend before the timer callback gets a turn',async()=>{
 const f=await fixture();f.setTime(f.now()+60000);
 expect(f.writes.run(()=>f.service.use(f.card.id,'art','merge',f.card.target)).value.ok).toBe(false);
 expect(f.db.select().from(approvals).get()?.state).toBe('expired');expect(f.events.size).toBe(1);
 f.drain();expect(f.db.select().from(changes).get()?.waitingOn).toBe('you');expect(f.events.size).toBe(0);expect(f.errors).not.toHaveBeenCalled();
});
it('owns one timer, cancels it and detaches its write observer while an allowance is still outstanding',async()=>{
 const f=await fixture();expect(f.events.size).toBe(1);const first=[...f.events][0];
 // Each commit is heard and sets the timer again: the one before it is cancelled, never left beside the new one.
 f.commit();f.commit();expect(f.heard).toHaveBeenCalledTimes(2);expect(f.events.size).toBe(1);expect([...f.events][0]).not.toBe(first);
 f.lifetime.close();f.lifetime.close();expect(f.events.size).toBe(0);
 f.commit();expect(f.heard).toHaveBeenCalledTimes(2);expect(f.events.size).toBe(0);f.setTime(f.now()+60000);f.drain();expect(f.db.select().from(approvals).get()?.state).toBe('allowed');
});
it('leaves used allowances and higher-priority GitHub blockers alone',async()=>{
 const f=await fixture();f.writes.run(()=>f.service.use(f.card.id,'art','merge',f.card.target));expect(f.events.size).toBe(0);f.setTime(f.now()+60000);f.drain();expect(f.db.select().from(approvals).get()?.state).toBe('used');
 // The allowance is outstanding again and past its time, and the change now waits on CI. The commit arms the
 // timer; the allowance expires, and the change is not handed back to the person over the blocker.
 f.writes.run(()=>{f.db.update(approvals).set({state:'allowed'}).where(eq(approvals.id,f.card.id)).run();f.db.update(changes).set({waitingOn:'ci'}).run();});
 expect(f.events.size).toBe(1);f.drain();expect(f.db.select().from(approvals).get()?.state).toBe('expired');expect(f.db.select().from(changes).get()?.waitingOn).toBe('ci');
});

it.each(['head','project'] as const)('does not reset a cached change whose %s changed before expiry',async label=>{
 const f=await fixture();f.db.update(changes).set(label==='head'?{headCommit:'b'.repeat(40)}:{project:'other'}).run();
 f.setTime(f.now()+60000);f.drain();expect(f.db.select().from(approvals).get()?.state).toBe('expired');expect(f.db.select().from(changes).get()?.waitingOn).toBe('agent');
});
