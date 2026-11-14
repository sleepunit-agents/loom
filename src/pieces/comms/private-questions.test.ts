import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startLoom} from '../../foundation.js';
import {FakeClock,type Sharing} from '../../core/index.js';
import {installAttention,attentionSources} from '../attention/index.js';
import {createHash} from 'node:crypto';
import {attentionRole} from '../attention/role.js';
import {installComms} from './index.js';
import {loadKey} from './crypto.js';
import {stagingHold,type Delivery,type Hold} from './role.js';
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const f of cleanup.splice(0).reverse())await f();vi.restoreAllMocks();});
async function setup(hold:Hold=async f=>f()){
 const deliveries:Delivery[]=[];
 const home=mkdtempSync(join(tmpdir(),'private-question-')),clock=new FakeClock(),key=await loadKey(home);
 const sharing:Sharing={members:{jonathan:{owner:true,agents:['art']},other:{owner:true,agents:['art']}},projects:{}};
 let comms!:ReturnType<typeof installComms>;
 const app=await startLoom({home,clock,install:a=>{
  installAttention(a.db,a.operations,a.live,()=>sharing);
  comms=installComms({...a,clock,key,sharing:()=>sharing,attention:attentionRole(a.operations),runtime:{deliver:async d=>{deliveries.push(d);},end:async()=>{}},hold});
 }});
 cleanup.push(async()=>{await comms.close();await app.close();rmSync(home,{recursive:true,force:true});});
 const viewer={kind:'member',id:'jonathan'} as const;
 let n=0;const call=(name:string,input:unknown,v=viewer)=>app.operations.callAsync('socket',v,name,input,`test-${++n}`,true);
 const r=await call('comms.open',{agent:'art',id:'aaaaaaaaaaaaaaaa',text:'Hello'});if(!r.ok)throw Error(r.message);
 const place=(r.value as {thread:string}).thread;
 const attention=attentionRole(app.operations);
 return {app,clock,key,sharing,comms,call,place,attention,viewer,deliveries};
}
const question={ask:'PRIVATE QUESTION SENTINEL',why:'PRIVATE WHY SENTINEL',if_yes:'PRIVATE YES SENTINEL',href:'https://private.invalid',refs:['private-note'],answers:'words' as const};
it('seals the whole question and atomically publishes only a metadata projection',async()=>{
 const f=await setup(),batches:unknown[]=[];const stop=f.app.live.observe(c=>batches.push(c));
 const r=await f.comms.ask('art',f.place,{id:'question',question});stop();
 expect(f.attention.get(f.viewer,{id:r.ref})).toMatchObject({ok:true,value:{ask:'Reply in your private conversation',state:'open',member:'jonathan',agent:'art',privateQuestion:{thread:f.place,seq:r.seq}}});
 for(const table of ['attention_asks','core_operations','comms_messages']){
  const stored=JSON.stringify(f.app.db.prepare(`SELECT * FROM ${table}`).all());
  for(const word of [question.ask,question.why,question.if_yes,question.href,...question.refs])expect(stored).not.toContain(word);
 }
 const page=await f.call('comms.messages',{thread:f.place});expect(page).toMatchObject({ok:true,value:expect.arrayContaining([expect.objectContaining({ask:question})])});
 const sealed=f.app.db.prepare('SELECT hash FROM comms_messages WHERE thread=? AND seq=?').get(f.place,r.seq) as {hash:string};
 expect(sealed.hash).toBe(f.key.hash(JSON.stringify({id:'question',question})));
 expect(batches).toContainEqual(expect.arrayContaining([{type:'message',id:`${f.place}/${r.seq}`},{type:'attention.ask',id:r.ref}]));
 expect(await f.call('attention.get',{id:r.ref},{kind:'member',id:'other'} as never)).toMatchObject({ok:false});
 expect(f.attention.raise(f.viewer,{id:r.ref,ask:'overwrite',source:{kind:'conversation',id:'fake'}},'overwrite')).toMatchObject({ok:false});
 expect(f.attention.resolve(f.viewer,{id:r.ref,reason:'overwrite'},'resolve')).toMatchObject({ok:false});
});
it('keeps first identity, answer and ciphertext on retry and refuses altered words',async()=>{
 const f=await setup(),input={id:'question',question},r=await f.comms.ask('art',f.place,input);
 const row=()=>f.app.db.prepare('SELECT * FROM comms_messages WHERE thread=? AND seq=?').get(f.place,r.seq);
 const original=row();
 expect(await f.call('comms.replyToAsk',{ref:r.ref,text:'Private answer'})).toMatchObject({ok:true});
 expect(await f.comms.ask('art',f.place,input)).toEqual(r);expect(row()).toEqual(original);
 expect(f.attention.get(f.viewer,{id:r.ref})).toMatchObject({ok:true,value:{state:'answered',answer:{kind:'replied'}}});
 await expect(f.comms.ask('art',f.place,{id:'question',question:{...question,ask:'Changed'}})).rejects.toThrow();
 f.clock.advance(14*86400_000);
 expect(await f.comms.ask('art',f.place,input)).toEqual(r);expect((row() as {words:unknown}).words).toBeNull();
});
it('rolls back the sealed message if projection fails',async()=>{
 const f=await setup();f.app.db.exec("CREATE TRIGGER fail_question BEFORE INSERT ON attention_asks BEGIN SELECT RAISE(ABORT,'interrupted'); END");
 await expect(f.comms.ask('art',f.place,{id:'question',question})).rejects.toThrow();
 expect(f.app.db.prepare("SELECT * FROM comms_messages WHERE kind='ask'").all()).toEqual([]);
 f.app.db.exec('DROP TRIGGER fail_question');expect(await f.comms.ask('art',f.place,{id:'question',question})).toMatchObject({seq:2});
});
it('rechecks original member and source after encryption and refuses wrong agents and managed questions',async()=>{
 const f=await setup();await expect(f.comms.ask('other',f.place,{id:'question',question})).rejects.toThrow();
 await expect(f.comms.ask('art',f.place,{id:'question',question:{...question,waits_on:{approval:'a-private'}}} as never)).rejects.toThrow();
 const seal=f.key.seal;vi.spyOn(f.key,'seal').mockImplementation(async words=>{const sealed=await seal(words);f.sharing.members.jonathan.agents=[];return sealed;});
 await expect(f.comms.ask('art',f.place,{id:'question',question})).rejects.toThrow();
 expect(f.app.db.prepare('SELECT * FROM attention_asks').all()).toEqual([]);
 expect(f.app.db.prepare("SELECT * FROM comms_messages WHERE kind='ask'").all()).toEqual([]);
});
for(const drift of ['member','conversation','project','archive','delete','closed'] as const)it(`refuses question creation when ${drift} changes during encryption`,async()=>{
 const f=await setup(),seal=f.key.seal;
 vi.spyOn(f.key,'seal').mockImplementation(async words=>{
  const sealed=await seal(words);
  if(drift==='closed')await f.comms.close();
  else if(drift==='archive'||drift==='delete')expect(await f.call('comms.change',{thread:f.place,action:drift})).toMatchObject({ok:true});
  else {
   const row=f.app.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(f.place) as {record:string};
   const t=JSON.parse(row.record);t[drift]=drift==='member'?'other':drift==='project'?'different-project':'different-conversation';
   f.app.db.prepare('UPDATE comms_threads SET member=?,project=?,record=? WHERE id=?').run(t.member,t.project??null,JSON.stringify(t),f.place);
  }
  return sealed;
 });
 await expect(f.comms.ask('art',f.place,{id:'question',question})).rejects.toThrow();
 expect(f.app.db.prepare('SELECT * FROM attention_asks').all()).toEqual([]);
 expect(f.app.db.prepare("SELECT * FROM comms_messages WHERE kind='ask'").all()).toEqual([]);
});
it('coalesces simultaneous identical creations and rejects changed concurrent questions',async()=>{
 const f=await setup(),same={id:'question',question};
 const [one,two]=await Promise.all([f.comms.ask('art',f.place,same),f.comms.ask('art',f.place,same)]);expect(one).toEqual(two);
 const results=await Promise.allSettled([f.comms.ask('art',f.place,{id:'other',question}),f.comms.ask('art',f.place,{id:'other',question:{...question,why:'Changed'}})]);
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 expect(f.app.db.prepare("SELECT * FROM comms_messages WHERE kind='ask'").all()).toHaveLength(2);
});

