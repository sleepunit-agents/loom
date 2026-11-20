import {afterEach,expect,it} from 'vitest';
import {bodyFixture} from '../test/fixtures/conversation-body.js';
import {Jobs} from './runtime/jobs.js';
import * as s from './core/data/schema.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
const take=async(f:Awaited<ReturnType<typeof bodyFixture>>)=>(await(await f.root.http.request('/api/conversation/take',{method:'POST',headers:{authorization:'Bearer '+'b'.repeat(64),'content-type':'application/json'},body:JSON.stringify({input:{}})})).json()).value.items.map((item:{id:string})=>item.id) as string[];
const mail=(f:Awaited<ReturnType<typeof bodyFixture>>)=>f.db.select().from(s.inbox).all().map(row=>row.state);
const delivery=(f:Awaited<ReturnType<typeof bodyFixture>>)=>f.db.select().from(s.messages).all().filter(row=>row.kind==='message').map(row=>row.delivery);
// Mail is settled by its answer, not by the body receiving it (see ConversationMail.accept).
it('shows mail a body has received as delivered without settling it, so a body that dies before answering leaves it for the next attempt',async()=>{
 const f=await bodyFixture(clean),jobs=new Jobs(f.db,()=>new Date(f.clock.now()).toISOString());
 expect((await f.send('Question','one')).status).toBe(200);const items=await take(f);expect(items).toHaveLength(1);
 expect(delivery(f)).toEqual(['sending']);
 expect((await f.call('accept',{items},'accept')).status).toBe(200);
 expect(delivery(f)).toEqual(['delivered']);expect(mail(f)).toEqual(['taken']);
 // A repeat of the receipt changes nothing; mail this job does not hold is refused.
 expect((await f.call('accept',{items},'accept-again')).status).toBe(200);expect(mail(f)).toEqual(['taken']);
 expect((await f.call('accept',{items:['missing']},'accept-missing')).status).toBe(403);
 const {retry}=f.root.writes.run(()=>jobs.finish('job','box',1)).value;
 expect(retry).toBeDefined();expect(f.db.select().from(s.inbox).get()).toMatchObject({state:'waiting',job:retry!.id,doneAt:null});
 expect(delivery(f)).toEqual(['held']);
});
it('settles the mail a body took in the same write as its recorded reply, and never lets the answered mail run again',async()=>{
 const f=await bodyFixture(clean),jobs=new Jobs(f.db,()=>new Date(f.clock.now()).toISOString());
 expect((await f.send('Question','one')).status).toBe(200);const items=await take(f);
 expect((await f.call('accept',{items},'accept')).status).toBe(200);
 // Mail that arrives while the body works is not this answer's to settle.
 expect((await f.send('Later','two')).status).toBe(200);
 expect((await f.call('message',{kind:'reply',clientId:'answer',words:'Answer'},'reply')).status).toBe(200);
 expect(mail(f)).toEqual(['done','waiting']);
 // The body dies before its own confirmation: nothing answered is left to retry.
 f.root.writes.run(()=>jobs.finish('job','box',1));
 expect(f.db.select().from(s.inbox).all()[0]).toMatchObject({state:'done',job:'job'});expect(mail(f)).toEqual(['done','waiting']);
 expect(f.db.select().from(s.messages).all().filter(row=>row.kind==='reply')).toHaveLength(1);
});
