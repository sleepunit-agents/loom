/** Actual Root HTTP/receiving SDK, fictional current private bodies, no provider. */
import {afterEach,expect,it,vi} from 'vitest';
import {eq} from 'drizzle-orm';
import {bodyFixture,bodyCredentials as raw,credentialHash} from '../test/fixtures/conversation-body.js';
import {bodyProgram} from './runtime/body-program.js';
import {sealHandoff} from './core/conversations/handoff-words.js';
import {bodyConversationClient,bodyMailContext} from './runtime/conversation-client.js';
import {privateInboxEnvelope,privateInboxWords} from './core/conversations/private-inbox-words.js';
import * as s from './core/data/schema.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{vi.restoreAllMocks();for(const close of clean.splice(0).reverse())await close();});
const question={words:'PRIVATE PUMP QUESTION',why:'PRIVATE PUMP REASON',ifYes:'PRIVATE YES OUTCOME',ifNo:'PRIVATE NO OUTCOME',link:'https://example.invalid/private-pump'};
type F=Awaited<ReturnType<typeof bodyFixture>>;
async function fixture(venue:'wake'|'handoff'|'discord'|'slack'='wake'){
 const f=await bodyFixture(clean);f.root.writes.run(()=>{f.db.delete(s.threads).where(eq(s.threads.id,f.thread.id)).run();f.db.update(s.conversations).set({venue,place:'fictional-background-place'}).where(eq(s.conversations.id,f.thread.conversation)).run();});return f;
}
async function ask(f:F,id='ask'){
 const response=await f.call('digest',{summary:'Fictitious work needs a decision',question:{...question,to:'alice',answers:'yes-no'}},id);expect(response.status).toBe(200);return (await response.json()).value.item as string;
}
const answer=(f:F,id:string,verdict='words',words='PRIVATE PERSON ANSWER')=>f.root.http.request('/api/inbox/answer',{method:'POST',headers:{cookie:'loom_ui='+raw.memberCookie,'content-type':'application/json'},body:JSON.stringify({input:{item:id,answer:verdict,...(['words','replied'].includes(verdict)?{words}:{})},id:'answer-'+id})});
const query=(f:F,source:string)=>f.root.http.request('/graphql',{method:'POST',headers:{cookie:'loom_ui='+raw.memberCookie,'content-type':'application/json'},body:JSON.stringify({query:source})});
const take=(f:F)=>f.root.http.request('/api/conversation/take',{method:'POST',headers:{authorization:'Bearer '+raw.body,'content-type':'application/json'},body:JSON.stringify({input:{}})});
function sdk(f:F){const client=bodyConversationClient({url:'https://loom.invalid',token:raw.body,job:'job',conversation:f.thread.conversation,signal:new AbortController().signal,clock:f.clock,fetch:async(url,init)=>f.root.http.request(new Request(url,init))});clean.push(()=>client.close());return client;}
function deadline(f:F,id:string,at:number){f.root.writes.run(()=>{const row=f.db.select().from(s.inbox).where(eq(s.inbox.id,id)).get()!,value=privateInboxEnvelope(row.words)!;f.db.update(s.inbox).set({words:row.words!.slice(0,row.words!.indexOf('{'))+JSON.stringify({...value,keepUntil:new Date(at).toISOString()})}).where(eq(s.inbox.id,id)).run();});}
function noCopies(f:F){for(const table of [s.inbox,s.jobs,s.operationResults,s.turns,s.digests,s.digestItems])expect(JSON.stringify(f.db.select().from(table).all())).not.toContain('PRIVATE');expect(f.db.select().from(s.threads).all()).toEqual([]);expect(f.db.select().from(s.messages).all()).toEqual([]);}
it.each(['wake','handoff','discord','slack'] as const)('a current private %s body raises an encrypted question in its actual conversation',async venue=>{
 const f=await fixture(venue);expect((await f.call('digest',{summary:'Baseline'},'baseline')).status).toBe(200);const id=await ask(f);
 const q=f.db.select().from(s.inbox).where(eq(s.inbox.id,id)).get()!;expect(q).toMatchObject({conversation:f.thread.conversation,toKind:'person',to:'alice',member:'alice',agent:'art',project:'pond',source:'thread',state:'waiting',thread:null,why:null,ifYes:null,ifNo:null,link:null});expect(privateInboxWords(q.words)).toBe(true);
 expect(await (await query(f,`{inboxItem(id:"${id}"){body{words why ifYes ifNo link} canAnswer}}`)).json()).toEqual({data:{inboxItem:{body:question,canAnswer:true}}});
 expect((await f.call('digest',{summary:'Wrong recipient',question:{...question,to:'bob',answers:'yes-no'}},'wrong')).status).toBe(403);
 expect((await f.call('digest',{summary:'Weak caller',question:{...question,to:'alice',answers:'yes-no'}},'weak',raw.agent)).status).toBe(403);
 expect(await ask(f)).toBe(id);expect(f.db.select().from(s.inbox).all()).toHaveLength(1);noCopies(f);
});
it.each(['yes','no','words','replied'])('records %s once and delivers retained answer and question to the actual receiving SDK',async verdict=>{
 const f=await fixture('handoff'),id=await ask(f);expect((await answer(f,id,verdict)).status).toBe(200);expect((await answer(f,id,verdict)).status).toBe(200);
 const recorded=f.db.select().from(s.inbox).where(eq(s.inbox.id,id)).get()!;expect(recorded).toMatchObject({state:'answered',answer:verdict,answerText:null,answeredBy:'alice'});expect(recorded.answeredAt).toBeTruthy();expect(f.db.select().from(s.inbox).all().filter(row=>row.source==='answer')).toHaveLength(1);
 const words=['words','replied'].includes(verdict)?'PRIVATE PERSON ANSWER':verdict;
 await sdk(f).takeAndAccept(async item=>{expect(item.source).toBe('answer');expect(item.sourceId).toBe(id);expect(item.words).toBe(words);expect(item.question).toEqual(question);expect(item.verdict).toBe(['yes','no'].includes(verdict)?verdict:null);expect(bodyMailContext(item)).not.toContain('loom:private-inbox');});
 expect(await (await query(f,`{inboxItem(id:"${id}"){answerText}}`)).json()).toEqual({data:{inboxItem:{answerText:['words','replied'].includes(verdict)?words:null}}});noCopies(f);
});
it('retires a rewritten pending question atomically and preserves answered history',async()=>{
 const f=await fixture(),first=await ask(f),second=await ask(f,'rewrite');expect(second).not.toBe(first);expect(f.db.select().from(s.inbox).where(eq(s.inbox.id,first)).get()).toMatchObject({state:'resolved',resolution:'Digest rewritten'});expect((await answer(f,second)).status).toBe(200);await ask(f,'again');expect(f.db.select().from(s.inbox).where(eq(s.inbox.id,second)).get()).toMatchObject({state:'answered'});noCopies(f);
});
it('withdraws private body authority while encrypting without committing a question or digest',async()=>{
 const f=await fixture();f.gate(async()=>{f.root.writes.run(()=>f.db.delete(s.memberAgents).run());});const response=await f.call('digest',{summary:'Fictitious decision',question:{...question,to:'alice',answers:'yes-no'}},'revoked');expect(response.status).toBe(403);expect(f.db.select().from(s.inbox).all()).toEqual([]);expect(f.db.select().from(s.digests).all()).toEqual([]);
});
it('withdraws the person session during answer encryption without recording an answer',async()=>{
 const f=await fixture(),id=await ask(f);f.gate(async()=>{f.root.writes.run(()=>f.db.delete(s.sessions).run());});expect((await answer(f,id)).status).toBe(403);expect(f.db.select().from(s.inbox).all()).toEqual([expect.objectContaining({id,state:'waiting',answer:null})]);
});
it('revokes unread original and cloned take responses at the question deadline, then delivers the independently retained answer',async()=>{
 const f=await fixture(),id=await ask(f);expect((await answer(f,id,'yes')).status).toBe(200);deadline(f,id,f.clock.now()+1000);const response=await take(f),wrapped=new Response(response.body,response),copy=wrapped.clone();expect(response.status).toBe(200);f.clock.advance(1000);await expect(wrapped.text()).rejects.toThrow();await expect(copy.text()).rejects.toThrow();await sdk(f).takeAndAccept(async item=>{expect(item.words).toBe('yes');expect(item.question).toBeNull();});expect(f.db.select().from(s.inbox).where(eq(s.inbox.id,id)).get()).toMatchObject({words:null,state:'answered',answer:'yes'});noCopies(f);
});
it('keeps matching private question and answer search IDs under their exact retention lease',async()=>{
 const f=await fixture(),id=await ask(f);expect((await answer(f,id)).status).toBe(200);const row=f.db.select().from(s.inbox).all().find(row=>row.source==='answer')!;deadline(f,row.id,f.clock.now()+1000);
 const search=()=>query(f,'{inboxItems(folder:"answered",search:"PRIVATE PERSON ANSWER"){id}}');expect(await (await search()).json()).toEqual({data:{inboxItems:[{id}]}});const delayed=await search(),copy=delayed.clone();vi.spyOn(f.clock,'now').mockReturnValue(f.clock.now()+1000);await expect(delayed.text()).rejects.toThrow();await expect(copy.text()).rejects.toThrow();noCopies(f);
});
it('shortening the household policy erases ciphertext while retaining question and answer metadata',async()=>{
 const f=await fixture(),id=await ask(f);expect((await answer(f,id,'no')).status).toBe(200);f.root.writes.run(()=>f.db.insert(s.household).values({commsDays:1}).run());f.clock.advance(86400000);expect(f.db.select().from(s.inbox).all()).toEqual([expect.objectContaining({id,words:null,state:'answered',answer:'no'}),expect.objectContaining({source:'answer',words:null})]);noCopies(f);
});
it('keeps the original ciphertext ceiling when the household policy grows',async()=>{
 const f=await fixture();f.root.writes.run(()=>f.db.insert(s.household).values({commsDays:1}).run());const id=await ask(f);expect((await answer(f,id)).status).toBe(200);const before=f.db.select().from(s.inbox).all();expect(before.every(row=>privateInboxEnvelope(row.words)?.keepUntil===new Date(f.clock.now()+86400000).toISOString())).toBe(true);f.root.writes.run(()=>f.db.update(s.household).set({commsDays:14}).run());f.clock.advance(86400000);expect(f.db.select().from(s.inbox).all().every(row=>row.words===null)).toBe(true);noCopies(f);
});
it('aborts SDK acceptance when the included private question expires during its sink',async()=>{
 const f=await fixture(),id=await ask(f);expect((await answer(f,id,'yes')).status).toBe(200);deadline(f,id,f.clock.now()+1000);let entered!:()=>void,release!:()=>void,signal:AbortSignal|undefined;const ready=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});const pending=sdk(f).takeAndAccept(async(item,current)=>{expect(item.question).toEqual(question);signal=current;entered();await gate;});await ready;f.clock.advance(1000);await expect(pending).rejects.toThrow();expect(signal?.aborted).toBe(true);release();await pending.catch(()=>{});expect(f.db.select().from(s.inbox).all().find(row=>row.source==='answer')?.state).toBe('taken');
});
it('withholds person-body bytes when the question expires during decryption',async()=>{
 const f=await fixture(),id=await ask(f);deadline(f,id,f.clock.now()+1000);f.openGate(async()=>{f.clock.advance(1000);});const response=await query(f,`{inboxItem(id:"${id}"){body{words why}}}`);expect(await response.text()).not.toContain('PRIVATE');noCopies(f);
});
it('withdraws current private body assignment while opening an answer without taking it',async()=>{
 const f=await fixture(),id=await ask(f);expect((await answer(f,id)).status).toBe(200);f.openGate(async()=>{f.root.writes.run(()=>f.db.delete(s.memberAgents).run());});const response=await take(f);expect(response.status).toBe(403);expect(await response.text()).not.toContain('PRIVATE');expect(f.db.select().from(s.inbox).all().find(row=>row.source==='answer')?.state).toBe('waiting');noCopies(f);
});
it('fails closed on corrupt answer ciphertext without confirming or discarding mail',async()=>{
 const f=await fixture(),id=await ask(f);expect((await answer(f,id)).status).toBe(200);f.root.writes.run(()=>{const row=f.db.select().from(s.inbox).all().find(row=>row.source==='answer')!,value=privateInboxEnvelope(row.words)!;f.db.update(s.inbox).set({words:row.words!.slice(0,row.words!.indexOf('{'))+JSON.stringify({...value,cipher:Buffer.from('not an age ciphertext').toString('base64')})}).where(eq(s.inbox.id,row.id)).run();});expect((await take(f)).status).toBe(503);expect(f.db.select().from(s.inbox).all().find(row=>row.source==='answer')?.state).toBe('waiting');noCopies(f);
});
it('rolls back both private answer and response mail when receipt persistence fails',async()=>{
 const f=await fixture(),id=await ask(f);f.db.$client.exec("CREATE TRIGGER reject_private_answer_receipt BEFORE INSERT ON operation_results WHEN NEW.operation='inbox.answer' BEGIN SELECT RAISE(FAIL,'fictional receipt failure'); END");expect((await answer(f,id)).status).toBe(503);expect(f.db.select().from(s.inbox).all()).toEqual([expect.objectContaining({id,state:'waiting',answer:null,answeredAt:null})]);noCopies(f);
});
it('lets household owners read private questions but keeps answering with the actual recipient',async()=>{
 const f=await fixture(),id=await ask(f),token='e'.repeat(64),cookie='f'.repeat(64),at=new Date(f.clock.now()).toISOString();
 f.root.writes.run(()=>{f.db.insert(s.memberAgents).values({member:'bob',agent:'art'}).run();f.db.insert(s.tokens).values({fingerprint:credentialHash(token),label:'Fictitious Bob',kind:'owner',member:'bob',createdAt:at}).run();f.db.insert(s.sessions).values({id:credentialHash(cookie),token:credentialHash(token),device:'Fictional',via:'link',isAgent:false,issuedAt:at,seenAt:at,provedAt:at}).run();});
 const read=()=>f.root.http.request('/graphql',{method:'POST',headers:{cookie:'loom_ui='+cookie,'content-type':'application/json'},body:JSON.stringify({query:`{inboxItem(id:"${id}"){body{words} canAnswer}}`})});
 expect(await (await read()).json()).toEqual({data:{inboxItem:null}});f.root.writes.run(()=>f.db.update(s.members).set({role:'owner'}).where(eq(s.members.id,'bob')).run());
 expect(await (await read()).json()).toEqual({data:{inboxItem:{body:{words:question.words},canAnswer:false}}});
 const denied=await f.root.http.request('/api/inbox/answer',{method:'POST',headers:{cookie:'loom_ui='+cookie,'content-type':'application/json'},body:JSON.stringify({input:{item:id,answer:'yes'},id:'other-owner-answer'})});expect(denied.status).toBe(403);expect(f.db.select().from(s.inbox).where(eq(s.inbox.id,id)).get()?.state).toBe('waiting');noCopies(f);
});
it('rechecks current assignment before replaying a private digest receipt',async()=>{
 const f=await fixture(),id=await ask(f);f.root.writes.run(()=>f.db.delete(s.memberAgents).run());const response=await f.call('digest',{summary:'Fictitious work needs a decision',question:{...question,to:'alice',answers:'yes-no'}},'ask');expect(response.status).toBe(403);expect(f.db.select().from(s.inbox).all()).toEqual([expect.objectContaining({id,state:'waiting'})]);
});
it('can record a decision after question words expire without resurrecting them',async()=>{
 const f=await fixture(),id=await ask(f);deadline(f,id,f.clock.now()+1000);f.clock.advance(1000);expect((await answer(f,id,'yes')).status).toBe(200);await sdk(f).takeAndAccept(async item=>{expect(item.words).toBe('yes');expect(item.verdict).toBe('yes');expect(item.question).toBeNull();});expect(f.db.select().from(s.inbox).where(eq(s.inbox.id,id)).get()?.words).toBeNull();noCopies(f);
});
it('refuses trusted producer mistakes that would put private question words in plaintext',async()=>{
 const f=await fixture(),cvs=f.root.services.comms!.threads.conversations;
 expect(()=>cvs.digest({conversation:f.thread.conversation,run:'job',summary:'Fictitious work',question:{...question,to:'alice',answers:'yes-no'}})).toThrow('encrypted');
 expect(()=>cvs.send({conversation:f.thread.conversation,toKind:'person',to:'alice',source:'thread',fromKind:'agent',fromId:'art',words:question.words,answers:'yes-no'})).toThrow('encrypted');expect(f.db.select().from(s.inbox).all()).toEqual([]);noCopies(f);
});
it.each(['wake','handoff'] as const)('preserves an owner question through actual private %s body completion',async venue=>{
 const f=await fixture(venue),token='body_'+'d'.repeat(64),at=new Date(f.clock.now()).toISOString();f.root.writes.run(()=>{f.db.insert(s.tokens).values({fingerprint:credentialHash(token),label:'Fictitious background body',kind:'agent',agent:'art',job:'job',createdAt:at}).run();if(venue==='handoff')f.db.insert(s.memberAgents).values({member:'alice',agent:'mark'}).run();});
 const instruction='Inspect the fictitious pump';f.root.services.comms!.threads.conversations.send({conversation:f.thread.conversation,toKind:'agent',to:'art',source:venue==='wake'?'trigger':'handoff',fromKind:venue==='wake'?'schedule':'agent',fromId:venue==='wake'?null:'mark',words:venue==='wake'?instruction:await sealHandoff(f.key,instruction,at,14)});
 const job={id:'job',box:'box',agent:'art',conversation:f.thread.conversation,thread:null,venue,model:'fixture',account:'fictional',harness:'claude' as const,brief:'',house:{repository:'fiction',file:'Housefile',branch:'next'}};
 const errors:string[]=[];expect(await bodyProgram({args:['config'],read:async()=>JSON.stringify({command:'/fictional/claude',cwd:'/fictional'}),stdin:async()=>Buffer.from(JSON.stringify({job,build:'fictional',bootstrap:{origin:'https://loom.invalid',job:'job',token}})),env:{},signal:new AbortController().signal,clock:f.clock,schedule:{every:()=>()=>{}},startup:async()=>{},loadMemory:async()=>null,fetch:async(url,init)=>f.root.http.request(new Request(url,init)),native:async(_job,words)=>{expect(words).toBe(instruction);const response=await f.call('digest',{summary:'Inspection needs a decision',question:{...question,to:'alice',answers:'yes-no'}},'authored',token);expect(response.status).toBe(200);return {text:'Fictitious work paused for its owner.',model:'fixture',actions:[]};},error:text=>errors.push(text)})).toBe(0);
 expect(errors).toEqual([]);const digest=f.db.select().from(s.digests).get()!;expect(digest).toMatchObject({summary:'Inspection needs a decision',revision:1});expect(f.db.select().from(s.inbox).where(eq(s.inbox.id,digest.inboxItem!)).get()).toMatchObject({to:'alice',state:'waiting',thread:null});expect(f.db.select().from(s.agentStatus).get()).toMatchObject({state:'idle',work:''});noCopies(f);
});
