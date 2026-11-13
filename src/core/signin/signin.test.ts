import { afterEach, expect, it, vi } from 'vitest';
import { randomBytes, generateKeyPairSync, createHash, sign } from 'node:crypto';
import { once } from 'node:events';
import { request } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { startLoom, createFoundation } from '../../foundation.js';
import { FakeClock } from '../clock.js';
import { importHousehold } from '../../cli/household-importer.js';
import { signin, hash } from './index.js';
import { runSigninLink } from './client.js';
import { Readable } from 'node:stream';
const cleanups:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{vi.unstubAllEnvs();for(const f of cleanups.splice(0).reverse())await f();});
async function setup(){
  const root=mkdtempSync(join(tmpdir(),'next-signin-'));cleanups.push(()=>rmSync(root,{recursive:true,force:true}));
  const home=join(root,'new'),old=join(root,'old');mkdirSync(home);mkdirSync(old);
  const clock=new FakeClock(), cookie=randomBytes(32).toString('hex'), owner=randomBytes(32).toString('hex'),agent=randomBytes(32).toString('hex');
  const records=[{label:'owner',role:'owner',member:'jonathan',sha256:hash(owner),created:new Date(clock.now()).toISOString()},{label:'agent',role:'agent:art',sha256:hash(agent),created:new Date(clock.now()).toISOString()}];
  for(const [name,data] of Object.entries({'household.json':{v:1,agents:['art'],owner:'jonathan',members:[{person:'jonathan',role:'owner',agents:'*'},{person:'pollock',role:'member',agents:['art']}]},'tokens.json':{v:1,tokens:records},'ui-sessions.json':{v:1,sessions:{[hash(cookie)]:{issuedAt:clock.now()/1000,secret:hash(owner),via:'link'}}}}))writeFileSync(join(old,name),JSON.stringify(data));
  writeFileSync(join(old,'ui-cookie.key'),randomBytes(32));
  const app=createFoundation({home,clock});importHousehold(app.db,home,old,clock.now());app.close();
  const loom=await startLoom({home,next:true,clock});cleanups.push(()=>loom.close());const s=signin(loom);
  // startLoom returns a facade, so the public resolver and this store share rows, never mutable caller state.
  const get=async(path:string,headers:Record<string,string>={})=>fetch(loom.url+path,{headers,redirect:'manual'});
  const post=async(path:string,body:unknown={},headers:Record<string,string>={})=>fetch(loom.url+path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body),redirect:'manual'});
  const open=async(headers:Record<string,string>)=>{const ws=new WebSocket(loom.url.replace('http:','ws:')+'/live',{headers});cleanups.push(()=>{ws.terminate();});await once(ws,'open');return ws;};
  return {root,home,old,clock,cookie,owner,agent,loom,s,get,post,open};
}
it('imports an old home and serves its existing browser cookie and agent bearer through every next door',async()=>{
  const f=await setup();
  const session=await (await f.get('/auth/session',{cookie:`loom_ui=${f.cookie}`})).json();expect(session.viewer).toEqual({kind:'member',id:'jonathan'});
  expect((await f.post('/api/tasks/list',{input:{}},{cookie:`loom_ui=${f.cookie}`})).status).toBe(401);
  expect((await f.post('/api/tasks/list',{input:{}},{cookie:`loom_ui=${f.cookie}`,'x-loom-csrf':session.csrf})).status).toBe(200);
  expect((await f.post('/api/tasks/list',{input:{}},{authorization:`Bearer ${f.agent}`})).status).toBe(200);
  const a=await f.open({cookie:`loom_ui=${f.cookie}`,origin:f.loom.url}),b=await f.open({authorization:`Bearer ${f.agent}`});
  a.send(JSON.stringify({kind:'subscribe',type:'task'}));expect(JSON.parse((await once(a,'message'))[0].toString()).kind).toBe('set');
  const mc=await f.post('/mcp',{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}}},{authorization:`Bearer ${f.agent}`,accept:'application/json, text/event-stream'});expect(mc.status).toBe(200);
  const closed=once(b,'close');expect(f.loom.operations.call('direct',{kind:'member',id:'jonathan'},'signin.revokeToken',{label:'agent'},'revoke')).toMatchObject({ok:true});expect((await closed)[0]).toBe(1008);
  expect((await f.post('/api/tasks/list',{input:{}},{authorization:`Bearer ${f.agent}`})).status).toBe(401);
  const ended=once(a,'close');expect((await f.post('/logout',{_csrf:session.csrf},{cookie:`loom_ui=${f.cookie}`})).status).toBe(200);expect((await ended)[0]).toBe(1008);
  expect((await f.get('/auth/session',{cookie:`loom_ui=${f.cookie}`})).status).toBe(200);expect((await(await f.get('/auth/session',{cookie:`loom_ui=${f.cookie}`})).json()).viewer).toBeNull();
});
it('CLI links are member-bound, GET-safe, single-use, expiring, and absent from retry storage',async()=>{
  const f=await setup();writeFileSync(join(f.root,'token'),f.owner);let stdout='';
  expect(await runSigninLink(['--member','pollock','--label','Tablet'],{stdin:Readable.from([]),stdinIsTTY:false,env:{LOOM_URL:f.loom.url,LOOM_TOKEN_FILE:join(f.root,'token')},stdout:s=>{stdout+=s;},stderr:()=>{}})).toBe(0);
  const url=stdout.trim();const confirmation=await fetch(url);expect(confirmation.status).toBe(200);expect(confirmation.headers.get('referrer-policy')).toBe('strict-origin');expect(await confirmation.text()).not.toContain(url.split('/').pop());expect((await fetch(url)).status).toBe(200);
  const res=await fetch(url,{method:'POST',redirect:'manual',headers:{origin:f.loom.url}});expect(res.status).toBe(303);const cookie=res.headers.get('set-cookie')!.split(';')[0];
  expect((await(await f.get('/auth/session',{cookie})).json()).viewer).toEqual({kind:'member',id:'pollock'});
  expect((await fetch(url,{method:'POST'})).status).toBe(401);
  expect(JSON.stringify(f.loom.db.prepare('SELECT * FROM core_operations').all())).not.toContain(url.split('/').pop());
  const next=f.s.link('pollock',undefined,false,undefined,1);f.clock.advance(1000);expect((await f.post(next)).status).toBe(401);
  const csrf=(await(await f.get('/auth/session',{cookie:`loom_ui=${f.cookie}`})).json()).csrf;
  for(const path of ['/api/signin/link','/api/signin/%6cink'])expect((await f.post(path,{input:{member:'pollock'}},{cookie:`loom_ui=${f.cookie}`,'x-loom-csrf':csrf})).status).toBe(403);
});
it('session expiry closes sockets and cross-origin or missing-origin cookie sockets are refused',async()=>{
  const f=await setup();
  for(const headers of [{cookie:`loom_ui=${f.cookie}`},{cookie:`loom_ui=${f.cookie}`,origin:'https://evil.invalid'}]){
    const ws=new WebSocket(f.loom.url.replace('http:','ws:')+'/live',{headers});ws.on('error',()=>{});
    const status=await new Promise<number>(ok=>ws.on('unexpected-response',(_r,res)=>{res.resume();ws.terminate();ok(res.statusCode!);}));expect(status).toBe(401);
  }
  // Age the fixture instead of replaying a month of every daemon's scheduled jobs.
  f.s.sessions.change(file=>{file.sessions[hash(f.cookie)].issuedAt=f.clock.now()/1000-30*86400+1;});
  const ws=await f.open({cookie:`loom_ui=${f.cookie}`,origin:f.loom.url});const closed=once(ws,'close');
  f.clock.advance(999);expect(f.s.session(f.cookie)).toBeDefined();expect(ws.readyState).toBe(WebSocket.OPEN);
  f.clock.advance(1);expect((await closed)[0]).toBe(1008);
  expect((await(await f.get('/auth/session',{cookie:`loom_ui=${f.cookie}`})).json()).viewer).toBeNull();
});
it('passkeys use one WebAuthn user per member, their own token, fresh CSRF registration and verified login',async()=>{
  const f=await setup();vi.stubEnv('LOOM_PUBLIC_URL',f.loom.url.replace('http:','https:'));
  // Request host must match configured RP; fixture listener accepts localhost at this port.
  const host=new URL(process.env.LOOM_PUBLIC_URL!).host,origin=process.env.LOOM_PUBLIC_URL!;
  const session=await(await f.get('/auth/session',{cookie:`loom_ui=${f.cookie}`})).json();
  const headers={cookie:`loom_ui=${f.cookie}`,host,origin};
  f.clock.advance(300_000);
  const options=await(await f.post('/passkeys/options',{_csrf:session.csrf},headers)).json();
  expect(f.s.tokens.used()[hash(f.owner)]).toBe(new Date(f.clock.now()).toISOString());expect(f.s.sessions.get('sessions',hash(f.cookie))?.seenAt).toBe(f.clock.now()/1000);
  const options2=await(await f.post('/passkeys/options',{_csrf:session.csrf},headers)).json();expect(options.user.id).toBe(options2.user.id);
  const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),id=randomBytes(32),rpHash=createHash('sha256').update('127.0.0.1').digest();
  const ad=Buffer.alloc(55+id.length);rpHash.copy(ad);ad[32]=0x45;ad.writeUInt32BE(0,33);ad.writeUInt16BE(id.length,53);id.copy(ad,55);
  const cd=(type:string,challenge:string)=>Buffer.from(JSON.stringify({type,challenge,origin}));
  const registration={_csrf:session.csrf,label:'Phone',id:id.toString('base64url'),clientDataJSON:cd('webauthn.create',options.challenge).toString('base64url'),authenticatorData:ad.toString('base64url'),publicKey:publicKey.export({type:'spki',format:'der'}).toString('base64url'),publicKeyAlgorithm:-7};
  expect((await f.post('/passkeys',registration,{...headers,origin:'https://evil.invalid'})).status).toBe(403);
  f.clock.advance(60_000);
  f.s.sessions.change(file=>{delete file.sessions[hash(f.cookie)].seenAt;});
  expect((await f.post('/passkeys',registration,headers)).status).toBe(200);
  expect(f.s.tokens.used()[hash(f.owner)]).toBe(new Date(f.clock.now()).toISOString());expect(f.s.sessions.get('sessions',hash(f.cookie))?.seenAt).toBe(f.clock.now()/1000);
  expect((await f.post('/passkeys',registration,headers)).status).toBe(400);
  f.loom.operations.call('direct',{kind:'member',id:'jonathan'},'signin.revokeToken',{label:'owner'},'revoke-owner');
  const o=await(await f.post('/login/passkey/options',{}, {host,origin})).json();
  const auth=Buffer.alloc(37);rpHash.copy(auth);auth[32]=5;auth.writeUInt32BE(1,33);const client=cd('webauthn.get',o.challenge);
  const body={id:id.toString('base64url'),authenticatorData:auth.toString('base64url'),clientDataJSON:client.toString('base64url'),signature:sign('sha256',Buffer.concat([auth,createHash('sha256').update(client).digest()]),privateKey).toString('base64url')};
  const res=await f.post('/login/passkey',body,{host,origin});expect(res.status).toBe(200);expect(res.headers.get('set-cookie')).toContain('HttpOnly');
  expect((await f.post('/login/passkey',body,{host,origin})).status).toBe(401);
  const cookie=res.headers.get('set-cookie')!.split(';')[0];expect((await(await f.get('/auth/session',{cookie})).json()).viewer.id).toBe('jonathan');
  f.clock.advance(601000);const csrf=(await(await f.get('/auth/session',{cookie})).json()).csrf;expect((await f.post('/passkeys/options',{_csrf:csrf},{cookie,host,origin})).status).toBe(403);
});
it('runner and service tokens keep their viewer kinds; expired and unknown-agent tokens fail closed',async()=>{
  const f=await setup();
  for(const role of ['runner:box','service:clock','agent:missing']){
    const token=randomBytes(32).toString('hex');f.s.tokens.change(tokens=>tokens.push({label:role,role,sha256:hash(token),created:new Date(f.clock.now()).toISOString(),expires:new Date(f.clock.now()+1000).toISOString()}));
    if(role==='agent:missing'){expect((await f.post('/api/tasks/list',{input:{}},{authorization:`Bearer ${token}`})).status).toBe(401);continue;}
    expect(f.s.token(hash(token))).toBeUndefined();
    expect(f.loom.operations.call('direct',{kind:'member',id:'jonathan'},'signin.setPrincipal',{kind:role.split(':')[0],id:role.split(':')[1],active:true},role)).toMatchObject({ok:true});
    expect(f.s.token(hash(token))?.viewer).toEqual({kind:role.split(':')[0],id:role.split(':')[1]});
    const ws=await f.open({authorization:`Bearer ${token}`});const ended=once(ws,'close');f.clock.advance(1000);expect((await ended)[0]).toBe(1008);
    expect((await f.post('/api/tasks/list',{input:{}},{authorization:`Bearer ${token}`})).status).toBe(401);
  }
  expect((await f.post('/logout',{}, {cookie:`loom_ui=${f.cookie}`})).status).toBe(403);
  const path=f.s.link('pollock');f.s.tokens.change(tokens=>{for(const t of tokens)if(t.member==='pollock')t.revoked=new Date(f.clock.now()).toISOString();});expect((await f.post(path)).status).toBe(401);
});
it('headless browser sessions end in six hours and a stale link cannot authorize adding a passkey',async()=>{
  const f=await setup();const path=f.s.link('jonathan',undefined,false,f.clock.now()/1000-601);
  const res=await f.post(path,{}, {'user-agent':'Mozilla/5.0 '+ 'x'.repeat(100) +' HeadlessChrome/120 Linux'});expect(res.status).toBe(303);
  const cookie=res.headers.get('set-cookie')!.split(';')[0], id=cookie.slice(8);expect(f.s.fresh(id)).toBeUndefined();
  expect(f.s.session(id)?.s.agent).toBe(true);f.clock.advance(6*3600_000);expect(f.s.session(id)).toBeUndefined();
});
class Authenticator {
  id=randomBytes(16);keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});counter=0;
  constructor(readonly origin:string){}
  data(attested=false, flags=attested?0x45:5, rp=new URL(this.origin).hostname){const b=Buffer.alloc(attested?55+this.id.length:37);createHash('sha256').update(rp).digest().copy(b);b[32]=flags;b.writeUInt32BE(this.counter,33);if(attested){b.writeUInt16BE(this.id.length,53);this.id.copy(b,55);}return b;}
  registration(challenge:string){return {id:this.id.toString('base64url'),clientDataJSON:Buffer.from(JSON.stringify({type:'webauthn.create',challenge,origin:this.origin})).toString('base64url'),authenticatorData:this.data(true).toString('base64url'),publicKey:this.keys.publicKey.export({type:'spki',format:'der'}).toString('base64url'),publicKeyAlgorithm:-7};}
  assertion(challenge:string, changes:{origin?:string;type?:string;flags?:number;rp?:string;forge?:boolean}={}){const cd=Buffer.from(JSON.stringify({type:changes.type ?? 'webauthn.get',challenge,origin:changes.origin ?? this.origin})),ad=this.data(false,changes.flags,changes.rp);return {id:this.id.toString('base64url'),clientDataJSON:cd.toString('base64url'),authenticatorData:ad.toString('base64url'),signature:sign('sha256',changes.forge?Buffer.from('forged'):Buffer.concat([ad,createHash('sha256').update(cd).digest()]),this.keys.privateKey).toString('base64url')};}
}
it('independently enforces WebAuthn checks, challenge lifetimes, single use and counters',async()=>{
  const f=await setup(), origin=f.loom.url.replace('http:','https:');vi.stubEnv('LOOM_PUBLIC_URL',origin);
  const headers={cookie:`loom_ui=${f.cookie}`,origin},csrf=(await(await f.get('/auth/session',headers)).json()).csrf,device=new Authenticator(origin);
  const opts=()=>f.post('/passkeys/options',{_csrf:csrf},headers).then(r=>r.json());
  for(const path of ['/passkeys/options','/passkeys'])for(const token of [undefined,'wrong'])expect((await f.post(path,{_csrf:token},headers)).status).toBe(403);
  const o=await opts(),registration=device.registration(o.challenge);
  const changeCd=(r:typeof registration,change:Record<string,unknown>)=>({...r,clientDataJSON:Buffer.from(JSON.stringify({...JSON.parse(Buffer.from(r.clientDataJSON,'base64url').toString()),...change})).toString('base64url')});
  for(const bad of [
    {...registration,authenticatorData:device.data(true,0x41).toString('base64url')},
    {...registration,authenticatorData:device.data(true,0x44).toString('base64url')},
    {...registration,authenticatorData:device.data(true,0x45,'wrong.test').toString('base64url')},
    {...registration,id:randomBytes(16).toString('base64url')},
    {...registration,publicKeyAlgorithm:-8},
    changeCd(registration,{origin:'https://wrong.test'}),changeCd(registration,{type:'webauthn.get'}),
  ])expect((await f.post('/passkeys',{_csrf:csrf,...bad},headers)).status).toBe(400);
  expect((await f.post('/passkeys',{_csrf:csrf,...registration},headers)).status).toBe(200);
  const other=new Authenticator(origin);expect((await f.post('/passkeys',{_csrf:csrf,...other.registration(o.challenge)},headers)).status).toBe(400);
  const expiring=await opts();f.clock.advance(300000);expect((await f.post('/passkeys',{_csrf:csrf,...other.registration(expiring.challenge)},headers)).status).toBe(400);
  const challenge=()=>f.post('/login/passkey/options',{}, {origin}).then(r=>r.json());
  device.counter=1;
  for(const change of [{forge:true},{flags:1},{flags:4},{rp:'wrong.test'},{origin:'https://wrong.test'},{type:'webauthn.create'}]){
    const c=await challenge();expect((await f.post('/login/passkey',device.assertion(c.challenge,change),{origin})).status).toBe(401);
  }
  const expired=await challenge();f.clock.advance(300000);expect((await f.post('/login/passkey',device.assertion(expired.challenge),{origin})).status).toBe(401);
  const valid=await challenge();expect((await f.post('/login/passkey',device.assertion(valid.challenge),{origin})).status).toBe(200);
  const unchanged=await challenge();expect((await f.post('/login/passkey',device.assertion(unchanged.challenge),{origin})).status).toBe(401);
  device.counter=2;expect((await f.post('/login/passkey',device.assertion(valid.challenge),{origin})).status).toBe(401);
});
it('isolates member user handles and excluded credentials and invalidates a removed member',async()=>{
  const f=await setup(),origin=f.loom.url.replace('http:','https:');vi.stubEnv('LOOM_PUBLIC_URL',origin);
  const cookieA=`loom_ui=${f.cookie}`,link=await f.post(f.s.link('pollock'));const cookieB=link.headers.get('set-cookie')!.split(';')[0];
  const add=async(cookie:string)=>{const csrf=(await(await f.get('/auth/session',{cookie})).json()).csrf;const o=await(await f.post('/passkeys/options',{_csrf:csrf},{cookie,origin})).json();const d=new Authenticator(origin);expect((await f.post('/passkeys',{_csrf:csrf,...d.registration(o.challenge)},{cookie,origin})).status).toBe(200);return {o,csrf,d};};
  const a=await add(cookieA),b=await add(cookieB);
  expect(a.o.user.id).toBe(Buffer.from(hash('loom-owner|127.0.0.1'),'hex').subarray(0,16).toString('base64url'));
  expect(b.o.user.id).toBe(Buffer.from(hash('loom-member|pollock|127.0.0.1'),'hex').subarray(0,16).toString('base64url'));
  expect(a.o.user.id).not.toBe(b.o.user.id);
  for(const [cookie,entry] of [[cookieA,a],[cookieB,b]] as const){const o=await(await f.post('/passkeys/options',{_csrf:entry.csrf},{cookie,origin})).json();expect(o.excludeCredentials).toEqual([{type:'public-key',id:entry.d.id.toString('base64url')}]);}
  const memberToken=randomBytes(32).toString('hex');f.s.tokens.change(tokens=>tokens.push({role:'owner',member:'pollock',sha256:hash(memberToken),label:'member',created:new Date(f.clock.now()).toISOString()}));
  expect((await f.post('/api/signin/link',{input:{member:'pollock'}},{authorization:`Bearer ${memberToken}`})).status).toBe(403);
  const ws=await f.open({cookie:cookieB,origin});const closed=once(ws,'close');
  const {HouseholdDatabase}=await import('../household/document.js');new HouseholdDatabase(f.loom.db).change(f.home,raw=>{raw.members=(raw.members as Array<{person:string}>).filter(m=>m.person!=='pollock');});
  f.loom.live.changed([{type:'core.access',id:'household'}]);expect((await closed)[0]).toBe(1008);
  expect((await(await f.get('/auth/session',{cookie:cookieB})).json()).viewer).toBeNull();expect((await f.post('/api/tasks/list',{input:{}},{authorization:`Bearer ${memberToken}`})).status).toBe(401);
  const c=await(await f.post('/login/passkey/options',{}, {origin})).json();b.d.counter=1;expect((await f.post('/login/passkey',b.d.assertion(c.challenge),{origin})).status).toBe(401);
});
it('revoking a session token closes its socket and unknown or disabled machine principals cannot authenticate',async()=>{
  const f=await setup();const ws=await f.open({cookie:`loom_ui=${f.cookie}`,origin:f.loom.url}),closed=once(ws,'close');
  f.loom.operations.call('direct',{kind:'member',id:'jonathan'},'signin.revokeToken',{label:'owner'},'revoke-bound-token');expect((await closed)[0]).toBe(1008);
  expect((await(await f.get('/auth/session',{cookie:`loom_ui=${f.cookie}`})).json()).viewer).toBeNull();
  const token=randomBytes(32).toString('hex');f.s.tokens.change(tokens=>tokens.push({role:'runner:box',label:'box',sha256:hash(token),created:new Date(f.clock.now()).toISOString()}));
  expect((await f.post('/api/tasks/list',{input:{}},{authorization:`Bearer ${token}`})).status).toBe(401);
  const principal=(active:boolean,id:string)=>f.loom.operations.call('direct',{kind:'member',id:'jonathan'},'signin.setPrincipal',{kind:'runner',id:'box',active},id);
  expect(principal(true,'enable')).toMatchObject({ok:true});const runner=await f.open({authorization:`Bearer ${token}`}),ended=once(runner,'close');expect(principal(false,'disable')).toMatchObject({ok:true});expect((await ended)[0]).toBe(1008);
  expect((await f.post('/api/tasks/list',{input:{}},{authorization:`Bearer ${token}`})).status).toBe(401);
});
it('link spend rolls back if session creation fails, agent suffixes resolve, and CLI never retries a lost response',async()=>{
  const f=await setup(),path=f.s.link('jonathan');
  f.loom.db.exec("CREATE TRIGGER fail_session BEFORE INSERT ON household_sessions BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
  expect((await f.post(path)).status).toBe(400);f.loom.db.exec('DROP TRIGGER fail_session');expect((await f.post(path)).status).toBe(303);
  for(const role of ['agent:art/service','agent:art@house','agent:art/service@house']){const token=randomBytes(32).toString('hex');f.s.tokens.change(tokens=>tokens.push({role,label:role,sha256:hash(token),created:new Date(f.clock.now()).toISOString()}));expect(f.s.token(hash(token))?.viewer).toEqual({kind:'agent',id:'art'});}
  writeFileSync(join(f.root,'token'),f.owner);let calls=0,output='';
  expect(await runSigninLink(['--member','jonathan'],{stdin:Readable.from([]),stdinIsTTY:false,env:{LOOM_URL:f.loom.url,LOOM_TOKEN_FILE:join(f.root,'token')},stdout:s=>{output+=s;},stderr:()=>{}},async()=>{calls++;throw new Error('response lost');})).toBe(1);expect(calls).toBe(1);expect(output).toBe('');
});
it('session cap evicts ended sessions first, then agent sessions before a person',async()=>{
  const f=await setup(),old=f.cookie,now=f.clock.now()/1000;
  f.s.sessions.change(file=>{file.sessions[hash(old)].issuedAt=now-1;for(let i=0;i<48;i++)file.sessions[hash('person'+i)]={issuedAt:now,secret:hash(f.owner)};file.sessions[hash('agent-browser')]={issuedAt:now,secret:hash(f.owner),agent:true};file.sessions[hash('ended')]={issuedAt:0,secret:hash(f.owner)};});
  f.s.createSession(hash(f.owner));expect(f.s.sessions.get('sessions',hash('ended'))).toBeUndefined();expect(f.s.sessions.get('sessions',hash('agent-browser'))).toBeUndefined();expect(f.s.session(old)).toBeDefined();expect(Object.keys(f.s.sessions.read().sessions)).toHaveLength(50);
});
it('rejects mismatched RP hosts and forged forwarding headers on requests and upgrades',async()=>{
  const f=await setup(),origin=f.loom.url.replace('http:','https:');vi.stubEnv('LOOM_PUBLIC_URL',origin);
  const mismatched=await new Promise<number>((ok,no)=>{const req=request(new URL('/login/passkey/options',f.loom.url),{method:'POST',headers:{host:'other.invalid',origin:'http://other.invalid','content-type':'application/json'}},res=>{res.resume();ok(res.statusCode!);});req.on('error',no);req.end('{}');});expect(mismatched).toBe(404);
  const forged={origin:'https://evil.invalid','x-forwarded-host':'evil.invalid','x-forwarded-proto':'https'};
  expect((await f.post('/login/passkey/options',{},forged)).status).toBe(403);
  for(const extra of [forged,{host:'other.invalid',origin}]){const ws=new WebSocket(f.loom.url.replace('http:','ws:')+'/live',{headers:{cookie:`loom_ui=${f.cookie}`,...extra}});ws.on('error',()=>{});const status=await new Promise<number>(ok=>ws.once('unexpected-response',(_r,res)=>{res.resume();ws.terminate();ok(res.statusCode!);}));expect(status).toBe(401);}
  const ws=await f.open({cookie:`loom_ui=${f.cookie}`,origin,'x-forwarded-proto':'http'});ws.terminate();
});
it('only household owners can administer machine principals or revoke tokens through authenticated doors',async()=>{
  const f=await setup();const callers=[f.agent];
  for(const [role,member] of [['owner','pollock'],['runner:box',undefined],['service:clock',undefined]] as const){const token=randomBytes(32).toString('hex');f.s.tokens.change(tokens=>tokens.push({role,member,label:role,sha256:hash(token),created:new Date(f.clock.now()).toISOString()}));if(role!=='owner')expect(f.loom.operations.call('direct',{kind:'member',id:'jonathan'},'signin.setPrincipal',{kind:role.split(':')[0],id:role.split(':')[1],active:true},role)).toMatchObject({ok:true});callers.push(token);}
  for(const token of callers){const headers={authorization:`Bearer ${token}`};expect((await f.post('/api/signin/setPrincipal',{id:'try-principal',input:{kind:'runner',id:'box',active:false}},headers)).status).toBe(403);expect((await f.post('/api/signin/revokeToken',{id:'try-revoke',input:{label:'owner'}},headers)).status).toBe(403);}
  expect((await(await f.get('/auth/session',{cookie:`loom_ui=${f.cookie}`})).json()).viewer.id).toBe('jonathan');
});
it('records accepted bearer and browser use with persisted throttles and safe admin metadata',async()=>{
  const f=await setup(), bearer={authorization:`Bearer ${f.agent}`}, cookie={cookie:`loom_ui=${f.cookie}`};
  const used=()=>f.s.tokens.used(), seen=()=>f.s.sessions.get('sessions',hash(f.cookie))?.seenAt;
  expect(used()).toEqual({});expect(seen()).toBeUndefined();
  expect((await f.post('/api/tasks/list',{input:{}},bearer)).status).toBe(200);
  const first=new Date(f.clock.now()).toISOString();expect(used()).toEqual({[hash(f.agent)]:first});expect(seen()).toBeUndefined();
  const session=await(await f.get('/auth/session',cookie)).json();expect(session.viewer.id).toBe('jonathan');
  expect(used()[hash(f.owner)]).toBe(first);expect(seen()).toBe(f.clock.now()/1000);
  const start=f.clock.now();f.clock.advance(59_999);
  await f.post('/api/tasks/list',{input:{}},bearer);await f.get('/auth/session',cookie);
  expect(used()[hash(f.agent)]).toBe(first);expect(used()[hash(f.owner)]).toBe(first);expect(seen()).toBe(start/1000);
  f.clock.advance(1);await f.post('/api/tasks/list',{input:{}},bearer);await f.get('/auth/session',cookie);
  expect(used()[hash(f.agent)]).toBe(new Date(f.clock.now()).toISOString());expect(used()[hash(f.owner)]).toBe(new Date(f.clock.now()).toISOString());expect(seen()).toBe(start/1000);
  f.clock.advance(240_000);await f.get('/auth/session',cookie);expect(seen()).toBe(f.clock.now()/1000);
  const result=f.loom.operations.call('direct',{kind:'member',id:'jonathan'},'token.list',{});expect(result).toMatchObject({ok:true,value:expect.arrayContaining([expect.objectContaining({label:'agent',last_used:new Date(start+60_000).toISOString()})])});
  const sessions=f.loom.operations.call('direct',{kind:'member',id:'jonathan'},'sessions.list',{});expect(sessions).toMatchObject({ok:true,value:expect.arrayContaining([expect.objectContaining({ref:hash(f.cookie).slice(0,16),seenAt:f.clock.now()/1000})])});
  // Pure reads, including the admin projection and validity probes, never report activity.
  const before=used(),beforeSeen=seen();f.clock.advance(300_000);
  f.s.token(hash(f.owner));f.s.session(f.cookie);f.loom.live.changed([{type:'core.access',id:'credentials'}]);
  expect(used()).toEqual(before);expect(seen()).toBe(beforeSeen);
});
it('never records rejected credentials, cookie CSRF failures or invalid cookie upgrades',async()=>{
  const f=await setup(),cookie={cookie:`loom_ui=${f.cookie}`};
  expect((await f.post('/api/tasks/list',{input:{}},cookie)).status).toBe(401);
  expect(f.s.resolve({headers:{...cookie,upgrade:'websocket',origin:'https://evil.invalid'},socket:{},method:'GET'} as unknown as import('node:http').IncomingMessage)).toBeUndefined();
  expect((await f.post('/api/tasks/list',{input:{}},{authorization:'Bearer invalid'})).status).toBe(401);
  expect(f.s.tokens.used()).toEqual({});expect(f.s.sessions.get('sessions',hash(f.cookie))?.seenAt).toBeUndefined();
  f.s.tokens.change(tokens=>{tokens.find(t=>t.label==='agent')!.revoked=new Date(f.clock.now()).toISOString();tokens.find(t=>t.label==='owner')!.expires=new Date(f.clock.now()).toISOString();});
  expect((await f.post('/api/tasks/list',{input:{}},{authorization:`Bearer ${f.agent}`})).status).toBe(401);
  expect((await(await f.get('/auth/session',cookie)).json()).viewer).toBeNull();expect(f.s.tokens.used()).toEqual({});
});
it('tracks incoming open-socket activity and publishes usage without passive validity refreshes',async()=>{
  const f=await setup(),cookie={cookie:`loom_ui=${f.cookie}`,origin:f.loom.url};
  const ws=await f.open(cookie),admin=await f.open({authorization:`Bearer ${f.owner}`});
  admin.send(JSON.stringify({kind:'subscribe',type:'signin.admin'}));const snapshot=JSON.parse((await once(admin,'message'))[0].toString());expect(snapshot.kind).toBe('set');
  const before=f.s.sessions.get('sessions',hash(f.cookie))!.seenAt;
  f.clock.advance(300_000);const reset=once(admin,'message');f.loom.live.changed([{type:'core.access',id:'credentials'}]);await reset;
  expect(f.s.sessions.get('sessions',hash(f.cookie))!.seenAt).toBe(before);
  const update=once(admin,'message');ws.send(JSON.stringify({kind:'subscribe',type:'task'}));
  expect(JSON.parse((await once(ws,'message'))[0].toString()).kind).toBe('set');
  const message=JSON.parse((await update)[0].toString());expect(message).toMatchObject({kind:'put',type:'signin.admin',record:{sessions:expect.arrayContaining([expect.objectContaining({ref:hash(f.cookie).slice(0,16),seenAt:f.clock.now()/1000})])}});
  expect(f.s.tokens.used()[hash(f.owner)]).toBe(new Date(f.clock.now()).toISOString());
});
it('does not turn diagnostic write failures into authentication failures or partial session usage',async()=>{
  const f=await setup();
  f.loom.db.exec("CREATE TRIGGER refuse_usage BEFORE UPDATE ON household_sessions BEGIN SELECT RAISE(ABORT, 'fixture usage unavailable'); END");
  expect((await f.post('/api/tasks/list',{input:{}},{authorization:`Bearer ${f.agent}`})).status).toBe(200);
  expect((await(await f.get('/auth/session',{cookie:`loom_ui=${f.cookie}`})).json()).viewer.id).toBe('jonathan');
  expect(f.s.tokens.used()).toEqual({[hash(f.agent)]:new Date(f.clock.now()).toISOString()});expect(f.s.sessions.get('sessions',hash(f.cookie))?.seenAt).toBeUndefined();
  f.loom.db.exec('DROP TRIGGER refuse_usage');
  await f.get('/auth/session',{cookie:`loom_ui=${f.cookie}`});expect(f.s.sessions.get('sessions',hash(f.cookie))?.seenAt).toBe(f.clock.now()/1000);
});

it('preserves both usage throttles across a stopped instance and restart',async()=>{
  const f=await setup(),cookie={cookie:`loom_ui=${f.cookie}`};
  await f.get('/auth/session',cookie);
  const before=f.s.tokens.used(),seen=f.s.sessions.get('sessions',hash(f.cookie))!.seenAt;
  cleanups.pop();await f.loom.close();f.clock.advance(30_000);
  const reopened=await startLoom({home:f.home,next:true,clock:f.clock});cleanups.push(()=>reopened.close());
  expect((await(await fetch(reopened.url+'/auth/session',{headers:cookie})).json()).viewer.id).toBe('jonathan');
  const s=signin(reopened);expect(s.tokens.used()).toEqual(before);expect(s.sessions.get('sessions',hash(f.cookie))!.seenAt).toBe(seen);
  f.clock.advance(30_000);await fetch(reopened.url+'/auth/session',{headers:cookie});
  expect(s.tokens.used()[hash(f.owner)]).toBe(new Date(f.clock.now()).toISOString());expect(s.sessions.get('sessions',hash(f.cookie))!.seenAt).toBe(seen);
  f.clock.advance(240_000);await fetch(reopened.url+'/auth/session',{headers:cookie});expect(s.sessions.get('sessions',hash(f.cookie))!.seenAt).toBe(f.clock.now()/1000);
});
it('does not count malformed same-origin cookie upgrades and records accepted logout token use',async()=>{
  const f=await setup(),cookie={cookie:`loom_ui=${f.cookie}`};
  const malformed=await new Promise<number>((ok,fail)=>{
    const req=request(f.loom.url+'/live',{headers:{...cookie,origin:f.loom.url,connection:'Upgrade',upgrade:'websocket','sec-websocket-version':'13','sec-websocket-key':'invalid'}},res=>{res.resume();ok(res.statusCode!);});req.on('error',fail);req.end();
  });
  expect(malformed).toBe(400);expect(f.s.tokens.used()).toEqual({});expect(f.s.sessions.get('sessions',hash(f.cookie))?.seenAt).toBeUndefined();
  expect((await f.post('/logout',{_csrf:f.s.csrf(f.cookie)},cookie)).status).toBe(200);
  expect(f.s.tokens.used()[hash(f.owner)]).toBe(new Date(f.clock.now()).toISOString());expect(f.s.sessions.get('sessions',hash(f.cookie))).toBeUndefined();
});
