import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFoundation, startLoom } from '../../foundation.js';
import { FakeClock, type Viewer, type Context, type Result } from '../../core/index.js';
import { fixture, fixtureSharing } from '../../fixture.js';
import * as crypto from './crypto.js';
import { append, thread } from './store.js';
import { attentionRole } from '../attention/role.js';
const loadKey=crypto.loadKey,owner:Viewer={kind:'member',id:'jonathan'};
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{try{for(const close of cleanup.splice(0).reverse())await close();}finally{vi.restoreAllMocks();}});
const value=<T>(r:Result):T=>{expect(r.ok).toBe(true);return (r as {ok:true;value:T}).value;};
async function setup(ref='private-ask'){
 const home=mkdtempSync(join(tmpdir(),'comms-private-reply-'));fixture(home);
 const clock=new FakeClock(),key=await loadKey(home),held=fixtureSharing();held.members.other={owner:true,agents:['art']};
 vi.spyOn(crypto,'loadKey').mockResolvedValue(key);
 let app=await startLoom({home,next:true,staging:true,clock,sharing:()=>held,stdout:()=>{}});
 cleanup.push(async()=>{await app.close();rmSync(home,{recursive:true,force:true});});
 let n=0;const call=(name:string,input:unknown,viewer=owner,window=true,id=`private-${++n}`)=>app.operations.callAsync('socket',viewer,name,input,id,window);
 const opened=value<{thread:string}>(await call('comms.open',{agent:'art',id:'aaaaaaaaaaaaaaaa',text:'Initial fixture message'}));
 const t=JSON.parse((app.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(opened.thread) as {record:string}).record);
 await expect.poll(()=>JSON.parse((app.db.prepare('SELECT record FROM comms_messages WHERE thread=? AND seq=1').get(t.id) as {record:string}).record).delivery).toBe('held');
 let attention=attentionRole(app.operations);
 if(ref.startsWith('comms:')){
  // Imported legacy ids bypass new-source namespace reservation, as the importer does.
  app.db.prepare('INSERT INTO attention_asks VALUES (?,?)').run(ref,JSON.stringify({id:ref,member:owner.id,agent:'art',source:{kind:'conversation',id:t.conversation},ask:'Reply in your private conversation',answers:'words',state:'open',createdAt:clock.now(),changedAt:clock.now()}));
 }else expect(attention.raise(owner,{id:ref,member:owner.id,agent:'art',source:{kind:'conversation',id:t.conversation},ask:'Reply in your private conversation',answers:'words'},'ask')).toMatchObject({ok:true});
 const messages=()=>app.db.prepare("SELECT * FROM comms_messages WHERE thread=? AND id=?").all(t.id,`private-reply:${ref}`);
 const getAsk=()=>value<Record<string,unknown>>(attention.get(owner,{id:ref}));
 return {get app(){return app;},clock,key,held,call,get attention(){return attention;},ref,t,messages,getAsk,
  async restart(){await app.close();app=await startLoom({home,next:true,staging:true,clock,sharing:()=>held,stdout:()=>{}});attention=attentionRole(app.operations);},
 };
}
it('seals a private answer and atomically acknowledges only its reference in Attention',async()=>{
 const f=await setup(),batches:Array<Array<{type:string;id:string}>>=[];
 const stop=f.app.live.observe(changes=>batches.push(changes));
 const words='PRIVATE typed answer sentinel';
 const answer=value<{thread:string;seq:number}>(await f.call('comms.replyToAsk',{ref:f.ref,text:words},owner,true,'keyed-reply'));stop();
 expect((f.app.db.prepare("SELECT input_hash FROM core_operations WHERE id='keyed-reply'").get() as {input_hash:string}).input_hash).toBe(f.key.hash(`comms-operation\0${JSON.stringify({ref:f.ref,text:words})}`));
 expect(answer.thread).toBe(f.t.id);expect(f.messages()).toHaveLength(1);
 expect(f.getAsk()).toMatchObject({state:'answered',answer:{kind:'replied',reply:answer,by:owner}});
 expect(batches.some(batch=>batch.some(c=>c.type==='attention.ask'&&c.id===f.ref)&&batch.some(c=>c.type==='message'&&c.id===`${answer.thread}/${answer.seq}`))).toBe(true);
 for(const table of ['attention_asks','attention_digests','core_operations','runtime_inputs','runtime_jobs'])expect(JSON.stringify(f.app.db.prepare(`SELECT * FROM ${table}`).all())).not.toContain(words);
 expect(JSON.stringify(f.messages())).not.toContain(words);
 await expect.poll(()=>JSON.parse((f.messages()[0] as {record:string}).record).delivery).toBe('held');
 const page=value<Array<{text:string|null;seq:number;ref?:string}>>(await f.call('comms.messages',{thread:f.t.id}));expect(page.find(m=>m.seq===answer.seq)).toMatchObject({text:words,ref:f.ref});
});
it('deduplicates the same reply across operation ids and refuses changed words',async()=>{
 const f=await setup(),input={ref:f.ref,text:'Private retry words'};
 const first=await f.call('comms.replyToAsk',input,owner,true,'reply');
 expect(first.ok).toBe(true);expect(await f.call('comms.replyToAsk',input,owner,true,'reply')).toEqual(first);
 expect(await f.call('comms.replyToAsk',input)).toEqual(first);
 expect(await f.call('comms.replyToAsk',{...input,text:'Changed private words'},owner,true,'reply')).toMatchObject({ok:false,code:'conflict'});
 expect(await f.call('comms.replyToAsk',{...input,text:'Changed private words'})).toMatchObject({ok:false,code:'conflict'});
 expect(f.messages()).toHaveLength(1);
});
it('requires the original member, current agent ownership and an actual page window',async()=>{
 const f=await setup(),seal=vi.spyOn(f.key,'seal'),input={ref:f.ref,text:'Forbidden words'};
 for(const viewer of [{kind:'member',id:'other'},{kind:'agent',id:'art'},{kind:'service',id:'runtime'}] as Viewer[])expect(await f.call('comms.replyToAsk',input,viewer)).toMatchObject({ok:false,code:'denied'});
 expect(await f.call('comms.replyToAsk',input,owner,false)).toMatchObject({ok:false,code:'denied'});
 for(const door of ['http','mcp','direct'] as const)expect(await f.app.operations.callAsync(door,owner,'comms.replyToAsk',input,'wrong-door',true)).toMatchObject({ok:false});
 f.held.members.jonathan.agents=[];
 expect(await f.call('comms.replyToAsk',input)).toMatchObject({ok:false,code:'denied'});
 expect(seal).not.toHaveBeenCalled();expect(f.messages()).toEqual([]);expect(f.getAsk()).toMatchObject({state:'open'});
});
it('rolls back encrypted reply and retry receipt when Attention acknowledgement fails',async()=>{
 const f=await setup(),input={ref:f.ref,text:'Retry after interrupted acknowledgement'};
 f.app.db.exec("CREATE TRIGGER fail_private_reply BEFORE UPDATE ON attention_asks BEGIN SELECT RAISE(ABORT,'interrupted fixture'); END");
 expect(await f.call('comms.replyToAsk',input,owner,true,'atomic-reply')).toMatchObject({ok:false});
 expect(f.messages()).toEqual([]);expect(f.getAsk()).toMatchObject({state:'open'});
 expect(f.app.db.prepare("SELECT 1 FROM core_operations WHERE id='atomic-reply'").get()).toBeUndefined();
 f.app.db.exec('DROP TRIGGER fail_private_reply');
 expect(await f.call('comms.replyToAsk',input,owner,true,'atomic-reply')).toMatchObject({ok:true});
 expect(f.messages()).toHaveLength(1);expect(f.getAsk()).toMatchObject({state:'answered'});
});
it('rechecks ownership, thread routing and ask state after asynchronous encryption',async()=>{
 for(const drift of ['owner','project','resolved','answered','archived','ask-source','question','member','agent'] as const){
  const f=await setup(),seal=f.key.seal;
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>entered=r);
  vi.spyOn(f.key,'seal').mockImplementation(async text=>{expect(f.app.db.inTransaction).toBe(false);entered();await gate;return seal(text);});
  const pending=f.call('comms.replyToAsk',{ref:f.ref,text:'Must not survive drift'});await ready;
  if(drift==='owner')f.held.members.jonathan.agents=[];
  else if(drift==='project')expect(await f.call('comms.change',{thread:f.t.id,action:'project',project:'pond'})).toMatchObject({ok:true});
  else if(drift==='archived')expect(await f.call('comms.change',{thread:f.t.id,action:'archive'})).toMatchObject({ok:true});
  else if(drift==='answered')expect(f.attention.answer(owner,{id:f.ref,answer:{kind:'done'}},'first-answer')).toMatchObject({ok:true});
  else if(drift==='question'){const a=f.getAsk();f.app.db.prepare('UPDATE attention_asks SET record=? WHERE id=?').run(JSON.stringify({...a,ask:'A different question'}),f.ref);}
  else if(drift==='member'||drift==='agent'){const t={...thread(f.app.db,f.t.id)!};if(drift==='member')t.member='other';else t.agent='mark';f.app.db.prepare('UPDATE comms_threads SET member=?,agent=?,record=? WHERE id=?').run(t.member,t.agent,JSON.stringify(t),t.id);}
  else if(drift==='ask-source'){const ask=f.getAsk() as {source:{id:string}};ask.source.id='another-conversation';f.app.db.prepare('UPDATE attention_asks SET record=? WHERE id=?').run(JSON.stringify(ask),f.ref);}
  else expect(f.attention.resolve(owner,{id:f.ref,reason:'No longer needed'},'resolved')).toMatchObject({ok:true});
  release();expect(await pending).toMatchObject({ok:false});expect(f.messages()).toEqual([]);
  expect(f.getAsk()).toMatchObject({state:drift==='resolved'?'resolved':drift==='answered'?'answered':'open'});
  vi.restoreAllMocks();
 }
});
it('cannot use a typed reply to authorize a waiting source or reply to an archived thread',async()=>{
 const f=await setup();
 expect(f.attention.raise(owner,{id:'waiting-ask',member:owner.id,agent:'art',source:{kind:'conversation',id:f.t.conversation},ask:'Opaque source ask',answers:'words',waits_on:{approval:'a-fixture'}},'waiting')).toMatchObject({ok:true});
 expect(await f.call('comms.replyToAsk',{ref:'waiting-ask',text:'Allow everything'})).toMatchObject({ok:false,code:'conflict'});
 expect(f.app.db.prepare("SELECT 1 FROM comms_messages WHERE id='private-reply:waiting-ask'").get()).toBeUndefined();
 expect(await f.call('comms.change',{thread:f.t.id,action:'archive'})).toMatchObject({ok:true});
 expect(await f.call('comms.replyToAsk',{ref:f.ref,text:'Archived reply'})).toMatchObject({ok:false,code:'conflict'});expect(f.messages()).toEqual([]);
});
it('does not expose the acknowledgement capability as an operation or outside a transaction',async()=>{
 const f=await setup();
 expect(f.app.operations.has('attention.privateReply')).toBe(false);
 const ctx={db:f.app.db,viewer:owner,now:f.clock.now(),changed:()=>{throw new Error('Must not publish');}} as Context;
 expect(f.attention.privateReply(ctx,{id:f.ref,conversation:f.t.conversation,agent:'art',member:owner.id,thread:f.t.id,seq:2})).toMatchObject({ok:false,code:'unavailable'});
 expect(f.getAsk()).toMatchObject({state:'open'});
 expect(f.app.operations.call('direct',owner,'attention.answer',{id:f.ref,answer:{kind:'words',text:'Still forbidden'}},'direct-private-words')).toMatchObject({ok:false,code:'invalid'});
});

