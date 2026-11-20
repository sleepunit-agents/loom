import {afterEach,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {bodyFixture,bodyCredentials as raw} from '../test/fixtures/conversation-body.js';
import * as s from './core/data/schema.js';
const clean:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
const selection='{inboxItems(folder:"needs"){id canAnswer source sourceId state body{words}} inboxFolders{needs} }';
it('publishes a native Secret request in the owner mailbox and removes access on current owner demotion',async()=>{
 const f=await bodyFixture(clean),at=new Date(f.clock.now()).toISOString(),id=randomUUID();
 f.root.writes.run(()=>{
  f.db.update(s.members).set({role:'owner'}).where(eq(s.members.id,'alice')).run();
  f.db.insert(s.secrets).values({name:'TOKEN',description:'Fictitious credential',changedBy:'alice',changedAt:at}).run();
  f.db.insert(s.secretChanges).values({id:randomUUID(),secret:'TOKEN',action:'add',by:'alice',at}).run();
 });
 const response=await f.root.http.request('/api/secrets/request',{method:'POST',headers:{authorization:'Bearer '+raw.body,'content-type':'application/json'},body:JSON.stringify({id:randomUUID(),input:{id,secret:'TOKEN',why:'A fictitious read',minutes:7}})});
 expect(response.status).toBe(200);
 const item=f.db.select().from(s.inbox).where(eq(s.inbox.sourceId,id)).get()!;expect(item).toMatchObject({to:'alice',state:'waiting',waitsOnKind:'secret-request',waitsOnId:id,conversation:f.thread.conversation});
 const read=()=>f.root.http.request('/graphql',{method:'POST',headers:{cookie:'loom_ui='+raw.memberCookie,'content-type':'application/json'},body:JSON.stringify({query:selection})});
 expect(await(await read()).json()).toMatchObject({data:{inboxItems:[{id:item.id,canAnswer:false,source:'secret-request',sourceId:id,state:'waiting',body:{words:'Allow art to use TOKEN for 7 minutes?'}}],inboxFolders:{needs:1}}});
 const generic=await f.root.http.request('/api/inbox/answer',{method:'POST',headers:{cookie:'loom_ui='+raw.memberCookie,'content-type':'application/json'},body:JSON.stringify({id:randomUUID(),input:{item:item.id,answer:'yes'}})});expect(generic.status).toBe(400); // refused in words: it is answered where the request livesexpect(f.db.select().from(s.secretRequests).where(eq(s.secretRequests.id,id)).get()?.state).toBe('pending');
 const direct=()=>f.root.http.request('/graphql',{method:'POST',headers:{cookie:'loom_ui='+raw.memberCookie,'content-type':'application/json'},body:JSON.stringify({query:'{inboxItem(id:'+JSON.stringify(item.id)+'){id body{words}}}'})});
 expect(await(await direct()).json()).toMatchObject({data:{inboxItem:{id:item.id,body:{words:'Allow art to use TOKEN for 7 minutes?'}}}});
 const held=await read();f.root.writes.run(()=>f.db.update(s.members).set({role:'member'}).where(eq(s.members.id,'alice')).run());
 expect(await(await read()).json()).toEqual({data:{inboxItems:[],inboxFolders:{needs:0}}});await expect(held.text()).rejects.toThrow();
 expect(await(await direct()).json()).toEqual({data:{inboxItem:null}});
 for(const [operation,extra]of [['read',{}],['volume',{volume:'mute'}]]as const){
  const denied=await f.root.http.request('/api/inbox/'+operation,{method:'POST',headers:{cookie:'loom_ui='+raw.memberCookie,'content-type':'application/json'},body:JSON.stringify({id:randomUUID(),input:{item:item.id,...extra}})});expect(denied.status).toBe(403);
 }
 f.root.writes.run(()=>f.db.update(s.members).set({role:'owner'}).where(eq(s.members.id,'alice')).run());
 const answer=await f.root.http.request('/api/secrets/command',{method:'POST',headers:{cookie:'loom_ui='+raw.memberCookie,'content-type':'application/json'},body:JSON.stringify({id:randomUUID(),input:{action:'answer',id,allow:true,always:false}})});expect(answer.status).toBe(200);
 expect(f.db.select().from(s.inbox).where(eq(s.inbox.id,item.id)).get()?.state).toBe('resolved');expect(await(await read()).json()).toEqual({data:{inboxItems:[],inboxFolders:{needs:0}}});
 expect(f.db.select().from(s.secretRequests).where(eq(s.secretRequests.id,id)).get()?.state).toBe('allowed');
 const resumed=await f.root.http.request('/api/secrets/requestStatus',{method:'POST',headers:{authorization:'Bearer '+raw.body,'content-type':'application/json'},body:JSON.stringify({input:{id}})});expect(await resumed.json()).toEqual({ok:true,value:{id,state:'allowed'}});
 const pending=randomUUID();expect((await f.root.http.request('/api/secrets/request',{method:'POST',headers:{authorization:'Bearer '+raw.body,'content-type':'application/json'},body:JSON.stringify({id:randomUUID(),input:{id:pending,secret:'TOKEN',why:'Another fictitious read',minutes:7}})})).status).toBe(200);
 expect((await(await read()).json()).data.inboxItems).toHaveLength(1);
 f.root.writes.run(()=>f.db.delete(s.secretRequests).where(eq(s.secretRequests.id,pending)).run());
 expect(await(await read()).json()).toEqual({data:{inboxItems:[],inboxFolders:{needs:0}}});
});
