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
 const lifetime=workLifetime(f.db,clock,writes,errors);clean.push(()=>lifetime.close());
 const drain=()=>{for(const event of [...events].sort((a,b)=>a.at-b.at)){if(event.at<=time&&events.delete(event))event.fn();}};
 return {...f,service,card,writes,lifetime,events,errors,drain,setTime:(value:number)=>{time=value;},now:()=>time};
}
it('repairs expiry committed by a competing late spend before the timer callback gets a turn',async()=>{
 const f=await fixture();f.setTime(f.now()+60000);
 expect(f.writes.run(()=>f.service.use(f.card.id,'art','merge',f.card.target)).value.ok).toBe(false);
 expect(f.db.select().from(approvals).get()?.state).toBe('expired');expect(f.events.size).toBe(1);
 f.drain();expect(f.db.select().from(changes).get()?.waitingOn).toBe('you');expect(f.events.size).toBe(0);expect(f.errors).not.toHaveBeenCalled();
});
it('owns one timer, cancels it and detaches its write observer while an allowance is still outstanding',async()=>{
 const f=await fixture();expect(f.events.size).toBe(1);f.writes.run(()=>{});f.writes.run(()=>{});expect(f.events.size).toBe(1);
 f.lifetime.close();f.lifetime.close();expect(f.events.size).toBe(0);
 const select=vi.spyOn(f.db,'select');f.writes.run(()=>{});expect(select).not.toHaveBeenCalled();select.mockRestore();f.setTime(f.now()+60000);f.drain();expect(f.db.select().from(approvals).get()?.state).toBe('allowed');
});
it('leaves used allowances and higher-priority GitHub blockers alone',async()=>{
 const f=await fixture();f.writes.run(()=>f.service.use(f.card.id,'art','merge',f.card.target));expect(f.events.size).toBe(0);f.setTime(f.now()+60000);f.drain();expect(f.db.select().from(approvals).get()?.state).toBe('used');
 f.db.update(approvals).set({state:'allowed'}).where(eq(approvals.id,f.card.id)).run();f.db.update(changes).set({waitingOn:'ci'}).run();f.writes.run(()=>{});f.drain();expect(f.db.select().from(changes).get()?.waitingOn).toBe('ci');
});

it.each(['head','project'] as const)('does not reset a cached change whose %s changed before expiry',async label=>{
 const f=await fixture();f.db.update(changes).set(label==='head'?{headCommit:'b'.repeat(40)}:{project:'other'}).run();
 f.setTime(f.now()+60000);f.drain();expect(f.db.select().from(approvals).get()?.state).toBe('expired');expect(f.db.select().from(changes).get()?.waitingOn).toBe('agent');
});
