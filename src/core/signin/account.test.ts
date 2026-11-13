import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from '../../fixture.js';
import { startLoom } from '../../foundation.js';
import { FakeClock } from '../clock.js';
import { signin, hash } from './index.js';
import type { Viewer } from '../../policy.js';
const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const f of cleanup.splice(0).reverse())await f();});
const owner:Viewer={kind:'member',id:'jonathan'},pollock:Viewer={kind:'member',id:'pollock'};
async function setup(){
  const home=mkdtempSync(join(tmpdir(),'account-'));fixture(home);cleanup.push(()=>rmSync(home,{recursive:true,force:true}));
  const clock=new FakeClock(),app=await startLoom({home,next:true,clock});cleanup.push(()=>app.close());const s=signin(app);
  s.tokens.change(tokens=>{for(const member of ['jonathan','pollock'])for(const name of ['root','child','grand'])tokens.push({role:'owner',member,label:name,sha256:hash(member+name),created:'2026-01-01',passkey:hash(member+name),...(name==='root'?{}:{from_sha256:hash(member+(name==='child'?'root':'child'))})});});
  s.sessions.change(f=>{f.passkeys={};for(const member of ['jonathan','pollock'])for(const name of ['root','child','grand']){const id=member+name;f.passkeys![id]={id,secret:hash(id),publicKey:'private-publickey-witness',counter:0,alg:-7,label:name,created:0};}});
  const jonathan=s.createSession(hash('jonathanroot'),{device:'Phone'}),other=s.createSession(hash('pollockroot'),{device:'Other phone'});
  const call=(name:string,input:unknown={},id?:string,v:Viewer=owner)=>app.operations.call('direct',v,`account.${name}`,input,id);
  const read=(v:Viewer=owner)=>{const r=call('read',{},undefined,v);if(!r.ok)throw Error(r.message);return r.value as {member:string;passkeys:Array<{ref:string;label:string;made:number;ended:boolean}>;sessions:Array<{ref:string;device:string;ended:boolean}>};};
  return {app,s,call,read,jonathan,other,clock};
}
it('projects only own safe metadata, excludes other people even for household owners and denies nonmembers',async()=>{
  const f=await setup(),a=f.read(),b=f.read(pollock);
  expect(a.member).toBe('jonathan');expect(a.passkeys).toHaveLength(3);expect(a.sessions).toHaveLength(1);expect(a.passkeys.find(k=>k.label==='root')?.made).toBe(2);expect(a.sessions[0].device).toBe('Phone');expect(b.sessions[0].device).toBe('Other phone');
  for(const marker of ['private-publickey-witness',hash('jonathanroot'),'jonathanroot',hash(f.jonathan),'pollock'])expect(JSON.stringify(a)).not.toContain(marker);
  for(const v of [{kind:'agent',id:'art'},{kind:'runner',id:'one'},{kind:'service',id:'signin'},{kind:'member',id:'gone'}] as Viewer[])expect(f.call('read',{},undefined,v)).toMatchObject({ok:false,code:'denied'});
  expect(f.call('read',{member:'pollock'})).toMatchObject({ok:false,code:'invalid'});
  expect(f.call('removePasskey',{ref:b.passkeys[0].ref},'foreign')).toMatchObject({ok:false,code:'not-found'});
  expect(f.call('revokeSession',{ref:b.sessions[0].ref},'foreign-session')).toMatchObject({ok:false,code:'not-found'});
  expect(f.s.session(f.other)).toBeDefined();
});
it('removes a passkey and revokes its own token, keeps descendants unless selected and never matches labels',async()=>{
  const f=await setup(),root=f.read().passkeys.find(k=>k.label==='root')!;
  expect(f.call('removePasskey',{ref:root.ref},'remove')).toEqual({ok:true,value:{removed:1,revoked:1}});
  expect(f.s.session(f.jonathan)).toBeUndefined();expect(f.s.session(f.other)).toBeDefined();expect(f.s.token(hash('jonathanchild'))).toBeDefined();expect(f.read().passkeys.map(k=>k.label)).toEqual(['child','grand']);expect(f.read(pollock).passkeys).toHaveLength(3);
  const child=f.read().passkeys.find(k=>k.label==='child')!;
  expect(f.call('removePasskey',{ref:child.ref,withMade:true},'cascade')).toEqual({ok:true,value:{removed:2,revoked:2}});
  expect(f.s.token(hash('jonathangrand'))).toBeUndefined();expect(f.read().passkeys).toEqual([]);expect(f.read(pollock).passkeys).toHaveLength(3);
  expect(f.call('removePasskey',{ref:root.ref},'remove')).toEqual({ok:true,value:{removed:1,revoked:1}});
});
it('removes a legacy shared-token key without revoking its links token and refuses stale replacement refs',async()=>{
  const f=await setup();f.s.tokens.change(ts=>ts.push({role:'owner',member:'jonathan',label:'links',sha256:hash('links'),created:'2026-01-01'}));
  f.s.tokens.change(ts=>ts.push({role:'owner',member:'jonathan',label:'linked',sha256:hash('linked'),passkey:hash('linked'),from_sha256:hash('links'),created:'2026-01-01'}));
  const key={id:'legacy',secret:hash('links'),publicKey:'key',counter:0,alg:-7,label:'legacy',created:0};f.s.sessions.change(x=>{x.passkeys!.legacy=key;x.passkeys!.sibling={...key,id:'sibling',label:'Sibling'};x.passkeys!.linked={...key,id:'linked',secret:hash('linked'),label:'Linked'};});
  const before=f.read().passkeys.find(k=>k.label==='legacy')!;expect(before.made).toBe(0);
  expect(f.call('removePasskey',{ref:before.ref,withMade:true},'legacy')).toEqual({ok:true,value:{removed:1,revoked:0}});expect(f.s.token(hash('links'))).toBeDefined();expect(f.s.sessions.read().passkeys!.sibling).toEqual({...key,id:'sibling',label:'Sibling'});expect(f.s.sessions.read().passkeys!.linked).toBeDefined();
  f.s.sessions.change(x=>{x.passkeys!.legacy={...key,secret:hash('jonathanchild')};});
  expect(f.call('removePasskey',{ref:before.ref},'stale')).toMatchObject({ok:false,code:'not-found'});expect(f.s.sessions.read().passkeys!.legacy).toBeDefined();
});
it('rolls back credentials and receipts together, then retries after failure without replaying the cascade',async()=>{
  const f=await setup(),root=f.read().passkeys.find(k=>k.label==='root')!,before={tokens:f.s.tokens.document(),sessions:f.s.sessions.read()};
  f.app.db.exec("CREATE TEMP TRIGGER fail_key_remove BEFORE DELETE ON household_passkeys BEGIN SELECT RAISE(ABORT,'fixture'); END");
  expect(f.call('removePasskey',{ref:root.ref,withMade:true},'retry')).toMatchObject({ok:false,code:'unavailable'});expect({tokens:f.s.tokens.document(),sessions:f.s.sessions.read()}).toEqual(before);
  expect(f.app.db.prepare("SELECT count(*) AS n FROM core_operations WHERE id='retry'").get()).toEqual({n:0});f.app.db.exec('DROP TRIGGER fail_key_remove');
  expect(f.call('removePasskey',{ref:root.ref,withMade:true},'retry')).toEqual({ok:true,value:{removed:3,revoked:3}});
  expect(f.call('removePasskey',{ref:root.ref,withMade:true},'retry')).toEqual({ok:true,value:{removed:3,revoked:3}});
});
it('ends exactly the selected own session and stops only its devices atomically',async()=>{
  const f=await setup(),sibling=f.s.createSession(hash('jonathanroot'),{device:'Same-token sibling'});f.s.sessions.change(x=>{x.push={subs:{sibling:{session:hash(sibling),at:0,sub:{endpoint:'sibling',keys:{auth:'a',p256dh:'p'}}},mine:{session:hash(f.jonathan),at:0,sub:{endpoint:'mine',keys:{auth:'private',p256dh:'private'}}},other:{session:hash(f.other),at:0,sub:{endpoint:'other',keys:{auth:'private',p256dh:'private'}}}}};});
  const ref=f.read().sessions.find(x=>x.device==='Phone')!.ref;
  expect(f.call('revokeSession',{ref},'end')).toEqual({ok:true,value:{revoked:true,devices:1}});expect(f.s.session(f.jonathan)).toBeUndefined();expect(f.s.session(f.other)).toBeDefined();expect(Object.keys(f.s.sessions.read().push!.subs!).sort()).toEqual(['other','sibling']);expect(f.s.session(sibling)).toBeDefined();
  expect(f.s.token(hash('jonathanroot'))).toBeDefined();expect(f.call('revokeSession',{ref},'end')).toEqual({ok:true,value:{revoked:true,devices:1}});
});
it('serves safe private Live records, refreshes usage/expiry and evicts removed members',async()=>{
  const {WebSocket}=await import('ws'),{once}=await import('node:events');
  const f=await setup();f.s.tokens.change(ts=>{ts.push({role:'owner',member:'jonathan',label:'socket',sha256:hash('socket'),created:'2026-01-01'});});
  f.s.sessions.change(x=>{x.sessions[hash(f.jonathan)].issuedAt=f.s.now()-30*86400+1;});
  const ws=new WebSocket(f.app.url.replace('http:','ws:')+'/live',{headers:{authorization:'Bearer socket'}});cleanup.push(()=>ws.terminate());await once(ws,'open');
  ws.send(JSON.stringify({kind:'subscribe',type:'account.self'}));const first=JSON.parse((await once(ws,'message'))[0].toString());expect(first.records).toHaveLength(1);expect(first.records[0].member).toBe('jonathan');expect(first.records[0].sessions[0].ended).toBe(false);
  const changed=once(ws,'message');f.clock.advance(1000);const update=JSON.parse((await changed)[0].toString());expect(update.record.sessions[0].ended).toBe(true);
  expect(first.records[0].passkeys).toHaveLength(3);expect(JSON.stringify(first)).not.toContain('private-publickey-witness');
  const gone=once(ws,'close');const {HouseholdDatabase}=await import('../household/document.js');new HouseholdDatabase(f.app.db).change('',h=>{h.members=(h.members as Array<{person:string}>).filter(m=>m.person!=='jonathan').map(m=>({...m,role:'owner',agents:'*'}));});f.app.live.changed([{type:'core.access',id:'credentials'}]);await gone;
});
it('generates the API client from registry metadata and preserves one id after a lost response',async()=>{
  const {runAccessClient}=await import('../../cli/access-client.js'),{Readable}=await import('node:stream'),{writeFileSync}=await import('node:fs'),{accountCommands}=await import('./account-commands.js');
  const f=await setup();f.s.tokens.change(ts=>ts.push({role:'owner',member:'jonathan',label:'client',sha256:hash('client'),created:'2026-01-01'}));
  const file=join(tmpdir(),`account-client-${process.pid}-${Math.random()}`);writeFileSync(file,'client');cleanup.push(()=>rmSync(file,{force:true}));
  expect(f.app.operations.offered('http').filter(x=>x.name.startsWith('account.')).map(x=>x.cli)).toEqual(accountCommands());
  let stdout='',stderr='',calls=0;const bodies:string[]=[];
  const io={stdin:Readable.from([]),stdinIsTTY:false,env:{LOOM_URL:f.app.url,LOOM_TOKEN_FILE:file},stdout:(s:string)=>stdout+=s,stderr:(s:string)=>stderr+=s};
  const ref=f.read().sessions[0].ref;
  expect(await runAccessClient('account',['revokeSession',JSON.stringify({ref})],io,{request:async(url,init)=>{calls++;bodies.push(String(init?.body));const r=await fetch(url,init);if(calls===1){await r.body?.cancel();throw Error('client');}return r;},retry:async()=>{}})).toBe(0);
  expect(calls).toBe(2);expect(new Set(bodies).size).toBe(1);expect(JSON.parse(stdout)).toEqual({revoked:true,devices:0});expect(stderr).toBe('');
  expect(await runAccessClient('account',['--help'],{...io,env:{}},{request:async()=>{throw Error('unexpected');},retry:async()=>{}})).toBe(0);
});
it('never follows ancestry into another member or revokes an ambiguously shared digest',async()=>{
  const f=await setup();f.s.tokens.change(ts=>{
    ts.find(t=>t.sha256===hash('pollockroot'))!.from_sha256=hash('jonathanroot');
    ts.push({role:'owner',member:'pollock',label:'ambiguous',sha256:hash('jonathangrand'),created:'2026-01-01'});
  });
  expect(f.read().passkeys.map(k=>k.label).sort()).toEqual(['child','root']);
  const root=f.read().passkeys.find(k=>k.label==='root')!;
  expect(f.call('removePasskey',{ref:root.ref,withMade:true},'line')).toEqual({ok:true,value:{removed:2,revoked:2}});
  expect(f.s.session(f.other)).toBeDefined();expect(f.s.sessions.read().passkeys!.pollockroot).toBeDefined();expect(f.s.sessions.read().passkeys!.jonathangrand).toBeDefined();expect(f.s.tokens.records(hash('jonathangrand')).every(t=>!t.revoked)).toBe(true);
});
it('rolls back session/device removal and its receipt if the last device write fails',async()=>{
  const f=await setup();f.s.sessions.change(x=>{x.push={subs:{mine:{session:hash(f.jonathan),at:0,sub:{endpoint:'mine',keys:{auth:'a',p256dh:'p'}}}}};});
  const ref=f.read().sessions[0].ref,before=f.s.sessions.read();f.app.db.exec("CREATE TEMP TRIGGER fail_push_remove BEFORE DELETE ON household_push BEGIN SELECT RAISE(ABORT,'fixture'); END");
  expect(f.call('revokeSession',{ref},'rollback-session')).toMatchObject({ok:false,code:'unavailable'});expect(f.s.sessions.read()).toEqual(before);expect(f.app.db.prepare("SELECT count(*) AS n FROM core_operations WHERE id='rollback-session'").get()).toEqual({n:0});
  f.app.db.exec('DROP TRIGGER fail_push_remove');expect(f.call('revokeSession',{ref},'rollback-session')).toEqual({ok:true,value:{revoked:true,devices:1}});
});
it('refreshes Account browser usage through signin.admin without core.access churn',async()=>{
  const {WebSocket}=await import('ws'),{once}=await import('node:events');const f=await setup();
  f.s.tokens.change(ts=>ts.push({role:'owner',member:'jonathan',label:'usage-socket',sha256:hash('usage-socket'),created:'2026-01-01'}));
  const ws=new WebSocket(f.app.url.replace('http:','ws:')+'/live',{headers:{authorization:'Bearer usage-socket'}});cleanup.push(()=>ws.terminate());await once(ws,'open');
  ws.send(JSON.stringify({kind:'subscribe',type:'account.self'}));const first=JSON.parse((await once(ws,'message'))[0].toString());const ref=f.read().sessions[0].ref;
  expect(first.records[0].sessions.find((x:{ref:string})=>x.ref===ref).seenAt).toBeUndefined();
  const updated=new Promise<Record<string,unknown>>(resolve=>{const listener=(data:Buffer)=>{const event=JSON.parse(data.toString());const record=event.record??event.records?.[0];if(record?.sessions?.some((x:{ref:string;seenAt?:number})=>x.ref===ref&&x.seenAt===f.s.now())){ws.off('message',listener);resolve(record);}};ws.on('message',listener);});
  const changes:string[]=[];const stop=f.app.live.observe(cs=>changes.push(...cs.map(c=>c.type)));expect(f.s.session(f.jonathan,true)).toBeDefined();await updated;stop();expect(changes).toContain('signin.admin');expect(changes).not.toContain('core.access');
});
it.each(['removePasskey','revokeSession'] as const)('%s closes the target authenticated socket while its own sibling stays connected',async operation=>{
  const {WebSocket}=await import('ws'),{once}=await import('node:events');const f=await setup();
  const siblingCookie=f.s.createSession(hash(operation==='removePasskey'?'jonathanchild':'jonathanroot'),{device:'Sibling'});
  const open=async(cookie:string)=>{const ws=new WebSocket(f.app.url.replace('http:','ws:')+'/live',{headers:{cookie:`loom_ui=${cookie}`,origin:f.app.url}});cleanup.push(()=>ws.terminate());await once(ws,'open');return ws;};
  const target=await open(f.jonathan),sibling=await open(siblingCookie),closed=once(target,'close');
  const ref=operation==='removePasskey'?f.read().passkeys.find(k=>k.label==='root')!.ref:f.read().sessions.find(x=>x.device==='Phone')!.ref;
  expect(f.call(operation,{ref},`close-${operation}`).ok).toBe(true);await closed;expect(sibling.readyState).toBe(WebSocket.OPEN);expect(f.s.session(siblingCookie)).toBeDefined();
  sibling.send(JSON.stringify({kind:'subscribe',type:'account.self'}));expect(JSON.parse((await once(sibling,'message'))[0].toString()).records[0].member).toBe('jonathan');
});