it('keeps the same opaque receipt and encrypted words across restart',async()=>{
 const f=await setup(),input={ref:f.ref,text:'Private retained reply'};
 const first=await f.call('comms.replyToAsk',input,owner,true,'restart-reply');expect(first.ok).toBe(true);
 await expect.poll(()=>JSON.parse((f.messages()[0] as {record:string}).record).delivery).toBe('held');
 const before=f.messages();await f.restart();const seal=vi.spyOn(f.key,'seal');
 expect(await f.call('comms.replyToAsk',input,owner,true,'restart-reply')).toEqual(first);
 expect(await f.call('comms.replyToAsk',input)).toEqual(first);
 expect(f.messages()).toEqual(before);expect(seal).not.toHaveBeenCalled();
});
it('lets one of two concurrent typed replies win without a partial answer or second message',async()=>{
 const f=await setup(),seal=f.key.seal;let release!:()=>void,ready!:()=>void,count=0;
 const gate=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>ready=r);
 vi.spyOn(f.key,'seal').mockImplementation(async words=>{expect(f.app.db.inTransaction).toBe(false);if(++count===2)ready();await gate;return seal(words);});
 const pending=['First private answer','Second private answer'].map(text=>f.call('comms.replyToAsk',{ref:f.ref,text}));
 await entered;release();const results=await Promise.all(pending);
 expect(results.filter(r=>r.ok)).toHaveLength(1);expect(results.filter(r=>!r.ok)).toHaveLength(1);
 expect(f.messages()).toHaveLength(1);expect(f.getAsk()).toMatchObject({state:'answered',answer:{kind:'replied',reply:value(results.find(r=>r.ok)!)}});
});
it('rejects malformed and oversized words before encryption, and never resurrects expired words on retry',async()=>{
 const f=await setup(),seal=vi.spyOn(f.key,'seal');
 for(const input of [{ref:f.ref,text:''},{ref:f.ref,text:'  '},{ref:f.ref,text:'x'.repeat(4001)},{ref:f.ref,text:'words',extra:'forbidden'}])expect(await f.call('comms.replyToAsk',input)).toMatchObject({ok:false,code:'invalid'});
 expect(seal).not.toHaveBeenCalled();
 const input={ref:f.ref,text:'Only once before retention'},first=await f.call('comms.replyToAsk',input);expect(first.ok).toBe(true);
 await expect.poll(()=>JSON.parse((f.messages()[0] as {record:string}).record).delivery).toBe('held');
 f.clock.advance(14*86400_000);seal.mockClear();expect((f.messages()[0] as {words:unknown}).words).toBeNull();
 expect(await f.call('comms.replyToAsk',input)).toEqual(first);expect(seal).not.toHaveBeenCalled();
 expect((f.messages()[0] as {words:unknown}).words).toBeNull();
});

