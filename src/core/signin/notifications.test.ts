import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { WebSocket } from 'ws';
import { fixture } from '../../fixture.js';
import { startLoom } from '../../foundation.js';
import { FakeClock } from '../clock.js';
import { changeHouseholdMember } from '../household/members.js';
import { signin, hash } from './index.js';
import type { Viewer } from '../../policy.js';
const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const f of cleanup.splice(0).reverse())await f();});
const sub=(id='phone')=>({endpoint:`https://web.push.apple.com/${id}`,keys:{p256dh:'B'.repeat(87),auth:'a'.repeat(22)}});
const owner:Viewer={kind:'member',id:'jonathan'},other:Viewer={kind:'member',id:'pollock'};
async function setup(){
  const home=mkdtempSync(join(tmpdir(),'notifications-'));fixture(home);cleanup.push(()=>rmSync(home,{recursive:true,force:true}));
  const clock=new FakeClock(Date.parse('2026-11-12T12:00:00Z')),app=await startLoom({home,next:true,clock});cleanup.push(()=>app.close());const s=signin(app);
  for(const member of ['jonathan','pollock'])s.tokens.change(ts=>ts.push({role:'owner',member,label:member,sha256:hash(member),created:new Date(clock.now()).toISOString()}));
  const cookie=s.createSession(hash('jonathan'),{device:'Safari on iPhone'}),otherCookie=s.createSession(hash('pollock'),{device:'Firefox on Linux'});
  let sequence=0;
  const call=(name:string,input:unknown={},v:Viewer=owner,id=`call-${++sequence}`)=>app.operations.call('direct',v,`notifications.${name}`,input,id);
  const read=(v:Viewer=owner)=>{const r=call('read',{},v);if(!r.ok)throw Error(r.message);return r.value as {member:string;devices:Array<{ref:string;session:string;at:number;seenAt?:number;device?:string}>};};
  async function socket(id:string,bearer?:string){
    const ws=new WebSocket(app.url.replace('http:','ws:')+'/live',{headers:{cookie:`loom_ui=${id}`,origin:app.url,...(bearer?{authorization:`Bearer ${bearer}`}:{})}});cleanup.push(()=>ws.terminate());await once(ws,'open');
    return async(name:string,input:unknown={},request=`socket-${++sequence}`)=>{
      const response=new Promise<import('../operations/index.js').Result>(resolve=>{const listener=(raw:import('ws').RawData)=>{const m=JSON.parse(String(raw));if(m.kind==='result'&&m.request===request){ws.off('message',listener);resolve(m.result);}};ws.on('message',listener);});
      ws.send(JSON.stringify({kind:'call',request,id:request,name:`notifications.${name}`,input}));return response;
    };
  }
  return{app,s,clock,cookie,otherCookie,call,read,socket};
}
it('real cookie sockets register only their devices with safe private metadata and stable public VAPID',async()=>{
  const f=await setup(),a=await f.socket(f.cookie),b=await f.socket(f.otherCookie);
  const key=await a('key');expect(key).toMatchObject({ok:true,value:{publicKey:expect.any(String)}});expect(await b('key')).toEqual(key);
  expect(await a('subscribe',{sub:sub()})).toEqual({ok:true,value:{status:'added'}});expect(await b('subscribe',{sub:sub('other')})).toMatchObject({ok:true});
  const mine=f.read();expect(mine.devices).toHaveLength(1);expect(mine.devices[0]).toMatchObject({device:'Safari on iPhone',session:hash(`account-session:${hash(f.cookie)}`)});expect(f.read(other).devices).toHaveLength(1);
  for(const secret of [sub().endpoint,sub().keys.auth,sub().keys.p256dh,f.cookie,hash(f.cookie),hash('jonathan'),f.s.sessions.read().push!.vapid!.privateKey])expect(JSON.stringify(mine)).not.toContain(secret);
  expect(f.call('read',{member:'pollock'})).toMatchObject({ok:false,code:'invalid'});
  expect(f.call('remove',{ref:f.read(other).devices[0].ref})).toMatchObject({ok:false,code:'not-found'});
  expect(await a('unsubscribe',{sub:sub('other')})).toEqual({ok:true,value:{removed:false}});
  for(const v of [{kind:'agent',id:'art'},{kind:'service',id:'signin'},{kind:'runner',id:'one'},{kind:'member',id:'gone'}] as Viewer[])expect(f.call('read',{},v)).toMatchObject({ok:false,code:'denied'});
  const ws=new WebSocket(f.app.url.replace('http:','ws:')+'/live',{headers:{authorization:'Bearer jonathan'}});cleanup.push(()=>ws.terminate());await once(ws,'open');ws.send(JSON.stringify({kind:'subscribe',type:'notifications.devices'}));const first=JSON.parse(String((await once(ws,'message'))[0]));expect(first.records).toHaveLength(1);expect(first.records[0].member).toBe('jonathan');
  const change=once(ws,'message');expect(f.call('remove',{ref:mine.devices[0].ref})).toMatchObject({ok:true});expect(JSON.parse(String((await change)[0])).record.devices).toEqual([]);
});
it('refuses bearer plus cookie, synthetic viewers, other doors, headless and agent cookie sessions',async()=>{
  const f=await setup(),bearer=await f.socket(f.cookie,'jonathan');expect(await bearer('subscribe',{sub:sub()})).toMatchObject({ok:false,code:'denied'});expect(await bearer('key')).toMatchObject({ok:false,code:'denied'});
  for(const door of ['direct','http','mcp','socket'] as const)expect(await f.app.operations.callAsync(door,owner,'notifications.subscribe',{sub:sub()},'synthetic-'+door,true)).toMatchObject({ok:false,code:'denied'});
  for(const meta of [{agent:true as const},{device:'HeadlessChrome on Linux'}]){const id=f.s.createSession(hash('jonathan'),meta),call=await f.socket(id);expect(await call('subscribe',{sub:sub()})).toMatchObject({ok:false,code:'denied'});}
  const viewer=f.s.resolve({headers:{cookie:`loom_ui=${f.cookie}`},method:'GET',socket:{}} as IncomingMessage)!.viewer;f.s.end(f.cookie);expect(()=>f.s.notificationBrowser(viewer)).toThrow('signed-in browser');expect(f.read().devices).toEqual([]);
});
it('validates real push hosts, rejects URL credentials, ports, fragments, bad keys and caller device selectors',async()=>{
  const f=await setup(),a=await f.socket(f.cookie);
  for(const endpoint of ['http://fcm.googleapis.com/x','https://127.0.0.1/x','https://fcm.googleapis.com.evil.example/x','https://fcm.googleapis.com:8443/x','https://user:pass@fcm.googleapis.com/x','https://fcm.googleapis.com/x#secret'])expect(await a('subscribe',{sub:{...sub(),endpoint}})).toMatchObject({ok:false,code:'invalid'});
  for(const input of [{sub:{...sub(),keys:{auth:'x',p256dh:'x'}}},{sub:sub(),device:'Fake phone'},{sub:sub(),session:hash(f.cookie)},{sub:sub(),member:'pollock'}])expect(await a('subscribe',input)).toMatchObject({ok:false,code:'invalid'});
  expect(await a('subscribe',{sub:{...sub('browser-json'),expirationTime:null}})).toMatchObject({ok:true});expect(f.s.sessions.read().push!.subs![sub('browser-json').endpoint].sub).toEqual(sub('browser-json'));
  for(const host of ['fcm.googleapis.com','updates.push.services.mozilla.com','web.push.apple.com','wns2-by3p.notify.windows.com'])expect(await a('subscribe',{sub:{...sub(),endpoint:`https://${host}/valid`}})).toMatchObject({ok:true});
});
it('keeps device through logout, expiry and sign-in; remote removal blocks quiet again until explicit enable',async()=>{
  const f=await setup(),a=await f.socket(f.cookie);await a('subscribe',{sub:sub()});const first=f.read().devices[0];f.s.end(f.cookie);expect(f.read().devices[0]).toEqual(first);
  // Cap survival has an independent still-present subscribed-session case below.
  // Repeating 55 sign-ins after end() already deleted this session added SQLite
  // churn and advanced every daemon job without exercising another invariant.
  expect(f.s.sessions.read().sessions[hash(f.cookie)]).toBeUndefined();
  f.s.sessions.change(file=>{for(const session of Object.values(file.sessions))session.issuedAt-=31*86400;});expect(f.s.session(f.otherCookie)).toBeUndefined();expect(f.read().devices[0]).toEqual(first);
  const next=f.s.createSession(hash('jonathan'),{device:'Safari on iPhone'}),b=await f.socket(next);expect(await b('subscribe',{sub:sub(),again:true})).toMatchObject({ok:true});expect(f.read().devices[0]).toMatchObject({ref:first.ref,at:first.at,seenAt:f.s.now(),session:hash(`account-session:${hash(next)}`)});
  expect(f.call('remove',{ref:first.ref},owner,'remove')).toEqual({ok:true,value:{removed:true}});expect(await b('subscribe',{sub:sub(),again:true})).toEqual({ok:true,value:{status:'removed'}});expect(f.read().devices).toEqual([]);
  expect(await b('subscribe',{sub:sub()})).toMatchObject({ok:true,value:{status:'added'}});expect(f.s.sessions.read().push!.removed).toEqual([]);
  // Replaying the old receipt cannot delete a later explicit re-enable.
  expect(f.call('remove',{ref:first.ref},owner,'remove')).toMatchObject({ok:true});expect(f.read().devices).toHaveLength(1);
  expect(await b('unsubscribe',{sub:sub()})).toEqual({ok:true,value:{removed:true}});expect(f.read().devices).toEqual([]);
// This case creates/evicts 55 real database sessions. Its lifecycle assertions
  // use fake time; concurrent CI shard wall time is not the behavior under test.
},20_000);
it('requires explicit shared-device reassignment, resets ownership time and keeps other member private',async()=>{
  const f=await setup(),a=await f.socket(f.cookie),b=await f.socket(f.otherCookie);await a('subscribe',{sub:sub()});f.clock.advance(10_000);
  expect(await b('subscribe',{sub:sub(),again:true})).toMatchObject({ok:false,code:'denied'});expect(f.read().devices).toHaveLength(1);
  expect(await b('subscribe',{sub:sub()})).toMatchObject({ok:true});expect(f.read().devices).toEqual([]);expect(f.read(other).devices[0]).toMatchObject({at:f.s.now(),device:'Firefox on Linux'});expect(await a('unsubscribe',{sub:sub()})).toEqual({ok:true,value:{removed:false}});
});
it('resolves imported member-less devices from original token bindings, refuses orphans and ambiguous digests after owner rotation',async()=>{
  const f=await setup();f.s.tokens.change(ts=>ts.push({role:'owner',label:'legacy',sha256:hash('legacy'),created:'2026-01-01'}));
  const old=f.s.createSession(hash('legacy'));
  f.s.sessions.change(file=>{file.push={vapid:{publicKey:'imported-public',privateKey:'imported-private'},subs:{[sub().endpoint]:{sub:sub(),session:hash(old),at:7},[sub('orphan').endpoint]:{sub:sub('orphan'),session:'gone',at:8}}};});
  const browser=await f.socket(f.cookie);expect(await browser('key')).toEqual({ok:true,value:{publicKey:'imported-public'}});expect(f.s.sessions.read().push!.vapid).toEqual({publicKey:'imported-public',privateKey:'imported-private'});
  expect(f.read().devices).toHaveLength(1);
  f.s.end(old);expect(f.s.sessions.read().push!.subs![sub().endpoint].token).toBe(hash('legacy'));expect(f.read().devices).toHaveLength(1);
  // Membership changes pin revoked/unbound tokens before changing first owner.
  f.app.db.transaction(()=>{changeHouseholdMember(f.app.db,'','pollock','*');changeHouseholdMember(f.app.db,'','jonathan',['art']);})();
  expect(f.read().devices).toHaveLength(1);expect(f.read(other).devices).toEqual([]);
  f.s.tokens.change(ts=>{ts.find(t=>t.sha256===hash('legacy'))!.revoked='2026-01-01';});expect(f.read().devices).toHaveLength(1);
  f.s.tokens.change(ts=>ts.push({role:'owner',member:'pollock',label:'conflict',sha256:hash('legacy'),created:'2026-01-01'}));expect(f.read().devices).toEqual([]);expect(f.read(other).devices).toEqual([]);
  const active=await f.socket(f.cookie);for(let i=0;i<21;i++){f.clock.advance(1000);expect(await active('subscribe',{sub:sub('pressure-'+i)})).toMatchObject({ok:true});}
  const retained=f.s.sessions.read().push!;expect(retained.subs![sub().endpoint]).toBeDefined();expect(retained.subs![sub('orphan').endpoint]).toBeDefined();expect(Object.keys(retained.subs!)).toHaveLength(22);expect(f.read().devices).toHaveLength(20);
});
it('bounds devices at twenty and tombstones at one hundred; rollback includes keys, device, receipt and live changes',async()=>{
  const f=await setup(),a=await f.socket(f.cookie);await a('key');const changes:unknown[]=[];const stop=f.app.live.observe(c=>changes.push(c));
  const before=f.s.sessions.read();f.app.db.exec("CREATE TEMP TRIGGER fail_device BEFORE INSERT ON household_push WHEN NEW.id LIKE 'sub:%' BEGIN SELECT RAISE(ABORT,'fixture'); END");
  expect(await a('subscribe',{sub:sub()},'retry')).toMatchObject({ok:false,code:'unavailable'});expect(f.s.sessions.read()).toEqual(before);expect(f.app.db.prepare("SELECT * FROM core_operations WHERE id='retry'").get()).toBeUndefined();expect(changes).toEqual([]);f.app.db.exec('DROP TRIGGER fail_device');
  expect(await a('subscribe',{sub:sub()},'retry')).toMatchObject({ok:true});expect(await a('subscribe',{sub:sub()},'retry')).toMatchObject({ok:true});expect(f.read().devices).toHaveLength(1);
  for(let i=0;i<21;i++){f.clock.advance(1000);await a('subscribe',{sub:sub('cap-'+i)});}expect(f.read().devices).toHaveLength(20);expect(f.s.sessions.read().push!.subs![sub('cap-0').endpoint]).toBeUndefined();
  f.s.sessions.change(file=>{file.push!.removed=Array.from({length:100},(_,i)=>hash('old-'+i));});const target=f.read().devices[0].ref;expect(f.call('remove',{ref:target})).toMatchObject({ok:true});expect(f.s.sessions.read().push!.removed).toHaveLength(100);expect(f.s.sessions.read().push!.removed).not.toContain(hash('old-0'));stop();
});

