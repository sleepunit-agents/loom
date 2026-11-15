import Database from 'better-sqlite3';
import { afterEach,expect,it,vi } from 'vitest';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { actionResults, members, sessions,tokens,memberPreferences } from './core/data/schema.js';
import { sharedRoot } from './shared-root.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();vi.restoreAllMocks();});
const hash=(v:string)=>createHash('sha256').update(v).digest('hex'),token='t'.repeat(64),cookie='c'.repeat(64);
function fixture(){const client=new Database(':memory:');clean.push(()=>client.close());const clock=new FakeClock(Date.parse('2026-11-14T18:00:00Z')),now=()=>new Date(clock.now()).toISOString(),db=createDataSchema(client,now);
 db.insert(members).values({id:'alice',role:'member',joinedAt:now()}).run();db.insert(tokens).values({fingerprint:hash(token),kind:'owner',member:'alice',label:'Fictional',createdAt:now()}).run();db.insert(sessions).values({id:hash(cookie),token:hash(token),device:'Browser',via:'link',isAgent:false,issuedAt:now(),seenAt:now(),provedAt:now()}).run();const errors:unknown[]=[];
 const root=sharedRoot({db,clock,originAllowed:()=>true,commsKey:{seal:async words=>Buffer.from(words),open:async bytes=>Buffer.from(bytes).toString(),hash:words=>hash('fixture-key:'+words)},reportError:error=>errors.push(error)});clean.push(()=>root.close());
 root.operations.register({name:'tasks.fixture',write:true,recheckPolicy:true,input:z.object({sensitive:z.string()}),output:z.object({saved:z.literal(true)}),may:()=>true,run(){return {saved:true};}});
 const call=(name:string,input:unknown,id='action',bearer=false)=>root.http.request('/api/'+name.replace('.','/'),{method:'POST',headers:{'content-type':'application/json',...(bearer?{authorization:'Bearer '+token}:{cookie:'loom_ui='+cookie})},body:JSON.stringify({input,id})});return {client,db,clock,root,call,errors};}