it('namespaces caller ids to their original thread rather than impersonating a source',async()=>{
 const f=await setup(),r=await f.comms.ask('art',f.place,{id:'approval:fake',question});
 expect(r.ref).toMatch(/^comms:[0-9a-f]{64}$/);
 const opened=await f.call('comms.open',{agent:'art',id:'bbbbbbbbbbbbbbbb',text:'Other thread'});if(!opened.ok)throw Error(opened.message);
 const other=(opened.value as {thread:string}).thread;
 const second=await f.comms.ask('art',other,{id:'approval:fake',question});expect(second.ref).not.toBe(r.ref);
 expect(f.attention.get(f.viewer,{id:second.ref})).toMatchObject({ok:true,value:{privateQuestion:{thread:other}}});
 const nested=await f.comms.ask('art',other,{id:r.ref,question});expect(nested.ref).not.toBe(r.ref);
 expect(f.attention.get(f.viewer,{id:r.ref})).toMatchObject({ok:true,value:{privateQuestion:{thread:f.place}}});
});

it('keeps the default answer mode consistent in sealed words and Attention metadata',async()=>{
 const f=await setup(),r=await f.comms.ask('art',f.place,{id:'default-mode',question:{ask:'Private default question'}});
 expect(f.attention.get(f.viewer,{id:r.ref})).toMatchObject({ok:true,value:{answers:'words'}});
 expect(await f.call('comms.messages',{thread:f.place})).toMatchObject({ok:true,value:expect.arrayContaining([expect.objectContaining({ask:{ask:'Private default question',answers:'words'}})])});
});

