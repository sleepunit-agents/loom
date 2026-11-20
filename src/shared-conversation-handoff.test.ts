/** Real Root and receiving SDK; all bodies/people/words are fictional. */
import {afterEach,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {z} from 'zod';
import {bodyFixture,bodyCredentials,credentialHash} from '../test/fixtures/conversation-body.js';
import * as s from './core/data/schema.js';
import {bodyProgram} from './runtime/body-program.js';
import {bodyProgramTools} from './runtime/body-program-tools.js';
import {bodyConversationClient} from './runtime/conversation-client.js';
import {handoffDeadline,handoffEnvelope,sealHandoff} from './core/conversations/handoff-words.js';
const clean:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
const brief={agent:'mark',clientId:'brief',label:'Compare fictional pumps',words:'PRIVATE HANDOFF WORDS'};
async function fixture(){
 const f=await bodyFixture(clean);f.root.writes.run(()=>{
  f.db.insert(s.memberAgents).values({member:'alice',agent:'mark'}).run();
  f.db.insert(s.projectAgents).values({project:'pond',agent:'mark'}).run();
  f.db.insert(s.agentModels).values({agent:'mark',model:'fixture',position:0}).run();
  f.db.insert(s.agentRunSettings).values({agent:'mark',houseRepository:'fixture',houseFile:'Housefile',houseBranch:'next',nestedContainers:false,gpu:false}).run();
 });
 return f;
}
async function create(f:Awaited<ReturnType<typeof fixture>>,id='handoff'){
 const response=await f.call('handoff',brief,id);expect(response.status).toBe(200);
 return z.object({value:z.object({conversation:z.string(),item:z.string()})}).parse(await response.json()).value;
}
function receive(f:Awaited<ReturnType<typeof fixture>>,cv:string){
 const row=f.db.select().from(s.jobs).where(eq(s.jobs.conversation,cv)).get()!;expect(row).toBeDefined();
 const token='body_'+'d'.repeat(64);
 // These tests move the clock by days with no worker reporting. They are about the brief, not about a silent
 // job, so the silence sweep is stopped. (A report stamped in the future no longer hides a job from it.)
 f.root.services.runtime.close();
 f.root.writes.run(()=>{
  f.db.update(s.jobs).set({box:'box',state:'running',heardAt:new Date(f.clock.now()).toISOString()}).where(eq(s.jobs.id,row.id)).run();
  f.db.insert(s.tokens).values({fingerprint:credentialHash(token),label:'Fictional child',kind:'agent',agent:'mark',job:row.id,createdAt:new Date(f.clock.now()).toISOString()}).run();
 });
 const sdk=bodyConversationClient({url:'https://loom.invalid',token,job:row.id,conversation:cv,signal:new AbortController().signal,clock:f.clock,fetch:async(url,init)=>f.root.http.request(new Request(String(url),init))});clean.push(()=>sdk.close());return{sdk,job:row.id,token};
}
it('hands a real private brief through one inherited conversation, settled job and bound SDK, with no plaintext copy',async()=>{
 const f=await fixture(),created=await create(f);
 const cv=f.root.services.conversations.conversation(created.conversation);
 expect(cv).toMatchObject({agent:'mark',venue:'handoff',place:'job',project:'pond',member:'alice'});
 const stored=f.db.select().from(s.inbox).where(eq(s.inbox.id,created.item)).get()!;
 expect(stored).toMatchObject({source:'handoff',fromKind:'agent',fromId:'art',to:'mark',conversation:cv.id,state:'waiting'});
 expect(stored.words).not.toContain(brief.words);expect(handoffDeadline(stored,14)).toBe(f.clock.now()+14*86400000);expect(handoffEnvelope(stored.words)?.keepUntil).toBe(new Date(f.clock.now()+14*86400000).toISOString());
 expect(f.db.select().from(s.threads).all()).toHaveLength(1);
 expect(await create(f,'different-receipt')).toEqual(created);
 expect(f.db.select().from(s.turns).where(eq(s.turns.conversation,cv.id)).all()).toHaveLength(1);
 f.clock.advance(60_000);
 const {sdk,job}=receive(f,cv.id);
 expect(f.db.select().from(s.jobs).where(eq(s.jobs.id,job)).get()).toMatchObject({member:'alice',project:'pond',brief:''});
 expect(await sdk.takeAndAccept(async item=>{expect(item).toMatchObject({source:'handoff',fromKind:'agent',fromId:'art',words:brief.words,keepUntil:new Date(handoffDeadline(stored,14)).toISOString()});})).toMatchObject({accepted:1});
 expect(f.db.select().from(s.inbox).where(eq(s.inbox.id,stored.id)).get()?.state).toBe('taken');await sdk.settle();
 expect(f.db.select().from(s.inbox).where(eq(s.inbox.id,stored.id)).get()?.state).toBe('done');
 for(const table of [s.inbox,s.jobs,s.operationResults,s.conversations,s.turns])expect(JSON.stringify(f.db.select().from(table).all())).not.toContain(brief.words);
 expect(f.db.$client.serialize().includes(Buffer.from(brief.words))).toBe(false);
});
it.each(['ordinary-agent','member','missing-agent','removed-agent','foreign-project','foreign-owner','spoofed-parent'] as const)('rejects %s before producing mail',async mode=>{
 const f=await fixture();let token=bodyCredentials.body,input:unknown=brief;
 if(mode==='ordinary-agent')token=bodyCredentials.agent;
 if(mode==='member')token=bodyCredentials.member;
 if(mode==='missing-agent')input={...brief,agent:'missing'};
 // A removed agent keeps its rows, and the lists that named it; it is nobody to hand work to.
 if(mode==='removed-agent')f.root.writes.run(()=>f.db.update(s.agents).set({removedAt:new Date(f.clock.now()).toISOString()}).where(eq(s.agents.id,'mark')).run());
 if(mode==='foreign-project')f.root.writes.run(()=>f.db.delete(s.projectAgents).where(eq(s.projectAgents.agent,'mark')).run());
 if(mode==='foreign-owner')f.root.writes.run(()=>f.db.delete(s.memberAgents).where(eq(s.memberAgents.agent,'mark')).run());
 if(mode==='spoofed-parent')input={...brief,parent:'other-job'};
 expect((await f.call('handoff',input,'denied',token)).status).toBe(mode==='spoofed-parent'?400:403);
 expect(f.db.select().from(s.inbox).all()).toEqual([]);
});
it('rechecks target assignment after sealing and before receipt replay',async()=>{
 const f=await fixture();let release!:()=>void,entered!:()=>void;const held=new Promise<void>(yes=>{release=yes;}),started=new Promise<void>(yes=>{entered=yes;});
 f.gate(async()=>{entered();await held;});const pending=f.call('handoff',brief,'race');await started;
 f.root.writes.run(()=>f.db.delete(s.memberAgents).where(eq(s.memberAgents.agent,'mark')).run());release();expect((await pending).status).toBe(403);
 expect(f.db.select().from(s.inbox).all()).toEqual([]);
 f.gate(async()=>{});f.root.writes.run(()=>f.db.insert(s.memberAgents).values({member:'alice',agent:'mark'}).run());await create(f,'race');
 f.root.writes.run(()=>f.db.delete(s.memberAgents).where(eq(s.memberAgents.agent,'mark')).run());expect((await f.call('handoff',brief,'race')).status).toBe(403);
});
it('withdraws expired brief bytes from original/cloned responses and the database, retaining metadata',async()=>{
 const f=await fixture();f.root.writes.run(()=>f.db.insert(s.household).values({commsDays:1}).run());
 const created=await create(f);f.clock.advance(60_000);const {token}=receive(f,created.conversation);
 const response=await f.root.http.request('/api/conversation/take',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({input:{}})});expect(response.status).toBe(200);const copy=response.clone();
 const before=f.db.select().from(s.inbox).where(eq(s.inbox.id,created.item)).get()!;
 f.clock.advance(86400000-60_000);
 const after=f.db.select().from(s.inbox).where(eq(s.inbox.id,created.item)).get()!;expect(after).toEqual({...before,words:null});
 await expect(response.text()).rejects.toThrow('Data access ended');await expect(copy.text()).rejects.toThrow('Data access ended');
});
it('cancels acceptance if the brief expires before confirmation and denies revoked recipient release',async()=>{
 const f=await fixture();f.root.writes.run(()=>f.db.insert(s.household).values({commsDays:1}).run());const created=await create(f);f.clock.advance(60_000);const {sdk}=receive(f,created.conversation);
 await expect(sdk.takeAndAccept(async(_item,signal)=>{f.clock.advance(86400000);expect(signal.aborted).toBe(true);})).rejects.toThrow();
 expect(f.db.select().from(s.inbox).where(eq(s.inbox.id,created.item)).get()?.state).toBe('taken');
 f.root.writes.run(()=>f.db.delete(s.memberAgents).where(and(eq(s.memberAgents.member,'alice'),eq(s.memberAgents.agent,'mark'))).run());
 const accept=vi.fn(async()=>{});await expect(sdk.takeAndAccept(accept)).rejects.toThrow();expect(accept).not.toHaveBeenCalled();
});

