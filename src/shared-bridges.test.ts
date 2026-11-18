import Database from 'better-sqlite3';
import { setupCall } from '../test/fixtures/setup-call.js';
import {afterEach,expect,it,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {FakeClock} from './core/clock.js';
import {createDataSchema} from './core/data/database.js';
import {inboxRefs,agentPeople,conversationSessions,triggers,members,agents,secrets,boxes,jobs,tokens,bridgeConnections,bridgeChannels,bridgeIncoming,bridgeSends,bridgeSendParts,conversations,inbox,secretChanges,turns,projects,memberAgents} from './core/data/schema.js';
import {sharedRoot} from './shared-root.js';
import type {bridgeSlackSocket} from './pieces/bridges/slack-socket.js';
import {wordsKey} from './pieces/comms/crypto.js';
import {SESSION_BYTES} from './core/conversations/session-limit.js';
import {bodyConversationClient,bodyMailContext} from './runtime/conversation-client.js';
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
 const admitted=vi.fn(()=>true),root=sharedRoot({db,clock,originAllowed:()=>true,reportError:()=>{},tempo:{admit:admitted},...(comms?{commsKey:wordsKey('AGE-SECRET-KEY-10SC5M7Q03WKNXKZHXZKY6JWHDV8MP7DS8USNSE64C674RN6TDGDSEKQNMR')}:{}),bridges:{source,effectsAllowed,request,slack}});clean.push(()=>root.close());
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
});
it('takes a file on bridges.say as a name and bytes, and refuses it for Slack with the reason',async()=>{
 const f=fixture();const incoming=await f.receive();
 f.root.writes.run(()=>{f.db.update(jobs).set({conversation:incoming.conversation}).where(eq(jobs.id,'body')).run();f.root.services.conversations.take(incoming.conversation!,'body');});
 const contents=Buffer.from('PNG').toString('base64');
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
 const f=fixture(()=>true,true);const incoming=await f.receive();
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
// What a body may schedule depends on where its job is (policy.ts, maySchedule). A room's body would be
// setting words that later run as the agent's own wake, outside the room and its limits; Tempo cannot yet
// address a firing to a conversation, so every trigger from a room's body is refused.
it('refuses every trigger a room\'s body sets, rewords, stops, starts or runs, with a line that says what to do instead',async()=>{
 const f=fixture();const incoming=await f.receive();
 f.root.writes.run(()=>{f.db.insert(agents).values({id:'mark',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();f.db.update(jobs).set({conversation:incoming.conversation}).where(eq(jobs.id,'body')).run();f.root.services.conversations.take(incoming.conversation!,'body');});
 // A Slack channel, and its sender an outside account: a room, with a guest in it.
 expect(f.db.select().from(conversations).get()).toMatchObject({venue:'slack',member:null});expect(f.db.select().from(inbox).get()).toMatchObject({fromKind:'unknown'});
 const trigger=(more:Record<string,unknown>)=>({id:randomUUID(),ownerKind:'agent',owner:'art',sourceKind:'time',times:new Date(f.clock.now()+3_600_000).toISOString(),lifespan:'once',targetKind:'inbox',toKind:'agent',to:'art',instructions:'Words chosen in the room',note:'Set from a room',...more});
 const line='A body working in a room cannot schedule work: ask in your own thread, or have an owner schedule it.';
 // The agent's own wake: who the caller is would allow it; where its job is does not.
 expect(await f.call('tempo','set',trigger({}))).toMatchObject({status:403,body:{ok:false,code:'denied',message:line}});
 // Another agent's work, and a message to a person, were never the caller's to set.
 for(const other of [{owner:'mark',to:'mark'},{to:'mark'},{toKind:'person',to:'owner'}])expect((await f.call('tempo','set',trigger(other))).status).toBe(403);
 expect(f.db.select().from(triggers).all()).toEqual([]);
 // Nor may it reword a trigger of its agent's that is already set: the words would run the same way.
 // A body of the same agent whose job is not in a room is judged as before, by who it is: the other job here
 // has no conversation at all.
 const owned=trigger({instructions:'Set outside any room'});
 expect((await f.call('tempo','set',owned,token.other)).status).toBe(200);
 // Nor may the room's body reword that trigger: the words would run the same way.
 expect(await f.call('tempo','edit',{id:owned.id,instructions:'Reworded in the room'})).toMatchObject({status:403,body:{message:line}});
 expect(f.db.select().from(triggers).all()).toMatchObject([{id:owned.id,instructions:'Set outside any room'}]);
 // Nor stop it, start it, or fire it at a time of its choosing: each would decide in the room what happens outside it.
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

import {Jobs} from './runtime/jobs.js';
import {workerPolicy} from './runtime/body-policy.js';
import {CHAIN_NOTICE_EVERY,ROOM_TRIGGERS_MAX} from './shared-room-mail.js';
import {ROOM_REPEAT_REFUSAL} from './shared-room-triggers.js';
/** The conversation a call's answer names, wherever the door puts its output. */
const made=(body:unknown):string=>{const found=JSON.stringify(body).match(/"conversation":"([^"]+)"/);if(!found)throw new Error('No conversation in '+JSON.stringify(body));return found[1];};
const GUEST=JSON.stringify(['slack','TWORK','UUSER']),ROOM_LINE='A body working in a room cannot schedule work: ask in your own thread, or have an owner schedule it.';
/** A room with a guest's message in it and the body's job working there. */
async function room(effects:()=>boolean=()=>true){
 let received=false;const f=fixture(()=>!received||effects(),true),incoming=await f.receive(),cv=incoming.conversation!;received=true;
 f.root.writes.run(()=>{f.db.update(jobs).set({conversation:cv}).where(eq(jobs.id,'body')).run();f.root.services.conversations.take(cv,'body');});
 const once=(more:Record<string,unknown>={})=>({id:randomUUID(),ownerKind:'agent',owner:'art',sourceKind:'time',times:new Date(f.clock.now()+86_400_000).toISOString(),lifespan:'once',targetKind:'inbox',toKind:'agent',to:'art',instructions:'Post the numbers',note:'Daily numbers',conversation:cv,...more});
 /** Put the other job to work in a conversation, with mail from these people behind it. */
 const work=(conversation:string,from:{kind:'person'|'unknown';id?:string}[])=>f.root.writes.run(()=>{
  f.db.update(inbox).set({job:null}).where(eq(inbox.job,'other')).run();f.db.update(jobs).set({conversation}).where(eq(jobs.id,'other')).run();
  from.forEach((who,index)=>{const item=f.root.services.conversations.send({conversation,toKind:'agent',to:'art',source:'notice',sourceId:randomUUID()+index,fromKind:who.kind,fromId:who.id,words:'Go on'});f.db.update(inbox).set({job:'other',state:'taken'}).where(eq(inbox.id,item.id)).run();});});
 return {f,incoming,cv,once,work};
}
it('lets a room\'s body set a trigger that names its own conversation, records who asked, and holds it to that conversation and to the bounds',async()=>{
 const {f,cv,once}=await room();
 const mine=once();
 expect((await f.call('tempo','set',mine)).status).toBe(200);
 // The asker is the person whose message started the job: here the guest, by the account loom knows them by.
 expect(f.db.select().from(triggers).get()).toMatchObject({id:mine.id,conversation:cv,askedByKind:'outside',askedBy:GUEST,member:null,state:'standing'});
 expect(f.db.select().from(triggers).get()!.askedAt).toBe(new Date(f.clock.now()).toISOString());
 // Anything that does not name this conversation keeps the refusal: no conversation, and another one.
 const elsewhere=f.root.services.conversations.open({agent:'art',venue:'slack',place:JSON.stringify(['TWORK','COTHER',null]),label:'other'}).id;
 for(const other of [{conversation:undefined},{conversation:elsewhere}])expect(await f.call('tempo','set',once(other))).toMatchObject({status:403,body:{message:ROOM_LINE}});
 // What is named must be a bridge conversation of the agent the trigger puts to work.
 expect((await f.call('tempo','set',once({conversation:'cv-none'}),token.other)).status).toBe(400);
 // From a room a repeating one comes no more often than hourly, at listed times; a rewording is held to the same.
 expect(await f.call('tempo','set',once({lifespan:'until-stopped',times:'09:00,09:30'}))).toMatchObject({status:403,body:{message:ROOM_REPEAT_REFUSAL}});
 expect(await f.call('tempo','set',once({lifespan:'until-stopped',times:'23:30,00:15'}))).toMatchObject({status:403,body:{message:ROOM_REPEAT_REFUSAL}});
 const hourly=once({lifespan:'until-stopped',times:'09:00,10:00'});expect((await f.call('tempo','set',hourly)).status).toBe(200);
 expect(await f.call('tempo','edit',{id:hourly.id,times:'09:00,09:10'})).toMatchObject({status:403,body:{message:ROOM_REPEAT_REFUSAL}});
 expect((await f.call('tempo','edit',{id:hourly.id,times:'09:00,11:00',instructions:'Reworded in the room'})).status).toBe(200);
 // It stops, starts and runs its own conversation's triggers, and still no other of its agent's.
 const outside=once({conversation:undefined});expect((await f.call('tempo','set',outside,token.other)).status).toBe(200);
 for(const action of ['stop','start','runNow']){expect((await f.call('tempo',action,{id:hourly.id})).status,action).toBe(200);expect(await f.call('tempo',action,{id:outside.id}),action).toMatchObject({status:403,body:{message:ROOM_LINE}});}
 // The owner, and the agent outside the room, set one naming a conversation the agent has: the asker is then that owner, or the agent.
 const owners=once(),own=once();
 owners.ownerKind='member';owners.owner='owner';f.root.writes.run(()=>f.db.insert(memberAgents).values({member:'owner',agent:'art'}).run());
 expect((await f.call('tempo','set',owners,token.owner)).status).toBe(200);expect((await f.call('tempo','set',own,token.other)).status).toBe(200);
 expect(f.db.select().from(triggers).where(eq(triggers.id,owners.id)).get()).toMatchObject({askedByKind:'member',askedBy:'owner'});
 expect(f.db.select().from(triggers).where(eq(triggers.id,own.id)).get()).toMatchObject({askedByKind:'agent',askedBy:'art'});
 // At most ROOM_TRIGGERS_MAX stand at once for one conversation, whoever sets them.
 expect(ROOM_TRIGGERS_MAX).toBe(10);
 const standing=()=>f.db.select().from(triggers).all().filter(row=>row.conversation===cv&&row.enabled).length;
 while(standing()<ROOM_TRIGGERS_MAX)expect((await f.call('tempo','set',once())).status).toBe(200);
 for(const credential of [token.body,token.owner])expect((await f.call('tempo','set',once(),credential)).status).toBe(409);
 expect((await f.call('tempo','stop',{id:mine.id})).status).toBe(200);expect((await f.call('tempo','set',once())).status).toBe(200);
});
it('fires such a trigger as mail from the schedule in its conversation, on its asker\'s word, and answers by a post there',async()=>{
 const {f,cv,once}=await room(()=>false);
 const mine=once();expect((await f.call('tempo','set',mine)).status).toBe(200);
 const before=f.db.select().from(conversations).all().length;
 expect((await f.call('tempo','runNow',{id:mine.id})).status).toBe(200);
 // Mail in the room, and no wake of its own.
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
 expect(f.db.select().from(turns).all().at(-1)).toMatchObject({conversation:cv,kind:'reply',run:'other'});
 expect(f.request.mock.calls.some(([url])=>String(url).endsWith('chat.postMessage'))).toBe(false);
});
it('stops such a trigger, with one notice, when its asker is no longer known or its conversation cannot be posted to',async()=>{
 const {f,once}=await room();
 const notices=()=>f.db.select().from(inbox).where(eq(inbox.source,'notice')).all().filter(item=>item.sourceId?.startsWith('room-trigger-stopped:'));
 const asked=once({lifespan:'until-stopped',times:'09:00'}),closed=once({lifespan:'until-stopped',times:'10:00'});
 for(const trigger of [asked,closed])expect((await f.call('tempo','set',trigger)).status).toBe(200);
 // A removed channel rule alone stops nothing: a mention there would still wake the agent.
 f.root.writes.run(()=>f.db.delete(bridgeChannels).run());
 expect((await f.call('tempo','runNow',{id:asked.id})).status).toBe(200);
 expect(f.db.select().from(inbox).where(eq(inbox.source,'trigger')).all()).toHaveLength(1);
 // The owner takes the guest's tier away: the firing does nothing, the trigger is stopped, the owner is told once.
 f.root.writes.run(()=>f.db.delete(agentPeople).run());
 expect((await f.call('tempo','runNow',{id:asked.id})).status).toBe(200);
 expect(f.db.select().from(inbox).where(eq(inbox.source,'trigger')).all()).toHaveLength(1);
 expect(f.db.select().from(triggers).where(eq(triggers.id,asked.id)).get()).toMatchObject({enabled:false,state:'stopped'});
 expect(notices()).toMatchObject([{toKind:'person',to:'owner',words:expect.stringContaining('who asked for it, is no longer known to art')}]);
 // The connection is turned off: the same, for the conversation.
 f.root.writes.run(()=>{f.db.insert(agentPeople).values({agent:'art',person:GUEST,tier:2}).run();f.db.update(bridgeConnections).set({enabled:false}).run();});
 expect((await f.call('tempo','runNow',{id:closed.id})).status).toBe(200);
 expect(f.db.select().from(triggers).where(eq(triggers.id,closed.id)).get()).toMatchObject({enabled:false,state:'stopped'});
 expect(notices().map(item=>item.words)).toContainEqual(expect.stringContaining("its conversation's connection is not in use"));
 expect(f.db.select().from(inbox).where(eq(inbox.source,'trigger')).all()).toHaveLength(1);
});
it('hands a note to the agent\'s own body in another conversation, by who the sending body works for',async()=>{
 const {f,cv,work}=await room(()=>false);
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
 const {f,cv,work}=await room();
 const pond=f.root.services.conversations.open({agent:'art',venue:'slack',place:JSON.stringify(['TWORK','CPOND',null]),label:'pond'}).id;
 expect(CHAIN_NOTICE_EVERY).toBe(25);
 const chain=Array.from({length:CHAIN_NOTICE_EVERY-1},(_,index)=>index%2?pond:cv),started='2026-11-01T00:00:00.000Z';
 work(pond,[{kind:'person',id:'owner'}]);
 f.root.writes.run(()=>{const item=f.root.services.conversations.send({conversation:pond,toKind:'agent',to:'art',source:'handoff',sourceId:'earlier',fromKind:'agent',fromId:'art',words:null as never,chain:JSON.stringify(chain),chainStartedAt:started});f.db.update(inbox).set({job:'other',state:'taken'}).where(eq(inbox.id,item.id)).run();});
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
});
it('gives a stopped job the notes and firings waiting in its conversation, so they start no work until a person speaks there',async()=>{
 const {f,cv}=await room();
 const send=(fromKind:'agent'|'schedule'|'person',source:'handoff'|'trigger'|'notice')=>{let id='';f.root.writes.run(()=>{id=f.root.services.conversations.send({conversation:cv,toKind:'agent',to:'art',source,sourceId:randomUUID(),fromKind,fromId:fromKind==='person'?'owner':'art',words:source==='handoff'?null as never:'Words'}).id;});return id;};
 const note=send('agent','handoff'),firing=send('schedule','trigger'),said=send('person','notice');
 const all=new Jobs(f.db,()=>new Date(f.clock.now()).toISOString());
 // Today's Stop by hand for another reason leaves them as they are.
 expect(f.db.select().from(inbox).all().filter(item=>[note,firing,said].includes(item.id)).map(item=>item.job)).toEqual([null,null,null]);
 f.root.writes.run(()=>all.stop('body','owner','stop'));
 const job=(id:string)=>f.db.select().from(inbox).where(eq(inbox.id,id)).get()!;
 expect([job(note),job(firing)]).toMatchObject([{job:'body',state:'waiting'},{job:'body',state:'waiting'}]);
 // What a person said there is fresh mail still, and admission starts work for it; the note comes along then.
 expect(job(said)).toMatchObject({job:null,state:'waiting'});
});
it('lets only an agent\'s own work post a text straight to a channel it has a rule for',async()=>{
 const {f,cv,work}=await room(()=>false);
 const post=(to:unknown)=>({id:randomUUID(),to,text:'Standup: all green',model:'observed'}),croom={platform:'slack',workspace:'TWORK',channel:'CROOM'};
 // The room's body works for a guest: it posts nowhere this way.
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
 expect(f.request.mock.calls.some(([url])=>String(url).endsWith('chat.postMessage'))).toBe(false);
});
