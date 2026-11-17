/** The body's bridge door through the actual root: which mail a reply may answer,
 * what a recorded reply settles, and who reads a message's attachments. */
import Database from 'better-sqlite3';
import {createHash,randomUUID} from 'node:crypto';
import {afterEach,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import {FakeClock} from './core/clock.js';
import {createDataSchema} from './core/data/database.js';
import * as s from './core/data/schema.js';
import {sharedRoot} from './shared-root.js';
import {BridgeIncoming} from './pieces/bridges/incoming.js';
import {wordsKey} from './pieces/comms/crypto.js';
const clean:(()=>unknown|Promise<unknown>)[]=[];
afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
const owner='a'.repeat(64),member='b'.repeat(64),other='c'.repeat(64),plainAgent='d'.repeat(64);
function fixture(){
 const sql=new Database(':memory:');clean.push(()=>sql.close());const db=createDataSchema(sql),clock=new FakeClock(),now=()=>new Date(clock.now()).toISOString();
 db.insert(s.members).values([{id:'owner',role:'owner',joinedAt:now()},{id:'member',role:'member',joinedAt:now()},{id:'other',role:'member',joinedAt:now()}]).run();
 db.insert(s.agents).values({id:'art',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();
 db.insert(s.memberAgents).values([{member:'member',agent:'art'},{member:'other',agent:'art'}]).run();
 db.insert(s.boxes).values({id:'box',name:'Box',owner:'owner',sameMachineAsLoom:false,hostsAny:false,reportOnly:false,alwaysOn:false,enrolledAt:now()}).run();
 db.insert(s.secrets).values(['TOKEN','APP'].map(name=>({name,description:'',changedAt:now(),changedBy:'owner'}))).run();
 db.insert(s.bridgeConnections).values({id:'slack',platform:'slack',workspace:'TWORK',botUser:'UBOT',agent:'art',tokenSecret:'TOKEN',appSecret:'APP',enabled:true,state:'disconnected',stateAt:now()}).run();
 db.insert(s.bridgeChannels).values({platform:'slack',workspace:'TWORK',channel:'CROOM',answers:'art',botsMayTalk:false}).run();
 db.insert(s.bridgePeople).values({platform:'slack',workspace:'TWORK',user:'UMEMBER',member:'member'}).run();
 const token=(value:string,row:Partial<typeof s.tokens.$inferInsert>)=>db.insert(s.tokens).values({fingerprint:createHash('sha256').update(value).digest('hex'),label:'Synthetic '+value.slice(0,12),kind:'owner',createdAt:now(),...row}).run();
 token(owner,{member:'owner'});token(member,{member:'member'});token(other,{member:'other'});token(plainAgent,{kind:'agent',agent:'art'});
 // No socket is opened: the daemon is never made ready. Only its send queue and doors are used.
 const root=sharedRoot({db,clock,originAllowed:()=>true,reportError:()=>{},commsKey:wordsKey('AGE-SECRET-KEY-10SC5M7Q03WKNXKZHXZKY6JWHDV8MP7DS8USNSE64C674RN6TDGDSEKQNMR'),tempo:{admit:()=>true},
  bridges:{source:{generation:async()=>'12345678-1234-4234-8234-123456789abc',read:async()=>Buffer.from('SYNTHETIC')},effectsAllowed:()=>true}});clean.push(()=>root.close());
 const incoming=new BridgeIncoming(db,now);let count=0;
 const receive=(dm:boolean,user='UMEMBER')=>root.writes.run(()=>incoming.receive({id:JSON.stringify([dm?'DMEMBER':'CROOM',`1794432000.00000${++count}`]),connection:'slack',channel:dm?'DMEMBER':'CROOM',thread:dm?undefined:`1794432000.00000${count}`,isDm:dm,user,text:'Synthetic words',postedAt:now(),mentions:[]})).value;
 /** A running job in the message's conversation, with the body token that proves it. */
 const body=(conversation:string,job=`job-${randomUUID()}`)=>{
  const value='body_'+createHash('sha256').update(job).digest('hex'),cv=db.select().from(s.conversations).where(eq(s.conversations.id,conversation)).get()!;
  root.writes.run(()=>{db.insert(s.jobs).values({id:job,agent:'art',box:'box',conversation,member:cv.member,title:'',brief:'',model:'m',state:'running',startedByKind:'agent',startedBy:'art',houseRepository:'r',houseFile:'f',houseBranch:'next',queuedAt:now()}).run();
   token(value,{kind:'agent',agent:'art',job});});
  return {job,token:value};
 };
 const call=async(name:'reply'|'file',input:unknown,bearer:string)=>{const res=await root.http.request('http://loom/api/bridges/'+name,{method:'POST',headers:{authorization:'Bearer '+bearer,'content-type':'application/json'},body:JSON.stringify({id:randomUUID(),input})});return {status:res.status,body:await res.json()};};
 const reply=(incomingId:string,bearer:string)=>call('reply',{id:randomUUID(),incoming:incomingId,text:'Synthetic reply',model:'m'},bearer);
 const mail=(incomingId:string)=>db.select({item:s.inbox}).from(s.inboxRefs).innerJoin(s.inbox,eq(s.inbox.id,s.inboxRefs.item)).where(eq(s.inboxRefs.ref,incomingId)).get()!.item;
 return {db,root,now,receive,body,call,reply,mail};
}
it('settles everything the body took with its one reply, and leaves mail that arrived afterwards waiting',async()=>{
 const f=fixture(),one=f.receive(true),two=f.receive(true);expect(two.conversation).toBe(one.conversation);
 const body=f.body(one.conversation!);f.root.writes.run(()=>f.root.services.conversations.take(one.conversation!,body.job));
 const late=f.receive(true);
 // One reply, to the latest message it read, answers the batch: a body that died now would leave nothing to answer twice.
 expect((await f.reply(two.id,body.token)).status).toBe(200);
 expect([f.mail(one.id).state,f.mail(two.id).state,f.mail(late.id).state]).toEqual(['done','done','waiting']);
});
it('lets a body answer only mail it took, and settles that mail with the reply',async()=>{
 const f=fixture(),message=f.receive(false),first=f.body(message.conversation!);
 // Not taken yet: these words never reached this body.
 expect((await f.reply(message.id,first.token)).status).toBe(403);expect(f.db.select().from(s.bridgeSends).all()).toEqual([]);
 f.root.writes.run(()=>f.root.services.conversations.take(message.conversation!,first.job));
 expect((await f.reply(message.id,first.token)).status).toBe(200);
 // The body never called conversation.confirm: the reply itself is the record that this mail was answered.
 expect(f.mail(message.id)).toMatchObject({state:'done',job:first.job});expect(f.db.select().from(s.bridgeSends).all()).toHaveLength(1);
 // The first body dies. Nothing goes back to waiting, and a second body cannot answer the same message.
 f.root.writes.run(()=>{f.db.update(s.jobs).set({state:'lost'}).where(eq(s.jobs.id,first.job)).run();f.db.update(s.inbox).set({state:'waiting',takenAt:null}).where(eq(s.inbox.state,'taken')).run();});
 expect(f.mail(message.id).state).toBe('done');
 const second=f.body(message.conversation!);expect((await f.reply(message.id,second.token)).status).toBe(403);
 expect(f.db.select().from(s.bridgeSends).all()).toHaveLength(1);
});
it('reads attachments under the rule of the message they hang off',async()=>{
 const f=fixture(),dm=f.receive(true),room=f.receive(false);
 f.root.writes.run(()=>{for(const [file,message] of [['FDM',dm],['FROOM',room]] as const){f.db.insert(s.bridgeFiles).values({connection:'slack',file,incoming:message.id,name:file+'.txt',contents:Buffer.from(file),fetchedAt:f.now()}).run();f.db.insert(s.bridgeFileMessages).values({connection:'slack',file,incoming:message.id}).run();}});
 expect(f.db.select().from(s.conversations).where(eq(s.conversations.id,dm.conversation!)).get()?.member).toBe('member');
 const status=async(message:{id:string},bearer:string)=>(await f.call('file',{incoming:message.id},bearer)).status;
 // Members: whoever may read the message row. The private DM is its member's alone; not even a household owner's.
 expect(await status(dm,member)).toBe(200);expect(await status(dm,owner)).toBe(403);expect(await status(dm,other)).toBe(403);
 expect(await status(room,other)).toBe(200);
 // Agents: only the body working in that conversation. The agent's identity alone opens nothing.
 expect(await status(room,plainAgent)).toBe(403);expect(await status(dm,plainAgent)).toBe(403);
 const inRoom=f.body(room.conversation!);
 expect(await status(room,inRoom.token)).toBe(200);expect(await status(dm,inRoom.token)).toBe(403);
 const one=await f.call('file',{incoming:room.id,file:'FROOM'},inRoom.token);expect(Buffer.from(one.body.value.files[0].contents,'base64').toString()).toBe('FROOM');
 expect((await f.call('file',{incoming:room.id,file:'missing'},inRoom.token)).body).toMatchObject({code:'not-found'});
 // A file is the message's only through its link: the one kept for the private message is not the room's.
 expect((await f.call('file',{incoming:room.id,file:'FDM'},inRoom.token)).body).toMatchObject({code:'not-found'});
 // The same file shared in a second message is kept once and listed under both.
 const again=f.receive(false);f.root.writes.run(()=>{f.db.insert(s.bridgeFileMessages).values({connection:'slack',file:'FROOM',incoming:again.id}).run();});
 expect((await f.call('file',{incoming:again.id},other)).body.value.files.map((file:{file:string})=>file.file)).toEqual(['FROOM']);
 expect((await f.call('file',{incoming:room.id},other)).body.value.files.map((file:{file:string})=>file.file)).toEqual(['FROOM']);
 expect(f.db.select().from(s.bridgeFiles).all()).toHaveLength(2);
});
