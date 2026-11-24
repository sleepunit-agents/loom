import Database from 'better-sqlite3';
import {eq} from 'drizzle-orm';
import {afterEach,expect,it,vi} from 'vitest';
import {bodyCredentials,bodyFixture,credentialHash} from '../test/fixtures/conversation-body.js';
import {FakeClock} from './core/clock.js';
import {dataDatabase} from './core/data/database.js';
import * as s from './core/data/schema.js';
import {bodyConversationClient} from './runtime/conversation-client.js';
import {reviewPlace} from './core/conversations/review-place.js';
import {bodyProgramTools} from './runtime/body-program-tools.js';
import {Jobs} from './runtime/jobs.js';
import {sharedRoot} from './shared-root.js';

const cleanup:(()=>unknown|Promise<unknown>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});

it.each(['codex','role','expired'] as const)('rechecks an overnight %s handoff after reopening the database',async kind=>{
 const workRoles=[{agent:'art',id:'research',description:'Compare fictional reports.',models:['reviewer']}];
 const modelRoles=()=>[{model:'reviewer',provider:'openai',harness:'codex' as const,series:'reviewer'}];
 const f=await bodyFixture(cleanup,{workRoles,modelRoles});
 const due=f.clock.now()+(kind==='expired'?48:12)*3600_000, notBefore=new Date(due).toISOString();
 const request={...(kind==='role'?{role:'research'}:{harness:'codex'}),clientId:'night',label:'Morning report',words:'PRIVATE NIGHT BRIEF',notBefore};
 await f.send('Bring the result back here tomorrow','request');
 expect((await f.call('handoff',{...request,notBefore:new Date(due+30*86400_000).toISOString()},'expired')).status).toBe(400);
 const issue=await f.call('handoff',request,'schedule');
 expect(issue.status,await issue.clone().text()).toBe(200);
 const saved=(await issue.json()).value,child=saved.conversation;
 expect((await (await f.call('handoff',request,'second-receipt')).json()).value).toEqual(saved);
 expect((await f.call('handoff',{...request,notBefore:new Date(due+1000).toISOString()},'different-time')).status).toBe(409);
 expect((await (await f.call('handoffStatus',{conversation:child},'status')).json()).value).toEqual({jobState:null,resultDelivered:false,notBefore});
 expect(new Jobs(f.db,()=>new Date(f.clock.now()).toISOString()).admit(child)).toBeUndefined();

 f.db.update(s.inbox).set({state:'done',job:'job'}).where(eq(s.inbox.conversation,f.thread.conversation)).run();
 f.db.update(s.jobs).set({state:'done',endedAt:new Date(f.clock.now()).toISOString()}).where(eq(s.jobs.id,'job')).run();
 await f.root.close();
 const bytes=f.db.$client.serialize();
 expect(bytes.includes(Buffer.from(request.words))).toBe(false);
 const client=new Database(bytes);cleanup.push(()=>client.close());
 const clock=new FakeClock(due-60_000),now=()=>new Date(clock.now()).toISOString(),db=dataDatabase(client,now);
 const root=sharedRoot({db,clock,workRoles,modelRoles,originAllowed:()=>true,commsKey:f.key,reportError:error=>{throw error;}});
 cleanup.push(()=>root.close());
 db.insert(s.agentModels).values({agent:'art',model:'reviewer',position:0}).run();
 db.insert(s.agentRunSettings).values({agent:'art',houseRepository:'fixture',houseFile:'Housefile',houseBranch:'main',nestedContainers:false,gpu:false}).run();
 db.insert(s.agentBoxes).values({agent:'art',box:'box',position:0}).run();
 db.update(s.boxes).set({hostsAny:true,lastSeenAt:now()}).run();
 db.insert(s.modelAccounts).values({id:'paid',owner:'alice',provider:'openai',label:'Fixture',hasRoom:kind!=='expired'}).run();
 db.insert(s.modelAccountWindows).values({account:'paid',window:'week',usage:0.1,usageReadAt:now(),resetsAt:new Date(due+86400_000).toISOString(),durationMs:604800000}).run();
 db.insert(s.modelAccountBoxes).values({account:'paid',box:'box'}).run();
 const post=async(path:string,token:string,id:string,input:unknown)=>root.http.request('/api/'+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({id,input})});
 const poll=async(id:string)=>(await (await post('runtime/next',bodyCredentials.runner,id,{execution:'container',reviewResults:true,slots:3})).json()).value;
 clock.advance(59_999);
 expect(await poll('early')).toBeNull();
 expect(db.select().from(s.jobs).where(eq(s.jobs.conversation,child)).all()).toHaveLength(0);
 clock.advance(60_001);
 if(kind==='expired'){
  expect(await poll('no-capacity')).toBeNull();
  expect(db.select().from(s.jobs).where(eq(s.jobs.conversation,child)).get()?.state).toBe('queued');
  db.insert(s.household).values({singleton:1,commsDays:1}).onConflictDoUpdate({target:s.household.singleton,set:{commsDays:1}}).run();
  db.update(s.modelAccounts).set({hasRoom:true}).where(eq(s.modelAccounts.id,'paid')).run();
  expect(await poll('capacity-after-expiry')).toBeNull();
  expect(db.select().from(s.jobs).where(eq(s.jobs.conversation,child)).get()?.endedNote).toBe('The scheduled handoff brief expired.');
  const message=await vi.waitFor(()=>{
   const result=db.select().from(s.messages).where(eq(s.messages.clientId,'review:'+child)).get();
   expect(result).toBeDefined();return result!;
  });
  expect(message.thread).toBe(f.thread.id);
  expect(await f.key.open(message.words!)).toContain('The scheduled handoff brief expired.');
  return;
 }
 const assignment=await poll('due');
 expect(assignment).toMatchObject({conversation:child,review:true,model:'reviewer'});
 const token='body_'+'d'.repeat(64);
 expect((await post('runtime/started',bodyCredentials.runner,'start',{job:assignment.id,build:'fixture'})).status).toBe(200);
 db.insert(s.tokens).values({fingerprint:credentialHash(token),kind:'agent',agent:'art',job:assignment.id,label:'Fixture child',createdAt:now()}).run();
 const original=db.select().from(s.jobs).where(eq(s.jobs.id,'job')).get()!;
 db.insert(s.jobs).values({...original,id:'holder',state:'running',endedAt:null,heardAt:now()}).run();
 const result={clientId:'final',words:'PRIVATE NIGHT RESULT',model:'reviewer'};
 const sdk=bodyConversationClient({url:'https://loom.invalid',token,job:assignment.id,conversation:child,
  signal:new AbortController().signal,clock,fetch:async(url,init)=>root.http.request(new Request(String(url),init))});
 cleanup.push(()=>sdk.close());
 expect((await sdk.takeAndAccept(async item=>{expect(item.words).toContain(request.words);})).accepted).toBe(1);
 await sdk.reply(result);
 await sdk.reply(result);
 const replies=db.select().from(s.messages).where(eq(s.messages.kind,'reply')).all();
 expect(replies).toHaveLength(1);
 expect(replies[0]).toMatchObject({thread:f.thread.id,run:assignment.id});
 expect(await f.key.open(replies[0].words!)).toBe(result.words);
 expect(db.select().from(s.inbox).where(eq(s.inbox.sourceId,'review:'+child)).all()).toHaveLength(1);
 expect(db.select().from(s.jobs).where(eq(s.jobs.id,'holder')).get()?.state).toBe('running');
});