it.each(['parent','project','recipient'] as const)('rejects a changed %s after async encryption with no partial receipt',async mode=>{
 const f=await fixture();let release!:()=>void,enter!:()=>void;const held=new Promise<void>(yes=>{release=yes;}),started=new Promise<void>(yes=>{enter=yes;});
 f.gate(async()=>{enter();await held;});const pending=f.call('handoff',brief,'changed');await started;
 f.root.writes.run(()=>{
  if(mode==='parent')f.db.update(s.jobs).set({state:'done'}).where(eq(s.jobs.id,'job')).run();
  else if(mode==='project')f.db.delete(s.projectAgents).where(eq(s.projectAgents.agent,'mark')).run();
  else f.db.delete(s.memberAgents).where(eq(s.memberAgents.agent,'mark')).run();
 });release();expect((await pending).status).toBe(403);
 expect(f.db.select().from(s.inbox).all()).toEqual([]);
 expect(f.db.select().from(s.operationResults).all()).toEqual([]);
});
it('keeps the earlier encrypted deadline after policy grows and never extends expired brief words',async()=>{
 const f=await fixture();f.root.writes.run(()=>f.db.insert(s.household).values({commsDays:1}).run());const created=await create(f);
 const before=f.db.select().from(s.inbox).where(eq(s.inbox.id,created.item)).get()!;
 f.root.writes.run(()=>f.db.update(s.household).set({commsDays:14}).run());
 expect(handoffDeadline(before,14)).toBe(f.clock.now()+86400000);
 f.clock.advance(86400000);
 expect(f.db.select().from(s.inbox).where(eq(s.inbox.id,created.item)).get()?.words).toBeNull();
});
it('rolls back conversation, brief and wordless turn when receipt insertion fails',async()=>{
 const f=await fixture();f.db.$client.exec("CREATE TRIGGER fail_handoff_receipt BEFORE INSERT ON operation_results BEGIN SELECT RAISE(ABORT,'fictional receipt failure'); END");
 expect((await f.call('handoff',brief,'rollback')).status).toBeGreaterThanOrEqual(400);
 expect(f.db.select().from(s.inbox).all()).toEqual([]);expect(f.db.select().from(s.turns).all()).toEqual([]);
 expect(f.db.select().from(s.conversations).all()).toHaveLength(1);
});

