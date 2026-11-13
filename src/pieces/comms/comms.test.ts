import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { startLoom } from '../../foundation.js';
import { FakeClock, type Sharing, type Viewer } from '../../core/index.js';
import { installComms } from './index.js';
import { loadKey, type WordsKey } from './crypto.js';
import { stagingHold, HeldEffect } from './role.js';
import type { Attention, Hold, Comms, Delivery, RuntimeDelivery } from './role.js';
const cleanup: (()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const f of cleanup.splice(0).reverse())await f();});
const member:Viewer={kind:'member',id:'jonathan'};
it('creates a private background spawn with its supplied conversation, brief and atomic parent links',async()=>{
 const metadata=new Map<string,{agent:string;venue:string;version:string;label?:string}>([['cv-job',{agent:'art',venue:'spawn',version:'one',label:'Private job'}]]);
 const s=await setup({conversation:id=>metadata.get(id)});const parent=await s.open();await s.comms.deliver('art',parent,1);
 const before=JSON.parse((s.app.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(parent) as {record:string}).record);
 metadata.set(before.conversation,{agent:'art',venue:'loom',version:'one',label:'Parent discussion'});
 const deliveries=s.deliveries.length;
 const created=await s.comms.spawn('art',{conversation:'cv-job',text:'Secret assigned brief',parent:before.conversation,run:'run-job'});
 const t=JSON.parse((s.app.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(created.thread) as {record:string}).record);
 expect(t).toMatchObject({member:'jonathan',conversation:'cv-job',title:'Private job',titledBy:'agent',working:false,readSeq:0,nextSeq:3});expect(t.firstId).toMatch(/^[a-z2-7]{16}$/);
 const rows=s.app.db.prepare('SELECT * FROM comms_messages WHERE thread=? ORDER BY seq').all(created.thread) as {sender:string;record:string;words:Buffer}[];
 expect(rows[0]).toMatchObject({sender:'art',record:JSON.stringify({delivery:'delivered'})});
 expect(JSON.stringify(rows)).not.toContain('Secret assigned brief');expect(JSON.stringify(rows)).not.toContain('run-job');
 const messages=await s.call('messages',{thread:created.thread});expect(messages.ok).toBe(true);
 const decoded=(messages as {ok:true;value:{text:string}[]}).value;
 expect(decoded[0].text).toBe('Secret assigned brief');expect(decoded[1].text).toContain('Parent discussion');expect(decoded[1].text).toContain('run-job');
 const parentMessages=await s.call('messages',{thread:parent});expect(JSON.stringify(parentMessages)).toContain('Spawned job:');expect(JSON.stringify(parentMessages)).toContain('cv-job');
 expect(await s.call('messages',{thread:created.thread},{kind:'member',id:'other'})).toMatchObject({ok:false});
 const socket=new WebSocket(s.app.url.replace('http:','ws:')+'/live',{headers:{'x-member':'jonathan','x-window':'yes'}});cleanup.push(()=>socket.terminate());await once(socket,'open');
 const received=once(socket,'message');socket.send(JSON.stringify({kind:'subscribe',type:'thread',scope:'all'}));const snapshot=JSON.parse((await received)[0].toString());
 expect(snapshot.records.find((r:{id:string})=>r.id===created.thread)).toMatchObject({background:true,job:{joined:false}});
 expect(s.deliveries).toHaveLength(deliveries);expect(s.ends).toHaveLength(0);
 expect(s.comms.describe('art',created.thread).brief[0]).toContain('conversation:cv-job');
});
it('keeps the first spawn across concurrent calls, restart and word expiry without crypto or activity',async()=>{
 let unavailable=false;const s=await setup({conversation:()=>({agent:'art',venue:'spawn',version:'one'}),key:k=>({...k,seal:async words=>{if(unavailable)throw new Error('key unavailable');return k.seal(words);}})});
 const [a,b]=await Promise.all([s.comms.spawn('art',{conversation:'cv-job',text:'First brief'}),s.comms.spawn('art',{conversation:'cv-job',text:'Second brief'})]);expect(a).toEqual(b);
 expect(s.app.db.prepare('SELECT count(*) AS n FROM comms_threads').get()).toEqual({n:1});expect(s.app.db.prepare('SELECT count(*) AS n FROM comms_messages').get()).toEqual({n:1});
 await s.restart();const before=s.app.db.prepare('SELECT record FROM comms_threads').get();unavailable=true;
 expect(await s.comms.spawn('art',{conversation:'cv-job',text:'Changed retry'})).toEqual(a);expect(s.app.db.prepare('SELECT record FROM comms_threads').get()).toEqual(before);
 s.clock.advance(14*86400_000);expect(await s.comms.spawn('art',{conversation:'cv-job',text:'Expired retry'})).toEqual(a);
 expect(s.app.db.prepare('SELECT words FROM comms_messages').get()).toEqual({words:null});expect(s.deliveries).toHaveLength(0);
});
it('assigns a spawn to the owning parent member, otherwise the first explicit agent owner',async()=>{
 const s=await setup({conversation:()=>({agent:'art',venue:'spawn',version:'one'})});
 const opened=await s.call('open',{agent:'art',id:'bbbbbbbbbbbbbbbb',text:'Other owner parent'},{kind:'member',id:'other'});expect(opened.ok).toBe(true);
 const p=(opened as {ok:true;value:{thread:string}}).value.thread;const cv=JSON.parse((s.app.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(p) as {record:string}).record).conversation;
 const a=await s.comms.spawn('art',{conversation:'cv-child',text:'Child',parent:cv});
 expect((s.app.db.prepare('SELECT member FROM comms_threads WHERE id=?').get(a.thread))).toEqual({member:'other'});
 const b=await s.comms.spawn('art',{conversation:'cv-other',text:'Unparented'});expect(s.app.db.prepare('SELECT member FROM comms_threads WHERE id=?').get(b.thread)).toEqual({member:'jonathan'});
});
for(const boundary of ['metadata','owner','closed','parent','archive','delete'] as const)it(`refuses an in-flight spawn after ${boundary} changes with no partial links`,async()=>{
 let pause=false,entered!:()=>void,release!:()=>void;const start=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>release=r);
 const metadata=new Map<string,{agent:string;venue:string;version:string}>([['cv-job',{agent:'art',venue:'spawn',version:'one'}]]);
 const s=await setup({conversation:id=>metadata.get(id),key:k=>({...k,seal:async words=>{expect(s.app.db.inTransaction).toBe(false);if(pause){entered();await wait;}return k.seal(words);}})});
 const place=await s.open();await s.comms.deliver('art',place,1);const t=JSON.parse((s.app.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(place) as {record:string}).record);metadata.set(t.conversation,{agent:'art',venue:'loom',version:'one'});
 pause=true;const pending=s.comms.spawn('art',{conversation:'cv-job',text:'Private job brief',parent:t.conversation});await start;
 if(boundary==='metadata')metadata.set('cv-job',{agent:'art',venue:'spawn',version:'two'});
 if(boundary==='owner')s.setSharing({...s.getSharing(),members:{...s.getSharing().members,jonathan:{owner:true,agents:[]}}});
 if(boundary==='closed')await s.comms.close();
 if(boundary==='parent'){t.conversation='cv-replaced';s.app.db.prepare('UPDATE comms_threads SET record=? WHERE id=?').run(JSON.stringify(t),place);}
 if(boundary==='archive'||boundary==='delete')await s.call('change',{thread:place,action:boundary});
 const before=s.app.db.prepare('SELECT * FROM comms_messages').all();release();await expect(pending).rejects.toThrow('Spawn unavailable');expect(s.app.db.prepare('SELECT * FROM comms_messages').all()).toEqual(before);
 expect(s.app.db.prepare("SELECT 1 FROM comms_threads WHERE json_extract(record,'$.conversation')='cv-job'").get()).toBeUndefined();
});
it('rejects invalid spawn metadata and deleted jobs before sealing, and rolls back parent append failures',async()=>{
 let seals=0;const metadata=new Map<string,{agent:string;venue:string;version:string}>([['cv-job',{agent:'art',venue:'spawn',version:'one'}]]);
 const s=await setup({conversation:id=>metadata.get(id),key:k=>({...k,seal:async words=>{seals++;return k.seal(words);}})});
 for(const cv of [undefined,{agent:'other',venue:'spawn',version:'one'},{agent:'art',venue:'loom',version:'one'},{agent:'art',venue:'spawn',version:''}]){
  if(cv)metadata.set('cv-bad',cv);else metadata.delete('cv-bad');await expect(s.comms.spawn('art',{conversation:'cv-bad',text:'Brief'})).rejects.toThrow('Spawn unavailable');
 }expect(seals).toBe(0);
 const parent=await s.open();await s.comms.deliver('art',parent,1);const cv=JSON.parse((s.app.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(parent) as {record:string}).record).conversation;
 s.app.db.exec(`CREATE TRIGGER fail_spawn BEFORE INSERT ON comms_messages WHEN NEW.kind='reply' BEGIN SELECT RAISE(ABORT,'injected'); END`);
 await expect(s.comms.spawn('art',{conversation:'cv-job',text:'Brief',parent:cv})).rejects.toThrow('injected');expect(s.app.db.prepare('SELECT count(*) AS n FROM comms_threads').get()).toEqual({n:1});
 s.app.db.exec('DROP TRIGGER fail_spawn');const job=await s.comms.spawn('art',{conversation:'cv-job',text:'Brief'});await s.call('change',{thread:job.thread,action:'delete'});const before=seals;
 await expect(s.comms.spawn('art',{conversation:'cv-job',text:'Resurrection'})).rejects.toThrow('Spawn unavailable');expect(seals).toBe(before);
});
it('keeps spawn words private for an ordinary parent and uses commit time after crypto',async()=>{
 let advance=false;const s=await setup({conversation:id=>({agent:'art',venue:id==='cv-job'?'spawn':'terminal',version:'one',label:'Link [name]'}),key:k=>({...k,seal:async words=>{if(advance)s.clock.advance(1000);return k.seal(words);}})});
 advance=true;const job=await s.comms.spawn('art',{conversation:'cv-job',text:'Assigned job',parent:'cv-terminal'});
 const t=JSON.parse((s.app.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(job.thread) as {record:string}).record);expect(t.opened).toBe(s.clock.now());
 const messages=await s.call('messages',{thread:job.thread});expect(JSON.stringify(messages)).toContain('/p/comms-preview/conversation/cv-terminal');
 expect(s.app.db.prepare('SELECT count(*) AS n FROM comms_threads').get()).toEqual({n:1});
 expect(s.comms.announcements('jonathan')).toEqual([]);
});
it('does not grant a spawn to household owners without explicit agent ownership or expose a public spawn operation',async()=>{
 const s=await setup({conversation:()=>({agent:'art',venue:'spawn',version:'one'})});
 s.setSharing({...s.getSharing(),members:{jonathan:{owner:true,agents:[]},other:{owner:true,agents:[]}}});
 await expect(s.comms.spawn('art',{conversation:'cv-job',text:'Brief'})).rejects.toThrow('Spawn unavailable');
 expect(s.app.db.prepare('SELECT count(*) AS n FROM comms_threads').get()).toEqual({n:0});
 expect(await s.call('spawn',{conversation:'cv-job',text:'Brief'})).toMatchObject({ok:false});
});
it('keeps the first spawn report by reference across message ids, restart and expiry without crypto or new activity',async()=>{
 let failSeal=false;const s=await setup({key:k=>({...k,seal:async words=>{if(failSeal)throw new Error('key unavailable');return k.seal(words);}})});
 const place=await s.open();await s.comms.deliver('art',place,1);
 const report={id:'first-report',kind:'reply' as const,text:'First private report',ref:'spawn-run-0123456789ab',run:'run-0123456789ab'};
 const first=await s.comms.post('art',place,report);
 const saved=()=>s.app.db.prepare('SELECT * FROM comms_messages WHERE thread=? AND seq=?').get(place,first.seq);
 const original=saved();await s.restart();s.clock.advance(1);
 s.comms.status('art',place,'working');const live=vi.spyOn(s.app.live,'changed');live.mockClear();
 failSeal=true;
 expect(await s.comms.post('art',place,{...report,id:'retry-report',text:'Changed retry report'})).toEqual(first);
 expect(saved()).toEqual(original);expect(live).not.toHaveBeenCalled();expect(s.comms.trace('art',place).working).toBe(true);
 failSeal=false;s.clock.advance(14*86400_000);const expired=saved();failSeal=true;
 expect(await s.comms.post('art',place,{...report,id:'after-expiry'})).toEqual(first);
 expect(saved()).toEqual(expired);expect((expired as {words:unknown}).words).toBeNull();
 expect(await s.call('messages',{thread:place})).toMatchObject({ok:true,value:expect.arrayContaining([expect.objectContaining({seq:first.seq,text:null})])});
});
it('coalesces overlapping spawn report references at commit and isolates them by thread',async()=>{
 let pause=false,release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>{release=r;}),began=new Promise<void>(r=>{started=r;});
 const s=await setup({key:k=>({...k,seal:async words=>{if(pause){started();await gate;}return k.seal(words);}})});
 const place=await s.open();await s.comms.deliver('art',place,1);const other=await s.open();await s.comms.deliver('art',other,1);
 const report={id:'report-a',kind:'reply' as const,text:'Private report A',ref:'spawn-run-0123456789ab'};
 pause=true;const pending=s.comms.post('art',place,report);await began;pause=false;
 const winner=await s.comms.post('art',place,{...report,id:'report-b',text:'Private report B'});release();
 expect(await pending).toEqual(winner);
 expect(await s.call('messages',{thread:place})).toMatchObject({ok:true,value:expect.arrayContaining([expect.objectContaining({seq:winner.seq,text:'Private report B'})])});
 expect((s.app.db.prepare("SELECT count(*) AS n FROM comms_messages WHERE thread=? AND kind='reply'").get(place) as {n:number}).n).toBe(1);
 await s.comms.post('art',other,report);
 expect((s.app.db.prepare("SELECT count(*) AS n FROM comms_messages WHERE kind='reply'").get() as {n:number}).n).toBe(2);
});
for(const boundary of ['agent','ownership','archive','delete','close'] as const)it(`checks spawn report retry access before its receipt (${boundary})`,async()=>{
 const s=await setup();const place=await s.open();await s.comms.deliver('art',place,1);
 const report={id:'first',kind:'reply' as const,text:'Private report',ref:'spawn-run-0123456789ab'};await s.comms.post('art',place,report);
 if(boundary==='ownership')s.setSharing({...s.getSharing(),members:{jonathan:{agents:[]}}});
 if(boundary==='archive'||boundary==='delete')await s.call('change',{thread:place,action:boundary});
 if(boundary==='close')await s.comms.close();
 await expect(s.comms.post(boundary==='agent'?'other-agent':'art',place,{...report,id:'retry'})).rejects.toThrow();
});
for(const boundary of ['ownership','archive','delete','close','conversation'] as const)it(`rechecks a racing spawn report receipt after encryption (${boundary})`,async()=>{
 let pause=false,release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>{release=r;}),began=new Promise<void>(r=>{started=r;});
 const s=await setup({key:k=>({...k,seal:async words=>{if(pause){started();await gate;}return k.seal(words);}})});
 const place=await s.open();await s.comms.deliver('art',place,1);
 const report={id:'report-a',kind:'reply' as const,text:'Private report',ref:'spawn-run-0123456789ab'};
 pause=true;const pending=s.comms.post('art',place,report);const rejected=expect(pending).rejects.toThrow();await began;pause=false;
 await s.comms.post('art',place,{...report,id:'report-b'});
 if(boundary==='ownership')s.setSharing({...s.getSharing(),members:{jonathan:{agents:[]}}});
 if(boundary==='archive'||boundary==='delete')await s.call('change',{thread:place,action:boundary});
 if(boundary==='close')await s.comms.close();
 if(boundary==='conversation'){
  const row=s.app.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(place) as {record:string};
  s.app.db.prepare('UPDATE comms_threads SET record=? WHERE id=?').run(JSON.stringify({...JSON.parse(row.record),conversation:'cv-replaced'}),place);
 }
 release();await rejected;
});
it('applies spawn report references only to replies with the exact stable reference shape',async()=>{
 const s=await setup();const place=await s.open();await s.comms.deliver('art',place,1);
 for(const ref of ['spawn-run-0123456789aB','spawn-run-0123456789ab-extra','other-ref']){
  await s.comms.post('art',place,{id:ref+'-one',kind:'reply',text:'One',ref});
  await s.comms.post('art',place,{id:ref+'-two',kind:'reply',text:'Two',ref});
 }
 for(const kind of ['ask','error','card'] as const){
  await s.comms.post('art',place,{id:kind+'-one',kind,text:'One',ref:'spawn-run-0123456789ab'});
  await s.comms.post('art',place,{id:kind+'-two',kind,text:'Two',ref:'spawn-run-0123456789ab'});
 }
 expect((s.app.db.prepare('SELECT count(*) AS n FROM comms_messages WHERE thread=?').get(place) as {n:number}).n).toBe(13);
});
it('groups assigned spawn threads until their member writes, with scoped Live promotion',async()=>{
 const conversations=new Map<string,{agent:string;venue:string;version:string}>();
 const s=await setup({conversation:id=>conversations.get(id)});const place=await s.open();await s.comms.deliver('art',place,1);
 const saved=JSON.parse((s.app.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(place) as {record:string}).record);
 saved.conversation='cv-spawn-fixture';s.app.db.prepare('UPDATE comms_threads SET record=? WHERE id=?').run(JSON.stringify(saved),place);
 conversations.set(saved.conversation,{agent:'art',venue:'spawn',version:'one'});
 s.app.db.prepare("UPDATE comms_messages SET sender='art' WHERE thread=? AND kind='message'").run(place);
 const ws=new WebSocket(s.app.url.replace('http:','ws:')+'/live',{headers:{'x-member':'jonathan','x-window':'yes'}});cleanup.push(()=>ws.terminate());await once(ws,'open');
 const snapshot=(scope?:string)=>new Promise<Record<string,unknown>[]>(resolve=>{const receive=(raw:Buffer)=>{const frame=JSON.parse(raw.toString());if(frame.kind==='set'&&frame.type==='thread'&&frame.scope===scope){ws.off('message',receive);resolve(frame.records);}};ws.on('message',receive);ws.send(JSON.stringify({kind:'subscribe',type:'thread',scope}));});
 expect(await snapshot()).toEqual([]);
 expect(await snapshot('background')).toMatchObject([{id:place,job:{joined:false},background:true}]);
 expect(await snapshot('all')).toMatchObject([{id:place,job:{joined:false},background:true}]);
 const summaries=await s.call('agents',{});expect(summaries).toMatchObject({ok:true,value:{summaries:[{agent:'art',unread:0}]}});
 expect(JSON.stringify(summaries)).not.toContain(place);
 // Merely reading the job does not promote it.
 await s.call('change',{thread:place,action:'read',seq:1});
 expect(await snapshot('background')).toHaveLength(1);
 const frames:Record<string,unknown>[]=[];let promoted=()=>{};const promotion=new Promise<void>(resolve=>{promoted=resolve;});ws.on('message',raw=>{const frame=JSON.parse(raw.toString());frames.push(frame);if(frame.kind==='put'&&frame.scope==='all'&&frame.record.background===false)promoted();});
 await s.call('send',{thread:place,id:'followupaaaaaaaa',text:'Join this work'});await s.comms.deliver('art',place,2);await promotion;
 expect(frames).toContainEqual({kind:'del',type:'thread',scope:'background',id:place});
 expect(frames.some(f=>f.kind==='put'&&f.scope===undefined&&(f.record as {id?:string}).id===place)).toBe(true);
 expect(await snapshot()).toMatchObject([{id:place,job:{joined:true},background:false}]);
 await s.restart();expect(await s.call('agents',{})).toMatchObject({ok:true,value:{summaries:[{last:{thread:place}}]}});
});
it('refreshes background classification on authoritative conversation changes and keeps archived jobs in archive',async()=>{
 const conversations=new Map<string,{agent:string;venue:string;version:string}>();
 const s=await setup({conversation:id=>conversations.get(id)});const place=await s.open();await s.comms.deliver('art',place,1);
 const saved=JSON.parse((s.app.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(place) as {record:string}).record);
 const cv='cv-spawn-fixture';saved.conversation=cv;s.app.db.prepare('UPDATE comms_threads SET record=? WHERE id=?').run(JSON.stringify(saved),place);
 s.app.db.prepare("UPDATE comms_messages SET sender='art' WHERE thread=?").run(place);
 const ws=new WebSocket(s.app.url.replace('http:','ws:')+'/live',{headers:{'x-member':'jonathan','x-window':'yes'}});cleanup.push(()=>ws.terminate());await once(ws,'open');
 const snapshot=(scope?:string)=>new Promise<Record<string,unknown>[]>(resolve=>{const receive=(raw:Buffer)=>{const frame=JSON.parse(raw.toString());if(frame.kind==='set'&&frame.type==='thread'&&frame.scope===scope){ws.off('message',receive);resolve(frame.records);}};ws.on('message',receive);ws.send(JSON.stringify({kind:'subscribe',type:'thread',scope}));});
 expect(await snapshot()).toMatchObject([{id:place,job:false,background:false}]);
 conversations.set(cv,{agent:'other-agent',venue:'spawn',version:'one'});
 expect(await snapshot()).toHaveLength(1);
 conversations.set(cv,{agent:'art',venue:'spawn',version:'two'});
 const update=once(ws,'message');s.app.live.changed([{type:'conversation',id:cv}]);
 expect(JSON.parse((await update)[0].toString())).toEqual({kind:'del',type:'thread',id:place});
 expect(await snapshot('background')).toHaveLength(1);
 await s.call('change',{thread:place,action:'archive'});
 // Use a fresh connection to avoid queued updates for existing subscriptions.
 ws.terminate();
 const ws2=new WebSocket(s.app.url.replace('http:','ws:')+'/live',{headers:{'x-member':'jonathan','x-window':'yes'}});cleanup.push(()=>ws2.terminate());await once(ws2,'open');
 const next=once(ws2,'message');ws2.send(JSON.stringify({kind:'subscribe',type:'thread',scope:'archived'}));
 expect(JSON.parse((await next)[0].toString()).records).toMatchObject([{id:place,background:true}]);
});
for(const scope of ['background','all'] as const)it(`keeps ${scope} thread scopes restricted to the owning member window`,async()=>{
 const s=await setup({conversation:()=>({agent:'art',venue:'spawn',version:'one'})});const place=await s.open();await s.comms.deliver('art',place,1);
 const t=JSON.parse((s.app.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(place) as {record:string}).record);
 t.conversation='cv-job';s.app.db.prepare('UPDATE comms_threads SET record=? WHERE id=?').run(JSON.stringify(t),place);
 s.app.db.prepare("UPDATE comms_messages SET sender='art' WHERE thread=?").run(place);
 for(const [who,window] of [['other',true],['jonathan',false]] as const){
  const ws=new WebSocket(s.app.url.replace('http:','ws:')+'/live',{headers:{'x-member':who,'x-window':window?'yes':'no'}});cleanup.push(()=>ws.terminate());await once(ws,'open');
  const answer=once(ws,'message');ws.send(JSON.stringify({kind:'subscribe',type:'thread',scope}));const frame=JSON.parse((await answer)[0].toString());
  if(window)expect(frame.records).toEqual([]);else expect(frame.code).toBe('denied');
 }
});
it('offers unread reply notifications only to the opener, with metadata and stable latest-reply keys',async()=>{
 const s=await setup();const place=await s.open();await s.comms.deliver('art',place,1);
 for(const kind of ['card','ask','error'] as const)await s.comms.post('art',place,{id:kind,kind,text:`private ${kind} words`});
 expect(s.comms.announcements('jonathan')).toEqual([]);
 const reply={id:'reply-one',kind:'reply' as const,text:'private reply words',run:'private-run'};
 const {seq}=await s.comms.post('art',place,reply);
 const expected={key:`comms-${place}-${seq}`,member:'jonathan',agent:'art',open:true,title:'Art replied in a new thread',body:'',url:`/p/comms-preview/thread/${place.slice(3)}`};
 expect(s.comms.announcements('jonathan')).toEqual([expected]);
 expect(s.comms.announcements('other')).toEqual([]);
 await s.comms.post('art',place,reply);
 await s.comms.post('art',place,{id:'later-card',kind:'card',text:'private later work'});
 expect(s.comms.announcements('jonathan')).toEqual([expected]);
 await s.call('change',{thread:place,action:'title',title:'A public thread title'});
 expect(s.comms.announcements('jonathan')).toEqual([{...expected,title:'Art replied',body:'A public thread title'}]);
 const second=await s.comms.post('art',place,{id:'reply-two',kind:'reply',text:'private second reply'});
 expect(s.comms.announcements('jonathan')[0].key).toBe(`comms-${place}-${second.seq}`);
 expect(JSON.stringify(s.comms.announcements('jonathan'))).not.toMatch(/private/);
});
it('suppresses only the foreground thread until the exact two-minute boundary, across restart',async()=>{
 const s=await setup();const a=await s.open(),b=await s.open();
 for(const place of [a,b])await s.comms.post('art',place,{id:'reply',kind:'reply',text:'private words'});
 await s.call('change',{thread:a,action:'read',seq:0});
 expect(s.comms.announcements('jonathan').map(x=>x.url)).toEqual([`/p/comms-preview/thread/${b.slice(3)}`]);
 await s.restart();s.clock.advance(119999);
 expect(s.comms.announcements('jonathan')).toHaveLength(1);
 s.clock.advance(1);expect(s.comms.announcements('jonathan')).toHaveLength(2);
 await s.call('change',{thread:a,action:'read',seq:999});s.clock.advance(120000);
 expect(s.comms.announcements('jonathan').map(x=>x.url)).toEqual([`/p/comms-preview/thread/${b.slice(3)}`]);
});
for(const boundary of ['ownership','archive','delete','close'] as const)it(`drops notification candidates after ${boundary}`,async()=>{
 const s=await setup();const place=await s.open();await s.comms.post('art',place,{id:'reply',kind:'reply',text:'private words'});
 expect(s.comms.announcements('jonathan')).toHaveLength(1);
 if(boundary==='ownership')s.setSharing({...s.getSharing(),members:{jonathan:{owner:true,agents:[]}}});
 else if(boundary==='close')await s.comms.close();
 else await s.call('change',{thread:place,action:boundary});
 expect(s.comms.announcements('jonathan')).toEqual([]);
});
it('keeps notification metadata after words expire without using crypto or exposing a public operation',async()=>{
 let opens=0;const s=await setup({key:k=>({...k,open:async words=>{opens++;return k.open(words);}})});
 const place=await s.open();await s.comms.deliver('art',place,1);
 await s.comms.post('art',place,{id:'reply',kind:'reply',text:'private reply'});
 const before=opens,candidates=s.comms.announcements('jonathan');
 s.clock.advance(14*86400000);
 expect(s.comms.announcements('jonathan')).toEqual(candidates);expect(opens).toBe(before);
 expect(s.app.db.prepare('SELECT words FROM comms_messages WHERE thread=? AND kind=\'reply\'').get(place)).toEqual({words:null});
 expect((await s.call('announcements',{member:'jonathan'})).ok).toBe(false);
});
it('does not notify assigned background work until the member writes in it',async()=>{
 const s=await setup();const place=await s.open();await s.comms.deliver('art',place,1);
 // An assigned job has an access member but no message from that member.
 s.app.db.prepare("DELETE FROM comms_messages WHERE thread=? AND kind='message'").run(place);
 await s.comms.post('art',place,{id:'report',kind:'reply',text:'private background report'});
 expect(s.comms.announcements('jonathan')).toEqual([]);
 expect((await s.call('send',{thread:place,id:'followupaaaaaaaa',text:'A follow-up'})).ok).toBe(true);
 expect(s.comms.announcements('jonathan')).toHaveLength(1);
});
it('refreshes foreground presence on unchanged reads without moving activity or publishing Live changes',async()=>{
 const s=await setup();const place=await s.open();await s.comms.deliver('art',place,1);
 const saved=()=>JSON.parse((s.app.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(place) as {record:string}).record);
 const original=saved();
 await s.call('change',{thread:place,action:'read',seq:1});
 expect(saved().inFront).toBe(s.clock.now());
 const changed=vi.spyOn(s.app.live,'changed');changed.mockClear();
 s.clock.advance(30000);
 await s.call('change',{thread:place,action:'read',seq:0});
 expect(saved()).toMatchObject({inFront:s.clock.now(),readSeq:1,last:original.last});
 expect(changed).not.toHaveBeenCalled();
 await s.restart();expect(saved().inFront).toBe(s.clock.now());
 const before=saved();
 expect((await s.call('change',{thread:place,action:'read',seq:1},{kind:'member',id:'other'})).ok).toBe(false);
 expect((await s.call('change',{thread:place,action:'read',seq:1},member,false)).ok).toBe(false);
 expect(saved()).toEqual(before);
});
async function setup(overrides: {key?:(key:WordsKey)=>WordsKey; hold?:boolean|Hold; days?:number; attention?:Attention; valid?:()=>boolean; receipt?:RuntimeDelivery['receipt']; conversation?:(id:string)=>{agent:string;venue:string;version:string}|undefined; deliver?:(message:Delivery)=>Promise<void>; end?:(conversation:string)=>Promise<void>}={}) {
 const home=mkdtempSync(join(tmpdir(),'comms-next-'));cleanup.push(()=>rmSync(home,{recursive:true,force:true}));
 const clock=new FakeClock();let sharing:Sharing={members:{jonathan:{owner:true,agents:['art']},other:{owner:true,agents:['art']}},projects:{pond:{members:['other','jonathan'],agents:['art','pond-bot']}},services:{runtime:{types:['message','thread'],operations:[]}}};
 const deliveries:Delivery[]=[];const ends:string[]=[];let comms:Comms & {close():Promise<void>};const base=await loadKey(home),key=overrides.key?.(base)??base;
 const start=()=>startLoom({home,clock,authenticate:req=>({viewer:{kind:'member',id:String(req.headers['x-member']??'jonathan')},window:req.headers['x-window']==='yes',valid:overrides.valid??(()=>true)}),
  install:a=>{comms=installComms({...a,clock,key,sharing:()=>sharing,conversation:overrides.conversation,runtime:{receipt:overrides.receipt,deliver:async d=>{await overrides.deliver?.(d);deliveries.push(d);},end:async cv=>{await overrides.end?.(cv);ends.push(cv);}},days:overrides.days,hold:typeof overrides.hold==='function'?overrides.hold:async f=>{if(overrides.hold)throw new Error('staging');return f();},attention:overrides.attention??{answer:()=>({ok:true,value:{answered:true}})}});},
 });let app=await start();cleanup.push(()=>app.close());cleanup.push(()=>comms.close());
 let n=0;
 const call=(name:string,input:unknown,v:Viewer=member,window=true)=>app.operations.callAsync('socket',v,`comms.${name}`,input,`op-${++n}`,window);
 const open=async()=>{const r=await call('open',{agent:'art',id:n.toString(2).replaceAll('0','a').replaceAll('1','b').padStart(16,'a'),text:'secret member words',project:'pond'});expect(r.ok).toBe(true);return (r as {ok:true;value:{thread:string;seq:number}}).value.thread;};
 return {get app(){return app;},clock,home,call,open,deliveries,ends,get comms(){return comms;},async restart(){await comms.close();await app.close();app=await start();},setSharing:(value:Sharing)=>{sharing=value;app.live.refreshAccess();},getSharing:()=>sharing};
}
for(const kind of ['reply','card'] as const)for(const boundary of ['revoked','closed','archived','deleted','member','conversation','project'] as const)it(`refuses a runtime post changed during encryption (${kind}, ${boundary})`,async()=>{
 let pause=false,release:()=>void=()=>{},started:()=>void=()=>{};
 const waiting=new Promise<void>(r=>{release=r;}),began=new Promise<void>(r=>{started=r;});
 const s=await setup({key:k=>({...k,seal:async words=>{if(pause){started();await waiting;}return k.seal(words);}})});
 const place=await s.open();await s.comms.deliver('art',place,1);
 if(kind==='card')await s.comms.post('art',place,{id:'late-post',kind,text:'original private card'});
 pause=true;
 const result=s.comms.post('art',place,{id:'late-post',kind,text:'late private reply'});
 const rejected=expect(result).rejects.toThrow();await began;
 if(boundary==='revoked')s.setSharing({...s.getSharing(),members:{jonathan:{agents:[]}}});
 else if(boundary==='closed')await s.comms.close();
 else if(boundary==='archived'||boundary==='deleted')await s.call('change',{thread:place,action:boundary==='archived'?'archive':'delete'});
 else s.app.db.prepare(`UPDATE comms_threads SET record=json_set(record,'$.${boundary}',?) WHERE id=?`).run(boundary==='member'?'other':'replacement',place);
 const before=JSON.stringify(s.app.db.prepare('SELECT * FROM comms_messages').all());
 const threadBefore=JSON.stringify(s.app.db.prepare('SELECT * FROM comms_threads').all());
 release();await rejected;
 expect(JSON.stringify(s.app.db.prepare('SELECT * FROM comms_messages').all())).toBe(before);
 expect(JSON.stringify(s.app.db.prepare('SELECT * FROM comms_threads').all())).toBe(threadBefore);
});
it('refuses every runtime post kind before encryption when ownership or the instance is unavailable',async()=>{
 let seals=0;const s=await setup({key:k=>({...k,seal:async words=>{seals++;return k.seal(words);}})});
 const place=await s.open();await s.comms.deliver('art',place,1);
 const sharing=s.getSharing(),before=seals;
 s.setSharing({...sharing,members:{jonathan:{agents:[]}}});
 for(const kind of ['reply','card','ask','error'] as const)await expect(s.comms.post('art',place,{id:kind,kind,text:'refused private words'})).rejects.toThrow();
 s.setSharing(sharing);await s.comms.close();
 await expect(s.comms.post('art',place,{id:'closed',kind:'reply',text:'refused private words'})).rejects.toThrow();
 expect(seals).toBe(before);
});
for(const boundary of ['revoked','closed','archived','deleted','wrong-agent'] as const)it(`refuses unavailable runtime title writes (${boundary})`,async()=>{
 const s=await setup();const place=await s.open();await s.comms.deliver('art',place,1);
 if(boundary==='revoked')s.setSharing({...s.getSharing(),members:{jonathan:{agents:[]}}});
 else if(boundary==='closed')await s.comms.close();
 else if(boundary==='archived'||boundary==='deleted')await s.call('change',{thread:place,action:boundary==='archived'?'archive':'delete'});
 const before=JSON.stringify(s.app.db.prepare('SELECT * FROM comms_threads').all());
 expect(()=>s.comms.title(boundary==='wrong-agent'?'pond-bot':'art',place,'Unavailable title')).toThrow();
 expect(JSON.stringify(s.app.db.prepare('SELECT * FROM comms_threads').all())).toBe(before);
});
it('lets the runtime name a live owned thread until the member names it',async()=>{
 const s=await setup();const place=await s.open();await s.comms.deliver('art',place,1);
 s.comms.title('art',place,'Runtime title');
 expect(JSON.parse((s.app.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(place) as {record:string}).record)).toMatchObject({title:'Runtime title',titledBy:'agent'});
 await s.call('change',{thread:place,action:'title',title:'Member title'});
 expect(()=>s.comms.title('art',place,'Replacement')).toThrow('member');
});
it('keeps one encrypted start notice through retries, restart and final failure',async()=>{
 const s=await setup();const place=await s.open();await s.comms.deliver('art',place,1);
 const retry={kind:'start-retry' as const,seq:1,attempt:1,retryAt:'2026-11-12T00:01:00Z',reason:'private host failure',run:'run-start'};
 expect(await s.comms.startNotice('art',place,retry)).toEqual({seq:2});
 const first=JSON.stringify(s.app.db.prepare('SELECT * FROM comms_messages').all());
 expect(first).not.toContain('private host failure');expect(first).not.toContain('run-start');expect(first).not.toContain('start-retry');
 expect(JSON.stringify(await s.call('messages',{thread:place}))).toContain("Art couldn't start; retrying.");
 await s.comms.startNotice('art',place,{...retry,reason:'changed duplicate'});
 expect(JSON.stringify(s.app.db.prepare('SELECT * FROM comms_messages').all())).toBe(first);
 await s.restart();await s.comms.startNotice('art',place,{...retry,attempt:2});
 const second=JSON.stringify(s.app.db.prepare('SELECT * FROM comms_messages').all());
 await s.comms.startNotice('art',place,retry);expect(JSON.stringify(s.app.db.prepare('SELECT * FROM comms_messages').all())).toBe(second);
 expect(JSON.stringify(await s.call('messages',{thread:place}))).toContain("Art couldn't start (2 tries so far); retrying.");
 await s.comms.startNotice('art',place,{kind:'start-failed',seq:1,attempt:2});
 const page=JSON.stringify(await s.call('messages',{thread:place}));
 expect(page).toContain("Art couldn't start after 2 tries.");expect(page).toContain('private host failure');
 const failed=JSON.stringify(s.app.db.prepare('SELECT * FROM comms_messages').all());
 await s.comms.startNotice('art',place,{...retry,attempt:3});
 await s.comms.startNotice('art',place,{kind:'start-failed',seq:1,attempt:3});
 expect(JSON.stringify(s.app.db.prepare('SELECT * FROM comms_messages').all())).toBe(failed);
 expect(s.app.db.prepare('SELECT count(*) AS n FROM comms_messages').get()).toEqual({n:2});
});
for(const progress of ['working','done','card','reply','no-reply'] as const)it(`ignores start notices after body progress (${progress})`,async()=>{
 const s=await setup();const place=await s.open();await s.comms.deliver('art',place,1);
 if(progress==='working'||progress==='done'){s.comms.status('art',place,progress);if(progress==='working')s.clock.advance(90_000);}
 else if(progress==='no-reply')await s.comms.notice('art',place,{kind:'no-reply',id:'run'});
 else await s.comms.post('art',place,{id:'progress',kind:progress,text:'body progress'});
 const before=JSON.stringify(s.app.db.prepare('SELECT * FROM comms_messages').all());
 expect(await s.comms.startNotice('art',place,{kind:'start-failed',seq:1,attempt:1})).toEqual({seq:null});
 expect(JSON.stringify(s.app.db.prepare('SELECT * FROM comms_messages').all())).toBe(before);
 // A new member message has its own start lifecycle.
 await s.call('send',{thread:place,id:'newmessageaaaaaa',text:'new request'});
 const seq=(s.app.db.prepare("SELECT max(seq) AS seq FROM comms_messages WHERE kind='message'").get() as {seq:number}).seq;
 await s.comms.deliver('art',place,seq);
 expect((await s.comms.startNotice('art',place,{kind:'start-failed',seq,attempt:1})).seq).not.toBeNull();
});
for(const progress of ['working','done','card','reply','no-reply'] as const)it(`settles an existing retry headline after body progress (${progress})`,async()=>{
 const s=await setup();const place=await s.open();await s.comms.deliver('art',place,1);
 const notice={kind:'start-retry' as const,seq:1,attempt:2,retryAt:'2026-11-12T00:01:00Z',reason:'private start reason'};
 await s.comms.startNotice('art',place,notice);
 const stored=JSON.stringify(s.app.db.prepare('SELECT * FROM comms_messages WHERE seq=2').get());
 const changed=vi.spyOn(s.app.live,'changed');changed.mockClear();
 if(progress==='working'||progress==='done')s.comms.status('art',place,progress);
 else if(progress==='no-reply')await s.comms.notice('art',place,{kind:'no-reply',id:'progress'});
 else await s.comms.post('art',place,{id:'progress',kind:progress,text:'body progress'});
 expect(changed.mock.calls.flatMap(([refs])=>refs)).toContainEqual({type:'message',id:`${place}/2`});
 const read=()=>s.comms.reader({agent:'art',conversation:place,valid:()=>true}).read({thread:place});
 const page=await read();
 expect(page.messages.find(m=>m.seq===2)).toMatchObject({text:"Art couldn't start at first.",step:{error:'start-retry',settled:true,attempt:2,reason:'private start reason'}});
 expect(JSON.stringify(await s.call('messages',{thread:place}))).toContain("Art couldn't start at first.");
 expect(JSON.stringify(s.app.db.prepare('SELECT * FROM comms_messages WHERE seq=2').get())).toBe(stored);
 if(progress==='working')s.clock.advance(90_000);
 await s.restart();
 expect((await read()).messages.find(m=>m.seq===2)?.text).toBe("Art couldn't start at first.");
 await s.comms.startNotice('art',place,{kind:'start-failed',seq:1,attempt:3});
 expect((await read()).messages.find(m=>m.seq===2)?.text).toBe("Art couldn't start at first.");
 s.clock.advance(14*86400_000);
 expect((await read()).messages.find(m=>m.seq===2)).toMatchObject({text:null});
 expect((await read()).messages.find(m=>m.seq===2)).not.toHaveProperty('step');
});
it('refreshes a subscribed retry line when the body starts',async()=>{
 const s=await setup();const place=await s.open();await s.comms.deliver('art',place,1);
 await s.comms.startNotice('art',place,{kind:'start-retry',seq:1,attempt:1,retryAt:'2026-11-12T00:01:00Z'});
 const ws=new WebSocket(s.app.url.replace('http:','ws:')+'/live',{headers:{'x-member':'jonathan','x-window':'yes'}});
 cleanup.push(()=>ws.terminate());await once(ws,'open');
 const initial=once(ws,'message');ws.send(JSON.stringify({kind:'subscribe',type:'message',scope:place}));
 expect(JSON.stringify(JSON.parse((await initial)[0].toString()))).toContain("Art couldn't start; retrying.");
 const update=once(ws,'message');s.comms.status('art',place,'working');
 expect(JSON.stringify(JSON.parse((await update)[0].toString()))).toContain("Art couldn't start at first.");
});
it('settles a page retry line if progress arrives while a later row decrypts',async()=>{
 let pause=false,release:()=>void=()=>{},started:()=>void=()=>{};
 const waiting=new Promise<void>(r=>{release=r;}),began=new Promise<void>(r=>{started=r;});
 const s=await setup({key:k=>({...k,open:async blob=>{
  const words=await k.open(blob);
  if(pause&&words.includes('later private ask')){started();await waiting;}
  return words;
 }})});
 const place=await s.open();await s.comms.deliver('art',place,1);
 await s.comms.startNotice('art',place,{kind:'start-retry',seq:1,attempt:1,retryAt:'2026-11-12T00:01:00Z'});
 await s.comms.post('art',place,{id:'ask',kind:'ask',text:'later private ask'});pause=true;
 const page=s.call('messages',{thread:place});await began;
 s.comms.status('art',place,'done');release();
 expect(JSON.stringify(await page)).toContain("Art couldn't start at first.");
});
it('keeps final start failures and a newer message retry distinct from prior progress',async()=>{
 const s=await setup();const place=await s.open();await s.comms.deliver('art',place,1);
 await s.comms.startNotice('art',place,{kind:'start-failed',seq:1,attempt:1});
 s.comms.status('art',place,'done');
 await s.call('send',{thread:place,id:'newmessageaaaaaa',text:'new request'});
 await s.comms.deliver('art',place,3);
 await s.comms.startNotice('art',place,{kind:'start-retry',seq:3,attempt:1,retryAt:'2026-11-12T00:01:00Z'});
 const page=await s.comms.reader({agent:'art',valid:()=>true}).read({thread:place});
 expect(page.messages.find(m=>m.seq===2)).toMatchObject({text:"Art couldn't start.",step:{error:'start-failed'}});
 expect(page.messages.find(m=>m.seq===4)).toMatchObject({text:"Art couldn't start; retrying."});
 expect(page.messages.find(m=>m.seq===4)?.step).not.toHaveProperty('settled');
});
for(const boundary of ['revoked','closed','archived','conversation','project','source','notice'] as const)it(`refuses changed start-notice snapshots during encryption (${boundary})`,async()=>{
 let pause=false,release:()=>void=()=>{},started:()=>void=()=>{};
 const waiting=new Promise<void>(r=>{release=r;}),began=new Promise<void>(r=>{started=r;});
 const s=await setup({key:k=>({...k,seal:async words=>{expect(s.app.db.inTransaction).toBe(false);if(pause){started();await waiting;}return k.seal(words);}})});
 const place=await s.open();await s.comms.deliver('art',place,1);
 await s.comms.startNotice('art',place,{kind:'start-retry',seq:1,attempt:1,retryAt:'2026-11-12T00:01:00Z'});
 pause=true;const result=s.comms.startNotice('art',place,{kind:'start-failed',seq:1,attempt:1});
 const rejected=expect(result).rejects.toThrow();await began;
 if(boundary==='revoked')s.setSharing({...s.getSharing(),members:{jonathan:{agents:[]}}});
 else if(boundary==='closed')await s.comms.close();
 else if(boundary==='archived')await s.call('change',{thread:place,action:'archive'});
 else if(boundary==='source'||boundary==='notice')s.app.db.prepare('UPDATE comms_messages SET hash=? WHERE thread=? AND seq=?').run('replacement',place,boundary==='source'?1:2);
 else s.app.db.prepare(`UPDATE comms_threads SET record=json_set(record,'$.${boundary}',?) WHERE id=?`).run('replacement',place);
 const before=JSON.stringify(s.app.db.prepare('SELECT * FROM comms_messages').all());
 const threads=JSON.stringify(s.app.db.prepare('SELECT * FROM comms_threads').all());
 release();await rejected;
 expect(JSON.stringify(s.app.db.prepare('SELECT * FROM comms_messages').all())).toBe(before);
 expect(JSON.stringify(s.app.db.prepare('SELECT * FROM comms_threads').all())).toBe(threads);
});
it('rechecks access even for a duplicate start notice after decrypting the prior attempt',async()=>{
 let pause=false,release:()=>void=()=>{},started:()=>void=()=>{};
 const waiting=new Promise<void>(r=>{release=r;}),began=new Promise<void>(r=>{started=r;});
 const s=await setup({key:k=>({...k,open:async words=>{expect(s.app.db.inTransaction).toBe(false);if(pause){started();await waiting;}return k.open(words);}})});
 const place=await s.open();await s.comms.deliver('art',place,1);
 const notice={kind:'start-retry' as const,seq:1,attempt:1,retryAt:'2026-11-12T00:01:00Z'};
 await s.comms.startNotice('art',place,notice);pause=true;
 const result=s.comms.startNotice('art',place,notice),rejected=expect(result).rejects.toThrow();await began;
 s.setSharing({...s.getSharing(),members:{jonathan:{agents:[]}}});release();await rejected;
});
it('suppresses a start notice if the body starts during encryption, including after restart',async()=>{
 let pause=false,release:()=>void=()=>{},started:()=>void=()=>{};
 const waiting=new Promise<void>(r=>{release=r;}),began=new Promise<void>(r=>{started=r;});
 const s=await setup({key:k=>({...k,seal:async words=>{if(pause){started();await waiting;}return k.seal(words);}})});
 const place=await s.open();await s.comms.deliver('art',place,1);pause=true;
 const result=s.comms.startNotice('art',place,{kind:'start-failed',seq:1,attempt:1});await began;
 s.comms.status('art',place,'working');s.comms.status('art',place,'done');release();
 expect(await result).toEqual({seq:null});await s.restart();
 expect(await s.comms.startNotice('art',place,{kind:'start-failed',seq:1,attempt:1})).toEqual({seq:null});
 expect(s.app.db.prepare('SELECT count(*) AS n FROM comms_messages').get()).toEqual({n:1});
});
it('validates start notices before crypto and never revives expired notices',async()=>{
 let seals=0;const s=await setup({key:k=>({...k,seal:async words=>{seals++;return k.seal(words);}})});
 const place=await s.open();await s.comms.deliver('art',place,1);const before=seals;
 const valid={kind:'start-failed',seq:1,attempt:1};
 for(const input of [{...valid,seq:0},{...valid,attempt:0},{...valid,attempt:1.5},{...valid,attempt:1001},
  {...valid,retryAt:'2026-11-12T00:01:00Z'},{...valid,reason:'bad\nline'},{...valid,run:'bad run'},
  {...valid,text:'private extra'},{kind:'start-retry',seq:1,attempt:1},{kind:'start-retry',seq:1,attempt:1,retryAt:'tomorrow'}])
  await expect(s.comms.startNotice('art',place,input as never)).rejects.toThrow();
 await expect(s.comms.startNotice('pond-bot',place,valid as never)).rejects.toThrow();
 await expect(s.comms.startNotice('art',place,{...valid,seq:99} as never)).rejects.toThrow();
 expect(seals).toBe(before);
 await s.comms.startNotice('art',place,{kind:'start-retry',seq:1,attempt:1,retryAt:'2026-11-12T00:01:00Z'});
 const saved=JSON.stringify(s.app.db.prepare('SELECT * FROM comms_messages').all());
 s.app.db.exec("CREATE TRIGGER refuse_start BEFORE UPDATE ON comms_threads BEGIN SELECT RAISE(ABORT, 'refused'); END");
 await expect(s.comms.startNotice('art',place,{kind:'start-failed',seq:1,attempt:1})).rejects.toThrow();
 expect(JSON.stringify(s.app.db.prepare('SELECT * FROM comms_messages').all())).toBe(saved);
 s.app.db.exec('DROP TRIGGER refuse_start');s.clock.advance(14*86400_000);
 await expect(s.comms.startNotice('art',place,{kind:'start-failed',seq:1,attempt:1})).rejects.toThrow();
 expect(s.app.db.prepare('SELECT words FROM comms_messages').all()).toEqual([{words:null},{words:null}]);
});
for(const kind of ['no-reply','loop'] as const)it(`records an encrypted terminal notice once without stopping a later turn (${kind})`,async()=>{
 const s=await setup();const place=await s.open();await s.comms.deliver('art',place,1);
 s.comms.status('art',place,'working');s.comms.activity('art',place,{at:s.clock.now(),tokens:25});
 const notice={kind,id:'run-terminal'};
 const first=await s.comms.notice('art',place,notice);
 expect(first).toEqual({seq:2});
 const stored=JSON.stringify(s.app.db.prepare('SELECT * FROM comms_messages WHERE seq=2').get());
 expect(stored).not.toContain('finished without replying');expect(stored).not.toContain('was repeating itself');
 const page=await s.call('messages',{thread:place});
 expect(JSON.stringify(page)).toContain(kind==='no-reply'?'Art finished without replying.':'Paused: Art was repeating itself.');
 const row=()=>JSON.parse((s.app.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(place) as {record:string}).record);
 expect(row()).toMatchObject({working:false,workingSince:null,workingBeat:null});
 s.clock.advance(1000);s.comms.status('art',place,'working');
 const before=JSON.stringify(row());
 expect(await s.comms.notice('art',place,notice)).toEqual(first);
 expect(JSON.stringify(row())).toBe(before);
 await s.restart();expect(await s.comms.notice('art',place,notice)).toEqual(first);
 expect(s.app.db.prepare('SELECT count(*) AS n FROM comms_messages').get()).toEqual({n:2});
 expect(()=>s.comms.trace('art',place)).not.toThrow();
});
for(const boundary of ['revoked','closed','conversation','archived'] as const)it(`rejects a terminal notice changed during encryption (${boundary})`,async()=>{
 let pause=false,release:()=>void=()=>{},started:()=>void=()=>{};
 const waiting=new Promise<void>(r=>{release=r;}),began=new Promise<void>(r=>{started=r;});
 const s=await setup({key:k=>({...k,seal:async words=>{if(pause){started();await waiting;}return k.seal(words);}})});
 const place=await s.open();await s.comms.deliver('art',place,1);s.comms.status('art',place,'working');pause=true;
 const result=s.comms.notice('art',place,{kind:'no-reply',id:'run-terminal'});const rejected=expect(result).rejects.toThrow();await began;
 if(boundary==='revoked')s.setSharing({...s.getSharing(),members:{jonathan:{agents:[]}}});
 else if(boundary==='closed')await s.comms.close();
 else if(boundary==='archived')await s.call('change',{thread:place,action:'archive'});
 else s.app.db.prepare("UPDATE comms_threads SET record=json_set(record,'$.conversation','replacement') WHERE id=?").run(place);
 const before=JSON.stringify(s.app.db.prepare('SELECT * FROM comms_threads').all());
 release();await rejected;
 expect(JSON.stringify(s.app.db.prepare('SELECT * FROM comms_threads').all())).toBe(before);
 expect(s.app.db.prepare('SELECT count(*) AS n FROM comms_messages').get()).toEqual({n:1});
});
it('validates and isolates terminal notices before encryption and rolls back turn settlement with a failed append',async()=>{
 let seals=0;const s=await setup({key:k=>({...k,seal:async words=>{seals++;return k.seal(words);}})});
 const place=await s.open();await s.comms.deliver('art',place,1);s.comms.status('art',place,'working');const before=seals;
 for(const input of [{kind:'unknown',id:'run'}, {kind:'loop',id:'bad id'}, {kind:'loop',id:'run',text:'private'}])
  expect(()=>s.comms.notice('art',place,input as never)).toThrow();
 await expect(s.comms.notice('pond-bot',place,{kind:'loop',id:'run'})).rejects.toThrow();
 expect(seals).toBe(before);
 s.app.db.exec("CREATE TRIGGER refuse_notice BEFORE UPDATE ON comms_threads BEGIN SELECT RAISE(ABORT, 'refused'); END");
 await expect(s.comms.notice('art',place,{kind:'loop',id:'run'})).rejects.toThrow();
 expect(s.app.db.prepare('SELECT count(*) AS n FROM comms_messages').get()).toEqual({n:1});
 expect(JSON.parse((s.app.db.prepare('SELECT record FROM comms_threads').get() as {record:string}).record).working).toBe(true);
 s.app.db.exec('DROP TRIGGER refuse_notice');
 await s.comms.notice('art',place,{kind:'loop',id:'run'});
 s.clock.advance(14*86400_000);
 expect(JSON.stringify(await s.call('messages',{thread:place}))).not.toContain('was repeating itself');
 expect(await s.comms.notice('art',place,{kind:'loop',id:'run'})).toEqual({seq:2});
 expect((s.app.db.prepare('SELECT words FROM comms_messages WHERE seq=2').get() as {words:unknown}).words).toBeNull();
});
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
for(const expired of [false,true])it(`settles an ineligible held send as failed instead of leaving it held (expired=${expired})`,async()=>{
 const s=await setup({hold:stagingHold({beforeOutside:()=>false,finish:()=>{}}),days:1});
 const place=await s.open();await s.comms.deliver('art',place,1);
 const delivery=()=>JSON.parse((s.app.db.prepare('SELECT record FROM comms_messages WHERE thread=? AND seq=1').get(place) as {record:string}).record).delivery;
 expect(delivery()).toBe('held');
 if(expired)s.clock.advance(86400_000);else await s.call('change',{thread:place,action:'archive'});
 await s.comms.deliver('art',place,1);
 expect(delivery()).toBe('failed');expect(s.deliveries).toEqual([]);
});
it('keeps a completed delivery receipt after archiving and retention expiry',async()=>{
 const s=await setup({days:1});const place=await s.open();await s.comms.deliver('art',place,1);
 await s.call('change',{thread:place,action:'archive'});s.clock.advance(86400_000);await s.comms.deliver('art',place,1);
 expect(JSON.parse((s.app.db.prepare('SELECT record FROM comms_messages WHERE thread=? AND seq=1').get(place) as {record:string}).record).delivery).toBe('delivered');
 expect(s.deliveries).toHaveLength(1);
});
it('does not acknowledge a send archived while waiting at the staging gate, and can retry after reopening',async()=>{
 let resume:()=>void=()=>{},started:()=>void=()=>{};
 const waiting=new Promise<void>(r=>{resume=r;}),began=new Promise<void>(r=>{started=r;});
 let first=true;
 const s=await setup({hold:async(run,facts)=>{if(first&&facts?.title==='Deliver a Comms message'){first=false;started();await waiting;}return run();}});
 const place=await s.open();await began;
 await s.call('change',{thread:place,action:'archive'});resume();await s.comms.deliver('art',place,1);
 expect(s.deliveries).toEqual([]);
 const delivery=()=>JSON.parse((s.app.db.prepare('SELECT record FROM comms_messages WHERE thread=? AND seq=1').get(place) as {record:string}).record).delivery;
 expect(delivery()).toBe('failed');
 await s.call('change',{thread:place,action:'unarchive'});await s.comms.deliver('art',place,1);
 expect(s.deliveries).toHaveLength(1);expect(delivery()).toBe('delivered');
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
for(const boundary of ['decryption','staging'] as const)for(const change of ['member','conversation','project','words','kind','receipt'] as const)it(`refuses a replaced delivery snapshot during ${boundary} (${change})`,async()=>{
 let resume:()=>void=()=>{},started:()=>void=()=>{};
 const wait=new Promise<void>(r=>{resume=r;}),begin=new Promise<void>(r=>{started=r;});
 const pause=async()=>{started();await wait;};
 const s=await setup(boundary==='decryption'
  ?{key:key=>({...key,open:async blob=>{await pause();return key.open(blob);}})}
  :{hold:async run=>{await pause();return run();}});
 const place=await s.open();await begin;expect(s.app.db.inTransaction).toBe(false);
 const routing=change==='member'||change==='conversation'||change==='project';
 if(routing)s.app.db.prepare(`UPDATE comms_threads SET record=json_set(record,'$.${change}',?) WHERE id=?`).run(change==='member'?'other':'replacement',place);
 else if(change==='words')s.app.db.prepare('UPDATE comms_messages SET words=? WHERE thread=? AND seq=1').run(Buffer.from('replacement ciphertext'),place);
 else if(change==='kind')s.app.db.prepare("UPDATE comms_messages SET kind='reply' WHERE thread=? AND seq=1").run(place);
 else s.app.db.prepare("UPDATE comms_messages SET record=json_set(record,'$.delivery','delivered') WHERE thread=? AND seq=1").run(place);
 const before=JSON.stringify(s.app.db.prepare('SELECT * FROM comms_messages').all());
 resume();await s.comms.deliver('art',place,1);
 expect(s.deliveries).toEqual([]);
 if(routing)expect(JSON.parse((s.app.db.prepare('SELECT record FROM comms_messages WHERE thread=? AND seq=1').get(place) as {record:string}).record).delivery).toBe('failed');
 else expect(JSON.stringify(s.app.db.prepare('SELECT * FROM comms_messages').all())).toBe(before);
});
for(const boundary of ['decryption','staging'] as const)it(`allows unrelated thread changes during delivery ${boundary}`,async()=>{
 let resume:()=>void=()=>{},started:()=>void=()=>{};
 const wait=new Promise<void>(r=>{resume=r;}),begin=new Promise<void>(r=>{started=r;});
 const pause=async()=>{started();await wait;};
 const s=await setup(boundary==='decryption'
  ?{key:key=>({...key,open:async blob=>{await pause();return key.open(blob);}})}
  :{hold:async run=>{await pause();return run();}});
 const place=await s.open();await begin;
 await s.call('change',{thread:place,action:'title',title:'Renamed while sending'});
 await s.call('change',{thread:place,action:'read',seq:1});
 resume();await s.comms.deliver('art',place,1);
 expect(s.deliveries).toEqual([expect.objectContaining({member:'jonathan',conversation:expect.any(String),project:'pond',text:'secret member words'})]);
});
for(const outcome of ['accepted','failed'] as const)it(`does not settle a replacement row after runtime ${outcome}`,async()=>{
 let resume:()=>void=()=>{},started:()=>void=()=>{};
 const wait=new Promise<void>(r=>{resume=r;}),begin=new Promise<void>(r=>{started=r;});
 const s=await setup({deliver:async()=>{started();await wait;if(outcome==='failed')throw new Error('uncertain runtime failure');}});
 const place=await s.open();await begin;
 s.app.db.prepare("UPDATE comms_messages SET record=json_set(record,'$.delivery','held') WHERE thread=? AND seq=1").run(place);
 const before=JSON.stringify(s.app.db.prepare('SELECT * FROM comms_messages').all());
 resume();await s.comms.deliver('art',place,1);
 expect(JSON.stringify(s.app.db.prepare('SELECT * FROM comms_messages').all())).toBe(before);
});
it('a foreign delivery attempt leaves the original held receipt unchanged',async()=>{
 const s=await setup({hold:stagingHold({beforeOutside:()=>false,finish:()=>{}})});
 const place=await s.open();await s.comms.deliver('art',place,1);
 const before=JSON.stringify(s.app.db.prepare('SELECT * FROM comms_messages').all());
 await s.comms.deliver('pond-bot',place,1);
 expect(s.deliveries).toEqual([]);
 expect(JSON.stringify(s.app.db.prepare('SELECT * FROM comms_messages').all())).toBe(before);
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
it('binds runtime readers to trusted agent and house conversations with bounded read-only pages',async()=>{
 const s=await setup();const place=await s.open();const other=await s.open();
 const saved=JSON.parse((s.app.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(place) as {record:string}).record);
 const cv='cv-spawn-fixture';saved.conversation=cv;s.app.db.prepare('UPDATE comms_threads SET record=? WHERE id=?').run(JSON.stringify(saved),place);
 const reader=s.comms.reader({agent:'art',conversation:cv,houseConversations:[cv],valid:()=>true});
 await s.comms.post('art',place,{id:'r1',kind:'reply',text:'first'});
 await s.comms.post('art',place,{id:'r2',kind:'reply',text:'second'});
 expect((await reader.read({limit:2})).messages.map(m=>m.text)).toEqual(['first','second']);
 expect((await reader.read({before:3,limit:1})).messages.map(m=>m.text)).toEqual(['first']);
 await expect(reader.read({thread:other})).rejects.toMatchObject({code:'denied'});
 for(const binding of [{agent:'pond-bot',valid:()=>true},{agent:'art',houseConversations:[],valid:()=>true},{agent:'art',valid:()=>false}])await expect(s.comms.reader(binding).read({thread:place})).rejects.toMatchObject({code:'denied'});
 expect((await s.comms.reader({agent:'art',valid:()=>true}).read({thread:other})).messages).toHaveLength(1);
 s.clock.advance(14*86400_000);
 expect((await reader.read()).messages.every(m=>m.text===null)).toBe(true);
 await s.call('change',{thread:place,action:'delete'});
 await expect(reader.read()).rejects.toMatchObject({code:'denied'});
});
it('revokes a bound runtime read while decryption is suspended',async()=>{
 let pause=false;let resume:()=>void=()=>{};let started:()=>void=()=>{};
 const began=new Promise<void>(r=>{started=r;});const waiting=new Promise<void>(r=>{resume=r;});
 const s=await setup({key:k=>({...k,open:async words=>{if(pause){started();await waiting;}return k.open(words);}})});
 const place=await s.open();await s.comms.deliver('art',place,1);
 let valid=true;const binding={agent:'art',valid:()=>valid,houseConversations:undefined as string[]|undefined};
 const reader=s.comms.reader(binding);binding.agent='pond-bot';pause=true;
 const read=reader.read({thread:place});await began;valid=false;resume();
 await expect(read).rejects.toMatchObject({code:'denied'});
});
it('gives each archive lifecycle a distinct end effect while duplicate archives share one',async()=>{
 const accepted=new Set<string>();const attempts:string[]=[];
 const s=await setup({hold:stagingHold({beforeOutside:f=>{if(f.title==='End a Comms body'){attempts.push(f.id);if(accepted.has(f.id))return false;accepted.add(f.id);}return true;},finish:()=>{}})});
 const place=await s.open();await s.comms.deliver('art',place,1);
 await s.call('change',{thread:place,action:'archive'});
 await s.call('change',{thread:place,action:'archive'});
 expect(s.ends).toHaveLength(1);
 await s.call('change',{thread:place,action:'unarchive'});
 await s.call('change',{thread:place,action:'archive'});
 expect(s.ends).toHaveLength(2);
 expect(new Set(attempts).size).toBe(2);
 await s.call('change',{thread:place,action:'delete'});expect(s.ends).toHaveLength(3);
});
for(const archiveAgain of [false,true])it(`a delayed archive end cannot stop a reopened thread (rearchive=${archiveAgain})`,async()=>{
 let release:()=>void=()=>{},started:()=>void=()=>{},finished:()=>void=()=>{};
 const wait=new Promise<void>(r=>{release=r;}),begin=new Promise<void>(r=>{started=r;}),done=new Promise<void>(r=>{finished=r;});
 let first=true;const s=await setup({hold:async(run,facts)=>{if(facts?.title==='End a Comms body'&&first){first=false;started();await wait;try{return await run();}finally{finished();}}return run();}});
 const place=await s.open();await s.comms.deliver('art',place,1);
 await s.call('change',{thread:place,action:'archive'});await begin;
 await s.call('change',{thread:place,action:'unarchive'});if(archiveAgain)await s.call('change',{thread:place,action:'archive'});release();await done;
 expect(s.ends).toHaveLength(archiveAgain?1:0);
});
for(const action of ['archive','delete'] as const)it(`rolls back the ${action} end journal with a failed thread write`,async()=>{
 const s=await setup();const place=await s.open();await s.comms.deliver('art',place,1);
 s.app.db.exec(`CREATE TRIGGER reject_change BEFORE ${action==='delete'?'DELETE':'UPDATE'} ON comms_threads BEGIN SELECT RAISE(ABORT,'write failed'); END`);
 expect(await s.call('change',{thread:place,action})).toMatchObject({ok:false,code:'unavailable'});
 expect(s.comms.trace('art',place).archived).toBe(null);
 expect(s.app.db.prepare("SELECT * FROM comms_meta WHERE key LIKE 'pending-end:%'").all()).toEqual([]);
 expect(s.app.db.prepare('SELECT * FROM comms_deleted').all()).toEqual([]);expect(s.ends).toEqual([]);
});
for(const action of ['archive','delete'] as const)it(`recovers a staged ${action} end after restart without repeating completed ends`,async()=>{
 let released=false;const attempts:string[]=[];
 const s=await setup({hold:stagingHold({beforeOutside:f=>{if(f.title==='End a Comms body')attempts.push(f.id);return released;},finish:()=>{}})});
 const place=await s.open();await s.comms.deliver('art',place,1);
 await s.call('change',{thread:place,action});await s.comms.close();
 expect(s.ends).toEqual([]);
 released=true;await s.restart();await s.comms.close();
 expect(s.ends).toHaveLength(1);expect(new Set(attempts).size).toBe(1);
 await s.restart();await s.comms.close();expect(s.ends).toHaveLength(1);
 expect(JSON.stringify(s.app.db.prepare('SELECT * FROM comms_meta').all())).not.toContain('secret member words');
});
it('retries held and failed ends explicitly after release, coalescing concurrent recovery calls',async()=>{
 let released=false,fail=true;const attempts:string[]=[];
 const s=await setup({hold:stagingHold({beforeOutside:f=>{if(f.title==='End a Comms body')attempts.push(f.id);return released;},finish:()=>{}}),end:async()=>{if(fail)throw new Error('uncertain runtime');}});
 const place=await s.open();await s.comms.deliver('art',place,1);
 await s.call('change',{thread:place,action:'delete'});
 await s.comms.reconcileEnds();expect(s.ends).toEqual([]);
 released=true;await s.comms.reconcileEnds();expect(s.ends).toEqual([]);
 expect(s.app.db.prepare("SELECT * FROM comms_meta WHERE key LIKE 'pending-end:%'").all()).toHaveLength(1);
 fail=false;await Promise.all([s.comms.reconcileEnds(),s.comms.reconcileEnds()]);
 expect(s.ends).toHaveLength(1);expect(new Set(attempts).size).toBe(1);
 expect(s.app.db.prepare("SELECT * FROM comms_meta WHERE key LIKE 'pending-end:%'").all()).toEqual([]);
 await s.comms.reconcileEnds();expect(s.ends).toHaveLength(1);
});
for(const rearchive of [false,true])it(`restart discards an obsolete archive end and preserves a new lifecycle (rearchive=${rearchive})`,async()=>{
 let released=false;const attempts:string[]=[];
 const s=await setup({hold:stagingHold({beforeOutside:f=>{if(f.title==='End a Comms body')attempts.push(f.id);return released;},finish:()=>{}})});
 const place=await s.open();await s.comms.deliver('art',place,1);
 await s.call('change',{thread:place,action:'archive'});
 await s.call('change',{thread:place,action:'unarchive'});
 if(rearchive)await s.call('change',{thread:place,action:'archive'});
 await s.comms.close();released=true;await s.restart();await s.comms.close();
 expect(s.ends).toHaveLength(rearchive?1:0);
 if(rearchive)expect(attempts.at(-1)).toBe(`comms-end:${place}:2`);
 expect(s.app.db.prepare("SELECT * FROM comms_meta WHERE key LIKE 'pending-end:%'").all()).toEqual([]);
});
it('completion of an old end does not remove a newer staged end job',async()=>{
 let began:()=>void=()=>{},release:()=>void=()=>{},first=true,allow=true;
 const started=new Promise<void>(r=>{began=r;}),waiting=new Promise<void>(r=>{release=r;});
 const s=await setup({hold:stagingHold({beforeOutside:()=>allow,finish:()=>{}}),end:async()=>{if(first){first=false;began();await waiting;}}});
 const place=await s.open();await s.comms.deliver('art',place,1);
 await s.call('change',{thread:place,action:'archive'});await started;
 await s.call('change',{thread:place,action:'unarchive'});allow=false;
 await s.call('change',{thread:place,action:'delete'});
 release();await s.comms.reconcileEnds();
 // Drain the first lifecycle before checking that its completion retained generation two.
 await s.comms.close();
 const rows=s.app.db.prepare("SELECT value FROM comms_meta WHERE key LIKE 'pending-end:%'").all() as {value:string}[];
 expect(rows).toHaveLength(1);expect(JSON.parse(rows[0].value)).toMatchObject({action:'delete',generation:2});
 allow=true;await s.restart();await s.comms.close();expect(s.ends).toHaveLength(2);
});
it('removes expired words and work fields when a later page row finishes decrypting after the deadline',async()=>{
 let reading=false,release:()=>void=()=>{},started:()=>void=()=>{},firstDone:()=>void=()=>{};
 const waiting=new Promise<void>(r=>{release=r;}),began=new Promise<void>(r=>{started=r;}),decoded=new Promise<void>(r=>{firstDone=r;});
 const s=await setup({key:k=>({...k,open:async blob=>{
  const words=await k.open(blob);
  if(reading&&words.includes('earlier private'))firstDone();
  if(reading&&words.includes('later private')){await decoded;started();await waiting;}
  return words;
 }})});
 const place=await s.open();await s.comms.deliver('art',place,1);
 await s.comms.post('art',place,{id:'earlier',kind:'card',text:'earlier private',tool:'private tool',step:{body:'private output'}});
 s.clock.advance(1000);
 await s.comms.post('art',place,{id:'later',kind:'reply',text:'later private'});
 s.clock.advance(14*86400_000-1001);
 reading=true;const page=s.call('messages',{thread:place});await began;
 // Wall time can cross a deadline before the timer callback gets its turn.
 const now=s.clock.now();s.clock.now=()=>now+1;
 release();const result=await page;
 expect(result.ok).toBe(true);
 expect(JSON.stringify(result)).not.toContain('earlier private');
 expect(JSON.stringify(result)).not.toContain('private tool');
 expect(JSON.stringify(result)).not.toContain('private output');
 expect(JSON.stringify(result)).toContain('later private');
});
it('refuses an ask that expires while answer encryption waits, before calling attention',async()=>{
 let pause=false,release:()=>void=()=>{},started:()=>void=()=>{};let answers=0;
 const waiting=new Promise<void>(r=>{release=r;}),began=new Promise<void>(r=>{started=r;});
 const s=await setup({key:k=>({...k,seal:async words=>{if(pause){started();await waiting;}return k.seal(words);}}),attention:{answer:()=>{answers++;return {ok:true,value:{}};}}});
 const place=await s.open();await s.comms.deliver('art',place,1);
 await s.comms.post('art',place,{id:'ask',kind:'ask',ref:'attention',text:'private question'});
 s.clock.advance(14*86400_000-1);pause=true;
 const answer=s.call('answer',{thread:place,ref:'attention',verdict:'yes'});await began;
 const now=s.clock.now();s.clock.now=()=>now+1;release();
 expect(await answer).toMatchObject({ok:false,code:'denied'});
 expect(answers).toBe(0);
 expect(s.app.db.prepare("SELECT * FROM comms_messages WHERE kind='answer'").all()).toEqual([]);
});
for(const change of ['agent','conversation','project','ask-words','ask-record','ask-delete','closed'] as const)it(`refuses an answer snapshot replaced during encryption (${change})`,async()=>{
 let pause=false,release:()=>void=()=>{},started:()=>void=()=>{};let answers=0;
 const waiting=new Promise<void>(r=>{release=r;}),began=new Promise<void>(r=>{started=r;});
 const s=await setup({key:k=>({...k,seal:async words=>{if(pause){started();await waiting;}return k.seal(words);}}),attention:{answer:()=>{answers++;return {ok:true,value:{}};}}});
 const place=await s.open();await s.comms.deliver('art',place,1);
 await s.comms.post('art',place,{id:'ask',kind:'ask',ref:'attention',text:'original private question'});
 // Both agents are owned, so a generic permission recheck cannot bind the answer.
 s.getSharing().members.jonathan.agents.push('other-agent');
 pause=true;const answer=s.call('answer',{thread:place,ref:'attention',verdict:'yes'});await began;
 if(change==='closed')await s.comms.close();
 else if(change==='ask-delete')s.app.db.prepare("DELETE FROM comms_messages WHERE kind='ask'").run();
 else if(change==='ask-words')s.app.db.prepare("UPDATE comms_messages SET words=? WHERE kind='ask'").run(Buffer.from('replacement question'));
 else if(change==='ask-record')s.app.db.prepare("UPDATE comms_messages SET record=json_set(record,'$.seen',1) WHERE kind='ask'").run();
 else s.app.db.prepare(`UPDATE comms_threads SET record=json_set(record,'$.${change}',?) WHERE id=?`).run(change==='agent'?'other-agent':'replacement',place);
 const before=JSON.stringify(s.app.db.prepare('SELECT * FROM comms_messages').all());
 release();expect(await answer).toMatchObject({ok:false,code:'denied'});
 expect(answers).toBe(0);
 expect(JSON.stringify(s.app.db.prepare('SELECT * FROM comms_messages').all())).toBe(before);
});
it('allows unrelated thread title and read changes while encrypting an answer',async()=>{
 let pause=false,release:()=>void=()=>{},started:()=>void=()=>{};let answers=0;
 const waiting=new Promise<void>(r=>{release=r;}),began=new Promise<void>(r=>{started=r;});
 const s=await setup({key:k=>({...k,seal:async words=>{if(pause){started();await waiting;}return k.seal(words);}}),attention:{answer:()=>{answers++;return {ok:true,value:{}};}}});
 const place=await s.open();await s.comms.deliver('art',place,1);
 await s.comms.post('art',place,{id:'ask',kind:'ask',ref:'attention',text:'private question'});
 pause=true;const answer=s.call('answer',{thread:place,ref:'attention',verdict:'yes'});await began;
 await s.call('change',{thread:place,action:'title',title:'A new title'});
 await s.call('change',{thread:place,action:'read',seq:2});
 release();expect((await answer).ok).toBe(true);expect(answers).toBe(1);
});
it('summarizes only owned open threads, counting unread threads and folding the first unread line',async()=>{
 const s=await setup();const first=await s.open();
 await s.comms.post('art',first,{id:'r1',kind:'reply',text:'  first\n unread  '});
 await s.comms.post('art',first,{id:'r2',kind:'reply',text:'second'});
 s.clock.advance(1);const latest=await s.open();
 const emoji='👩🏽‍💻';await s.comms.post('art',latest,{id:'r3',kind:'reply',text:emoji.repeat(161)});
 const other=await s.call('open',{agent:'art',id:'otheraaaaaaaaaaa',text:'other words'},{kind:'member',id:'other'});
 expect(other.ok).toBe(true);
 await s.comms.post('art',(other as {ok:true;value:{thread:string}}).value.thread,{id:'private',kind:'reply',text:'other private reply'});
 expect(await s.call('agents',{})).toMatchObject({ok:true,value:{agents:['art'],summaries:[{agent:'art',unread:2,last:{thread:latest},first:{thread:latest,text:emoji.repeat(159)+'…'}}]}});
 await s.call('change',{thread:latest,action:'archive'});
 expect(await s.call('agents',{})).toMatchObject({ok:true,value:{summaries:[{unread:1,last:{thread:first},first:{thread:first,text:'first unread'}}]}});
 await s.call('change',{thread:first,action:'read',seq:3});
 const result=await s.call('agents',{});expect(result).toMatchObject({ok:true,value:{summaries:[{unread:0}]}});expect(JSON.stringify(result)).not.toContain('other private');expect(JSON.stringify(result)).not.toContain('first unread');
 expect(await s.call('agents',{},member,false)).toMatchObject({code:'denied'});
 expect(JSON.stringify(s.app.db.prepare('SELECT * FROM core_operations').all())).not.toContain(emoji);
});
for(const change of ['ownership','read','delete','reply'] as const)it(`refuses a stale agent summary after ${change} changes during decryption`,async()=>{
 let pause=false,resume:()=>void=()=>{},started:()=>void=()=>{};
 const wait=new Promise<void>(r=>{resume=r;}),begin=new Promise<void>(r=>{started=r;});
 const s=await setup({key:key=>({...key,open:async blob=>{if(pause){started();await wait;}return key.open(blob);}})});
 const place=await s.open();await s.comms.deliver('art',place,1);await s.comms.post('art',place,{id:'r',kind:'reply',text:'revoked summary'});
 pause=true;const reading=s.call('agents',{});await begin;
 if(change==='ownership'){const sharing=s.getSharing();sharing.members.jonathan.agents=[];s.setSharing(sharing);}
 else if(change==='reply')await s.comms.post('art',place,{id:'new',kind:'reply',text:'new reply'});
 else await s.call('change',{thread:place,action:change,seq:2});
 resume();
 expect(await reading).toMatchObject({code:'conflict'});
 if(change==='ownership')expect(await s.call('agents',{})).toMatchObject({ok:true,value:{agents:[],summaries:[]}});
});
it('strips the first unread summary line if retention expires while crypto is suspended',async()=>{
 let pause=false,resume:()=>void=()=>{},started:()=>void=()=>{};
 const wait=new Promise<void>(r=>{resume=r;}),begin=new Promise<void>(r=>{started=r;});
 const s=await setup({key:key=>({...key,open:async blob=>{const text=await key.open(blob);if(pause){started();await wait;}return text;}})});
 const place=await s.open();await s.comms.deliver('art',place,1);await s.comms.post('art',place,{id:'r',kind:'reply',text:'expired summary'});
 pause=true;const reading=s.call('agents',{});await begin;
 // Advance the read clock without firing the sweep: enforce the deadline at return.
 const now=s.clock.now()+14*86400_000;s.clock.now=()=>now;resume();
 expect(await reading).toMatchObject({ok:true,value:{summaries:[{unread:1,first:{thread:place,text:null}}]}});
});

it('traces only the newest hundred delivery facts without decrypting words or work metadata',async()=>{
 let opens=0;
 const s=await setup({key:key=>({...key,open:async words=>{opens++;return key.open(words);}})});
 const place=await s.open();await s.comms.deliver('art',place,1);
 for(let n=0;n<102;n++)await s.comms.post('art',place,{id:`trace-${n}`,kind:'card',text:'private trace text',run:'private run',tool:'private tool',step:{body:'private output'}});
 const before=opens;
 const trace=s.comms.trace('art',place);
 expect(trace.messages).toHaveLength(100);
 expect(trace.messages.map(m=>m.seq)).toEqual(Array.from({length:100},(_,n)=>n+4));
 expect(trace.messages[0]).toEqual({seq:4,at:s.clock.now(),kind:'card',from:'art'});
 expect(JSON.stringify(trace)).not.toContain('private');
 expect(opens).toBe(before);
 expect(()=>s.comms.trace('other-agent',place)).toThrow('Thread unavailable');
 expect(()=>s.comms.trace('art','missing')).toThrow('Thread unavailable');
 await s.call('change',{thread:place,action:'archive'});
 expect(s.comms.trace('art',place).archived).toBe(s.clock.now());
 await s.call('change',{thread:place,action:'delete'});
 expect(()=>s.comms.trace('art',place)).toThrow('Thread unavailable');
});
it('traces fixed delivery states without returning arbitrary record payloads',async()=>{
 const s=await setup();const place=await s.open();await s.comms.deliver('art',place,1);
 expect(s.comms.trace('art',place).messages[0].delivery).toBe('delivered');
 for(const delivery of ['sending','held','failed']) {
  s.app.db.prepare('UPDATE comms_messages SET record=? WHERE thread=?').run(JSON.stringify({delivery,reason:'private reason'}),place);
  expect(s.comms.trace('art',place).messages[0]).toEqual({seq:1,at:s.clock.now(),kind:'message',from:'jonathan',delivery});
 }
 s.app.db.prepare('UPDATE comms_messages SET record=? WHERE thread=?').run(JSON.stringify({delivery:'private injected status'}),place);
 expect(s.comms.trace('art',place).messages[0]).not.toHaveProperty('delivery');
});

it('recovers staging-held deliveries after restart and never repeats completed receipts',async()=>{
 let released=false;
 const s=await setup({hold:stagingHold({beforeOutside:()=>released,finish:()=>{}})});
 const place=await s.open();await s.comms.deliver('art',place,1);
 expect(s.deliveries).toEqual([]);
 released=true;await s.restart();await s.comms.reconcileDeliveries();
 expect(s.deliveries).toHaveLength(1);
 await s.restart();await s.comms.reconcileDeliveries();expect(s.deliveries).toHaveLength(1);
});
it('coalesces held delivery recovery and leaves uncertain sending and failed receipts for runtime reconciliation',async()=>{
 let released=false;
 const s=await setup({hold:stagingHold({beforeOutside:()=>released,finish:()=>{}})});
 const place=await s.open();await s.comms.deliver('art',place,1);
 for(const state of ['sending','failed']) {
  s.app.db.prepare('UPDATE comms_messages SET record=? WHERE thread=?').run(JSON.stringify({delivery:state}),place);
  released=true;await s.restart();await s.comms.reconcileDeliveries();expect(s.deliveries).toEqual([]);
 }
 s.app.db.prepare('UPDATE comms_messages SET record=? WHERE thread=?').run(JSON.stringify({delivery:'held'}),place);
 await Promise.all([s.comms.reconcileDeliveries(),s.comms.reconcileDeliveries()]);
 expect(s.deliveries).toHaveLength(1);
});
for(const reason of ['archive','expiry','ownership'] as const)it(`settles stale sends during recovery without crypto (${reason})`,async()=>{
 let decrypts=0;
 const s=await setup({days:1,key:key=>({...key,open:async words=>{decrypts++;return key.open(words);}}),hold:stagingHold({beforeOutside:()=>false,finish:()=>{}})});
 const place=await s.open();await s.comms.deliver('art',place,1);
 if(reason==='archive')await s.call('change',{thread:place,action:'archive'});
 if(reason==='expiry')s.clock.advance(86400_000);
 if(reason==='ownership'){const sharing=s.getSharing();sharing.members.jonathan.agents=[];s.setSharing(sharing);}
 for(const delivery of ['held','sending','failed']) {
  s.app.db.prepare('UPDATE comms_messages SET record=? WHERE thread=?').run(JSON.stringify({delivery}),place);
  const before=decrypts;await s.restart();await s.comms.reconcileDeliveries();
  expect(decrypts).toBe(before);expect(s.deliveries).toEqual([]);
  expect(JSON.parse((s.app.db.prepare('SELECT record FROM comms_messages WHERE thread=?').get(place) as {record:string}).record).delivery).toBe('failed');
 }
});
it('recovers a persisted fresh send after pre-runtime staging failure without a receipt adapter',async()=>{
 let released=false;
 const s=await setup({hold:async f=>{if(!released)throw new Error('gate unavailable');return f();}});
 const place=await s.open();await s.comms.deliver('art',place,1);
 expect(s.deliveries).toHaveLength(0);
 expect(JSON.parse((s.app.db.prepare('SELECT record FROM comms_messages WHERE thread=?').get(place) as {record:string}).record)).toMatchObject({delivery:'failed',attempted:false});
 released=true;await s.restart();await s.comms.reconcileDeliveries();
 expect(s.deliveries).toHaveLength(1);
});
it('keeps uncertainty after a fenced retry fails before runtime',async()=>{
 let failOpen=false,lookups=0,attempts=0;
 const s=await setup({key:k=>({...k,open:async words=>{if(failOpen)throw new Error('crypto unavailable');return k.open(words);}}),
  receipt:async()=>{lookups++;return lookups===1?'not-accepted':'unknown';},deliver:async()=>{attempts++;throw new Error('uncertain');}});
 const place=await s.open();await s.comms.deliver('art',place,1);
 failOpen=true;await s.comms.deliver('art',place,1);failOpen=false;
 await s.comms.deliver('art',place,1);
 expect(lookups).toBe(2);expect(attempts).toBe(1);
 expect(JSON.parse((s.app.db.prepare('SELECT record FROM comms_messages WHERE thread=?').get(place) as {record:string}).record)).toMatchObject({delivery:'failed',attempted:true});
});
it('persists the runtime boundary before calling out and never downgrades a runtime failure to held',async()=>{
 let saved:unknown,attempts=0;
 const s=await setup({deliver:async d=>{attempts++;saved=JSON.parse((s.app.db.prepare('SELECT record FROM comms_messages WHERE thread=? AND seq=?').get(d.thread,d.seq) as {record:string}).record);throw new HeldEffect('runtime outcome uncertain');}});
 const place=await s.open();await s.comms.deliver('art',place,1);
 expect(saved).toMatchObject({delivery:'sending',attempted:true});
 expect(s.comms.trace('art',place).messages[0].delivery).toBe('failed');
 await s.restart();await s.comms.deliver('art',place,1);await s.comms.reconcileDeliveries();
 expect(attempts).toBe(1);
});
it('coalesces direct and operation retries throughout receipt lookup and runtime acceptance',async()=>{
 let released=false,lookups=0,attempts=0,resolveReceipt:(v:'not-accepted')=>void=()=>{},releaseRuntime:()=>void=()=>{},entered:()=>void=()=>{};
 const began=new Promise<void>(r=>{entered=r;}),waiting=new Promise<void>(r=>{releaseRuntime=r;});
 const s=await setup({hold:stagingHold({beforeOutside:()=>released,finish:()=>{}}),
  receipt:async()=>{lookups++;return new Promise(r=>{resolveReceipt=r;});},deliver:async()=>{attempts++;entered();await waiting;}});
 const input={agent:'art',id:'abcdefghijklmnop',text:'retry words'};
 const opened=await s.call('open',input),place=(opened as {ok:true;value:{thread:string}}).value.thread;
 await s.comms.deliver('art',place,1);
 s.app.db.prepare('UPDATE comms_messages SET record=? WHERE thread=?').run(JSON.stringify({delivery:'failed'}),place);released=true;
 const direct=s.comms.deliver('art',place,1);
 await s.call('open',input);const recovery=s.comms.reconcileDeliveries();
 expect(lookups).toBe(1);expect(attempts).toBe(0);
 resolveReceipt('not-accepted');await began;
 await s.call('open',input);const another=s.comms.deliver('art',place,1);
 expect(lookups).toBe(1);expect(attempts).toBe(1);
 releaseRuntime();await Promise.all([direct,recovery,another]);
 expect(s.deliveries).toHaveLength(1);
});
for(const route of ['open','send','direct'] as const)for(const receipt of ['accepted','not-accepted','unknown','error','absent'] as const)it(`fences duplicate delivery through ${route} (${receipt})`,async()=>{
 let attempts=0,lookups=0,decrypts=0;
 const s=await setup({key:k=>({...k,open:async words=>{decrypts++;return k.open(words);}}),
  deliver:async()=>{attempts++;throw new Error('acceptance uncertain');},
  receipt:receipt==='absent'?undefined:async()=>{lookups++;if(receipt==='error')throw new Error('lookup unavailable');return receipt;}});
 const input={agent:'art',id:'abcdefghijklmnop',text:'retry words'};
 const opened=await s.call('open',input);expect(opened.ok).toBe(true);
 const place=(opened as {ok:true;value:{thread:string}}).value.thread;
 await s.comms.deliver('art',place,1);
 let seq=1;
 if(route==='send') {await s.call('send',{thread:place,id:'bcdefghijklmnopq',text:'retry words'});seq=2;await s.comms.deliver('art',place,seq);}
 const before=attempts,openedBefore=decrypts,lookupsBefore=lookups;
 if(route==='direct')await s.comms.deliver('art',place,seq);
 else {expect((await s.call(route,route==='open'?input:{thread:place,id:'bcdefghijklmnopq',text:'retry words'})).ok).toBe(true);await s.comms.deliver('art',place,seq);}
 expect(lookups-lookupsBefore).toBe(receipt==='absent'?0:1);
 expect(attempts-before).toBe(receipt==='not-accepted'?1:0);
 expect(decrypts-openedBefore).toBe(receipt==='not-accepted'?1:0);
 expect(s.comms.trace('art',place).messages.find(m=>m.seq===seq)?.delivery).toBe(receipt==='accepted'?'delivered':'failed');
});
for(const state of ['sending','failed'] as const)for(const receipt of ['accepted','not-accepted','unknown','error','absent'] as const)it(`checks receipts before a window resend (${state}, ${receipt})`,async()=>{
 let released=false,decrypts=0,lookups=0;
 const s=await setup({key:k=>({...k,open:async words=>{decrypts++;return k.open(words);}}),hold:stagingHold({beforeOutside:()=>released,finish:()=>{}}),
  receipt:receipt==='absent'?undefined:async()=>{lookups++;if(receipt==='error')throw new Error('unavailable');return receipt;}});
 const place=await s.open();await s.comms.deliver('art',place,1);
 s.app.db.prepare('UPDATE comms_messages SET record=? WHERE thread=?').run(JSON.stringify({delivery:state}),place);
 const before=decrypts;released=true;
 const sent=s.call('resend',{thread:place,seq:1}),recovery=s.comms.reconcileDeliveries();
 expect((await sent).ok).toBe(true);await recovery;
 expect(lookups).toBe(receipt==='absent'?0:1);
 expect(s.deliveries).toHaveLength(receipt==='not-accepted'?1:0);
 expect(decrypts-before).toBe(receipt==='not-accepted'?1:0);
 expect(s.comms.trace('art',place).messages[0].delivery).toBe(receipt==='accepted'||receipt==='not-accepted'?'delivered':state);
});
it('coalesces window resends behind a receipt fence and resumes a held send',async()=>{
 let released=false,lookups=0,resolve:(value:'not-accepted')=>void=()=>{};
 const s=await setup({hold:stagingHold({beforeOutside:()=>released,finish:()=>{}}),receipt:async()=>{lookups++;return new Promise(r=>{resolve=r;});}});
 const place=await s.open();await s.comms.deliver('art',place,1);released=true;
 expect((await s.call('resend',{thread:place,seq:1})).ok).toBe(true);await s.comms.reconcileDeliveries();
 expect(s.deliveries).toHaveLength(1);expect(lookups).toBe(0);
 s.app.db.prepare('UPDATE comms_messages SET record=? WHERE thread=?').run(JSON.stringify({delivery:'failed'}),place);
 await Promise.all([s.call('resend',{thread:place,seq:1}),s.call('resend',{thread:place,seq:1})]);
 expect(lookups).toBe(1);expect(s.deliveries).toHaveLength(1);
 const recovery=s.comms.reconcileDeliveries();resolve('not-accepted');await recovery;
 expect(s.deliveries).toHaveLength(2);
});
for(const result of ['accepted','not-accepted','unknown','error'] as const)it(`reconciles uncertain runtime receipts without blind replay (${result})`,async()=>{
 let released=false,decrypts=0;const receipts:unknown[]=[];
 const s=await setup({key:key=>({...key,open:async words=>{decrypts++;return key.open(words);}}),hold:stagingHold({beforeOutside:()=>released,finish:()=>{}}),receipt:async facts=>{receipts.push(facts);if(result==='error')throw new Error('runtime unavailable');return result;}});
 const place=await s.open();await s.comms.deliver('art',place,1);
 s.app.db.prepare('UPDATE comms_messages SET record=? WHERE thread=?').run(JSON.stringify({delivery:'sending'}),place);
 const before=decrypts;released=true;await s.restart();await s.comms.reconcileDeliveries();
 const state=JSON.parse((s.app.db.prepare('SELECT record FROM comms_messages WHERE thread=?').get(place) as {record:string}).record).delivery;
 expect(state).toBe(result==='accepted'||result==='not-accepted'?'delivered':'sending');
 expect(s.deliveries).toHaveLength(result==='not-accepted'?1:0);
 expect(decrypts-before).toBe(result==='not-accepted'?1:0);
 expect(receipts[0]).toMatchObject({thread:place,agent:'art',member:'jonathan',seq:1});
 expect(JSON.stringify(receipts)).not.toContain('secret member words');
 if(result==='accepted'||result==='not-accepted'){const count=receipts.length;await s.restart();await s.comms.reconcileDeliveries();expect(receipts).toHaveLength(count);}
});
for(const change of ['archive','ownership','receipt'] as const)it(`coalesces receipt recovery and rejects a changed snapshot (${change})`,async()=>{
 let lookup:((value:'not-accepted')=>void)|undefined,calls=0,released=false;
 const s=await setup({hold:stagingHold({beforeOutside:()=>released,finish:()=>{}}),receipt:async()=>{calls++;return new Promise(resolve=>{lookup=resolve;});}});
 const place=await s.open();await s.comms.deliver('art',place,1);
 s.app.db.prepare('UPDATE comms_messages SET record=? WHERE thread=?').run(JSON.stringify({delivery:'failed'}),place);
 const first=s.comms.reconcileDeliveries(),second=s.comms.reconcileDeliveries();expect(calls).toBe(1);
 if(change==='archive')await s.call('change',{thread:place,action:'archive'});
 if(change==='ownership'){s.getSharing().members.jonathan.agents=[];}
 if(change==='receipt')s.app.db.prepare('UPDATE comms_messages SET record=? WHERE thread=?').run(JSON.stringify({delivery:'delivered'}),place);
 released=true;lookup!('not-accepted');await Promise.all([first,second]);expect(s.deliveries).toEqual([]);
});
it('describes a private runtime thread with only its original reader and bounded source, ask and title guidance',async()=>{
 let opens=0;const s=await setup({key:key=>({...key,open:async words=>{opens++;return key.open(words);}})});
 const place=await s.open();await s.comms.deliver('art',place,1);const before=opens;
 const conversation=s.deliveries[0].conversation;
 const description=s.comms.describe('art',place);
 expect(description.readers).toEqual(['jonathan']);
 expect(description.brief).toEqual([
  `A private thread in loom's app with your owner, Jonathan. Only they read it. They can see your tool use as you work. Work you record here can name this conversation as its source: conversation:${conversation}.`,
  "When you need Jonathan's OK, ask it as you always do (a needs_owner, or an approval request): it shows right here in the thread as a card with its buttons, as well as in their Inbox, and their answer comes back to you.",
  "The thread is filed under the project pond. Give the thread a short title once you know what it's about: call comms_title.",
 ]);
 expect(description.brief.every(line=>line.length<=300&&!/[\r\n\x00-\x1f\x7f]/.test(line))).toBe(true);
 expect(opens).toBe(before);expect(JSON.stringify(description)).not.toContain('secret member words');
 await s.call('change',{thread:place,action:'title',title:'Private title'});
 expect(s.comms.describe('art',place).brief[2]).toBe('The thread is filed under the project pond.');
 await s.call('change',{thread:place,action:'project',project:null});
 expect(s.comms.describe('art',place).brief).toHaveLength(2);
 expect(s.app.operations.has('comms.describe')).toBe(false);
});
it('refuses runtime description for another agent, inactive threads, revoked owners and unsafe brief fields',async()=>{
 const s=await setup();const place=await s.open();
 for(const [agent,target] of [['other',place],['art','missing']])expect(()=>s.comms.describe(agent,target)).toThrow('Thread unavailable');
 const original=(s.app.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(place) as {record:string}).record;
 for(const conversation of ['cv\nforged','cv\u2028forged','c'.repeat(301)]){
  s.app.db.prepare('UPDATE comms_threads SET record=? WHERE id=?').run(JSON.stringify({...JSON.parse(original),conversation}),place);
  expect(()=>s.comms.describe('art',place)).toThrow('Thread description unavailable');
 }
 s.app.db.prepare('UPDATE comms_threads SET record=? WHERE id=?').run(original,place);
 const sharing=s.getSharing();sharing.members.jonathan.agents=[];s.setSharing(sharing);
 expect(()=>s.comms.describe('art',place)).toThrow('Thread unavailable');
 sharing.members.jonathan.agents=['art'];s.setSharing(sharing);
 await s.call('change',{thread:place,action:'archive'});expect(()=>s.comms.describe('art',place)).toThrow('Thread unavailable');
 await s.call('change',{thread:place,action:'delete'});expect(()=>s.comms.describe('art',place)).toThrow('Thread unavailable');
 const live=await s.open();await s.comms.close();expect(()=>s.comms.describe('art',live)).toThrow('Thread unavailable');
});
it('records working/done heartbeats without moving thread activity and consumes stop once',async()=>{
 const s=await setup();const place=await s.open();await s.comms.deliver('art',place,1);
 const row=()=>JSON.parse((s.app.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(place) as {record:string}).record);
 const last=row().last;s.clock.advance(1000);
 expect(s.comms.status('art',place,'working')).toEqual({stop:false,archived:false});
 expect(row()).toMatchObject({working:true,workingSince:s.clock.now(),workingBeat:s.clock.now(),last});
 const since=row().workingSince;s.clock.advance(15000);s.comms.status('art',place,'working');
 expect(row()).toMatchObject({working:true,workingSince:since,workingBeat:s.clock.now(),last});
 await s.restart();expect(row()).toMatchObject({working:true,workingSince:since,workingBeat:s.clock.now(),last});
 await s.call('change',{thread:place,action:'stop'});
 expect(s.comms.status('art',place)).toEqual({stop:true,archived:false});
 expect(row().working).toBe(true);
 expect(s.comms.status('art',place,'done')).toEqual({stop:false,archived:false});
 expect(row()).toMatchObject({working:false,workingSince:null,workingBeat:null,last});
 expect(s.app.db.prepare('SELECT * FROM comms_messages').all()).toHaveLength(1);
});
it('refuses invalid, foreign, revoked and closed heartbeat writes and cannot start archived threads',async()=>{
 const s=await setup();const place=await s.open();await s.comms.deliver('art',place,1);
 const snapshot=()=>JSON.stringify(s.app.db.prepare('SELECT * FROM comms_threads').all());
 const before=snapshot();
 expect(()=>s.comms.status('other',place,'working')).toThrow();
 expect(()=>s.comms.status('art','missing','working')).toThrow();
 expect(()=>s.comms.status('art',place,'invalid' as 'working')).toThrow();
 expect(snapshot()).toBe(before);
 const sharing=s.getSharing();s.setSharing({...sharing,members:{...sharing.members,jonathan:{...sharing.members.jonathan,agents:[]}}});
 expect(()=>s.comms.status('art',place,'working')).toThrow();expect(snapshot()).toBe(before);
 s.setSharing(sharing);s.comms.status('art',place,'working');await s.call('change',{thread:place,action:'archive'});
 expect(JSON.parse((s.app.db.prepare('SELECT record FROM comms_threads').get() as {record:string}).record)).toMatchObject({working:false,workingSince:null,workingBeat:null});
 expect(s.comms.status('art',place,'working')).toEqual({stop:false,archived:true});
 expect(JSON.parse((s.app.db.prepare('SELECT record FROM comms_threads').get() as {record:string}).record).working).toBe(false);
 await s.comms.close();const closed=snapshot();expect(()=>s.comms.status('art',place,'working')).toThrow();expect(snapshot()).toBe(closed);
});
it('expires working heartbeats at 90 seconds, extends on a beat, and preserves activity and words',async()=>{
 const s=await setup();const place=await s.open();await s.comms.deliver('art',place,1);
 const row=()=>JSON.parse((s.app.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(place) as {record:string}).record);
 const messages=()=>JSON.stringify(s.app.db.prepare('SELECT * FROM comms_messages').all());
 const last=row().last,before=messages();s.comms.status('art',place,'working');
 s.clock.advance(89_999);expect(row().working).toBe(true);
 s.comms.status('art',place,'working');const since=row().workingSince;
 s.clock.advance(89_999);expect(row()).toMatchObject({working:true,workingSince:since});
 s.clock.advance(1);expect(row()).toMatchObject({working:false,workingSince:null,workingBeat:null,last});
 expect(messages()).toBe(before);
 s.comms.status('art',place,'working');expect(row().workingSince).toBe(s.clock.now());
 await s.comms.close();s.clock.advance(90_000);expect(row().working).toBe(true);
 await s.restart();expect(row()).toMatchObject({working:false,workingSince:null,workingBeat:null,last});
});
it('settles persisted working state without a beat using its start or last activity',async()=>{
 const s=await setup();const place=await s.open();await s.comms.deliver('art',place,1);await s.comms.close();
 const row=JSON.parse((s.app.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(place) as {record:string}).record);
 row.working=true;row.workingSince=s.clock.now();delete row.workingBeat;
 s.app.db.prepare('UPDATE comms_threads SET record=? WHERE id=?').run(JSON.stringify(row),place);
 s.clock.advance(89_999);await s.restart();expect(s.comms.trace('art',place).working).toBe(true);
 s.clock.advance(1);expect(s.comms.trace('art',place).working).toBe(false);
 await s.comms.close();delete row.workingSince;row.working=true;
 s.app.db.prepare('UPDATE comms_threads SET record=? WHERE id=?').run(JSON.stringify(row),place);
 await s.restart();expect(s.comms.trace('art',place).working).toBe(false);
});
it('records monotonic body liveness and tokens without extending working or moving activity',async()=>{
 const s=await setup();const place=await s.open();await s.comms.deliver('art',place,1);
 const row=()=>JSON.parse((s.app.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(place) as {record:string}).record);
 const messages=JSON.stringify(s.app.db.prepare('SELECT * FROM comms_messages').all()),last=row().last;
 s.comms.status('art',place,'working');const since=row().workingSince;
 s.clock.advance(15_000);const at=s.clock.now();
 s.comms.activity('art',place,{at,tokens:500});
 expect(row()).toMatchObject({aliveAt:at,aliveTokens:500,workingSince:since,workingBeat:since,last});
 expect(s.comms.trace('art',place)).toMatchObject({alive:{at,tokens:500}});
 s.comms.activity('art',place,{at:at-1,tokens:999});
 s.comms.activity('art',place,{at,tokens:999});
 s.comms.activity('art',place,{at:at+60_001,tokens:999});
 expect(row()).toMatchObject({aliveAt:at,aliveTokens:500});
 await s.restart();expect(s.comms.trace('art',place)).toMatchObject({alive:{at,tokens:500}});
 s.clock.advance(1);s.comms.activity('art',place,{at:s.clock.now()});
 expect(row()).toMatchObject({aliveTokens:null});expect(s.comms.trace('art',place).alive).toEqual({at:s.clock.now()});
 s.clock.advance(74_999);expect(row().working).toBe(false);expect(s.comms.trace('art',place).alive).toBeUndefined();
 s.clock.advance(60_001);s.comms.status('art',place,'working');
 expect(s.comms.trace('art',place).alive).toBeUndefined();
 s.comms.status('art',place,'done');s.comms.activity('art',place,{at:s.clock.now(),tokens:0});
 expect(row().working).toBe(false);expect(s.comms.trace('art',place).alive).toBeUndefined();
 expect(row().last).toBe(last);expect(JSON.stringify(s.app.db.prepare('SELECT * FROM comms_messages').all())).toBe(messages);
});
it('rejects malformed and unauthorized body liveness without mutation',async()=>{
 const s=await setup();const place=await s.open();await s.comms.deliver('art',place,1);
 const snapshot=()=>JSON.stringify(s.app.db.prepare('SELECT * FROM comms_threads').all());const before=snapshot();
 for(const input of [{at:NaN},{at:Infinity},{at:-1},{at:1.5},{at:'now'},{at:s.clock.now(),tokens:-1},{at:s.clock.now(),tokens:0.5},{at:s.clock.now(),tokens:1e12+1},{at:s.clock.now(),tokens:Infinity},{at:s.clock.now(),text:'private'}]) {
  expect(()=>s.comms.activity('art',place,input as {at:number})).toThrow();expect(snapshot()).toBe(before);
 }
 expect(()=>s.comms.activity('other',place,{at:s.clock.now()})).toThrow();
 expect(()=>s.comms.activity('art','missing',{at:s.clock.now()})).toThrow();
 const sharing=s.getSharing();s.setSharing({...sharing,members:{...sharing.members,jonathan:{...sharing.members.jonathan,agents:[]}}});
 expect(()=>s.comms.activity('art',place,{at:s.clock.now()})).toThrow();expect(snapshot()).toBe(before);
 s.setSharing(sharing);await s.call('change',{thread:place,action:'archive'});const archived=snapshot();
 expect(()=>s.comms.activity('art',place,{at:s.clock.now()})).toThrow();expect(snapshot()).toBe(archived);
 await s.call('change',{thread:place,action:'unarchive'});await s.comms.close();const closed=snapshot();
 expect(()=>s.comms.activity('art',place,{at:s.clock.now()})).toThrow();expect(snapshot()).toBe(closed);
});

it('retries a final queued start as one durable generation and ignores old callbacks',async()=>{
 const s=await setup();const place=await s.open();await s.comms.deliver('art',place,1);
 await s.comms.startNotice('art',place,{seq:1,attempt:3,kind:'start-failed',reason:'private stopped host'});
 const input={thread:place,seq:1,generation:0};
 expect(JSON.stringify(await s.call('messages',{thread:place}))).toContain('"retryStart":{"seq":1,"generation":0}');
 const results=await Promise.all([s.call('retryStart',input),s.call('retryStart',input)]);
 expect(results.filter(r=>r.ok)).toHaveLength(1);await s.comms.deliver('art',place,1);
 expect(s.deliveries).toHaveLength(2);expect(s.deliveries[1]).toMatchObject({seq:1,generation:1,text:'secret member words'});
 const before=JSON.stringify(s.app.db.prepare('SELECT * FROM comms_messages').all());
 await s.comms.startNotice('art',place,{seq:1,attempt:99,kind:'start-failed'});
 expect(JSON.stringify(s.app.db.prepare('SELECT * FROM comms_messages').all())).toBe(before);
 expect(JSON.stringify(await s.call('messages',{thread:place}))).not.toContain('retryStart');
 await s.restart();
 expect((await s.call('retryStart',input)).ok).toBe(false);
 await s.comms.startNotice('art',place,{seq:1,generation:1,attempt:1,kind:'start-retry',retryAt:'2026-11-12T00:01:00Z'});
 expect(JSON.stringify(await s.call('messages',{thread:place}))).toContain('start-retry');
 await s.comms.startNotice('art',place,{seq:1,generation:1,attempt:2,kind:'start-failed'});
 expect((await s.call('retryStart',{...input,generation:1})).ok).toBe(true);await s.comms.deliver('art',place,1);
 expect(s.deliveries.at(-1)?.generation).toBe(2);
 const rows=s.app.db.prepare('SELECT * FROM comms_messages').all();expect(rows).toHaveLength(2);
 expect(JSON.stringify(rows)).not.toContain('private stopped host');
});
for(const receipt of ['accepted','not-accepted','unknown','absent'] as const)it(`fences uncertain explicit start generations after restart (${receipt})`,async()=>{
 const facts:unknown[]=[];let attempts=0,uncertain=true;
 const s=await setup({deliver:async d=>{attempts++;if(d.generation&&uncertain)throw new Error('lost ack');},receipt:receipt==='absent'?undefined:async d=>{facts.push(d);return receipt;}});
 const place=await s.open();await s.comms.deliver('art',place,1);
 await s.comms.startNotice('art',place,{seq:1,attempt:1,kind:'start-failed'});
 expect((await s.call('retryStart',{thread:place,seq:1,generation:0})).ok).toBe(true);await s.comms.deliver('art',place,1);
 expect(attempts).toBe(2);uncertain=false;await s.restart();await s.comms.reconcileDeliveries();
 expect(attempts).toBe(receipt==='not-accepted'?3:2);
 if(receipt!=='absent')expect(facts[0]).toMatchObject({seq:1,generation:1});
 expect(JSON.stringify(facts)).not.toContain('secret member words');
 expect((await s.call('retryStart',{thread:place,seq:1,generation:0})).ok).toBe(false);
});
for(const change of ['progress','expiry','archive','revocation','source','notice'] as const)it(`refuses a final-start retry changed during private decoding (${change})`,async()=>{
 let pause=false,release:()=>void=()=>{},began:()=>void=()=>{};
 const waiting=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{began=r;});
 const s=await setup({key:k=>({...k,open:async words=>{if(pause){began();await waiting;}return k.open(words);}})});
 const place=await s.open();await s.comms.deliver('art',place,1);
 await s.comms.startNotice('art',place,{seq:1,attempt:1,kind:'start-failed'});
 pause=true;const result=s.call('retryStart',{thread:place,seq:1,generation:0});await started;
 if(change==='progress')s.comms.status('art',place,'working');
 if(change==='expiry')s.clock.advance(14*86400_000);
 if(change==='archive')await s.call('change',{thread:place,action:'archive'});
 if(change==='revocation')s.setSharing({...s.getSharing(),members:{jonathan:{agents:[]}}});
 if(change==='source'||change==='notice')s.app.db.prepare("UPDATE comms_messages SET record=json_set(record,'$.changed',1) WHERE thread=? AND seq=?").run(place,change==='source'?1:2);
 release();expect((await result).ok).toBe(false);expect(s.deliveries).toHaveLength(1);
});
it('keeps a staged start generation stable through restart and a repeated operation receipt',async()=>{
 let released=true;const effects:string[]=[];
 const s=await setup({hold:stagingHold({beforeOutside:f=>{effects.push(f.id);return released;},finish:()=>{}})});
 const place=await s.open();await s.comms.deliver('art',place,1);
 const source=s.app.db.prepare('SELECT at,words,hash FROM comms_messages WHERE thread=? AND seq=1').get(place);
 await s.comms.startNotice('art',place,{seq:1,attempt:1,kind:'start-failed'});
 released=false;
 const input={thread:place,seq:1,generation:0};
 const call=()=>s.app.operations.callAsync('socket',member,'comms.retryStart',input,'stable-start-operation',true);
 expect((await call()).ok).toBe(true);await s.comms.deliver('art',place,1);
 expect(s.comms.trace('art',place).messages[0].delivery).toBe('held');
 expect((await call()).ok).toBe(true);await s.comms.deliver('art',place,1);
 expect(s.deliveries).toHaveLength(1);
 released=true;await s.restart();await s.comms.reconcileDeliveries();
 expect(s.deliveries).toHaveLength(2);expect(s.deliveries.at(-1)?.generation).toBe(1);
 expect(effects.filter(id=>id.endsWith(':g1')).length).toBeGreaterThan(1);
 expect(new Set(effects.filter(id=>id.endsWith(':g1'))).size).toBe(1);
 expect(s.app.db.prepare('SELECT at,words,hash FROM comms_messages WHERE thread=? AND seq=1').get(place)).toEqual(source);
});

it('supplies authoritative retention deadlines on page and runtime-reader records',async()=>{
 const s=await setup({days:1}),place=await s.open();await s.comms.deliver('art',place,1);
 const read=async()=>{const result=await s.call('messages',{thread:place});expect(result.ok).toBe(true);return (result as {ok:true;value:Record<string,unknown>[]}).value;};
 const first=(await read())[0];expect(first.keepUntil).toBe(Number(first.at)+86400000);
 const bound=await s.comms.reader({agent:'art',valid:()=>true}).read({thread:place});
 expect(bound.messages[0].keepUntil).toBe(first.keepUntil);
 await s.comms.post('art',place,{id:'deadline-card',kind:'card',text:'private step',step:{keepUntil:9999999999999}});
 const card=(await read())[1];expect(card.keepUntil).toBe(Number(card.at)+86400000);
});

it('atomically writes private activity batches, preserving step identity, tool, timing and deadline',async()=>{
 const s=await setup(),place=await s.open(),at=s.clock.now(),t0=new Date(at).toISOString();
 const first=await s.comms.activityCards('art',place,{run:'run-private',cards:[
  {id:'edit',tool:'Edit',summary:'Private edit',state:'running',at:t0,body:'private diff',detail:'private command',limit:10},
  {id:'shell',tool:'Bash',summary:'Ran tests',state:'done',body:'must never keep shell output',result:'Tests passed'},
 ]});
 expect(first).toEqual({added:2,updated:0});
 const rows=()=>s.app.db.prepare("SELECT * FROM comms_messages WHERE thread=? AND kind='card' ORDER BY seq").all(place) as {seq:number;at:number;record:string;words:Buffer|null}[];
 const before=rows();expect(before).toHaveLength(2);
 expect(JSON.stringify(before)).not.toMatch(/private diff|private command|Private edit|run-private|Bash|Edit|Tests passed/);
 s.clock.advance(5000);
 expect(await s.comms.activityCards('art',place,{run:'run-private',cards:[{id:'edit',tool:'Bash',summary:'Edited',state:'done',body:'replacement diff'}]})).toEqual({added:0,updated:1});
 const page=await s.call('messages',{thread:place});expect(page).toMatchObject({ok:true});
 const records=(page as {ok:true;value:Record<string,unknown>[]}).value;
 const edit=records.find(r=>r.seq===before[0].seq)!;
 expect(edit).toMatchObject({text:'Edited',tool:'Edit',run:'run-private',state:'done',at,keepUntil:at+14*86400_000,step:{t0,t1:new Date(at+5000).toISOString()}});
 expect(JSON.stringify(edit)).not.toMatch(/private diff|private command|replacement diff|"limit"/);
 expect(JSON.stringify(records)).not.toContain('must never keep shell output');
 expect(rows().map(r=>[r.seq,r.at])).toEqual(before.map(r=>[r.seq,r.at]));
 expect(await s.comms.activityCards('art',place,{run:'another-run',cards:[{id:'edit',tool:'Edit',summary:'New label',state:'done',body:'new diff'}]})).toEqual({added:0,updated:1});
 const last=await s.call('messages',{thread:place});expect(JSON.stringify(last)).toContain('new diff');
});

it('refuses a whole invalid private card batch before crypto or writes',async()=>{
 let seals=0;const s=await setup({key:k=>({...k,seal:async v=>{seals++;return k.seal(v);}})}),place=await s.open();
 await s.comms.deliver('art',place,1);seals=0;
 const good={id:'one',tool:'Edit',summary:'Edit file',state:'running'} as const;
 const invalid:unknown[]=[[],Array(51).fill(good),[good,good],[good,{...good,id:'bad id'}],[good,{...good,id:'two',tool:'bad tool'}],
  [good,{...good,id:'two',summary:'bad\nline'}],[good,{...good,id:'two',summary:'\u0085'}],[good,{...good,id:'two',summary:'\u202e'}],
  [good,{...good,id:'two',state:'unknown'}],[good,{...good,id:'two',unknown:'value'}],
  [good,{...good,id:'two',detail:'x'.repeat(4001)}],[good,{...good,id:'two',detail:'\x1b[31mcolor'}],
  [good,{...good,id:'two',body:'x'.repeat(32001)}],[good,{...good,id:'two',body:'\x1b[2J'}],
  [good,{...good,id:'two',result:'a\nb'}],[good,{...good,id:'two',limit:0}],[good,{...good,id:'two',limit:86401}],
  [good,{...good,id:'two',exit:1.5}],[good,{...good,id:'two',exit:1000000}],[good,{...good,id:'two',parent:'bad id'}],
  [good,{...good,id:'two',end:'yesterday'}],[good,{...good,id:'two',items:Array(21).fill({text:'a',state:'now'})}],
  [good,{...good,id:'two',items:[{text:'a',state:'bad'}]}],
 ];
 const snapshot=s.app.db.prepare('SELECT * FROM comms_messages').all();
 for(const cards of invalid)await expect(s.comms.activityCards('art',place,{run:'body',cards} as never)).rejects.toThrow();
 for(const raw of [{run:'',cards:[good]},{run:'body',cards:[good],extra:true},{run:'body',cards:[],alive:{at:1,tokens:-1}}])
  await expect(s.comms.activityCards('art',place,raw as never)).rejects.toThrow();
 expect(seals).toBe(0);expect(s.app.db.prepare('SELECT * FROM comms_messages').all()).toEqual(snapshot);
});

it('keeps private step bodies only for the original allowed tool and retains timing through whole-card replacement',async()=>{
 const s=await setup(),place=await s.open(),at=s.clock.now(),start=new Date(at-1000).toISOString();
 const write=(cards:import('./role.js').ThreadCard[])=>s.comms.activityCards('art',place,{run:'body',cards});
 await write([{id:'shell',tool:'Bash',summary:'Shell',state:'running'},
  {id:'text',tool:'text',summary:'Words',state:'done',at:start,body:'Private words\n\x1b[31mred\x1b[0m'},
  {id:'plan',tool:'TodoWrite',summary:'Plan',state:'done',at:start,items:[{text:'Do it',state:'done'}]}]);
 s.clock.advance(1000);
 await write([{id:'shell',tool:'Edit',summary:'Shell ended',state:'done',body:'never store changed-tool output',exit:1}]);
 const read=async()=>{const r=await s.call('messages',{thread:place});return (r as {ok:true;value:Record<string,unknown>[]}).value;};
 let rows=await read();expect(JSON.stringify(rows)).not.toContain('never store changed-tool output');
 expect(rows.find(r=>r.tool==='Bash')).toMatchObject({step:{exit:1,t1:new Date(at+1000).toISOString()}});
 for(const tool of ['text','TodoWrite'])expect(rows.find(r=>r.tool===tool)).toMatchObject({step:{t0:start,t1:start}});
 expect(rows.find(r=>r.tool==='text')).toMatchObject({step:{body:'Private words\n\x1b[31mred\x1b[0m'}});
 s.clock.advance(1000);await write([{id:'shell',tool:'Bash',summary:'Again',state:'running'}]);
 rows=await read();expect(rows.find(r=>r.tool==='Bash')?.step).toEqual({});
});

for(const boundary of ['ownership','closed','deleted','conversation','project','archived','reopened','row'] as const)
 it(`fences whole private card batches across suspended crypto (${boundary})`,async()=>{
  let pause=false,started=()=>{},release=()=>{};
  const began=new Promise<void>(r=>{started=r;}),waiting=new Promise<void>(r=>{release=r;});
  const s=await setup({key:k=>({...k,seal:async words=>{expect(s.app.db.inTransaction).toBe(false);if(pause){started();await waiting;}return k.seal(words);}})}),place=await s.open();
  await s.comms.deliver('art',place,1);
  const card={id:'step',tool:'Edit',summary:'Before',state:'running'} as const;
  await s.comms.activityCards('art',place,{run:'body',cards:[card]});
  pause=true;const writing=s.comms.activityCards('art',place,{run:'body',cards:[{...card,summary:'After'},{...card,id:'second'}]});await began;
  if(boundary==='ownership')s.setSharing({members:{},projects:{},services:{}});
  if(boundary==='closed')await s.comms.close();
  if(boundary==='deleted')await s.call('change',{thread:place,action:'delete'});
  if(boundary==='archived'||boundary==='reopened')await s.call('change',{thread:place,action:'archive'});
  if(boundary==='reopened')await s.call('change',{thread:place,action:'unarchive'});
  if(boundary==='conversation'||boundary==='project'){
   const row=s.app.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(place) as {record:string};
   s.app.db.prepare('UPDATE comms_threads SET record=? WHERE id=?').run(JSON.stringify({...JSON.parse(row.record),[boundary]:'replacement'}),place);
  }
  if(boundary==='row')s.app.db.prepare("UPDATE comms_messages SET record='{}',words=NULL WHERE thread=? AND kind='card'").run(place);
  const snapshot=s.app.db.prepare('SELECT * FROM comms_messages').all();release();
  await expect(writing).rejects.toThrow();expect(s.app.db.prepare('SELECT * FROM comms_messages').all()).toEqual(snapshot);
 });

it('keeps batch writes atomic on later crypto failure and a transaction rollback',async()=>{
 let fail=false,n=0;const s=await setup({key:k=>({...k,seal:async words=>{if(fail&&++n===2)throw new Error('crypto failed');return k.seal(words);}})}),place=await s.open();
 await s.comms.deliver('art',place,1);
 const cards=[{id:'a',tool:'Edit',summary:'a',state:'done'},{id:'b',tool:'Edit',summary:'b',state:'done'}] as const;
 const before=s.app.db.prepare('SELECT * FROM comms_messages').all();fail=true;
 await expect(s.comms.activityCards('art',place,{run:'body',cards})).rejects.toThrow('crypto failed');
 expect(s.app.db.prepare('SELECT * FROM comms_messages').all()).toEqual(before);fail=false;
 s.app.db.exec("CREATE TRIGGER reject_second BEFORE INSERT ON comms_messages WHEN NEW.id='b' BEGIN SELECT RAISE(ABORT,'batch rollback'); END;");
 await expect(s.comms.activityCards('art',place,{run:'body',cards})).rejects.toThrow();
 expect(s.app.db.prepare('SELECT * FROM comms_messages').all()).toEqual(before);
});

it('never renews a private step deadline or resurrects swept words, including expiry during crypto',async()=>{
 let pause=false,started=()=>{},release=()=>{};
 const began=new Promise<void>(r=>{started=r;}),waiting=new Promise<void>(r=>{release=r;});
 const s=await setup({days:1,key:k=>({...k,seal:async words=>{if(pause){started();await waiting;}return k.seal(words);}})}),place=await s.open();
 await s.comms.deliver('art',place,1);
 const card={id:'a',tool:'Edit',summary:'Private',state:'running'} as const,at=s.clock.now();
 await s.comms.activityCards('art',place,{run:'body',cards:[card]});s.clock.advance(86400_000-1);
 pause=true;const writing=s.comms.activityCards('art',place,{run:'body',cards:[{...card,summary:'Too late',state:'done'}]});await began;
 // Move wall time without running sweep callbacks, so the commit's deadline check is exercised.
 s.clock.now=()=>at+86400_000;release();expect(await writing).toEqual({added:0,updated:0});pause=false;
 s.app.db.prepare("UPDATE comms_messages SET words=NULL,record='{}' WHERE thread=? AND kind='card'").run(place);
 expect(await s.comms.activityCards('art',place,{run:'later',cards:[card]})).toEqual({added:0,updated:0});
 const row=s.app.db.prepare("SELECT at,words FROM comms_messages WHERE thread=? AND kind='card'").get(place);expect(row).toEqual({at,words:null});
});

it('applies private batch heartbeats and monotonic alive samples without restarting a finished turn',async()=>{
 const s=await setup(),place=await s.open(),at=s.clock.now();await s.comms.deliver('art',place,1);
 const row=()=>JSON.parse((s.app.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(place) as {record:string}).record);
 const cards=[{id:'a',tool:'Edit',summary:'Editing',state:'running'}] as const;
 expect(await s.comms.activityCards('art',place,{run:'body',cards,alive:{at,tokens:0}})).toEqual({added:1,updated:0});
 expect(row()).toMatchObject({working:true,workingSince:at,workingBeat:at,aliveAt:at,aliveTokens:0});
 const last=row().last;s.clock.advance(1000);
 await s.comms.activityCards('art',place,{run:'body',cards:[],alive:{at:at+1000}});
 expect(row()).toMatchObject({working:true,workingSince:at,workingBeat:at+1000,aliveAt:at+1000,aliveTokens:null,last});
 s.comms.status('art',place,'done');s.clock.advance(1000);
 await s.comms.activityCards('art',place,{run:'body',cards:[{...cards[0],state:'done'}]});
 expect(row()).toMatchObject({working:false,workingSince:null,last});
 await s.comms.activityCards('art',place,{run:'body',cards:[],alive:{at:at+100000,tokens:99}});
 expect(row()).toMatchObject({working:false,aliveAt:at+1000,aliveTokens:null,last});
 await s.comms.activityCards('art',place,{run:'body',cards:[],alive:{at,tokens:99}});
 expect(row()).toMatchObject({aliveAt:at+1000,aliveTokens:null});
});

it('rejects unavailable private activity capabilities before decrypting or encrypting',async()=>{
 let crypto=0;const s=await setup({key:k=>({...k,seal:async v=>{crypto++;return k.seal(v);},open:async v=>{crypto++;return k.open(v);}})}),place=await s.open();
 await s.comms.deliver('art',place,1);crypto=0;
 const batch={run:'body',cards:[{id:'a',tool:'Edit',summary:'Edit',state:'done'}]} as const;
 await expect(s.comms.activityCards('other-agent',place,batch)).rejects.toThrow();
 await expect(s.comms.activityCards('art','missing',batch)).rejects.toThrow();
 await s.call('change',{thread:place,action:'archive'});
 await expect(s.comms.activityCards('art',place,batch)).rejects.toThrow();
 expect(crypto).toBe(0);
});

it('preserves imported card timing when its sealed metadata and step words use separate envelopes',async()=>{
 let key:WordsKey;const s=await setup({key:k=>{key=k;return k;}}),place=await s.open();await s.comms.deliver('art',place,1);
 const at=s.clock.now(),start=new Date(at-5000).toISOString(),end=new Date(at-1000).toISOString();
 await s.comms.post('art',place,{id:'imported',kind:'card',text:'Old',tool:'Edit',state:'done'});
 const words=await key!.seal('Imported label');
 const privateCipher=(await key!.seal(JSON.stringify({card:{tool:'Edit',state:'done',t0:start,t1:end}}))).toString('base64');
 const stepCipher=(await key!.seal(JSON.stringify({body:'Old diff'}))).toString('base64');
 s.app.db.prepare("UPDATE comms_messages SET words=?,record=? WHERE thread=? AND kind='card'").run(words,JSON.stringify({encoding:'text',privateCipher,stepCipher}),place);
 await s.comms.activityCards('art',place,{run:'new-body',cards:[{id:'imported',tool:'Edit',summary:'Updated',state:'done',body:'New diff'}]});
 expect(await s.call('messages',{thread:place})).toMatchObject({ok:true,value:expect.arrayContaining([expect.objectContaining({text:'Updated',tool:'Edit',state:'done',step:{body:'New diff',t0:start,t1:end}})])});
});

it('keeps switched harness labels encrypted and drops malformed labels without refusing replies',async()=>{
 const s=await setup({days:1});const place=await s.open();await s.comms.deliver('art',place,1);
 const posted={id:'switched',kind:'reply' as const,text:'Private switched reply',on:'Codex'};
 const first=await s.comms.post('art',place,posted);
 expect(await s.comms.post('art',place,posted)).toEqual(first);
 const read=await s.call('messages',{thread:place});expect(read.ok).toBe(true);
 expect((read as {ok:true;value:unknown[]}).value).toContainEqual(expect.objectContaining({card:{on:'Codex'}}));
 expect(JSON.stringify(s.app.db.prepare('SELECT * FROM comms_messages').all())).not.toContain('Codex');
 await expect(s.comms.post('art',place,{...posted,on:'Gemini'})).rejects.toThrow('Reply id');
 for(const [n,on] of ['<Codex>','two words','a'.repeat(25),'9codex','Codex\n',17,null,{on:'Codex'}].entries()){
  await s.comms.post('art',place,{id:`invalid-harness-${n}`,kind:'reply',text:'Still accepted',on} as unknown as import('./role.js').AgentPost);
 }
 const page=await s.call('messages',{thread:place});expect(page.ok).toBe(true);
 for(const m of (page as {ok:true;value:{card?:unknown;seq:number}[]}).value.filter(m=>m.seq>first.seq))expect(m.card).toBeUndefined();
 await s.comms.post('art',place,{id:'plain-harness',kind:'reply',text:'Ordinary reply'});
 const denied=await s.call('messages',{thread:place},{kind:'member',id:'other'});expect(denied.ok).toBe(false);
 s.clock.advance(86400000);
 expect(JSON.stringify(await s.call('messages',{thread:place}))).not.toContain('Codex');
});