it('records actual browser outcomes without request/output words and preserves dismissals across replay',async()=>{
 const f=fixture();expect((await f.call('tasks.fixture',{sensitive:'NEVER IN NOTICES'})).status).toBe(200);const first=f.db.select().from(actionResults).get()!;expect(first).toMatchObject({member:'alice',ok:true,text:'Saved in Tasks',page:'/p/tasks-preview',readAt:null});expect(JSON.stringify(first)).not.toContain('NEVER');
 f.db.update(actionResults).set({readAt:'2026-11-14T18:00:01Z'}).where(eq(actionResults.id,first.id)).run();expect((await f.call('tasks.fixture',{sensitive:'NEVER IN NOTICES'})).status).toBe(200);expect(f.db.select().from(actionResults).all()).toMatchObject([{id:first.id,readAt:'2026-11-14T18:00:01Z'}]);
 expect((await f.call('tasks.fixture',{sensitive:'DIFFERENT PRIVATE INPUT'})).status).toBe(409);expect(f.db.select().from(actionResults).all()).toHaveLength(2);expect(f.db.select().from(actionResults).all().find(row=>!row.ok)).toMatchObject({text:'Could not save in Tasks',readAt:null});expect(JSON.stringify(f.db.select().from(actionResults).all())).not.toContain('PRIVATE');
});
it('records a real failed browser write and keeps bearer writes and unknown operations out of personal notices',async()=>{
 const f=fixture();expect((await f.call('household.setPreferences',{look:'daylight'},'saved')).status).toBe(200);expect((await f.call('household.setPreferences',{look:'invalid'},'bad')).status).toBe(400);
 expect((await f.call('tasks.fixture',{sensitive:'bearer'},'outside',true)).status).toBe(200);expect((await f.call('unknown.operation',{},'unknown')).status).toBe(404);expect(f.db.select().from(actionResults).all()).toMatchObject([{ok:true,text:'Saved in Appearance'},{ok:false,text:'Could not save in Appearance'}]);
});
it('does not turn committed success into failure when the notice write fails',async()=>{
 const f=fixture();f.client.exec("CREATE TRIGGER fail_notice BEFORE INSERT ON action_results BEGIN SELECT RAISE(ABORT,'PRIVATE DRIVER TEXT'); END");const response=await f.call('household.setPreferences',{look:'daylight'});expect(response.status).toBe(200);expect((await response.json() as {ok:boolean}).ok).toBe(true);expect(f.db.select().from(memberPreferences).get()?.look).toBe('daylight');expect(f.db.select().from(actionResults).all()).toEqual([]);expect(f.errors.map(String)).toEqual(['Error: Action notice could not be recorded']);
});
it('does not make notices from opening an Inbox item or dismissing an existing notice',async()=>{
 const f=fixture(),item=f.root.services.conversations.send({toKind:'person',to:'alice',member:'alice',source:'notice',fromKind:'unknown',words:'A notice'});
 expect((await f.call('inbox.read',{item:item.id},'read')).status).toBe(200);expect(f.db.select().from(actionResults).all()).toEqual([]);
 expect((await f.call('household.setPreferences',{look:'daylight'},'prefs')).status).toBe(200);const notice=f.db.select().from(actionResults).get()!;
 expect((await f.call('inbox.dismissResult',{id:notice.id},'dismiss')).status).toBe(200);expect(f.db.select().from(actionResults).all()).toHaveLength(1);expect(f.db.select().from(actionResults).get()?.readAt).not.toBeNull();
});
it('creates a new notice generation after the write receipt expires without reopening its old dismissal',async()=>{
 const f=fixture();expect((await f.call('household.setPreferences',{look:'daylight'})).status).toBe(200);const first=f.db.select().from(actionResults).get()!;f.db.update(actionResults).set({readAt:new Date(f.clock.now()).toISOString()}).run();
 f.clock.advance(31*86400000);const at=new Date(f.clock.now()).toISOString();f.db.update(sessions).set({issuedAt:at,seenAt:at,provedAt:at}).run();
 expect((await f.call('household.setPreferences',{look:'daylight'})).status).toBe(200);const results=f.db.select().from(actionResults).all();expect(results).toHaveLength(2);expect(results.find(row=>row.id===first.id)?.readAt).not.toBeNull();expect(results.find(row=>row.id!==first.id)?.readAt).toBeNull();
});
it('binds notices and their query to the actual browser member even when operation IDs are shared',async()=>{
 const f=fixture(),otherToken='o'.repeat(64),otherCookie='p'.repeat(64),at=new Date(f.clock.now()).toISOString();f.db.insert(members).values({id:'bob',role:'owner',joinedAt:at}).run();f.db.insert(tokens).values({fingerprint:hash(otherToken),kind:'owner',member:'bob',label:'Bob',createdAt:at}).run();f.db.insert(sessions).values({id:hash(otherCookie),token:hash(otherToken),device:'Browser',via:'link',isAgent:false,issuedAt:at,seenAt:at,provedAt:at}).run();
 expect((await f.call('tasks.fixture',{sensitive:'Alice input'},'shared-id')).status).toBe(200);
 const response=await f.root.http.request('/api/tasks/fixture',{method:'POST',headers:{'content-type':'application/json',cookie:'loom_ui='+otherCookie},body:JSON.stringify({input:{sensitive:'Bob input'},id:'shared-id'})});expect(response.status).toBe(200);
 const notices=f.db.select().from(actionResults).all();expect(notices).toHaveLength(2);expect(new Set(notices.map(row=>row.id)).size).toBe(2);
 for(const [personCookie,person] of [[cookie,'alice'],[otherCookie,'bob']]){const read=await f.root.http.request('/graphql',{method:'POST',headers:{'content-type':'application/json',cookie:'loom_ui='+personCookie},body:JSON.stringify({query:'{inboxActionResults{id text}}'})});expect(await read.json()).toEqual({data:{inboxActionResults:[{id:notices.find(row=>row.member===person)!.id,text:'Saved in Tasks'}]}});}
});