it('rolls back first VAPID creation when its receipt fails and retries with a stable imported/generated pair',async()=>{
  const f=await setup(),a=await f.socket(f.cookie),before=f.s.sessions.read();
  f.app.db.exec("CREATE TEMP TRIGGER fail_key_receipt BEFORE INSERT ON core_operations WHEN NEW.id='key-retry' BEGIN SELECT RAISE(ABORT,'fixture'); END");
  expect(await a('key',{},'key-retry')).toMatchObject({ok:false,code:'unavailable'});expect(f.s.sessions.read()).toEqual(before);expect(f.app.db.prepare("SELECT * FROM core_operations WHERE id='key-retry'").get()).toBeUndefined();
  f.app.db.exec('DROP TRIGGER fail_key_receipt');const key=await a('key',{},'key-retry');expect(key).toMatchObject({ok:true});const pair=f.s.sessions.read().push!.vapid;expect(await a('key',{},'key-retry')).toEqual(key);expect(f.s.sessions.read().push!.vapid).toEqual(pair);
});
it('refreshes another member’s actual Live window after reassignment and household cap eviction',async()=>{
  const f=await setup(),a=await f.socket(f.cookie),b=await f.socket(f.otherCookie);await a('subscribe',{sub:sub()});
  const ws=new WebSocket(f.app.url.replace('http:','ws:')+'/live',{headers:{authorization:'Bearer jonathan'}});cleanup.push(()=>ws.terminate());await once(ws,'open');ws.send(JSON.stringify({kind:'subscribe',type:'notifications.devices'}));expect(JSON.parse(String((await once(ws,'message'))[0])).records[0].devices).toHaveLength(1);
  const reassigned=once(ws,'message');expect(await b('subscribe',{sub:sub()})).toMatchObject({ok:true});expect(JSON.parse(String((await reassigned)[0])).record.devices).toEqual([]);
  f.s.sessions.change(file=>{const subs=file.push!.subs!;for(const ep of Object.keys(subs))delete subs[ep];subs[sub().endpoint]={sub:sub(),member:'jonathan',session:hash(f.cookie),token:hash('jonathan'),at:0};for(let i=0;i<19;i++){const x=sub('other-'+i);subs[x.endpoint]={sub:x,member:'pollock',session:hash(f.otherCookie),token:hash('pollock'),at:f.s.now()};}});
  const repopulated=once(ws,'message');f.app.live.changed([{type:'notifications.devices',id:'jonathan'}]);expect(JSON.parse(String((await repopulated)[0])).record.devices).toHaveLength(1);
  const evicted=once(ws,'message');expect(await b('subscribe',{sub:sub('newest')})).toMatchObject({ok:true});expect(JSON.parse(String((await evicted)[0])).record.devices).toEqual([]);
});
it.each(['cap','expiry'] as const)('keeps an imported token-less device when its still-present session reaches %s',async mode=>{
  const f=await setup(),a=await f.socket(f.cookie);await a('subscribe',{sub:sub()});const first=f.read().devices[0];
  f.s.sessions.change(file=>{delete file.push!.subs![sub().endpoint].token;file.sessions[hash(f.cookie)].issuedAt=mode==='expiry'?f.s.now()-30*86400+1:f.s.now()-1;});
  expect(f.s.session(f.cookie)).toBeDefined();
  if(mode==='cap'){
    for(let i=0;i<51;i++)f.s.createSession(hash('jonathan'));
    expect(f.s.sessions.read().sessions[hash(f.cookie)]).toBeUndefined();expect(f.s.sessions.read().push!.subs![sub().endpoint].token).toBe(hash('jonathan'));
  }else{
    f.clock.advance(1000);expect(f.s.session(f.cookie)).toBeUndefined();expect(f.s.sessions.read().sessions[hash(f.cookie)]).toBeDefined();
  }
  expect(f.read().devices[0]).toEqual(first);
});
