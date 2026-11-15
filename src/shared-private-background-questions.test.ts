/** Actual Root HTTP/receiving SDK, fictional current private bodies, no provider. */
import {afterEach,expect,it,vi} from 'vitest';
import {eq} from 'drizzle-orm';
import {bodyFixture,bodyCredentials as raw,credentialHash} from '../test/fixtures/conversation-body.js';
import {bodyProgram} from './runtime/body-program.js';
import {sealHandoff} from './core/conversations/handoff-words.js';
import {bodyConversationClient,bodyMailContext} from './runtime/conversation-client.js';
import {privateInboxEnvelope,hasPrivateInboxWords,sealPrivateInbox} from './core/conversations/private-inbox-words.js';
import {sharedActivityConversations} from './pieces/mind/activity-conversations.js';
import {sharedSharing} from './shared-sharing.js';
import {conversationQuestionPolicy} from './shared-conversation-questions.js';
import {InboxQueries} from './core/conversations/inbox-query.js';
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
 const q=f.db.select().from(s.inbox).where(eq(s.inbox.id,id)).get()!;expect(q).toMatchObject({conversation:f.thread.conversation,toKind:'person',to:'alice',member:'alice',agent:'art',project:'pond',source:'thread',state:'waiting',thread:null,why:null,ifYes:null,ifNo:null,link:null});expect(hasPrivateInboxWords(q.words)).toBe(true);
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
it('Activity keeps a wordless link to a private question without projecting its ciphertext as a need',async()=>{
 const f=await fixture();await ask(f);const digest=f.db.select().from(s.digests).get()!,reader=sharedActivityConversations(f.db,{sharing:()=>sharedSharing(f.db),conversationHref:id=>'/p/comms-preview/conversation/'+id});const result=reader.read({kind:'member',id:'alice'},'art','digest',digest.id);expect(result?.summary).toBe(digest.summary);expect(result?.links).toEqual([{label:'Conversation',href:'/p/comms-preview/conversation/'+f.thread.conversation}]);expect(result).not.toHaveProperty('needs');expect(JSON.stringify(result)).not.toContain('loom:private-inbox');expect(JSON.stringify(result)).not.toContain('PRIVATE');
});
it('refuses plaintext question display fields even alongside a valid encrypted words envelope',async()=>{
 const f=await fixture(),words=await sealPrivateInbox(f.key,JSON.stringify(question),new Date(f.clock.now()).toISOString(),14);for(const field of ['why','ifYes','ifNo','link'])expect(()=>f.root.services.conversations.send({conversation:f.thread.conversation,toKind:'person',to:'alice',source:'thread',fromKind:'agent',fromId:'art',words,answers:'yes-no',[field]:'PRIVATE FIELD'})).toThrow('encrypted');expect(f.db.select().from(s.inbox).all()).toEqual([]);
});
it('rolls back a failed digest rewrite together with its new question and old question retirement',async()=>{
 const f=await fixture(),id=await ask(f),before=f.db.select().from(s.digests).all();f.db.$client.exec("CREATE TRIGGER reject_private_digest BEFORE UPDATE ON digests BEGIN SELECT RAISE(FAIL,'fictional digest failure'); END");const response=await f.call('digest',{summary:'Fictitious rewrite',question:{...question,to:'alice',answers:'yes-no'}},'failed-rewrite');expect(response.status).toBe(503);expect(f.db.select().from(s.digests).all()).toEqual(before);expect(f.db.select().from(s.inbox).all()).toEqual([expect.objectContaining({id,state:'waiting',resolution:null})]);noCopies(f);
});
function bobReader(f:F){
 const token='e'.repeat(64),cookie='f'.repeat(64),at=new Date(f.clock.now()).toISOString();f.root.writes.run(()=>{f.db.update(s.members).set({role:'owner'}).where(eq(s.members.id,'bob')).run();f.db.insert(s.tokens).values({fingerprint:credentialHash(token),label:'Fictitious Bob owner',kind:'owner',member:'bob',createdAt:at}).run();f.db.insert(s.sessions).values({id:credentialHash(cookie),token:credentialHash(token),device:'Fictional owner',via:'link',isAgent:false,issuedAt:at,seenAt:at,provedAt:at}).run();});
 return {revoke:()=>f.root.writes.run(()=>f.db.update(s.members).set({role:'member'}).where(eq(s.members.id,'bob')).run()),query:(source:string)=>f.root.http.request('/graphql',{method:'POST',headers:{cookie:'loom_ui='+cookie,'content-type':'application/json'},body:JSON.stringify({query:source})})};
}
it.each(['question','answer'] as const)('rechecks person sharing after async opening of a private %s',async kind=>{
 const f=await fixture(),id=await ask(f);if(kind==='answer')expect((await answer(f,id)).status).toBe(200);const bob=bobReader(f),reader=new InboxQueries(f.db,f.root.services.comms!.key,conversationQuestionPolicy(f.db).visibility,()=>new Date(f.clock.now()).toISOString());f.openGate(async()=>{bob.revoke();});expect(kind==='question'?await reader.body({kind:'member',id:'bob'},id):await reader.answerText({kind:'member',id:'bob'},id)).toBeNull();noCopies(f);
});
it('withdraws delayed and cloned person-read response bytes when household-owner sharing ends',async()=>{
 const f=await fixture(),id=await ask(f),bob=bobReader(f);const response=await bob.query(`{inboxItem(id:"${id}"){body{words why}}}`),copy=response.clone();bob.revoke();await expect(response.text()).rejects.toThrow();await expect(copy.text()).rejects.toThrow();noCopies(f);
});
it('refuses another conversation current body attempting to ask this private member',async()=>{
 const f=await fixture(),id=await ask(f),token='body_'+'e'.repeat(64);f.root.writes.run(()=>f.db.insert(s.memberAgents).values({member:'bob',agent:'mark'}).run());const other=f.root.services.comms!.threads.open({member:'bob',agent:'mark',title:'Fictitious foreign context'}),old=f.db.select().from(s.jobs).get()!;f.root.writes.run(()=>{f.db.insert(s.jobs).values({...old,id:'foreign-job',agent:'mark',member:'bob',project:null,conversation:other.conversation}).run();f.db.update(s.conversations).set({job:'foreign-job'}).where(eq(s.conversations.id,other.conversation)).run();f.db.insert(s.tokens).values({fingerprint:credentialHash(token),label:'Fictitious foreign body',kind:'agent',agent:'mark',job:'foreign-job',createdAt:new Date(f.clock.now()).toISOString()}).run();});expect((await f.call('digest',{summary:'Fictitious foreign baseline'},'foreign-baseline',token)).status).toBe(200);expect((await f.call('digest',{summary:'Fictitious foreign ask',question:{...question,to:'alice',answers:'yes-no'}},'foreign-ask',token)).status).toBe(403);expect(f.db.select().from(s.inbox).all()).toEqual([expect.objectContaining({id})]);
});
it('refuses a finished body before creating or replaying a private question',async()=>{
 const f=await fixture(),id=await ask(f);f.root.writes.run(()=>f.db.update(s.jobs).set({state:'done'}).where(eq(s.jobs.id,'job')).run());expect((await f.call('digest',{summary:'Fictitious work needs a decision',question:{...question,to:'alice',answers:'yes-no'}},'ask')).status).toBe(401);expect((await f.call('digest',{summary:'Fictitious stale work',question:{...question,to:'alice',answers:'yes-no'}},'stale-new')).status).toBe(401);expect(f.db.select().from(s.inbox).all()).toEqual([expect.objectContaining({id})]);
});
it('leases a private question-word search independently from its later answer deadline',async()=>{
 const f=await fixture(),id=await ask(f);expect((await answer(f,id)).status).toBe(200);deadline(f,id,f.clock.now()+1000);const search=()=>query(f,'{inboxItems(folder:"answered",search:"PRIVATE PUMP QUESTION"){id}}');expect(await (await search()).json()).toEqual({data:{inboxItems:[{id}]}});const delayed=await search(),copy=delayed.clone();vi.spyOn(f.clock,'now').mockReturnValue(f.clock.now()+1000);await expect(delayed.text()).rejects.toThrow();await expect(copy.text()).rejects.toThrow();noCopies(f);
});
it.each(['task','approval'] as const)('takes real private Comms and %s-source answers in one canonical-scope batch',async source=>{
 const f=await bodyFixture(clean);f.root.writes.run(()=>{f.db.update(s.conversations).set({project:null}).where(eq(s.conversations.id,f.thread.conversation)).run();f.db.update(s.jobs).set({project:null}).where(eq(s.jobs.id,'job')).run();if(source==='approval')f.db.update(s.members).set({role:'owner'}).where(eq(s.members.id,'alice')).run();});expect((await f.send('Fictitious private batch message','project-answer')).status).toBe(200);
 let response:Response;
 if(source==='task'){
  const task=f.root.services.tasks.create({title:'Fictitious project work',goal:'Exercise actual reply production',why:'Private discussion of project work',owner:{kind:'agent',id:'art'},project:'pond',source:{kind:'conversation',id:f.thread.conversation}},{kind:'member',id:'alice'});f.root.services.tasks.ask(task.id,{to:{kind:'member',id:'alice'},ask:'Inspect the fictitious project work?',answers:'yes-no',ifYes:'Art inspects.',ifNo:'Art waits.'},{kind:'agent',id:'art'});const q=f.db.select().from(s.inbox).all().find(i=>i.waitsOnId===task.id)!;
  response=await f.root.http.request('/api/tasks/command',{method:'POST',headers:{cookie:'loom_ui='+raw.memberCookie,'content-type':'application/json'},body:JSON.stringify({input:{action:'answer',id:task.id,question:q.id,answer:'yes'},id:'project-task-answer'})});
 }else{
  const approval=f.root.services.approvals.request({kind:'command',target:'fictional:private-batch',what:'Fictitious project inspection',why:'Private project discussion',agent:'art',askedFrom:f.thread.conversation,actingFor:'alice',conversation:f.thread.conversation,project:'pond',member:'alice',ask:'Allow the fictitious inspection?',ifYes:'Art inspects.',ifNo:'Art waits.'});response=await f.root.http.request('/api/approvals/answer',{method:'POST',headers:{cookie:'loom_ui='+raw.memberCookie,'content-type':'application/json'},body:JSON.stringify({input:{id:approval.id,answer:'allow'},id:'project-approval-answer'})});
 }
 expect(response.status).toBe(200);const seen:{id:string;seq:number;source:string}[]=[];await sdk(f).takeAndAccept(async item=>{seen.push({id:item.id,seq:item.seq,source:item.source});expect(item.words).toBeTruthy();});expect(seen.map(i=>i.source)).toEqual(['thread','answer']);expect(seen[0].seq).toBeLessThan(seen[1].seq);for(const item of seen)expect(f.db.select().from(s.inbox).where(eq(s.inbox.id,item.id)).get()).toMatchObject({member:'alice',agent:'art',project:null,state:'done'});
});
it('never relabels a different member private work source into this private conversation',async()=>{
 const f=await bodyFixture(clean),task=f.root.services.tasks.create({title:'Fictitious Bob-private task',goal:'Keep Bob private',why:'Reject a mismatched source',owner:{kind:'member',id:'bob'},source:{kind:'conversation',id:f.thread.conversation}},{kind:'member',id:'bob'});f.root.services.tasks.ask(task.id,{to:{kind:'member',id:'bob'},ask:'Fictitious Bob decision?',answers:'yes-no',ifYes:'Proceed.',ifNo:'Wait.'},{kind:'agent',id:'art'});expect(()=>f.root.services.tasks.answer(task.id,'yes','',{kind:'member',id:'bob'})).toThrow('private to another member');expect(f.db.select().from(s.inbox).all()).toEqual([expect.objectContaining({state:'waiting',to:'bob'})]);
 const publicCv=f.root.services.conversations.open({agent:'art',venue:'wake',place:'fictitious-public',project:'other',label:'Fictitious public context'});expect(f.root.services.conversations.answerScope(publicCv.id,'art',{project:'pond',member:'bob'})).toEqual({project:'pond',member:'bob'});
});
it('keeps ordinary public question words that happen to start with the private storage marker literal',async()=>{
 const f=await fixture();f.root.writes.run(()=>{f.db.update(s.conversations).set({member:null}).where(eq(s.conversations.id,f.thread.conversation)).run();f.db.update(s.jobs).set({member:null}).where(eq(s.jobs.id,'job')).run();});const words='loom:private-inbox:v1:literal authored public question';const response=await f.call('digest',{summary:'Fictitious public question',question:{to:'alice',answers:'words',words}},'literal-prefix');expect(response.status).toBe(200);const id=(await response.json()).value.item;f.clock.advance(0);expect(await (await query(f,`{inboxItem(id:"${id}"){body{words}}}`)).json()).toEqual({data:{inboxItem:{body:{words}}}});expect(f.db.select().from(s.inbox).where(eq(s.inbox.id,id)).get()?.words).toBe(words);
});
it('does not treat trigger instructions that start with the storage marker as private ciphertext',async()=>{
 const f=await fixture(),words='loom:private-inbox:v1:literal authored trigger instructions';const mail=f.root.services.conversations.send({conversation:f.thread.conversation,toKind:'agent',to:'art',source:'trigger',fromKind:'schedule',words});f.clock.advance(0);await sdk(f).takeAndAccept(async item=>expect(item.words).toBe(words));expect(f.db.select().from(s.inbox).where(eq(s.inbox.id,mail.id)).get()?.words).toBe(words);
});
