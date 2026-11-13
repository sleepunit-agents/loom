import { afterEach, expect, it, vi } from 'vitest';
import { randomBytes, generateKeyPairSync, createHash, sign } from 'node:crypto';
import { once } from 'node:events';
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
  const url=stdout.trim();expect((await fetch(url)).status).toBe(200);expect((await fetch(url)).status).toBe(200);
  const res=await fetch(url,{method:'POST',redirect:'manual',headers:{origin:f.loom.url}});expect(res.status).toBe(303);const cookie=res.headers.get('set-cookie')!.split(';')[0];
  expect((await(await f.get('/auth/session',{cookie})).json()).viewer).toEqual({kind:'member',id:'pollock'});
  expect((await fetch(url,{method:'POST'})).status).toBe(401);
  expect(JSON.stringify(f.loom.db.prepare('SELECT * FROM core_operations').all())).not.toContain(url.split('/').pop());
  const next=f.s.link('pollock',undefined,false,undefined,1);f.clock.advance(1000);expect((await f.post(next)).status).toBe(401);
  expect((await f.post('/api/signin/link',{input:{member:'pollock'}},{cookie:`loom_ui=${f.cookie}`})).status).toBe(403);
});
it('session expiry closes sockets and cross-origin or missing-origin cookie sockets are refused',async()=>{
  const f=await setup();
  for(const headers of [{cookie:`loom_ui=${f.cookie}`},{cookie:`loom_ui=${f.cookie}`,origin:'https://evil.invalid'}]){
    const ws=new WebSocket(f.loom.url.replace('http:','ws:')+'/live',{headers});ws.on('error',()=>{});
    const status=await new Promise<number>(ok=>ws.on('unexpected-response',(_r,res)=>{res.resume();ws.terminate();ok(res.statusCode!);}));expect(status).toBe(401);
  }
  const ws=await f.open({cookie:`loom_ui=${f.cookie}`,origin:f.loom.url});const closed=once(ws,'close');f.clock.advance(30*86400_000);expect((await closed)[0]).toBe(1008);
  expect((await(await f.get('/auth/session',{cookie:`loom_ui=${f.cookie}`})).json()).viewer).toBeNull();
});
it('passkeys use one WebAuthn user per member, their own token, fresh CSRF registration and verified login',async()=>{
  const f=await setup();vi.stubEnv('LOOM_PUBLIC_URL',f.loom.url.replace('http:','https:'));
  // Request host must match configured RP; fixture listener accepts localhost at this port.
  const host=new URL(process.env.LOOM_PUBLIC_URL!).host,origin=process.env.LOOM_PUBLIC_URL!;
  const session=await(await f.get('/auth/session',{cookie:`loom_ui=${f.cookie}`})).json();
  const headers={cookie:`loom_ui=${f.cookie}`,host,origin};
  const options=await(await f.post('/passkeys/options',{_csrf:session.csrf},headers)).json();
  const options2=await(await f.post('/passkeys/options',{_csrf:session.csrf},headers)).json();expect(options.user.id).toBe(options2.user.id);
  const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),id=randomBytes(32),rpHash=createHash('sha256').update('127.0.0.1').digest();
  const ad=Buffer.alloc(55+id.length);rpHash.copy(ad);ad[32]=0x45;ad.writeUInt32BE(0,33);ad.writeUInt16BE(id.length,53);id.copy(ad,55);
  const cd=(type:string,challenge:string)=>Buffer.from(JSON.stringify({type,challenge,origin}));
  const registration={_csrf:session.csrf,label:'Phone',id:id.toString('base64url'),clientDataJSON:cd('webauthn.create',options.challenge).toString('base64url'),authenticatorData:ad.toString('base64url'),publicKey:publicKey.export({type:'spki',format:'der'}).toString('base64url'),publicKeyAlgorithm:-7};
  expect((await f.post('/passkeys',registration,{...headers,origin:'https://evil.invalid'})).status).toBe(403);
  expect((await f.post('/passkeys',registration,headers)).status).toBe(200);
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
    expect(f.s.token(hash(token))?.viewer).toEqual({kind:role.split(':')[0],id:role.split(':')[1]});
    const ws=await f.open({authorization:`Bearer ${token}`});const ended=once(ws,'close');f.clock.advance(1000);expect((await ended)[0]).toBe(1008);
    expect((await f.post('/api/tasks/list',{input:{}},{authorization:`Bearer ${token}`})).status).toBe(401);
  }
  expect((await f.post('/logout',{}, {cookie:`loom_ui=${f.cookie}`})).status).toBe(403);
  const path=f.s.link('pollock');f.s.tokens.change(tokens=>{for(const t of tokens)if(t.member==='pollock')t.revoked=new Date(f.clock.now()).toISOString();});expect((await f.post(path)).status).toBe(401);
});
it('headless browser sessions end in six hours and a stale link cannot authorize adding a passkey',async()=>{
  const f=await setup();const path=f.s.link('jonathan',undefined,false,f.clock.now()/1000-601);
  const res=await f.post(path,{}, {'user-agent':'Mozilla/5.0 HeadlessChrome/120 Linux'});expect(res.status).toBe(303);
  const cookie=res.headers.get('set-cookie')!.split(';')[0], id=cookie.slice(8);expect(f.s.fresh(id)).toBeUndefined();
  expect(f.s.session(id)?.s.agent).toBe(true);f.clock.advance(6*3600_000);expect(f.s.session(id)).toBeUndefined();
});
