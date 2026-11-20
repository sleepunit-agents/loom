import {afterEach,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import * as s from './core/data/schema.js';
import {bodyFixture,bodyCredentials as raw} from '../test/fixtures/conversation-body.js';
import {bodyConversationClient,bodyMailContext} from './runtime/conversation-client.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
const take=(f:Awaited<ReturnType<typeof bodyFixture>>)=>f.root.http.request('/api/conversation/take',{method:'POST',headers:{authorization:'Bearer '+raw.body,'content-type':'application/json'},body:JSON.stringify({input:{}})});
const question={words:'PRIVATE QUESTION',why:'PRIVATE WHY',ifYes:'PRIVATE YES OUTCOME',ifNo:'PRIVATE NO OUTCOME',link:'https://example.invalid/private'};
async function fixture(earlier=false){
 const f=await bodyFixture(clean);if(earlier)expect((await f.send('EARLIER PRIVATE','earlier')).status).toBe(200);
 const created=await f.call('digest',{summary:'Question',question:{...question,to:'alice',answers:'yes-no'}},'ask');expect(created.status).toBe(200);
 const q=f.db.select().from(s.inbox).where(eq(s.inbox.id,(await created.json()).value.item)).get()!;
 const response=await f.root.http.request('/api/inbox/answer',{method:'POST',headers:{cookie:'loom_ui='+raw.memberCookie,'content-type':'application/json'},body:JSON.stringify({input:{item:q.id,answer:'yes'},id:'answer'})});
 expect(response.status).toBe(200);
 const answer=f.db.select().from(s.inbox).all().find(row=>row.source==='answer')!;
 return {...f,q,answer};
}
it('delivers the retained private question and outcomes to the actual receiving SDK without storing another copy',async()=>{
 const f=await fixture(),abort=new AbortController(),beforeMessages=f.db.select().from(s.messages).all();
 const client=bodyConversationClient({url:'http://127.0.0.1/',token:raw.body,job:'job',conversation:f.thread.conversation,signal:abort.signal,clock:f.clock,fetch:async(url,init)=>f.root.http.request(new Request(url,init))});clean.push(()=>client.close());
 let context='';await client.takeAndAccept(async item=>{expect(item.question).toEqual(question);expect(item.words).toBe('yes');expect(item.verdict).toBe('yes');context=bodyMailContext(item)!;expect(Object.isFrozen(item.question)).toBe(true);});
 expect(JSON.parse(context)).toEqual({question,answer:'yes',verdict:'yes'});
 expect(f.db.select().from(s.messages).all()).toEqual(beforeMessages);
 // Received is not settled: the mail is done only when the body says it is dealt with.
 expect(f.db.select().from(s.inbox).where(eq(s.inbox.id,f.answer.id)).get()?.state).toBe('taken');await client.settle();
 expect(f.db.select().from(s.inbox).where(eq(s.inbox.id,f.answer.id)).get()?.state).toBe('done');
 for(const table of [s.inbox,s.jobs,s.operationResults])expect(JSON.stringify(f.db.select().from(table).all())).not.toContain('PRIVATE');
});
it('uses the question deadline for unread original and cloned responses, then preserves the independently retained answer',async()=>{
 const f=await fixture(),questionDeadline=f.clock.now()+1000,answerDeadline=f.clock.now()+5000;
 f.root.writes.run(()=>{
  f.db.update(s.messages).set({keepUntil:new Date(questionDeadline).toISOString()}).where(eq(s.messages.seq,f.q.messageSeq!)).run();
  f.db.update(s.messages).set({keepUntil:new Date(answerDeadline).toISOString()}).where(eq(s.messages.seq,f.answer.messageSeq!)).run();
 });
 const response=await take(f),wrapped=new Response(response.body,response),copy=wrapped.clone();
 expect(response.status).toBe(200);
 f.clock.advance(1000);
 await expect(wrapped.text()).rejects.toThrow();await expect(copy.text()).rejects.toThrow();
 const retry=await(await take(f)).json();
 expect(retry.value.items[0]).toMatchObject({words:'yes',keepUntil:new Date(answerDeadline).toISOString()});
 expect(retry.value.items[0].question).toBeUndefined();
});
it('keeps Dim delivery to its first line without expanding the private question',async()=>{
 const f=await fixture();f.root.writes.run(()=>f.db.update(s.inbox).set({volume:'dim'}).where(eq(s.inbox.id,f.answer.id)).run());
 const value=await(await take(f)).json();expect(value.value.items[0].words).toBe('yes');expect(value.value.items[0].question).toBeUndefined();
});
it('does not follow an answer source ID to a question in another conversation',async()=>{
 const f=await fixture(),other=f.root.services.comms!.threads.open({member:'bob',agent:'mark',title:'Other'});
 const q=await f.root.services.comms!.ask(other.id,'mark','other',{words:'BOB PRIVATE',answers:'yes-no'});
 f.root.writes.run(()=>f.db.update(s.inbox).set({sourceId:q.inboxItem}).where(eq(s.inbox.id,f.answer.id)).run());
 const value=await(await take(f)).json();expect(JSON.stringify(value)).not.toContain('BOB PRIVATE');expect(value.value.items[0].question).toBeUndefined();
});
it('withdraws private assignment during the question decrypt before claiming answer mail',async()=>{
 const f=await fixture();let opens=0;
 f.openGate(async()=>{if(++opens===2)f.root.writes.run(()=>f.db.delete(s.memberAgents).run());});
 const response=await take(f);expect(response.status).toBe(403);expect(await response.text()).not.toContain('PRIVATE');
 expect(opens).toBe(2);expect(f.db.select().from(s.inbox).where(eq(s.inbox.id,f.answer.id)).get()?.state).toBe('waiting');
});
it('bounds asynchronous SDK acceptance by the included question deadline and retries without expired context',async()=>{
 const f=await fixture(),deadline=f.clock.now()+1000,abort=new AbortController();
 f.root.writes.run(()=>f.db.update(s.messages).set({keepUntil:new Date(deadline).toISOString()}).where(eq(s.messages.seq,f.q.messageSeq!)).run());
 const client=bodyConversationClient({url:'http://127.0.0.1/',token:raw.body,job:'job',conversation:f.thread.conversation,signal:abort.signal,clock:f.clock,fetch:async(url,init)=>f.root.http.request(new Request(url,init))});clean.push(()=>client.close());
 let entered!:()=>void,release!:()=>void,signal:AbortSignal|undefined;
 const ready=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
 const pending=client.takeAndAccept(async(item,sinkSignal)=>{expect(item.question).toEqual(question);signal=sinkSignal;entered();await gate;});
 try{await ready;f.clock.advance(1000);await expect(pending).rejects.toThrow();expect(signal?.aborted).toBe(true);expect(f.db.select().from(s.inbox).where(eq(s.inbox.id,f.answer.id)).get()?.state).toBe('taken');}
 finally{release();await pending.catch(()=>{});}
 await client.takeAndAccept(async item=>{expect(item.words).toBe('yes');expect(item.question).toBeNull();});
 // Received is not settled: the mail is done only when the body says it is dealt with.
 expect(f.db.select().from(s.inbox).where(eq(s.inbox.id,f.answer.id)).get()?.state).toBe('taken');await client.settle();
 expect(f.db.select().from(s.inbox).where(eq(s.inbox.id,f.answer.id)).get()?.state).toBe('done');
});
async function secondQuestion(f:Awaited<ReturnType<typeof fixture>>){
 const created=await f.call('digest',{summary:'Second',question:{...question,words:'SECOND QUESTION',to:'alice',answers:'yes-no'}},'second');
 expect(created.status).toBe(200);const id=(await created.json()).value.item as string;
 expect((await f.root.http.request('/api/inbox/answer',{method:'POST',headers:{cookie:'loom_ui='+raw.memberCookie,'content-type':'application/json'},body:JSON.stringify({input:{item:id,answer:'yes'},id:'second-answer'})})).status).toBe(200);
}
it.each(['agent','member','project','recipient','answerer','author','author-kind','source','linked','question-binding','question-kind','question-sender','answer-kind','answer-sender'] as const)('does not expand question context with mismatched %s',async change=>{
 const f=await fixture();let opens=0;f.openGate(async()=>{opens++;});
 f.root.writes.run(()=>{
  if(change==='agent')f.db.update(s.inbox).set({agent:'mark'}).where(eq(s.inbox.id,f.q.id)).run();
  if(change==='member')f.db.update(s.inbox).set({member:'bob'}).where(eq(s.inbox.id,f.q.id)).run();
  if(change==='project')f.db.update(s.inbox).set({project:'other'}).where(eq(s.inbox.id,f.q.id)).run();
  if(change==='recipient')f.db.update(s.inbox).set({to:'bob'}).where(eq(s.inbox.id,f.q.id)).run();
  if(change==='answerer')f.db.update(s.inbox).set({answeredBy:'bob'}).where(eq(s.inbox.id,f.q.id)).run();
  if(change==='author')f.db.update(s.inbox).set({fromId:'mark'}).where(eq(s.inbox.id,f.q.id)).run();
  if(change==='author-kind')f.db.update(s.inbox).set({fromKind:'person'}).where(eq(s.inbox.id,f.q.id)).run();
  if(change==='source')f.db.update(s.inbox).set({source:'approval'}).where(eq(s.inbox.id,f.q.id)).run();
  if(change==='linked')f.db.update(s.inbox).set({waitsOnKind:'task',waitsOnId:'unavailable-task'}).where(eq(s.inbox.id,f.q.id)).run();
  if(change==='question-binding')f.db.update(s.inbox).set({messageSeq:f.answer.messageSeq}).where(eq(s.inbox.id,f.q.id)).run();
  if(change==='question-kind')f.db.update(s.messages).set({kind:'reply'}).where(eq(s.messages.seq,f.q.messageSeq!)).run();
  if(change==='question-sender')f.db.update(s.messages).set({sender:'mark'}).where(eq(s.messages.seq,f.q.messageSeq!)).run();
  if(change==='answer-kind')f.db.update(s.messages).set({kind:'reply'}).where(eq(s.messages.seq,f.answer.messageSeq!)).run();
  if(change==='answer-sender')f.db.update(s.messages).set({sender:'bob'}).where(eq(s.messages.seq,f.answer.messageSeq!)).run();
 });
 const response=await take(f);expect(response.status).toBe(200);const value=await response.json();
 expect(value.value.items[0]).toMatchObject({words:'yes'});expect(value.value.items[0].question).toBeUndefined();expect(opens).toBe(1);
});
it('omits earlier expired/swept context during a later decrypt without withholding either answer',async()=>{
 const f=await fixture();await secondQuestion(f);const deadline=f.clock.now()+1000;
 f.root.writes.run(()=>f.db.update(s.messages).set({keepUntil:new Date(deadline).toISOString()}).where(eq(s.messages.seq,f.q.messageSeq!)).run());
 let opens=0;f.openGate(async()=>{if(++opens===4){f.clock.advance(1000);f.root.writes.run(()=>f.db.update(s.messages).set({words:null}).where(eq(s.messages.seq,f.q.messageSeq!)).run());}});
 const response=await take(f);expect(response.status).toBe(200);const value=await response.json();
 expect(opens).toBe(4);expect(value.value.items).toHaveLength(2);
 expect(value.value.items[0]).toMatchObject({words:'yes'});expect(value.value.items[0].question).toBeUndefined();
 expect(value.value.items[1]).toMatchObject({words:'yes',question:{words:'SECOND QUESTION'}});
});
it.each(['metadata','cipher','binding'] as const)('rechecks earlier question %s while a later question decrypts',async change=>{
 const f=await fixture();await secondQuestion(f);let opens=0;
 f.openGate(async()=>{if(++opens===4)f.root.writes.run(()=>{
  if(change==='metadata')f.db.update(s.inbox).set({sourceId:'changed-source'}).where(eq(s.inbox.id,f.q.id)).run();
  if(change==='cipher')f.db.update(s.messages).set({words:Buffer.from('changed-ciphertext')}).where(eq(s.messages.seq,f.q.messageSeq!)).run();
  if(change==='binding')f.db.update(s.inbox).set({member:'bob'}).where(eq(s.inbox.id,f.q.id)).run();
 });});
 const response=await take(f);expect(opens).toBe(4);
 if(change==='binding'){expect(response.status).toBe(200);const value=await response.json();expect(value.value.items[0].question).toBeUndefined();expect(value.value.items[0].words).toBe('yes');}
 else{expect(response.status).toBe(503);expect(await response.text()).not.toContain('PRIVATE');expect(f.db.select().from(s.inbox).where(eq(s.inbox.id,f.answer.id)).get()?.state).toBe('waiting');}
});

it.each(['cipher','key'] as const)('delivers a valid answer without unavailable question %s',async change=>{
 const f=await fixture();let opens=0;
 if(change==='cipher')f.root.writes.run(()=>f.db.update(s.messages).set({words:Buffer.from('unreadable-question')}).where(eq(s.messages.seq,f.q.messageSeq!)).run());
 else f.openGate(async()=>{if(++opens===2)throw Error('Fictitious question decryption unavailable');});
 const response=await take(f);expect(response.status).toBe(200);const value=await response.json();
 expect(value.value.items[0]).toMatchObject({words:'yes',verdict:'yes'});expect(value.value.items[0].question).toBeUndefined();
 expect(JSON.stringify(value)).not.toContain('PRIVATE');if(change==='key')expect(opens).toBe(2);
});

it('drops only expired question context before a later SDK acceptance and delivers its retained answer',async()=>{
 const f=await fixture(true),deadline=f.clock.now()+1000,abort=new AbortController();
 f.root.writes.run(()=>f.db.update(s.messages).set({keepUntil:new Date(deadline).toISOString()}).where(eq(s.messages.seq,f.q.messageSeq!)).run());
 const client=bodyConversationClient({url:'http://127.0.0.1/',token:raw.body,job:'job',conversation:f.thread.conversation,signal:abort.signal,clock:f.clock,fetch:async(url,init)=>f.root.http.request(new Request(url,init))});clean.push(()=>client.close());
 let entered!:()=>void,release!:()=>void,answerSeen=false;
 const ready=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
 const pending=client.takeAndAccept(async item=>{
  if(item.source==='thread'){expect(item.words).toBe('EARLIER PRIVATE');entered();await gate;}
  else{expect(item.words).toBe('yes');expect(item.question).toBeNull();expect(item.questionKeepUntil).toBeNull();answerSeen=true;}
 });
 try{await ready;f.clock.advance(1000);release();expect(await pending).toMatchObject({accepted:2});}
 finally{release();await pending.catch(()=>{});}
 expect(answerSeen).toBe(true);await client.settle();expect(f.db.select().from(s.inbox).where(eq(s.inbox.id,f.answer.id)).get()?.state).toBe('done');
});

it.each(['json','words','outcome'] as const)('omits an unavailable decoded question %s without losing its answer',async change=>{
 const f=await fixture(),text=change==='json'?'not-json':JSON.stringify({...question,...(change==='words'?{words:42}:{ifYes:42})}),cipher=await f.key.seal(text);
 f.root.writes.run(()=>f.db.update(s.messages).set({words:cipher}).where(eq(s.messages.seq,f.q.messageSeq!)).run());
 const response=await take(f);expect(response.status).toBe(200);const value=await response.json();
 expect(value.value.items[0].words).toBe('yes');expect(value.value.items[0].question).toBeUndefined();
});