it('recognizes the same scheduled request from the coordinator’s automatic retry',async()=>{
 const f=await bodyFixture(cleanup);
 const now=()=>new Date(f.clock.now()).toISOString();
 const request={harness:'codex',clientId:'same',label:'Report',words:'Fixture brief',notBefore:new Date(f.clock.now()+3600_000).toISOString()};
 await f.send('Schedule this','retry-origin');
 expect((await f.call('handoff',{...request,notBefore:request.notBefore.replace('Z','9Z')},'precision')).status).toBe(400);
 const issued=await f.call('handoff',request,'original');
 expect(issued.status).toBe(200);
 const saved=(await issued.json()).value;
 f.db.update(s.inbox).set({job:'job'}).where(eq(s.inbox.conversation,f.thread.conversation)).run();
 const successor=new Jobs(f.db,now).finish('job','box',1).retry!;
 expect(successor.retryOf).toBe('job');
 f.db.update(s.jobs).set({state:'running',box:'box'}).where(eq(s.jobs.id,successor.id)).run();
 const token='body_'+'e'.repeat(64);
 f.db.insert(s.tokens).values({fingerprint:credentialHash(token),kind:'agent',agent:'art',job:successor.id,label:'Retry',createdAt:now()}).run();
 const {notBefore:_time,...immediate}=request;
 expect((await f.call('handoff',immediate,'omit-time',token)).status).toBe(409);
 expect(f.db.select().from(s.jobs).where(eq(s.jobs.conversation,saved.conversation)).all()).toHaveLength(0);
 const resumed=await f.call('handoff',request,'resumed',token);
 expect(resumed.status,await resumed.clone().text()).toBe(200);
 expect((await resumed.json()).value).toEqual(saved);
 expect(f.db.select().from(s.conversations).where(eq(s.conversations.venue,'handoff')).all()).toHaveLength(1);
});