it('offers and executes the handoff through the actual default native model command projection',async()=>{
 const f=await fixture(),tools=bodyProgramTools({url:'https://loom.invalid',token:bodyCredentials.body,signal:new AbortController().signal,clock:f.clock,fetch:async(url,init)=>f.root.http.request(new Request(String(url),init)),onStop:()=>{},onStatus:()=>{}});clean.push(()=>tools.close());
 const catalog=await tools.call('loom_commands',{name:'conversation.handoff'});expect(catalog.isError).not.toBe(true);expect(catalog.content[0].text).toContain('conversation.handoff');
 const result=await tools.call('loom_command',{operation:'conversation.handoff',input:brief,id:'native-handoff'});expect(result.isError).not.toBe(true);
 const row=z.object({ok:z.literal(true),value:z.object({conversation:z.string(),item:z.string()})}).parse(JSON.parse(result.content[0].text));
 expect(f.db.select().from(s.inbox).where(eq(s.inbox.id,row.value.item)).get()).toMatchObject({source:'handoff',to:'mark',conversation:row.value.conversation});
});

it('runs the actual default receiving body on the produced handoff and finishes without private stdout or response copies',async()=>{
 const f=await fixture(),created=await create(f);f.clock.advance(60_000);const {token,job}=receive(f,created.conversation);
 const assignment={id:job,box:'box',agent:'mark',conversation:created.conversation,thread:null,venue:'handoff',model:'fixture',account:'fixture',harness:'claude',brief:'',house:{repository:'fixture',file:'Housefile',branch:'next'}};
 const bytes=Buffer.from(JSON.stringify({job:assignment,build:'fixture',bootstrap:{origin:'https://loom.invalid',job,token}}));const errors:string[]=[];
 const native=vi.fn(async(_job:unknown,input:string)=>{expect(input).toContain(brief.words);return{text:'PRIVATE CHILD RESULT',model:'fictional-observed',actions:[]};});
 expect(await bodyProgram({args:['fixture'],read:async()=>JSON.stringify({command:'/fictional/claude',cwd:'/fictional'}),stdin:async()=>bytes,env:{},signal:new AbortController().signal,clock:f.clock,fetch:async(url,init)=>f.root.http.request(new Request(String(url),init)),schedule:{every:()=>()=>{}},startup:async()=>{},loadMemory:async()=>null,native,error:text=>errors.push(text)})).toBe(0);
 expect(native).toHaveBeenCalledOnce();expect(errors).toEqual([]);expect(bytes.every(value=>value===0)).toBe(true);
 expect(f.db.select().from(s.inbox).where(eq(s.inbox.id,created.item)).get()?.state).toBe('done');
 expect(f.db.select().from(s.digests).where(eq(s.digests.conversation,created.conversation)).get()).toMatchObject({run:job,summary:'Completed this stretch of work.'});
 const response=await f.root.http.request('/api/runtime/finish',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+bodyCredentials.runner},body:JSON.stringify({id:'handoff-finish',input:{job,exitCode:0,logTail:'PRIVATE CHILD STDOUT'}})});expect(response.status).toBe(200);
 expect(f.db.select().from(s.jobs).where(eq(s.jobs.id,job)).get()).toMatchObject({state:'done',brief:'',logTail:null});
 const receipt=f.db.select().from(s.operationResults).where(eq(s.operationResults.operation,'runtime.finish')).get()!;
 expect(receipt.inputHash).not.toBe(createHash('sha256').update(JSON.stringify({exitCode:0,job,logTail:'PRIVATE CHILD STDOUT'})).digest('hex'));
 const durable=f.db.$client.serialize();for(const words of [brief.words,'PRIVATE CHILD RESULT','PRIVATE CHILD STDOUT'])expect(durable.includes(Buffer.from(words))).toBe(false);
});