it('rechecks current ownership before replaying a successful operation receipt',async()=>{
 const f=await setup(),input={ref:f.ref,text:'Original authorized answer'};
 expect(await f.call('comms.replyToAsk',input,owner,true,'revoked-replay')).toMatchObject({ok:true});
 f.held.members.jonathan.agents=[];
 expect(await f.call('comms.replyToAsk',input,owner,true,'revoked-replay')).toMatchObject({ok:false,code:'denied'});
 expect(f.messages()).toHaveLength(1);
});
it('refuses zero or ambiguous conversation threads, including a duplicate created during encryption',async()=>{
 for(const when of ['zero','before','during'] as const){
  const f=await setup(),original=f.getAsk();
  if(when==='zero')f.app.db.prepare('UPDATE attention_asks SET record=? WHERE id=?').run(JSON.stringify({...original,source:{kind:'conversation',id:'missing-conversation'}}),f.ref);
  const duplicate=()=>{const t={...thread(f.app.db,f.t.id)!,id:'th:duplicate'};f.app.db.prepare('INSERT INTO comms_threads VALUES (?,?,?,?,?)').run(t.id,t.member,t.agent,t.project??null,JSON.stringify(t));};
  if(when==='before')duplicate();
  const seal=f.key.seal;let release!:()=>void,ready!:()=>void;
  const gate=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>ready=r);
  if(when==='during')vi.spyOn(f.key,'seal').mockImplementation(async text=>{expect(f.app.db.inTransaction).toBe(false);ready();await gate;return seal(text);});
  const pending=f.call('comms.replyToAsk',{ref:f.ref,text:'No ambiguous routing'});
  if(when==='during'){await entered;duplicate();release();}
  expect(await pending).toMatchObject({ok:false,code:'denied'});expect(f.messages()).toEqual([]);
  expect(f.getAsk()).toMatchObject({state:'open'});vi.restoreAllMocks();
 }
});
it('keeps a managed conversation ask without a wait on its owning source protocol',async()=>{
 const f=await setup(),a=f.getAsk();
 f.app.db.prepare('UPDATE attention_asks SET record=? WHERE id=?').run(JSON.stringify({...a,sourceManaged:true}),f.ref);
 expect(await f.call('comms.replyToAsk',{ref:f.ref,text:'Cannot answer managed source'})).toMatchObject({ok:false,code:'conflict'});
 expect(f.messages()).toEqual([]);expect(f.getAsk()).toMatchObject({state:'open'});
});
it('checks the capability database identity and current central answer authority independently',async()=>{
 const f=await setup(),otherHome=mkdtempSync(join(tmpdir(),'private-reply-other-')),other=createFoundation({home:otherHome}),changes:unknown[]=[];
 const input={id:f.ref,conversation:f.t.conversation,agent:'art',member:owner.id,thread:f.t.id,seq:2};
 const ctx={db:f.app.db,viewer:owner,now:f.clock.now(),changed:(...change:unknown[])=>changes.push(change)} as Context;
 try {
  expect(f.app.db.transaction(()=>f.attention.privateReply({...ctx,db:other.db},input))()).toMatchObject({ok:false,code:'unavailable'});
  const saved=f.held.members.jonathan;delete f.held.members.jonathan;
  expect(f.app.db.transaction(()=>f.attention.privateReply(ctx,input))()).toMatchObject({ok:false,code:'denied'});
  f.held.members.jonathan=saved;expect(f.getAsk()).toMatchObject({state:'open'});expect(changes).toEqual([]);
 }finally{other.close();rmSync(otherHome,{recursive:true,force:true});}
});
it('preserves ordinary public word answers and legacy private boolean answers',async()=>{
 const f=await setup();
 expect(f.attention.raise(owner,{id:'public-words',agent:'art',source:{kind:'piece',id:'fixture'},ask:'Public fixture question',answers:'words'},'public-raise')).toMatchObject({ok:true});
 expect(f.attention.answer(owner,{id:'public-words',answer:{kind:'words',text:'Public answer'}},'public-answer')).toMatchObject({ok:true,value:{answer:{kind:'words',text:'Public answer'}}});
 const ref='legacy-boolean';expect(f.attention.raise(owner,{id:ref,agent:'art',member:owner.id,source:{kind:'conversation',id:f.t.conversation},ask:'Opaque legacy question'},'legacy-raise')).toMatchObject({ok:true});
 const words=await f.key.seal(JSON.stringify({text:'Legacy question',ref}));
 f.app.db.transaction(()=>append(f.app.db,thread(f.app.db,f.t.id)!,{id:ref,kind:'ask',at:f.clock.now(),sender:'art',words,hash:f.key.hash(ref),record:JSON.stringify({ref})}))();
 expect(await f.call('comms.answer',{thread:f.t.id,ref,verdict:'yes'})).toMatchObject({ok:true});
 expect(f.attention.get(owner,{id:ref})).toMatchObject({ok:true,value:{answer:{kind:'yes',by:owner}}});
});

