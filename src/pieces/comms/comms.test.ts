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
import { stagingHold } from './role.js';
import type { Attention, Hold, Comms, Delivery } from './role.js';
const cleanup: (()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const f of cleanup.splice(0).reverse())await f();});
const member:Viewer={kind:'member',id:'jonathan'};
async function setup(overrides: {key?:(key:WordsKey)=>WordsKey; hold?:boolean|Hold; days?:number; attention?:Attention; valid?:()=>boolean}={}) {
 const home=mkdtempSync(join(tmpdir(),'comms-next-'));cleanup.push(()=>rmSync(home,{recursive:true,force:true}));
 const clock=new FakeClock();let sharing:Sharing={members:{jonathan:{owner:true,agents:['art']},other:{owner:true,agents:['art']}},projects:{pond:{members:['other','jonathan'],agents:['art','pond-bot']}},services:{runtime:{types:['message','thread'],operations:[]}}};
 const deliveries:Delivery[]=[];const ends:string[]=[];let comms:Comms & {close():Promise<void>};const base=await loadKey(home),key=overrides.key?.(base)??base;
 const app=await startLoom({home,clock,authenticate:req=>({viewer:{kind:'member',id:String(req.headers['x-member']??'jonathan')},window:req.headers['x-window']==='yes',valid:overrides.valid??(()=>true)}),
  install:a=>{comms=installComms({...a,clock,key,sharing:()=>sharing,runtime:{deliver:async d=>{deliveries.push(d);},end:async cv=>{ends.push(cv);}},days:overrides.days,hold:typeof overrides.hold==='function'?overrides.hold:async f=>{if(overrides.hold)throw new Error('staging');return f();},attention:overrides.attention??{answer:()=>({ok:true,value:{answered:true}})}});},
 });cleanup.push(()=>app.close());cleanup.push(()=>comms.close());
 let n=0;
 const call=(name:string,input:unknown,v:Viewer=member,window=true)=>app.operations.callAsync('socket',v,`comms.${name}`,input,`op-${++n}`,window);
 const open=async()=>{const r=await call('open',{agent:'art',id:n.toString(2).replaceAll('0','a').replaceAll('1','b').padStart(16,'a'),text:'secret member words',project:'pond'});expect(r.ok).toBe(true);return (r as {ok:true;value:{thread:string;seq:number}}).value.thread;};
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
 expect(await s.call('send',{thread:place,id:'evilaaaaaaaaaaaa',text:'hello'},{kind:'member',id:'other'})).toMatchObject({code:'denied'});
 await expect(s.comms.post('pond-bot',place,{id:'r',kind:'reply',text:'wrong'})).rejects.toMatchObject({code:'denied'});
 const sharing=s.getSharing();sharing.members.jonathan.agents=[];s.setSharing(sharing);
 expect(await s.call('messages',{thread:place})).toMatchObject({code:'denied'});
});
it('rechecks ownership after asynchronous encryption, before storing anything',async()=>{
 let resume:()=>void=()=>{};let started:()=>void=()=>{};
 const beginning=new Promise<void>(r=>{started=r;});const paused=new Promise<void>(r=>{resume=r;});
 const s=await setup({key:key=>({...key,seal:async text=>{started();await paused;return key.seal(text);}})});
 const send=s.call('open',{agent:'art',id:'firstaaaaaaaaaaa',text:'lost access'});await beginning;expect(s.app.db.inTransaction).toBe(false);
 const sharing=s.getSharing();sharing.members.jonathan.agents=[];s.setSharing(sharing);resume();
 expect(await send).toMatchObject({code:'denied'});expect(s.app.db.prepare('SELECT * FROM comms_threads').all()).toEqual([]);
});
it('keeps retries stable, rejects changed text, marks reads forward, respects member titles and archived sends',async()=>{
 const s=await setup();const place=await s.open();
 const a=await s.call('send',{thread:place,id:'maaaaaaaaaaaaaaa',text:'one'});expect(await s.call('send',{thread:place,id:'maaaaaaaaaaaaaaa',text:'one'})).toEqual(a);
 expect(await s.call('send',{thread:place,id:'maaaaaaaaaaaaaaa',text:'two'})).toMatchObject({code:'conflict'});
 await s.comms.post('art',place,{id:'r',kind:'reply',text:'reply'});
 await s.call('change',{thread:place,action:'read',seq:3});await s.call('change',{thread:place,action:'read',seq:0});
 expect(JSON.parse((s.app.db.prepare('SELECT record FROM comms_threads').get() as {record:string}).record).readSeq).toBe(3);
 await s.call('change',{thread:place,action:'title',title:'Mine'});
 expect(()=>s.comms.title('art',place,'Theirs')).toThrow('member');
 await s.call('change',{thread:place,action:'archive'});
 expect(await s.call('send',{thread:place,id:'lateraaaaaaaaaaa',text:'no'})).toMatchObject({code:'conflict'});
 await s.call('change',{thread:place,action:'unarchive'});expect((await s.call('send',{thread:place,id:'lateraaaaaaaaaaa',text:'yes'})).ok).toBe(true);
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
for(const boundary of ['decryption','staging'] as const)it(`revoking ownership during delivery ${boundary} prevents the runtime from receiving words`,async()=>{
 let resume:()=>void=()=>{},started:()=>void=()=>{};
 const wait=new Promise<void>(r=>{resume=r;}),begin=new Promise<void>(r=>{started=r;});
 const pause=async()=>{started();await wait;};
 const s=await setup(boundary==='decryption'
  ?{key:key=>({...key,open:async blob=>{await pause();return key.open(blob);}})}
  :{hold:async run=>{await pause();return run();}});
 const place=await s.open();await begin;
 expect(s.app.db.inTransaction).toBe(false);
 const sharing=s.getSharing();sharing.members.jonathan.agents=[];s.setSharing(sharing);
 resume();await s.comms.deliver('art',place,1);
 expect(s.deliveries).toEqual([]);
 expect(JSON.parse((s.app.db.prepare('SELECT record FROM comms_messages WHERE thread=? AND seq=1').get(place) as {record:string}).record).delivery).toBe('failed');
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
it('expires off-hour messages exactly at their deadline and omits every Comms table from export/backup',async()=>{
 const s=await setup();s.clock.advance(12345);const place=await s.open();await s.comms.deliver('art',place,1);
 s.clock.advance(14*86400_000-1);expect(JSON.stringify(await s.call('messages',{thread:place}))).toContain('secret member words');
 s.clock.advance(1);expect(JSON.stringify(await s.call('messages',{thread:place}))).not.toContain('secret member words');
 const {exportDatabase}=await import('../../core/index.js');const snapshot=exportDatabase(s.app.db);
 expect(snapshot.some(t=>t.name.startsWith('comms_'))).toBe(false);
 expect(JSON.stringify(snapshot)).not.toContain('CREATE TABLE comms_');
});
it('never stores runtime work details or asks as plaintext and passes only the member identity to attention',async()=>{
 const s=await setup();const place=await s.open();await s.comms.deliver('art',place,1);
 await s.comms.post('art',place,{id:'a-private',kind:'ask',text:'private question',ref:'a-private',tool:'secret tool name',step:{body:'secret output'}});
 expect(JSON.stringify(s.app.db.prepare('SELECT * FROM comms_messages').all())).not.toContain('secret tool name');
 expect(JSON.stringify(await s.call('messages',{thread:place}))).toContain('secret tool name');
 expect((await s.call('answer',{thread:place,ref:'a-private',verdict:'yes'})).ok).toBe(true);
 expect(await s.call('answer',{thread:place,ref:'a-private',verdict:'no'},{kind:'member',id:'other'})).toMatchObject({code:'denied'});
});
it('rechecks live-record ownership after decryption and drops suspended snapshots when access is revoked',async()=>{
 let paused=false,resume:()=>void=()=>{},started:()=>void=()=>{};
 const wait=new Promise<void>(r=>{resume=r;}),begin=new Promise<void>(r=>{started=r;});
 const s=await setup({key:key=>({...key,open:async blob=>{if(paused){started();await wait;}return key.open(blob);}})});
 const place=await s.open();await s.comms.deliver('art',place,1);paused=true;
 const ws=new WebSocket(s.app.url.replace('http:','ws:')+'/live',{headers:{'x-member':'jonathan','x-window':'yes'}});cleanup.push(()=>ws.terminate());await once(ws,'open');
 const received:string[]=[];ws.on('message',raw=>received.push(raw.toString()));ws.send(JSON.stringify({kind:'subscribe',type:'message',scope:place}));await begin;
 const answer=once(ws,'message');const sharing=s.getSharing();sharing.members.jonathan.agents=[];s.setSharing(sharing);
 const [raw]=await answer;expect(JSON.parse(raw.toString()).records).toEqual([]);resume();
 // A later authorized operation gives the socket a deterministic turn boundary after the suspended read.
 const boundary=once(ws,'message');ws.send(JSON.stringify({kind:'call',request:'boundary',name:'comms.agents',input:{}}));await boundary;
 expect(received.join('')).not.toContain('secret member words');
});
it('a page session invalidated while encryption awaits never commits or delivers its send',async()=>{
 let valid=true,resume:()=>void=()=>{},started:()=>void=()=>{};const wait=new Promise<void>(r=>{resume=r;}),begin=new Promise<void>(r=>{started=r;});
 const s=await setup({valid:()=>valid,key:key=>({...key,seal:async words=>{started();await wait;return key.seal(words);}})});
 const ws=new WebSocket(s.app.url.replace('http:','ws:')+'/live',{headers:{'x-member':'jonathan','x-window':'yes'}});cleanup.push(()=>ws.terminate());await once(ws,'open');
 ws.send(JSON.stringify({kind:'call',request:'open',name:'comms.open',input:{agent:'art',id:'firstaaaaaaaaaaa',text:'never stored'},id:'firstaaaaaaaaaaa'}));await begin;
 valid=false;const closed=once(ws,'close');resume();await closed;
 expect(s.app.db.prepare('SELECT * FROM comms_threads').all()).toEqual([]);expect(s.deliveries).toEqual([]);
});
it('the ninth pin is refused and unpinning releases capacity',async()=>{
 const s=await setup();const places:string[]=[];
 for(let n=0;n<9;n++){const place=await s.open();places.push(place);const r=await s.call('change',{thread:place,action:'pin'});if(n===8)expect(r).toMatchObject({code:'conflict'});else expect(r.ok).toBe(true);}
 await s.call('change',{thread:places[0],action:'unpin'});expect((await s.call('change',{thread:places[8],action:'pin'})).ok).toBe(true);
});
it('configurable retention is bounded and a one-day window expires exactly',async()=>{
 const s=await setup({days:1});const place=await s.open();await s.comms.deliver('art',place,1);s.clock.advance(86400_000);
 expect(JSON.stringify(await s.call('messages',{thread:place}))).not.toContain('secret member words');
 for(const days of [0,15,1.5])await expect(setup({days})).rejects.toThrow('1–14');
});
it('answers a distinct encrypted ask reference as the original member, and attention owns first-answer-wins',async()=>{
 const calls:{viewer:Viewer;id:string;kind:string}[]=[];let answered=false;
 const s=await setup({attention:{answer:(viewer,input)=>{calls.push({viewer,id:input.id,kind:input.answer.kind});if(answered)return {ok:false,code:'conflict',message:'Already answered'};answered=true;return {ok:true,value:{id:input.id}};}}});
 const place=await s.open();await s.comms.post('art',place,{id:'message-one',kind:'ask',ref:'attention-one',text:'A private question'});
 expect((await s.call('answer',{thread:place,ref:'attention-one',verdict:'yes'})).ok).toBe(true);
 expect(calls[0]).toEqual({viewer:member,id:'attention-one',kind:'yes'});
 expect(await s.call('answer',{thread:place,ref:'attention-one',verdict:'no'})).toMatchObject({code:'conflict'});
 expect(await s.call('answer',{thread:place,ref:'attention-one',verdict:'yes',words:'never plaintext'})).toMatchObject({code:'unavailable'});
 expect(JSON.stringify(s.app.db.prepare('SELECT * FROM core_operations').all())).not.toContain('A private question');
});
it('staging holds delivery and end; releasing a stable effect permits one runtime call',async()=>{
 let released=false;const finished:string[]=[];
 const hold=stagingHold({beforeOutside:()=>released,finish:id=>{finished.push(id);}});const s=await setup({hold});const place=await s.open();await s.comms.deliver('art',place,1);
 expect(s.deliveries).toEqual([]);expect(JSON.parse((s.app.db.prepare('SELECT record FROM comms_messages WHERE seq=1').get() as {record:string}).record).delivery).toBe('held');
 await s.call('change',{thread:place,action:'archive'});expect(s.ends).toEqual([]);
 await s.call('change',{thread:place,action:'unarchive'});released=true;await s.comms.deliver('art',place,1);expect(s.deliveries).toHaveLength(1);await s.comms.deliver('art',place,1);expect(s.deliveries).toHaveLength(1);expect(finished).toContain(`comms-deliver:${place}:1`);
});

it('rejects malformed client ids before encryption, persistence or runtime delivery',async()=>{
 let seals=0;
 const s=await setup({key:key=>({...key,seal:async words=>{seals++;return key.seal(words);}})});
 const place=await s.open();await s.comms.deliver('art',place,1);
 const before={seals,deliveries:s.deliveries.length,messages:s.app.db.prepare('SELECT count(*) AS n FROM comms_messages').get(),threads:s.app.db.prepare('SELECT count(*) AS n FROM comms_threads').get()};
 for(const id of ['', 'a'.repeat(15), 'a'.repeat(17), 'A'.repeat(16), 'a'.repeat(15)+'0', 'a'.repeat(15)+'1', 'a'.repeat(15)+'8', 'a'.repeat(15)+'9', 'a'.repeat(15)+'-', 'a'.repeat(16)+'\n']) {
  expect(await s.call('open',{agent:'art',id,text:'invalid open'})).toMatchObject({ok:false,code:'invalid'});
  expect(await s.call('send',{thread:place,id,text:'invalid send'})).toMatchObject({ok:false,code:'invalid'});
 }
 expect(seals).toBe(before.seals);expect(s.deliveries).toHaveLength(before.deliveries);
 expect(s.app.db.prepare('SELECT count(*) AS n FROM comms_messages').get()).toEqual(before.messages);
 expect(s.app.db.prepare('SELECT count(*) AS n FROM comms_threads').get()).toEqual(before.threads);
});
it('accepts the base32 alphabet and deduplicates first sends and later sends',async()=>{
 const s=await setup();const first={agent:'art',id:'abcdefghijklmnop',text:'first'};
 const opened=await s.call('open',first);expect(opened.ok).toBe(true);
 expect(await s.call('open',first)).toEqual(opened);
 expect(await s.call('open',{...first,text:'changed'})).toMatchObject({code:'conflict'});
 const thread=(opened as {ok:true;value:{thread:string}}).value.thread;
 const next={thread,id:'qrstuvwxyz234567',text:'next'};
 const sent=await s.call('send',next);expect(sent.ok).toBe(true);
 expect(await s.call('send',next)).toEqual(sent);
 expect(await s.call('send',{...next,text:'changed'})).toMatchObject({code:'conflict'});
 expect(s.app.db.prepare('SELECT count(*) AS n FROM comms_messages').get()).toEqual({n:2});
});