it('does not let another registered source reserve a future Comms identity',async()=>{
 const f=await setup(),ref=`comms:${createHash('sha256').update(JSON.stringify([f.place,'question'])).digest('hex')}`;
 const source=attentionSources(f.app.operations)!.register('fixture-source',()=>{});
 const ctx={db:f.app.db,viewer:f.viewer,now:f.clock.now(),changed:()=>{}};
 expect(()=>f.app.db.transaction(()=>source.raise(ctx,{id:ref,ask:'Impersonated source'}))()).toThrow('another source');
 expect(f.app.db.prepare('SELECT * FROM attention_asks').all()).toEqual([]);
 expect(await f.comms.ask('art',f.place,{id:'question',question})).toMatchObject({ref});
 expect(()=>f.app.db.transaction(()=>source.resolve(ctx,ref,'Wrong source'))()).toThrow('another source');
});
it('rechecks independent project creation permission for an ordinary member',async()=>{
 const f=await setup();f.sharing.members.jonathan.owner=false;
 f.sharing.projects.private={members:['jonathan'],agents:['art']};
 expect(await f.call('comms.change',{thread:f.place,action:'project',project:'private'})).toMatchObject({ok:true});
 const seal=f.key.seal;vi.spyOn(f.key,'seal').mockImplementation(async words=>{const sealed=await seal(words);f.sharing.projects.private.members=[];return sealed;});
 await expect(f.comms.ask('art',f.place,{id:'question',question})).rejects.toThrow();
 expect(f.app.db.prepare('SELECT * FROM attention_asks').all()).toEqual([]);
 expect(f.app.db.prepare("SELECT * FROM comms_messages WHERE kind='ask'").all()).toEqual([]);
});

