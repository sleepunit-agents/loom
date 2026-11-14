import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import webpush from 'web-push';
import { fixture } from '../../fixture.js';
import { startLoom } from '../../foundation.js';
import { FakeClock } from '../clock.js';
import { signin } from './index.js';
import { changeHouseholdMember } from '../household/members.js';
import type { Foundation } from '../app.js';
import type { PushTransport } from './push-transport.js';
import { attentionAnnouncements } from '../../pieces/attention/role.js';
import { installComms } from '../../pieces/comms/index.js';
import { loadKey } from '../../pieces/comms/crypto.js';
import { SharingDatabase } from '../household/sharing.js';
const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
const sub=(id='phone')=>({endpoint:`https://fcm.googleapis.com/${id}`,keys:{p256dh:'p'.repeat(87),auth:'a'.repeat(22)}});
async function setup(staging=true,withComms=false){
 const home=mkdtempSync(join(tmpdir(),'announcement-'));fixture(home);cleanup.push(()=>rmSync(home,{recursive:true,force:true}));
 const clock=new FakeClock(),send=vi.fn<PushTransport>().mockResolvedValue({});
 const key=withComms?await loadKey(home):undefined;let comms:ReturnType<typeof installComms>|undefined;
 const options={home,next:true,clock,staging,notifications:{send},stdout:()=>{},...(key?{install:(app:Foundation)=>{
   comms=installComms({...app,clock,key,sharing:()=>new SharingDatabase(app.db,home).sharing(),hold:async()=>{throw new Error('held');},runtime:{async deliver(){},async end(){}}});
 }}:{})};
 let app=await startLoom(options);cleanup.push(async()=>{await app.close();await comms?.close();});
 const seed=(id='phone',member='jonathan')=>signin(app).sessions.change(f=>{f.push??={};f.push.vapid??=webpush.generateVAPIDKeys();f.push.subs??={};const value=sub(id);f.push.subs[value.endpoint]={sub:value,member,session:'retained',at:signin(app).now()};});seed();
 let serial=0;
 const raise=(id='question',member='jonathan',scope:Record<string,string>={member})=>{
   const result=app.operations.call('direct',{kind:'member',id:member},'attention.raise',{id,ask:`PRIVATE ${id}`,source:{kind:'conversation',id:'cv-test'},...scope},`raise-${++serial}`);
   expect(result).toMatchObject({ok:true});return result;
 };
 const items=()=>app.db.prepare('SELECT * FROM notifications_announcements ORDER BY id').all() as Array<{id:string;member:string;key:string;state:string}>;
 const attempts=()=>app.db.prepare('SELECT * FROM notifications_announcement_attempts ORDER BY id').all() as Array<{id:string;state:string;ref:string}>;
 const settle=async()=>{await vi.waitFor(()=>{clock.advance(0);expect(attempts().every(a=>a.state!=='queued'||app.effects!.status(`notifications:announcement:${a.id}`)==='due')).toBe(true);});};
 const tick=async()=>{clock.advance(60_000);await settle();};
 const release=async()=>{
   for(const a of attempts().filter(a=>app.effects!.status(`notifications:announcement:${a.id}`)==='due'))expect(app.operations.call('direct',{kind:'member',id:Object.entries(new SharingDatabase(app.db,'').sharing().members).find(([,m])=>m.owner)![0]},'core.releaseEffect',{id:`notifications:announcement:${a.id}`},`release-${++serial}`)).toMatchObject({ok:true});
   await settle();
 };
 return {get app(){return app;},get comms(){return comms!;},get s(){return signin(app);},home,clock,send,seed,raise,tick,settle,release,items,attempts,async restart(){await app.close();await comms?.close();app=await startLoom(options);}};
}
it('holds exact-device routine sends, releases once, uses content-free payloads and persists dedupe across restart',async()=>{
 const f=await setup();f.raise();await f.tick();expect(f.send).not.toHaveBeenCalled();expect(f.attempts()).toHaveLength(1);
 await f.release();expect(f.send).toHaveBeenCalledOnce();expect(f.attempts()[0].state).toBe('sent');
 expect(f.send.mock.calls[0][0]).toEqual(sub());expect(JSON.parse(f.send.mock.calls[0][1])).toEqual({title:'loom',body:'',tag:expect.stringMatching(/^ask-[a-f0-9]{64}$/),url:'/p/inbox-preview/ask/question'});
 const rows=JSON.stringify([f.items(),f.attempts(),f.app.db.prepare('SELECT * FROM core_effects').all()]);
 for(const secret of ['PRIVATE',sub().endpoint,sub().keys.auth,f.s.sessions.read().push!.vapid!.privateKey])expect(rows).not.toContain(secret);
 await f.restart();await f.tick();expect(f.send).toHaveBeenCalledOnce();
});
it('first baseline suppresses existing asks and a newly subscribed device never hears a backlog',async()=>{
 const f=await setup(false);f.raise('old');f.app.db.prepare('DELETE FROM notifications_announcement_seed').run();await f.restart();await f.tick();expect(f.send).not.toHaveBeenCalled();expect(f.items()[0].state).toBe('seeded');
 f.s.sessions.change(file=>{file.push!.subs={};});f.raise('without-device');await f.tick();expect(f.send).not.toHaveBeenCalled();f.seed('new');await f.tick();expect(f.send).not.toHaveBeenCalled();f.raise('fresh');await f.tick();expect(f.send).toHaveBeenCalledOnce();expect(f.send.mock.calls[0][0]).toEqual(sub('new'));
});
it('uses current central visibility per member, with per-member durable dedupe and no added service grant',async()=>{
 const f=await setup(false);f.seed('other','pollock');
 f.raise('private');f.raise('household','jonathan',{});await f.tick();expect(f.send).toHaveBeenCalledTimes(2);expect(f.send.mock.calls.every(c=>c[0].endpoint===sub().endpoint)).toBe(true);
 expect(attentionAnnouncements(f.app.operations,'pollock')).toEqual([]);
 // A later owner gains the household item only; private membership remains exact.
 f.app.db.transaction(()=>{changeHouseholdMember(f.app.db,'','pollock','*');})();await f.tick();expect(f.send).toHaveBeenCalledTimes(3);expect(f.send.mock.calls[2][0]).toEqual(sub('other'));
 expect(f.items().filter(r=>r.member==='pollock')).toHaveLength(1);
 expect(new SharingDatabase(f.app.db,'').sharing().services).not.toHaveProperty('notifications');
});
it.each(['answered','member','device','keys','generation','vapid'] as const)('revalidates %s before a held send is released',async kind=>{
 const f=await setup();f.raise();await f.tick();
 if(kind==='answered')expect(f.app.operations.call('direct',{kind:'member',id:'jonathan'},'attention.answer',{id:'question',answer:{kind:'done'}},'answer')).toMatchObject({ok:true});
 else if(kind==='member')f.app.db.transaction(()=>{changeHouseholdMember(f.app.db,'','pollock','*');changeHouseholdMember(f.app.db,'','jonathan');})();
 else f.s.sessions.change(file=>{const d=file.push!.subs![sub().endpoint];if(kind==='device')delete file.push!.subs![sub().endpoint];if(kind==='keys')d.sub.keys.auth='b'.repeat(22);if(kind==='generation')(d as typeof d & {generation:string}).generation='replacement';if(kind==='vapid')file.push!.vapid=webpush.generateVAPIDKeys();});
 await f.release();expect(f.send).not.toHaveBeenCalled();expect(f.attempts()[0].state).toBe('cancelled');
});
it('admits at most five per minute and leaves excess candidates unmarked until next minute',async()=>{
 const f=await setup(false);for(let i=0;i<7;i++)f.raise(`ask-${i}`);await f.tick();expect(f.items()).toHaveLength(5);expect(f.send).toHaveBeenCalledTimes(5);await f.tick();expect(f.items()).toHaveLength(7);expect(f.send).toHaveBeenCalledTimes(7);
});
it('rechecks candidate and device after each awaited send and preserves replacement on late 410',async()=>{
 const f=await setup(false);f.seed('second');let reject!:(e:unknown)=>void;f.send.mockImplementationOnce(()=>new Promise((_yes,no)=>{reject=no;}));f.raise();f.clock.advance(60_000);await vi.waitFor(()=>{f.clock.advance(0);expect(f.send).toHaveBeenCalledOnce();});
 const endpoint=f.send.mock.calls[0][0].endpoint;
 f.s.sessions.change(file=>{file.push!.subs![endpoint].sub.keys.auth='b'.repeat(22);});
 expect(f.app.operations.call('direct',{kind:'member',id:'jonathan'},'attention.answer',{id:'question',answer:{kind:'done'}},'answer')).toMatchObject({ok:true});reject({statusCode:410,body:'PRIVATE diagnostics'});await f.settle();expect(f.send).toHaveBeenCalledOnce();expect(f.s.sessions.read().push!.subs![endpoint]).toBeDefined();expect(f.attempts().map(a=>a.state).sort()).toEqual(['cancelled','gone']);
});
it.each([410,503,undefined])('settles status %s without diagnostics or automatic replay',async statusCode=>{
 const f=await setup(false);f.send.mockRejectedValue({statusCode,body:'PRIVATE diagnostics'});f.raise();await f.tick();expect(f.attempts()[0].state).toBe(statusCode===410?'gone':statusCode===503?'failed':'uncertain');expect(!!f.s.sessions.read().push!.subs![sub().endpoint]).toBe(statusCode!==410);await f.restart();await f.tick();expect(f.send).toHaveBeenCalledOnce();expect(JSON.stringify(f.attempts())).not.toContain('PRIVATE');
});
it('recovers held attempts, refuses interrupted replay and aborts transport on daemon-clock deadline during close',async()=>{
 const f=await setup();f.raise();await f.tick();await f.restart();await f.settle();expect(f.send).not.toHaveBeenCalled();
 f.app.db.prepare("UPDATE core_effects SET state='started' WHERE id=?").run(`notifications:announcement:${f.attempts()[0].id}`);await f.restart();await f.settle();expect(f.attempts()[0].state).toBe('uncertain');expect(f.send).not.toHaveBeenCalled();
 f.raise('closing');await f.tick();f.send.mockImplementation((_s,_p,_o,signal)=>new Promise((_yes,no)=>signal.addEventListener('abort',()=>no(new Error('deadline')),{once:true})));
 for(const a of f.attempts().filter(a=>a.state==='queued'))expect(f.app.operations.call('direct',{kind:'member',id:'jonathan'},'core.releaseEffect',{id:`notifications:announcement:${a.id}`},`release-close`)).toMatchObject({ok:true});f.clock.advance(0);expect(f.send).toHaveBeenCalledOnce();
 let closed=false;const close=f.app.close().then(()=>{closed=true;});await Promise.resolve();expect(closed).toBe(false);f.clock.advance(15_000);await close;expect(closed).toBe(true);expect(f.send).toHaveBeenCalledOnce();
});
it('composes the real Comms role: unread not-in-front replies target only their member and reading cancels a held attempt',async()=>{
 const f=await setup(true,true);f.seed('other','pollock');
 const opened=await f.app.operations.callAsync('socket',{kind:'member',id:'jonathan'},'comms.open',{agent:'art',id:'aaaaaaaaaaaaaaaa',text:'PRIVATE message'},'open',true);expect(opened).toMatchObject({ok:true});
 const thread=(opened as {ok:true;value:{thread:string}}).value.thread;
 await f.comms.post('art',thread,{id:'reply',kind:'reply',text:'PRIVATE title and words'});
 await f.tick();await f.tick();expect(f.attempts()).toHaveLength(1);expect(f.send).not.toHaveBeenCalled();
 expect(await f.app.operations.callAsync('socket',{kind:'member',id:'jonathan'},'comms.change',{thread,action:'read',seq:2},'read',true)).toMatchObject({ok:true});await f.release();expect(f.send).not.toHaveBeenCalled();expect(f.attempts()[0].state).toBe('cancelled');
});
it('releasing one exact device leaves the other attempt held',async()=>{
 const f=await setup();f.seed('second');f.raise();await f.tick();expect(f.attempts()).toHaveLength(2);
 const one=f.attempts()[0];expect(f.app.operations.call('direct',{kind:'member',id:'jonathan'},'core.releaseEffect',{id:`notifications:announcement:${one.id}`},'one-only')).toMatchObject({ok:true});await f.settle();
 expect(f.send).toHaveBeenCalledOnce();expect(f.attempts().map(a=>a.state).sort()).toEqual(['queued','sent']);
 const held=f.attempts().find(a=>a.state==='queued')!;expect(f.app.effects!.status(`notifications:announcement:${held.id}`)).toBe('due');await f.tick();expect(f.send).toHaveBeenCalledOnce();await f.release();expect(f.send).toHaveBeenCalledTimes(2);
});
it.each(['queued','held','released'] as const)('resumes %s work successfully after restart exactly once',async kind=>{
 const f=await setup();f.raise();
 if(kind==='queued'){
   // Admission commits before the newly scheduled drain runs.
   // Consume startup's empty drain first so it cannot defer this new one.
   f.clock.advance(0);await Promise.resolve();await Promise.resolve();
   // A source is sampled at the minute boundary; a same-time close prevents IO.
   f.clock.at(f.clock.now()+60_000,()=>{void f.app.close();});f.clock.advance(60_000);
   await f.app.close();
 }else{
   await f.tick();
   if(kind==='released')expect(f.app.operations.call('direct',{kind:'member',id:'jonathan'},'core.releaseEffect',{id:`notifications:announcement:${f.attempts()[0].id}`},'release-before-restart')).toMatchObject({ok:true});
 }
 await f.restart();expect(f.attempts()).toHaveLength(1);
 expect(f.app.effects!.status(`notifications:announcement:${f.attempts()[0].id}`)).toBe(kind==='queued'?undefined:kind==='held'?'due':'released');
 await f.settle();
 if(kind==='queued'||kind==='held'){expect(f.send).not.toHaveBeenCalled();await f.release();}
 expect(f.send).toHaveBeenCalledOnce();expect(f.attempts()[0].state).toBe('sent');await f.restart();await f.tick();expect(f.send).toHaveBeenCalledOnce();
});
it.each(['device','member','reassigned','keys','generation','vapid'] as const)('rechecks next-device %s after await while the candidate stays eligible',async kind=>{
 const f=await setup(false);f.seed('second');let done!:(v:unknown)=>void;
 f.send.mockImplementationOnce(()=>new Promise(yes=>{done=yes;}));f.raise();f.clock.advance(60_000);await vi.waitFor(()=>{f.clock.advance(0);expect(f.send).toHaveBeenCalledOnce();});
 const first=f.send.mock.calls[0][0].endpoint,second=[sub().endpoint,sub('second').endpoint].find(ep=>ep!==first)!;
 if(kind==='member')f.app.db.transaction(()=>{changeHouseholdMember(f.app.db,'','pollock','*');changeHouseholdMember(f.app.db,'','jonathan');})();
 else f.s.sessions.change(file=>{const d=file.push!.subs![second];if(kind==='device')delete file.push!.subs![second];if(kind==='reassigned')d.member='pollock';if(kind==='keys')d.sub.keys.auth='b'.repeat(22);if(kind==='generation')(d as typeof d & {generation:string}).generation='replacement';if(kind==='vapid')file.push!.vapid=webpush.generateVAPIDKeys();});
 // Source remains open. Any cancellation now depends on policy/binding checks.
 expect(f.app.db.prepare("SELECT record FROM attention_asks WHERE id='question'").get()).toBeDefined();
 done({});await f.settle();expect(f.send).toHaveBeenCalledOnce();expect(f.attempts().map(a=>a.state).sort()).toEqual(['cancelled','sent']);
});
it('rolls back the whole admission sample on a failed write and retries without crashing the daemon',async()=>{
 const f=await setup(false);f.raise('one');f.raise('two');
 f.app.db.exec("CREATE TEMP TRIGGER fail_admission BEFORE INSERT ON notifications_announcement_attempts BEGIN SELECT RAISE(ABORT,'PRIVATE diagnostics'); END");
 await f.tick();expect(f.items()).toEqual([]);expect(f.attempts()).toEqual([]);expect(f.send).not.toHaveBeenCalled();
 f.app.db.exec('DROP TRIGGER fail_admission');await f.tick();expect(f.send).toHaveBeenCalledTimes(2);expect(f.items()).toHaveLength(2);
});