it('refuses an internal plaintext handoff producer instead of saving a parallel word copy',async()=>{
 const f=await fixture();expect(()=>f.root.services.conversations.send({toKind:'agent',to:'art',conversation:f.thread.conversation,source:'handoff',fromKind:'agent',fromId:'mark',words:brief.words})).toThrow('Handoff briefs must be encrypted');
 expect(f.db.select().from(s.inbox).all()).toEqual([]);
});

it.each([false,true])('rechecks the sending project assignment after sealing (public %s)',async publicSource=>{
 const f=await fixture();if(publicSource)f.root.writes.run(()=>{f.db.update(s.conversations).set({member:null}).where(eq(s.conversations.id,f.thread.conversation)).run();f.db.update(s.jobs).set({member:null}).where(eq(s.jobs.id,'job')).run();});
 let release!:()=>void,enter!:()=>void;const held=new Promise<void>(yes=>{release=yes;}),started=new Promise<void>(yes=>{enter=yes;});f.gate(async()=>{enter();await held;});
 const pending=f.call('handoff',brief,'source-assignment');await started;f.root.writes.run(()=>f.db.delete(s.projectAgents).where(eq(s.projectAgents.agent,'art')).run());release();expect((await pending).status).toBe(403);
 expect(f.db.select().from(s.inbox).all()).toEqual([]);
});

