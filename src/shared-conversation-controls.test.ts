import {afterEach,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import {bodyFixture,bodyCredentials as raw} from '../test/fixtures/conversation-body.js';
import * as s from './core/data/schema.js';
import {bodyConversationClient} from './runtime/conversation-client.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const stop of clean.splice(0).reverse())await stop();});
const fixture=()=>bodyFixture(clean);
async function automaticThread(f:Awaited<ReturnType<typeof fixture>>){
 const response=await f.root.http.request('/api/comms/open',{method:'POST',headers:{cookie:'loom_ui='+raw.memberCookie,'content-type':'application/json'},body:JSON.stringify({input:{thread:'th:auto',agent:'art'},id:'auto'})});expect(response.status).toBe(200);
 const opened=(await response.json()).value as {thread:string;conversation:string};
 f.root.writes.run(()=>{f.db.update(s.conversations).set({job:null}).where(eq(s.conversations.id,f.thread.conversation)).run();f.db.update(s.jobs).set({conversation:opened.conversation,project:null}).where(eq(s.jobs.id,'job')).run();f.db.update(s.conversations).set({job:'job'}).where(eq(s.conversations.id,opened.conversation)).run();});return opened;
}
it('names automatic threads through the current body and preserves a later human title',async()=>{
 const f=await fixture(),opened=await automaticThread(f);expect(f.root.services.comms!.threads.thread(opened.thread)).toMatchObject({title:'New conversation',titledBy:'agent'});
 expect(await(await f.call('title',{title:'PRIVATE AGENT TITLE'},'agent-title')).json()).toEqual({ok:true,value:{saved:true,renamed:true}});expect(f.root.services.conversations.conversation(opened.conversation).label).toBe('PRIVATE AGENT TITLE');
 const changed=await f.root.http.request('/api/comms/change',{method:'POST',headers:{cookie:'loom_ui='+raw.memberCookie,'content-type':'application/json'},body:JSON.stringify({input:{thread:opened.thread,change:'rename',title:'Person chose this'},id:'human-title'})});expect(changed.status).toBe(200);
 expect(await(await f.call('title',{title:'Must preserve human'},'later-agent')).json()).toEqual({ok:true,value:{saved:true,renamed:false}});expect(f.root.services.comms!.threads.thread(opened.thread)).toMatchObject({title:'Person chose this',titledBy:'member'});expect(f.root.services.conversations.conversation(opened.conversation).label).toBe('Person chose this');
 expect(JSON.stringify(f.db.select().from(s.operationResults).all())).not.toContain('PRIVATE AGENT TITLE');expect(f.db.select().from(s.operationResults).where(eq(s.operationResults.operation,'conversation.title')).get()?.inputHash).toBe(f.root.services.comms!.key.hash('body-output\0job\0'+JSON.stringify({title:'PRIVATE AGENT TITLE'})));expect((await f.call('title',{title:'x'.repeat(61)},'too-long')).status).toBe(400);
});
it('updates an existing current-run progress card without another message, turn or word lease',async()=>{
 const f=await fixture();expect((await f.call('message',{kind:'card',clientId:'step',words:'PRIVATE STEP',tool:'Read',cardState:'running'},'start')).status).toBe(200);const before=f.db.select().from(s.messages).get()!;
 for(const [id,state]of [['done','done'],['retry','done'],['failed','failed']] as const)expect(await(await f.call('cardState',{clientId:'step',cardState:state},id)).json()).toEqual({ok:true,value:{saved:true,seq:1}});
 const after=f.db.select().from(s.messages).get()!;expect(after).toEqual({...before,cardState:'failed'});expect(f.db.select().from(s.messages).all()).toHaveLength(1);expect(f.db.select().from(s.turns).all()).toHaveLength(1);expect(JSON.stringify(f.db.select().from(s.operationResults).all())).not.toContain('PRIVATE STEP');expect(f.db.select().from(s.operationResults).where(eq(s.operationResults.operation,'conversation.cardState')).get()?.inputHash).toBe(f.root.services.comms!.key.hash('body-output\0job\0'+JSON.stringify({cardState:'done',clientId:'step'})));
});
it('refuses other runs, non-card targets and non-body credentials',async()=>{
 const f=await fixture();await f.call('message',{kind:'reply',clientId:'reply',words:'Reply'},'reply');await f.call('message',{kind:'card',clientId:'step',words:'Step',tool:'Read',cardState:'running'},'card');
 expect((await f.call('cardState',{clientId:'reply',cardState:'done'},'not-card')).status).toBe(404);f.root.writes.run(()=>f.db.update(s.messages).set({run:'other-run'}).where(eq(s.messages.kind,'card')).run());expect((await f.call('cardState',{clientId:'step',cardState:'done'},'other-run')).status).toBe(404);
 for(const token of [raw.member,raw.agent,raw.runner])for(const [name,input]of [['title',{title:'Denied'}],['cardState',{clientId:'step',cardState:'done'}]] as const)expect((await f.call(name,input,'denied-'+name,token)).status).toBe(403);
 expect((await f.call('title',{title:'X',thread:f.thread.id},'target')).status).toBe(400);expect((await f.call('cardState',{clientId:'step',cardState:'done',run:'other-run'},'run')).status).toBe(400);
});
it('uses the recipient SDK for both metadata-only controls',async()=>{
 const f=await fixture(),opened=await automaticThread(f),abort=new AbortController();const client=bodyConversationClient({url:'https://loom.invalid',token:raw.body,job:'job',conversation:opened.conversation,signal:abort.signal,clock:f.clock,fetch:async(url,init)=>f.root.http.request(new Request(url,init))});clean.push(()=>client.close());
 expect(await client.title('Pump check')).toEqual({saved:true,renamed:true});await client.card({clientId:'step',words:'PRIVATE CARD',tool:'Read',cardState:'running'});expect(await client.cardState('step','done')).toEqual({saved:true,seq:1});expect(f.db.select().from(s.messages).get()?.cardState).toBe('done');
});

it('accepts sixty astral title characters and rejects extra private SDK acknowledgement fields',async()=>{
 const f=await fixture(),opened=await automaticThread(f),title='🧵'.repeat(60);
 expect((await f.call('title',{title},'unicode')).status).toBe(200);expect(f.root.services.comms!.threads.thread(opened.thread).title).toBe(title);
 const client=bodyConversationClient({url:'https://loom.invalid',token:raw.body,job:'job',conversation:opened.conversation,signal:new AbortController().signal,fetch:async()=>Response.json({ok:true,value:{saved:true,renamed:true,words:'PRIVATE ACK'}})});clean.push(()=>client.close());
 await expect(client.title('Another')).rejects.toThrow(/^Conversation body request failed; outcome may be uncertain$/);
});
