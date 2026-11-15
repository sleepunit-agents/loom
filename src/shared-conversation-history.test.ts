/** Fresh native bodies get bounded retained dialogue through existing take only. */
import {afterEach,expect,it,vi} from 'vitest';
import {eq,and} from 'drizzle-orm';
import {bodyFixture,bodyCredentials as raw,credentialHash as hash} from '../test/fixtures/conversation-body.js';
import {bodyConversationClient,bodyMailContext} from './runtime/conversation-client.js';
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
  f.db.insert(s.jobs).values({...old,id:'fresh-job',state:'running'}).run();f.db.update(s.conversations).set({job:'fresh-job'}).where(eq(s.conversations.id,f.thread.conversation)).run();
  f.db.insert(s.tokens).values({fingerprint:hash(token),label:'Fictional fresh body',kind:'agent',agent:'art',job:'fresh-job',createdAt:new Date(f.clock.now()).toISOString()}).run();
 });
 const native=vi.fn(async(_job:unknown,context:string)=>{const value=JSON.parse(context);expect(value.input).toBe('Do that again');expect(value.history.map((line:{words:string})=>line.words)).toEqual(['PRIOR PERSON DIALOGUE','PRIOR AGENT REPLY']);expect(value.history.map((line:{sender:string})=>line.sender)).toEqual(['alice','art']);return{text:'New answer',model:'fixture',actions:[]};});
 const job={id:'fresh-job',box:'box',agent:'art',conversation:f.thread.conversation,thread:f.thread.id,model:'fixture',account:'fictional',harness:'claude' as const,brief:'',house:{repository:'fiction',file:'Housefile',branch:'next'}};
 expect(await bodyProgram({args:['config'],read:async()=>JSON.stringify({command:'/fictional/claude',cwd:'/fictional'}),stdin:async()=>Buffer.from(JSON.stringify({job,build:'fixture',bootstrap:{origin:'https://loom.invalid',job:'fresh-job',token}})),env:{},signal:new AbortController().signal,clock:f.clock,fetch:async(url,init)=>f.root.http.request(new Request(url,init)),startup:async()=>{},native,error:()=>{}})).toBe(0);
 expect(native).toHaveBeenCalledOnce();expect(f.db.select().from(s.messages).all().slice(0,2)).toEqual(beforeMessages.slice(0,2));
 for(const table of [s.inbox,s.jobs,s.operationResults])for(const words of ['PRIOR PERSON DIALOGUE','PRIOR AGENT REPLY'])expect(JSON.stringify(f.db.select().from(table).all())).not.toContain(words);
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