it.each([false,true])('requires a current explicit shared owner for unlabelled public handoffs (assigned %s)',async assigned=>{
 const f=await fixture();f.root.writes.run(()=>{
  f.db.update(s.conversations).set({member:null,project:null}).where(eq(s.conversations.id,f.thread.conversation)).run();f.db.update(s.jobs).set({member:null,project:null}).where(eq(s.jobs.id,'job')).run();
  if(!assigned){f.db.delete(s.memberAgents).where(eq(s.memberAgents.agent,'mark')).run();f.db.insert(s.memberAgents).values({member:'bob',agent:'mark'}).run();}
 });
 const response=await f.call('handoff',brief,'public');expect(response.status).toBe(assigned?200:403);
 if(assigned){const created=z.object({value:z.object({conversation:z.string()})}).parse(await response.json()).value;f.clock.advance(60_000);const {job}=receive(f,created.conversation);expect(f.db.select().from(s.jobs).where(eq(s.jobs.id,job)).get()).toMatchObject({member:null,project:null,brief:''});const input={job,exitCode:0,logTail:'PUBLIC HANDOFF STDOUT WORDS'};const ended=await f.root.http.request('/api/runtime/finish',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+bodyCredentials.runner},body:JSON.stringify({id:'public-finish',input})});expect(ended.status).toBe(200);expect(f.db.select().from(s.jobs).where(eq(s.jobs.id,job)).get()?.logTail).toBeNull();expect(f.db.select().from(s.operationResults).where(eq(s.operationResults.operation,'runtime.finish')).get()?.inputHash).not.toBe(createHash('sha256').update(JSON.stringify({exitCode:0,job,logTail:input.logTail})).digest('hex'));}
 else expect(f.db.select().from(s.inbox).all()).toEqual([]);
});
it('keeps one peer/parent conversation for distinct briefs, with one item and wordless turn per brief',async()=>{
 const f=await fixture(),first=await create(f),response=await f.call('handoff',{...brief,clientId:'second',words:'SECOND PRIVATE BRIEF'},'second');expect(response.status).toBe(200);
 const second=z.object({value:z.object({conversation:z.string(),item:z.string()})}).parse(await response.json()).value;expect(second.conversation).toBe(first.conversation);expect(second.item).not.toBe(first.item);
 expect(f.db.select().from(s.inbox).where(eq(s.inbox.conversation,first.conversation)).all()).toHaveLength(2);expect(f.db.select().from(s.turns).where(eq(s.turns.conversation,first.conversation)).all()).toHaveLength(2);
});
it('shortens an existing fourteen-day brief to the new one-day policy before publication and confirmation',async()=>{
 const f=await fixture(),created=await create(f);f.root.writes.run(()=>f.db.insert(s.household).values({commsDays:1}).run());f.clock.advance(60_000);const {sdk}=receive(f,created.conversation);
 const until=f.clock.now()-60_000+86400000;
 await expect(sdk.takeAndAccept(async(item,signal)=>{expect(item.keepUntil).toBe(new Date(until).toISOString());f.clock.advance(86400000-60_000);expect(signal.aborted).toBe(true);})).rejects.toThrow();
 expect(f.db.select().from(s.inbox).where(eq(s.inbox.id,created.item)).get()).toMatchObject({state:'taken',words:null});
});
it.each(['expiry','recipient','cipher'] as const)('withholds words when %s changes while decryption is pending',async mode=>{
 const f=await fixture();if(mode==='expiry')f.root.writes.run(()=>f.db.insert(s.household).values({commsDays:1}).run());const created=await create(f);f.clock.advance(mode==='expiry'?86400000-1000:60_000);const {token}=receive(f,created.conversation);
 const swapped=mode==='cipher'?await sealHandoff(f.key,'REPLACEMENT PRIVATE BRIEF',new Date(f.clock.now()).toISOString(),14):null;
 let enter!:()=>void,release!:()=>void;const started=new Promise<void>(yes=>{enter=yes;}),held=new Promise<void>(yes=>{release=yes;});f.openGate(async()=>{enter();await held;});
 const pending=f.root.http.request('/api/conversation/take',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({input:{}})});await started;
 if(mode==='expiry')f.clock.advance(1000);
 else f.root.writes.run(()=>{if(mode==='recipient')f.db.delete(s.memberAgents).where(eq(s.memberAgents.agent,'mark')).run();else f.db.update(s.inbox).set({words:swapped}).where(eq(s.inbox.id,created.item)).run();});
 release();const response=await pending;expect(response.status).toBeGreaterThanOrEqual(400);expect(await response.text()).not.toContain(brief.words);
});

it('hides handoff envelopes from generic agent bodies/search and opens words only for an authorized member',async()=>{
 const f=await fixture();f.root.writes.run(()=>{f.db.update(s.conversations).set({member:null,project:null}).where(eq(s.conversations.id,f.thread.conversation)).run();f.db.update(s.jobs).set({member:null,project:null}).where(eq(s.jobs.id,'job')).run();});
 const created=await create(f),query=`{inboxItem(id:"${created.item}"){body{words} bodyKeepUntil}}`;
 const read=async(token:string)=>f.root.http.request('/graphql',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({query})});
 f.clock.advance(60_000);const {token}=receive(f,created.conversation);
 const agent=await read(token);expect(await agent.json()).toMatchObject({data:{inboxItem:{body:null,bodyKeepUntil:null}}});
 const searched=await f.root.http.request('/graphql',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({query:'{inboxItems(search: "loom:handoff:v1"){id body{words}}}'})});expect(await searched.json()).toMatchObject({data:{inboxItems:[]}});
 const member=await f.root.http.request('/graphql',{method:'POST',headers:{'content-type':'application/json',cookie:'loom_ui='+bodyCredentials.memberCookie},body:JSON.stringify({query})});expect(await member.json()).toMatchObject({data:{inboxItem:{body:{words:brief.words},bodyKeepUntil:new Date(f.clock.now()-60000+14*86400000).toISOString()}}});
});

