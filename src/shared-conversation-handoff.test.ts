/** Real Root and receiving SDK; all bodies/people/words are fictional. */
import {afterEach,expect,it,vi} from 'vitest';
import {fileURLToPath} from 'node:url';
import {dirname} from 'node:path';
import type {HarnessRun} from './runtime/body-harness.js';
import {createHash} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {z} from 'zod';
import {bodyFixture,bodyCredentials,credentialHash} from '../test/fixtures/conversation-body.js';
import * as s from './core/data/schema.js';
import {harnesses} from './runtime/body-harnesses.js';
import {roleRevision,eligibleModels} from './runtime/work-roles.js';
import {bodyProgram} from './runtime/body-program.js';
import {bodyProgramTools} from './runtime/body-program-tools.js';
import {bodyConversationClient} from './runtime/conversation-client.js';
import {reviewPlace} from './core/conversations/review-place.js';
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
it('limits handoff discovery to the private owner body and its currently assigned peers',async()=>{
 const f=await fixture();
 await f.send('Please delegate this work','owner-request');
 const options=()=>f.call('handoffOptions',{},'read');
 const value=async()=>{const response=await options();expect(response.status).toBe(200);return (await response.json()).value;};
 expect(await value()).toEqual({agents:['mark'],codexAvailable:false});
 f.db.delete(s.projectAgents).where(eq(s.projectAgents.agent,'mark')).run();
 expect(await value()).toEqual({agents:[],codexAvailable:false});
 for(const token of [bodyCredentials.member,bodyCredentials.agent])expect((await f.call('handoffOptions',{},'ordinary',token)).status).toBe(403);
 f.db.update(s.threads).set({archivedAt:new Date(f.clock.now()).toISOString()}).where(eq(s.threads.id,f.thread.id)).run();
 expect((await options()).status).toBe(403);
});

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

it('keeps equivalent role selectors stable and supports registered native harnesses',()=>{
 const role={agent:'art',id:'research',description:'Compare documents.',models:['b','a','a'],providers:['y','x']};
 expect(roleRevision(role)).toBe(roleRevision({...role,models:['a','b'],providers:['x','y']}));
 const native={model:'a',provider:'x',harness:'agy',series:'a'};
 expect(eligibleModels(role,[native,{...native,harness:'custom'}],new Set(Object.keys(harnesses)))).toEqual([native]);
});