it('delivers sealed yes/no outcomes as encrypted conversation messages with atomic Attention state',async()=>{
 const f=await setup(),q={...question,answers:'yes-no' as const},r=await f.comms.ask('art',f.place,{id:'boolean',question:q});
 const batches:unknown[]=[];const stop=f.app.live.observe(c=>batches.push(c));
 const input={thread:f.place,ref:r.ref,verdict:'yes'},answer=await f.call('comms.answer',input);stop();
 expect(answer).toMatchObject({ok:true});if(!answer.ok)throw Error('answer failed');const ack=answer.value as {thread:string;seq:number};
 await f.comms.deliver('art',f.place,ack.seq);
 const row=f.app.db.prepare('SELECT * FROM comms_messages WHERE thread=? AND seq=?').get(f.place,ack.seq) as {kind:string;record:string;words:Buffer};
 expect(row.kind).toBe('message');expect(JSON.parse(row.record).delivery).toBe('delivered');
 expect(f.deliveries.filter(d=>d.seq===ack.seq)).toEqual([expect.objectContaining({thread:f.place,agent:'art',member:'jonathan',seq:ack.seq,text:`Yes, to: ${q.ask}\n\n${q.if_yes}`})]);
 expect(JSON.parse(await f.key.open(row.words))).toEqual({text:`Yes, to: ${q.ask}\n\n${q.if_yes}`,ref:r.ref,verdict:'yes'});
 expect(f.attention.get(f.viewer,{id:r.ref})).toMatchObject({ok:true,value:{state:'answered',answer:{kind:'yes',by:f.viewer}}});
 expect(batches).toContainEqual(expect.arrayContaining([{type:'message',id:`${f.place}/${ack.seq}`},{type:'attention.ask',id:r.ref}]));
 expect(await f.call('comms.answer',input)).toEqual(answer);
 await f.comms.deliver('art',f.place,ack.seq);expect(f.deliveries.filter(d=>d.seq===ack.seq)).toHaveLength(1);
 expect(await f.call('comms.answer',{...input,verdict:'no'})).toMatchObject({ok:false,code:'conflict'});
 for(const table of ['attention_asks','core_operations','comms_messages']){
  const stored=JSON.stringify(f.app.db.prepare(`SELECT * FROM ${table}`).all());
  expect(stored).not.toContain(q.ask);expect(stored).not.toContain(q.if_yes);
 }
});
it('rolls back a decision and its receipt when the encrypted reply cannot be appended',async()=>{
 const f=await setup(),r=await f.comms.ask('art',f.place,{id:'boolean',question:{...question,answers:'yes-no'}});
 f.app.db.exec("CREATE TRIGGER fail_decision BEFORE INSERT ON comms_messages WHEN new.kind='message' BEGIN SELECT RAISE(ABORT,'interrupted'); END");
 expect(await f.call('comms.answer',{thread:f.place,ref:r.ref,verdict:'no'})).toMatchObject({ok:false});
 expect(f.attention.get(f.viewer,{id:r.ref})).toMatchObject({ok:true,value:{state:'open'}});
 f.app.db.exec('DROP TRIGGER fail_decision');
 expect(await f.call('comms.answer',{thread:f.place,ref:r.ref,verdict:'no'})).toMatchObject({ok:true});
});
for(const drift of ['member','conversation','project','archive','delete','access','expired','answered','ciphertext'] as const)it(`refuses a sealed decision after ${drift} changes during crypto`,async()=>{
 const f=await setup(),r=await f.comms.ask('art',f.place,{id:'boolean',question:{...question,answers:'yes-no'}}),seal=f.key.seal;
 vi.spyOn(f.key,'seal').mockImplementation(async words=>{
  const sealed=await seal(words);
  if(drift==='access')f.sharing.members.jonathan.agents=[];
  else if(drift==='ciphertext')f.app.db.prepare('UPDATE comms_messages SET words=? WHERE thread=? AND seq=?').run(await seal(JSON.stringify({...question,answers:'yes-no',ask:'REPLACED QUESTION'})),f.place,r.seq);
  else if(drift==='expired')f.clock.advance(14*86400_000);
  else if(drift==='answered')expect(f.attention.answer(f.viewer,{id:r.ref,answer:{kind:'no'}},'competing-answer')).toMatchObject({ok:true});
  else if(drift==='archive'||drift==='delete')expect(await f.call('comms.change',{thread:f.place,action:drift})).toMatchObject({ok:true});
  else {
   const row=f.app.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(f.place) as {record:string};const t=JSON.parse(row.record);
   t[drift]=drift==='member'?'other':'changed';f.app.db.prepare('UPDATE comms_threads SET member=?,project=?,record=? WHERE id=?').run(t.member,t.project??null,JSON.stringify(t),f.place);
  }
  return sealed;
 });
 expect(await f.call('comms.answer',{thread:f.place,ref:r.ref,verdict:'yes'})).toMatchObject({ok:false});
 expect(f.app.db.prepare("SELECT * FROM comms_messages WHERE id=?").all(`answer:${r.ref}`)).toEqual([]);
});
it('refuses another owner, nonwindow and typed answers to sealed yes/no; words questions cannot be decided',async()=>{
 const f=await setup(),r=await f.comms.ask('art',f.place,{id:'boolean',question:{...question,answers:'yes-no'}}),i={thread:f.place,ref:r.ref,verdict:'yes'};
 expect(await f.call('comms.answer',i,{kind:'member',id:'other'} as never)).toMatchObject({ok:false});
 expect(await f.app.operations.callAsync('socket',f.viewer,'comms.answer',i,'nonwindow',false)).toMatchObject({ok:false});
 expect(await f.call('comms.answer',{...i,words:'Private words'})).toMatchObject({ok:false});
 const words=await f.comms.ask('art',f.place,{id:'words',question});
 expect(await f.call('comms.answer',{...i,ref:words.ref})).toMatchObject({ok:false});
});
it('recovers held boolean delivery with the selected no outcome, once',async()=>{
 let released=false;const f=await setup(stagingHold({beforeOutside:()=>released,finish:()=>{}}));
 const r=await f.comms.ask('art',f.place,{id:'boolean',question:{...question,answers:'yes-no',if_no:'PRIVATE NO OUTCOME'}});
 const answer=await f.call('comms.answer',{thread:f.place,ref:r.ref,verdict:'no'});expect(answer.ok).toBe(true);if(!answer.ok)throw Error('answer failed');
 const ack=answer.value as {seq:number};await f.comms.deliver('art',f.place,ack.seq);expect(f.deliveries).toEqual([]);
 released=true;await f.comms.reconcileDeliveries();await f.comms.reconcileDeliveries();
 expect(f.deliveries.filter(d=>d.seq===ack.seq)).toEqual([expect.objectContaining({text:`No, to: ${question.ask}\n\nPRIVATE NO OUTCOME`})]);
});
it('keeps imported comms-prefixed asks on their legacy source protocol',async()=>{
 const f=await setup(),ref=`comms:${'a'.repeat(64)}`;
 // Build the old-format imported projection: prefix alone is not provenance.
 f.app.db.prepare('INSERT INTO attention_asks VALUES (?,?)').run(ref,JSON.stringify({id:ref,member:f.viewer.id,agent:'art',source:{kind:'conversation',id:JSON.parse((f.app.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(f.place) as {record:string}).record).conversation},ask:'Imported legacy ask',answers:'yes-no',state:'open',createdAt:f.clock.now(),changedAt:f.clock.now()}));
 await f.comms.post('art',f.place,{id:'legacy',ref,kind:'ask',text:'Legacy retained question'});
 const r=await f.call('comms.answer',{thread:f.place,ref,verdict:'yes'});expect(r).toMatchObject({ok:true});if(!r.ok)throw Error('answer failed');
 const seq=(r.value as {seq:number}).seq;await f.comms.deliver('art',f.place,seq);
 expect(f.app.db.prepare('SELECT kind FROM comms_messages WHERE thread=? AND seq=?').get(f.place,seq)).toEqual({kind:'answer'});
 expect(f.deliveries.filter(d=>d.seq===seq)).toEqual([]);
});
