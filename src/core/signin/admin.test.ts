import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { startLoom } from '../../foundation.js';
import { fixture, installFixture } from '../../fixture.js';
import { FakeClock } from '../clock.js';
import { signin, hash } from './index.js';
import { runAccessClient } from '../../cli/access-client.js';
import { accessCommands } from './commands.js';
const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const owner={kind:'member' as const,id:'jonathan'};
async function setup(){
  const home=mkdtempSync(join(tmpdir(),'access-admin-'));fixture(home);
  cleanup.push(()=>rmSync(home,{recursive:true,force:true}));
  const clock=new FakeClock();
  const app=await startLoom({home,next:true,clock,install:installFixture});cleanup.push(()=>app.close());
  const s=signin(app);app.db.transaction(()=>s.tokens.replace({v:1,tokens:[{label:'operator',role:'owner',member:'jonathan',sha256:hash('operator-bearer'),created:new Date(clock.now()).toISOString()}]},{}))();
  const call=(name:string,input:unknown={},id?:string)=>app.operations.call('direct',owner,name,input,id);
  const file=join(home,'client-token');writeFileSync(file,'operator-bearer');
  const client=async(piece:'token'|'sessions',args:string[],request:typeof fetch=fetch,env:NodeJS.ProcessEnv={LOOM_URL:app.url,LOOM_TOKEN_FILE:file,LOOM_HOME:'/missing'})=>{
    let stdout='',stderr='',now=0,calls=0;const bodies:string[]=[];
    const code=await runAccessClient(piece,args,{stdin:Readable.from([]),stdinIsTTY:false,env,stdout:t=>stdout+=t,stderr:t=>stderr+=t},{request:(url,init)=>{calls++;bodies.push(String(init?.body));return request(url,init);},retry:async ms=>{now+=ms;},now:()=>now});
    return {code,stdout,stderr,calls,bodies};
  };
  return {app,s,clock,call,client,home,file};
}
it('mints only supported identities, returns the bearer once, and never journals a credential',async()=>{
  const f=await setup();
  for(const input of [{role:'owner'},{role:'owner',member:'missing'},{role:'agent',agent:'missing'},{role:'service',principal:'absent'},{role:'peer',principal:'peer'},{role:'owner',member:'jonathan',agent:'art'},{role:'agent',agent:'art',expires:new Date(f.clock.now()-1).toISOString()}])expect(f.call('token.create',{label:'bad',...input})).toMatchObject({ok:false});
  expect(f.call('signin.setPrincipal',{kind:'service',id:'clock',active:true},'principal')).toMatchObject({ok:true});
  expect(f.call('signin.setPrincipal',{kind:'runner',id:'box',active:true},'runner-principal')).toMatchObject({ok:true});
  const grants=()=>({secrets:f.app.db.prepare('SELECT * FROM secrets_grants ORDER BY id').all(),runtime:f.app.db.prepare('SELECT * FROM runtime_settings ORDER BY id').all()});
  const grantsBefore=grants();
  const runnerBefore=f.app.db.prepare("SELECT body FROM household_settings WHERE id='signin-principal:runner:box'").get();
  for(const input of [{role:'runner',principal:'box'},{role:'owner',member:'pollock'},{role:'agent',agent:'art',service:'build',house:'house'},{role:'service',principal:'clock'}]){
    const r=f.call('token.create',{...input,label:input.role});expect(r.ok).toBe(true);if(!r.ok)throw Error();
    const {token,record}=r.value as {token:string;record:object};expect(f.s.token(hash(token))).toBeDefined();
    expect(JSON.stringify(record)).not.toContain(hash(token));
    const dump=JSON.stringify(f.app.db.prepare('SELECT * FROM core_operations').all());expect(dump).not.toContain(token);expect(dump).not.toContain(hash(token));
    expect(f.app.db.prepare("SELECT body FROM household_settings WHERE id='signin-principal:runner:box'").get()).toEqual(runnerBefore);
    expect(grants()).toEqual(grantsBefore);
    if(input.role==='runner'){
      expect(f.s.token(hash(token))).toEqual({viewer:{kind:'runner',id:'box'}});
      const denied=await fetch(f.app.url+'/api/token/list',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:'{"input":{}}'});expect(denied.status).toBe(403);await denied.body?.cancel();
    }
    expect(f.call('token.create',{...input,label:input.role})).toMatchObject({ok:false,code:'conflict'});
  }
  for(const viewer of [{kind:'member',id:'pollock'},{kind:'agent',id:'art'},{kind:'runner',id:'box'},{kind:'service',id:'clock'}] as const){
    for(const name of ['token.list','token.create','token.revoke','sessions.list','sessions.revoke'])expect(f.app.operations.call('direct',viewer,name,name==='token.create'?{label:'x',role:'owner',member:'jonathan'}:name==='token.revoke'?{label:'operator'}:name==='sessions.revoke'?{label:'x'}:{},'denied')).toMatchObject({ok:false,code:'denied'});
  }
  const list=f.call('token.list');expect(list.ok).toBe(true);expect(JSON.stringify(list)).not.toContain(hash('operator-bearer'));
});
it('revokes one session and its device, refuses ambiguous refs, and leaves human sessions when ending agent labels',async()=>{
  const f=await setup(),secret=hash('operator-bearer');
  const a=f.s.createSession(secret,{label:'screens',agent:true}),b=f.s.createSession(secret,{label:'screens'}),c=f.s.createSession(secret,{label:'screens',device:'HeadlessChrome on Linux'});
  const device=(id:string)=>({session:hash(id),token:secret,at:0,sub:{endpoint:'https://push.invalid/'+id,keys:{auth:'auth',p256dh:'key'}}});
  f.s.sessions.change(x=>{x.push={subs:{a:device(a),b:device(b),c:device(c)}};});
  const ref=hash(b).slice(0,16);
  f.s.sessions.change(x=>{x.sessions[ref+'0'.repeat(48)]={issuedAt:f.s.now(),secret};});
  expect(f.call('sessions.revoke',{ref},'ambiguous')).toMatchObject({ok:false,code:'not-found'});expect(f.s.session(b)).toBeDefined();
  f.s.sessions.change(x=>{delete x.sessions[ref+'0'.repeat(48)];});
  expect(f.call('sessions.revoke',{label:'screens'},'agents')).toEqual({ok:true,value:{revoked:2,devices:2}});
  expect(f.s.session(a)).toBeUndefined();expect(f.s.session(c)).toBeUndefined();expect(f.s.session(b)).toBeDefined();
  expect(f.call('sessions.revoke',{ref},'one')).toEqual({ok:true,value:{revoked:1,devices:1}});
  expect(f.call('sessions.revoke',{ref},'one')).toEqual({ok:true,value:{revoked:1,devices:1}});
  expect(f.call('sessions.revoke',{label:'screens'},'one')).toMatchObject({ok:false,code:'conflict'});
  expect(f.s.sessions.read().push?.subs).toEqual({});
});
it('projects only safe metadata and invalidates an authenticated socket immediately on session revocation',async()=>{
  const f=await setup(),secret=hash('operator-bearer'),cookie=f.s.createSession(secret,{device:'Phone',label:'phone'});
  const ws=new WebSocket(f.app.url.replace('http:','ws:')+'/live',{headers:{cookie:`loom_ui=${cookie}`,origin:f.app.url}});cleanup.push(()=>ws.terminate());await once(ws,'open');
  ws.send(JSON.stringify({kind:'subscribe',type:'signin.admin'}));const set=JSON.parse((await once(ws,'message'))[0].toString());expect(set.kind).toBe('set');
  for(const value of [secret,cookie,hash(cookie),'publicKey','sha256'])expect(JSON.stringify(set)).not.toContain(value);
  const closed=once(ws,'close');expect(f.call('sessions.revoke',{ref:hash(cookie).slice(0,16)},'socket')).toMatchObject({ok:true});expect((await closed)[0]).toBe(1008);
});
it('plain token revoke preserves descendant passkeys and devices; compromise takes the full line atomically',async()=>{
  const f=await setup(),root=hash('operator-bearer'),child=hash('child'),grand=hash('grand');
  f.s.tokens.change(x=>{x.push({role:'owner',member:'jonathan',label:'child',sha256:child,passkey:hash('credential-child'),from_sha256:root,created:'2026-01-01'},{role:'owner',member:'jonathan',label:'grand',sha256:grand,passkey:hash('credential-grand'),from_sha256:child,created:'2026-01-01'});});
  const a=f.s.createSession(root),b=f.s.createSession(child),c=f.s.createSession(grand);
  f.s.sessions.change(x=>{x.passkeys={child:{id:'child',secret:child,publicKey:'private-witness',counter:0,alg:-7,label:'child',created:0},grand:{id:'grand',secret:grand,publicKey:'key',counter:0,alg:-7,label:'grand',created:0}};x.push={subs:{a:{session:hash(a),token:root,at:0,sub:{endpoint:'a',keys:{auth:'a',p256dh:'a'}}},b:{session:hash(b),at:0,sub:{endpoint:'b',keys:{auth:'b',p256dh:'b'}}},c:{session:hash(c),token:grand,at:0,sub:{endpoint:'c',keys:{auth:'c',p256dh:'c'}}}}};});
  expect(f.call('token.revoke',{label:'operator'},'plain')).toEqual({ok:true,value:{revoked:1,passkeys:2,devices:0}});
  expect(f.s.session(a)).toBeUndefined();expect(f.s.session(b)).toBeDefined();expect(Object.keys(f.s.sessions.read().push!.subs!)).toHaveLength(3);
  expect(f.call('token.revoke',{label:'child',withPasskeys:true},'compromised')).toEqual({ok:true,value:{revoked:2,passkeys:1,devices:2}});
  expect(f.s.session(c)).toBeUndefined();expect(Object.keys(f.s.sessions.read().passkeys!)).toEqual(['child']);
  expect(f.s.sessions.read().push!.subs!.a).toBeDefined();
});
it('generates both clients, never retries minting, and retries revocation with one stable id',async()=>{
  const f=await setup();
  for(const piece of ['token','sessions'] as const){expect(f.app.operations.offered('http').filter(x=>x.name.startsWith(piece+'.')).map(x=>x.cli)).toEqual(accessCommands(piece));expect((await f.client(piece,['--help'])).stdout).toContain('revoke');expect(await f.client(piece,['list','{}'])).toMatchObject({code:0,stderr:''});}
  const minted=await f.client('token',['create','{"role":"agent","agent":"art","label":"remote"}']);expect(minted.code).toBe(0);expect(minted.stdout).toMatch(/^loom_\S+\n$/);expect(f.s.token(hash(minted.stdout.trim()))).toEqual({viewer:{kind:'agent',id:'art'}});
  const failed=await f.client('token',['create','{"role":"agent","agent":"art","label":"lost"}'],async(url,init)=>{const r=await fetch(url,init);await r.body?.cancel();throw Error('operator-bearer');});expect(failed).toMatchObject({code:1,calls:1,stdout:''});expect(failed.stderr).not.toContain('operator-bearer');
  let n=0;const retry=await f.client('token',['revoke','{"label":"remote"}'],async(url,init)=>{const r=await fetch(url,init);if(++n===1){await r.body?.cancel();throw Error();}return r;});expect(retry).toMatchObject({code:0,calls:2});expect(new Set(retry.bodies).size).toBe(1);
  expect(await f.client('token',['create','{}'],async()=>new Response('private-witness',{status:503}))).toMatchObject({code:1,calls:1,stdout:''});
  expect(await f.client('sessions',['revoke','[]'])).toMatchObject({code:2,calls:0});
});
it('rolls back the entire compromised line and its retry receipt when device removal cannot commit',async()=>{
  const f=await setup(),root=hash('operator-bearer'),child=hash('child');
  f.s.tokens.change(x=>x.push({role:'owner',member:'jonathan',label:'child',sha256:child,passkey:hash('credential'),from_sha256:root,created:'2026-01-01'}));
  f.s.sessions.change(x=>{x.passkeys={child:{id:'child',secret:child,publicKey:'key',counter:0,alg:-7,label:'child',created:0}};x.push={subs:{child:{session:'0'.repeat(64),token:child,at:0,sub:{endpoint:'child',keys:{auth:'a',p256dh:'k'}}}}};});
  const before={tokens:f.s.tokens.document(),sessions:f.s.sessions.read()};
  f.app.db.exec("CREATE TEMP TRIGGER fail_device_remove BEFORE DELETE ON household_push BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
  expect(f.call('token.revoke',{label:'operator',withPasskeys:true},'rollback')).toMatchObject({ok:false,code:'unavailable'});
  expect({tokens:f.s.tokens.document(),sessions:f.s.sessions.read()}).toEqual(before);
  expect(f.app.db.prepare("SELECT count(*) AS n FROM core_operations WHERE id='rollback'").get()).toEqual({n:0});
  f.app.db.exec('DROP TRIGGER fail_device_remove');
  expect(f.call('token.revoke',{label:'operator',withPasskeys:true},'rollback')).toEqual({ok:true,value:{revoked:2,passkeys:1,devices:1}});
});
it('updates safe Live sessions at the expiry boundary without a new write',async()=>{
  const f=await setup(),cookie=f.s.createSession(hash('operator-bearer'));
  f.s.sessions.change(x=>{x.sessions[hash(cookie)].issuedAt=f.s.now()-30*86400+1;});
  const ws=new WebSocket(f.app.url.replace('http:','ws:')+'/live',{headers:{authorization:'Bearer operator-bearer'}});cleanup.push(()=>ws.terminate());await once(ws,'open');
  ws.send(JSON.stringify({kind:'subscribe',type:'signin.admin'}));const first=JSON.parse((await once(ws,'message'))[0].toString());expect(first.records[0].sessions[0].ended).toBe(false);
  const changed=once(ws,'message');f.clock.advance(1000);const update=JSON.parse((await changed)[0].toString());expect(update.record.sessions[0].ended).toBe(true);
  expect(f.s.session(cookie)).toBeUndefined();
});
it('does not infer ancestry from a reused label and resolves safe origin metadata by digest',async()=>{
  const f=await setup(),old=hash('old-operator'),child=hash('independent-child');
  f.s.tokens.change(x=>{x.push({role:'owner',member:'jonathan',label:'operator',sha256:old,revoked:'2026-01-01',created:'2026-01-01'},{role:'owner',member:'jonathan',label:'unbound-old-child',sha256:child,passkey:hash('child-id'),from:'operator',created:'2026-01-01'},{role:'owner',member:'jonathan',label:'digest-child',sha256:hash('digest-child'),passkey:hash('digest-child-id'),from_sha256:old,created:'2026-01-01'});});
  const list=f.call('token.list');expect(list.ok).toBe(true);if(!list.ok)throw Error();
  expect(list.value).toEqual(expect.arrayContaining([expect.objectContaining({label:'digest-child',from:'operator',member:'jonathan',passkey:true,created:'2026-01-01'})]));
  expect(f.call('token.revoke',{label:'operator',withPasskeys:true},'reused')).toEqual({ok:true,value:{revoked:1,passkeys:0,devices:0}});
  expect(f.s.token(child)).toEqual({viewer:owner});expect(f.s.token(hash('digest-child'))).toEqual({viewer:owner});
});
it('lists populated session metadata in recency order including ended sessions',async()=>{
  const f=await setup(),secret=hash('operator-bearer');
  const first=f.s.createSession(secret,{device:'Phone',label:'daily',via:'link'}),second=f.s.createSession(secret,{device:'HeadlessChrome',label:'screens',via:'passkey'});
  f.s.sessions.change(x=>{const recent=x.sessions[hash(first)],old=x.sessions[hash(second)];recent.issuedAt=f.s.now()-100;recent.seenAt=f.s.now()-1;old.issuedAt=f.s.now()-6*3600;x.sessions={['f'.repeat(64)]:recent,['0'.repeat(64)]:old};});
  const answer=f.call('sessions.list');expect(answer.ok).toBe(true);if(!answer.ok)throw Error();
  expect(answer.value).toEqual([
    {ref:'f'.repeat(16),issuedAt:f.s.now()-100,seenAt:f.s.now()-1,expiresAt:(f.s.now()-100+30*86400)*1000,device:'Phone',label:'daily',via:'link',agent:false,token:'operator',member:'jonathan',ended:false},
    {ref:'0'.repeat(16),issuedAt:f.s.now()-6*3600,expiresAt:f.clock.now(),device:'HeadlessChrome',label:'screens',via:'passkey',agent:true,token:'operator',member:'jonathan',ended:true},
  ]);
});
it('withDevices alone removes root devices and keeps descendant passkeys working',async()=>{
  const f=await setup(),root=hash('operator-bearer'),child=hash('child');
  f.s.tokens.change(x=>x.push({role:'owner',member:'jonathan',label:'child',sha256:child,passkey:hash('credential'),from_sha256:root,created:'2026-01-01'}));
  const a=f.s.createSession(root),b=f.s.createSession(child);
  f.s.sessions.change(x=>{x.passkeys={child:{id:'child',secret:child,publicKey:'key',counter:0,alg:-7,label:'child',created:0}};x.push={subs:{a:{session:hash(a),token:root,at:0,sub:{endpoint:'a',keys:{auth:'a',p256dh:'a'}}},b:{session:hash(b),token:child,at:0,sub:{endpoint:'b',keys:{auth:'b',p256dh:'b'}}}}};});
  expect(f.call('token.revoke',{label:'operator',withDevices:true},'devices')).toEqual({ok:true,value:{revoked:1,passkeys:1,devices:1}});
  expect(f.s.session(b)).toBeDefined();expect(f.s.sessions.read().passkeys?.child).toBeDefined();expect(Object.keys(f.s.sessions.read().push!.subs!)).toEqual(['b']);
});
it('marks every API response uncacheable, including early authentication and validation failures',async()=>{
  const f=await setup();
  for(const [body,auth,status] of [['{}',false,401],['{',true,400],['{}',true,400],['{"input":{},"id":4}',true,400],['{"input":{}}',true,200],['x'.repeat(1024*1024+1),true,413]] as const){
    const r=await fetch(f.app.url+'/api/token/list',{method:'POST',headers:{'content-type':'application/json',...(auth?{authorization:'Bearer operator-bearer'}:{})},body});expect(r.status).toBe(status);expect(r.headers.get('cache-control')).toBe('no-store');await r.body?.cancel();
  }
});
it('sends empty Live snapshots to nonowners and removes retained records after ownership ends',async()=>{
  const f=await setup();
  const open=async(token:string)=>{const ws=new WebSocket(f.app.url.replace('http:','ws:')+'/live',{headers:{authorization:`Bearer ${token}`}});cleanup.push(()=>ws.terminate());await once(ws,'open');return ws;};
  for(const [role,member] of [['owner','pollock'],['agent:art',undefined],['runner:box',undefined],['service:clock',undefined]] as const){
    if(role==='runner:box'||role==='service:clock')f.call('signin.setPrincipal',{kind:role.split(':')[0],id:role.split(':')[1],active:true},role);
    const token=role+'-token';f.s.tokens.change(x=>x.push({label:role+'-'+member,role,...(member?{member}:{}),sha256:hash(token),created:'2026-01-01'}));
    const ws=await open(token);ws.send(JSON.stringify({kind:'subscribe',type:'signin.admin'}));expect(JSON.parse((await once(ws,'message'))[0].toString()).records).toEqual([]);
  }
  const ws=await open('operator-bearer');ws.send(JSON.stringify({kind:'subscribe',type:'signin.admin'}));expect(JSON.parse((await once(ws,'message'))[0].toString()).records[0].tokens).not.toHaveLength(0);
  const {HouseholdDatabase}=await import('../household/document.js');f.app.db.transaction(()=>new HouseholdDatabase(f.app.db).change('',raw=>{raw.members=[{person:'jonathan',role:'member',agents:['art']},{person:'pollock',role:'owner',agents:'*'}];}))();
  const removed=once(ws,'message');f.app.live.changed([{type:'core.access',id:'household'}]);expect(JSON.parse((await removed)[0].toString()).records).toEqual([]);
});
it('refuses empty normalized labels without signing out unlabeled agent sessions or removing their devices',async()=>{
  const f=await setup(),secret=hash('operator-bearer'),a=f.s.createSession(secret,{agent:true}),b=f.s.createSession(secret,{device:'HeadlessChrome'});
  f.s.sessions.change(x=>{x.push={subs:{a:{session:hash(a),token:secret,at:0,sub:{endpoint:'a',keys:{auth:'a',p256dh:'a'}}}}};});
  const before=f.s.sessions.read();
  for(const label of [' ','\t','\u200b','\u202e','\u2060','\ufeff'])expect(f.call('sessions.revoke',{label},'blank-'+label)).toMatchObject({ok:false,code:'invalid'});
  expect(f.s.sessions.read()).toEqual(before);expect(f.s.session(a)).toBeDefined();expect(f.s.session(b)).toBeDefined();
});
it('requires explicit safe client connection settings and a readable nonempty token before transport',async()=>{
  const f=await setup();let requests=0;
  const request:typeof fetch=async()=>{requests++;throw Error('private-witness');};
  const base={LOOM_URL:f.app.url,LOOM_TOKEN_FILE:f.file};
  for(const env of [{},{LOOM_URL:f.app.url},{LOOM_TOKEN_FILE:f.file},...['ftp://example.com','http://user:password@example.com','http://example.com/path','http://example.com/?query','http://example.com/#hash','not a URL'].map(LOOM_URL=>({...base,LOOM_URL})),{...base,LOOM_TOKEN_FILE:join(f.home,'absent')}]){
    const r=await f.client('token',['list','{}'],request,env);expect(r).toMatchObject({code:1,stdout:'',calls:0});expect(r.stderr).not.toContain('private-witness');expect(r.stderr).not.toContain('password');
  }
  writeFileSync(f.file,' \n');expect(await f.client('sessions',['list','{}'],request,base)).toMatchObject({code:1,stdout:'',calls:0});expect(requests).toBe(0);
});

it('creates a token over the authenticated browser socket without a credential receipt or Live secret', async () => {
  const f = await setup(), cookie = f.s.createSession(hash('operator-bearer'));
  const ws = new WebSocket(f.app.url.replace('http:', 'ws:') + '/live', { headers: { cookie: `loom_ui=${cookie}`, origin: f.app.url } });
  cleanup.push(() => { ws.terminate(); }); await once(ws, 'open');
  const messages: unknown[] = []; ws.on('message', raw => messages.push(JSON.parse(String(raw))));
  const answer = new Promise<{ ok: boolean; value: { token: string } }>(resolve => {
    ws.on('message', raw => { const m = JSON.parse(String(raw)); if (m.kind === 'result' && m.request === 'mint') resolve(m.result); });
  });
  ws.send(JSON.stringify({ kind: 'subscribe', type: 'signin.admin' }));
  ws.send(JSON.stringify({ kind: 'call', request: 'mint', name: 'token.create', input: { label: 'browser-mint', role: 'owner', member: 'pollock' }, id: 'mint' }));
  const result = await answer; expect(result.ok).toBe(true);
  expect(f.s.token(hash(result.value.token))?.viewer).toEqual({ kind: 'member', id: 'pollock' });
  expect(f.app.db.prepare("SELECT * FROM core_operations WHERE id='mint'").all()).toEqual([]);
  const metadata = JSON.stringify(messages.filter(m => (m as { kind: string }).kind !== 'result'));
  expect(metadata).toContain('browser-mint'); expect(metadata).not.toContain(result.value.token); expect(metadata).not.toContain(hash(result.value.token));
});

it('uses an opaque token ref to refuse stale label reuse without touching the replacement', async () => {
  const f = await setup();
  const first = f.call('token.create', { label: 'reusable', role: 'agent', agent: 'art', expires: new Date(f.clock.now() + 1000).toISOString() });
  if (!first.ok) throw Error();
  const old = (first.value as { record: { ref: string } }).record.ref;
  expect(old).not.toContain(hash('operator-bearer'));
  const ws = new WebSocket(f.app.url.replace('http:', 'ws:') + '/live', { headers: { authorization: 'Bearer operator-bearer' } });
  cleanup.push(() => { ws.terminate(); }); await once(ws, 'open');
  ws.send(JSON.stringify({ kind: 'subscribe', type: 'signin.admin' }));
  const snapshot = JSON.parse(String((await once(ws, 'message'))[0])); expect(snapshot.records[0].at).toBe(f.clock.now());
  const expired = once(ws, 'message'); f.clock.advance(1000);
  const update = JSON.parse(String((await expired)[0])); expect(update.record.at).toBe(f.clock.now());
  const replacement = f.call('token.create', { label: 'reusable', role: 'agent', agent: 'art' });
  if (!replacement.ok) throw Error();
  const value = replacement.value as { token: string; record: { ref: string } };
  expect(f.call('token.revoke', { label: 'reusable', ref: old }, 'stale')).toMatchObject({ ok: false, code: 'not-found' });
  expect(f.s.token(hash(value.token))).toBeDefined();
  expect(f.call('token.revoke', { label: 'reusable', ref: value.record.ref }, 'right')).toMatchObject({ ok: true, value: { revoked: 1 } });
  expect(f.s.token(hash(value.token))).toBeUndefined();
});