it('rechecks a public shared owner after encryption and before receipt replay',async()=>{
 const f=await fixture();f.root.writes.run(()=>{f.db.update(s.conversations).set({member:null,project:null}).where(eq(s.conversations.id,f.thread.conversation)).run();f.db.update(s.jobs).set({member:null,project:null}).where(eq(s.jobs.id,'job')).run();});
 let release!:()=>void,enter!:()=>void;const gate=new Promise<void>(yes=>{release=yes;}),started=new Promise<void>(yes=>{enter=yes;});f.gate(async()=>{enter();await gate;});const pending=f.call('handoff',brief,'public-owner');await started;
 f.root.writes.run(()=>f.db.delete(s.memberAgents).where(eq(s.memberAgents.agent,'mark')).run());release();expect((await pending).status).toBe(403);
 f.gate(async()=>{});f.root.writes.run(()=>f.db.insert(s.memberAgents).values({member:'alice',agent:'mark'}).run());await create(f,'public-owner');
 f.root.writes.run(()=>f.db.delete(s.memberAgents).where(eq(s.memberAgents.agent,'mark')).run());expect((await f.call('handoff',brief,'public-owner')).status).toBe(403);
});

it('rechecks the private no-project sender during encryption and receipt replay',async()=>{
 const f=await fixture();f.root.writes.run(()=>{f.db.update(s.conversations).set({project:null}).where(eq(s.conversations.id,f.thread.conversation)).run();f.db.update(s.jobs).set({project:null}).where(eq(s.jobs.id,'job')).run();});
 let release!:()=>void,enter!:()=>void;const gate=new Promise<void>(yes=>{release=yes;}),started=new Promise<void>(yes=>{enter=yes;});f.gate(async()=>{enter();await gate;});const pending=f.call('handoff',brief,'private-sender');await started;
 f.root.writes.run(()=>f.db.delete(s.memberAgents).where(eq(s.memberAgents.agent,'art')).run());release();expect((await pending).status).toBe(403);expect(f.db.select().from(s.inbox).all()).toEqual([]);
 f.gate(async()=>{});f.root.writes.run(()=>f.db.insert(s.memberAgents).values({member:'alice',agent:'art'}).run());await create(f,'private-sender');
 f.root.writes.run(()=>f.db.delete(s.memberAgents).where(eq(s.memberAgents.agent,'art')).run());expect((await f.call('handoff',brief,'private-sender')).status).toBe(403);
});
it.each(['project','owner'] as const)('withholds a pending public brief after %s assignment changes, without relying on notifications',async kind=>{
 const f=await fixture();f.root.writes.run(()=>{f.db.update(s.conversations).set({member:null,...(kind==='owner'?{project:null}:{})}).where(eq(s.conversations.id,f.thread.conversation)).run();f.db.update(s.jobs).set({member:null,...(kind==='owner'?{project:null}:{})}).where(eq(s.jobs.id,'job')).run();});
 const created=await create(f);f.clock.advance(60_000);const {token}=receive(f,created.conversation);
 let enter!:()=>void,release!:()=>void;const started=new Promise<void>(yes=>{enter=yes;}),gate=new Promise<void>(yes=>{release=yes;});f.openGate(async()=>{enter();await gate;});
 const pending=f.root.http.request('/api/conversation/take',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({input:{}})});await started;
 // Current policy is checked even when a source writer omits its notification.
 if(kind==='project')f.db.delete(s.projectAgents).where(eq(s.projectAgents.agent,'mark')).run();else f.db.delete(s.memberAgents).where(eq(s.memberAgents.agent,'mark')).run();
 release();const response=await pending;expect(response.status).toBe(403);expect(await response.text()).not.toContain(brief.words);
 expect(f.db.select().from(s.inbox).where(eq(s.inbox.id,created.item)).get()?.state).toBe('waiting');
});
it('keeps private handoff body words from a household owner who is not its member',async()=>{
 const f=await fixture(),created=await create(f),token='fictional-owner-body-read-'.repeat(4);
 f.root.writes.run(()=>{f.db.update(s.members).set({role:'owner'}).where(eq(s.members.id,'bob')).run();f.db.insert(s.tokens).values({fingerprint:credentialHash(token),label:'Fictional owner',kind:'owner',member:'bob',createdAt:new Date(f.clock.now()).toISOString()}).run();});
 const response=await f.root.http.request('/graphql',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({query:`{inboxItem(id:"${created.item}"){body{words}}}`})});expect(await response.json()).toEqual({data:{inboxItem:null}});
});

