import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import webpush from 'web-push';
import { fixture } from '../../fixture.js';
import { startLoom } from '../../foundation.js';
import { FakeClock } from '../clock.js';
import { signin,hash } from './index.js';
import { changeHouseholdMember } from '../household/members.js';
import { deviceRef } from './notifications.js';
import type { PushTransport } from './push-transport.js';
import type { Viewer } from '../../policy.js';
const clean:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const fn of clean.splice(0).reverse())await fn();});
const sub=(id='phone')=>({endpoint:`https://fcm.googleapis.com/${id}`,keys:{p256dh:'p'.repeat(87),auth:'a'.repeat(22)}});
async function setup(staging=true){
 const home=mkdtempSync(join(tmpdir(),'test-push-'));fixture(home);clean.push(()=>rmSync(home,{force:true,recursive:true}));
 const clock=new FakeClock(),send=vi.fn<PushTransport>().mockResolvedValue({statusCode:201,body:'',headers:{}});
 const options={home,next:true,clock,staging,notifications:{send},stdout:()=>{}};
 let app=await startLoom(options);clean.push(()=>app.close());let s=signin(app);
 s.tokens.change(ts=>ts.push({role:'owner',member:'jonathan',label:'test',sha256:hash('test'),created:new Date(clock.now()).toISOString()}));
 const cookie=s.createSession(hash('test'),{device:'Safari on iPhone'});
 const viewer=()=>s.resolve({headers:{cookie:`loom_ui=${cookie}`},method:'GET',socket:{}} as IncomingMessage)!.viewer;
 const seed=(id='phone',member='jonathan')=>s.sessions.change(f=>{f.push??={};f.push.vapid??=webpush.generateVAPIDKeys();f.push.subs??={};const x=sub(id);f.push.subs[x.endpoint]={sub:x,session:hash(cookie),token:hash('test'),member,at:s.now()};});seed();
 const queue=(ref=deviceRef(sub().endpoint),id='request',v=viewer())=>app.operations.callAsync('socket',v,'notifications.test',{ref},id,true);
 const requests=()=>app.db.prepare('SELECT * FROM notifications_tests ORDER BY id').all() as Array<{id:string;state:string;ref:string}>;
 const advance=async()=>{clock.advance(0);await vi.waitFor(()=>expect(requests().every(r=>r.state!=='queued'||app.effects!.status(`notifications:test:${r.id}`)==='due')).toBe(true));};
 const release=(id=requests()[0].id)=>{expect(app.operations.call('direct',{kind:'member',id:'jonathan'},'core.releaseEffect',{id:`notifications:test:${id}`},`release-${id}`)).toMatchObject({ok:true});clock.advance(0);};
 return {get app(){return app;},get s(){return s;},home,clock,send,cookie,viewer,seed,queue,requests,advance,release,async restart(){await app.close();app=await startLoom(options);s=signin(app);}};
}
it('queues atomically, holds every send, releases exactly once and exposes only safe private status',async()=>{
 const f=await setup(),pair=f.s.sessions.read().push!.vapid;
 const queued=await f.queue();expect(queued).toMatchObject({ok:true,value:{state:'queued'}});expect(await f.queue()).toEqual(queued);await f.advance();expect(f.send).not.toHaveBeenCalled();
 f.release();await vi.waitFor(()=>expect(f.requests()[0].state).toBe('sent'));
 expect(f.send).toHaveBeenCalledExactlyOnceWith(sub(),JSON.stringify({title:'loom',body:'',tag:'loom-test',url:'/p/account-preview'}),expect.objectContaining({vapidDetails:{subject:'mailto:loom@localhost',...pair},TTL:600,timeout:15000}),expect.any(AbortSignal));
 expect(await f.queue()).toEqual(queued);await f.advance();expect(f.send).toHaveBeenCalledOnce();
 const projection=JSON.stringify(f.app.db.prepare('SELECT result FROM core_operations').all());
 for(const secret of [sub().endpoint,sub().keys.auth,sub().keys.p256dh,pair!.privateKey])expect(projection).not.toContain(secret);
 await f.restart();await f.advance();expect(f.send).toHaveBeenCalledOnce();
});
it('requires an actual browser window and refuses a different member or an invalid imported subscription',async()=>{
 const f=await setup();f.seed('other','pollock');
 expect(await f.queue(deviceRef(sub('other').endpoint))).toMatchObject({ok:false,code:'not-found'});
 for(const v of [{kind:'member',id:'jonathan'},{kind:'agent',id:'art'},{kind:'service',id:'signin'},{kind:'runner',id:'one'}] as Viewer[])expect(await f.queue(undefined,'synthetic-'+v.kind,v)).toMatchObject({ok:false,code:'denied'});
 for(const door of ['direct','http','mcp'] as const)expect(await f.app.operations.callAsync(door,f.viewer(),'notifications.test',{ref:deviceRef(sub().endpoint)},door,true)).toMatchObject({ok:false,code:'denied'});
 f.s.sessions.change(file=>{file.push!.subs![sub().endpoint].sub.endpoint='https://localhost/private';});expect(await f.queue()).toMatchObject({ok:false,code:'not-found'});expect(f.requests()).toEqual([]);expect(f.send).not.toHaveBeenCalled();
});
it('rolls back a queued request when the operation receipt fails and resumes held requests after restart',async()=>{
 const f=await setup();f.app.db.exec("CREATE TEMP TRIGGER fail_test BEFORE INSERT ON core_operations WHEN NEW.id='request' BEGIN SELECT RAISE(ABORT,'fixture'); END");
 expect(await f.queue()).toMatchObject({ok:false,code:'unavailable'});expect(f.requests()).toEqual([]);expect(f.app.db.prepare('SELECT * FROM core_effects').all()).toEqual([]);
 f.app.db.exec('DROP TRIGGER fail_test');await f.queue();await f.advance();await f.restart();await f.advance();expect(f.send).not.toHaveBeenCalled();f.release();await vi.waitFor(()=>expect(f.send).toHaveBeenCalledOnce());
});
it.each(['removed','reassigned','keys','membership','vapid'] as const)('rechecks %s while held before release',async kind=>{
 const f=await setup();await f.queue();await f.advance();
 if(kind==='membership')expect(f.app.operations.call('direct',{kind:'member',id:'jonathan'},'core.releaseEffect',{id:`notifications:test:${f.requests()[0].id}`},'release')).toMatchObject({ok:true});
 if(kind==='membership')f.app.db.transaction(()=>{changeHouseholdMember(f.app.db,'','pollock','*');changeHouseholdMember(f.app.db,'','jonathan');})();
 else f.s.sessions.change(file=>{if(kind==='removed')delete file.push!.subs![sub().endpoint];if(kind==='reassigned')file.push!.subs![sub().endpoint].member='pollock';if(kind==='keys')file.push!.subs![sub().endpoint].sub.keys.auth='b'.repeat(22);if(kind==='vapid')file.push!.vapid=webpush.generateVAPIDKeys();});
 if(kind==='membership')f.clock.advance(0);else f.release();
 await vi.waitFor(()=>expect(f.requests()[0].state).toBe('cancelled'));expect(f.send).not.toHaveBeenCalled();
});
it('rechecks the next device after an awaited send and never deletes a new binding on late gone replies',async()=>{
 const f=await setup(false);f.seed('second');let done!:(x:Awaited<ReturnType<typeof webpush.sendNotification>>)=>void;
 f.send.mockImplementationOnce(()=>new Promise(r=>{done=r;}));await f.queue();f.clock.advance(1);await f.queue(deviceRef(sub('second').endpoint),'second');f.clock.advance(0);expect(f.send).toHaveBeenCalledOnce();
 f.s.sessions.change(file=>{delete file.push!.subs![sub('second').endpoint];});done({statusCode:201,headers:{},body:''});await vi.waitFor(()=>expect(f.requests().some(r=>r.state==='sent')).toBe(true));f.clock.advance(0);await vi.waitFor(()=>expect(f.requests().map(r=>r.state).sort()).toEqual(['cancelled','sent']));expect(f.send).toHaveBeenCalledOnce();
 let fail!:(x:unknown)=>void;f.send.mockImplementationOnce(()=>new Promise((_r,reject)=>{fail=reject;}));await f.queue(undefined,'late');f.clock.advance(0);expect(f.send).toHaveBeenCalledTimes(2);
 f.s.sessions.change(file=>{file.push!.subs![sub().endpoint].sub.keys.auth='b'.repeat(22);});fail({statusCode:410,body:'PRIVATE ERROR'});await vi.waitFor(()=>expect(f.requests().some(r=>r.state==='gone')).toBe(true));expect(f.s.sessions.read().push!.subs![sub().endpoint]).toBeDefined();
});
it.each([404,410,503,undefined])('handles status %s without leaking diagnostics or automatically retrying',async statusCode=>{
 const f=await setup(false);f.send.mockRejectedValue({statusCode,message:'PRIVATE ERROR',body:sub().endpoint});await f.queue();await f.advance();
 expect(f.requests()[0].state).toBe(statusCode===undefined?'uncertain':statusCode===503?'failed':'gone');expect(!!f.s.sessions.read().push!.subs![sub().endpoint]).toBe(statusCode===undefined||statusCode===503);
 await f.restart();await f.advance();expect(f.send).toHaveBeenCalledOnce();expect(JSON.stringify(f.app.db.prepare('SELECT * FROM notifications_tests').all())).not.toContain('PRIVATE ERROR');
});
it('marks interrupted effects uncertain on startup and drains in-flight IO before closing SQLite',async()=>{
 const f=await setup();await f.queue();await f.advance();const id=`notifications:test:${f.requests()[0].id}`;
 f.app.db.prepare("UPDATE core_effects SET state='started' WHERE id=?").run(id);await f.restart();await f.advance();expect(f.requests()[0].state).toBe('uncertain');expect(f.send).not.toHaveBeenCalled();
 await f.queue(undefined,'close');await f.advance();let done!:(x:Awaited<ReturnType<typeof webpush.sendNotification>>)=>void;f.send.mockImplementationOnce(()=>new Promise(r=>{done=r;}));const pending=f.requests().find(r=>r.state==='queued')!;f.release(pending.id);expect(f.send).toHaveBeenCalledOnce();
 let closed=false;const close=f.app.close().then(()=>{closed=true;});await Promise.resolve();expect(closed).toBe(false);done({statusCode:201,headers:{},body:''});await close;expect(closed).toBe(true);
});

