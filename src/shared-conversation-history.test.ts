/** Fresh native bodies get bounded retained dialogue through existing take only. */
import {afterEach,expect,it,vi} from 'vitest';
import Database from 'better-sqlite3';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {bodySessions} from './runtime/body-session.js';
import {jobRoom} from './shared-place-mail.js';
import {bodyCommandClient} from './runtime/body-command-client.js';
import {dataDatabase} from './core/data/database.js';
import {ConversationSessions} from './core/conversations/sessions.js';
import {eq,and} from 'drizzle-orm';
import {bodyFixture,bodyCredentials as raw,credentialHash as hash} from '../test/fixtures/conversation-body.js';
import {bodyConversationClient,bodyMailContext} from './runtime/conversation-client.js';
import {Jobs} from './runtime/jobs.js';
import {SILENCE_MS, REPORT_MS} from './runtime/silence.js';
import {bodyProgram} from './runtime/body-program.js';
import * as s from './core/data/schema.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
function sdk(f:Awaited<ReturnType<typeof bodyFixture>>,token=raw.body,job='job'){
 const client=bodyConversationClient({url:'https://loom.invalid',token,job,conversation:f.thread.conversation,signal:new AbortController().signal,clock:f.clock,fetch:async(url,init)=>f.root.http.request(new Request(url,init))});clean.push(()=>client.close());return client;
}
const take=(f:Awaited<ReturnType<typeof bodyFixture>>)=>f.root.http.request('/api/conversation/take',{method:'POST',headers:{authorization:'Bearer '+raw.body,'content-type':'application/json'},body:JSON.stringify({input:{}})});
async function fixture(){
 const f=await bodyFixture(clean),client=sdk(f);
 await f.send('PRIOR PERSON DIALOGUE','prior');await client.takeAndAccept(async()=>{});
 await client.reply({clientId:'prior-answer',words:'PRIOR AGENT REPLY',model:'fixture'});
 await f.send('Do that again','followup');return {...f,client};
}
it('gives a different fresh body the retained dialogue and follow-up without a second store/read door',async()=>{
 const f=await fixture(),old=f.db.select().from(s.jobs).get()!,token='body_'+'d'.repeat(64),beforeMessages=f.db.select().from(s.messages).all();
 f.root.services.runtime.stop('job','alice','reset');
 f.root.writes.run(()=>{
  f.db.insert(s.jobs).values({...old,id:'fresh-job',state:'running'}).run();
  f.db.insert(s.tokens).values({fingerprint:hash(token),label:'Fictional fresh body',kind:'agent',agent:'art',job:'fresh-job',createdAt:new Date(f.clock.now()).toISOString()}).run();
 });
 const native=vi.fn(async(_job:unknown,context:string)=>{const value=JSON.parse(context);expect(value.input).toBe('Do that again');expect(value.history.map((line:{words:string})=>line.words)).toEqual(['PRIOR PERSON DIALOGUE','PRIOR AGENT REPLY']);expect(value.history.map((line:{sender:string})=>line.sender)).toEqual(['alice','art']);return{text:'New answer',model:'fixture',actions:[]};});
 const job={id:'fresh-job',box:'box',agent:'art',conversation:f.thread.conversation,thread:f.thread.id,model:'fixture',account:'fictional',harness:'claude' as const,brief:'',house:{repository:'fiction',file:'Housefile',branch:'next'}};
 expect(await bodyProgram({args:['config'],read:async()=>JSON.stringify({command:'/fictional/claude',cwd:'/fictional'}),stdin:async()=>Buffer.from(JSON.stringify({job,build:'fixture',bootstrap:{origin:'https://loom.invalid',job:'fresh-job',token}})),env:{},signal:new AbortController().signal,clock:f.clock,fetch:async(url,init)=>f.root.http.request(new Request(url,init)),startup:async()=>{},native,error:()=>{}})).toBe(0);
 expect(native).toHaveBeenCalledOnce();expect(f.db.select().from(s.messages).all().slice(0,2)).toEqual(beforeMessages.slice(0,2));
 for(const table of [s.inbox,s.jobs,s.operationResults])for(const words of ['PRIOR PERSON DIALOGUE','PRIOR AGENT REPLY'])expect(JSON.stringify(f.db.select().from(table).all())).not.toContain(words);
});
it('recovers accepted private mail on a second worker and fences the former body before and after the reply',async()=>{
 const f=await fixture(),runtime=f.root.services.runtime;
 const now=()=>new Date(f.clock.now()).toISOString();
 const jobs=new Jobs(f.db,now);
 runtime.start();
 const [box]=f.db.select().from(s.boxes).all();
 f.db.insert(s.boxes).values({...box,id:'second-box',name:'Second box'}).run();
 // The worker accepted the follow-up and then vanished before recording an answer.
 await f.client.takeAndAccept(async item=>{expect(item.words).toBe('Do that again');});
 f.clock.advance(SILENCE_MS + 2 * REPORT_MS);
 const replacement=f.db.select().from(s.jobs).where(eq(s.jobs.retryOf,'job')).get()!;
 expect(replacement.state).toBe('queued');
 expect(jobs.claim(replacement.id,'second-box')).toBeUndefined();
 f.clock.advance(Date.parse(replacement.retryAt!)-f.clock.now());
 expect(jobs.claim(replacement.id,'second-box')?.box).toBe('second-box');
 jobs.started(replacement.id,'second-box','fixture-build');
 const token='second_'+'d'.repeat(64);
 f.db.insert(s.tokens).values({fingerprint:hash(token),label:'Second worker body',kind:'agent',agent:'art',job:replacement.id,createdAt:now()}).run();
 const next=sdk(f,token,replacement.id);
 await expect(f.client.reply({clientId:'late',words:'Stale answer',model:'fixture'})).rejects.toThrow();
 const inputs:string[]=[];
 await next.takeAndAccept(async item=>{
  inputs.push(item.words!);
  expect(item.history.map(line=>line.words)).toEqual(['PRIOR PERSON DIALOGUE','PRIOR AGENT REPLY']);
 });
 expect(inputs).toEqual(['Do that again']);
 await next.reply({clientId:'completed',words:'Second worker answer',model:'fixture'});
 // A second loss after the durable reply, before the worker's final receipt, must not run the input again.
 f.clock.advance(SILENCE_MS + 2 * REPORT_MS);
 expect(f.db.select().from(s.jobs).where(eq(s.jobs.retryOf,replacement.id)).all()).toEqual([]);
 expect(f.db.select().from(s.messages).where(eq(s.messages.thread,f.thread.id)).all().map(row=>row.clientId))
  .toEqual(['prior','job:prior-answer','followup',replacement.id+':completed']);
 await expect(next.reply({clientId:'too-late',words:'Duplicate',model:'fixture'})).rejects.toThrow();
});
it('restricts history to this conversation and excludes the current batch and unavailable old words',async()=>{
 const f=await fixture(),other=f.root.services.comms!.threads.open({member:'bob',agent:'mark',title:'Other'});
 await f.root.services.comms!.send({thread:other.id,sender:'mark',kind:'reply',words:'BOB PRIVATE HISTORY'});
 f.root.writes.run(()=>f.db.update(s.messages).set({keepUntil:new Date(f.clock.now()).toISOString(),words:null}).where(and(eq(s.messages.thread,f.thread.id),eq(s.messages.seq,1))).run());
 await f.client.takeAndAccept(async item=>{expect(item.history.map(line=>line.words)).toEqual(['PRIOR AGENT REPLY']);expect(bodyMailContext(item)).not.toContain('BOB PRIVATE HISTORY');expect(item.history.every(line=>line.seq<3)).toBe(true);expect(Object.isFrozen(item.history)).toBe(true);expect(Object.isFrozen(item.history[0])).toBe(true);});
});
it('does not expand Dim input with retained dialogue',async()=>{
 const f=await fixture();f.root.writes.run(()=>f.db.update(s.inbox).set({volume:'dim'}).where(eq(s.inbox.state,'waiting')).run());
 await f.client.takeAndAccept(async item=>expect(item.history).toEqual([]));
});
it('revokes original and cloned response bytes at the earliest retained dialogue deadline',async()=>{
 const f=await fixture();f.root.writes.run(()=>f.db.update(s.messages).set({keepUntil:new Date(f.clock.now()+1000).toISOString()}).where(and(eq(s.messages.thread,f.thread.id),eq(s.messages.seq,1))).run());
 const response=await take(f),wrapped=new Response(response.body,response),copy=wrapped.clone();expect(response.status).toBe(200);f.clock.advance(1000);
 await expect(wrapped.text()).rejects.toThrow();await expect(copy.text()).rejects.toThrow();
 await f.client.takeAndAccept(async item=>{expect(item.words).toBe('Do that again');expect(item.history.map(line=>line.words)).toEqual(['PRIOR AGENT REPLY']);});
});
it('withdraws assignment during history decryption without claiming the new input',async()=>{
 const f=await fixture();let opens=0;f.openGate(async()=>{if(++opens===2)f.root.writes.run(()=>f.db.delete(s.memberAgents).run());});
 const response=await take(f);expect(response.status).toBe(403);expect(await response.text()).not.toContain('PRIOR');expect(f.db.select().from(s.inbox).all().find(row=>row.state==='waiting')).toBeTruthy();
});
it('aborts acceptance when included history expires and retries the independently retained input',async()=>{
 const f=await fixture();f.root.writes.run(()=>f.db.update(s.messages).set({keepUntil:new Date(f.clock.now()+1000).toISOString()}).where(and(eq(s.messages.thread,f.thread.id),eq(s.messages.seq,1))).run());
 let ready!:()=>void,release!:()=>void,signal:AbortSignal|undefined;const entered=new Promise<void>(resolve=>{ready=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
 const pending=f.client.takeAndAccept(async(item,current)=>{expect(item.history).toHaveLength(2);signal=current;ready();await gate;});
 await entered;f.clock.advance(1000);await expect(pending).rejects.toThrow();expect(signal?.aborted).toBe(true);release();await pending.catch(()=>{});
 expect(f.db.select().from(s.inbox).all().find(row=>row.source==='thread'&&row.messageSeq===3)?.state).toBe('taken');
 await f.client.takeAndAccept(async item=>{expect(item.words).toBe('Do that again');expect(item.history.map(line=>line.words)).toEqual(['PRIOR AGENT REPLY']);});
});
it('refuses history that expires while registering its acceptance deadline',async()=>{
 const f=await fixture(),deadline=f.clock.now()+1000;
 f.root.writes.run(()=>f.db.update(s.messages).set({keepUntil:new Date(deadline).toISOString()}).where(and(eq(s.messages.thread,f.thread.id),eq(s.messages.seq,1))).run());
 let crossed=false;
 const client=bodyConversationClient({url:'https://loom.invalid',token:raw.body,job:'job',conversation:f.thread.conversation,signal:new AbortController().signal,clock:{now:()=>f.clock.now(),at:(when,callback)=>{
  if(when===deadline&&!crossed){crossed=true;f.clock.advance(1000);}
  return f.clock.at(when,callback);
 }},fetch:async(url,init)=>f.root.http.request(new Request(url,init))});clean.push(()=>client.close());
 const accept=vi.fn();
 await expect(client.takeAndAccept(accept)).rejects.toThrow();expect(crossed).toBe(true);expect(accept).not.toHaveBeenCalled();
 await f.client.takeAndAccept(async item=>{expect(item.words).toBe('Do that again');expect(item.history.map(line=>line.words)).toEqual(['PRIOR AGENT REPLY']);});
});
it.each(['count','bytes'] as const)('bounds retained dialogue by %s and keeps its newest chronological suffix',async mode=>{
 const f=await bodyFixture(clean),client=sdk(f),count=mode==='count'?105:12,words=mode==='count'?'Small prior reply':'🙂'.repeat(25000);
 for(let i=0;i<count;i++)await f.root.services.comms!.send({thread:f.thread.id,sender:'art',kind:'reply',words});
 await f.send('Current input','current');
 await client.takeAndAccept(async item=>{
  if(mode==='count'){expect(item.history).toHaveLength(100);expect(item.history[0].seq).toBe(6);}
  else{expect(item.history.length).toBeGreaterThan(0);expect(item.history.length).toBeLessThan(count);expect(Buffer.byteLength(JSON.stringify(item.history))).toBeLessThanOrEqual(1_048_576);}
  expect(item.history.at(-1)?.seq).toBe(count);expect(item.words).toBe('Current input');
 });
});
it('omits unreadable optional history and still accepts independently retained current input',async()=>{
 const f=await fixture();f.root.writes.run(()=>f.db.update(s.messages).set({words:Buffer.from('not an age ciphertext')}).where(and(eq(s.messages.thread,f.thread.id),eq(s.messages.seq,1))).run());
 await f.client.takeAndAccept(async item=>{expect(item.words).toBe('Do that again');expect(item.history.map(line=>line.words)).toEqual(['PRIOR AGENT REPLY']);});
});
it('refuses malformed history ordering before accepting or confirming current mail',async()=>{
 const f=await fixture(),accept=vi.fn();
 const client=bodyConversationClient({url:'https://loom.invalid',token:raw.body,job:'job',conversation:f.thread.conversation,signal:new AbortController().signal,clock:f.clock,fetch:async(url,init)=>{
  const response=await f.root.http.request(new Request(url,init));if(!String(url).endsWith('/take'))return response;
  const value=await response.json();value.value.items[0].history.reverse();return Response.json(value);
 }});clean.push(()=>client.close());
 await expect(client.takeAndAccept(accept)).rejects.toThrow();expect(accept).not.toHaveBeenCalled();expect(f.db.select().from(s.inbox).all().find(row=>row.messageSeq===3)?.state).toBe('taken');
});
it('keeps earlier questions on the separately validated answer-context path',async()=>{
 const f=await bodyFixture(clean),client=sdk(f);
 await client.digest({summary:'Old question',question:{to:'alice',words:'EARLIER QUESTION',answers:'words'}});
 await f.send('A new ordinary follow-up','followup');
 await client.takeAndAccept(async item=>{expect(item.history).toEqual([]);expect(bodyMailContext(item)).not.toContain('EARLIER QUESTION');});
});
it.each(['dim','mute'] as const)('never expands an earlier %s delivery in a later Full follow-up',async volume=>{
 const f=await bodyFixture(clean),client=sdk(f);
 await f.send('FIRST LINE\nPRIVATE SECOND LINE','earlier');
 f.root.writes.run(()=>f.db.update(s.inbox).set({volume}).run());
 await client.takeAndAccept(async item=>{expect(item.words).toBe(volume==='dim'?'FIRST LINE':null);});
 await f.send('Full follow-up','later');
 await client.takeAndAccept(async item=>{expect(item.words).toBe('Full follow-up');expect(item.history).toEqual([]);});
});
it('does not put still-pending thread mail in history when taking a different source first',async()=>{
 const f=await bodyFixture(clean),client=sdk(f);
 f.root.writes.run(()=>f.root.services.conversations.send({toKind:'agent',to:'art',conversation:f.thread.conversation,source:'notice',fromKind:'unknown',words:'Earlier notice'}));
 await f.send('PENDING PERSON WORDS','pending');
 await client.takeAndAccept(async item=>{expect(item.words).toBe('Earlier notice');expect(item.history).toEqual([]);},1);
 await client.takeAndAccept(async item=>{expect(item.words).toBe('PENDING PERSON WORDS');expect(item.history).toEqual([]);},1);
});
it.each(['cipher','swept','expiry','metadata','volume'] as const)('omits optional history changed during decryption: %s',async change=>{
 const f=await fixture();let opens=0;
 if(change==='expiry')f.root.writes.run(()=>f.db.update(s.messages).set({keepUntil:new Date(f.clock.now()+1000).toISOString()}).where(eq(s.messages.seq,2)).run());
 f.openGate(async()=>{if(++opens!==3)return;f.root.writes.run(()=>{
  if(change==='cipher')f.db.update(s.messages).set({words:Buffer.from('changed cipher')}).where(eq(s.messages.seq,2)).run();
  if(change==='swept')f.db.update(s.messages).set({words:null}).where(eq(s.messages.seq,2)).run();
  if(change==='expiry')f.clock.advance(1000);
  if(change==='metadata')f.db.update(s.messages).set({sender:'changed sender'}).where(eq(s.messages.seq,2)).run();
  if(change==='volume')f.db.update(s.inbox).set({volume:'dim'}).where(eq(s.inbox.messageSeq,1)).run();
 });});
 await f.client.takeAndAccept(async item=>{expect(item.words).toBe('Do that again');expect(item.history.map(line=>line.words)).toEqual([change==='volume'?'PRIOR AGENT REPLY':'PRIOR PERSON DIALOGUE']);});
 expect(opens).toBe(3);
});
it('rejects an oversized history array at the receiving SDK before acceptance',async()=>{
 const f=await fixture(),accept=vi.fn();
 const client=bodyConversationClient({url:'https://loom.invalid',token:raw.body,job:'job',conversation:f.thread.conversation,signal:new AbortController().signal,clock:f.clock,fetch:async(url,init)=>{
  const response=await f.root.http.request(new Request(url,init));if(!String(url).endsWith('/take'))return response;
  const value=await response.json();value.value.items[0].history[0].words='x'.repeat(1_048_576);return Response.json(value);
 }});clean.push(()=>client.close());
 await expect(client.takeAndAccept(accept)).rejects.toThrow();expect(accept).not.toHaveBeenCalled();
});
it.each(['dim','mute','expired'] as const)('gives the Full follow-up its context after a first %s item',async mode=>{
 const f=await fixture();
 if(mode==='expired')f.root.writes.run(()=>f.db.update(s.messages).set({keepUntil:new Date(f.clock.now()).toISOString()}).where(eq(s.messages.seq,3)).run());
 else f.root.writes.run(()=>f.db.update(s.inbox).set({volume:mode}).where(eq(s.inbox.messageSeq,3)).run());
 await f.send('Second Full follow-up','second-full');
 let accepted=0;
 await f.client.takeAndAccept(async item=>{accepted++;if(accepted===1&&mode!=='mute')expect(item.history).toEqual([]);else{expect(item.words).toBe('Second Full follow-up');expect(item.history.map(line=>line.words)).toEqual(['PRIOR PERSON DIALOGUE','PRIOR AGENT REPLY']);}});
 expect(accepted).toBe(mode==='mute'?1:2);
});
it('keeps private thread history off nonthread mail even when old dialogue exists',async()=>{
 const f=await fixture();await f.client.takeAndAccept(async()=>{});
 f.root.writes.run(()=>f.root.services.conversations.send({toKind:'agent',to:'art',conversation:f.thread.conversation,source:'notice',fromKind:'unknown',words:'Notice only'}));
 await f.client.takeAndAccept(async item=>{expect(item.words).toBe('Notice only');expect(item.history).toEqual([]);});
});
it('excludes a reply between pending thread inputs and attaches history only once',async()=>{
 const f=await fixture();await f.client.reply({clientId:'between',words:'REPLY BETWEEN PENDING INPUTS',model:'fixture'});await f.send('Second current input','second');
 let accepted=0;await f.client.takeAndAccept(async item=>{accepted++;expect(item.history.map(line=>line.words)).toEqual(accepted===1?['PRIOR PERSON DIALOGUE','PRIOR AGENT REPLY']:[]);});expect(accepted).toBe(2);
});
it('drops history already expired at the receiving clock while accepting current input',async()=>{
 const f=await fixture(),client=bodyConversationClient({url:'https://loom.invalid',token:raw.body,job:'job',conversation:f.thread.conversation,signal:new AbortController().signal,clock:f.clock,fetch:async(url,init)=>{
  const response=await f.root.http.request(new Request(url,init));if(!String(url).endsWith('/take'))return response;
  const value=await response.json();value.value.items[0].history[0].keepUntil=new Date(f.clock.now()-1).toISOString();return Response.json(value);
 }});clean.push(()=>client.close());
 await client.takeAndAccept(async item=>{expect(item.words).toBe('Do that again');expect(item.history.map(line=>line.words)).toEqual(['PRIOR AGENT REPLY']);});
});
it('never repeats an earlier answered question through ordinary history',async()=>{
 const f=await bodyFixture(clean),client=sdk(f),digest=await client.digest({summary:'Question',question:{to:'alice',words:'OLD QUESTION',answers:'yes-no'}});
 const answered=await f.root.http.request('/api/inbox/answer',{method:'POST',headers:{cookie:'loom_ui='+raw.memberCookie,'content-type':'application/json'},body:JSON.stringify({input:{item:digest.item,answer:'yes'},id:'answer'})});expect(answered.status).toBe(200);
 await client.takeAndAccept(async item=>expect(item.question?.words).toBe('OLD QUESTION'));
 await f.send('Later ordinary message','later');await client.takeAndAccept(async item=>expect(item.history).toEqual([]));
});
it.each(['expire','content','set','confirm-retry'] as const)('never promotes previously Dim words into history after %s restores volume',async mode=>{
 const f=await bodyFixture(clean),client=sdk(f);
 await f.send('FIRST LINE\nNEVER DELIVERED SECOND LINE','dim-first');
 const original=f.db.select().from(s.inbox).get()!;
 f.root.writes.run(()=>f.root.services.tempo.volume.set({kind:'agent',id:'art'},original.id,'dim',new Date(f.clock.now()+1000).toISOString()));
 await client.takeAndAccept(async item=>expect(item.words).toBe('FIRST LINE'));
 if(mode==='expire'){f.clock.advance(1000);f.root.writes.run(()=>f.root.services.tempo.volume.expire());}
 else if(mode==='content')f.root.writes.run(()=>f.root.services.tempo.volume.changed({kind:'agent',id:'art'},original.id));
 else f.root.writes.run(()=>f.root.services.tempo.volume.set({kind:'agent',id:'art'},original.id,'full'));
 expect(f.db.select().from(s.inbox).where(eq(s.inbox.id,original.id)).get()?.volume).toBe('full');
 if(mode==='confirm-retry')expect((await f.call('confirm',{items:[original.id]},'confirm-again')).status).toBe(200);
 expect(f.db.select().from(s.inbox).where(eq(s.inbox.id,original.id)).get()?.takenVolume).toBe('dim');
 await f.send('Later Full input','full-later');await client.takeAndAccept(async item=>{expect(item.words).toBe('Later Full input');expect(item.history).toEqual([]);});
});
it.each(['multiple','source','count'] as const)('rejects malformed history at the receiving SDK: %s',async mode=>{
 const f=await fixture(),accept=vi.fn();await f.send('Second input','second');
 const client=bodyConversationClient({url:'https://loom.invalid',token:raw.body,job:'job',conversation:f.thread.conversation,signal:new AbortController().signal,clock:f.clock,fetch:async(url,init)=>{
  const response=await f.root.http.request(new Request(url,init));if(!String(url).endsWith('/take'))return response;
  const value=await response.json(),first=value.value.items[0];
  if(mode==='multiple')value.value.items[1].history=structuredClone(first.history);
  if(mode==='source')first.source='answer';
  if(mode==='count')first.history=Array.from({length:101},(_,index)=>({...first.history[0],seq:index+1}));
  return Response.json(value);
 }});clean.push(()=>client.close());
 await expect(client.takeAndAccept(accept)).rejects.toThrow();expect(accept).not.toHaveBeenCalled();
});

it('retains the issued input deadline after reopening the database and discards a checkpoint at that deadline',async()=>{
 const f=await bodyFixture(clean), now=()=>new Date(f.clock.now()).toISOString();
 const sdkBody=sdk(f), start=now(), deadline=new Date(f.clock.now()+5000).toISOString();
 await f.send('Earlier input','earlier');
 f.db.update(s.messages).set({keepUntil:deadline}).where(eq(s.messages.thread,f.thread.id)).run();
 await sdkBody.takeAndAccept(async item=>{expect(item.keepUntil).toBe(deadline);});
 f.clock.advance(1000);
 await f.send('Later input','later');
 await sdkBody.takeAndAccept(async()=>{});
 const copy=new Database(f.db.$client.serialize());
 clean.push(()=>copy.close());
 const reopened=dataDatabase(copy,now);
 expect(reopened.select().from(s.jobSessionLimits).get()).toEqual({job:'job',since:start,keepUntil:deadline});
 const sessions=new ConversationSessions(reopened,now,f.key);
 const prepared=await sessions.seal({conversation:f.thread.conversation,harness:'claude',model:'fixture',session:'abcd-1234',
  files:Buffer.from('fictional checkpoint').toString('base64')});
 expect(sessions.store(prepared,'job')).toBe(true);
 expect(reopened.select().from(s.conversationSessions).get()?.keepUntil).toBe(deadline);
 f.clock.advance(4000);
 expect(await sessions.open(f.thread.conversation,'claude','fixture')).toBeNull();
 expect(sessions.store(prepared,'job')).toBe(false);
});

it('keeps a replacement job bound by the checkpoint it could restore even after the source is erased',async()=>{
 const f=await bodyFixture(clean), now=()=>new Date(f.clock.now()).toISOString(), jobs=new Jobs(f.db,now);
 const sessions=new ConversationSessions(f.db,now,f.key);
 const input={conversation:f.thread.conversation,harness:'claude',model:'fixture',session:'abcd-1234',
   files:Buffer.from('fictional checkpoint').toString('base64')};
 const expiry=new Date(f.clock.now()+1000).toISOString();
 expect(sessions.store(await sessions.seal({...input,keepUntil:expiry}))).toBe(true);
 f.db.update(s.jobs).set({state:'starting',harness:'claude'}).where(eq(s.jobs.id,'job')).run();
 jobs.started('job','box','fixture');
 expect(await sessions.open(input.conversation,'claude','fixture')).not.toBeNull();
 f.clock.advance(1000);
 f.root.services.comms!.expire();
 expect(f.db.select().from(s.conversationSessions).all()).toEqual([]);
 expect(sessions.store(await sessions.seal(input),'job')).toBe(false);
 jobs.finish('job','box',0);
 expect(f.db.select().from(s.jobSessionLimits).all()).toEqual([]);
});

it('returns stable coverage keys only to a worker that requests them and omits them from the model prompt', async()=>{
 const f=await fixture();
 const prior=f.db.select().from(s.messages).where(and(eq(s.messages.thread,f.thread.id),eq(s.messages.seq,1))).get()!;
 await f.client.takeAndAccept(async item=>{
   expect(item.history.map(line=>line.sourceKey)).toEqual(['input:'+prior.inboxItem,'reply:2']);
   expect(bodyMailContext(item)).not.toContain('sourceKey');
 },50,true);
});

it('hands a private Comms checkpoint to the replacement body after a loss and keeps the delivered deadline authoritative',async()=>{
 const f=await bodyFixture(clean), now=()=>new Date(f.clock.now()).toISOString(), jobs=new Jobs(f.db,now);
 f.db.update(s.jobs).set({harness:'claude'}).where(eq(s.jobs.id,'job')).run();
 const old=sdk(f);
 await f.send('First private input','first');
 const expiry=new Date(f.clock.now()+600000).toISOString();
 f.db.update(s.messages).set({keepUntil:expiry}).where(eq(s.messages.thread,f.thread.id)).run();
 const session='0f0e0d0c-1111-4222-8333-444455556666';
 const run=async(id:string,box:string,token:string,continuing:boolean)=>{
  const base=mkdtempSync(join(tmpdir(),'loom-private-checkpoint-')),place=join(base,'.claude');
  clean.push(()=>rmSync(base,{recursive:true,force:true}));
  mkdirSync(place);
  const env={CLAUDE_CONFIG_DIR:place,LOOM_BODY_OWN_HARNESS:'1'};
  const path=join(place,'projects','-house',session+'.jsonl');
  const fetch:typeof globalThis.fetch=async(url,init)=>f.root.http.request(new Request(url,init));
  const signal=new AbortController().signal;
  const client=bodyCommandClient({url:'https://loom.invalid',clock:f.clock,token,signal,fetch});
  clean.push(()=>client.close());
  const keeper=bodySessions(client,'claude',env,place,base)!;
  const job={id,agent:'art',box,run:{nestedContainers:false,gpu:false,ports:[],policy:jobRoom(f.db,{id,agent:'art',conversation:f.thread.conversation})},venue:'loom',thread:f.thread.id,conversation:f.thread.conversation,
    model:'fixture',account:'fixture',harness:'claude',brief:'',house:{repository:'fixture',file:'Housefile',branch:'next'}};
  const native=vi.fn<NonNullable<Parameters<typeof bodyProgram>[0]['native']>>(async(_room,context,_signal,options)=>{
   if(continuing){
    expect(options?.resume).toBe(session);
    expect(context).toContain('Continue');expect(context).not.toContain('First private input');expect(context).not.toContain('Recorded reply');
    expect(readFileSync(path,'utf8')).toBe('fictional first turn');
   }else{
    expect(options?.resume).toBeUndefined();
    expect(context).toContain('First private input');
    mkdirSync(join(place,'projects','-house'),{recursive:true});
   }
   writeFileSync(path,continuing?'fictional second turn':'fictional first turn');
   return {text:continuing?'Continued reply':'Recorded reply',model:'fixture',actions:[],session};
  });
  const exit=await bodyProgram({args:['config'],read:async()=>JSON.stringify({command:'/fixture/claude',cwd:'/fixture'}),
   stdin:async()=>Buffer.from(JSON.stringify({job,build:'fixture',bootstrap:{origin:'https://loom.invalid',job:id,token}})),
   env,signal,clock:f.clock,fetch,startup:async()=>{},native,sessions:keeper,error:()=>{}});
  expect(exit).toBe(0);
  expect(native).toHaveBeenCalledOnce();
  expect(existsSync(path)).toBe(false);
 };
 const firstToken='body_'+'c'.repeat(64);
 f.db.insert(s.tokens).values({fingerprint:hash(firstToken),label:'First worker',kind:'agent',agent:'art',job:'job',createdAt:now()}).run();
 await run('job','box',firstToken,false);
 const stored=f.db.select().from(s.conversationSessions).get();
 expect(stored?.keepUntil).toBe(expiry);
 await f.send('Continue','continue');
 await old.takeAndAccept(async()=>{});
 f.db.update(s.jobs).set({heardAt:new Date(f.clock.now()-SILENCE_MS-1).toISOString()}).where(eq(s.jobs.id,'job')).run();
 jobs.sweep();
 const retry=f.db.select().from(s.jobs).where(eq(s.jobs.retryOf,'job')).get()!;
 f.clock.advance(Date.parse(retry.retryAt!)-f.clock.now());
 const [firstBox]=f.db.select().from(s.boxes).all();
 f.db.insert(s.boxes).values({...firstBox,id:'backup',name:'Backup'}).run();
 expect(jobs.claim(retry.id,'backup')).toBeDefined();
 f.db.update(s.jobs).set({harness:'claude'}).where(eq(s.jobs.id,retry.id)).run();
 jobs.started(retry.id,'backup','fixture');
 const token='body_'+'d'.repeat(64);
 f.db.insert(s.tokens).values({fingerprint:hash(token),label:'Replacement',kind:'agent',agent:'art',job:retry.id,createdAt:now()}).run();
 expect((await f.call('session',{retention:true},'read',raw.body)).status).toBeGreaterThanOrEqual(400);
 const restored=await f.call('session',{retention:true},'restore',token);
 expect(await restored.json()).toMatchObject({ok:true,value:{session:{session,keepUntil:expiry}}});
 await run(retry.id,'backup',token,true);
});
