/** What a push says about where it leads (ui/notification-target.ts): always the desktop's address, and beside
 * it the boards address of the item's thread when that thread is the member's own. Real root, in-process
 * transport: nothing here reaches a push service. */
vi.mock('./push-transport.js',()=>({pushTransport:()=>{throw Error('External push delivery is forbidden in this proof');}}));
import {expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import webpush from 'web-push';
import {eq} from 'drizzle-orm';
import {generateX25519Identity} from 'age-encryption';
import {FakeClock} from '../clock.js';
import {createDataSchema} from '../data/database.js';
import {agents,conversations,memberAgents,members,tokens,sessions,threads} from '../data/schema.js';
import {sharedRoot} from '../../shared-root.js';
import {sharedWeb} from '../../shared-web.js';
import {wordsKey} from '../../pieces/comms/crypto.js';
import {NOTIFICATION_DEVICE_REF} from '../../ui/notification-target.js';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

it('adds the thread\'s boards address for an item in the member\'s own thread, and nothing for any other item',async()=>{
 const client=new Database(':memory:'),clock=new FakeClock(),now=()=>new Date(clock.now()).toISOString(),db=createDataSchema(client,now),hash=(s:string)=>createHash('sha256').update(s).digest('hex'),cookie='c'.repeat(64),endpoint='https://fcm.googleapis.com/fictional-boards-proof';
 for(const id of ['sam','bob'])db.insert(members).values({id,role:'member',joinedAt:now()}).run();
 db.insert(agents).values({id:'art',about:'',markBg:'#000',markFg:'#fff',faceShape:'pebble',faceEyes:'dot'}).run();
 for(const member of ['sam','bob'])db.insert(memberAgents).values({member,agent:'art'}).run();
 db.insert(tokens).values({fingerprint:hash('a'.repeat(64)),kind:'owner',member:'sam',label:'Sam',createdAt:now()}).run();db.insert(sessions).values({id:hash(cookie),token:hash('a'.repeat(64)),device:'Browser',via:'link',isAgent:false,issuedAt:now(),seenAt:now(),provedAt:now()}).run();
 db.insert(tokens).values({fingerprint:hash('b'.repeat(64)),kind:'owner',member:'bob',label:'Bob',createdAt:now()}).run();db.insert(sessions).values({id:hash('d'.repeat(64)),token:hash('b'.repeat(64)),device:'Browser',via:'link',isAgent:false,issuedAt:now(),seenAt:now(),provedAt:now()}).run();
 const pushes:unknown[]=[];
 const root=sharedRoot({db,clock,commsKey:wordsKey(await generateX25519Identity()),tempo:{notify:()=>true},originAllowed:()=>true,reportError:error=>{throw error;},notifications:{vapid:webpush.generateVAPIDKeys(),send:async(_sub,payload)=>{pushes.push(JSON.parse(String(payload)));}}});
 const call=(name:string,input:unknown,as=cookie)=>root.http.request('https://loom.test/api/'+name,{method:'POST',headers:{cookie:'loom_ui='+as,'content-type':'application/json'},body:JSON.stringify({input,id:crypto.randomUUID()})});
 const settle=async(extra:object={})=>{root.writes.run(()=>root.services.conversations.send({toKind:'person',to:'sam',member:'sam',source:'notice',fromKind:'unknown',words:'PRIVATE WORDS',...extra}));clock.advance(5000);await root.services.notifications!.publish('sam',[]);return pushes.at(-1);};
 const desktop={title:'loom',body:'',tag:'loom-inbox',url:'/p/inbox-preview'};
 try{
  expect((await call('notifications/subscribe',{sub:{endpoint,keys:{p256dh:'p'.repeat(87),auth:'a'.repeat(22)}},device:'Browser'})).status).toBe(200);
  // The reference a page can work out for its own subscription is the one the server lists.
  expect(root.services.notifications!.read('sam').devices[0].ref).toBe(hash(NOTIFICATION_DEVICE_REF+endpoint));
  // No thread: the payload is what it was before the boards page existed, key for key.
  expect(JSON.stringify(await settle())).toBe(JSON.stringify(desktop));expect(pushes).toHaveLength(1);
  // An item in the member's own thread also names that thread on the boards page. The desktop's address is unchanged.
  expect((await call('comms/open',{thread:'th:pump/1',agent:'art',title:'Pump'})).status).toBe(200);
  const own=db.select().from(threads).where(eq(threads.id,'th:pump/1')).get()!;
  expect(await settle({conversation:own.conversation,thread:own.id})).toEqual({...desktop,board:'/app/t/th%3Apump%2F1'});expect(pushes).toHaveLength(2);
  expect(JSON.stringify(pushes)).not.toContain('PRIVATE');expect(JSON.stringify(pushes)).not.toContain('Pump');
  // A thread that is not this member's own is never named.
  expect((await call('comms/open',{thread:'th:bobs',agent:'art',title:'Bob'},'d'.repeat(64))).status).toBe(200);
  const other=db.select().from(threads).where(eq(threads.id,'th:bobs')).get()!;
  expect(db.select().from(conversations).where(eq(conversations.id,other.conversation)).get()!.member).toBe('bob');
  // The Inbox's own policy already keeps such an item from being pushed at all.
  await settle({conversation:other.conversation,thread:other.id});expect(pushes).toHaveLength(2);
  // And were the member's thread to stop being theirs, an item in it would lead to the desktop only.
  root.writes.run(()=>db.update(conversations).set({member:null}).where(eq(conversations.id,own.conversation)).run());
  const before=pushes.length;await settle({conversation:own.conversation,thread:own.id});
  expect(pushes.slice(before)).toEqual([desktop]);
 }finally{await root.close();client.close();}
});

it('serves the boards manifest beside the desktop\'s',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'loom-boards-web-'));
 try{
  writeFileSync(join(dir,'next.html'),'<!doctype html>');
  const web=sharedWeb(dir),boards=await web.request('http://loom/boards.webmanifest'),desk=await web.request('http://loom/manifest.webmanifest');
  expect(boards.status).toBe(200);expect(boards.headers.get('content-type')).toBe('application/manifest+json');
  expect((await boards.json()).start_url).toBe('/app/boards');expect((await desk.json()).start_url).toBe('/');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