it('a real cookie socket queues and follows private content-free Live status; another member sees nothing',async()=>{
 const f=await setup(),socket=async(headers:Record<string,string>)=>{const ws=new WebSocket(f.app.url.replace('http:','ws:')+'/live',{headers});clean.push(()=>ws.terminate());await once(ws,'open');return ws;};
 const ws=await socket({cookie:`loom_ui=${f.cookie}`,origin:f.app.url});
 ws.send(JSON.stringify({kind:'subscribe',type:'notifications.test'}));expect(JSON.parse(String((await once(ws,'message'))[0])).records).toEqual([]);
 const events:Record<string,unknown>[]=[];ws.on('message',raw=>events.push(JSON.parse(String(raw))));
 ws.send(JSON.stringify({kind:'call',name:'notifications.test',input:{ref:deviceRef(sub().endpoint)},id:'real-socket',request:'real-socket'}));
 await vi.waitFor(()=>expect(events.some(e=>e.kind==='result'&&(e.result as {ok:boolean}).ok)).toBe(true));
 await f.advance();f.release();await vi.waitFor(()=>expect(events.some(e=>(e.record as {state?:string}|undefined)?.state==='sent')).toBe(true));
 const ts=f.s.sessions.read();for(const secret of [sub().endpoint,sub().keys.auth,sub().keys.p256dh,ts.push!.vapid!.privateKey,f.cookie])expect(JSON.stringify(events)).not.toContain(secret);
 f.s.tokens.change(tokens=>tokens.push({role:'owner',member:'pollock',label:'other',sha256:hash('other'),created:new Date(f.clock.now()).toISOString()}));
 const other=await socket({authorization:'Bearer other'});other.send(JSON.stringify({kind:'subscribe',type:'notifications.test'}));expect(JSON.parse(String((await once(other,'message'))[0])).records).toEqual([]);
});