it('returns one acknowledgement for two concurrent identical replies with distinct operation ids',async()=>{
 const f=await setup(),seal=f.key.seal;let release!:()=>void,ready!:()=>void,count=0;
 const gate=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>ready=r);
 vi.spyOn(f.key,'seal').mockImplementation(async words=>{expect(f.app.db.inTransaction).toBe(false);if(++count===2)ready();await gate;return seal(words);});
 const input={ref:f.ref,text:'Identical concurrent words'},a=f.call('comms.replyToAsk',input),b=f.call('comms.replyToAsk',input);
 await entered;release();const results=await Promise.all([a,b]);expect(results[0]).toMatchObject({ok:true});expect(results[1]).toEqual(results[0]);expect(f.messages()).toHaveLength(1);
});
it('allows delivery-only movement but rejects replacement words while a retry prepares',async()=>{
 for(const changed of ['delivery','words'] as const){
  const f=await setup(),input={ref:f.ref,text:'Original stable reply'};
  const first=await f.call('comms.replyToAsk',input);expect(first.ok).toBe(true);
  await expect.poll(()=>JSON.parse((f.messages()[0] as {record:string}).record).delivery).toBe('held');
  const replacement=await f.key.seal(JSON.stringify({text:'Unrelated ciphertext'}));
  const pending=f.call('comms.replyToAsk',input);
  if(changed==='delivery')f.app.db.prepare("UPDATE comms_messages SET record=? WHERE thread=? AND id=?").run(JSON.stringify({delivery:'delivered',attempted:true}),f.t.id,`private-reply:${f.ref}`);
  else f.app.db.prepare('UPDATE comms_messages SET words=? WHERE thread=? AND id=?').run(replacement,f.t.id,`private-reply:${f.ref}`);
  expect(await pending).toMatchObject({ok:changed==='delivery'});expect(f.messages()).toHaveLength(1);vi.restoreAllMocks();
 }
});
it('rejects words passed to the internal capability in an otherwise authorized transaction',async()=>{
 const f=await setup(),changes:unknown[]=[];
 const ctx={db:f.app.db,viewer:owner,now:f.clock.now(),changed:(...change:unknown[])=>changes.push(change)} as Context;
 const input={id:f.ref,conversation:f.t.conversation,agent:'art',member:owner.id,thread:f.t.id,seq:2,text:'Words must never enter this capability'};
 expect(f.app.db.transaction(()=>f.attention.privateReply(ctx,input))()).toMatchObject({ok:false,code:'invalid'});
 expect(f.getAsk()).toMatchObject({state:'open'});expect(f.messages()).toEqual([]);expect(changes).toEqual([]);
});


it('keeps imported comms-prefixed private replies and their expired acknowledgements on the legacy protocol',async()=>{
 const f=await setup(`comms:${'b'.repeat(64)}`),input={ref:f.ref,text:'Legacy prefixed private words'};
 const first=await f.call('comms.replyToAsk',input,owner,true,'prefixed-legacy');expect(first.ok).toBe(true);
 await expect.poll(()=>JSON.parse((f.messages()[0] as {record:string}).record).delivery).toBe('held');
 f.clock.advance(14*86400_000);const seal=vi.spyOn(f.key,'seal');
 expect(await f.call('comms.replyToAsk',input,owner,true,'prefixed-legacy')).toEqual(first);
 expect(await f.call('comms.replyToAsk',input,owner,true,'prefixed-fresh')).toEqual(first);
 expect(seal).not.toHaveBeenCalled();expect(f.messages()).toHaveLength(1);expect((f.messages()[0] as {words:unknown}).words).toBeNull();
});
