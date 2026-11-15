import { afterEach,expect,it,vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { bodyFixture,bodyCredentials as raw,credentialHash as hash } from '../test/fixtures/conversation-body.js';
import * as s from './core/data/schema.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();vi.restoreAllMocks();});
const fixture=()=>bodyFixture(clean);
function take(f:Awaited<ReturnType<typeof fixture>>,input:unknown={input:{}},token=raw.body,headers:Record<string,string>={}){
 return f.root.http.request('/api/conversation/take',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token,...headers},body:JSON.stringify(input)});
}
type Batch={ok:true;value:{job:string;conversation:string;items:{id:string;seq:number;source:string;words:string|null;keepUntil:string|null;verdict:string|null;refs:string[]}[];stopRequested:boolean}};
it('delivers ordered private input without a receipt and confirms only after acceptance',async()=>{
 const f=await fixture();expect((await f.send('PRIVATE FIRST t-12','one')).status).toBe(200);expect((await f.send('PRIVATE SECOND','two')).status).toBe(200);const receipts=f.db.select().from(s.operationResults).all().length;
 const response=await take(f);expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');const batch=await response.json() as Batch;
 expect(batch.value).toMatchObject({job:'job',conversation:f.thread.conversation,items:[{seq:1,words:'PRIVATE FIRST t-12',refs:['t-12']},{seq:2,words:'PRIVATE SECOND'}],stopRequested:false});expect(f.db.select().from(s.operationResults).all()).toHaveLength(receipts);
 expect(f.db.select().from(s.inbox).all()).toMatchObject([{state:'taken',job:'job',words:null},{state:'taken',job:'job',words:null}]);expect(f.db.select().from(s.messages).all().map(row=>row.delivery)).toEqual(['sending','sending']);
 const ids=batch.value.items.map(row=>row.id);expect(await(await f.call('confirm',{items:ids},'accepted')).json()).toEqual({ok:true,value:{saved:true}});expect(f.db.select().from(s.inbox).all().map(row=>row.state)).toEqual(['done','done']);expect(f.db.select().from(s.messages).all().map(row=>row.delivery)).toEqual(['delivered','delivered']);
 expect((await(await take(f)).json() as Batch).value.items).toEqual([]);expect(JSON.stringify([f.db.select().from(s.jobs).all(),f.db.select().from(s.inbox).all(),f.db.select().from(s.operationResults).all()])).not.toContain('PRIVATE');
});
it('bounds the oldest prefix and repeats a held prefix without claiming later mail',async()=>{
 const f=await fixture();for(const [id,text]of [['one','First'],['two','Second'],['three','Third']])expect((await f.send(text,id)).status).toBe(200);
 const first=await(await take(f,{input:{limit:1}})).json() as Batch;expect(first.value.items.map(row=>row.words)).toEqual(['First']);const repeated=await(await take(f,{input:{limit:1}})).json() as Batch;expect(repeated.value.items.map(row=>row.id)).toEqual(first.value.items.map(row=>row.id));expect(f.db.select().from(s.inbox).all().map(row=>row.state)).toEqual(['taken','waiting','waiting']);
 expect((await f.call('confirm',{items:[first.value.items[0].id]},'first')).status).toBe(200);expect((await(await take(f,{input:{limit:1}})).json() as Batch).value.items.map(row=>row.words)).toEqual(['Second']);
});
it('rejects public actor labels, cookies, operation IDs, cross-origin and input-selected authority',async()=>{
 const f=await fixture();await f.send('PRIVATE','one');let opens=0;f.openGate(async()=>{opens++;});
 for(const token of [raw.member,raw.agent,raw.runner])expect((await take(f,{input:{}},token)).status).toBe(403);
 const cookie=await f.root.http.request('/api/conversation/take',{method:'POST',headers:{'content-type':'application/json',cookie:'loom_ui='+raw.memberCookie},body:'{"input":{}}'});expect(cookie.status).toBe(403);
 for(const input of [{input:{job:'job'}},{input:{conversation:f.thread.conversation}},{input:{limit:0}},{input:{limit:101}},{input:{},id:'must-not-cache'}])expect((await take(f,input)).status).toBe(400);
 expect((await take(f,{input:{}},raw.body,{origin:'https://other.invalid','sec-fetch-site':'cross-site'})).status).toBe(403);expect(opens).toBe(0);expect(f.db.select().from(s.inbox).get()?.state).toBe('waiting');
});
it.each(['ownership','project','job','token','box','scope','refs','cipher'])('withholds a prepared batch after %s changes while decryption yields',async change=>{
 const f=await fixture();await f.send('PRIVATE HELD','one');let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{entered=r;});f.openGate(()=>{entered();return new Promise<void>(r=>{release=r;});});
 const pending=take(f);await started;f.root.writes.run(()=>{
  if(change==='ownership')f.db.delete(s.memberAgents).run();if(change==='project')f.db.delete(s.projectAgents).run();if(change==='job')f.db.update(s.jobs).set({state:'done'}).run();if(change==='token')f.db.update(s.tokens).set({revokedAt:new Date(f.clock.now()).toISOString()}).where(eq(s.tokens.fingerprint,hash(raw.body))).run();if(change==='box')f.db.update(s.boxes).set({revokedAt:new Date(f.clock.now()).toISOString()}).run();if(change==='scope')f.db.update(s.inbox).set({member:'bob'}).run();if(change==='refs')f.db.insert(s.inboxRefs).values({item:f.db.select().from(s.inbox).get()!.id,ref:'t-new'}).run();if(change==='cipher')f.db.update(s.messages).set({words:Buffer.from('changed cipher')}).run();
 });release();const response=await pending;expect([403,503]).toContain(response.status);expect(await response.text()).not.toContain('PRIVATE HELD');expect(f.db.select().from(s.inbox).get()?.state).toBe('waiting');expect(f.db.select().from(s.operationResults).all().filter(row=>row.operation.startsWith('conversation.'))).toEqual([]);
});
it('leaves mail arriving during decryption for the next prefix',async()=>{
 const f=await fixture();await f.send('First','one');let entered!:()=>void,release!:()=>void,calls=0;const started=new Promise<void>(r=>{entered=r;});f.openGate(async()=>{if(++calls===1){entered();await new Promise<void>(r=>{release=r;});}});
 const pending=take(f);await started;expect((await f.send('Second','two')).status).toBe(200);release();const batch=await(await pending).json() as Batch;expect(batch.value.items.map(row=>row.words)).toEqual(['First']);expect(f.db.select().from(s.inbox).all().map(row=>row.state)).toEqual(['taken','waiting']);
});
it('withholds words changed by a reentrant postcommit writer and permits a fresh take',async()=>{
 const f=await fixture();await f.send('PRIVATE BEFORE','one');const cipher=await f.root.services.comms!.key.seal('PRIVATE AFTER');let changed=false;
 f.root.writes.observe(()=>{if(!changed&&f.db.select().from(s.inbox).get()?.state==='taken'){changed=true;f.root.writes.run(()=>f.db.update(s.messages).set({words:cipher}).run());}});
 const response=await take(f);expect(response.status).toBe(503);expect(await response.text()).not.toContain('PRIVATE BEFORE');expect((await(await take(f)).json() as Batch).value.items[0].words).toBe('PRIVATE AFTER');
});
it('guards deferred wrapped-clone input at its deadline without running an expiry timer',async()=>{
 const f=await fixture();await f.send('PRIVATE DEADLINE','one');const start=f.clock.now();let time=start;vi.spyOn(f.clock,'now').mockImplementation(()=>time);f.root.writes.run(()=>f.db.update(s.messages).set({keepUntil:new Date(start+1000).toISOString()}).run());
 const response=await take(f);expect(response.status).toBe(200);const wrapped=new Response(response.body,response),copy=wrapped.clone();await Promise.resolve();time+=1000;await expect(copy.text()).rejects.toThrow('Data access ended');await expect(wrapped.text()).rejects.toThrow('Data access ended');
 expect(f.db.select().from(s.messages).get()?.words).not.toBeNull();const retry=await(await take(f)).json() as Batch;expect(retry.value.items[0].words).toBeNull();
});
it('drains a held input callback at shutdown and releases no late words or claim',async()=>{
 const f=await fixture();await f.send('PRIVATE SHUTDOWN','one');let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{entered=r;});f.openGate(()=>{entered();return new Promise<void>(r=>{release=r;});});
 const pending=take(f);await started;let closed=false;const closing=f.root.close().then(()=>{closed=true;});await Promise.resolve();expect(closed).toBe(false);release();const response=await pending;expect([403,503]).toContain(response.status);expect(await response.text()).not.toContain('PRIVATE SHUTDOWN');await closing;expect(f.db.select().from(s.inbox).get()?.state).toBe('waiting');
});
it.each(['member','project','agent'] as const)('refuses confirmation with mismatched %s mail scope',async field=>{
 const f=await fixture();await f.send('PRIVATE SCOPE','one');const batch=await(await take(f)).json() as Batch,id=batch.value.items[0].id;
 const before=f.db.select().from(s.inbox).get()!;f.root.writes.run(()=>f.db.update(s.inbox).set({[field]:field==='member'?'bob':field==='project'?'other':'mark'}).where(eq(s.inbox.id,id)).run());
 expect((await f.call('confirm',{items:[id]},'scope')).status).toBe(403);expect(f.db.select().from(s.inbox).get()?.state).toBe('taken');expect(f.db.select().from(s.messages).get()?.delivery).toBe('sending');
 f.root.writes.run(()=>f.db.update(s.inbox).set({[field]:before[field]}).where(eq(s.inbox.id,id)).run());expect((await f.call('confirm',{items:[id]},'scope')).status).toBe(200);
});
it('rolls back the entire HTTP confirmation batch when its second delivery update fails, then retries',async()=>{
 const f=await fixture();await f.send('PRIVATE ONE','one');await f.send('PRIVATE TWO','two');const ids=(await(await take(f)).json() as Batch).value.items.map(item=>item.id);
 f.db.$client.exec("CREATE TRIGGER fail_second_confirmation BEFORE UPDATE OF delivery ON messages WHEN new.seq=2 AND new.delivery='delivered' BEGIN SELECT RAISE(ABORT,'fictitious second confirmation failure'); END");
 expect((await f.call('confirm',{items:ids},'atomic')).status).toBe(503);expect(f.db.select().from(s.inbox).all().map(row=>row.state)).toEqual(['taken','taken']);expect(f.db.select().from(s.messages).all().map(row=>row.delivery)).toEqual(['sending','sending']);expect(f.db.select().from(s.operationResults).all().some(row=>row.operation==='conversation.confirm')).toBe(false);
 f.db.$client.exec('DROP TRIGGER fail_second_confirmation');expect((await f.call('confirm',{items:ids},'atomic')).status).toBe(200);expect(f.db.select().from(s.inbox).all().map(row=>row.state)).toEqual(['done','done']);
});
it.each(['token','ownership','conversation','cipher','refs','shutdown'] as const)('withdraws unread original and wrapped-clone take responses after %s changes',async change=>{
 const f=await fixture();await f.send('PRIVATE UNREAD','one');const response=await take(f);expect(response.status).toBe(200);const wrapped=new Response(response.body,response),copy=wrapped.clone();await Promise.resolve();
 if(change==='shutdown')await f.root.close();else f.root.writes.run(()=>{
  if(change==='token')f.db.update(s.tokens).set({revokedAt:new Date(f.clock.now()).toISOString()}).where(eq(s.tokens.fingerprint,hash(raw.body))).run();
  if(change==='ownership')f.db.delete(s.memberAgents).run();if(change==='conversation')f.db.update(s.conversations).set({member:'bob'}).run();
  if(change==='cipher')f.db.update(s.messages).set({words:Buffer.from('different')}).run();if(change==='refs')f.db.insert(s.inboxRefs).values({item:f.db.select().from(s.inbox).get()!.id,ref:'t-later'}).run();
 });
 await expect(copy.text()).rejects.toThrow('Data access ended');await expect(wrapped.text()).rejects.toThrow('Data access ended');expect(f.db.select().from(s.inbox).get()?.state).toBe('taken');expect(f.db.select().from(s.messages).get()?.delivery).toBe('sending');
});
