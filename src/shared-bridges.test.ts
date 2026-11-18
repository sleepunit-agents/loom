import Database from 'better-sqlite3';
import { setupCall } from '../test/fixtures/setup-call.js';
import {afterEach,expect,it,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {FakeClock} from './core/clock.js';
import {createDataSchema} from './core/data/database.js';
import {approvals,agentModels,agentRunSettings,inboxRefs,agentPeople,conversationSessions,triggers,members,agents,secrets,boxes,jobs,tokens,bridgeConnections,bridgeChannels,bridgePeople,bridgeIncoming,bridgeSends,bridgeSendParts,conversations,inbox,secretChanges,turns,projects,memberAgents} from './core/data/schema.js';
import {sharedRoot} from './shared-root.js';
import type {bridgeSlackSocket} from './pieces/bridges/slack-socket.js';
import {wordsKey} from './pieces/comms/crypto.js';
import {SESSION_BYTES} from './core/conversations/session-limit.js';
import {bodyConversationClient,bodyMailContext} from './runtime/conversation-client.js';
import {Jobs} from './runtime/jobs.js';
import {workerPolicy} from './runtime/body-policy.js';
import {CHAIN_NOTICE_EVERY,NOTES_NOTICE_EVERY,PLACE_TRIGGERS_NOTICE_EVERY,PRIVATE_PLACE_REFUSAL} from './shared-place-mail.js';
import {SCHEDULE_ASKED,WOKEN_BY_MAIL_REFUSAL,WORD_EVENT_REFUSAL,WORD_PART_REFUSAL} from './shared-place-triggers.js';
import {COME_BACK_NOTICE_EVERY,REFIRE_REFUSAL,RUN_NOW_REFUSAL,WORD_ASKER_REFUSAL,WORD_FILE_REFUSAL,repeats} from './shared-place-triggers.js';
import {triggerLog} from './core/data/schema.js';
import {mayReviewReply} from './shared-bridge-commands.js';
import {jobWord,jobRoom,reportsTo,placeClosed,selfHandoff} from './shared-place-mail.js';
import {expirePrivateBridgeWords} from './core/conversations/private-bridge-words.js';
import {bridgeChannelFilters} from './core/data/schema.js';
const clean:(()=>unknown|Promise<unknown>)[]=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
const token={body:'a'.repeat(64),other:'b'.repeat(64),owner:'c'.repeat(64)};
function fixture(effectsAllowed:()=>boolean=()=>true,comms=false){
 const client=new Database(':memory:');clean.push(()=>client.close());const db=createDataSchema(client),clock=new FakeClock(),at=new Date(clock.now()).toISOString();
 db.insert(members).values({id:'owner',role:'owner',joinedAt:at}).run();db.insert(agents).values({id:'art',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();db.insert(boxes).values({id:'box',name:'Box',owner:'owner',sameMachineAsLoom:false,hostsAny:false,reportOnly:false,alwaysOn:false,enrolledAt:at}).run();db.insert(secrets).values(['TOKEN','APP'].map(name=>({name,description:'',changedAt:at,changedBy:'owner'}))).run();
 db.insert(bridgeConnections).values({id:'connection',platform:'slack',workspace:'TWORK',botUser:'UBOT',agent:'art',tokenSecret:'TOKEN',appSecret:'APP',enabled:true,state:'disconnected',stateAt:at}).run();db.insert(bridgeChannels).values({platform:'slack',workspace:'TWORK',channel:'CROOM',answers:'art',botsMayTalk:false}).run();
 // The agent's owner has placed the outside account that writes: a stranger's message is not taken (incoming.ts).
 db.insert(agentPeople).values({agent:'art',person:JSON.stringify(['slack','TWORK','UUSER']),tier:2}).run();
 const source={generation:vi.fn(async()=> '12345678-1234-4234-8234-123456789abc'),read:vi.fn(async(name:string)=>Buffer.from('synthetic:'+name))},transports:Parameters<typeof bridgeSlackSocket>[0][]=[],closed=vi.fn(async()=>{}),slack:typeof bridgeSlackSocket=options=>{transports.push(options);options.state?.('connected');return {close:closed};};
 const request=vi.fn<typeof fetch>(async url=>{
  if(String(url).endsWith('auth.test'))return Response.json({ok:true,user_id:'UBOT',team_id:'TWORK',bot_id:'BBOT'});
  if(String(url).endsWith('bots.info'))return Response.json({ok:true,bot:{id:'BBOT',user_id:'UBOT',app_id:'AAPP',deleted:false}});
  if(String(url).endsWith('conversations.info'))return Response.json({ok:true,channel:{id:'CROOM',context_team_id:'TWORK',is_channel:true}});
  if(String(url).endsWith('chat.postMessage'))return Response.json({ok:true,channel:'CROOM',ts:'1794432000.000009'});throw Error('Unexpected endpoint');
 });
 const admitted=vi.fn(()=>true),root=sharedRoot({db,clock,originAllowed:()=>true,reportError:()=>{},tempo:{admit:admitted},...(comms?{commsKey:wordsKey('AGE-SECRET-KEY-10SC5M7Q03WKNXKZHXZKY6JWHDV8MP7DS8USNSE64C674RN6TDGDSEKQNMR')}:{}),bridges:{source,effectsAllowed,request,slack,discord:()=>({close:async()=>{}})}});clean.push(()=>root.close());
 for(const id of ['body','other'])db.insert(jobs).values({id,agent:'art',box:'box',title:'',brief:'',model:'test',state:'running',startedByKind:'agent',startedBy:'art',houseRepository:'',houseFile:'',houseBranch:'',queuedAt:at}).run();
 for(const [id,value] of Object.entries(token))db.insert(tokens).values({fingerprint:createHash('sha256').update(value).digest('hex'),label:id,kind:id==='owner'?'owner':'agent',member:id==='owner'?'owner':null,agent:id==='owner'?null:'art',job:id==='owner'?null:id,createdAt:at}).run();
 const call=async(piece:string,operation:string,input:unknown,credential=token.body,id=randomUUID())=>{const response=setupCall(root,piece+'.'+operation,input,'owner')??await root.http.request('http://loom/api/'+piece+'/'+operation,{method:'POST',headers:{authorization:'Bearer '+credential,'content-type':'application/json'},body:JSON.stringify({id,input})});return {status:response.status,body:await response.json()};};
 const receive=async()=>{await root.services.bridges.daemon!.ready();await root.services.bridges.daemon!.idle();await transports.at(-1)!.receive({},Buffer.from(JSON.stringify({type:'events_api',envelope_id:'ack',payload:{type:'event_callback',event_id:'event',team_id:'TWORK',event:{type:'message',channel:'CROOM',user:'UUSER',text:'Hello',ts:'1794432000.000001'}}})));clock.advance(0);await root.services.bridges.daemon!.idle();return db.select().from(bridgeIncoming).get()!;};
 return {client,db,clock,root,source,transports,closed,request,call,receive,admitted};
}
it('mounts actual intake, committed Tempo admission, body reply door and current-credential network send',async()=>{
 const f=fixture();f.root.services.tempo.volume.setTimings({kind:'agent',id:'art'},{settleSeconds:0});const incoming=await f.receive();expect(f.db.select().from(inbox).get()?.conversation).toBe(incoming.conversation);expect(f.db.select().from(conversations).get()?.venue).toBe('slack');expect(f.admitted).toHaveBeenCalledOnce();
 f.root.writes.run(()=>{f.db.update(jobs).set({conversation:incoming.conversation}).where(eq(jobs.id,'body')).run();f.root.services.conversations.take(incoming.conversation!,'body');});
 const input={id:randomUUID(),incoming:incoming.id,text:'Reply',model:'observed',outcome:'progressed'},receipt=randomUUID();expect((await f.call('bridges','reply',input,token.other,receipt)).status).toBe(403);expect((await f.call('bridges','reply',input,token.owner,receipt)).status).toBe(403);expect((await f.call('bridges','reply',{...input,job:'other'})).status).toBe(400);
 expect((await f.call('bridges','reply',input,token.body,receipt)).status).toBe(200);await f.root.services.bridges.daemon!.idle();expect(f.db.select().from(bridgeSends).get()).toMatchObject({state:'sent'});expect(f.db.select().from(bridgeSendParts).all()).toMatchObject([{part:0,postedId:'1794432000.000009'}]);
 expect((await f.call('bridges','reply',input,token.body,receipt)).status).toBe(200);expect((await f.call('bridges','reply',input,token.body,randomUUID())).status).toBe(200);expect(f.request.mock.calls.filter(([url])=>String(url).endsWith('chat.postMessage'))).toHaveLength(1);expect(f.db.select().from(turns).all()).toMatchObject([{kind:'message'},{kind:'reply',run:'body',model:'observed',outcome:'progressed'}]);
});
it('retires actual sockets after committed owner disconnect and drains on root close',async()=>{
 const f=fixture();await f.receive();expect((await f.call('bridges','command',{action:'disconnect',id:'connection'},token.owner)).status).toBe(200);await f.root.services.bridges.daemon!.idle();expect(f.closed).toHaveBeenCalledOnce();await expect(f.transports[0].receive({},Buffer.from('{}'))).rejects.toThrow();await f.root.close();expect((await f.call('bridges','reply',{id:randomUUID(),incoming:'in',text:'Late'})).status).toBe(503);
});

it('invalidates sockets on committed credential audits but never on rolled-back writes',async()=>{
 const f=fixture();await f.receive();const old=f.transports[0],audit={id:randomUUID(),secret:'TOKEN',action:'replace' as const,by:'owner',at:new Date(f.clock.now()).toISOString()};
 expect(()=>f.root.writes.run(()=>{f.db.insert(secretChanges).values(audit).run();throw Error('Rollback');})).toThrow('Rollback');expect(f.closed).not.toHaveBeenCalled();old.state?.('connected');expect(f.db.select().from(bridgeConnections).get()?.state).toBe('connected');
 // Another secret changing is no business of this connection.
 f.root.writes.run(()=>{f.db.insert(secrets).values({name:'UNRELATED',description:'',changedAt:audit.at,changedBy:'owner'}).run();f.db.insert(secretChanges).values({...audit,id:randomUUID(),secret:'UNRELATED',action:'add'}).run();});
 await f.root.services.bridges.daemon!.idle();expect(f.closed).not.toHaveBeenCalled();expect(f.transports).toHaveLength(1);
 f.root.writes.run(()=>f.db.insert(secretChanges).values(audit).run());await expect(old.receive({},Buffer.from('{}'))).rejects.toThrow();await f.root.services.bridges.daemon!.idle();expect(f.closed).toHaveBeenCalledOnce();
});
it('answers a replay only for the job that took the mail, gives a later body no second answer, and rechecks source state before a cached acknowledgement',async()=>{
 const f=fixture(),incoming=await f.receive();f.root.writes.run(()=>{f.db.update(jobs).set({conversation:incoming.conversation}).where(eq(jobs.id,'body')).run();f.root.services.conversations.take(incoming.conversation!,'body');});const input={id:randomUUID(),incoming:incoming.id,text:'Reply',model:'observed'},receipt=randomUUID();expect((await f.call('bridges','reply',input,token.body,receipt)).status).toBe(200);await f.root.services.bridges.daemon!.idle();
 expect((await f.call('bridges','reply',input,token.body,receipt)).status).toBe(200);
 // The body ends and another job works the conversation. The answered mail was never that job's: it can
 // neither replay the first body's receipt nor answer the message again under a receipt of its own.
 f.root.writes.run(()=>{f.db.update(jobs).set({state:'done'}).where(eq(jobs.id,'body')).run();f.db.update(jobs).set({conversation:incoming.conversation}).where(eq(jobs.id,'other')).run();});
 expect((await f.call('bridges','reply',input,token.other,receipt)).status).toBe(403);expect((await f.call('bridges','reply',{...input,id:randomUUID()},token.other,randomUUID())).status).toBe(403);
 expect(f.db.select().from(bridgeSends).all()).toHaveLength(1);
 // Back with the body that answered: its receipt replays only while the message is still a delivered one.
 f.root.writes.run(()=>{f.db.update(jobs).set({conversation:null}).where(eq(jobs.id,'other')).run();f.db.update(jobs).set({state:'running'}).where(eq(jobs.id,'body')).run();});
 expect((await f.call('bridges','reply',input,token.body,receipt)).status).toBe(200);
 f.root.writes.run(()=>f.db.update(bridgeIncoming).set({state:'dropped'}).run());expect((await f.call('bridges','reply',input,token.body,receipt)).status).toBe(403);
});
it('fences startup configuration failure before late source completion can touch closed SQLite',async()=>{
 const client=new Database(':memory:'),db=createDataSchema(client),clock=new FakeClock();let release!:(generation:string)=>void;const generation=new Promise<string>(resolve=>{release=resolve;});
 expect(()=>sharedRoot({db,clock,originAllowed:()=>true,reportError:()=>{},bridges:{source:{generation:()=>generation,read:async()=>Buffer.from('synthetic')},effectsAllowed:()=>true},tempo:{contributors:[{name:'',open:()=>[]}]}})).toThrow('Duplicate or empty sweep part');client.close();const reads=vi.spyOn(db,'select');release('12345678-1234-4234-8234-123456789abc');await generation;await Promise.resolve();clock.advance(60000);await Promise.resolve();expect(reads).not.toHaveBeenCalled();reads.mockRestore();
});

it('rolls back a queued reply if its observed-model turn cannot be recorded',async()=>{
 const f=fixture(),incoming=await f.receive();f.root.writes.run(()=>{f.db.update(jobs).set({conversation:incoming.conversation}).where(eq(jobs.id,'body')).run();f.root.services.conversations.take(incoming.conversation!,'body');});
 f.client.exec("CREATE TRIGGER refuse_reply_turn BEFORE INSERT ON turns WHEN NEW.kind='reply' BEGIN SELECT RAISE(ABORT,'Fictitious turn failure'); END");
 expect((await f.call('bridges','reply',{id:randomUUID(),incoming:incoming.id,text:'Reply',model:'observed'})).status).toBe(503);expect(f.db.select().from(bridgeSends).all()).toEqual([]);await f.root.services.bridges.daemon!.idle();expect(f.request.mock.calls.some(([url])=>String(url).endsWith('chat.postMessage'))).toBe(false);
});
it.each(['replacement','venue','private-assignment'])('refuses a reply after the current %s scope changes',async change=>{
 const f=fixture(),incoming=await f.receive();f.root.writes.run(()=>{f.db.update(jobs).set({conversation:incoming.conversation}).where(eq(jobs.id,'body')).run();f.root.services.conversations.take(incoming.conversation!,'body');});
 f.root.writes.run(()=>{
  if(change==='replacement'){f.db.update(jobs).set({conversation:null}).where(eq(jobs.id,'body')).run();f.db.update(jobs).set({conversation:incoming.conversation}).where(eq(jobs.id,'other')).run();}
  if(change==='venue')f.db.update(conversations).set({venue:'loom'}).where(eq(conversations.id,incoming.conversation!)).run();
  if(change==='private-assignment'){f.db.insert(members).values({id:'stranger',role:'member',joinedAt:new Date(f.clock.now()).toISOString()}).run();f.db.update(jobs).set({member:'stranger'}).where(eq(jobs.id,'body')).run();f.db.update(conversations).set({member:'stranger'}).where(eq(conversations.id,incoming.conversation!)).run();}
 });
 expect((await f.call('bridges','reply',{id:randomUUID(),incoming:incoming.id,text:'Late reply',model:'observed'})).status).toBe(403);expect(f.db.select().from(bridgeSends).all()).toEqual([]);
});

it('requires an observed model before a body can queue a reply',async()=>{
 const f=fixture(),incoming=await f.receive();f.root.writes.run(()=>{f.db.update(jobs).set({conversation:incoming.conversation}).where(eq(jobs.id,'body')).run();f.root.services.conversations.take(incoming.conversation!,'body');});
 expect((await f.call('bridges','reply',{id:randomUUID(),incoming:incoming.id,text:'Missing model'})).status).toBe(400);expect(f.db.select().from(bridgeSends).all()).toEqual([]);
});

it.each(['job-agent','box','cv-agent','member','project'])('checks current %s provenance at the HTTP reply door',async change=>{
 const f=fixture(),incoming=await f.receive();f.root.writes.run(()=>{f.db.update(jobs).set({conversation:incoming.conversation}).where(eq(jobs.id,'body')).run();f.root.services.conversations.take(incoming.conversation!,'body');f.db.insert(agents).values({id:'other-agent',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();f.db.insert(members).values({id:'peer',role:'member',joinedAt:new Date(f.clock.now()).toISOString()}).run();f.db.insert(projects).values({id:'project',name:'Project'}).run();});
 f.root.writes.run(()=>{
  if(change==='job-agent')f.db.update(jobs).set({agent:'other-agent'}).where(eq(jobs.id,'body')).run();
  if(change==='box')f.db.update(boxes).set({revokedAt:new Date(f.clock.now()).toISOString()}).run();
  if(change==='cv-agent')f.db.update(conversations).set({agent:'other-agent'}).where(eq(conversations.id,incoming.conversation!)).run();
  if(change==='member')f.db.update(conversations).set({member:'peer'}).where(eq(conversations.id,incoming.conversation!)).run();
  if(change==='project')f.db.update(conversations).set({project:'project'}).where(eq(conversations.id,incoming.conversation!)).run();
 });
 expect([401,403]).toContain((await f.call('bridges','reply',{id:randomUUID(),incoming:incoming.id,text:'Refused',model:'observed'})).status);expect(f.db.select().from(bridgeSends).all()).toEqual([]);
});
it.each(['platform','private-assignment'])('rechecks %s before returning a previously successful reply receipt',async change=>{
 const f=fixture(),incoming=await f.receive();f.root.writes.run(()=>{f.db.update(jobs).set({conversation:incoming.conversation}).where(eq(jobs.id,'body')).run();f.root.services.conversations.take(incoming.conversation!,'body');
  if(change==='private-assignment'){f.db.insert(members).values({id:'peer',role:'member',joinedAt:new Date(f.clock.now()).toISOString()}).run();f.db.insert(memberAgents).values({member:'peer',agent:'art'}).run();f.db.update(jobs).set({member:'peer'}).where(eq(jobs.id,'body')).run();f.db.update(conversations).set({member:'peer'}).where(eq(conversations.id,incoming.conversation!)).run();}
 });
 const input={id:randomUUID(),incoming:incoming.id,text:'Reply',model:'observed'},receipt=randomUUID();expect((await f.call('bridges','reply',input,token.body,receipt)).status).toBe(200);await f.root.services.bridges.daemon!.idle();
 f.root.writes.run(()=>{if(change==='platform')f.db.update(conversations).set({venue:'loom'}).where(eq(conversations.id,incoming.conversation!)).run();else f.db.delete(memberAgents).where(eq(memberAgents.member,'peer')).run();});
 expect((await f.call('bridges','reply',input,token.body,receipt)).status).toBe(403);expect(f.db.select().from(bridgeSends).all()).toHaveLength(1);expect(f.db.select().from(turns).all()).toHaveLength(2);
});
it('lets the body holding a bridge job say more during its run, through the one send queue, and nobody else',async()=>{
 const f=fixture();f.root.services.tempo.volume.setTimings({kind:'agent',id:'art'},{settleSeconds:0});const incoming=await f.receive();
 // Before the job has taken a bridge message there is nothing to say it to.
 f.root.writes.run(()=>{f.db.update(jobs).set({conversation:incoming.conversation}).where(eq(jobs.id,'body')).run();});
 expect((await f.call('bridges','say',{id:randomUUID(),text:'Too early'})).status).toBe(403);
 f.root.writes.run(()=>{f.root.services.conversations.take(incoming.conversation!,'body');});
 const first={id:randomUUID(),text:'Working on it'};
 // Another job's body, and an owner, may not speak for this one. A model field is the reply's, not this door's.
 expect((await f.call('bridges','say',first,token.other)).status).toBe(403);expect((await f.call('bridges','say',first,token.owner)).status).toBe(403);
 expect((await f.call('bridges','say',{...first,model:'claimed'})).status).toBe(400);expect((await f.call('bridges','say',{...first,incoming:incoming.id})).status).toBe(400);
 expect((await f.call('bridges','say',first)).status).toBe(200);await f.root.services.bridges.daemon!.idle();
 // To the place of the message it took, as a reply would go: the same channel and thread, split and receipted the same way.
 expect(f.db.select().from(bridgeSends).all()).toMatchObject([{id:first.id,incoming:incoming.id,channel:'CROOM',thread:incoming.thread,text:'Working on it',state:'sent'}]);
 expect(f.db.select().from(bridgeSendParts).all()).toHaveLength(1);
 // It settles no mail and is no reply: the mail is still the job's to answer.
 expect(f.db.select().from(inbox).get()).toMatchObject({state:'taken',job:'body'});expect(f.db.select().from(turns).all()).toMatchObject([{kind:'message'}]);
 // The same id again is the same message, posted once.
 expect((await f.call('bridges','say',first)).status).toBe(200);await f.root.services.bridges.daemon!.idle();
 expect(f.request.mock.calls.filter(([url])=>String(url).endsWith('chat.postMessage'))).toHaveLength(1);
 // The reply is still made, and answers the mail.
 expect((await f.call('bridges','reply',{id:randomUUID(),incoming:incoming.id,text:'Done',model:'observed',outcome:'progressed'})).status).toBe(200);
 expect(f.db.select().from(inbox).get()).toMatchObject({state:'done'});
 // A body that keeps talking is cut off: twenty posts for what one job took, the reply among them.
 for(let n=0;n<18;n++)expect((await f.call('bridges','say',{id:randomUUID(),text:'More '+n})).status).toBe(200);
 expect(f.db.select().from(bridgeSends).all()).toHaveLength(20);
 const over=await f.call('bridges','say',{id:randomUUID(),text:'One too many'});expect(over.status).toBe(409);
 expect(f.db.select().from(bridgeSends).all()).toHaveLength(20);
 // Once the job has ended its body says nothing more.
 f.root.writes.run(()=>{f.db.update(jobs).set({state:'done'}).where(eq(jobs.id,'body')).run();});
 expect((await f.call('bridges','say',{id:randomUUID(),text:'After'})).status).not.toBe(200);
});
it('holds what a body says while effects are off, as it holds a reply',async()=>{
 let allowed=true;const f=fixture(()=>allowed);const incoming=await f.receive();
 f.root.writes.run(()=>{f.db.update(jobs).set({conversation:incoming.conversation}).where(eq(jobs.id,'body')).run();f.root.services.conversations.take(incoming.conversation!,'body');});
 allowed=false;
 expect((await f.call('bridges','say',{id:randomUUID(),text:'Not yet'})).status).toBe(200);await f.root.services.bridges.daemon!.idle();
 expect(f.db.select().from(bridgeSends).get()).toMatchObject({state:'held',text:'Not yet'});
 expect(f.request.mock.calls.filter(([url])=>String(url).endsWith('chat.postMessage'))).toHaveLength(0);
});
it('hands the body that takes the next bridge message what was said before in that conversation',async()=>{
 const f=fixture(()=>true,true);f.root.services.tempo.volume.setTimings({kind:'agent',id:'art'},{settleSeconds:0});const incoming=await f.receive();
 f.root.writes.run(()=>{f.db.update(jobs).set({conversation:incoming.conversation}).where(eq(jobs.id,'body')).run();});
 const take=async()=>{const response=await f.root.http.request('http://loom/api/conversation/take',{method:'POST',headers:{authorization:'Bearer '+token.body,'content-type':'application/json'},body:JSON.stringify({input:{}})});return (await response.json()).value.items as {words:string|null;history?:{kind:string;sender:string;words:string;keepUntil:string|null}[]}[];};
 // The first message of a conversation has nothing before it.
 const first=await take();expect(first).toMatchObject([{words:'Hello'}]);expect(first[0].history).toBeUndefined();
 expect((await f.call('bridges','say',{id:randomUUID(),text:'Looking'})).status).toBe(200);
 expect((await f.call('bridges','reply',{id:randomUUID(),incoming:incoming.id,text:'Hello back',model:'observed',outcome:'progressed'})).status).toBe(200);await f.root.services.bridges.daemon!.idle();
 // A reply in the same Slack thread: the same conversation. Its body is handed the earlier exchange.
 await f.transports.at(-1)!.receive({},Buffer.from(JSON.stringify({type:'events_api',envelope_id:'ack2',payload:{type:'event_callback',event_id:'event2',team_id:'TWORK',event:{type:'message',channel:'CROOM',user:'UUSER',text:'And again',ts:'1794432001.000001',thread_ts:'1794432000.000001'}}})));
 f.clock.advance(0);await f.root.services.bridges.daemon!.idle();
 expect(f.db.select().from(bridgeIncoming).all().map(row=>row.conversation)).toEqual([incoming.conversation,incoming.conversation]);
 // Taken by the body's own client, which checks what it is handed before the harness sees it.
 const client=bodyConversationClient({url:'https://loom.invalid',token:token.body,job:'body',conversation:incoming.conversation!,signal:new AbortController().signal,clock:f.clock,fetch:async(url,init)=>f.root.http.request(new Request(url,init))});clean.push(()=>client.close());
 const seen:string[]=[],items:unknown[]=[];
 expect(await client.takeAndAccept(async item=>{items.push(structuredClone(item));seen.push(bodyMailContext(item)!);})).toMatchObject({accepted:1});
 expect(items).toMatchObject([{source:'slack',words:'And again',history:[{seq:1,kind:'message',sender:'someone outside the household',words:'Hello',keepUntil:null},{seq:2,kind:'reply',sender:'art',words:'Looking'},{seq:3,kind:'reply',sender:'art',words:'Hello back'}]}]);
 // What the harness is given: the earlier exchange, then the new words.
 expect(JSON.parse(seen[0])).toMatchObject({input:'And again',history:[{words:'Hello'},{words:'Looking'},{words:'Hello back'}]});
});
it('tells the body of a bridge conversation the brief its channel\'s rule names, and tells the owners once when the agent has no such page',async()=>{
 const f=fixture();const incoming=await f.receive();
 f.root.writes.run(()=>{f.db.update(jobs).set({conversation:incoming.conversation}).where(eq(jobs.id,'body')).run();});
 // The rule names none.
 expect(await f.call('bridges','brief',{})).toMatchObject({status:200,body:{value:{brief:null}}});
 expect((await f.call('bridges','briefMissing',{})).status).toBe(403);
 f.root.writes.run(()=>{f.db.update(bridgeChannels).set({brief:'onterris'}).run();});
 expect(await f.call('bridges','brief',{})).toMatchObject({status:200,body:{value:{brief:'onterris'}}});
 // Only the body holding this conversation's job is told.
 expect((await f.call('bridges','brief',{},token.other)).status).toBe(403);expect((await f.call('bridges','brief',{},token.owner)).status).toBe(403);
 expect((await f.call('bridges','briefMissing',{},token.other)).status).toBe(403);
 // The body found no page of that name. The owner is told, once however many bodies find the same.
 const notices=()=>f.db.select().from(inbox).all().filter(item=>item.source==='notice'&&item.sourceId?.startsWith('brief-missing:'));
 expect((await f.call('bridges','briefMissing',{})).status).toBe(200);expect((await f.call('bridges','briefMissing',{})).status).toBe(200);
 expect(notices()).toMatchObject([{toKind:'person',to:'owner',words:'The rule for slack channel CROOM names the brief "onterris", and art has no role page of that name. Its work there goes on without it.'}]);
 // Another brief for the same channel is another thing to be told of.
 f.root.writes.run(()=>{f.db.update(bridgeChannels).set({brief:'field'}).run();});
 expect((await f.call('bridges','briefMissing',{})).status).toBe(200);expect(notices()).toHaveLength(2);
 // A conversation nobody has spoken in (a note or a firing opened it) has its channel's brief all the same:
 // the rule is looked up by the place, as every rule about a place is (ruleChannel).
 const pond=f.root.services.conversations.open({agent:'art',venue:'slack',place:JSON.stringify(['TWORK','CPOND',null]),label:'pond'}).id;
 f.root.writes.run(()=>{f.db.insert(bridgeChannels).values({platform:'slack',workspace:'TWORK',channel:'CPOND',answers:'art',botsMayTalk:false,brief:'pond'}).run();f.db.update(jobs).set({conversation:pond}).where(eq(jobs.id,'other')).run();});
 expect(await f.call('bridges','brief',{},token.other)).toMatchObject({status:200,body:{value:{brief:'pond'}}});
 // A thread's brief is its parent channel's: its messages say which channel that is.
 const thread=f.root.services.conversations.open({agent:'art',venue:'slack',place:JSON.stringify(['TWORK','CTHREAD',null]),label:'thread'}).id;
 f.root.writes.run(()=>{f.db.insert(bridgeIncoming).values({...incoming,id:'bi:thread',channel:'CTHREAD',parent:'CPOND',conversation:thread}).run();f.db.update(jobs).set({conversation:thread}).where(eq(jobs.id,'other')).run();});
 expect(await f.call('bridges','brief',{},token.other)).toMatchObject({status:200,body:{value:{brief:'pond'}}});
 // A direct conversation has none, whatever rule its channel id might match.
 const direct=f.root.services.conversations.open({agent:'art',venue:'slack',place:JSON.stringify(['TWORK','CPOND',null,['member',null]]),label:'dm',direct:true}).id;
 f.root.writes.run(()=>f.db.update(jobs).set({conversation:direct}).where(eq(jobs.id,'other')).run());
 expect(await f.call('bridges','brief',{},token.other)).toMatchObject({status:200,body:{value:{brief:null}}});
});
it('takes a file on bridges.say as a name and bytes, and refuses it for Slack with the reason',async()=>{
 const f=fixture();const incoming=await f.receive();
 f.root.writes.run(()=>{f.db.update(jobs).set({conversation:incoming.conversation}).where(eq(jobs.id,'body')).run();f.root.services.conversations.take(incoming.conversation!,'body');});
 const contents=Buffer.from('PNG').toString('base64');
 // The message is a guest's, so the job works on anybody else's word: its body has no file tools, and no post of its carries a file.
 const guests=await f.call('bridges','say',{id:randomUUID(),text:'With a plot',files:[{name:'plot.png',contents}]});
 expect(guests.status).toBe(403);expect(guests.body.message).toBe('This job is not working for the agent\'s owners: it runs with loom\'s tools only, and its posts carry no files.');
 expect((await f.call('bridges','say',{id:randomUUID(),text:'Words alone'})).status).toBe(200);f.root.writes.run(()=>{f.db.delete(bridgeSends).run();});
 // The owner speaks there instead.
 f.root.writes.run(()=>f.db.update(inbox).set({fromKind:'person',fromId:'owner'}).where(eq(inbox.job,'body')).run());
 const refused=await f.call('bridges','say',{id:randomUUID(),text:'With a plot',files:[{name:'plot.png',contents}]});
 expect(refused.status).toBe(400);expect(refused.body.message).toContain('files are posted on Discord only');
 expect(f.db.select().from(bridgeSends).all()).toEqual([]);
 // A path is no file here: the door takes bytes, and the body program is what reads a path (body-files.ts).
 expect((await f.call('bridges','say',{id:randomUUID(),text:'x',files:[{path:'/etc/passwd'}]})).status).toBe(400);
 expect((await f.call('bridges','say',{id:randomUUID(),text:'x',files:[{name:'a',contents:'not base64!'}]})).status).toBe(400);
 expect((await f.call('bridges','say',{id:randomUUID(),text:'x',files:[]})).status).toBe(400);
 expect((await f.call('bridges','say',{id:randomUUID(),text:'x',files:Array(5).fill({name:'a',contents})})).status).toBe(400);
});
it('keeps a conversation\'s harness session sealed, for the body of its job alone, and hands on only one that is current',async()=>{
 // The account that writes is the owner's own: the job works on owners' word. A job on anybody else's has neither door (below).
 const f=fixture(()=>true,true);f.db.insert(bridgePeople).values({platform:'slack',workspace:'TWORK',user:'UUSER',member:'owner'}).run();const incoming=await f.receive();
 f.root.writes.run(()=>{f.db.update(jobs).set({conversation:incoming.conversation,harness:'claude',model:'claude-opus-5-5'}).where(eq(jobs.id,'body')).run();f.db.update(jobs).set({harness:'claude',model:'claude-opus-5-5'}).where(eq(jobs.id,'other')).run();f.root.services.conversations.take(incoming.conversation!,'body');});
 const files=Buffer.from('THE MODEL\'S OWN RECORD OF THE CONVERSATION').toString('base64'),session='0f0e0d0c-1111-4222-8333-444455556666';
 const take=async(credential=token.body)=>f.call('conversation','session',{},credential),save=(input:unknown,credential=token.body)=>f.call('conversation','sessionSave',input,credential);
 expect(await take()).toMatchObject({status:200,body:{value:{session:null}}});
 expect(await save({session,files})).toMatchObject({status:200,body:{value:{saved:true}}});
 // Nobody but the body of this conversation's job: not another job's body, not the owner.
 for(const credential of [token.other,token.owner]){expect((await take(credential)).status).toBe(403);expect((await save({session,files},credential)).status).toBe(403);}
 // Nor a plain member of the household, signed in as themselves, whether or not they have the agent.
 const member='d'.repeat(64);
 f.root.writes.run(()=>{f.db.insert(members).values({id:'sam',role:'member',joinedAt:new Date(f.clock.now()).toISOString()}).run();f.db.insert(memberAgents).values({member:'sam',agent:'art'}).run();
  f.db.insert(tokens).values({fingerprint:createHash('sha256').update(member).digest('hex'),label:'sam',kind:'owner',member:'sam',agent:null,job:null,createdAt:new Date(f.clock.now()).toISOString()}).run();});
 expect((await take(member)).status).toBe(403);expect((await save({session,files},member)).status).toBe(403);
 // Nor the body of a job that is not a bridge conversation's: the other job here has no conversation, and a wake's body has no session.
 const wake=f.root.services.conversations.open({agent:'art',venue:'wake',place:'daily',label:'Daily'});
 f.root.writes.run(()=>{f.db.update(jobs).set({conversation:wake.id}).where(eq(jobs.id,'other')).run();});
 expect((await take(token.other)).status).toBe(403);expect((await save({session,files},token.other)).status).toBe(403);
 expect(await take()).toMatchObject({status:200,body:{value:{session:{session,files}}}});
 // Stored sealed: neither the bytes nor their base64 are in the database file, and no query serves the table.
 const stored=f.db.select().from(conversationSessions).all();
 expect(stored).toMatchObject([{conversation:incoming.conversation,harness:'claude',session,bytes:Buffer.byteLength(files,'base64')}]);
 for(const needle of ['THE MODEL\'S OWN RECORD',files])expect(f.client.serialize().includes(Buffer.from(needle))).toBe(false);
 const owner=await f.root.http.request('http://loom/graphql',{method:'POST',headers:{authorization:'Bearer '+token.owner,'content-type':'application/json'},body:JSON.stringify({query:'{ __schema { queryType { fields { name } } } }'})});
 expect(JSON.stringify(await owner.json())).not.toMatch(/conversationSessions|conversation_sessions/i);
 // Another family of models is not handed it.
 f.root.writes.run(()=>{f.db.update(jobs).set({model:'gpt-6-luna'}).where(eq(jobs.id,'body')).run();});
 expect(await take()).toMatchObject({body:{value:{session:null}}});
 f.root.writes.run(()=>{f.db.update(jobs).set({model:'claude-sonnet-5-5'}).where(eq(jobs.id,'body')).run();});
 expect(await take()).toMatchObject({body:{value:{session:{session}}}});
 // Nor another harness: each has its own.
 f.root.writes.run(()=>{f.db.update(jobs).set({harness:'codex'}).where(eq(jobs.id,'body')).run();});
 expect(await take()).toMatchObject({body:{value:{session:null}}});
 f.root.writes.run(()=>{f.db.update(jobs).set({harness:'claude'}).where(eq(jobs.id,'body')).run();});
 // The conversation was answered after the session was saved (its body died before saving, or another harness
 // answered): the session is behind what was said and is not handed on.
 f.clock.advance(1000);
 expect((await f.call('bridges','reply',{id:randomUUID(),incoming:incoming.id,text:'Answered since',model:'observed',outcome:'progressed'})).status).toBe(200);
 expect(await take()).toMatchObject({body:{value:{session:null}}});
 // Saved again after the answer, it is current.
 f.clock.advance(1000);expect((await save({session,files})).status).toBe(200);
 expect(await take()).toMatchObject({body:{value:{session:{session}}}});
 // One too large to keep is not kept, and takes the earlier one with it.
 const large=Buffer.alloc(SESSION_BYTES+1,1).toString('base64');
 expect(await save({session,files:large})).toMatchObject({status:200,body:{value:{saved:false}}});
 expect(f.db.select().from(conversationSessions).all()).toEqual([]);
 // A body that leaves none says so, and what was kept goes.
 expect((await save({session,files})).status).toBe(200);
 expect(await save({session:null})).toMatchObject({body:{value:{saved:false}}});
 expect(f.db.select().from(conversationSessions).all()).toEqual([]);
 // An id that could be a path, and a save that names a session without its files, are refused.
 for(const bad of [{session:'../../etc',files},{session},{session:null,files},{session,files:'not base64!'}])expect((await save(bad)).status).toBe(400);
 // Once the job has ended, its body has neither door.
 expect((await save({session,files})).status).toBe(200);
 f.root.writes.run(()=>{f.db.update(jobs).set({state:'done'}).where(eq(jobs.id,'body')).run();});
 expect((await take()).status).not.toBe(200);expect((await save({session,files})).status).not.toBe(200);
});
it('gives a job on anybody else\'s word neither session door, and leaves the owners\' session for the owners\' next job',async()=>{
 const f=fixture(()=>true,true);
 f.db.insert(bridgePeople).values({platform:'slack',workspace:'TWORK',user:'UOWNER',member:'owner'}).run();
 await f.root.services.bridges.daemon!.ready();await f.root.services.bridges.daemon!.idle();
 let events=0;
 /** A message in the one Slack thread of the room, from the owner's account or from the guest's. */
 const hear=async(user:'UOWNER'|'UUSER',text:string)=>{const n=++events;
  await f.transports.at(-1)!.receive({},Buffer.from(JSON.stringify({type:'events_api',envelope_id:'ack'+n,payload:{type:'event_callback',event_id:'event'+n,team_id:'TWORK',event:{type:'message',channel:'CROOM',user,text,ts:`179443200${n}.000001`,...(n>1?{thread_ts:'1794432001.000001'}:{})}}})));
  f.clock.advance(0);await f.root.services.bridges.daemon!.idle();return f.db.select().from(bridgeIncoming).all().find(row=>row.text===text)!;};
 /** One job at a time works in the conversation: this one now, with the mail that waits there. */
 const work=(id:'body'|'other',conversation:string)=>f.root.writes.run(()=>{f.db.update(jobs).set({state:'done'}).run();f.db.update(jobs).set({conversation,harness:'claude',model:'claude-opus-5-5',state:'running'}).where(eq(jobs.id,id)).run();
  f.db.update(inbox).set({job:id}).where(and(eq(inbox.conversation,conversation),eq(inbox.state,'waiting'))).run();f.root.services.conversations.take(conversation,id);});
 const take=async(credential:string)=>f.call('conversation','session',{},credential),save=(input:unknown,credential:string)=>f.call('conversation','sessionSave',input,credential);
 const answer=(incoming:string,credential:string)=>f.call('bridges','reply',{id:randomUUID(),incoming,text:'Answered',model:'observed',outcome:'progressed'},credential);
 const files=Buffer.from('WHAT THE OWNERS\' JOB READ AND USED').toString('base64'),session='0f0e0d0c-1111-4222-8333-444455556666';
 // An owners' job answers and saves its session.
 const first=await hear('UOWNER','Use the deploy key'),cv=first.conversation!;work('body',cv);
 expect(jobWord(f.db,{id:'body',agent:'art',conversation:cv}).woke).toBe('owners');
 expect((await answer(first.id,token.body)).status).toBe(200);f.clock.advance(1000);
 expect(await save({session,files},token.body)).toMatchObject({status:200,body:{value:{saved:true}}});
 const kept=f.db.select().from(conversationSessions).all();expect(kept).toMatchObject([{conversation:cv,session}]);
 // A guest writes in the same conversation. That job is on anybody else's word: it is refused the session at the door, and starts fresh.
 f.clock.advance(1000);const second=await hear('UUSER','What did you just do?');expect(second.conversation).toBe(cv);work('other',cv);
 expect(jobWord(f.db,{id:'other',agent:'art',conversation:cv}).woke).toBe('others');
 expect((await take(token.other)).status).toBe(403);
 // Nor does it save one of its own, or say that none is kept: what the owners' job left stays as it was.
 expect((await save({session:'1f0e0d0c-1111-4222-8333-444455556666',files},token.other)).status).toBe(403);
 expect((await save({session:null},token.other)).status).toBe(403);
 expect(f.db.select().from(conversationSessions).all()).toEqual(kept);
 // It answers all the same (what it is told of the conversation is its kept history: shared-bridge-resume.test.ts).
 expect((await answer(second.id,token.other)).status).toBe(200);
 // The owner writes again. That job resumes the session the first one left: the guest's job in between took nothing from it and put nothing in.
 f.clock.advance(1000);const third=await hear('UOWNER','Go on');expect(third.conversation).toBe(cv);work('body',cv);
 expect(jobWord(f.db,{id:'body',agent:'art',conversation:cv}).woke).toBe('owners');
 expect(await take(token.body)).toMatchObject({status:200,body:{value:{session:{session,files}}}});
 // An answer by an owners' job after the save still leaves the session behind, as before.
 expect((await answer(third.id,token.body)).status).toBe(200);
 expect(await take(token.body)).toMatchObject({status:200,body:{value:{session:null}}});
});
// What a body may schedule depends on whose word its job works on (policy.ts, maySchedule). A guest's body would be
// setting words that later run as the agent's own wake, outside the conversation and its limits: every trigger
// that does not name its own conversation is refused there.
it('refuses every trigger a shared place\'s body sets, rewords, stops, starts or runs outside its own conversation, with a line that says what to do instead',async()=>{
 const f=fixture();const incoming=await f.receive();
 f.root.writes.run(()=>{f.db.insert(agents).values({id:'mark',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();f.db.update(jobs).set({conversation:incoming.conversation}).where(eq(jobs.id,'body')).run();f.root.services.conversations.take(incoming.conversation!,'body');});
 // A Slack channel, and its sender an outside account: a shared place, with a guest in the room.
 expect(f.db.select().from(conversations).get()).toMatchObject({venue:'slack',member:null});expect(f.db.select().from(inbox).get()).toMatchObject({fromKind:'unknown'});
 const trigger=(more:Record<string,unknown>)=>({id:randomUUID(),ownerKind:'agent',owner:'art',sourceKind:'time',times:new Date(f.clock.now()+3_600_000).toISOString(),lifespan:'once',targetKind:'inbox',toKind:'agent',to:'art',instructions:'Words chosen in the shared place',note:'Set from a shared place',...more});
 const line='This job is not working for the agent\'s owners, so it schedules only into the Discord or Slack conversation it is working in, if that is a shared place. Ask in your own thread, or have an owner schedule it.';
 // The agent's own wake: who the caller is would allow it; where its job is does not.
 expect(await f.call('tempo','set',trigger({}))).toMatchObject({status:403,body:{ok:false,code:'denied',message:line}});
 // Another agent's work, and a message to a person, were never the caller's to set.
 for(const other of [{owner:'mark',to:'mark'},{to:'mark'},{toKind:'person',to:'owner'}])expect((await f.call('tempo','set',trigger(other))).status).toBe(403);
 expect(f.db.select().from(triggers).all()).toEqual([]);
 // Nor may it reword a trigger of its agent's that is already set: the words would run the same way.
 // A body of the same agent whose job is not in a shared place is judged as before, by who it is: the other job here
 // has no conversation at all.
 const owned=trigger({instructions:'Set outside any shared place'});
 expect((await f.call('tempo','set',owned,token.other)).status).toBe(200);
 // Nor may the shared place's body reword that trigger: the words would run the same way.
 expect(await f.call('tempo','edit',{id:owned.id,instructions:'Reworded in the shared place'})).toMatchObject({status:403,body:{message:line}});
 expect(f.db.select().from(triggers).all()).toMatchObject([{id:owned.id,instructions:'Set outside any shared place'}]);
 // Nor stop it, start it, or fire it at a time of its choosing: each would decide in the shared place what happens outside it.
 for(const action of ['stop','start','runNow'])expect(await f.call('tempo',action,{id:owned.id}),action).toMatchObject({status:403,body:{message:line}});
 expect(f.db.select().from(triggers).get()).toMatchObject({state:'standing',lastFiredAt:null});
 expect((await f.call('tempo','edit',{id:owned.id,instructions:'Reworded outside it'},token.other)).status).toBe(200);
 expect((await f.call('tempo','stop',{id:owned.id},token.other)).status).toBe(200);
});
it('attaches the earlier words of a bridge conversation to one piece of mail in a batch, not to each',async()=>{
 const f=fixture(()=>true,true);f.root.services.tempo.volume.setTimings({kind:'agent',id:'art'},{settleSeconds:0});const incoming=await f.receive();
 f.root.writes.run(()=>{f.db.update(jobs).set({conversation:incoming.conversation}).where(eq(jobs.id,'body')).run();});
 const take=async()=>{const response=await f.root.http.request('http://loom/api/conversation/take',{method:'POST',headers:{authorization:'Bearer '+token.body,'content-type':'application/json'},body:JSON.stringify({input:{}})});return (await response.json()).value.items as {words:string|null;history?:{words:string}[]}[];};
 await take();
 expect((await f.call('bridges','reply',{id:randomUUID(),incoming:incoming.id,text:'Hello back',model:'observed',outcome:'progressed'})).status).toBe(200);await f.root.services.bridges.daemon!.idle();
 for(const [n,text] of [[2,'Second'],[3,'Third']] as const){
  await f.transports.at(-1)!.receive({},Buffer.from(JSON.stringify({type:'events_api',envelope_id:'ack'+n,payload:{type:'event_callback',event_id:'event'+n,team_id:'TWORK',event:{type:'message',channel:'CROOM',user:'UUSER',text,ts:`179443200${n}.000001`,thread_ts:'1794432000.000001'}}})));
  f.clock.advance(0);await f.root.services.bridges.daemon!.idle();
 }
 const batch=await take();
 expect(batch.map(item=>item.words)).toEqual(['Second','Third']);
 expect(batch[0].history?.map(line=>line.words)).toEqual(['Hello','Hello back']);
 expect(batch[1].history).toBeUndefined();
});

/** The conversation a call's answer names, wherever the door puts its output. */
const made=(body:unknown):string=>{const found=JSON.stringify(body).match(/"conversation":"([^"]+)"/);if(!found)throw new Error('No conversation in '+JSON.stringify(body));return found[1];};
const GUEST=JSON.stringify(['slack','TWORK','UUSER']),SHARED_PLACE_LINE='This job is not working for the agent\'s owners, so it schedules only into the Discord or Slack conversation it is working in, if that is a shared place. Ask in your own thread, or have an owner schedule it.';
/** A shared place with a guest's message in it and the body's job working there. */
async function sharedPlace(effects:()=>boolean=()=>true){
 let received=false;const f=fixture(()=>!received||effects(),true),incoming=await f.receive(),cv=incoming.conversation!;received=true;
 f.root.writes.run(()=>{f.db.update(jobs).set({conversation:cv}).where(eq(jobs.id,'body')).run();f.root.services.conversations.take(cv,'body');});
 const once=(more:Record<string,unknown>={})=>({id:randomUUID(),ownerKind:'agent',owner:'art',sourceKind:'time',times:new Date(f.clock.now()+86_400_000).toISOString(),lifespan:'once',targetKind:'inbox',toKind:'agent',to:'art',instructions:'Post the numbers',note:'Daily numbers',conversation:cv,...more});
 /** Put the other job to work in a conversation, with mail from these people behind it. */
 const work=(conversation:string,from:{kind:'person'|'unknown';id?:string}[])=>f.root.writes.run(()=>{
  f.db.update(inbox).set({job:null}).where(eq(inbox.job,'other')).run();f.db.update(jobs).set({conversation}).where(eq(jobs.id,'other')).run();
  from.forEach((who,index)=>{const item=f.root.services.conversations.send({conversation,toKind:'agent',to:'art',source:'notice',sourceId:randomUUID()+index,fromKind:who.kind,fromId:who.id,words:'Go on'});f.db.update(inbox).set({job:'other',state:'taken'}).where(eq(inbox.id,item.id)).run();});});
 /** The card that waits for an owner about this trigger, and an owner's answer to it. */
 const card=(trigger:string)=>f.db.select().from(approvals).all().filter(row=>row.target===`household:placeSchedule:${trigger}`).at(-1);
 const answer=(trigger:string,answer:'allow'|'deny')=>f.call('approvals','answer',{id:card(trigger)!.id,answer},token.owner);
 /** A repeating trigger the guest's body asks for and an owner allows: the only way one comes to stand on a guest's word. */
 const allowed=async(trigger:{id:string})=>{expect(await f.call('tempo','set',trigger)).toMatchObject({status:200,body:{value:{id:trigger.id,waits:SCHEDULE_ASKED}}});expect((await answer(trigger.id,'allow')).status).toBe(200);};
 return {f,incoming,cv,once,work,card,answer,allowed};
}
it('lets a shared place\'s body set a trigger that names its own conversation, records who asked, and holds it to that conversation and to the bounds',async()=>{
 const {f,cv,once,allowed,answer}=await sharedPlace();
 const mine=once();
 expect((await f.call('tempo','set',mine)).status).toBe(200);
 // The asker is the person whose message started the job: here the guest, by the account loom knows them by.
 expect(f.db.select().from(triggers).get()).toMatchObject({id:mine.id,conversation:cv,askedByKind:'outside',askedBy:GUEST,member:null,state:'standing'});
 expect(f.db.select().from(triggers).get()!.askedAt).toBe(new Date(f.clock.now()).toISOString());
 // Anything that does not name this conversation keeps the refusal: no conversation, and another one.
 const elsewhere=f.root.services.conversations.open({agent:'art',venue:'slack',place:JSON.stringify(['TWORK','COTHER',null]),label:'other'}).id;
 for(const other of [{conversation:undefined},{conversation:elsewhere}])expect(await f.call('tempo','set',once(other))).toMatchObject({status:403,body:{message:SHARED_PLACE_LINE}});
 // What is named must be a bridge conversation of the agent the trigger puts to work.
 expect((await f.call('tempo','set',once({conversation:'cv-none'}),token.other)).status).toBe(400);
 // A repeating one is an owner's to allow (the test below); allowed, it stands on the guest's word.
 // How often it repeats is refused by no number: ten minutes apart is asked of the owners like any other.
 const hourly=once({lifespan:'until-stopped',times:'09:00,09:10'});await allowed(hourly);
 expect(await f.call('tempo','edit',{id:hourly.id,times:'09:00,11:00',instructions:'Reworded in the shared place'})).toMatchObject({status:200,body:{value:{saved:false,waits:SCHEDULE_ASKED}}});
 expect((await answer(hourly.id,'allow')).status).toBe(200);
 expect(f.db.select().from(triggers).where(eq(triggers.id,hourly.id)).get()).toMatchObject({times:'09:00,11:00',instructions:'Reworded in the shared place',askedByKind:'outside',askedBy:GUEST});
 // It stops, starts and runs its own conversation's triggers, and still no other of its agent's.
 const outside=once({conversation:undefined});expect((await f.call('tempo','set',outside,token.other)).status).toBe(200);
 for(const action of ['stop','start','runNow']){expect((await f.call('tempo',action,{id:hourly.id})).status,action).toBe(action==='runNow'?403:200);expect(await f.call('tempo',action,{id:outside.id}),action).toMatchObject({status:403,body:{message:SHARED_PLACE_LINE}});}
 // The owner, and the agent outside the conversation, set one naming a conversation the agent has: the asker is then that owner, or the agent.
 const owners=once(),own=once();
 owners.ownerKind='member';owners.owner='owner';f.root.writes.run(()=>f.db.insert(memberAgents).values({member:'owner',agent:'art'}).run());
 expect((await f.call('tempo','set',owners,token.owner)).status).toBe(200);expect((await f.call('tempo','set',own,token.other)).status).toBe(200);
 expect(f.db.select().from(triggers).where(eq(triggers.id,owners.id)).get()).toMatchObject({askedByKind:'member',askedBy:'owner'});
 expect(f.db.select().from(triggers).where(eq(triggers.id,own.id)).get()).toMatchObject({askedByKind:'agent',askedBy:'art'});
 // A trigger keeps to its asker. The guest's body may not reword, stop, start or run what the owner or the agent asked for there.
 for(const [action,input] of [['edit',{id:own.id,instructions:'The guest\'s words on the agent\'s word'}],['stop',{id:own.id}],['start',{id:own.id}],['runNow',{id:own.id}]] as const)
  expect(await f.call('tempo',action,input),action).toMatchObject({status:403,body:{message:action==='runNow'?RUN_NOW_REFUSAL:WORD_ASKER_REFUSAL}});
 expect(f.db.select().from(triggers).where(eq(triggers.id,own.id)).get()).toMatchObject({instructions:'Post the numbers',state:'standing',lastFiredAt:null});
 // Whoever changes its words becomes its asker: the owner replacing the words of the guest's trigger, all of them, makes it the owner's.
 expect((await f.call('tempo','edit',{id:hourly.id,instructions:'The owner\'s words',note:'The owner\'s note'},token.owner)).status).toBe(200);
 expect(f.db.select().from(triggers).where(eq(triggers.id,hourly.id)).get()).toMatchObject({askedByKind:'member',askedBy:'owner'});
 expect(await f.call('tempo','stop',{id:hourly.id})).toMatchObject({status:403,body:{message:WORD_ASKER_REFUSAL}});
 // From a shared place a trigger carries words, never a file of the household's repository, and watches no event.
 expect(await f.call('tempo','set',once({instructions:undefined,file:'lanes/secret.md'}))).toMatchObject({status:403,body:{message:WORD_FILE_REFUSAL}});
 expect(await f.call('tempo','edit',{id:mine.id,file:'lanes/secret.md'})).toMatchObject({status:403,body:{message:WORD_FILE_REFUSAL}});
 // No number of schedules is refused for one conversation, whoever sets them. The agent's people are told when ten
 // stand, and at each further ten: loud, not a stop.
 expect(PLACE_TRIGGERS_NOTICE_EVERY).toBe(10);
 const standing=()=>f.db.select().from(triggers).all().filter(row=>row.conversation===cv&&row.enabled).length;
 const crowded=()=>f.db.select().from(inbox).where(eq(inbox.source,'notice')).all().filter(item=>item.sourceId?.startsWith('place-schedules:'));
 while(standing()<PLACE_TRIGGERS_NOTICE_EVERY-1)expect((await f.call('tempo','set',once())).status).toBe(200);
 expect(crowded()).toEqual([]);
 expect((await f.call('tempo','set',once())).status).toBe(200);
 expect(crowded()).toMatchObject([{toKind:'person',to:'owner',words:`10 schedules now stand for one conversation of art (${cv}). Nothing was refused: stop any that should not stand.`}]);
 for(const credential of [token.body,token.owner])expect((await f.call('tempo','set',once(),credential)).status).toBe(200);
 expect(standing()).toBe(PLACE_TRIGGERS_NOTICE_EVERY+2);expect(crowded()).toHaveLength(1);
 // Turning one back on is counted as setting one is, and is refused no more. The same mark on the same day is told once.
 for(const id of [mine.id,hourly.id,own.id])f.root.writes.run(()=>f.root.services.tempo.triggers.stop(id));
 expect(standing()).toBe(PLACE_TRIGGERS_NOTICE_EVERY-1);
 expect((await f.call('tempo','start',{id:mine.id})).status).toBe(200);expect(standing()).toBe(PLACE_TRIGGERS_NOTICE_EVERY);expect(crowded()).toHaveLength(1);
 // At twenty they are told again.
 while(standing()<2*PLACE_TRIGGERS_NOTICE_EVERY)expect((await f.call('tempo','set',once())).status).toBe(200);
 expect(crowded()).toHaveLength(2);expect(crowded()[1].words).toContain('20 schedules now stand');
 // Nobody loom can name is ever the asker: with the sender of the job's mail unknowable, the body sets nothing.
 f.root.writes.run(()=>{f.db.update(triggers).set({enabled:false,state:'stopped'}).where(eq(triggers.id,own.id)).run();f.db.delete(inboxRefs).run();});
 expect(await f.call('tempo','set',once())).toMatchObject({status:403,body:{message:'Nobody loom knows asked for this'}});
});
it('sends a repeating schedule asked for on anybody else\'s word to the owners as a card, and sets or changes it only when an owner allows',async()=>{
 const {f,cv,once,card,answer}=await sharedPlace();
 const rows=()=>f.db.select().from(triggers).all(),row=(id:string)=>f.db.select().from(triggers).where(eq(triggers.id,id)).get();
 // A body coming back to its own work sets a one-time trigger any time, with no owner asked.
 const comeBack=once();expect(await f.call('tempo','set',comeBack)).toEqual({status:200,body:expect.objectContaining({value:{id:comeBack.id}})});
 expect(f.db.select().from(approvals).all()).toEqual([]);
 // The guest wants a schedule set up. Nothing is set: the body is told in plain words that the owners were asked.
 const daily=once({lifespan:'until-stopped',times:'09:00,09:30',days:'weekdays',note:'Daily numbers for Dana',instructions:'Post the numbers, then say hello'});
 expect(await f.call('tempo','set',daily)).toMatchObject({status:200,body:{value:{id:daily.id,waits:SCHEDULE_ASKED}}});
 expect(rows().map(trigger=>trigger.id)).toEqual([comeBack.id]);
 // The card is a household card from this conversation. It shows who asked, where, the times, and the note and words in full.
 expect(card(daily.id)).toMatchObject({kind:'setting',operation:'household.change',state:'pending',agent:'art',conversation:cv,askedFrom:cv,actingFor:'unknown'});
 expect(card(daily.id)!.what).toBe(`Set a repeating schedule for art in conversation ${cv} (slack channel CROOM, thread 1794432000.000001), asked for there by the outside account ${GUEST}, who is not one of art's owners. Times: 09:00,09:30, on weekdays, until it is stopped. `
  +`Its note, in the words of the body that asked and not loom's: "Daily numbers for Dana". What each firing tells the body, in the same body's words: "Post the numbers, then say hello".`);
 expect(card(daily.id)!.why).toBe(`the outside account ${GUEST} asked art for this in slack channel CROOM, thread 1794432000.000001. They are not one of art's owners, so loom asks you first.`);
 // What the owner is asked, and what the answer says, is loom's alone: the answer is mail to the agent on the owner's word, and carries no word of the body's.
 for(const line of [card(daily.id)!.ask,card(daily.id)!.ifYes,card(daily.id)!.ifNo]){expect(line).not.toContain('Dana');expect(line).not.toContain('hello');}
 expect(card(daily.id)!.ask).toBe(`Set a repeating schedule for art in conversation ${cv}, asked for by the outside account ${GUEST}?`);
 expect(f.db.select().from(inbox).where(eq(inbox.source,'approval')).all()).toMatchObject([{toKind:'person',to:'owner',waitsOnId:card(daily.id)!.id}]);
 // No standing rule answers such a card, not even filed as if from an owner's own thread under a rule for every setting.
 f.root.writes.run(()=>f.root.services.setup.rule({kind:'setting',scope:'household:*',person:'',tier:'do'},'owner'));
 const same={...JSON.parse(card(daily.id)!.details).after,trigger:{...JSON.parse(card(daily.id)!.details).after.trigger,id:'tr-as-if'}};
 expect(f.root.writes.run(()=>f.root.services.setup.propose('art',{change:'placeSchedule',input:same,why:'As if from the owner\'s thread'},{conversation:cv,member:'owner',project:null})).value).toMatchObject({state:'pending'});
 expect((await answer('tr-as-if','deny')).status).toBe(200);
 const second=once({lifespan:'today',times:'23:58,23:59'});expect(await f.call('tempo','set',second)).toMatchObject({status:200,body:{value:{waits:SCHEDULE_ASKED}}});
 expect(card(second.id)).toMatchObject({state:'pending'});expect(card(second.id)!.what).toContain('today only');
 // Denied, nothing is made.
 expect((await answer(second.id,'deny')).status).toBe(200);expect(rows().map(trigger=>trigger.id)).toEqual([comeBack.id]);
 // Allowed, the trigger is made with the person who asked as its asker, exactly as the door would have made it.
 expect((await answer(daily.id,'allow')).status).toBe(200);
 expect(row(daily.id)).toMatchObject({conversation:cv,ownerKind:'agent',owner:'art',member:null,toKind:'agent',to:'art',sourceKind:'time',times:'09:00,09:30',days:'weekdays',lifespan:'until-stopped',
  note:'Daily numbers for Dana',instructions:'Post the numbers, then say hello',file:null,askedByKind:'outside',askedBy:GUEST,enabled:true,state:'standing'});
 expect(card(daily.id)).toMatchObject({state:'used',decidedBy:'owner'});
 // A change of times that makes a one-time trigger repeat is asked the same way, and so is any change to one that repeats.
 const dated=once({lifespan:'until-stopped'});expect(await f.call('tempo','set',dated)).toEqual({status:200,body:expect.objectContaining({value:{id:dated.id}})});
 expect(await f.call('tempo','edit',{id:dated.id,times:'08:00,20:00'})).toMatchObject({status:200,body:{value:{saved:false,waits:SCHEDULE_ASKED}}});
 expect(row(dated.id)).toMatchObject({times:dated.times});
 expect(card(dated.id)!.what).toBe(`Change schedule ${dated.id} of art in conversation ${cv} (slack channel CROOM, thread 1794432000.000001), asked for there by the outside account ${GUEST}, who is not one of art's owners. It repeats once changed. `
  +`Changed, with the note and words in the words of the body that asked and not loom's: times 08:00,20:00.`);
 expect((await answer(dated.id,'allow')).status).toBe(200);expect(row(dated.id)).toMatchObject({times:'08:00,20:00',askedByKind:'outside',askedBy:GUEST});
 expect(await f.call('tempo','edit',{id:daily.id,instructions:'Post something else entirely'})).toMatchObject({status:200,body:{value:{saved:false}}});
 expect(card(daily.id)!.what).toContain('what each firing tells the body "Post something else entirely"');
 expect((await answer(daily.id,'deny')).status).toBe(200);expect(row(daily.id)).toMatchObject({instructions:'Post the numbers, then say hello'});
 // A change that leaves a trigger one-time, and stopping one, ask nobody.
 expect(await f.call('tempo','edit',{id:comeBack.id,instructions:'Look again'})).toMatchObject({status:200,body:{value:{saved:true}}});
 expect((await f.call('tempo','stop',{id:daily.id})).status).toBe(200);
 // The other rules stand before any card: a file, an event and another conversation are refused, and no card is filed.
 const before=f.db.select().from(approvals).all().length;
 expect(await f.call('tempo','set',once({lifespan:'until-stopped',times:'09:00',instructions:undefined,file:'lanes/secret.md'}))).toMatchObject({status:403,body:{message:WORD_FILE_REFUSAL}});
 expect(await f.call('tempo','set',once({lifespan:'until-stopped',times:'09:00',conversation:undefined}))).toMatchObject({status:403,body:{message:SHARED_PLACE_LINE}});
 expect(await f.call('tempo','set',once({lifespan:'until-stopped',times:'25:00'}))).toMatchObject({status:400});
 expect(f.db.select().from(approvals).all()).toHaveLength(before);
 // Nobody proposes such a card: who asked is loom's to say. The agent itself, outside any job, is refused by the door.
 expect((await f.call('household','propose',{change:'placeSchedule',input:{action:'set',agent:'art',conversation:cv,place:'anywhere',asker:{kind:'member',id:'owner'},trigger:once({lifespan:'until-stopped',times:'09:00'})},why:'The owner asked'},token.other)).status).toBe(400);
 expect(f.db.select().from(approvals).all()).toHaveLength(before);
 // An owner's answer comes too late for somebody the agent no longer knows: Allow is refused in plain words, and nothing is set.
 const late=once({lifespan:'until-stopped',times:'07:00'});expect((await f.call('tempo','set',late)).status).toBe(200);
 f.root.writes.run(()=>f.db.delete(agentPeople).run());
 expect(await answer(late.id,'allow')).toMatchObject({body:{ok:false,message:`the outside account ${GUEST}, who asked for it, is no longer known to art`}});
 expect(row(late.id)).toBeUndefined();expect(card(late.id)).toMatchObject({state:'pending'});
 // A job working for the agent's owners, there or anywhere, sets a repeating one itself as before.
 f.root.writes.run(()=>{f.db.insert(memberAgents).values({member:'owner',agent:'art'}).run();f.db.update(inbox).set({fromKind:'person',fromId:'owner'}).where(eq(inbox.job,'body')).run();});
 const owners=once({lifespan:'until-stopped',times:'09:00,09:30'});expect(await f.call('tempo','set',owners)).toEqual({status:200,body:expect.objectContaining({value:{id:owners.id}})});
 expect(row(owners.id)).toMatchObject({askedByKind:'member',askedBy:'owner'});
});
it('fires such a trigger as mail from the schedule in its conversation, on its asker\'s word, and answers by a post there',async()=>{
 const {f,cv,once}=await sharedPlace(()=>false);
 const mine=once();expect((await f.call('tempo','set',mine)).status).toBe(200);
 const before=f.db.select().from(conversations).all().length;
 expect((await f.call('tempo','runNow',{id:mine.id},token.other)).status).toBe(200);
 // Mail in the conversation, and no wake of its own.
 expect(f.db.select().from(conversations).all()).toHaveLength(before);
 const fired=f.db.select().from(inbox).where(eq(inbox.source,'trigger')).get()!;
 expect(fired).toMatchObject({conversation:cv,toKind:'agent',to:'art',fromKind:'schedule',onWordKind:'outside',onWord:GUEST,state:'waiting'});
 expect(fired.words).toMatch(/^\[From the schedule, not from a person speaking now: "Daily numbers"\. Asked for by the outside account .* at \d{4}-.*\]\n\nPost the numbers$/);
 // The job that takes it counts the asker as in the room, at the tier they have then: a guest, with a guest's denials.
 f.root.writes.run(()=>{f.db.update(inbox).set({state:'done'}).where(eq(inbox.source,'slack')).run();f.db.update(jobs).set({state:'done'}).where(eq(jobs.id,'body')).run();f.db.update(jobs).set({conversation:cv}).where(eq(jobs.id,'other')).run();f.db.update(inbox).set({job:'other',state:'taken'}).where(eq(inbox.id,fired.id)).run();});
 expect(workerPolicy(f.db,{id:'other',agent:'art',conversation:cv}).people).toEqual([{kind:'outside',person:GUEST,tier:2}]);
 f.root.writes.run(()=>f.db.update(agentPeople).set({tier:1}).run());
 expect(workerPolicy(f.db,{id:'other',agent:'art',conversation:cv}).people).toEqual([{kind:'outside',person:GUEST,tier:1}]);
 // Its answer answers no message: it is a post in the conversation, queued like any other, and held while effects are off.
 const reply={id:randomUUID(),text:'Here are the numbers',model:'observed'};
 expect((await f.call('bridges','reply',reply,token.body)).status).not.toBe(200);
 expect((await f.call('bridges','reply',reply,token.other)).status).toBe(200);
 expect(f.db.select().from(bridgeSends).get()).toMatchObject({id:reply.id,incoming:null,conversation:cv,connection:'connection',channel:'CROOM',text:'Here are the numbers',state:'held'});
 expect(f.db.select().from(inbox).where(eq(inbox.id,fired.id)).get()?.state).toBe('done');
 // During its run such a job may also say more in the conversation (bridges.say), through the same queue.
 const more=randomUUID();expect((await f.call('bridges','say',{id:more,text:'One more thing'},token.other)).status).toBe(200);
 expect(f.db.select().from(bridgeSends).where(eq(bridgeSends.id,more)).get()).toMatchObject({incoming:null,conversation:cv,state:'held'});
 // A held post that answers no message is seen and reviewed by whoever sees its conversation: the owner releases it; an agent never does.
 expect(mayReviewReply(f.db,{kind:'member',id:'owner'},reply.id)).toBe(true);expect(mayReviewReply(f.db,{kind:'agent',id:'art'},reply.id)).toBe(false);
 expect((await f.call('bridges','command',{action:'review',id:reply.id,decision:'release'},token.owner)).status).toBe(200);
 expect(f.db.select().from(bridgeSends).where(eq(bridgeSends.id,reply.id)).get()?.state).not.toBe('held');
 expect(f.db.select().from(turns).all().at(-1)).toMatchObject({conversation:cv,kind:'reply',run:'other'});
 expect(f.request.mock.calls.some(([url])=>String(url).endsWith('chat.postMessage'))).toBe(false);
});
it('stops such a trigger, with one notice, when its asker is no longer known or its conversation cannot be posted to',async()=>{
 const {f,once,allowed}=await sharedPlace();
 const notices=()=>f.db.select().from(inbox).where(eq(inbox.source,'notice')).all().filter(item=>item.sourceId?.startsWith('place-trigger-stopped:'));
 const asked=once({lifespan:'until-stopped',times:'09:00'}),closed=once({lifespan:'until-stopped',times:'10:00'});
 for(const trigger of [asked,closed])await allowed(trigger);
 // A removed channel rule alone stops nothing: a mention there would still wake the agent.
 f.root.writes.run(()=>f.db.delete(bridgeChannels).run());
 expect((await f.call('tempo','runNow',{id:asked.id},token.other)).status).toBe(200);
 expect(f.db.select().from(inbox).where(eq(inbox.source,'trigger')).all()).toHaveLength(1);
 // The owner takes the guest's tier away: the firing does nothing, the trigger is stopped, the owner is told once.
 f.root.writes.run(()=>f.db.delete(agentPeople).run());
 expect((await f.call('tempo','runNow',{id:asked.id},token.other)).status).toBe(200);
 expect(f.db.select().from(inbox).where(eq(inbox.source,'trigger')).all()).toHaveLength(1);
 expect(f.db.select().from(triggers).where(eq(triggers.id,asked.id)).get()).toMatchObject({enabled:false,state:'stopped'});
 expect(notices()).toMatchObject([{toKind:'person',to:'owner',words:expect.stringContaining('who asked for it, is no longer known to art')}]);
 // loom's own words come first and say whose the quoted words are: a note a guest's body wrote cannot pass as loom's.
 expect(notices()[0].words).toBe(`A schedule was stopped and did not fire: the outside account ${GUEST}, who asked for it, is no longer known to art. Its note, in the words of whoever set it and not loom's: "Daily numbers"`);
 // The connection is turned off: the same, for the conversation.
 f.root.writes.run(()=>{f.db.insert(agentPeople).values({agent:'art',person:GUEST,tier:2}).run();f.db.update(bridgeConnections).set({enabled:false}).run();});
 expect((await f.call('tempo','runNow',{id:closed.id},token.other)).status).toBe(200);
 expect(f.db.select().from(triggers).where(eq(triggers.id,closed.id)).get()).toMatchObject({enabled:false,state:'stopped'});
 expect(notices().map(item=>item.words)).toContainEqual(expect.stringContaining("its conversation's connection is not in use"));
 // Turned back on and stopped the same way again, the owner is told again.
 const before=notices().length;
 expect((await f.call('tempo','start',{id:closed.id},token.other)).status).toBe(200);expect((await f.call('tempo','runNow',{id:closed.id},token.other)).status).toBe(200);
 expect(notices()).toHaveLength(before+1);
 expect(f.db.select().from(inbox).where(eq(inbox.source,'trigger')).all()).toHaveLength(1);
 // A trigger whose conversation is no longer a bridge conversation of its agent is stopped the same way: here the
 // conversation was the agent's when the trigger was set, and is another agent's when it fires.
 const elsewhere=f.root.services.conversations.open({agent:'art',venue:'slack',place:JSON.stringify(['TWORK','COTHER',null]),label:'other'}).id,lost=once({conversation:elsewhere});
 expect((await f.call('tempo','set',lost,token.other)).status).toBe(200);
 f.root.writes.run(()=>{f.db.insert(agents).values({id:'mark',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();f.db.update(conversations).set({agent:'mark'}).where(eq(conversations.id,elsewhere)).run();});
 expect((await f.call('tempo','runNow',{id:lost.id},token.other)).status).toBe(200);
 expect(f.db.select().from(triggers).where(eq(triggers.id,lost.id)).get()).toMatchObject({enabled:false,state:'stopped'});
 expect(notices().at(-1)!.words).toContain('did not fire: its conversation is gone.');
 expect(f.db.select().from(inbox).where(eq(inbox.source,'trigger')).all()).toHaveLength(1);
});
it('hands a note to the agent\'s own body in another conversation, by who the sending body works for',async()=>{
 const {f,cv,work}=await sharedPlace(()=>false);
 const pond={platform:'slack',workspace:'TWORK',channel:'CPOND'},note=(to:unknown,words='I talked to them; here is what I need to know')=>({to,clientId:randomUUID(),label:'Debrief',words});
 f.root.writes.run(()=>{f.db.insert(bridgeChannels).values({...pond,answers:'art',botsMayTalk:false}).run();f.db.insert(members).values([{id:'sam',role:'member',joinedAt:new Date(f.clock.now()).toISOString()},{id:'kim',role:'member',joinedAt:new Date(f.clock.now()).toISOString()}]).run();f.db.insert(memberAgents).values({member:'kim',agent:'art'}).run();});
 const notes=()=>f.db.select().from(inbox).where(eq(inbox.source,'handoff')).all();
 // A guest woke this body. Its channel names no report target: it hands nothing anywhere.
 expect((await f.call('conversation','handoff',note(pond))).status).toBe(403);expect(notes()).toEqual([]);
 // The owner names one on the channel's rule (by its card). Then that channel, and no other.
 expect((await f.call('bridges','command',{action:'channel',platform:'slack',workspace:'TWORK',channel:'CROOM',answers:'art',botsMayTalk:false,reportsTo:pond},token.owner)).status).toBe(200);
 expect(f.db.select().from(bridgeChannels).all().find(row=>row.channel==='CROOM')?.reportsTo).toBe(JSON.stringify(['slack','TWORK','CPOND']));
 f.root.writes.run(()=>f.db.insert(bridgeChannels).values({platform:'slack',workspace:'TWORK',channel:'CELSE',answers:'art',botsMayTalk:false}).run());
 expect((await f.call('conversation','handoff',note({...pond,channel:'CELSE'}))).status).toBe(403);
 const first=await f.call('conversation','handoff',note(pond));expect(first.status).toBe(200);
 const target=made(first.body);
 // The conversation there is opened, and the note is mail in it: from the agent, on the guest's word, with where it came from.
 expect(f.db.select().from(conversations).where(eq(conversations.id,target)).get()).toMatchObject({agent:'art',venue:'slack',place:JSON.stringify(['TWORK','CPOND',null]),member:null});
 expect(notes()).toMatchObject([{conversation:target,toKind:'agent',to:'art',fromKind:'agent',fromId:'art',onWordKind:'outside',onWord:GUEST,chain:JSON.stringify([cv]),chainStartedAt:new Date(f.clock.now()).toISOString(),state:'waiting'}]);
 expect(f.db.select().from(inboxRefs).where(eq(inboxRefs.item,notes()[0].id)).all().map(row=>row.ref)).toEqual([cv]);
 // Sealed like any hand-off: the words are not kept in the clear.
 expect(notes()[0].words).not.toContain('here is what I need');
 // The job it starts there counts the guest as in the room.
 f.root.writes.run(()=>{f.db.update(jobs).set({conversation:target}).where(eq(jobs.id,'other')).run();f.db.update(inbox).set({job:'other',state:'taken'}).where(eq(inbox.id,notes()[0].id)).run();});
 expect(workerPolicy(f.db,{id:'other',agent:'art',conversation:target}).people).toEqual([{kind:'outside',person:GUEST,tier:2}]);
 // So that body, still on the guest's word, hands nothing on: #pond reports nowhere.
 expect((await f.call('conversation','handoff',note({conversation:cv}),token.other)).status).toBe(403);
 // Its answer is a post in #pond, held while effects are off.
 expect((await f.call('bridges','reply',{id:randomUUID(),text:'Daniel asked about X',model:'observed'},token.other)).status).toBe(200);
 expect(f.db.select().from(bridgeSends).all()).toMatchObject([{incoming:null,conversation:target,channel:'CPOND',thread:null,state:'held'}]);
 const answer=f.db.select().from(bridgeSends).get()!.id;
 expect((await f.call('bridges','command',{action:'review',id:answer,decision:'release'},token.owner)).status).toBe(200);
 expect(f.db.select().from(bridgeSends).get()?.state).not.toBe('held');
 // The owner answers there: a body woken by an owner hands to any conversation of the agent, and the chain goes on.
 work(target,[{kind:'person',id:'owner'}]);
 const back=await f.call('conversation','handoff',note({conversation:cv},'Tell them XYZ'),token.other);expect(back.status).toBe(200);
 expect(notes().find(item=>item.conversation===cv)).toMatchObject({onWordKind:'member',onWord:'owner',chain:JSON.stringify([cv,target]),chainStartedAt:notes()[0].chainStartedAt});
 // A member who has the agent: the same reach. A member without it, a sender nobody knows, and a mixed batch: anyone else's.
 work(target,[{kind:'person',id:'kim'}]);expect((await f.call('conversation','handoff',note({...pond,channel:'CELSE'}),token.other)).status).toBe(200);
 for(const from of [[{kind:'person' as const,id:'sam'}],[{kind:'unknown' as const}],[{kind:'person' as const,id:'owner'},{kind:'person' as const,id:'sam'}]]){work(target,from);expect((await f.call('conversation','handoff',note({conversation:cv}),token.other)).status,JSON.stringify(from)).toBe(403);}
 // The agent's own work, with nobody behind it: any target. Never its own conversation, another agent's, or a place it has no rule for.
 const lane=f.root.services.conversations.open({agent:'art',venue:'wake',place:'standup',label:'Standup'}).id;work(lane,[]);
 expect((await f.call('conversation','handoff',note(pond),token.other)).status).toBe(200);
 for(const to of [{conversation:lane},{conversation:'cv-none'},{...pond,channel:'CNORULE'}])expect((await f.call('conversation','handoff',note(to),token.other)).status,JSON.stringify(to)).toBe(400);
 // Nothing was posted anywhere by any of it.
 expect(f.request.mock.calls.some(([url])=>String(url).endsWith('chat.postMessage'))).toBe(false);
});
it('refuses no note for the length of its chain, and tells the owners each time it grows by twenty-five',async()=>{
 const {f,cv,work}=await sharedPlace();
 const pond=f.root.services.conversations.open({agent:'art',venue:'slack',place:JSON.stringify(['TWORK','CPOND',null]),label:'pond'}).id;
 expect(CHAIN_NOTICE_EVERY).toBe(25);
 const chain=Array.from({length:CHAIN_NOTICE_EVERY-1},(_,index)=>index%2?pond:cv),started='2026-11-01T00:00:00.000Z';
 work(pond,[{kind:'person',id:'owner'}]);
 f.root.writes.run(()=>{const item=f.root.services.conversations.send({conversation:pond,toKind:'agent',to:'art',source:'handoff',sourceId:'earlier',fromKind:'agent',fromId:'art',words:null as never,chain:JSON.stringify(chain),chainStartedAt:started,onWordKind:'member',onWord:'owner'});f.db.update(inbox).set({job:'other',state:'taken'}).where(eq(inbox.id,item.id)).run();});
 const hand=()=>f.call('conversation','handoff',{to:{conversation:cv},clientId:randomUUID(),label:'Again',words:'And again'},token.other);
 expect((await hand()).status).toBe(200);
 const note=f.db.select().from(inbox).where(eq(inbox.source,'handoff')).all().find(item=>item.conversation===cv)!;
 // Its start, its length and the conversations it runs between are on the row, with no words read.
 expect(note).toMatchObject({chainStartedAt:started});expect(JSON.parse(note.chain!)).toEqual([...chain,pond]);
 const told=()=>f.db.select().from(inbox).where(eq(inbox.source,'notice')).all().filter(item=>item.sourceId?.startsWith('handoff-chain:'));
 expect(told()).toMatchObject([{toKind:'person',to:'owner',words:expect.stringContaining(`handed ${CHAIN_NOTICE_EVERY} notes`)}]);
 expect(told()[0].words).toContain(cv);expect(told()[0].words).toContain(pond);
 // The next one is not refused and raises no second notice.
 expect((await hand()).status).toBe(200);expect(told()).toHaveLength(1);
 // At each further twenty-five the owners are told again.
 f.root.writes.run(()=>f.db.update(inbox).set({chain:JSON.stringify([...chain,...chain,pond])}).where(eq(inbox.sourceId,'earlier')).run());
 expect((await hand()).status).toBe(200);expect(told()).toHaveLength(2);expect(told()[1].words).toContain(`handed ${2*CHAIN_NOTICE_EVERY} notes`);
 // A chain is stored as a list and as nothing else.
 expect(()=>f.root.writes.run(()=>f.db.update(inbox).set({chain:'{}'}).where(eq(inbox.sourceId,'earlier')).run())).toThrow('CHECK');
});
it('gives a stopped job the notes and firings waiting in its conversation, so they start no work until a person speaks there',async()=>{
 const {f,cv,incoming}=await sharedPlace();
 const send=(fromKind:'agent'|'schedule'|'person',source:'handoff'|'trigger'|'notice')=>{let id='';f.root.writes.run(()=>{id=f.root.services.conversations.send({conversation:cv,toKind:'agent',to:'art',source,sourceId:randomUUID(),fromKind,fromId:fromKind==='person'?'owner':'art',words:source==='handoff'?null as never:'Words'}).id;});return id;};
 const note=send('agent','handoff'),firing=send('schedule','trigger'),said=send('person','notice');
 const all=runnable(f);
 // Today's Stop by hand for another reason leaves them as they are.
 expect(f.db.select().from(inbox).all().filter(item=>[note,firing,said].includes(item.id)).map(item=>item.job)).toEqual([null,null,null]);
 f.root.writes.run(()=>all.stop('body','owner','stop'));
 const job=(id:string)=>f.db.select().from(inbox).where(eq(inbox.id,id)).get()!;
 expect([job(note),job(firing)]).toMatchObject([{job:'body',state:'waiting'},{job:'body',state:'waiting'}]);
 // What a person said there is fresh mail still, and admission starts work for it; the note comes along then.
 expect(job(said)).toMatchObject({job:null,state:'waiting'});
 // Through admission: with the person's words set aside, the parked mail starts nothing, and neither does a note or a firing that arrives now.
 f.root.writes.run(()=>f.db.update(inbox).set({state:'done'}).where(eq(inbox.id,said)).run());
 expect(all.admission(cv)).toEqual({});
 const later=send('agent','handoff'),next=send('schedule','trigger');
 expect(all.admission(cv)).toEqual({});expect([job(later).job,job(next).job]).toEqual([null,null]);
 // A bot's message there is nobody speaking, whatever let it through: mail from a sender loom cannot name un-parks
 // nothing unless it is a delivered message from a person's account.
 const heard=(id:string,bot:boolean)=>f.root.writes.run(()=>{f.db.insert(bridgeIncoming).values({...incoming,id,bot,text:'Hi'}).run();
  f.root.services.conversations.send({conversation:cv,toKind:'agent',to:'art',source:'slack',sourceId:id,fromKind:'unknown',words:'Hi',refs:[id]});});
 heard('bi:bot',true);expect(all.admission(cv)).toEqual({});
 // A person speaks there, here the guest: work starts (or loom says why it cannot), and it is for everything waiting.
 heard('bi:guest',false);
 const released=all.admission(cv);expect(released).toMatchObject({started:true,job:{conversation:cv}});
 // The parked note and firing, and the ones that came while it was stopped, are the new job's now, not the stopped one's.
 expect([note,firing,later,next].map(id=>job(id))).toMatchObject(Array.from({length:4},()=>({job:released.job!.id,state:'waiting'})));
 // Outside a bridge a stop parks nothing: a lane's waiting mail is as it was, for the lane's next job.
 const lane=f.root.services.conversations.open({agent:'art',venue:'wake',place:'standup',label:'Standup'}).id;
 let waits='';f.root.writes.run(()=>{f.db.update(jobs).set({conversation:lane}).where(eq(jobs.id,'other')).run();waits=f.root.services.conversations.send({conversation:lane,toKind:'agent',to:'art',source:'trigger',sourceId:'lane-firing',fromKind:'schedule',words:'Next'}).id;});
 f.root.writes.run(()=>all.stop('other','owner','stop'));expect(job(waits)).toMatchObject({job:null,state:'waiting'});
});
it('leaves a note, a firing and another agent\'s mail that arrive after a job was admitted for the next job, and reads a thread\'s rules by its parent channel',async()=>{
 const {f,cv,work}=await sharedPlace();
 const pond=f.root.services.conversations.open({agent:'art',venue:'slack',place:JSON.stringify(['TWORK','CPOND',null]),label:'pond'}).id;
 work(pond,[{kind:'person',id:'owner'}]);
 const at=(ms:number)=>new Date(f.clock.now()+ms).toISOString();
 f.root.writes.run(()=>{f.db.update(inbox).set({state:'waiting'}).where(eq(inbox.job,'other')).run();f.db.update(jobs).set({claimedAt:at(0)}).where(eq(jobs.id,'other')).run();});
 // The job was admitted and claimed for the owner's message. A note on a guest's word arrives before the body
 // takes its mail, in the very millisecond the job was claimed: what a job was started for is marked by admission
 // (inbox.job), and no clock is compared.
 let note='',spoke='',firing='',agents='';
 f.root.writes.run(()=>{note=f.root.services.conversations.send({conversation:pond,toKind:'agent',to:'art',source:'handoff',sourceId:'late',fromKind:'agent',fromId:'art',words:null as never,onWordKind:'outside',onWord:GUEST,chain:JSON.stringify([cv]),chainStartedAt:at(0)}).id;
  firing=f.root.services.conversations.send({conversation:pond,toKind:'agent',to:'art',source:'trigger',sourceId:'late-firing',fromKind:'schedule',words:'From the schedule'}).id;
  agents=f.root.services.conversations.send({conversation:pond,toKind:'agent',to:'art',source:'notice',sourceId:'late-agent',fromKind:'agent',fromId:'mark',words:'From another agent'}).id;
  spoke=f.root.services.conversations.send({conversation:pond,toKind:'agent',to:'art',source:'notice',sourceId:'late-person',fromKind:'person',fromId:'owner',words:'And another thing'}).id;});
 const offered=f.root.services.conversations.pending(pond,'other').map(item=>item.id);
 for(const late of [note,firing,agents])expect(offered).not.toContain(late);
 expect(offered).toContain(spoke);expect(offered).toHaveLength(2);
 // Taking leaves them too, and they are still waiting, for the job after this one.
 f.root.writes.run(()=>f.root.services.conversations.take(pond,'other'));
 for(const late of [firing,agents])expect(f.db.select().from(inbox).where(eq(inbox.id,late)).get()).toMatchObject({state:'waiting',job:null});
 // It is still waiting, for the job after this one.
 expect(f.db.select().from(inbox).where(eq(inbox.id,note)).get()).toMatchObject({state:'waiting',job:null});
 // A Discord thread's place names the thread; its rules are its parent channel's, as admission reads them.
 const thread=f.root.services.conversations.open({agent:'art',venue:'slack',place:JSON.stringify(['TWORK','CTHREAD',null]),label:'thread'}),first=f.db.select().from(bridgeIncoming).get()!;
 f.root.writes.run(()=>{f.db.insert(bridgeIncoming).values({...first,id:'bi:thread',channel:'CTHREAD',parent:'CROOM',conversation:thread.id}).run();
  f.db.update(bridgeChannels).set({reportsTo:JSON.stringify(['slack','TWORK','CPOND'])}).run();f.db.insert(bridgeChannelFilters).values({connection:'connection',rule:'only',channel:'CROOM'}).run();});
 expect(placeClosed(f.db,thread)).toBeUndefined();expect(reportsTo(f.db,thread)).toBe(JSON.stringify(['slack','TWORK','CPOND']));
 f.root.writes.run(()=>{f.db.delete(bridgeChannelFilters).run();f.db.insert(bridgeChannelFilters).values({connection:'connection',rule:'ignore',channel:'CROOM'}).run();});
 expect(placeClosed(f.db,thread)).toBe('its channel is filtered out');
 // A direct conversation's post that answers no message is erased at the keep time like its other words.
 f.root.writes.run(()=>{f.db.update(conversations).set({direct:true}).where(eq(conversations.id,pond)).run();
  f.db.insert(bridgeSends).values({id:'direct-answer',incoming:null,conversation:pond,connection:'connection',channel:'CPOND',text:'Private words',state:'sent',createdAt:at(0)}).run();});
 let erased=0;f.root.writes.run(()=>{erased=expirePrivateBridgeWords(f.db,at(60_000));});
 expect(erased).toBeGreaterThan(0);expect(f.db.select().from(bridgeSends).where(eq(bridgeSends.id,'direct-answer')).get()?.text).toBe('');
});
it('leaves a message that would make an owners\' job anybody else\'s for the next job, so the job\'s word never falls while it runs',async()=>{
 const {f,work}=await sharedPlace(),stamp=new Date(f.clock.now()).toISOString();
 f.root.writes.run(()=>{f.db.insert(members).values({id:'lodger',role:'member',joinedAt:stamp}).run();f.db.insert(memberAgents).values({member:'owner',agent:'art'}).run();});
 const pond=f.root.services.conversations.open({agent:'art',venue:'slack',place:JSON.stringify(['TWORK','CPOND',null]),label:'pond'}).id,job={id:'other',agent:'art',conversation:pond};
 // Admitted for the owner's message: that mail is marked with the job, and still waiting to be taken.
 work(pond,[{kind:'person',id:'owner'}]);f.root.writes.run(()=>{f.db.update(inbox).set({state:'waiting'}).where(eq(inbox.job,'other')).run();});
 expect(jobWord(f.db,job).woke).toBe('owners');
 const say=(sourceId:string,from:{fromKind:'person'|'unknown';fromId?:string})=>{let id='';f.root.writes.run(()=>{id=f.root.services.conversations.send({conversation:pond,toKind:'agent',to:'art',source:'notice',sourceId,words:'Late words',...from}).id;});return id;};
 // Before the body takes its mail, three more people write: a guest, a member who does not have the agent, and the owner again.
 const guest=say('late-guest',{fromKind:'unknown'}),lodger=say('late-lodger',{fromKind:'person',fromId:'lodger'}),again=say('late-owner',{fromKind:'person',fromId:'owner'});
 const offered=f.root.services.conversations.pending(pond,'other').map(item=>item.id);
 expect(offered).toContain(again);expect(offered).not.toContain(guest);expect(offered).not.toContain(lodger);expect(offered).toHaveLength(2);
 // The word is read from the mail the job is offered: it is still the owners' while the others' mail waits.
 expect(jobWord(f.db,job)).toEqual({woke:'owners',person:{kind:'member',id:'owner'}});
 expect(jobRoom(f.db,job)).toMatchObject({word:'owners',people:[{kind:'person',person:'owner',tier:null}]});
 f.root.writes.run(()=>f.root.services.conversations.take(pond,'other'));
 for(const late of [guest,lodger])expect(f.db.select().from(inbox).where(eq(inbox.id,late)).get()).toMatchObject({state:'waiting',job:null});
 expect(f.db.select().from(inbox).where(eq(inbox.id,again)).get()).toMatchObject({state:'taken',job:'other'});
 expect(jobWord(f.db,job).woke).toBe('owners');
 // A job that is anybody else's already loses nothing by more mail: it takes what comes.
 const brook=f.root.services.conversations.open({agent:'art',venue:'slack',place:JSON.stringify(['TWORK','CBROOK',null]),label:'brook'}).id;
 work(brook,[{kind:'person',id:'lodger'}]);f.root.writes.run(()=>{f.db.update(inbox).set({state:'waiting'}).where(eq(inbox.job,'other')).run();});
 let more='';f.root.writes.run(()=>{more=f.root.services.conversations.send({conversation:brook,toKind:'agent',to:'art',source:'notice',sourceId:'late-guest-2',fromKind:'unknown',words:'Late words'}).id;});
 expect(jobWord(f.db,{...job,conversation:brook}).woke).toBe('others');expect(f.root.services.conversations.pending(brook,'other').map(item=>item.id)).toContain(more);
});
it('holds a late answer to a card to the same rule: the owner\'s joins the running owners\' job, and anybody else\'s waits for the next',async()=>{
 const {f,work}=await sharedPlace(),stamp=new Date(f.clock.now()).toISOString(),mail=f.root.services.conversations;
 f.root.writes.run(()=>{f.db.insert(members).values({id:'lodger',role:'member',joinedAt:stamp}).run();f.db.insert(memberAgents).values({member:'owner',agent:'art'}).run();});
 const pond=mail.open({agent:'art',venue:'slack',place:JSON.stringify(['TWORK','CPOND',null]),label:'pond'}).id,job={id:'other',agent:'art',conversation:pond};
 work(pond,[{kind:'person',id:'owner'}]);f.root.writes.run(()=>{f.db.update(inbox).set({state:'waiting'}).where(eq(inbox.job,'other')).run();});
 // The running owners' job has asked two people a question each. Both answer while it runs (Conversations.answer: mail from that member).
 const ask=(to:string)=>{let id='';f.root.writes.run(()=>{id=mail.send({toKind:'person',to,conversation:pond,source:'thread',sourceId:'card-'+to,fromKind:'agent',fromId:'art',answers:'yes-no',words:'May I?'}).id;});return id;};
 const cards={lodger:ask('lodger'),owner:ask('owner')};
 f.root.writes.run(()=>{mail.answer(cards.lodger,'lodger','yes');mail.answer(cards.owner,'owner','no');});
 const answer=(card:string)=>f.db.select().from(inbox).where(and(eq(inbox.source,'answer'),eq(inbox.sourceId,card))).get()!;
 expect(answer(cards.lodger)).toMatchObject({toKind:'agent',fromKind:'person',fromId:'lodger',state:'waiting',job:null});
 // The member who does not have the agent would make the job anybody else's: that answer waits. The owner's joins.
 const offered=mail.pending(pond,'other').map(item=>item.id);
 expect(offered).toContain(answer(cards.owner).id);
 expect(offered).not.toContain(answer(cards.lodger).id);
 expect(jobWord(f.db,job).woke).toBe('owners');
 f.root.writes.run(()=>mail.take(pond,'other'));
 expect(answer(cards.lodger)).toMatchObject({state:'waiting',job:null});expect(answer(cards.owner)).toMatchObject({state:'taken',job:'other'});
});
it('reads a job\'s mail once to say its word, however much waits: the work grows with the mail and no faster',async()=>{
 const {f,work}=await sharedPlace();f.root.writes.run(()=>{f.db.insert(memberAgents).values({member:'owner',agent:'art'}).run();});
 const pond=f.root.services.conversations.open({agent:'art',venue:'slack',place:JSON.stringify(['TWORK','CPOND',null]),label:'pond'}).id,job={id:'other',agent:'art',conversation:pond};
 work(pond,[{kind:'person',id:'owner'}]);f.root.writes.run(()=>{f.db.update(inbox).set({state:'waiting'}).where(eq(inbox.job,'other')).run();});
 const late=(count:number)=>f.root.writes.run(()=>{for(let n=0;n<count;n++)f.root.services.conversations.send({conversation:pond,toKind:'agent',to:'art',source:'notice',sourceId:randomUUID(),fromKind:'unknown',words:'Late words'});});
 // Every statement loom runs to say the word, and every row those statements read from the inbox.
 const cost=()=>{const prepare=f.client.prepare.bind(f.client);let statements=0;const spy=vi.spyOn(f.client,'prepare').mockImplementation((sql:string)=>{statements++;return prepare(sql);});
  try{expect(jobWord(f.db,job).woke).toBe('owners');expect(f.root.services.conversations.pending(pond,'other')).toHaveLength(1);}finally{spy.mockRestore();}return statements;};
 const none=cost();late(8);const eight=cost();late(8);const sixteen=cost();late(16);const thirtyTwo=cost();
 // Each waiting piece costs the same few statements, whether sixteen wait or thirty-two.
 expect(eight).toBeGreaterThan(none);
 expect(thirtyTwo-sixteen).toBe(2*(sixteen-eight));
 expect((sixteen-eight)/8).toBeLessThanOrEqual(4);
});
it('lets only an agent\'s own work post a text straight to a channel it has a rule for',async()=>{
 const {f,cv,work}=await sharedPlace(()=>false);
 const post=(to:unknown)=>({id:randomUUID(),to,text:'Standup: all green',model:'observed'}),croom={platform:'slack',workspace:'TWORK',channel:'CROOM'};
 // The shared place's body works for a guest: it posts nowhere this way.
 expect((await f.call('bridges','post',post(croom))).status).toBe(403);
 const lane=f.root.services.conversations.open({agent:'art',venue:'wake',place:'standup',label:'Standup'}).id;
 // A job with a person behind it, an owner included, hands a note instead.
 work(lane,[{kind:'person',id:'owner'}]);expect((await f.call('bridges','post',post(croom),token.other)).status).toBe(403);
 work(lane,[]);
 expect((await f.call('bridges','post',post({...croom,channel:'CNORULE'}),token.other)).status).toBe(400);
 const done=await f.call('bridges','post',post(croom),token.other);expect(done.status).toBe(200);
 const posted=made(done.body);
 expect(f.db.select().from(conversations).where(eq(conversations.id,posted)).get()).toMatchObject({venue:'slack',place:JSON.stringify(['TWORK','CROOM',null])});expect(posted).not.toBe(cv);
 // Through the queue, held while effects are off, with the agent's turn written there.
 expect(f.db.select().from(bridgeSends).all()).toMatchObject([{incoming:null,conversation:posted,channel:'CROOM',thread:null,text:'Standup: all green',state:'held'}]);
 expect(f.db.select().from(turns).all().at(-1)).toMatchObject({conversation:posted,kind:'reply',run:'other'});
 const held=f.db.select().from(bridgeSends).get()!.id;
 expect((await f.call('bridges','command',{action:'review',id:held,decision:'release'},token.owner)).status).toBe(200);
 expect(f.db.select().from(bridgeSends).get()?.state).not.toBe('held');
 // Mail from an agent on nobody's word is not the agent's own work: such a job posts nothing this way and hands nowhere.
 f.root.writes.run(()=>{const item=f.root.services.conversations.send({conversation:lane,toKind:'agent',to:'art',source:'notice',sourceId:'from-an-agent',fromKind:'agent',fromId:'mark',words:'Post this for me'});f.db.update(inbox).set({job:'other',state:'taken'}).where(eq(inbox.id,item.id)).run();});
 expect(jobWord(f.db,{id:'other',agent:'art',conversation:lane})).toEqual({woke:'others'});
 expect((await f.call('bridges','post',post(croom),token.other)).status).toBe(403);
 f.root.writes.run(()=>f.db.delete(inbox).where(eq(inbox.sourceId,'from-an-agent')).run());
 // A job posts at most twenty messages to one place, counting its own only: another job's posts there do not count against it.
 f.root.writes.run(()=>f.db.insert(bridgeSends).values(Array.from({length:30},(_,index)=>({id:'theirs-'+index,incoming:null,conversation:posted,connection:'connection',channel:'CROOM',text:'x',state:'sent' as const,createdAt:new Date(f.clock.now()).toISOString()}))).run());
 for(let n=1;n<20;n++)expect((await f.call('bridges','post',post(croom),token.other)).status,String(n)).toBe(200);
 expect((await f.call('bridges','post',post(croom),token.other)).status).toBe(409);
 expect(f.request.mock.calls.some(([url])=>String(url).endsWith('chat.postMessage'))).toBe(false);
});

it('keys what a body may do with a trigger or a note on whose word it works, not on where it is',async()=>{
 const {f,cv,once,work}=await sharedPlace();
 const stamp=new Date(f.clock.now()).toISOString();
 f.root.writes.run(()=>{f.db.insert(members).values({id:'kim',role:'member',joinedAt:stamp}).run();f.db.insert(memberAgents).values([{member:'kim',agent:'art'},{member:'owner',agent:'art'}]).run();
  f.db.insert(bridgeChannels).values({platform:'slack',workspace:'TWORK',channel:'CPOND',answers:'art',botsMayTalk:false}).run();f.db.update(bridgeChannels).set({reportsTo:JSON.stringify(['slack','TWORK','CPOND'])}).where(eq(bridgeChannels.channel,'CROOM')).run();});
 const note=(to:unknown)=>({to,clientId:randomUUID(),label:'Note',words:'Words'}),pond={platform:'slack',workspace:'TWORK',channel:'CPOND'};
 // The guest's body sets its own trigger. It is awake and can do the work now: it fires nothing by hand.
 const guests=once();expect((await f.call('tempo','set',guests)).status).toBe(200);
 expect((await f.call('tempo','runNow',{id:guests.id})).status).toBe(403);
 expect(f.db.select().from(inbox).where(eq(inbox.source,'trigger')).all()).toEqual([]);
 // A times-only edit by somebody else keeps the asker: the words are still the guest's.
 f.root.writes.run(()=>f.db.update(triggers).set({times:'09:00',lifespan:'until-stopped'}).where(eq(triggers.id,guests.id)).run());
 expect((await f.call('tempo','edit',{id:guests.id,times:'10:00'},token.owner)).status).toBe(200);
 expect(f.db.select().from(triggers).where(eq(triggers.id,guests.id)).get()).toMatchObject({askedByKind:'outside',askedBy:GUEST,times:'10:00'});
 // An outside account whose tier the owner took away is a stranger: its body hands nowhere, the report target included.
 f.root.writes.run(()=>f.db.delete(agentPeople).run());
 expect((await f.call('conversation','handoff',note(pond))).status).toBe(403);
 f.root.writes.run(()=>f.db.insert(agentPeople).values({agent:'art',person:GUEST,tier:2}).run());
 // The agent, outside the place, sets a half-hourly trigger and one that watches an event for this conversation.
 const half=once({lifespan:'until-stopped',times:'09:00,09:30'});expect((await f.call('tempo','set',half,token.other)).status).toBe(200);
 // A trigger that watches an event has no listed times: through the door, a shared place's body sets none, even for its own conversation.
 let question='';f.root.writes.run(()=>{question=f.root.services.conversations.send({toKind:'person',to:'owner',member:'owner',source:'notice',sourceId:'a-question',fromKind:'unknown',words:'Shall I?'}).id;});
 const mail=f.db.select().from(inbox).all().find(item=>item.job==='body')!.id;
 const watching=(watches:string,more:Record<string,unknown>={})=>once({sourceKind:'answer',watches,times:undefined,lifespan:'until-stopped',...more});
 expect(await f.call('tempo','set',watching(`question:${mail}`))).toMatchObject({status:403,body:{message:WORD_EVENT_REFUSAL}});
 // The owner sets one for this conversation, from outside it.
 const watch=watching(`question:${question}`);expect(await f.call('tempo','set',watch,token.owner)).toMatchObject({status:200});
 expect(f.db.select().from(triggers).where(eq(triggers.id,watch.id)).get()).toMatchObject({sourceKind:'answer',conversation:cv,askedByKind:'member',askedBy:'owner'});
 // The owner speaks in the place: the body there now works on the owner's word, and may stop and reword what
 // stands for its conversation however often it repeats.
 f.root.writes.run(()=>{f.db.update(inbox).set({fromKind:'person',fromId:'owner'}).where(eq(inbox.job,'body')).run();});
 // The one that watches an event too: the owner-woken body there stops it, starts it and rewords it.
 expect(await f.call('tempo','stop',{id:watch.id})).toMatchObject({status:200});expect(await f.call('tempo','start',{id:watch.id})).toMatchObject({status:200});
 expect(await f.call('tempo','edit',{id:watch.id,instructions:'Reworded where it fires'})).toMatchObject({status:200});
 expect(f.db.select().from(triggers).where(eq(triggers.id,watch.id)).get()).toMatchObject({instructions:'Reworded where it fires',state:'standing',askedByKind:'member',askedBy:'owner'});
 expect((await f.call('tempo','edit',{id:half.id,instructions:'Reworded by the owner\'s body'})).status).toBe(200);
 // On an owner's word the hourly minimum is not asked either: reach follows the person, not the place.
 expect((await f.call('tempo','edit',{id:half.id,times:'09:00,09:10'})).status).toBe(200);
 expect((await f.call('tempo','stop',{id:half.id})).status).toBe(200);expect((await f.call('tempo','start',{id:half.id})).status).toBe(200);
 // No job fires again the trigger whose firing woke it, whoever it works for.
 expect((await f.call('tempo','runNow',{id:half.id})).status).toBe(200);
 const fired=f.db.select().from(inbox).where(eq(inbox.source,'trigger')).get()!;
 f.root.writes.run(()=>f.db.update(inbox).set({job:'body',state:'taken'}).where(eq(inbox.id,fired.id)).run());
 for(const action of ['runNow','start'])expect((await f.call('tempo',action,{id:half.id})).status,action).toBe(403);
 // One member's private conversation is named only on that member's word, or by the agent's own work.
 const kims=f.root.services.conversations.open({agent:'art',venue:'slack',place:JSON.stringify(['TWORK','DKIM',null,['member','kim']]),label:'kim',member:'kim',direct:true}).id;
 const owners=once({conversation:kims,ownerKind:'member',owner:'owner'});
 expect((await f.call('tempo','set',owners,token.owner)).status).toBe(403);
 const lane=f.root.services.conversations.open({agent:'art',venue:'wake',place:'standup',label:'Standup'}).id;
 work(lane,[{kind:'person',id:'owner'}]);expect((await f.call('conversation','handoff',note({conversation:kims}),token.other)).status).toBe(403);
 work(lane,[{kind:'person',id:'kim'}]);expect((await f.call('conversation','handoff',note({conversation:kims}),token.other)).status).toBe(200);
 work(lane,[]);expect((await f.call('conversation','handoff',note({conversation:kims}),token.other)).status).toBe(200);
 expect((await f.call('tempo','set',once({conversation:kims}),token.other)).status).toBe(200);
 // What a body may schedule follows its job's word everywhere. A member who does not have the agent is not
 // its owner: a job on that word, in a place that is no shared place (a lane's wake here; a brief's conversation
 // is the same), schedules nothing but into its own bridge conversation, and it has none. Before, it set a
 // trigger of the agent's own, and its words then ran with the agent's whole reach.
 f.root.writes.run(()=>f.db.insert(members).values({id:'sam',role:'member',joinedAt:stamp}).run());
 const plain=()=>once({conversation:undefined});
 work(lane,[{kind:'person',id:'sam'}]);
 expect(jobWord(f.db,{id:'other',agent:'art',conversation:lane})).toEqual({woke:'others',person:{kind:'member',id:'sam'}});
 expect(await f.call('tempo','set',plain(),token.other)).toMatchObject({status:403,body:{message:SHARED_PLACE_LINE}});
 expect(await f.call('tempo','set',once({conversation:cv}),token.other)).toMatchObject({status:403,body:{message:SHARED_PLACE_LINE}});
 // The same job with a member who has the agent behind it, and the agent's own work, schedule as before.
 work(lane,[{kind:'person',id:'kim'}]);expect((await f.call('tempo','set',plain(),token.other)).status).toBe(200);
 work(lane,[]);const owned=plain();expect((await f.call('tempo','set',owned,token.other)).status).toBe(200);
 // On sam's word again: nothing of the agent's is reworded, stopped or started either, as from a shared place.
 work(lane,[{kind:'person',id:'sam'}]);
 expect((await f.call('tempo','edit',{id:owned.id,instructions:'Sam\'s words'},token.other)).status).toBe(403);
 for(const action of ['stop','start','runNow'])expect((await f.call('tempo',action,{id:owned.id},token.other)).status,action).toBe(403);
 expect(f.db.select().from(triggers).where(eq(triggers.id,owned.id)).get()).toMatchObject({instructions:'Post the numbers',state:'standing',lastFiredAt:null});
});

/** What admission needs before it starts a job for the agent, and the Jobs service on the fixture's clock. */
const runnable=(f:ReturnType<typeof fixture>)=>{f.root.writes.run(()=>{f.db.insert(agentModels).values({agent:'art',model:'primary',position:0}).run();f.db.insert(agentRunSettings).values({agent:'art',houseRepository:'r',houseFile:'Housefile',houseBranch:'main',nestedContainers:false,gpu:false}).run();});return new Jobs(f.db,()=>new Date(f.clock.now()).toISOString());};
it('starts a job at admission for a note and for a firing, and drops one whose word is no longer known, with its reason and a notice',async()=>{
 const {f,cv,once}=await sharedPlace(),all=runnable(f);
 const pond=f.root.services.conversations.open({agent:'art',venue:'slack',place:JSON.stringify(['TWORK','CPOND',null]),label:'pond'}).id;
 const note=(conversation:string,id:string)=>{let item='';f.root.writes.run(()=>{item=f.root.services.conversations.send({conversation,toKind:'agent',to:'art',source:'handoff',sourceId:id,fromKind:'agent',fromId:'art',words:null as never,onWordKind:'outside',onWord:GUEST,chain:JSON.stringify([cv]),chainStartedAt:new Date(f.clock.now()).toISOString()}).id;});return item;};
 const row=(id:string)=>f.db.select().from(inbox).where(eq(inbox.id,id)).get()!,end=(job:string)=>f.root.writes.run(()=>{f.db.update(inbox).set({state:'done'}).where(eq(inbox.job,job)).run();f.db.update(jobs).set({state:'done'}).where(eq(jobs.id,job)).run();});
 const dropped=()=>f.db.select().from(inbox).where(eq(inbox.source,'notice')).all().filter(item=>item.sourceId?.startsWith('word-unknown:'));
 // A note on the guest's word, in a conversation with no job: admission starts that conversation's job, for the note.
 const first=note(pond,'first');let started=all.admission(pond);
 expect(started).toMatchObject({started:true,job:{agent:'art',conversation:pond,member:null,state:'queued'}});expect(row(first)).toMatchObject({state:'waiting',job:started.job!.id});
 end(started.job!.id);
 // A firing in the shared place, asked for by the guest: the same.
 const mine=once();expect((await f.call('tempo','set',mine)).status).toBe(200);end('body');
 expect((await f.call('tempo','runNow',{id:mine.id},token.other)).status).toBe(200);
 const fired=f.db.select().from(inbox).where(eq(inbox.source,'trigger')).get()!;
 started=all.admission(cv);
 expect(started).toMatchObject({started:true,job:{conversation:cv,state:'queued'}});expect(row(fired.id)).toMatchObject({state:'waiting',job:started.job!.id});
 // A person says stop there. A note that arrives is parked with the stopped job; nobody asks about its word yet.
 const working=started.job!.id;f.root.writes.run(()=>f.db.update(jobs).set({state:'running'}).where(eq(jobs.id,working)).run());
 const parked=note(cv,'parked');f.root.writes.run(()=>all.stop(working,'owner','stop'));
 f.root.writes.run(()=>f.db.delete(agentPeople).run());
 expect(all.admission(cv)).toEqual({});expect(row(parked)).toMatchObject({state:'waiting',job:working});expect(dropped()).toEqual([]);
 // The owner has taken the guest's tier away. A note on that word starts no job: it is dropped with its reason, and the owner is told.
 const late=note(pond,'late');
 expect(all.admission(pond)).toEqual({noticed:true});
 expect(row(late)).toMatchObject({state:'resolved',job:null,resolution:expect.stringContaining('on whose word it was sent, is no longer known to art')});
 expect(f.db.select().from(jobs).all().filter(job=>job.conversation===pond&&job.state==='queued')).toEqual([]);
 expect(dropped()).toMatchObject([{toKind:'person',to:'owner',words:expect.stringContaining('was dropped and started no work')}]);
 // A person speaks where the note is parked: it is released, asked about then, and dropped; the job that starts is for the person's words alone.
 let spoke='';f.root.writes.run(()=>{spoke=f.root.services.conversations.send({conversation:cv,toKind:'agent',to:'art',source:'notice',sourceId:'spoke',fromKind:'person',fromId:'owner',words:'Go on'}).id;});
 started=all.admission(cv);
 expect(started).toMatchObject({started:true});expect(row(spoke).job).toBe(started.job!.id);
 expect(row(parked)).toMatchObject({state:'resolved'});
 // So is the firing the stopped job had not taken: it was asked for by the same guest.
 expect(row(fired.id)).toMatchObject({state:'resolved'});expect(dropped()).toHaveLength(3);expect(dropped().map(item=>item.words)).toContainEqual(expect.stringContaining('A firing of a schedule'));
 // A member's word is asked about the same way: one who has left the household is no longer known.
 f.root.writes.run(()=>{f.db.insert(members).values({id:'sam',role:'member',joinedAt:new Date(f.clock.now()).toISOString()}).run();f.db.insert(agentPeople).values({agent:'art',person:GUEST,tier:2}).run();});
 let sams='';f.root.writes.run(()=>{sams=f.root.services.conversations.send({conversation:pond,toKind:'agent',to:'art',source:'handoff',sourceId:'sams',fromKind:'agent',fromId:'art',words:null as never,onWordKind:'member',onWord:'sam',chain:JSON.stringify([cv]),chainStartedAt:new Date(f.clock.now()).toISOString()}).id;});
 f.root.writes.run(()=>f.db.update(members).set({removedAt:new Date(f.clock.now()).toISOString()}).where(eq(members.id,'sam')).run());
 expect(all.admission(pond)).toEqual({noticed:true});expect(row(sams).state).toBe('resolved');
});

it('judges the thread of a channel target before any conversation is opened: none on Discord, a message of the channel on Slack',async()=>{
 const {f,work}=await sharedPlace(()=>false);
 const guild='100000000000000001',channel='100000000000000002',at=new Date(f.clock.now()).toISOString();
 f.root.writes.run(()=>{f.db.insert(bridgeConnections).values({id:'discord',platform:'discord',workspace:guild,botUser:'100000000000000003',agent:'art',tokenSecret:'TOKEN',enabled:true,state:'disconnected',stateAt:at}).run();
  f.db.insert(bridgeChannels).values({platform:'discord',workspace:guild,channel,answers:'art',botsMayTalk:false}).run();});
 const lane=f.root.services.conversations.open({agent:'art',venue:'wake',place:'standup',label:'Standup'}).id;work(lane,[]);
 const before=f.db.select().from(conversations).all().length,discord={platform:'discord',workspace:guild,channel},slack={platform:'slack',workspace:'TWORK',channel:'CROOM'};
 const note=(to:unknown)=>f.call('conversation','handoff',{to,clientId:randomUUID(),label:'Note',words:'Words'},token.other),post=(to:unknown)=>f.call('bridges','post',{id:randomUUID(),to,text:'Words',model:'observed'},token.other);
 // A Discord thread is a channel of its own, and loom posts to no thread under one: a target naming one could
 // open a conversation whose every post is refused. On Slack a thread is the time of the message that started it.
 for(const to of [{...discord,thread:'100000000000000009'},{...discord,thread:channel},{...slack,thread:'not-a-message'}]){
  expect((await note(to)).status,JSON.stringify(to)).toBe(400);expect((await post(to)).status,JSON.stringify(to)).toBe(400);}
 expect(f.db.select().from(conversations).all()).toHaveLength(before);expect(f.db.select().from(inbox).where(eq(inbox.source,'handoff')).all()).toEqual([]);expect(f.db.select().from(bridgeSends).all()).toEqual([]);
 // The channel itself on Discord, and a real thread on Slack, are places like any other.
 expect((await note(discord)).status).toBe(200);expect((await post(discord)).status).toBe(200);
 expect((await note({...slack,thread:'1794432000.000001'})).status).toBe(200);
});

it('queues no answer to a firing or a note once the conversation\'s channel is filtered out, and says why',async()=>{
 const {f,cv}=await sharedPlace(()=>false);
 f.root.writes.run(()=>{f.db.update(inbox).set({state:'done'}).where(eq(inbox.job,'body')).run();f.db.update(jobs).set({state:'done'}).where(eq(jobs.id,'body')).run();f.db.update(jobs).set({conversation:cv}).where(eq(jobs.id,'other')).run();
  const fired=f.root.services.conversations.send({conversation:cv,toKind:'agent',to:'art',source:'trigger',sourceId:'tr:now',fromKind:'schedule',words:'Post the numbers',onWordKind:'outside',onWord:GUEST});
  f.db.update(inbox).set({job:'other',state:'taken'}).where(eq(inbox.id,fired.id)).run();
  // After the firing arrived the owner filtered the channel out: a message there would no longer be heard.
  f.db.insert(bridgeChannelFilters).values({connection:'connection',rule:'ignore',channel:'CROOM'}).run();});
 const closed={status:400,body:{message:'Nothing can be posted there: its channel is filtered out'}};
 expect(await f.call('bridges','reply',{id:randomUUID(),text:'The numbers',model:'observed'},token.other)).toMatchObject(closed);
 expect(await f.call('bridges','say',{id:randomUUID(),text:'Working'},token.other)).toMatchObject(closed);
 expect(f.db.select().from(bridgeSends).all()).toEqual([]);
 f.root.writes.run(()=>f.db.delete(bridgeChannelFilters).run());
 expect((await f.call('bridges','reply',{id:randomUUID(),text:'The numbers',model:'observed'},token.other)).status).toBe(200);
 expect(f.db.select().from(bridgeSends).all()).toMatchObject([{incoming:null,conversation:cv,state:'held'}]);
});

it('tells the body a note reaches how to answer only when a note back would be taken',async()=>{
 const {f,cv,work}=await sharedPlace();
 f.root.writes.run(()=>{f.db.insert(bridgeChannels).values({platform:'slack',workspace:'TWORK',channel:'CPOND',answers:'art',botsMayTalk:false}).run();f.db.update(bridgeChannels).set({reportsTo:JSON.stringify(['slack','TWORK','CPOND'])}).where(eq(bridgeChannels.channel,'CROOM')).run();
  f.db.insert(memberAgents).values({member:'owner',agent:'art'}).run();});
 const hand=selfHandoff(f.db,{send:()=>undefined},()=>new Date(f.clock.now()).toISOString()),row=(id:string)=>f.db.select().from(conversations).where(eq(conversations.id,id)).get()!;
 const told=(job:string,from:string,to:unknown)=>hand.target({job:{id:job,agent:'art',conversation:from},cv:row(from)},to as never).told,pond={platform:'slack',workspace:'TWORK',channel:'CPOND'};
 const back=`To answer that body, hand a note back to conversation ${cv}.`,none='A note back to that body would be refused from here.';
 // On a guest's word, to the channel this one reports to: that channel reports nowhere, so its body could hand nothing back.
 expect(told('body',cv,pond)).toContain(none);expect(told('body',cv,pond)).not.toContain('To answer that body');
 // On an owner's word the body there may hand to any conversation of the agent.
 f.root.writes.run(()=>f.db.update(inbox).set({fromKind:'person',fromId:'owner'}).where(eq(inbox.job,'body')).run());
 expect(told('body',cv,pond)).toContain(back);expect(told('body',cv,pond)).not.toContain(none);
 // On a guest's word again, into a channel that reports back here: still none. A guest's word goes one hop, and the body a note woke hands nowhere.
 f.root.writes.run(()=>{f.db.update(inbox).set({fromKind:'unknown',fromId:null}).where(eq(inbox.job,'body')).run();f.db.update(bridgeChannels).set({reportsTo:JSON.stringify(['slack','TWORK','CROOM'])}).where(eq(bridgeChannels.channel,'CPOND')).run();});
 expect(told('body',cv,pond)).toContain(none);
 // The agent's own work in a wake: a wake is never a note's target, and a note on nobody's word hands nowhere.
 const lane=f.root.services.conversations.open({agent:'art',venue:'wake',place:'standup',label:'Standup'}).id;work(lane,[]);
 expect(told('other',lane,pond)).toContain(none);expect(told('other',lane,pond)).not.toContain('To answer that body');
});

it('carries the sending job\'s word on a brief to another agent, through the door, so the job it starts is never that agent\'s own work',async()=>{
 const {f,work}=await sharedPlace(()=>false),stamp=new Date(f.clock.now()).toISOString(),marks='d'.repeat(64);
 f.root.writes.run(()=>{f.db.insert(agents).values({id:'mark',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();f.db.insert(memberAgents).values([{member:'owner',agent:'art'},{member:'owner',agent:'mark'}]).run();
  f.db.insert(bridgeChannels).values({platform:'slack',workspace:'TWORK',channel:'CMARK',answers:'mark',botsMayTalk:false}).run();});
 const brief=(credential:string)=>f.call('conversation','handoff',{agent:'mark',clientId:randomUUID(),label:'For mark',words:'Look into X'},credential);
 /** The latest brief in a conversation: every brief from one job goes to the one conversation that job opened. */
 const item=(conversation:string)=>f.db.select().from(inbox).all().filter(row=>row.conversation===conversation).sort((a,b)=>b.seq!-a.seq!)[0];
 /** Mark's job, working in the conversation a brief opened, holding that brief. */
 const taken=(conversation:string,job:string)=>{f.root.writes.run(()=>{f.db.insert(jobs).values({id:job,agent:'mark',box:'box',conversation,title:'',brief:'',model:'test',state:'running',startedByKind:'agent',startedBy:'mark',houseRepository:'',houseFile:'',houseBranch:'',queuedAt:stamp}).run();
  f.db.update(inbox).set({job,state:'taken'}).where(eq(inbox.id,item(conversation).id)).run();});return {id:job,agent:'mark',conversation};};
 // The guest's body in the shared place briefs mark: two agents one member has are peers, and the place is no member's.
 const first=await brief(token.body);expect(first.status).toBe(200);
 const guests=made(first.body);
 expect(f.db.select().from(conversations).where(eq(conversations.id,guests)).get()).toMatchObject({agent:'mark',venue:'handoff',member:null});
 expect(item(guests)).toMatchObject({toKind:'agent',to:'mark',source:'handoff',fromKind:'agent',fromId:'art',onWordKind:'outside',onWord:GUEST});
 // Mark's job counts the guest as in the room: an account mark's owner gave no tier, so nothing is done on its word.
 const job=taken(guests,'marks');
 expect(workerPolicy(f.db,job).people).toEqual([{kind:'outside',person:GUEST,tier:null}]);expect(jobWord(f.db,job)).toEqual({woke:'others'});
 // Through the doors: it posts nothing as mark's own work, and sets no trigger of mark's own.
 f.root.writes.run(()=>f.db.insert(tokens).values({fingerprint:createHash('sha256').update(marks).digest('hex'),label:'marks',kind:'agent',agent:'mark',job:'marks',createdAt:stamp}).run());
 expect((await f.call('bridges','post',{id:randomUUID(),to:{platform:'slack',workspace:'TWORK',channel:'CMARK'},text:'Words',model:'observed'},marks)).status).toBe(403);
 expect(await f.call('tempo','set',{id:randomUUID(),ownerKind:'agent',owner:'mark',sourceKind:'time',times:new Date(f.clock.now()+86_400_000).toISOString(),lifespan:'once',targetKind:'inbox',toKind:'agent',to:'mark',instructions:'The guest\'s words',note:'Later'},marks)).toMatchObject({status:403,body:{message:SHARED_PLACE_LINE}});
 // On an owner's word the brief carries the owner, and mark's job works for owners.
 const lane=f.root.services.conversations.open({agent:'art',venue:'wake',place:'standup',label:'Standup'}).id;work(lane,[{kind:'person',id:'owner'}]);
 const second=await brief(token.other);expect(second.status).toBe(200);
 expect(item(made(second.body))).toMatchObject({onWordKind:'member',onWord:'owner'});
 expect(jobWord(f.db,taken(made(second.body),'marks-2'))).toEqual({woke:'owners',person:{kind:'member',id:'owner'}});
 // The agent's own work carries nobody's word. Mail from an agent on nobody's word is anybody else's: still not mark's own work.
 f.root.writes.run(()=>f.db.update(jobs).set({state:'done'}).where(eq(jobs.id,'marks-2')).run());
 work(lane,[]);const third=await brief(token.other);expect(third.status).toBe(200);
 expect(item(made(third.body))).toMatchObject({onWordKind:null,onWord:null});
 expect(jobWord(f.db,taken(made(third.body),'marks-3'))).toEqual({woke:'others'});
});

it('holds a shared place\'s body to the shared-place bounds only when it works for anybody but owners',async()=>{
 const {f,cv,once,work}=await sharedPlace(),stamp=new Date(f.clock.now()).toISOString();
 f.root.writes.run(()=>{f.db.insert(members).values({id:'kim',role:'member',joinedAt:stamp}).run();f.db.insert(memberAgents).values([{member:'owner',agent:'art'},{member:'kim',agent:'art'}]).run();});
 const elsewhere=f.root.services.conversations.open({agent:'art',venue:'slack',place:JSON.stringify(['TWORK','COTHER',null]),label:'other'}).id;
 const mail=f.db.select().from(inbox).all().find(item=>item.job==='body')!.id;
 // The three a guest-woken body there is refused, one that watches an event, and a repeating one, which is asked of
 // the owners and not set.
 const asks=():[string,ReturnType<typeof once>,string|undefined][]=>[
  ['half-hourly',once({lifespan:'until-stopped',times:'09:00,09:30'}),undefined],
  ['a file',once({instructions:undefined,file:'lanes/numbers.md'}),WORD_FILE_REFUSAL],
  ['another conversation',once({conversation:elsewhere}),SHARED_PLACE_LINE],
  ['an ordinary wake',once({conversation:undefined}),SHARED_PLACE_LINE],
  ['an event',once({sourceKind:'answer',watches:`question:${mail}`,times:undefined,lifespan:'until-stopped'}),WORD_EVENT_REFUSAL]];
 for(const [name,trigger,message] of asks())expect(await f.call('tempo','set',trigger),name).toMatchObject(message?{status:403,body:{message}}:{status:200,body:{value:{waits:SCHEDULE_ASKED}}});
 expect(f.db.select().from(triggers).all()).toEqual([]);
 // The line is true wherever it is shown: it speaks of whose word the job is on, not of where the body sits.
 expect(SHARED_PLACE_LINE).toBe('This job is not working for the agent\'s owners, so it schedules only into the Discord or Slack conversation it is working in, if that is a shared place. Ask in your own thread, or have an owner schedule it.');
 // The agent sets a trigger of its own outside the place, for later.
 const outside=once({conversation:undefined});expect((await f.call('tempo','set',outside,token.other)).status).toBe(200);
 // The owner speaks there. Reach follows the person: the body now does what it could from the owner's own thread.
 f.root.writes.run(()=>f.db.update(inbox).set({fromKind:'person',fromId:'owner'}).where(eq(inbox.job,'body')).run());
 expect(jobWord(f.db,{id:'body',agent:'art',conversation:cv}).woke).toBe('owners');
 const set=asks();for(const [name,trigger] of set)expect(await f.call('tempo','set',trigger),name).toMatchObject({status:200});
 // A trigger naming a conversation is asked for by the owner; an ordinary wake is the agent's own, as from the owner's thread.
 expect(f.db.select().from(triggers).where(eq(triggers.id,set[2][1].id)).get()).toMatchObject({conversation:elsewhere,askedByKind:'member',askedBy:'owner'});
 expect(f.db.select().from(triggers).where(eq(triggers.id,set[3][1].id)).get()).toMatchObject({conversation:null,ownerKind:'agent',owner:'art',askedByKind:null});
 // It rewords, stops, starts and runs any of the agent's triggers, and moves one to any times.
 expect((await f.call('tempo','edit',{id:outside.id,instructions:'Reworded from the shared place'})).status).toBe(200);
 for(const action of ['stop','start','runNow'])expect((await f.call('tempo',action,{id:outside.id})).status,action).toBe(200);
 expect((await f.call('tempo','edit',{id:set[0][1].id,times:'09:00,09:10'})).status).toBe(200);
 // What holds for everybody still holds. One member's private conversation is named only on that member's word.
 const kims=f.root.services.conversations.open({agent:'art',venue:'slack',place:JSON.stringify(['TWORK','DKIM',null,['member','kim']]),label:'kim',member:'kim',direct:true}).id;
 expect((await f.call('tempo','set',once({conversation:kims}))).status).toBe(403);
 // No job starts again the trigger whose firing is in its mail.
 f.root.writes.run(()=>{const fired=f.root.services.conversations.send({conversation:cv,toKind:'agent',to:'art',source:'trigger',sourceId:'own-firing',fromKind:'schedule',words:'Fired',refs:[outside.id]});f.db.update(inbox).set({job:'body',state:'taken'}).where(eq(inbox.id,fired.id)).run();});
 for(const action of ['runNow','start'])expect((await f.call('tempo',action,{id:outside.id})).status,action).toBe(403);
 // No number of schedules is refused for one conversation: an eleventh is set like the first.
 const standing=()=>f.db.select().from(triggers).all().filter(row=>row.conversation===cv&&row.enabled).length;
 while(standing()<PLACE_TRIGGERS_NOTICE_EVERY)expect((await f.call('tempo','set',once())).status).toBe(200);
 expect((await f.call('tempo','set',once())).status).toBe(200);
 // A member who has the agent and is no household owner speaks instead. From her own thread what she has the
 // agent schedule is her private work, and the agent's own triggers are not hers to reword or start: the same from here.
 f.root.writes.run(()=>f.db.update(inbox).set({fromId:'kim'}).where(eq(inbox.id,mail)).run());
 expect(jobWord(f.db,{id:'body',agent:'art',conversation:cv})).toEqual({woke:'owners',person:{kind:'member',id:'kim'}});
 const hers=once({conversation:undefined});expect((await f.call('tempo','set',hers)).status).toBe(200);
 expect(f.db.select().from(triggers).where(eq(triggers.id,hers.id)).get()).toMatchObject({ownerKind:'member',owner:'kim',member:'kim',conversation:null});
 expect((await f.call('tempo','edit',{id:set[3][1].id,instructions:'Kim\'s words as the agent\'s own'})).status).toBe(403);
 expect((await f.call('tempo','edit',{id:hers.id,instructions:'Her own, reworded'})).status).toBe(200);
 // Least reach wins in a mixed batch: with somebody loom cannot name beside her, every bound is back.
 f.root.writes.run(()=>{const item=f.root.services.conversations.send({conversation:cv,toKind:'agent',to:'art',source:'notice',sourceId:'somebody',fromKind:'unknown',words:'Me too'});f.db.update(inbox).set({job:'body',state:'taken'}).where(eq(inbox.id,item.id)).run();});
 expect(jobWord(f.db,{id:'body',agent:'art',conversation:cv})).toEqual({woke:'others'});
 // (A firing is among this job's mail too, so what would fire into its own conversation is refused for that.)
 for(const [name,trigger] of asks())expect((await f.call('tempo','set',trigger)).status,name).toBe(403);
 expect((await f.call('tempo','stop',{id:outside.id})).status).toBe(403);
 void work;
});

it('delivers mail into one member\'s private conversation only on that member\'s word or as the agent\'s own work: at the doors, at the firing and at admission',async()=>{
 const {f,cv,once}=await sharedPlace(),all=runnable(f),stamp=new Date(f.clock.now()).toISOString();
 f.root.writes.run(()=>{f.db.insert(members).values({id:'kim',role:'member',joinedAt:stamp}).run();f.db.insert(memberAgents).values([{member:'owner',agent:'art'},{member:'kim',agent:'art'}]).run();});
 const kims=f.root.services.conversations.open({agent:'art',venue:'slack',place:JSON.stringify(['TWORK','DKIM',null,['member','kim']]),label:'kim',member:'kim',direct:true}).id;
 const own=once({conversation:kims});expect((await f.call('tempo','set',own,token.other)).status).toBe(200);
 const row=()=>f.db.select().from(triggers).where(eq(triggers.id,own.id)).get()!,fired=()=>f.db.select().from(inbox).where(eq(inbox.source,'trigger')).all();
 // A household owner rewords it, as a person and through a body woken by the owner: refused, and the asker stays.
 expect(await f.call('tempo','edit',{id:own.id,instructions:'The owner\'s words'},token.owner)).toMatchObject({status:403,body:{message:PRIVATE_PLACE_REFUSAL}});
 f.root.writes.run(()=>f.db.update(inbox).set({fromKind:'person',fromId:'owner'}).where(eq(inbox.job,'body')).run());
 expect(await f.call('tempo','edit',{id:own.id,instructions:'The owner\'s words'})).toMatchObject({status:403,body:{message:PRIVATE_PLACE_REFUSAL}});
 expect(row()).toMatchObject({instructions:'Post the numbers',askedByKind:'agent',askedBy:'art'});
 // The owner may move its times: the words and the asker are as they were.
 f.root.writes.run(()=>f.db.update(triggers).set({times:'09:00',lifespan:'until-stopped'}).where(eq(triggers.id,own.id)).run());
 expect((await f.call('tempo','edit',{id:own.id,times:'10:00'},token.owner)).status).toBe(200);expect(row()).toMatchObject({askedByKind:'agent',instructions:'Post the numbers'});
 // With the door out of the way (the row written as a reword by the owner would leave it), the firing holds on
 // its own: nothing is delivered into Kim's conversation, the trigger is stopped, and the agent's people are told.
 f.root.writes.run(()=>f.db.update(triggers).set({askedByKind:'member',askedBy:'owner',instructions:'The owner\'s words'}).where(eq(triggers.id,own.id)).run());
 expect((await f.call('tempo','runNow',{id:own.id},token.other)).status).toBe(200);
 expect(fired()).toEqual([]);expect(row()).toMatchObject({enabled:false,state:'stopped'});
 expect(f.db.select().from(inbox).where(eq(inbox.source,'notice')).all().map(item=>item.words)).toContainEqual(expect.stringContaining('its conversation is private to the member kim, and the member owner, who asked for it, is not that member'));
 // On Kim's own word it fires there.
 f.root.writes.run(()=>f.db.update(triggers).set({askedByKind:'member',askedBy:'kim',enabled:true,state:'standing'}).where(eq(triggers.id,own.id)).run());
 expect((await f.call('tempo','runNow',{id:own.id},token.other)).status).toBe(200);expect(fired()).toMatchObject([{conversation:kims,onWordKind:'member',onWord:'kim'}]);
 f.root.writes.run(()=>f.db.update(inbox).set({state:'done'}).where(eq(inbox.source,'trigger')).run());
 // A note is asked the same at admission: on the owner's word it is dropped with a notice, on Kim's it starts her conversation's job.
 const note=(id:string,on:string)=>{let item='';f.root.writes.run(()=>{item=f.root.services.conversations.send({conversation:kims,toKind:'agent',to:'art',source:'handoff',sourceId:id,fromKind:'agent',fromId:'art',words:null as never,onWordKind:'member',onWord:on,chain:JSON.stringify([cv]),chainStartedAt:stamp}).id;});return item;};
 const owners=note('owners','owner');expect(all.admission(kims)).toEqual({noticed:true});
 expect(f.db.select().from(inbox).where(eq(inbox.id,owners)).get()).toMatchObject({state:'resolved',resolution:expect.stringContaining('private to the member kim')});
 note('kims','kim');expect(all.admission(kims)).toMatchObject({started:true,job:{conversation:kims,member:'kim'}});
});
it('lets a job a firing woke on a guest\'s word come back to its work with a one-time trigger, sets it no repeating one, and tells the agent\'s people of every fifth come-back in a row',async()=>{
 const {f,cv,once,allowed}=await sharedPlace();
 expect(repeats({times:'09:00',lifespan:'until-stopped'})).toBe(true);expect(repeats({times:'09:00,09:01',lifespan:'once'})).toBe(false);expect(repeats({times:'2026-12-01T09:00:00Z',lifespan:'until-stopped'})).toBe(false);expect(repeats({times:'09:00,10:00',lifespan:'today'})).toBe(true);
 const mine=once(),second=once({lifespan:'until-stopped'}),daily=once({lifespan:'until-stopped',times:'09:00'});
 for(const trigger of [mine,second])expect((await f.call('tempo','set',trigger)).status).toBe(200);
 await allowed(daily);
 const fired=()=>f.db.select().from(inbox).where(eq(inbox.source,'trigger')).all(),row=(id:string)=>f.db.select().from(triggers).where(eq(triggers.id,id)).get()!;
 /** The firing of this trigger becomes the mail of the body's job, as admission would mark it. */
 const woke=(id:string)=>f.root.writes.run(()=>{const item=f.db.select({item:inboxRefs.item}).from(inboxRefs).where(eq(inboxRefs.ref,id)).all().map(ref=>ref.item).find(item=>fired().some(mail=>mail.id===item))!;f.db.update(inbox).set({job:'body',state:'taken'}).where(eq(inbox.id,item)).run();});
 // The first fires, and its firing is the job's mail: nobody is speaking now.
 expect((await f.call('tempo','runNow',{id:mine.id},token.other)).status).toBe(200);expect(fired()).toHaveLength(1);
 f.root.writes.run(()=>f.db.update(inbox).set({state:'done'}).where(eq(inbox.source,'slack')).run());woke(mine.id);
 // It may come back to work it is doing: a one-time trigger is set, and one is moved, with nobody asked.
 const soon=()=>new Date(f.clock.now()+60_000).toISOString();
 let next=once({times:soon()});expect((await f.call('tempo','set',next)).status).toBe(200);
 expect((await f.call('tempo','edit',{id:second.id,instructions:'Look again'})).status).toBe(200);
 // It sets, changes and starts no repeating one, and asks no owner for one: that is for a person to ask.
 const cards=f.db.select().from(approvals).all().length;
 expect(await f.call('tempo','set',once({lifespan:'until-stopped',times:'09:00'}))).toMatchObject({status:403,body:{message:WOKEN_BY_MAIL_REFUSAL}});
 expect(await f.call('tempo','edit',{id:second.id,times:'09:00'})).toMatchObject({status:403,body:{message:WOKEN_BY_MAIL_REFUSAL}});
 expect(await f.call('tempo','edit',{id:daily.id,instructions:'Again'})).toMatchObject({status:403,body:{message:WOKEN_BY_MAIL_REFUSAL}});
 expect(WOKEN_BY_MAIL_REFUSAL).toBe('A firing or a note woke this job, and it is not working for the agent\'s owners: it may set a one-time schedule to come back to its work here, and it sets, changes and starts no repeating one. It may stop one the same person asked for.');
 // It may still stop what the same person asked for, and not start it again; it fires nothing by hand, and never again the trigger that woke it.
 expect((await f.call('tempo','stop',{id:daily.id})).status).toBe(200);
 expect(await f.call('tempo','start',{id:daily.id})).toMatchObject({status:403,body:{message:WOKEN_BY_MAIL_REFUSAL}});
 expect(await f.call('tempo','runNow',{id:second.id})).toMatchObject({status:403,body:{message:RUN_NOW_REFUSAL}});
 expect(await f.call('tempo','runNow',{id:mine.id})).toMatchObject({status:403,body:{message:REFIRE_REFUSAL}});
 expect(f.db.select().from(approvals).all()).toHaveLength(cards);expect(row(second.id)).toMatchObject({times:second.times});
 // A chain of come-backs with each set by the job the last one woke is refused at no length. The agent's people are
 // told at the fifth firing in a row from the first, and at each further fifth.
 expect(COME_BACK_NOTICE_EVERY).toBe(5);
 const told=()=>f.db.select().from(inbox).where(eq(inbox.source,'notice')).all().filter(item=>item.sourceId?.startsWith('come-back-chain:'));
 for(let n=2;n<=2*COME_BACK_NOTICE_EVERY;n++){
  // (Fired by the agent's own work here, so the test's clock stays where the jobs' credentials are good.)
  expect((await f.call('tempo','runNow',{id:next.id},token.other)).status).toBe(200);
  expect(fired(),String(n)).toHaveLength(n);expect(row(next.id)).toMatchObject({state:'fired'});
  expect(told(),String(n)).toHaveLength(Math.floor(n/COME_BACK_NOTICE_EVERY));
  woke(next.id);next=once({times:soon()});expect((await f.call('tempo','set',next)).status,String(n)).toBe(200);
 }
 expect(told()[0]).toMatchObject({toKind:'person',to:'owner',words:`Bodies of art have come back to their work in conversation ${cv} 5 times in a row, each on a schedule set by the job the one before woke, on the word of the outside account ${GUEST}. Nothing was stopped: say stop in that conversation if it should end.`});
 expect(told()[1].words).toContain('10 times in a row');
 // A come-back a person's message asked for starts its own count: the one set at the start, moved, fires as a first.
 expect(f.db.select().from(triggerLog).all().filter(log=>log.event==='comes back'&&log.trigger===mine.id)).toEqual([]);
});
it('lets a job a note woke on a guest\'s word come back to its work the same way, and sets it no repeating schedule',async()=>{
 const {f,cv,once}=await sharedPlace();
 expect((await f.call('tempo','set',once())).status).toBe(200);
 f.root.writes.run(()=>{const item=f.root.services.conversations.send({conversation:cv,toKind:'agent',to:'art',source:'handoff',sourceId:'a-note',fromKind:'agent',fromId:'art',words:null as never,onWordKind:'outside',onWord:GUEST,chain:JSON.stringify(['elsewhere']),chainStartedAt:new Date(f.clock.now()).toISOString()});
  f.db.update(inbox).set({job:'body',state:'taken'}).where(eq(inbox.id,item.id)).run();});
 expect((await f.call('tempo','set',once())).status).toBe(200);
 expect(await f.call('tempo','set',once({lifespan:'until-stopped',times:'09:00'}))).toMatchObject({status:403,body:{message:WOKEN_BY_MAIL_REFUSAL}});
 expect(f.db.select().from(approvals).all()).toEqual([]);
});

it('lets a guest\'s word go one hop, tells the agent\'s people of every fifth note it hands and refuses none, and reads a report target only from a rule of the agent\'s own',async()=>{
 const {f,cv,work}=await sharedPlace(()=>false);
 const key=(channel:string)=>JSON.stringify(['slack','TWORK',channel]),pond={platform:'slack',workspace:'TWORK',channel:'CPOND'};
 f.root.writes.run(()=>{f.db.insert(agents).values({id:'mark',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();
  f.db.insert(bridgeChannels).values([{...pond,answers:'art',botsMayTalk:false,reportsTo:key('CTHIRD')},{platform:'slack',workspace:'TWORK',channel:'CTHIRD',answers:'art',botsMayTalk:false}]).run();
  f.db.update(bridgeChannels).set({reportsTo:key('CPOND')}).where(eq(bridgeChannels.channel,'CROOM')).run();});
 const note=(to:unknown,credential=token.body)=>f.call('conversation','handoff',{to,clientId:randomUUID(),label:'Note',words:'Words'},credential);
 // One hop: the guest's body hands to its channel's report target.
 const first=await note(pond);expect(first.status).toBe(200);const there=made(first.body);
 // The body that note woke is on the guest's word too. Its own channel names a report target, and it hands nothing there: a note started it.
 f.root.writes.run(()=>{f.db.update(jobs).set({conversation:there}).where(eq(jobs.id,'other')).run();f.db.update(inbox).set({job:'other',state:'taken'}).where(eq(inbox.conversation,there)).run();});
 expect(reportsTo(f.db,f.db.select().from(conversations).where(eq(conversations.id,there)).get()!)).toBe(key('CTHIRD'));
 expect(jobWord(f.db,{id:'other',agent:'art',conversation:there})).toEqual({woke:'others',person:{kind:'outside',id:GUEST}});
 expect((await note({platform:'slack',workspace:'TWORK',channel:'CTHIRD'},token.other)).status).toBe(403);
 // A job on a guest's word is refused no note for how many it has handed. The agent's people are told at five and at
 // each further five: loud, not a stop. The same note sent again is the same note, and is told of once.
 expect(NOTES_NOTICE_EVERY).toBe(5);
 const told=()=>f.db.select().from(inbox).where(eq(inbox.source,'notice')).all().filter(item=>item.sourceId?.startsWith('job-notes:'));
 const thread=(n:number)=>`17944320${String(n).padStart(2,'0')}.000001`;
 const again={to:{...pond,thread:'1794432000.000002'},clientId:'fifth',label:'Note',words:'Words'};
 for(let n=2;n<NOTES_NOTICE_EVERY;n++)expect((await note({...pond,thread:thread(n)})).status,String(n)).toBe(200);
 expect(told()).toEqual([]);
 expect((await f.call('conversation','handoff',again)).status).toBe(200);
 // Nobody has the agent, so the household's owners are told: who the job works for, where, and that nothing was stopped.
 expect(told()).toMatchObject([{toKind:'person',to:'owner',fromKind:'unknown'}]);
 expect(told()[0].words).toBe(`A job of art that is not working for its owners has handed 5 notes and briefs, on the word of the outside account ${GUEST}, from conversation ${cv}. Nothing was stopped: say stop in that conversation, or stop the job, if it should end.`);
 expect((await f.call('conversation','handoff',again)).status).toBe(200);expect(told()).toHaveLength(1);
 // The sixth is handed like the first, and raises nothing.
 expect((await note({...pond,thread:thread(6)})).status).toBe(200);expect(told()).toHaveLength(1);
 // At ten, the members who have the agent are told, and not the other owners.
 f.root.writes.run(()=>{f.db.insert(members).values({id:'kim',role:'member',joinedAt:new Date(f.clock.now()).toISOString()}).run();f.db.insert(memberAgents).values({member:'kim',agent:'art'}).run();});
 for(let n=7;n<=2*NOTES_NOTICE_EVERY;n++)expect((await note({...pond,thread:thread(n)})).status,String(n)).toBe(200);
 expect(told()).toHaveLength(2);expect(told()[1]).toMatchObject({to:'kim',words:expect.stringContaining('has handed 10 notes and briefs')});
 expect(f.db.select().from(inbox).where(eq(inbox.source,'handoff')).all()).toHaveLength(2*NOTES_NOTICE_EVERY);
 // A job working for owners is not counted, and nobody is told of its notes.
 f.root.writes.run(()=>{f.db.insert(memberAgents).values({member:'owner',agent:'art'}).run();f.db.update(inbox).set({fromKind:'person',fromId:'owner'}).where(eq(inbox.job,'body')).run();});
 for(let n=11;n<=3*NOTES_NOTICE_EVERY;n++)expect((await note({...pond,thread:thread(n)})).status,String(n)).toBe(200);
 expect(told()).toHaveLength(2);
 f.root.writes.run(()=>f.db.update(inbox).set({fromKind:'unknown',fromId:null}).where(and(eq(inbox.job,'body'),eq(inbox.source,'slack'))).run());
 // A report target is read from the rule of the agent that answers there. In a channel mark answers, art's body, woken by a guest's mention, reports nowhere.
 f.root.writes.run(()=>f.db.update(bridgeChannels).set({answers:'mark'}).where(eq(bridgeChannels.channel,'CROOM')).run());
 expect(reportsTo(f.db,f.db.select().from(conversations).where(eq(conversations.id,cv)).get()!)).toBeNull();
 // The card names a report target only on one of the answering agent's bridges.
 const card=(reports:unknown)=>f.call('bridges','command',{action:'channel',platform:'slack',workspace:'TWORK',channel:'CROOM',answers:'art',botsMayTalk:false,reportsTo:reports},token.owner);
 expect((await card({platform:'discord',workspace:'100000000000000001',channel:'100000000000000002'})).status).not.toBe(200);
 expect((await card({platform:'slack',workspace:'TELSE',channel:'CPOND'})).status).not.toBe(200);
 expect((await card(pond)).status).toBe(200);
 void work;
});

/** Kim, a member who has the agent, her private direct conversation, and a trigger there the agent's own work set. */
async function kimsTrigger(){
 const made=await sharedPlace(),{f,once}=made,stamp=new Date(f.clock.now()).toISOString();
 f.root.writes.run(()=>{f.db.insert(members).values({id:'kim',role:'member',joinedAt:stamp}).run();f.db.insert(memberAgents).values([{member:'owner',agent:'art'},{member:'kim',agent:'art'}]).run();});
 const kims=f.root.services.conversations.open({agent:'art',venue:'slack',place:JSON.stringify(['TWORK','DKIM',null,['member','kim']]),label:'kim',member:'kim',direct:true}).id;
 const own=once({conversation:kims});expect((await f.call('tempo','set',own,token.other)).status).toBe(200);
 return {...made,kims,own,stamp,row:()=>f.db.select().from(triggers).where(eq(triggers.id,own.id)).get()!};
}
it('refuses an owner\'s change of a trigger\'s note where the trigger names another member\'s private conversation: a note is words',async()=>{
 const {f,own,row}=await kimsTrigger();
 expect(await f.call('tempo','edit',{id:own.id,note:'The owner\'s words, in the note'},token.owner)).toMatchObject({status:403,body:{message:PRIVATE_PLACE_REFUSAL}});
 expect(row()).toMatchObject({note:'Daily numbers',askedByKind:'agent'});
});
it('refuses an owner\'s change of file on a trigger that names another member\'s private conversation',async()=>{
 const {f,own,row}=await kimsTrigger();
 expect(await f.call('tempo','edit',{id:own.id,file:'lanes/owner.md'},token.owner)).toMatchObject({status:403,body:{message:PRIVATE_PLACE_REFUSAL}});
 expect(row()).toMatchObject({file:null,instructions:'Post the numbers',askedByKind:'agent'});
});
/** A shared place, a trigger there the guest's body asked for, and an owner who has the agent. */
async function guestsTrigger(){
 const made=await sharedPlace(),{f,once}=made,guests=once();expect((await f.call('tempo','set',guests)).status).toBe(200);
 f.root.writes.run(()=>f.db.insert(memberAgents).values({member:'owner',agent:'art'}).run());
 return {...made,guests,row:(id=guests.id)=>f.db.select().from(triggers).where(eq(triggers.id,id)).get()!};
}
it('refuses an owner who changes only part of the words of a trigger a guest asked for: no firing carries one person\'s text on another\'s word',async()=>{
 const {f,guests,row}=await guestsTrigger();
 for(const part of [{note:'Typo fixed'},{instructions:'The owner\'s instructions'},{file:'lanes/owner.md'}])
  expect(await f.call('tempo','edit',{id:guests.id,...part},token.owner),JSON.stringify(part)).toMatchObject({status:403,body:{message:WORD_PART_REFUSAL}});
 expect(row()).toMatchObject({note:'Daily numbers',instructions:'Post the numbers',file:null,askedByKind:'outside',askedBy:GUEST});
});
it('re-stamps the asker to an owner who replaces all the words of a trigger a guest asked for',async()=>{
 const {f,cv,guests,row}=await guestsTrigger();
 expect((await f.call('tempo','edit',{id:guests.id,note:'The owner\'s note',instructions:'The owner\'s instructions'},token.owner)).status).toBe(200);
 expect(row()).toMatchObject({conversation:cv,note:'The owner\'s note',instructions:'The owner\'s instructions',askedByKind:'member',askedBy:'owner'});
});
it('lets the asker\'s own body change any part of its trigger\'s words',async()=>{
 const {f,guests,row}=await guestsTrigger();
 expect((await f.call('tempo','edit',{id:guests.id,note:'The guest\'s new note'})).status).toBe(200);
 expect((await f.call('tempo','edit',{id:guests.id,instructions:'The guest\'s new instructions'})).status).toBe(200);
 expect(row()).toMatchObject({note:'The guest\'s new note',instructions:'The guest\'s new instructions',askedByKind:'outside',askedBy:GUEST});
});
it('lets an owner change part of the words of a trigger an owner or the agent asked for',async()=>{
 const {f,once,row}=await guestsTrigger();
 f.root.writes.run(()=>{f.db.insert(members).values({id:'kim',role:'member',joinedAt:new Date(f.clock.now()).toISOString()}).run();f.db.insert(memberAgents).values({member:'kim',agent:'art'}).run();});
 const own=once(),kims=once();expect((await f.call('tempo','set',own,token.other)).status).toBe(200);expect((await f.call('tempo','set',kims,token.other)).status).toBe(200);
 f.root.writes.run(()=>f.db.update(triggers).set({askedByKind:'member',askedBy:'kim'}).where(eq(triggers.id,kims.id)).run());
 for(const id of [own.id,kims.id]){expect((await f.call('tempo','edit',{id,note:'Typo fixed'},token.owner)).status).toBe(200);expect(row(id)).toMatchObject({note:'Typo fixed',instructions:'Post the numbers',askedByKind:'member',askedBy:'owner'});}
});
it('holds a trigger\'s note to the length its instructions are held to, set or changed',async()=>{
 const {f,once}=await sharedPlace(),long='n'.repeat(100_001);
 expect((await f.call('tempo','set',once({note:long}),token.other)).status).toBe(400);
 const fine=once();expect((await f.call('tempo','set',fine,token.other)).status).toBe(200);
 expect((await f.call('tempo','edit',{id:fine.id,note:long},token.other)).status).toBe(400);
});
/** A shared place that reports to #pond, a peer agent mark, and the job a guest's note started in #pond (the `other` job). */
async function noteStarted(){
 const made=await sharedPlace(()=>false),{f}=made,stamp=new Date(f.clock.now()).toISOString(),pond={platform:'slack',workspace:'TWORK',channel:'CPOND'};
 f.root.writes.run(()=>{f.db.insert(agents).values({id:'mark',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();f.db.insert(memberAgents).values([{member:'owner',agent:'art'},{member:'owner',agent:'mark'}]).run();
  f.db.insert(bridgeChannels).values({...pond,answers:'art',botsMayTalk:false}).run();f.db.update(bridgeChannels).set({reportsTo:JSON.stringify(['slack','TWORK','CPOND'])}).where(eq(bridgeChannels.channel,'CROOM')).run();});
 const brief=(credential:string,agent='mark')=>f.call('conversation','handoff',{agent,clientId:randomUUID(),label:'Brief',words:'Look into X'},credential);
 const note=(to:unknown,credential=token.body)=>f.call('conversation','handoff',{to,clientId:randomUUID(),label:'Note',words:'Words'},credential);
 return {...made,pond,stamp,brief,note};
}
it('lets no job a note started on a guest\'s word brief a peer agent',async()=>{
 const {f,pond,brief,note}=await noteStarted();
 const first=await note(pond);expect(first.status).toBe(200);const there=made(first.body);
 f.root.writes.run(()=>{f.db.update(jobs).set({conversation:there}).where(eq(jobs.id,'other')).run();f.db.update(inbox).set({job:'other',state:'taken'}).where(eq(inbox.conversation,there)).run();});
 expect((await brief(token.other)).status).toBe(403);
 expect(f.db.select().from(inbox).all().filter(item=>item.to==='mark')).toEqual([]);
 // The guest's own body, which a person's message started, still may: that ruling stands.
 expect((await brief(token.body)).status).toBe(200);
});
it('lets no job a brief started on a guest\'s word brief back',async()=>{
 const {f,stamp,brief}=await noteStarted(),marks='d'.repeat(64);
 const first=await brief(token.body);expect(first.status).toBe(200);const briefed=made(first.body);
 f.root.writes.run(()=>{f.db.insert(jobs).values({id:'marks',agent:'mark',box:'box',conversation:briefed,title:'',brief:'',model:'test',state:'running',startedByKind:'agent',startedBy:'mark',houseRepository:'',houseFile:'',houseBranch:'',queuedAt:stamp}).run();
  f.db.update(inbox).set({job:'marks',state:'taken'}).where(eq(inbox.conversation,briefed)).run();
  f.db.insert(tokens).values({fingerprint:createHash('sha256').update(marks).digest('hex'),label:'marks',kind:'agent',agent:'mark',job:'marks',createdAt:stamp}).run();});
 expect(jobWord(f.db,{id:'marks',agent:'mark',conversation:briefed}).woke).toBe('others');
 expect((await brief(marks,'art')).status).toBe(403);
 expect(f.db.select().from(inbox).all().filter(item=>item.source==='handoff'&&item.to==='art')).toEqual([]);
});
it('counts a brief to a peer agent with the notes a job on a guest\'s word hands, for the notice and for no refusal',async()=>{
 const {f,pond,brief,note}=await noteStarted();
 const told=()=>f.db.select().from(inbox).where(eq(inbox.source,'notice')).all().filter(item=>item.sourceId?.startsWith('job-notes:'));
 for(let n=1;n<NOTES_NOTICE_EVERY;n++)expect((await note({...pond,thread:`179443200${n}.000001`})).status,String(n)).toBe(200);
 expect(told()).toEqual([]);
 // Every brief from one job is in the one conversation that job opened, and each is one more hand-off: the fifth here.
 expect((await brief(token.body)).status).toBe(200);
 expect(told()).toMatchObject([{toKind:'person',to:'owner',words:expect.stringContaining('has handed 5 notes and briefs')}]);
 // Neither a further brief nor a further note is refused.
 expect((await brief(token.body)).status).toBe(200);expect((await note({...pond,thread:'1794432009.000001'})).status).toBe(200);
 expect(told()).toHaveLength(1);
 expect(f.db.select().from(inbox).where(eq(inbox.source,'handoff')).all()).toHaveLength(NOTES_NOTICE_EVERY+2);
});
it('stops at the firing a trigger that watches an event on the word of anybody but owners',async()=>{
 const {f,once}=await sharedPlace();
 const mine=once();expect((await f.call('tempo','set',mine)).status).toBe(200);
 // No door sets one. The row is written as one would stand if a door had, or if its asker stopped being an owner.
 f.root.writes.run(()=>f.db.update(triggers).set({sourceKind:'answer',watches:'question:none',times:null,nextDueAt:null,lifespan:'until-stopped'}).where(eq(triggers.id,mine.id)).run());
 expect((await f.call('tempo','runNow',{id:mine.id},token.other)).status).toBe(200);
 expect(f.db.select().from(inbox).where(eq(inbox.source,'trigger')).all()).toEqual([]);
 expect(f.db.select().from(triggers).where(eq(triggers.id,mine.id)).get()).toMatchObject({enabled:false,state:'stopped'});
 expect(f.db.select().from(inbox).where(eq(inbox.source,'notice')).all().map(item=>item.words)).toContainEqual(expect.stringContaining('it watches an event'));
});
it('drops at admission a firing that waits in one member\'s private conversation on somebody else\'s word',async()=>{
 const {f,kims}=await kimsTrigger(),all=runnable(f);
 let firing='';f.root.writes.run(()=>{firing=f.root.services.conversations.send({conversation:kims,toKind:'agent',to:'art',source:'trigger',sourceId:'tr:late',fromKind:'schedule',words:'The owner\'s words',onWordKind:'member',onWord:'owner'}).id;});
 expect(all.admission(kims)).toEqual({noticed:true});
 expect(f.db.select().from(inbox).where(eq(inbox.id,firing)).get()).toMatchObject({state:'resolved',resolution:expect.stringContaining('private to the member kim')});
 expect(f.db.select().from(jobs).all().filter(job=>job.conversation===kims)).toEqual([]);
});
