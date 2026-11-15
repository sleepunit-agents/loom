/** Real Root settlement -> enrolled device transport -> production worker.
 * The provider is in-process; no vendor or operating-system delivery claim. */
vi.mock('./push-transport.js',()=>({pushTransport:()=>{throw Error('External push delivery is forbidden in this proof');}}));
import {expect,it,vi} from 'vitest';
import {runInNewContext} from 'node:vm';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import webpush from 'web-push';
import {FakeClock} from '../clock.js';
import {createDataSchema} from '../data/database.js';
import {members,tokens,sessions} from '../data/schema.js';
import {sharedRoot} from '../../shared-root.js';
import {nextWorker} from '../../next-pwa.js';
it('dispatches a private-word-free notification only while the browser device is enabled',async()=>{
 const client=new Database(':memory:'),clock=new FakeClock(),now=()=>new Date(clock.now()).toISOString(),db=createDataSchema(client,now),hash=(s:string)=>createHash('sha256').update(s).digest('hex'),cookie='c'.repeat(64),endpoint='https://fcm.googleapis.com/fictional-composed-proof';
 db.insert(members).values({id:'sam',role:'member',joinedAt:now()}).run();db.insert(tokens).values({fingerprint:hash('a'.repeat(64)),kind:'owner',member:'sam',label:'Sam',createdAt:now()}).run();db.insert(sessions).values({id:hash(cookie),token:hash('a'.repeat(64)),device:'Browser',via:'link',isAgent:false,issuedAt:now(),seenAt:now(),provedAt:now()}).run();
 const handlers:Record<string,(event:unknown)=>void>={},shown:Array<{title:string;body:string;url:string}>=[],payloads:string[]=[];
 runInNewContext(nextWorker([]),{URL,location:{origin:'https://loom.test'},self:{addEventListener:(name:string,handler:(event:unknown)=>void)=>{handlers[name]=handler;},registration:{showNotification:async(title:string,options:{body:string;data:{url:string}})=>{shown.push({title,body:options.body,url:options.data.url});}}}});
 const root=sharedRoot({db,clock,originAllowed:()=>true,reportError:error=>{throw error;},notifications:{vapid:webpush.generateVAPIDKeys(),send:async(sub,payload)=>{expect(sub.endpoint).toBe(endpoint);payloads.push(String(payload));let work:Promise<void>|undefined;handlers.push({data:{json:()=>JSON.parse(String(payload))},waitUntil:(pending:Promise<void>)=>{work=pending;}});expect(work).toBeDefined();await work;}}});
 const call=(name:string,input:unknown)=>root.http.request('https://loom.test/api/'+name,{method:'POST',headers:{cookie:'loom_ui='+cookie,'content-type':'application/json'},body:JSON.stringify({input,id:crypto.randomUUID()})});
 const notice=()=>{root.writes.run(()=>root.services.conversations.send({toKind:'person',to:'sam',member:'sam',source:'notice',fromKind:'unknown',words:'PRIVATE SETTLED WORDS'}));clock.advance(5000);};
 try{
  const response=await call('notifications/subscribe',{sub:{endpoint,keys:{p256dh:'p'.repeat(87),auth:'a'.repeat(22)}},device:'Browser'});expect(response.status).toBe(200);
  notice();await root.services.notifications!.publish('sam',[]);expect(shown).toEqual([{title:'loom',body:'',url:'https://loom.test/p/inbox-preview'}]);expect(payloads).toHaveLength(1);expect(payloads.join('')).not.toContain('PRIVATE SETTLED WORDS');
  const ref=root.services.notifications!.read('sam').devices[0].ref;expect((await call('notifications/removeDevice',{ref})).status).toBe(200);notice();await root.services.notifications!.publish('sam',[]);expect(shown).toHaveLength(1);expect(payloads).toHaveLength(1);
 }finally{await root.close();client.close();}
});
