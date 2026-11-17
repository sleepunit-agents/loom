import {afterEach,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import {bodyFixture,bodyCredentials as raw} from '../test/fixtures/conversation-body.js';
import {bodyConversationClient} from './runtime/conversation-client.js';
import * as s from './core/data/schema.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
async function fixture(){
 const f=await bodyFixture(clean);
 const client=bodyConversationClient({url:'https://loom.invalid',token:raw.body,job:'job',conversation:f.thread.conversation,signal:new AbortController().signal,clock:f.clock,fetch:async(url,init)=>f.root.http.request(new Request(url,init))});clean.push(()=>client.close());return {...f,client};
}
// A body that waits for a person says so in its agent's status; its job goes on running.
it('delivers a real person answer to the same body that waited for it and confirms it without admitting another job',async()=>{
 const f=await fixture();await f.client.status({state:'waiting',work:'Awaiting a person'});const ask=await f.client.digest({summary:'Need the fixture choice',question:{to:'alice',answers:'yes-no',words:'Use this fictitious fixture?'}});
 const response=await f.root.http.request('/api/inbox/answer',{method:'POST',headers:{cookie:'loom_ui='+raw.memberCookie,'content-type':'application/json'},body:JSON.stringify({input:{item:ask.item,answer:'yes'},id:'person-answer'})});expect(response.status).toBe(200);
 f.root.writes.run(()=>{f.db.insert(s.agentModels).values({agent:'art',model:'fixture',position:0}).run();f.db.insert(s.agentRunSettings).values({agent:'art',houseRepository:'fixture',houseFile:'Housefile',houseBranch:'next',nestedContainers:false,gpu:false}).run();});
 expect(f.root.services.runtime.admit({kind:'agent',id:'art'},f.db.select().from(s.inbox).all())).toBe(true);expect(f.db.select().from(s.jobs).all()).toHaveLength(1);
 const accepted:string[]=[];expect(await f.client.takeAndAccept(async item=>{expect(item).toMatchObject({source:'answer',sourceId:ask.item,verdict:'yes',words:'yes'});accepted.push(item.id);})).toEqual({accepted:1,stopRequested:false});expect(accepted).toHaveLength(1);await f.client.settle();expect(f.db.select().from(s.inbox).where(eq(s.inbox.source,'answer')).get()?.state).toBe('done');
 expect(await f.client.reply({clientId:'resumed',words:'I received the fictitious answer',model:'actual'})).toMatchObject({saved:true});expect(f.db.select().from(s.jobs).get()?.state).toBe('running');
 f.clock.advance(1000);const resumed=await f.root.http.request('/api/runtime/heartbeat',{method:'POST',headers:{authorization:'Bearer '+raw.runner,'content-type':'application/json'},body:JSON.stringify({input:{job:'job',state:'running'},id:'worker-resumed'})});expect(resumed.status).toBe(200);expect(f.db.select().from(s.jobs).get()).toMatchObject({state:'running',heardAt:new Date(f.clock.now()).toISOString()});
 await f.client.status({state:'idle',work:'Fictitious answer handled'});const finished=await f.root.http.request('/api/runtime/finish',{method:'POST',headers:{authorization:'Bearer '+raw.runner,'content-type':'application/json'},body:JSON.stringify({input:{job:'job',exitCode:0,logTail:''},id:'waiting-finished'})});expect(finished.status).toBe(200);expect(f.db.select().from(s.jobs).get()?.state).toBe('done');
});
it('keeps status reports and current-run controls available without changing their job ownership',async()=>{
 const f=await fixture();const turn=await f.client.turn({kind:'note'});expect(turn).toMatchObject({saved:true,conversation:f.thread.conversation});expect(await f.client.finding({turnSeq:turn.seq,measure:'useful',score:4,text:'Explicit fictitious review'})).toMatchObject({saved:true});expect(await f.client.status({state:'working',work:'Continuing'})).toEqual({saved:true,stopRequested:false});const card=await f.client.card({clientId:'step',words:'Fictitious step',tool:'Read',cardState:'running'});expect(await f.client.cardState('step','done')).toEqual({saved:true,seq:card.seq});expect(await f.client.title('Agent title')).toEqual({saved:true,renamed:false});expect(f.db.select().from(s.jobs).get()).toMatchObject({id:'job',state:'running'});
 f.root.services.runtime.stop('job','alice','reset');await expect(f.client.status({state:'idle',work:''})).rejects.toThrow();await expect(f.client.takeAndAccept(async()=>{})).rejects.toThrow();
});
it('continues refusing pre-start bodies and ordinary credentials',async()=>{
 const f=await fixture();for(const [index,token]of [raw.agent,raw.member,raw.runner].entries())expect((await f.call('turn',{kind:'note'},'wrong-'+index,token)).status).toBe(403);
 f.root.writes.run(()=>f.db.update(s.jobs).set({state:'starting'}).where(eq(s.jobs.id,'job')).run());expect((await f.call('turn',{kind:'note'},'before-ack')).status).toBe(403);await expect(f.client.takeAndAccept(async()=>{})).rejects.toThrow();expect(f.db.select().from(s.turns).all()).toEqual([]);
});
it('rechecks the exact private assignment after decrypt while the current job runs',async()=>{
 const f=await fixture();await f.send('PRIVATE WAITING INPUT','waiting-input');f.openGate(async()=>{f.root.writes.run(()=>f.db.delete(s.memberAgents).where(eq(s.memberAgents.agent,'art')).run());});let accepted=false;
 await expect(f.client.takeAndAccept(async()=>{accepted=true;})).rejects.toThrow();expect(accepted).toBe(false);expect(f.db.select().from(s.inbox).get()).toMatchObject({state:'waiting',job:null});expect((await f.call('status',{state:'idle',work:''},'revoked')).status).toBe(403);
});