it.each(['success','failure','archive','transient','occupied','work-role','mixed-native','role-changed','worker-loss'] as const)('delivers an owner-requested Codex handoff through its originating thread (%s)',async(mode)=>{
 const mixed=mode==='mixed-native';
 const roleMode=mixed||mode==='work-role'||mode==='role-changed'||mode==='worker-loss';
 const f=await bodyFixture(clean,{workRoles:[{agent:'art',id:'research',description:'Compare the cited documents.',models:['reviewer']},
  {agent:'mark',id:'editing',description:'Check prose.',providers:['openai']}],modelRoles:()=>[
  {model:'first',provider:roleMode?'openai':'claude',harness:'claude',series:'first'},
  {model:'reviewer',provider:'openai',harness:roleMode&&!mixed?'claude':'codex',series:'reviewer'}]});
 const {db,root}=f,now=()=>new Date(f.clock.now()).toISOString();
 await f.send('Please get a cold review','start-review');
 db.insert(s.agentModels).values([{agent:'art',model:'first',position:0},{agent:'art',model:'reviewer',position:1}]).run();
 db.insert(s.agentRunSettings).values({agent:'art',houseRepository:'repo',houseFile:'Housefile',houseBranch:'next',nestedContainers:false,gpu:false}).run();
 db.insert(s.agentBoxes).values({agent:'art',box:'box',position:0}).run();
 db.update(s.boxes).set({hostsAny:true,lastSeenAt:now()}).run();
 const request={...(roleMode?{role:'research'}:{harness:'codex'}),label:'Review pull request',clientId:'review-one',words:'Read commit abc.'};
 expect((await f.call('handoff',request,'unavailable')).status).toBe(503);
 db.insert(s.modelAccounts).values({id:'paid',owner:'alice',provider:'openai',label:'Subscription',hasRoom:true}).run();
 db.insert(s.modelAccountWindows).values({account:'paid',window:'week',usage:0.1,usageReadAt:now(),resetsAt:new Date(f.clock.now()+86400000).toISOString(),durationMs:604800000}).run();
 db.insert(s.modelAccountBoxes).values({account:'paid',box:'box'}).run();
 const next=async(id:string,capable:boolean,runner=bodyCredentials.runner)=>root.http.request('/api/runtime/next',{method:'POST',headers:{authorization:'Bearer '+runner,'content-type':'application/json'},body:JSON.stringify({id,input:{execution:'container',...(capable&&{reviewResults:true}),slots:3}})});
 await next('advertise',true);
 if(mixed){
  db.update(s.modelAccountWindows).set({usage:1}).where(eq(s.modelAccountWindows.account,'paid')).run();
  const unavailable=await f.call('handoffOptions',{},'exhausted');
  expect((await unavailable.json()).value.roles).toMatchObject([{id:'research',available:false}]);
  expect((await f.call('handoff',request,'exhausted-launch')).status).toBe(503);
  expect(db.select().from(s.conversations).where(eq(s.conversations.venue,'handoff')).all()).toHaveLength(0);
  db.update(s.modelAccountWindows).set({usage:0.1}).where(eq(s.modelAccountWindows.account,'paid')).run();
 }
 if(mode==='success'){
  const tools=bodyProgramTools({url:'https://loom.invalid',token:bodyCredentials.body,signal:new AbortController().signal,clock:f.clock,fetch:async(url,init)=>root.http.request(new Request(String(url),init)),onStop:()=>{},onStatus:()=>{}});
  clean.push(()=>tools.close());
  const options=await tools.call('loom_command',{operation:'conversation.handoffOptions',input:{},id:'options'});
  expect(options.isError,options.content[0].text).not.toBe(true);
  expect(JSON.parse(options.content[0].text).value).toMatchObject({codexAvailable:true});
 }
 if(roleMode){
  const discovery=await f.call('handoffOptions',{},'discover');
  expect((await discovery.json()).value).toMatchObject({codexAvailable:mixed,roles:[{id:'research',available:true,description:'Compare the cited documents.'}]});
  expect((await f.call('handoff',{...request,role:'editing'},'other-role')).status).toBe(400);
 }
 const response=await f.call('handoff',request,'launch');
 expect(response.status,JSON.stringify(await response.clone().json())).toBe(200);
 const child=(await response.json()).value.conversation;
 if(roleMode){
  expect((await (await f.call('handoff',request,'retry-role')).json()).value.conversation).toBe(child);
  expect((await f.call('handoff',{...request,role:'editing'},'reuse-id')).status).toBe(409);
 }
 const status=(conversation:string,token=bodyCredentials.body)=>f.call('handoffStatus',{conversation},'status',token);
 if(mode==='success'){
  expect((await (await status(child)).json()).value).toEqual({jobState:null,resultDelivered:false});
  expect((await status(f.thread.conversation)).status).toBe(403);
  expect((await status('missing')).status).toBe(403);
  const parent=db.select().from(s.jobs).where(eq(s.jobs.id,'job')).get()!;
  const other=root.services.comms!.threads.open({agent:'art',member:'alice',project:'pond',title:'Another private thread'});
  db.insert(s.jobs).values({...parent,id:'other-parent',conversation:other.conversation,state:'done',endedAt:now()}).run();
  const foreign=root.services.conversations.open({agent:'art',member:'alice',project:'pond',venue:'handoff',place:reviewPlace('other-parent','brief'),label:'Other child',direct:false});
  expect((await status(foreign.id)).status).toBe(403);
  expect((await status(child,bodyCredentials.agent)).status).toBe(403);
 }
 db.update(s.inbox).set({state:'done',job:'job'}).where(eq(s.inbox.conversation,f.thread.conversation)).run();
 db.update(s.jobs).set({state:'done',endedAt:now()}).where(eq(s.jobs.id,'job')).run();
 f.clock.advance(60_000);
 expect((await (await next('legacy',false)).json()).value).toBeNull();
 if(mode==='role-changed'){
  db.update(s.conversations).set({place:reviewPlace('job','review-one',{id:'research',revision:'0'.repeat(64)})}).where(eq(s.conversations.id,child)).run();
  await next('changed-role',true);
  expect(db.select().from(s.jobs).where(eq(s.jobs.conversation,child)).get()).toMatchObject({state:'failed'});
  return;
 }
 const poll=await next('poll',true);
 let assignment=(await poll.json()).value;
 expect(assignment).toMatchObject({conversation:child,review:true,agent:'art',harness:roleMode&&!mixed?'claude':'codex',model:'reviewer'});
 if(mode==='worker-loss'){
  const first=assignment, standbyRunner='s'.repeat(64), firstBody='body_'+'f'.repeat(64);
  const box=db.select().from(s.boxes).where(eq(s.boxes.id,'box')).get()!;
  db.insert(s.boxes).values({...box,id:'standby',name:'Standby'}).run();
  db.insert(s.agentBoxes).values({agent:'art',box:'standby',position:1}).run();
  db.insert(s.modelAccountBoxes).values({account:'paid',box:'standby'}).run();
  db.insert(s.tokens).values([
   {fingerprint:credentialHash(standbyRunner),label:'Standby',kind:'runner',box:'standby',createdAt:now()},
   {fingerprint:credentialHash(firstBody),label:'First reviewer',kind:'agent',agent:'art',job:first.id,createdAt:now()},
  ]).run();
  const start=async(job:string,runner:string)=>{
   const reply=await root.http.request('/api/runtime/started',{method:'POST',headers:{authorization:'Bearer '+runner,'content-type':'application/json'},body:JSON.stringify({id:'start-'+job,input:{job,build:'fixture'}})});
   expect(reply.status).toBe(200);
  };
  await start(first.id,bodyCredentials.runner);
  const original=bodyConversationClient({url:'https://loom.invalid',token:firstBody,job:first.id,conversation:child,signal:new AbortController().signal,clock:f.clock,fetch:async(url,init)=>root.http.request(new Request(url,init))});
  clean.push(()=>original.close());
  expect((await original.takeAndAccept(async item=>{expect(item.words).toContain(request.words);})).accepted).toBe(1);
  f.clock.advance(150_000);
  const retry=db.select().from(s.jobs).where(eq(s.jobs.retryOf,first.id)).get()!;
  expect(retry).toMatchObject({state:'queued',conversation:child,box:null});
  expect(db.select().from(s.jobs).where(eq(s.jobs.id,first.id)).get()?.state).toBe('lost');
  expect((await (await next('too-early',true,standbyRunner)).json()).value).toBeNull();
  await expect(original.reply({clientId:'late',words:'Late result',model:'reviewer'})).rejects.toThrow();
  f.clock.advance(Date.parse(retry.retryAt!)-f.clock.now());
  assignment=(await (await next('retry-on-standby',true,standbyRunner)).json()).value;
  expect(assignment).toMatchObject({id:retry.id,box:'standby',conversation:child,review:true,harness:'claude',model:'reviewer'});
  await start(assignment.id,standbyRunner);
  expect((await (await next('original-box-returns',true)).json()).value).toBeNull();
 }
 const token='body_'+'c'.repeat(64);
 if(mode!=='worker-loss')db.update(s.jobs).set({state:'running'}).where(eq(s.jobs.id,assignment.id)).run();
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
 // The original requester is finished. A different body can already be holding its thread when the child replies.
 let holding:string|undefined;
 if(mode==='occupied'){
  await f.send('Another question for the coordinator','while-reviewing');
  f.clock.advance(60_000);
  const queued=db.select().from(s.jobs).where(and(eq(s.jobs.conversation,f.thread.conversation),eq(s.jobs.state,'queued'))).get()!;
  expect(queued).toBeDefined();holding=queued.id;
  db.update(s.jobs).set({state:'running',box:'box',heardAt:now()}).where(eq(s.jobs.id,holding)).run();
 }
 const reply={clientId:'review-result',words:'PRIVATE REVIEW FINDINGS',model:'reviewer'};
 const bytes=Buffer.from(JSON.stringify({job:assignment,build:'fixture',bootstrap:{origin:'https://loom.invalid',job:assignment.id,token}}));
 const executable=fileURLToPath(new URL('../test/fixtures/codex-mixed-handoff.mjs',import.meta.url));
 const plan=mixed?{command:executable,cwd:dirname(executable)}:{command:'/fictional/codex',cwd:'/fictional'};
 const native:HarnessRun=async(_job,context)=>{
  expect(context).toContain(request.words);
  if(roleMode)expect(context).toContain('Compare the cited documents.');
  return {text:reply.words,model:'reviewer',actions:[]};
 };
 const errors:string[]=[];
 const code=await bodyProgram({args:['fixture'],read:async()=>JSON.stringify({...plan,reach:'all'}),stdin:async()=>bytes,
  env:mixed?{PATH:dirname(process.execPath)}:{},signal:new AbortController().signal,clock:f.clock,
  fetch:async(url,init)=>root.http.request(new Request(url,init)),schedule:{every:()=>()=>{}},startup:async()=>{},
  loadMemory:async()=>null,...(mixed?{}:{native}),error:message=>errors.push(message)});
 expect(code,errors.join(' ')).toBe(0);
 if(mixed){
  const childJobs=db.select().from(s.jobs).where(eq(s.jobs.conversation,child)).all();
  expect(childJobs).toMatchObject([{id:assignment.id,account:'paid',model:'reviewer'}]);
  const usage=db.select().from(s.jobUsage).where(eq(s.jobUsage.job,assignment.id)).get();
  expect(usage).toMatchObject({tokensIn:1200,tokensOut:85,cacheRead:400,toolCalls:5,
   tools:{'collab_tool_call.spawn_agent.completed':3,'collab_tool_call.spawn_agent.failed':1,'collab_tool_call.wait':1}});
 }
 await sdk.reply(reply);
 const replies=db.select().from(s.messages).where(and(eq(s.messages.thread,f.thread.id),eq(s.messages.kind,'reply'))).all();
 expect(replies).toHaveLength(1);expect(replies[0].run).toBe(assignment.id);expect(await f.key.open(replies[0].words!)).toBe(reply.words);
 const mail=db.select().from(s.inbox).where(and(eq(s.inbox.conversation,f.thread.conversation),eq(s.inbox.source,'handoff'))).all();
 expect(mail).toHaveLength(1);expect(mail[0]).toMatchObject({onWord:'alice',thread:f.thread.id,messageSeq:replies[0].seq,words:null});
 const readAsCoordinator=async(id:string,token:string)=>{
  db.update(s.jobs).set({box:'box',state:'running',heardAt:now()}).where(eq(s.jobs.id,id)).run();
  db.insert(s.tokens).values({fingerprint:credentialHash(token),label:'Fictional coordinator '+id,kind:'agent',agent:'art',job:id,createdAt:now()}).run();
  const receiver=bodyConversationClient({url:'https://loom.invalid',token,job:id,conversation:f.thread.conversation,signal:new AbortController().signal,clock:f.clock,fetch:async(url,init)=>root.http.request(new Request(url,init))});
  clean.push(()=>receiver.close());
  const received:string[]=[];
  await receiver.takeAndAccept(async item=>{if(item.words)received.push(item.words);});if(id===holding)await receiver.settle();
  if(mode==='success'||mode==='occupied'){
   const response=await status(child,token);
   expect(response.status).toBe(200);
   expect((await response.json()).value).toEqual({jobState:'running',resultDelivered:true});
  }
  return received;
 };
 if(holding){
  expect(db.select().from(s.jobs).where(eq(s.jobs.id,holding)).get()?.state).toBe('running');
  const earlier=await readAsCoordinator(holding,'body_'+'b'.repeat(64));
  expect(earlier).toContain('Another question for the coordinator');
  const finish=await root.http.request('/api/runtime/finish',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+bodyCredentials.runner},body:JSON.stringify({id:'finish-intervening-job',input:{job:holding,exitCode:0,logTail:''}})});
  expect(finish.status).toBe(200);
 }
 f.clock.advance(60_000);
 const coordinator=db.select().from(s.jobs).where(and(eq(s.jobs.conversation,f.thread.conversation),eq(s.jobs.state,'queued'))).get()!;
 expect(coordinator).toBeDefined();
 const received=await readAsCoordinator(coordinator.id,'body_'+'e'.repeat(64));
 expect(received).toContain(reply.words);
 root.services.comms!.delete(f.thread.id);
 expect(root.services.conversations.item(mail[0].id)).toMatchObject({state:'resolved',words:null,thread:null});
 expect(db.$client.serialize().includes(Buffer.from(reply.words))).toBe(false);
});
