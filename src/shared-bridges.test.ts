import Database from 'better-sqlite3';
import { setupCall } from '../test/fixtures/setup-call.js';
import {afterEach,expect,it,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {FakeClock} from './core/clock.js';
import {createDataSchema} from './core/data/database.js';
import {agentPeople,members,agents,secrets,boxes,jobs,tokens,bridgeConnections,bridgeChannels,bridgeIncoming,bridgeSends,bridgeSendParts,conversations,inbox,secretChanges,turns,projects,memberAgents} from './core/data/schema.js';
import {sharedRoot} from './shared-root.js';
import type {bridgeSlackSocket} from './pieces/bridges/slack-socket.js';
import {wordsKey} from './pieces/comms/crypto.js';
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
