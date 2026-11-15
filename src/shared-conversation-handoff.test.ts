/** Real Root and receiving SDK; all bodies/people/words are fictional. */
import {afterEach,expect,it,vi} from 'vitest';
import {and,eq} from 'drizzle-orm';
import {z} from 'zod';
import {bodyFixture,bodyCredentials,credentialHash} from '../test/fixtures/conversation-body.js';
import * as s from './core/data/schema.js';
import {bodyProgram} from './runtime/body-program.js';
import {bodyProgramTools} from './runtime/body-program-tools.js';
import {bodyConversationClient} from './runtime/conversation-client.js';
import {handoffDeadline} from './core/conversations/handoff-words.js';
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
 f.root.writes.run(()=>{
  f.db.update(s.jobs).set({box:'box',state:'running',heardAt:new Date(f.clock.now()+100*86400000).toISOString()}).where(eq(s.jobs.id,row.id)).run();
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
 expect(stored.words).not.toContain(brief.words);expect(handoffDeadline(stored,14)).toBe(f.clock.now()+14*86400000);
 expect(f.db.select().from(s.threads).all()).toHaveLength(1);
 expect(await create(f,'different-receipt')).toEqual(created);
 expect(f.db.select().from(s.turns).where(eq(s.turns.conversation,cv.id)).all()).toHaveLength(1);
 f.clock.advance(60_000);
 const {sdk,job}=receive(f,cv.id);
 expect(f.db.select().from(s.jobs).where(eq(s.jobs.id,job)).get()?.brief).toBe('');
 expect(await sdk.takeAndAccept(async item=>{expect(item).toMatchObject({source:'handoff',fromKind:'agent',fromId:'art',words:brief.words,keepUntil:new Date(handoffDeadline(stored,14)).toISOString()});})).toMatchObject({accepted:1});
 expect(f.db.select().from(s.inbox).where(eq(s.inbox.id,stored.id)).get()?.state).toBe('done');
 for(const table of [s.inbox,s.jobs,s.operationResults,s.conversations,s.turns])expect(JSON.stringify(f.db.select().from(table).all())).not.toContain(brief.words);
 expect(f.db.$client.serialize().includes(Buffer.from(brief.words))).toBe(false);
});
it.each(['ordinary-agent','member','missing-agent','foreign-project','foreign-owner','spoofed-parent'] as const)('rejects %s before producing mail',async mode=>{
 const f=await fixture();let token=bodyCredentials.body,input:unknown=brief;
 if(mode==='ordinary-agent')token=bodyCredentials.agent;
 if(mode==='member')token=bodyCredentials.member;
 if(mode==='missing-agent')input={...brief,agent:'missing'};
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
