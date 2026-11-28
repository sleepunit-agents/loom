/** A reply from the agent can bring its member back (docs/specs/boards.md, "Coming back"): a device that chose
 * replies is pushed once for an agent's reply in its member's own loom thread, REPLY_PUSH_WAIT_MS after the reply
 * was stored and only if the reply is still unread then. Real root, in-process transport: nothing reaches a push
 * service, and nothing here receives a real push. */
vi.mock('./push-transport.js',()=>({pushTransport:()=>{throw Error('External push delivery is forbidden in this proof');}}));
import {afterEach,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import webpush from 'web-push';
import {eq} from 'drizzle-orm';
import {bodyFixture,bodyCredentials as raw,credentialHash} from '../../../test/fixtures/conversation-body.js';
import * as s from '../data/schema.js';
import {REPLY_PUSH_WAIT_MS} from './shared-notifications.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const sub=(name:string)=>({endpoint:'https://fcm.googleapis.com/fictional-'+name,keys:{p256dh:'p'.repeat(87),auth:'a'.repeat(22)}});
const bobCookie='e'.repeat(64);
async function fixture(){
 const pushes:{endpoint:string;payload:Record<string,unknown>}[]=[];
 const f=await bodyFixture(clean,{notifications:{vapid:webpush.generateVAPIDKeys(),send:async(to,payload)=>{pushes.push({endpoint:to.endpoint,payload:JSON.parse(String(payload))});}}});
 const now=()=>new Date(f.clock.now()).toISOString();
 f.db.insert(s.tokens).values({fingerprint:credentialHash('o'.repeat(64)),label:'Bob',kind:'owner',member:'bob',createdAt:now()}).run();
 f.db.insert(s.sessions).values({id:credentialHash(bobCookie),token:credentialHash('o'.repeat(64)),device:'Browser',via:'link',isAgent:false,issuedAt:now(),seenAt:now(),provedAt:now()}).run();
 let n=0;
 const as=(name:string,input:unknown,cookie=raw.memberCookie)=>f.root.http.request('https://loom.test/api/'+name,{method:'POST',headers:{cookie:'loom_ui='+cookie,'content-type':'application/json'},body:JSON.stringify({input,id:'call-'+n++})});
 const enrol=async(name:string,replies?:boolean,cookie=raw.memberCookie)=>{expect((await as('notifications/subscribe',{sub:sub(name),device:name,...(replies===undefined?{}:{replies})},cookie)).status).toBe(200);};
 const reply=async(clientId:string,words='PRIVATE ANSWER')=>{const response=await f.call('message',{kind:'reply',clientId,words},'reply-'+n++);expect(response.status).toBe(200);return (await response.json()).value.seq as number;};
 // Whatever is due is sent: the wait passes, and the sender is let finish.
 const idle=async()=>{await f.root.services.notifications!.publish('alice',[]);for(let i=0;i<3;i++)await new Promise(done=>setTimeout(done,0));await f.root.services.notifications!.publish('alice',[]);};
 const wait=async(ms=REPLY_PUSH_WAIT_MS)=>{f.clock.advance(ms);await idle();};
 const rows=()=>f.db.select().from(s.notificationReplies).all();
 return{...f,pushes,as,enrol,reply,idle,wait,rows};
}
const expected=(thread:string)=>({title:'loom',body:'',tag:'loom-reply-'+sha(thread).slice(0,32),url:'/app/t/'+encodeURIComponent(thread),board:'/app/t/'+encodeURIComponent(thread)});

it('pushes a reply once to a device that chose replies, after the wait, saying no words',async()=>{
 const f=await fixture();await f.enrol('phone',true);
 expect(f.root.services.notifications!.read('alice').devices).toMatchObject([{device:'phone',replies:true}]);
 const seq=await f.reply('one');
 // Nothing leaves before the wait is over.
 await f.wait(REPLY_PUSH_WAIT_MS-1);expect(f.pushes).toEqual([]);expect(f.rows()).toMatchObject([{thread:f.thread.id,seq,attempts:0,sentAt:null}]);
 await f.wait(1);
 expect(f.pushes).toEqual([{endpoint:sub('phone').endpoint,payload:expected(f.thread.id)}]);
 expect(JSON.stringify(f.pushes[0].payload)).toBe(JSON.stringify(expected(f.thread.id)));
 expect(JSON.stringify(f.pushes)).not.toContain('PRIVATE');expect(JSON.stringify(f.pushes)).not.toContain('Private');expect(JSON.stringify(f.rows())).not.toContain('PRIVATE');
 expect(f.rows()).toMatchObject([{seq,attempts:1,sentAt:expect.any(String)}]);
 // The body's retry of the same reply stores nothing new and pushes nothing more, however long it waits.
 expect(await f.reply('one')).toBe(seq);await f.wait();await f.wait(60_000);
 expect(f.pushes).toHaveLength(1);
});

it('pushes nothing to a device that did not choose replies: the choice is off until made',async()=>{
 const f=await fixture();await f.enrol('phone');
 expect(f.db.select().from(s.notificationDevices).get()?.replies).toBe(false);
 expect(f.root.services.notifications!.read('alice').devices).toMatchObject([{replies:false}]);
 await f.reply('one');await f.wait();
 expect(f.pushes).toEqual([]);expect(f.rows()).toEqual([]);
 // Only the device that chose is pushed to, and choosing does not reach back to a reply stored before.
 await f.enrol('tablet',true);await f.wait();expect(f.pushes).toEqual([]);
 await f.reply('two');await f.wait();
 expect(f.pushes.map(push=>push.endpoint)).toEqual([sub('tablet').endpoint]);
});

it('pushes nothing when the member is looking: the thread was marked read before the wait ended',async()=>{
 const f=await fixture();await f.enrol('phone',true);
 const seq=await f.reply('one');f.clock.advance(1000);
 expect((await f.as('comms/change',{thread:f.thread.id,change:'read',seq})).status).toBe(200);
 await f.wait();
 expect(f.pushes).toEqual([]);expect(f.rows()).toMatchObject([{seq,attempts:1,sentAt:null}]);
 // The next reply, left unread, is pushed.
 await f.reply('two');await f.wait();expect(f.pushes).toHaveLength(1);
});

it('never pushes to another member\'s device',async()=>{
 const f=await fixture();await f.enrol('bobs',true,bobCookie);
 expect(f.db.select().from(s.notificationDevices).get()).toMatchObject({member:'bob',replies:true});
 await f.reply('one');await f.wait();await f.wait(60_000);
 expect(f.pushes).toEqual([]);expect(f.rows()).toEqual([]);
});

it('pushes nothing for a card, a progress message or the member\'s own message, and once for the reply that adopts the progress',async()=>{
 const f=await fixture();await f.enrol('phone',true);
 expect((await f.call('message',{kind:'card',clientId:'card',words:'PRIVATE STEP',tool:'Read',cardState:'done'},'card')).status).toBe(200);
 expect((await f.send('PRIVATE QUESTION','mine')).status).toBe(200);
 await f.wait();await f.wait(60_000);
 expect(f.db.select().from(s.messages).all().map(row=>row.kind)).toEqual(['card','message']);
 expect(f.pushes).toEqual([]);expect(f.rows()).toEqual([]);
 // A progress message is stored as the agent's words and is no reply yet; the reply that adopts it is one.
 const progressId='11111111-1111-4111-8111-111111111111',progress=await f.call('message',{kind:'progress',clientId:progressId,words:'PRIVATE PROGRESS'},'progress');
 expect(progress.status).toBe(200);await f.wait();expect(f.pushes).toEqual([]);
 expect((await f.call('message',{kind:'reply',clientId:progressId,progressId,words:'PRIVATE PROGRESS'},'adopt')).status).toBe(200);
 await f.wait();expect(f.pushes).toHaveLength(1);expect(JSON.stringify(f.pushes)).not.toContain('PRIVATE');
});

it('tells a device once of two replies stored inside the wait, and again of a later one, under the thread\'s one tag',async()=>{
 const f=await fixture();await f.enrol('phone',true);
 await f.reply('one');f.clock.advance(2000);const second=await f.reply('two');
 // The later reply took the device's row over and the wait began again.
 await f.wait(REPLY_PUSH_WAIT_MS-1);expect(f.pushes).toEqual([]);
 await f.wait(1);
 expect(f.pushes).toHaveLength(1);expect(f.rows()).toMatchObject([{seq:second,attempts:1,sentAt:expect.any(String)}]);
 // A reply after that push is a new push with the same tag: the device shows one notification for the thread.
 const third=await f.reply('three');await f.wait();
 expect(f.pushes).toHaveLength(2);expect(f.pushes[1].payload).toEqual(f.pushes[0].payload);expect(f.rows()).toMatchObject([{seq:third}]);
});

it('pushes nothing for an archived thread, a thread that is not the member\'s own, or one of another venue',async()=>{
 const f=await fixture();await f.enrol('phone',true);
 await f.reply('one');expect((await f.as('comms/change',{thread:f.thread.id,change:'archive',archived:true})).status).toBe(200);
 await f.wait();expect(f.pushes).toEqual([]);
 expect((await f.as('comms/change',{thread:f.thread.id,change:'archive',archived:false})).status).toBe(200);
 // Asked directly, as the composition asks: a venue other than loom, and a thread with no member of its own.
 const seq=await f.reply('two');
 f.root.writes.run(()=>f.db.update(s.conversations).set({venue:'terminal'}).where(eq(s.conversations.id,f.thread.conversation)).run());
 await f.wait();expect(f.pushes).toEqual([]);
 f.root.writes.run(()=>{f.db.update(s.conversations).set({venue:'loom'}).where(eq(s.conversations.id,f.thread.conversation)).run();f.db.delete(s.notificationReplies).run();});
 expect(f.root.writes.run(()=>f.root.services.notifications!.reply({member:'bob',thread:f.thread.id,seq})).value).toBe(0);
 expect(f.root.writes.run(()=>f.root.services.notifications!.reply({member:'alice',thread:f.thread.id,seq:seq+50})).value).toBe(0);
 await f.wait();expect(f.pushes).toEqual([]);
});

it('pushes nothing once the browser is signed out or the member is removed',async()=>{
 const f=await fixture();await f.enrol('phone',true);
 // Removed while the reply waits: the device's session is no longer that member's.
 await f.reply('one');
 f.root.writes.run(()=>f.db.update(s.members).set({removedAt:new Date(f.clock.now()).toISOString()}).where(eq(s.members.id,'alice')).run());
 await f.wait();expect(f.pushes).toEqual([]);
 f.root.writes.run(()=>f.db.update(s.members).set({removedAt:null}).where(eq(s.members.id,'alice')).run());
 // Signed out while the reply waits: the device and what was queued for it are gone.
 await f.reply('two');expect(f.rows()).toHaveLength(1);
 expect((await f.root.http.request('https://loom.test/logout',{method:'POST',headers:{cookie:'loom_ui='+raw.memberCookie}})).status).toBe(200);
 expect(f.db.select().from(s.notificationDevices).all()).toEqual([]);expect(f.rows()).toEqual([]);
 await f.wait();expect(f.pushes).toEqual([]);
});

it('keeps the choice the browser\'s own: enrolling again keeps it, and another person taking the browser starts off',async()=>{
 const f=await fixture();await f.enrol('phone',true);
 // The desktop's Account enrols without the choice: what was chosen here stays.
 await f.enrol('phone');expect(f.db.select().from(s.notificationDevices).get()).toMatchObject({member:'alice',replies:true});
 await f.enrol('phone',false);expect(f.db.select().from(s.notificationDevices).get()?.replies).toBe(false);
 await f.enrol('phone',true);await f.reply('one');expect(f.rows()).toHaveLength(1);
 // The same browser, now another person's: the choice and what was queued do not go with it.
 await f.enrol('phone',undefined,bobCookie);
 expect(f.db.select().from(s.notificationDevices).all()).toMatchObject([{member:'bob',replies:false}]);expect(f.rows()).toEqual([]);
 await f.wait();expect(f.pushes).toEqual([]);
 // Not a browser, no change: a bearer token cannot set it.
 expect((await f.root.http.request('https://loom.test/api/notifications/subscribe',{method:'POST',headers:{authorization:'Bearer '+raw.member,'content-type':'application/json'},body:JSON.stringify({input:{sub:sub('phone'),device:'x',replies:true},id:'bearer'})})).status).toBe(403);
 expect((await f.as('notifications/subscribe',{sub:sub('phone'),device:'x',replies:'yes'})).status).toBe(400);
});

it('answers an enrolment the same whether or not the endpoint was another person\'s, and hands nothing of theirs over',async()=>{
 // A push endpoint is one browser, and loom cannot ask a browser to prove it holds one: whoever is signed in on it
 // takes the row. So a taken row carries nothing of the last person's, and the answer never says there was one.
 const f=await fixture();await f.enrol('phone',true);await f.reply('one');expect(f.rows()).toHaveLength(1);
 const body=async(name:string)=>{const response=await f.as('notifications/subscribe',{sub:{...sub(name),keys:{p256dh:'q'.repeat(87),auth:'b'.repeat(22)}},device:'Theirs'},bobCookie);return[response.status,await response.text()];};
 expect(await body('phone')).toEqual(await body('never-seen'));
 // Every choice starts again: replies off, the taker's keys, name and session, and nothing queued for the last person.
 expect(f.db.select().from(s.notificationDevices).where(eq(s.notificationDevices.endpoint,sub('phone').endpoint)).get()).toMatchObject({member:'bob',session:credentialHash(bobCookie),device:'Theirs',replies:false,keys:JSON.stringify({p256dh:'q'.repeat(87),auth:'b'.repeat(22)})});
 expect(f.rows()).toEqual([]);expect(f.db.select().from(s.notificationQueue).all()).toEqual([]);
 expect(f.root.services.notifications!.read('alice').devices).toEqual([]);
 // The last person's later replies go nowhere, and the taker is told nothing of them.
 await f.reply('two');await f.wait();expect(f.pushes).toEqual([]);expect(f.rows()).toEqual([]);
 // The same person on another of their browsers taking the endpoint keeps their own choice: it is theirs.
 await f.enrol('tablet',true);
 const other='f'.repeat(64);f.db.insert(s.sessions).values({id:credentialHash(other),token:credentialHash(raw.member),device:'Browser 2',via:'link',isAgent:false,issuedAt:new Date(f.clock.now()).toISOString(),seenAt:new Date(f.clock.now()).toISOString(),provedAt:new Date(f.clock.now()).toISOString()}).run();
 await f.enrol('tablet',undefined,other);
 expect(f.db.select().from(s.notificationDevices).where(eq(s.notificationDevices.endpoint,sub('tablet').endpoint)).get()).toMatchObject({member:'alice',session:credentialHash(other),replies:true});
});

it('deletes what was queued with the thread',async()=>{
 const f=await fixture();await f.enrol('phone',true);await f.reply('one');expect(f.rows()).toHaveLength(1);
 expect((await f.as('comms/change',{thread:f.thread.id,change:'delete'})).status).toBe(200);
 expect(f.rows()).toEqual([]);await f.wait();expect(f.pushes).toEqual([]);
});