it.each(['project','owner'] as const)('withdraws published public handoff originals and clones after %s assignment changes',async kind=>{
 const f=await fixture();f.root.writes.run(()=>{f.db.update(s.conversations).set({member:null,...(kind==='owner'?{project:null}:{})}).where(eq(s.conversations.id,f.thread.conversation)).run();f.db.update(s.jobs).set({member:null,...(kind==='owner'?{project:null}:{})}).where(eq(s.jobs.id,'job')).run();});
 const created=await create(f);f.clock.advance(60_000);const {token}=receive(f,created.conversation);
 const response=await f.root.http.request('/api/conversation/take',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({input:{}})});expect(response.status).toBe(200);const copy=response.clone();
 if(kind==='project')f.db.delete(s.projectAgents).where(eq(s.projectAgents.agent,'mark')).run();else f.db.delete(s.memberAgents).where(eq(s.memberAgents.agent,'mark')).run();
 await expect(response.text()).rejects.toThrow('Data access ended');await expect(copy.text()).rejects.toThrow('Data access ended');
});

it('keeps a handed-off direct message direct, so its words reach no wider audience than the message had',async()=>{
 // An unlinked sender's direct message: nobody's private thread, in no project, shown only to the agent's owners.
 const f=await fixture();f.root.writes.run(()=>{f.db.update(s.conversations).set({member:null,project:null,direct:true}).where(eq(s.conversations.id,f.thread.conversation)).run();f.db.update(s.jobs).set({member:null,project:null}).where(eq(s.jobs.id,'job')).run();});
 const created=await create(f,'direct');
 expect(f.db.select({direct:s.conversations.direct,member:s.conversations.member,project:s.conversations.project}).from(s.conversations).where(eq(s.conversations.id,created.conversation)).get()).toEqual({direct:true,member:null,project:null});
 // The same brief sent again finds the same conversation, still direct.
 expect((await create(f,'direct')).conversation).toBe(created.conversation);
 // The agent it was handed to still takes it.
 f.clock.advance(60_000);const {token}=receive(f,created.conversation);
 const taken=await f.root.http.request('/api/conversation/take',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({input:{}})});expect(taken.status).toBe(200);
});