it('resumes a committed queued request before any effect exists',async()=>{
 const f=await setup();await f.queue();expect(f.app.db.prepare('SELECT * FROM core_effects').all()).toEqual([]);
 await f.restart();await f.advance();expect(f.send).not.toHaveBeenCalled();f.release();await vi.waitFor(()=>expect(f.requests()[0].state).toBe('sent'));expect(f.send).toHaveBeenCalledOnce();
});
it('same-second unregister and reenable of identical bytes survives a late 410',async()=>{
 const f=await setup(false),register=()=>f.app.operations.callAsync('socket',f.viewer(),'notifications.subscribe',{sub:sub()},`register-${++serial}`,true);let serial=0;
 expect(await register()).toMatchObject({ok:true});const before=f.s.sessions.read().push!.subs![sub().endpoint];
 let reject!:(e:unknown)=>void;f.send.mockImplementationOnce(()=>new Promise((_r,no)=>{reject=no;}));await f.queue();f.clock.advance(0);expect(f.send).toHaveBeenCalledOnce();
 expect(await f.app.operations.callAsync('socket',f.viewer(),'notifications.unsubscribe',{sub:sub()},'unregister',true)).toMatchObject({ok:true});expect(await register()).toMatchObject({ok:true});
 const after=f.s.sessions.read().push!.subs![sub().endpoint];expect(after.at).toBe(before.at);expect(after.sub).toEqual(before.sub);
 reject({statusCode:410});await vi.waitFor(()=>expect(f.requests()[0].state).toBe('gone'));expect(f.s.sessions.read().push!.subs![sub().endpoint]).toEqual(after);
});
it('transport deadline releases shutdown and queued requests never start during close',async()=>{
 const f=await setup(false);f.seed('second');
 let signal!:AbortSignal;
 f.send.mockImplementation((_sub,_payload,_options,abort)=>new Promise((_yes,no)=>{signal=abort;abort.addEventListener('abort',()=>no(new Error('PRIVATE timeout')),{once:true});}));
 await f.queue();f.clock.advance(1);await f.queue(deviceRef(sub('second').endpoint),'second');expect(f.send).toHaveBeenCalledOnce();
 let closed=false;const closing=f.app.close().then(()=>{closed=true;});f.clock.advance(14_998);await Promise.resolve();expect(closed).toBe(false);expect(signal.aborted).toBe(false);
 expect(await f.queue(undefined,'during-close')).toMatchObject({ok:false,code:'denied'});f.clock.advance(1);await closing;expect(signal.aborted).toBe(true);
 expect(closed).toBe(true);expect(f.send).toHaveBeenCalledOnce();
});

it('rechecks changed VAPID pair after a preceding awaited send',async()=>{
 const f=await setup(false);f.seed('second');let done!:(x:unknown)=>void;
 f.send.mockImplementationOnce(()=>new Promise(r=>{done=r;}));await f.queue();f.clock.advance(1);await f.queue(deviceRef(sub('second').endpoint),'second');
 f.s.sessions.change(file=>{file.push!.vapid=webpush.generateVAPIDKeys();});done({});await vi.waitFor(()=>expect(f.requests().some(r=>r.state==='sent')).toBe(true));f.clock.advance(0);
 await vi.waitFor(()=>expect(f.requests().map(r=>r.state).sort()).toEqual(['cancelled','sent']));expect(f.send).toHaveBeenCalledOnce();
});
