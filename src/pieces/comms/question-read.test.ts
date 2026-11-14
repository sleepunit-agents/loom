import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startLoom} from '../../foundation.js';
import {FakeClock,type Sharing} from '../../core/index.js';
import {installAttention} from '../attention/index.js';
import {WebSocket} from 'ws';
import {once} from 'node:events';
import {attentionRole} from '../attention/role.js';
import {installComms} from './index.js';
import {loadKey} from './crypto.js';
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const f of cleanup.splice(0).reverse())await f();vi.restoreAllMocks();});
async function setup(){
 const home=mkdtempSync(join(tmpdir(),'private-question-')),clock=new FakeClock(),key=await loadKey(home);
 const sharing:Sharing={members:{jonathan:{owner:true,agents:['art']},other:{owner:true,agents:['art']}},projects:{}};
 let comms!:ReturnType<typeof installComms>;
 const app=await startLoom({home,clock,authenticate:req=>({viewer:{kind:'member',id:String(req.headers['x-member']??'jonathan')},window:req.headers['x-window']==='yes',valid:()=>true}),install:a=>{
  installAttention(a.db,a.operations,a.live,()=>sharing);
  comms=installComms({...a,clock,key,sharing:()=>sharing,attention:attentionRole(a.operations),runtime:{deliver:async()=>{},end:async()=>{}},hold:async f=>f()});
 }});
 cleanup.push(async()=>{await comms.close();await app.close();rmSync(home,{recursive:true,force:true});});
 const viewer={kind:'member',id:'jonathan'} as const;
 let n=0;const call=(name:string,input:unknown,v=viewer)=>app.operations.callAsync('socket',v,name,input,`test-${++n}`,true);
 const r=await call('comms.open',{agent:'art',id:'aaaaaaaaaaaaaaaa',text:'Hello'});if(!r.ok)throw Error(r.message);
 const place=(r.value as {thread:string}).thread;
 const attention=attentionRole(app.operations);
 return {app,clock,key,sharing,comms,call,place,attention,viewer};
}
const question={ask:'SEALED question sentinel',why:'SEALED why sentinel',refs:['private-ref'],answers:'words' as const};
it('reads the full sealed question and current kept answer from its owning window only',async()=>{
 const f=await setup(),r=await f.comms.ask('art',f.place,{id:'question',question});
 expect(await f.call('comms.question',{ref:r.ref})).toMatchObject({ok:true,value:{id:r.ref,thread:f.place,seq:r.seq,state:'open',question}});
 expect(await f.call('comms.replyToAsk',{ref:r.ref,text:'Private answer'})).toMatchObject({ok:true});
 expect(await f.call('comms.question',{ref:r.ref})).toMatchObject({ok:true,value:{question,state:'answered',answer:{kind:'replied',by:f.viewer}}});
 expect(await f.call('comms.change',{thread:f.place,action:'archive'})).toMatchObject({ok:true});
 expect(await f.call('comms.question',{ref:r.ref})).toMatchObject({ok:true,value:{state:'answered',question}});
 for(const table of ['attention_asks','core_operations'])expect(JSON.stringify(f.app.db.prepare(`SELECT * FROM ${table}`).all())).not.toContain(question.ask);
 expect(f.attention.get(f.viewer,{id:r.ref})).toMatchObject({ok:true,value:{ask:'Reply in your private conversation'}});
});
it('refuses other members, agents, tokens/nonwindows and nonsocket doors',async()=>{
 const f=await setup(),r=await f.comms.ask('art',f.place,{id:'question',question});
 for(const viewer of [{kind:'member',id:'other'},{kind:'agent',id:'art'},{kind:'service',id:'runtime'}] as const)
  expect(await f.app.operations.callAsync('socket',viewer,'comms.question',{ref:r.ref},undefined,true)).toMatchObject({ok:false});
 expect(await f.app.operations.callAsync('socket',f.viewer,'comms.question',{ref:r.ref},undefined,false)).toMatchObject({ok:false});
 for(const door of ['direct','http','mcp'] as const)expect(await f.app.operations.callAsync(door,f.viewer,'comms.question',{ref:r.ref},undefined,true)).toMatchObject({ok:false});
 f.sharing.members.jonathan.agents=[];expect(await f.call('comms.question',{ref:r.ref})).toMatchObject({ok:false});
});
for(const drift of ['member','conversation','project','delete','closed','answer','ownership','row','expiry'] as const)it(`fences ${drift} movement across question decryption`,async()=>{
 const f=await setup(),r=await f.comms.ask('art',f.place,{id:'question',question}),open=f.key.open;
 let changed=false;vi.spyOn(f.key,'open').mockImplementation(async words=>{
  const plain=await open(words);if(changed)return plain;changed=true;
  if(drift==='closed')await f.comms.close();
  else if(drift==='delete')expect(await f.call('comms.change',{thread:f.place,action:'delete'})).toMatchObject({ok:true});
  else if(drift==='ownership')f.sharing.members.jonathan.agents=[];
  else if(drift==='expiry')f.clock.advance(14*86400_000);
  else if(drift==='answer')expect(f.attention.answer(f.viewer,{id:r.ref,answer:{kind:'dismiss'}},'dismiss')).toMatchObject({ok:true});
  else if(drift==='row')f.app.db.prepare('UPDATE comms_messages SET id=? WHERE thread=? AND seq=?').run('replacement',f.place,r.seq);
  else {
   const row=f.app.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(f.place) as {record:string},t=JSON.parse(row.record);
   t[drift]=drift==='member'?'other':`different-${drift}`;
   f.app.db.prepare('UPDATE comms_threads SET member=?,project=?,record=? WHERE id=?').run(t.member,t.project??null,JSON.stringify(t),f.place);
  }
  return plain;
 });
 const got=await f.call('comms.question',{ref:r.ref});expect(got).toMatchObject({ok:false});expect(JSON.stringify(got)).not.toContain(question.ask);
});
it('retains wordless question history at the exact expiry deadline',async()=>{
 const f=await setup(),r=await f.comms.ask('art',f.place,{id:'question',question});
 expect(f.attention.answer(f.viewer,{id:r.ref,answer:{kind:'dismiss'}},'dismiss')).toMatchObject({ok:true});
 f.clock.advance(14*86400_000);
 expect(await f.call('comms.question',{ref:r.ref})).toMatchObject({ok:true,value:{question:null,state:'answered',answer:{kind:'dismiss'}}});
});
it('updates a scoped question subscription on source answers and strips words on idle expiry',async()=>{
 const f=await setup(),r=await f.comms.ask('art',f.place,{id:'question',question}),frames:Array<Record<string,unknown>>=[];
 const ws=new WebSocket(f.app.url.replace('http','ws')+'/live',{headers:{'x-member':'jonathan','x-window':'yes'}});
 cleanup.push(async()=>{ws.terminate();});ws.on('message',data=>frames.push(JSON.parse(String(data))));await once(ws,'open');
 ws.send(JSON.stringify({kind:'subscribe',type:'comms.question',scope:r.ref}));
 const latest=()=>{const set=frames.filter(x=>x.kind==='set'&&x.type==='comms.question').at(-1);return (set?.records as Array<Record<string,unknown>>|undefined)?.[0];};
 await expect.poll(()=>latest()?.question).toEqual(question);
 expect(f.attention.answer(f.viewer,{id:r.ref,answer:{kind:'done'}},'done')).toMatchObject({ok:true});
 await expect.poll(()=>latest()?.state).toBe('answered');
 f.clock.advance(14*86400_000);await expect.poll(()=>latest()?.question).toBeNull();
 f.sharing.members.jonathan.agents=[];f.app.live.refreshAccess();
 await expect.poll(()=>{const set=frames.filter(x=>x.kind==='set'&&x.type==='comms.question').at(-1);return set?.records;}).toEqual([]);
});