it.each(['success','failure','archive','transient'] as const)('delivers an owner-requested Codex handoff through its originating thread (%s)',async(mode)=>{
 const f=await bodyFixture(clean,{modelRoles:()=>[
  {model:'first',provider:'claude',harness:'claude',series:'first'},
  {model:'reviewer',provider:'openai',harness:'codex',series:'reviewer'}]});
 const {db,root}=f,now=()=>new Date(f.clock.now()).toISOString();
 await f.send('Please get a cold review','start-review');
 db.insert(s.agentModels).values([{agent:'art',model:'first',position:0},{agent:'art',model:'reviewer',position:1}]).run();
 db.insert(s.agentRunSettings).values({agent:'art',houseRepository:'repo',houseFile:'Housefile',houseBranch:'next',nestedContainers:false,gpu:false}).run();
 db.insert(s.agentBoxes).values({agent:'art',box:'box',position:0}).run();
 db.update(s.boxes).set({hostsAny:true,lastSeenAt:now()}).run();
 const request={harness:'codex',label:'Review pull request',clientId:'review-one',words:'Read commit abc.'};
 expect((await f.call('handoff',request,'unavailable')).status).toBe(503);
 db.insert(s.modelAccounts).values({id:'paid',owner:'alice',provider:'openai',label:'Subscription',hasRoom:true}).run();
 db.insert(s.modelAccountWindows).values({account:'paid',window:'week',usage:0.1,usageReadAt:now(),resetsAt:new Date(f.clock.now()+86400000).toISOString(),durationMs:604800000}).run();
 db.insert(s.modelAccountBoxes).values({account:'paid',box:'box'}).run();
 const next=async(id:string,capable:boolean)=>root.http.request('/api/runtime/next',{method:'POST',headers:{authorization:'Bearer '+bodyCredentials.runner,'content-type':'application/json'},body:JSON.stringify({id,input:{execution:'container',...(capable&&{reviewResults:true}),slots:3}})});
 await next('advertise',true);
 const response=await f.call('handoff',request,'launch');
 expect(response.status,JSON.stringify(await response.clone().json())).toBe(200);
 const child=(await response.json()).value.conversation;
 db.update(s.inbox).set({state:'done',job:'job'}).where(eq(s.inbox.conversation,f.thread.conversation)).run();
 db.update(s.jobs).set({state:'done',endedAt:now()}).where(eq(s.jobs.id,'job')).run();
 f.clock.advance(60_000);
 expect((await (await next('legacy',false)).json()).value).toBeNull();
 const poll=await next('poll',true);
 const assignment=(await poll.json()).value;
 expect(assignment).toMatchObject({conversation:child,review:true,agent:'art',harness:'codex',model:'reviewer'});
 const token='body_'+'c'.repeat(64);
 db.update(s.jobs).set({state:'running'}).where(eq(s.jobs.id,assignment.id)).run();
 db.insert(s.tokens).values({fingerprint:credentialHash(token),label:'Fictional reviewer',kind:'agent',agent:'art',job:assignment.id,createdAt:now()}).run();
 const sdk=bodyConversationClient({url:'https://loom.invalid',token,job:assignment.id,conversation:child,signal:new AbortController().signal,clock:f.clock,fetch:async(url,init)=>root.http.request(new Request(url,init))});
 clean.push(()=>sdk.close());
 if(mode==='archive'){
  db.update(s.threads).set({archivedAt:now()}).where(eq(s.threads.id,f.thread.id)).run();
  await expect(sdk.reply({clientId:'no',words:'withheld',model:'reviewer'})).rejects.toThrow();
  return;
 }
 if(mode==='failure'||mode==='transient'){
  let refused=false;
  if(mode==='transient')f.gate(async()=>{if(!refused){refused=true;throw Error('Temporary key unavailability');}});
  root.services.runtime.stop(assignment.id,'alice','write-off');
  if(mode==='transient'){
   await vi.waitFor(()=>expect(refused).toBe(true));
   await new Promise(resolve=>setImmediate(resolve));
   f.clock.advance(30_001);
  }
  await vi.waitFor(()=>expect(db.select().from(s.messages).where(eq(s.messages.kind,'reply')).all()).toHaveLength(1));
  const failure=db.select().from(s.messages).where(eq(s.messages.kind,'reply')).get()!;
  expect(await f.key.open(failure.words!)).toContain('the job was stopped');return;
 }
 const reply={clientId:'review-result',words:'PRIVATE REVIEW FINDINGS',model:'reviewer'};
 const bytes=Buffer.from(JSON.stringify({job:assignment,build:'fixture',bootstrap:{origin:'https://loom.invalid',job:assignment.id,token}}));
 expect(await bodyProgram({args:['fixture'],read:async()=>JSON.stringify({command:'/fictional/codex',cwd:'/fictional',reach:'all'}),stdin:async()=>bytes,env:{},signal:new AbortController().signal,clock:f.clock,fetch:async(url,init)=>root.http.request(new Request(url,init)),schedule:{every:()=>()=>{}},startup:async()=>{},loadMemory:async()=>null,native:async(_job,context)=>{expect(context).toContain(request.words);return {text:reply.words,model:'reviewer',actions:[]};},error:()=>{}})).toBe(0);
 await sdk.reply(reply);
 const replies=db.select().from(s.messages).where(and(eq(s.messages.thread,f.thread.id),eq(s.messages.kind,'reply'))).all();
 expect(replies).toHaveLength(1);expect(await f.key.open(replies[0].words!)).toBe(reply.words);
 const mail=db.select().from(s.inbox).where(and(eq(s.inbox.conversation,f.thread.conversation),eq(s.inbox.source,'handoff'))).all();
 expect(mail).toHaveLength(1);expect(mail[0]).toMatchObject({onWord:'alice',thread:f.thread.id,messageSeq:replies[0].seq,words:null});
 f.clock.advance(60_000);
 const coordinator=db.select().from(s.jobs).where(and(eq(s.jobs.conversation,f.thread.conversation),eq(s.jobs.state,'queued'))).get()!;
 expect(coordinator).toBeDefined();
 db.update(s.jobs).set({box:'box',state:'running',heardAt:now()}).where(eq(s.jobs.id,coordinator.id)).run();
 const resumed='body_'+'e'.repeat(64);
 db.insert(s.tokens).values({fingerprint:credentialHash(resumed),label:'Fictional coordinator',kind:'agent',agent:'art',job:coordinator.id,createdAt:now()}).run();
 const receiver=bodyConversationClient({url:'https://loom.invalid',token:resumed,job:coordinator.id,conversation:f.thread.conversation,signal:new AbortController().signal,clock:f.clock,fetch:async(url,init)=>root.http.request(new Request(url,init))});
 clean.push(()=>receiver.close());
 const received:string[]=[];
 await receiver.takeAndAccept(async item=>{if(item.words)received.push(item.words);});
 expect(received).toContain(reply.words);
 root.services.comms!.delete(f.thread.id);
 expect(root.services.conversations.item(mail[0].id)).toMatchObject({state:'resolved',words:null,thread:null});
 expect(db.$client.serialize().includes(Buffer.from(reply.words))).toBe(false);
});
