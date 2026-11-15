import Database from 'better-sqlite3';
import webpush from 'web-push';
import {createHash} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterEach,expect,it,vi} from 'vitest';
import {FakeClock} from '../clock.js';
import {createDataSchema} from '../data/database.js';
import {members,tokens,sessions,notificationDevices,notificationQueue,inbox} from '../data/schema.js';
import type {PushTransport} from './push-transport.js';
import {sharedRoot} from '../../shared-root.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
const hash=(value:string)=>createHash('sha256').update(value).digest('hex'),sub={endpoint:'https://fcm.googleapis.com/fictional-device',keys:{p256dh:'p'.repeat(87),auth:'a'.repeat(22)}};
function fixture(){
 const client=new Database(':memory:');clean.push(()=>client.close());const clock=new FakeClock(),now=()=>new Date(clock.now()).toISOString(),db=createDataSchema(client,now),raw={sam:'a'.repeat(64),other:'b'.repeat(64)},cookie={sam:'c'.repeat(64),other:'d'.repeat(64)},vapid=webpush.generateVAPIDKeys(),send=vi.fn<PushTransport>(async()=>{});
 for(const member of ['sam','other'] as const){db.insert(members).values({id:member,role:'member',joinedAt:now()}).run();db.insert(tokens).values({fingerprint:hash(raw[member]),kind:'owner',member,label:member,createdAt:now()}).run();db.insert(sessions).values({id:hash(cookie[member]),token:hash(raw[member]),device:member+' browser',via:'link',isAgent:false,issuedAt:now(),seenAt:now(),provedAt:now()}).run();}
 const root=sharedRoot({db,clock,originAllowed:()=>true,reportError:()=>{},notifications:{vapid,send}});clean.push(()=>root.close());
 const call=(name:string,input:unknown,member:'sam'|'other'='sam',headers={})=>root.http.request('http://loom/api/'+name,{method:'POST',headers:{cookie:'loom_ui='+cookie[member],'content-type':'application/json',...headers},body:JSON.stringify({input,id:Math.random().toString()})});
 const read=(member:'sam'|'other'='sam')=>root.http.request('http://loom/graphql',{method:'POST',headers:{cookie:'loom_ui='+cookie[member],'content-type':'application/json'},body:JSON.stringify({query:'{ account { notifications { publicKey devices { ref device } } } }'})}).then(r=>r.json());
 const item=(id:string,patch:Partial<typeof inbox.$inferInsert>={})=>root.writes.run(()=>db.insert(inbox).values({id,toKind:'person',to:'sam',member:'sam',source:'notice',fromKind:'agent',words:'PRIVATE INBOX WORDS',state:'waiting',at:now(),changedAt:now(),...patch}).run());
 return{client,db,clock,root,raw,cookie,vapid,send,call,read,item};
}
it('enrolls only a current personal browser, keeps endpoints/keys private, and removes only owned devices',async()=>{
 const f=fixture(),input={sub,device:'Phone'};
 expect((await f.call('notifications/subscribe',input,'sam',{authorization:'Bearer '+f.raw.sam})).status).toBe(403);
 expect((await f.call('notifications/subscribe',{...input,sub:{...sub,endpoint:'https://127.0.0.1/private'}})).status).toBe(400);
 expect((await f.call('notifications/subscribe',input)).status).toBe(200);
 const own=(await f.read()).data.account.notifications,other=(await f.read('other')).data.account.notifications;
 expect(own).toEqual({publicKey:f.vapid.publicKey,devices:[{ref:expect.any(String),device:'Phone'}]});expect(other.devices).toEqual([]);expect(JSON.stringify(own)).not.toContain(sub.endpoint);expect(JSON.stringify(own)).not.toContain(sub.keys.auth);
 expect((await f.call('notifications/subscribe',input,'other')).status).toBe(409);
 expect((await f.call('notifications/removeDevice',{ref:own.devices[0].ref},'other')).status).toBe(404);
 expect((await f.call('notifications/removeDevice',{ref:own.devices[0].ref})).status).toBe(200);expect(f.db.select().from(notificationDevices).all()).toEqual([]);
});
it('pushes only currently visible settled full-volume Inbox items, once, without their words',async()=>{
 const f=fixture();await f.call('notifications/subscribe',{sub,device:'Phone'});f.item('allowed');f.item('muted',{volume:'mute'});f.item('hidden',{member:'other'});f.item('other-person',{to:'other',member:'other'});
 await f.root.services.notifications!.publish('sam',['allowed','muted','hidden','other-person']);
 expect(f.send).toHaveBeenCalledOnce();expect(f.send.mock.calls[0]?.[0]).toEqual(sub);expect(JSON.stringify(f.send.mock.calls)).not.toContain('PRIVATE INBOX WORDS');expect(f.db.select().from(notificationQueue).all()).toMatchObject([{item:'allowed',attempts:1,sentAt:expect.any(String)}]);
 await f.root.services.notifications!.publish('sam',['allowed']);expect(f.send).toHaveBeenCalledOnce();
});
it('does not retry uncertain attempts and removes gone devices without deleting a newly rebound device',async()=>{
 const f=fixture();await f.call('notifications/subscribe',{sub,device:'Phone'});f.item('uncertain');f.send.mockRejectedValueOnce(Error('network'));
 await f.root.services.notifications!.publish('sam',['uncertain']);await f.root.services.notifications!.publish('sam',['uncertain']);expect(f.send).toHaveBeenCalledOnce();expect(f.db.select().from(notificationQueue).get()).toMatchObject({attempts:1,sentAt:null});
 f.item('gone');f.send.mockRejectedValueOnce({statusCode:410});await f.root.services.notifications!.publish('sam',['gone']);expect(f.db.select().from(notificationDevices).all()).toEqual([]);expect(f.db.select().from(notificationQueue).all()).toEqual([]);
});
it('ends queued notification devices with their browser and refuses stale delivery authority',async()=>{
 const f=fixture();await f.call('notifications/subscribe',{sub,device:'Phone'});f.item('waiting');
 f.root.writes.run(()=>f.db.update(tokens).set({revokedAt:new Date(f.clock.now()).toISOString()}).where(eq(tokens.member,'sam')).run());
 await f.root.services.notifications!.publish('sam',['waiting']);expect(f.send).not.toHaveBeenCalled();
 f.db.update(tokens).set({revokedAt:null}).where(eq(tokens.member,'sam')).run();
 await f.root.services.notifications!.publish('sam',['waiting']);expect(f.send).toHaveBeenCalledOnce();
 const response=await f.root.http.request('http://loom/logout',{method:'POST',headers:{cookie:'loom_ui='+f.cookie.sam}});expect(response.status).toBe(200);expect(f.db.select().from(notificationDevices).all()).toEqual([]);expect(f.db.select().from(notificationQueue).all()).toEqual([]);
});
