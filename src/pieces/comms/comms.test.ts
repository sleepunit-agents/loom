import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { startLoom } from '../../foundation.js';
import { FakeClock, type Sharing, type Viewer } from '../../core/index.js';
import { installComms } from './index.js';
import { loadKey, type WordsKey } from './crypto.js';
import type { Comms, Delivery } from './role.js';
const cleanup: (()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const f of cleanup.splice(0).reverse())await f();});
const member:Viewer={kind:'member',id:'jonathan'};
async function setup(overrides: {key?:(key:WordsKey)=>WordsKey; hold?:boolean}={}) {
 const home=mkdtempSync(join(tmpdir(),'comms-next-'));cleanup.push(()=>rmSync(home,{recursive:true,force:true}));
 const clock=new FakeClock();let sharing:Sharing={members:{jonathan:{owner:true,agents:['art']},other:{owner:true,agents:['art']}},projects:{pond:{members:['other','jonathan'],agents:['art','pond-bot']}},services:{runtime:{types:['message','thread'],operations:[]}}};
 const deliveries:Delivery[]=[];const ends:string[]=[];let comms:Comms & {close():Promise<void>};const base=await loadKey(home),key=overrides.key?.(base)??base;
 const app=await startLoom({home,clock,authenticate:req=>({viewer:{kind:'member',id:String(req.headers['x-member']??'jonathan')},window:req.headers['x-window']==='yes',valid:()=>true}),
  install:a=>{comms=installComms({...a,clock,key,sharing:()=>sharing,runtime:{deliver:async d=>{deliveries.push(d);},end:async cv=>{ends.push(cv);}},hold:async f=>{if(overrides.hold)throw new Error('staging');return f();},attention:{answer:async()=>{}}});},
 });cleanup.push(()=>app.close());cleanup.push(()=>comms.close());
 let n=0;
 const call=(name:string,input:unknown,v:Viewer=member,window=true)=>app.operations.callAsync('socket',v,`comms.${name}`,input,`op-${++n}`,window);
 const open=async()=>{const r=await call('open',{agent:'art',id:`first-${n}`,text:'secret member words',project:'pond'});expect(r.ok).toBe(true);return (r as {ok:true;value:{thread:string;seq:number}}).value.thread;};
 return {app,clock,home,call,open,deliveries,ends,get comms(){return comms;},setSharing:(value:Sharing)=>{sharing=value;app.live.refreshAccess();},getSharing:()=>sharing};
}
it('encrypts rows with age; only acknowledgements enter retry storage, and runtime receives the words',async()=>{
 const s=await setup();const place=await s.open();await s.comms.deliver('art',place,1);
 expect(s.deliveries[0]).toMatchObject({thread:place,text:'secret member words',agent:'art'});
 const row=s.app.db.prepare('SELECT * FROM comms_messages').get() as {words:Buffer};
 expect(row.words.toString()).toMatch(/^age-encryption.org\/v1/);
 expect(JSON.stringify(s.app.db.prepare('SELECT * FROM comms_messages').all())).not.toContain('secret member words');
 expect(JSON.stringify(s.app.db.prepare('SELECT * FROM core_operations').all())).not.toContain('secret member words');
 const r=await s.call('messages',{thread:place});expect(JSON.stringify(r)).toContain('secret member words');
 expect(readFileSync(join(s.home,'loom.db')).includes(Buffer.from('secret member words'))).toBe(false);
});
it('refuses every token door and a member socket without trusted window authentication',async()=>{
 const s=await setup();const place=await s.open();
 for(const v of [{kind:'agent',id:'art'},{kind:'service',id:'runtime'},{kind:'runner',id:'runner'},member] as Viewer[]) {
  for(const door of ['http','mcp','direct'] as const)expect(await s.app.operations.callAsync(door,v,'comms.messages',{thread:place})).toMatchObject({code:'denied'});
 }
 expect(await s.call('messages',{thread:place},member,false)).toMatchObject({code:'denied'});
 expect(s.app.operations.offered('mcp').some(op=>op.name.startsWith('comms.'))).toBe(false);
});
it('household ownership and a shared project never widen private thread access',async()=>{
 const s=await setup();const place=await s.open();
 expect(await s.call('messages',{thread:place},{kind:'member',id:'other'})).toMatchObject({code:'denied'});
 expect(await s.call('messages',{thread:'missing'},{kind:'member',id:'other'})).toMatchObject({code:'denied'});
 expect(await s.call('send',{thread:place,id:'evil',text:'hello'},{kind:'member',id:'other'})).toMatchObject({code:'denied'});
 await expect(s.comms.post('pond-bot',place,{id:'r',kind:'reply',text:'wrong'})).rejects.toMatchObject({code:'denied'});
 const sharing=s.getSharing();sharing.members.jonathan.agents=[];s.setSharing(sharing);
 expect(await s.call('messages',{thread:place})).toMatchObject({code:'denied'});
});
it('rechecks ownership after asynchronous encryption, before storing anything',async()=>{
 let resume:()=>void=()=>{};let started:()=>void=()=>{};
 const beginning=new Promise<void>(r=>{started=r;});const paused=new Promise<void>(r=>{resume=r;});
 const s=await setup({key:key=>({...key,seal:async text=>{started();await paused;return key.seal(text);}})});
 const send=s.call('open',{agent:'art',id:'first',text:'lost access'});await beginning;
 const sharing=s.getSharing();sharing.members.jonathan.agents=[];s.setSharing(sharing);resume();
 expect(await send).toMatchObject({code:'denied'});expect(s.app.db.prepare('SELECT * FROM comms_threads').all()).toEqual([]);
});
it('keeps retries stable, rejects changed text, marks reads forward, respects member titles and archived sends',async()=>{
 const s=await setup();const place=await s.open();
 const a=await s.call('send',{thread:place,id:'m',text:'one'});expect(await s.call('send',{thread:place,id:'m',text:'one'})).toEqual(a);
 expect(await s.call('send',{thread:place,id:'m',text:'two'})).toMatchObject({code:'conflict'});
 await s.comms.post('art',place,{id:'r',kind:'reply',text:'reply'});
 await s.call('change',{thread:place,action:'read',seq:3});await s.call('change',{thread:place,action:'read',seq:0});
 expect(JSON.parse((s.app.db.prepare('SELECT record FROM comms_threads').get() as {record:string}).record).readSeq).toBe(3);
 await s.call('change',{thread:place,action:'title',title:'Mine'});
 expect(()=>s.comms.title('art',place,'Theirs')).toThrow('member');
 await s.call('change',{thread:place,action:'archive'});
 expect(await s.call('send',{thread:place,id:'later',text:'no'})).toMatchObject({code:'conflict'});
 await s.call('change',{thread:place,action:'unarchive'});expect((await s.call('send',{thread:place,id:'later',text:'yes'})).ok).toBe(true);
});
it('sweeps all encrypted message and step words at fourteen days; deletes rows and keeps a wordless tombstone',async()=>{
 const s=await setup();const place=await s.open();
 await s.comms.post('art',place,{id:'step',kind:'card',text:'private summary',step:{body:'private output'},state:'running',tool:'shell'});
 s.clock.advance(14*86400_000);
 expect(s.app.db.prepare('SELECT words FROM comms_messages').all()).toEqual([{words:null},{words:null}]);
 await s.comms.post('art',place,{id:'step',kind:'card',text:'late summary',state:'done',tool:'shell'});
 expect(JSON.stringify(await s.call('messages',{thread:place}))).not.toContain('late summary');
 expect(s.app.db.pragma('secure_delete',{simple:true})).toBe(1);
 expect((await s.call('change',{thread:place,action:'delete'})).ok).toBe(true);
 expect(s.app.db.prepare('SELECT * FROM comms_messages').all()).toEqual([]);
 expect(s.app.db.prepare('SELECT * FROM comms_threads').all()).toEqual([]);
 expect(s.app.db.prepare('SELECT * FROM comms_deleted').all()).toHaveLength(1);
});
it('staging holds runtime delivery and never leaks words to another effect',async()=>{
 const s=await setup({hold:true});const place=await s.open();await s.comms.deliver('art',place,1);expect(s.deliveries).toEqual([]);
});
it('sends encrypted records as plaintext only to its member signed-in socket; bearer subscriptions are denied',async()=>{
 const s=await setup();const place=await s.open();await s.comms.post('art',place,{id:'reply',kind:'reply',text:'agent secret'});
 for(const [who,window] of [['jonathan',true],['other',true],['jonathan',false]] as const) {
  const ws=new WebSocket(s.app.url.replace('http:','ws:')+'/live',{headers:{'x-member':who,'x-window':window?'yes':'no'}});cleanup.push(()=>ws.terminate());await once(ws,'open');
  const answer=once(ws,'message');ws.send(JSON.stringify({kind:'subscribe',type:'message',scope:place}));
  const [raw]=await answer;const received=JSON.parse(raw.toString());
  if(who==='jonathan' && window) {expect(received.records).toHaveLength(2);expect(JSON.stringify(received)).toContain('agent secret');expect(JSON.stringify(received)).not.toContain('age-encryption');}
  else if(!window)expect(received).toMatchObject({code:'denied'});
  else expect(received.records).toEqual([]);
 }
});