it('withdraws an unadmitted scheduled brief only from the private owner thread that requested it',async()=>{
 const f=await bodyFixture(cleanup);
 await f.send('Schedule a fictional check','owner');
 const notBefore=new Date(f.clock.now()+60*60_000).toISOString();
 const request={harness:'codex',clientId:'tomorrow',label:'Fictional check',words:'Compare garden notes.',notBefore};
 const issued=await f.call('handoff',request,'schedule');
 expect(issued.status).toBe(200);
 const handle=(await issued.json()).value;
 const input={conversation:handle.conversation};
 const cancel=(id:string,token=bodyCredentials.body)=>f.call('handoffCancel',input,id,token);
 expect((await cancel('member',bodyCredentials.member)).status).toBe(403);
 const foreign=f.root.services.comms!.threads.open({member:'alice',agent:'art',project:'pond',title:'Other thread'});
 const original=f.db.select().from(s.jobs).where(eq(s.jobs.id,'job')).get()!;
 f.db.insert(s.jobs).values({...original,id:'other-job',conversation:foreign.conversation,state:'done',endedAt:notBefore}).run();
 const other=f.root.services.conversations.open({agent:'art',member:'alice',project:'pond',venue:'handoff',place:reviewPlace('other-job','brief'),label:'Other child',direct:false,handoffNotBefore:notBefore});
 expect((await f.call('handoffCancel',{conversation:other.id},'wrong-thread')).status).toBe(403);
 const tools=bodyProgramTools({url:'https://loom.invalid',token:bodyCredentials.body,signal:new AbortController().signal,clock:f.clock,fetch:async(url,init)=>f.root.http.request(new Request(String(url),init)),onStop:()=>{},onStatus:()=>{}});
 cleanup.push(()=>tools.close());
 const withdrawn=await tools.call('loom_command',{operation:'conversation.handoffCancel',input,id:'withdraw'});
 expect(withdrawn.isError,withdrawn.content[0].text).not.toBe(true);
 expect(JSON.parse(withdrawn.content[0].text).value).toEqual({cancelled:true});
 for(const id of ['withdraw','confirm-again']){
  const response=await cancel(id);
  expect(response.status,await response.clone().text()).toBe(200);
  expect((await response.json()).value).toEqual({cancelled:true});
 }
 expect((await (await f.call('handoffStatus',input,'status')).json()).value).toEqual({jobState:null,resultDelivered:false,notBefore,cancelled:true});
 expect((await (await f.call('handoff',request,'recover')).json()).value).toEqual(handle);
 const second=await f.call('handoff',{...request,clientId:'outside-window'},'later');
 const queued=(await second.json()).value;
 f.db.insert(s.agentModels).values({agent:'art',model:'fixture',position:0}).run();
 f.db.insert(s.agentRunSettings).values({agent:'art',houseRepository:'fixture',houseFile:'Housefile',houseBranch:'main',gpu:false,nestedContainers:false}).run();
 const restored=new Database(f.db.$client.serialize());
 try {
  const due=()=>notBefore;
  const db=dataDatabase(restored,due);
  const root=sharedRoot({db,clock:f.clock,originAllowed:()=>true,commsKey:f.key});
  try {
   const status=await root.http.request('/api/conversation/handoffStatus',{method:'POST',headers:{authorization:'Bearer '+bodyCredentials.body,'content-type':'application/json'},body:JSON.stringify({id:'reopened',input})});
   expect((await status.json()).value).toEqual({jobState:null,resultDelivered:false,notBefore,cancelled:true});
   const jobs=new Jobs(db,due);
   expect(jobs.admit(handle.conversation)).toBeUndefined();
   expect(jobs.admit(queued.conversation)?.state).toBe('queued');
  }finally{await root.close();}
  expect(db.select().from(s.jobs).where(eq(s.jobs.conversation,handle.conversation)).all()).toHaveLength(0);
  expect(db.select().from(s.inbox).where(eq(s.inbox.id,handle.item)).get()?.state).toBe('resolved');
 }finally{restored.close();}
 const admitted=new Jobs(f.db,()=>notBefore).admit(queued.conversation);
 expect(admitted?.state).toBe('queued');
 expect((await f.call('handoffCancel',{conversation:queued.conversation},'too-late')).status).toBe(409);
 expect(f.db.select().from(s.inbox).where(eq(s.inbox.id,queued.item)).get()).toMatchObject({state:'waiting',job:admitted?.id});
 // A failed attempt can release waiting mail; it still has an admission history.
 f.db.update(s.jobs).set({state:'failed',endedAt:notBefore}).where(eq(s.jobs.id,admitted!.id)).run();
 f.db.update(s.inbox).set({job:null}).where(eq(s.inbox.id,queued.item)).run();
 expect((await f.call('handoffCancel',{conversation:queued.conversation},'already-admitted')).status).toBe(409);
 f.db.update(s.threads).set({archivedAt:notBefore}).where(eq(s.threads.id,f.thread.id)).run();
 expect((await cancel('withdraw')).status).toBe(403);
});
