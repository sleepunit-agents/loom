import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync,readFileSync,openSync} from 'node:fs';
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {runHouseholdClient} from './household-client.js';
import {tmpdir} from 'node:os';
import {Readable} from 'node:stream';
import {afterEach,expect,it,vi} from 'vitest';
import {eq} from 'drizzle-orm';
import {FakeClock} from '../core/clock.js';
import {createDataSchema} from '../core/data/database.js';
import {members,tokens,sessions,passkeys} from '../core/data/schema.js';
import {sharedRoot} from '../shared-root.js';
import {runCli,runCliLocal} from './index.js';
import {runAccessClient} from './access-client.js';
vi.mock('node:fs',async original=>{const fs=await original<typeof import('node:fs')>();return{...fs,readFileSync:vi.fn(fs.readFileSync),openSync:vi.fn(fs.openSync)};});
vi.mock('node:fs/promises',async original=>{const fs=await original<typeof import('node:fs/promises')>();return{...fs,readFile:vi.fn(fs.readFile)};});
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{try{for(const close of clean.splice(0).reverse())await close();}finally{vi.unstubAllGlobals();}});
function fixture(){
 const home=mkdtempSync(join(tmpdir(),'fictional-signin-cli-'));clean.push(()=>rmSync(home,{recursive:true,force:true}));const client=new Database(':memory:');clean.push(()=>client.close());const clock=new FakeClock(),at=new Date(clock.now()).toISOString(),db=createDataSchema(client,()=>new Date(clock.now()).toISOString()),raw={owner:'a'.repeat(64),sam:'b'.repeat(64)},hash=(value:string)=>createHash('sha256').update(value).digest('hex');
 for(const member of ['owner','sam'] as const){db.insert(members).values({id:member,role:member==='owner'?'owner':'member',joinedAt:at}).run();db.insert(tokens).values({fingerprint:hash(raw[member]),kind:'owner',member,label:member,createdAt:at}).run();writeFileSync(join(home,member),raw[member],{mode:0o600});}
 db.insert(sessions).values({id:hash('c'.repeat(64)),token:hash(raw.sam),device:'Sam browser',via:'link',isAgent:false,issuedAt:at,seenAt:at,provedAt:at}).run();
 const root=sharedRoot({db,clock,originAllowed:()=>true,reportError:()=>{}});clean.push(()=>root.close());
 const transport:typeof fetch=async(input,init)=>await root.http.fetch(new Request(input,init));
 const invoke=async(piece:'token'|'sessions'|'account'|'household',args:string[],actor:'owner'|'sam'='owner',request:typeof fetch=transport,env?:NodeJS.ProcessEnv)=>{
  let out='',err='',time=0,calls=0;const bodies:string[]=[],paths:string[]=[];
  const code=await runAccessClient(piece,args,{stdin:Readable.from([]),stdinIsTTY:false,env:env??{LOOM_URL:'http://loom',LOOM_TOKEN_FILE:join(home,actor)},stdout:value=>out+=value,stderr:value=>err+=value},{now:()=>time,retry:async ms=>{time+=ms;},request:async(input,init)=>{calls++;bodies.push(String(init?.body));paths.push(new URL(String(input)).pathname);return request(input,init);}});
  return{code,out,err,calls,bodies,paths,time};
 };
 return{root,db,invoke,transport,home,clock};
}
it('reads canonical owner lists and personal Account through the same shared GraphQL door',async()=>{
 const f=fixture();for(const piece of ['token','sessions'] as const){const result=await f.invoke(piece,['list']);expect(result.code).toBe(0);expect(result.paths).toEqual(['/graphql']);expect(JSON.parse(result.out)).toHaveLength(piece==='token'?2:1);}
 expect((await f.invoke('token',['list','{}'],'sam')).code).toBe(1);const own=await f.invoke('account',['read','{}'],'sam');expect(own.code).toBe(0);expect(JSON.parse(own.out)).toMatchObject({member:'sam',sessions:[{device:'Sam browser'}]});
});
it('mints only through the canonical credential ceremony and never retries a lost issuance response',async()=>{
 const f=fixture(),input=JSON.stringify({kind:'owner',member:'sam',label:'Remote'}),created=await f.invoke('token',['create',input]);expect(created.code).toBe(0);expect(created.paths).toEqual(['/api/signin/token']);expect(created.out).toMatch(/^loom_\S+\n$/);expect(f.root.credentials.authenticate(new Request('http://loom',{headers:{authorization:'Bearer '+created.out.trim()}}))?.viewer).toEqual({kind:'member',id:'sam'});
 const lost=await f.invoke('token',['create',JSON.stringify({kind:'owner',member:'sam',label:'Lost'})],'owner',async(url,init)=>{const response=await f.transport(url,init);await response.body?.cancel();throw Error('PRIVATE TRANSPORT DETAIL');});
 expect(lost).toMatchObject({code:1,calls:1,out:''});expect(lost.err).toContain('outcome unknown');expect(lost.err).not.toContain('PRIVATE TRANSPORT DETAIL');expect(f.db.select().from(tokens).all().filter(row=>row.label==='Lost')).toHaveLength(1);
});
it('retries ordinary commands with one stable receipt id against the same shared operation',async()=>{
 const f=fixture(),listed=await f.invoke('sessions',['list','{}']),ref=JSON.parse(listed.out)[0].ref;let attempts=0;
 const result=await f.invoke('sessions',['revoke',JSON.stringify({ref})],'owner',async(url,init)=>{const response=await f.transport(url,init);if(++attempts===1){await response.body?.cancel();throw Error('lost');}return response;});
 expect(result).toMatchObject({code:0,calls:2,err:''});expect(new Set(result.bodies).size).toBe(1);expect(JSON.parse(result.out)).toEqual({revoked:true});expect(f.db.select().from(sessions).all()).toEqual([]);
});
it('rejects unsafe connection settings and invalid daemon payloads without printing private diagnostics',async()=>{
 const f=fixture();expect((await f.invoke('token',['list','{}'],'owner',f.transport,{})).calls).toBe(0);expect((await f.invoke('token',['create','[]'])).code).toBe(2);
 const bad=await f.invoke('token',['list','{}'],'owner',async()=>Response.json({data:{householdSetup:{tokens:[{privateKey:'PRIVATE'}]}}}));expect(bad).toMatchObject({code:1,out:''});expect(bad.err).not.toContain('PRIVATE');
});

it('reports expired tokens and ended browsers distinctly from current credentials',async()=>{
 const f=fixture();f.db.update(tokens).set({expiresAt:new Date(f.clock.now()).toISOString()}).where(eq(tokens.member,'sam')).run();
 const tokenList=JSON.parse((await f.invoke('token',['list','{}'])).out);expect(tokenList.find((row:{label:string})=>row.label==='sam').expired).toBe(true);expect(tokenList.find((row:{label:string})=>row.label==='owner').expired).toBe(false);
 expect(JSON.parse((await f.invoke('sessions',['list','{}'])).out)[0].ended).toBe(true);
});
it('runs token revocation and both personal account mutations through canonical shared commands',async()=>{
 const f=fixture(),create=await f.invoke('token',['create',JSON.stringify({kind:'owner',member:'sam',label:'Revoked by CLI'})]);expect(create.code).toBe(0);
 const tokenList=JSON.parse((await f.invoke('token',['list','{}'])).out),fingerprint=tokenList.find((row:{label:string})=>row.label==='Revoked by CLI').fingerprint;
 expect(await f.invoke('token',['revoke',JSON.stringify({fingerprint})])).toMatchObject({code:0,paths:['/api/token/revoke']});
 const sam=f.db.select().from(tokens).all().find(row=>row.label==='sam')!;f.db.insert(passkeys).values({id:'fictional-key',token:sam.fingerprint,label:'CLI key',publicKey:'Unused public half',counter:0,createdAt:new Date(f.clock.now()).toISOString()}).run();
 const own=JSON.parse((await f.invoke('account',['read','{}'],'sam')).out),session=own.sessions[0];
 const removed=await f.invoke('account',['removePasskey',JSON.stringify({ref:own.passkeys[0].ref})],'sam');expect(removed).toMatchObject({code:0,paths:['/api/account/removePasskey']});expect(JSON.parse(removed.out)).toEqual({removed:true});expect(f.db.select().from(passkeys).all()).toEqual([]);
 expect(await f.invoke('account',['revokeSession',JSON.stringify({ref:session.ref})],'sam')).toMatchObject({code:0,paths:['/api/account/revokeSession']});
 // A syntactically valid but absent key proves the real personal mutation door
 // is reached and refused, without inventing key material or another issuer.
 const missing=await f.invoke('account',['removePasskey',JSON.stringify({ref:'e'.repeat(64)})],'sam');expect(missing).toMatchObject({code:1,paths:['/api/account/removePasskey']});
});
it('does not retry a 5xx issuance and bounds ordinary 5xx and transport-error retries on the fake clock',async()=>{
 const f=fixture();
 const mint=await f.invoke('token',['create',JSON.stringify({kind:'owner',member:'sam',label:'Uncertain'})],'owner',async()=>new Response('PRIVATE FAILURE',{status:503}));expect(mint).toMatchObject({code:1,calls:1,out:''});expect(mint.err).toContain('outcome unknown');expect(mint.err).not.toContain('PRIVATE FAILURE');
 for(const broken of [async()=>new Response('PRIVATE FAILURE',{status:503}),async()=>{throw Error('PRIVATE FAILURE');}]){const result=await f.invoke('sessions',['revoke',JSON.stringify({ref:'e'.repeat(64)})],'owner',broken);expect(result).toMatchObject({code:1,calls:8,time:4000,out:''});expect(new Set(result.bodies).size).toBe(1);expect(JSON.parse(result.bodies[0]).id).toEqual(expect.any(String));expect(result.err).not.toContain('PRIVATE FAILURE');}
});
it('supplies redirect refusal and rejects every unsafe URL or missing/empty token before transport',async()=>{
 const f=fixture(),settings={LOOM_URL:'http://loom',LOOM_TOKEN_FILE:join(f.home,'owner')};let redirect:RequestRedirect|undefined;
 await f.invoke('token',['list','{}'],'owner',async(url,init)=>{redirect=init?.redirect;return f.transport(url,init);});expect(redirect).toBe('error');
 for(const LOOM_URL of ['not a URL','file:///tmp/private','https://name:secret@loom','https://loom/path','https://loom/?query','https://loom/#hash'])expect((await f.invoke('token',['list','{}'],'owner',f.transport,{...settings,LOOM_URL})).calls).toBe(0);
 for(const LOOM_TOKEN_FILE of [undefined,join(f.home,'missing'),join(f.home,'empty')]){if(LOOM_TOKEN_FILE?.endsWith('empty'))writeFileSync(LOOM_TOKEN_FILE,'');expect((await f.invoke('token',['list','{}'],'owner',f.transport,{...settings,LOOM_TOKEN_FILE})).calls).toBe(0);}
 expect((await f.invoke('token',['list','{"unexpected":true}'],'owner',f.transport,{})).code).toBe(2);
});

it('preserves raw JSON numerals verbatim rather than changing overflow into null',async()=>{
 const f=fixture(),text='{"kind":"owner","member":"sam","label":"Raw","overflow":1e999}';
 const mint=await f.invoke('token',['create',text]);expect(mint.bodies).toEqual([text]);expect(mint.code).toBe(1);
 const revokeText='{"ref":"'+ 'e'.repeat(64) +'","overflow":1e999}',revoke=await f.invoke('sessions',['revoke',revokeText]);expect(revoke.bodies[0]).toContain('"input":'+revokeText);expect(revoke.bodies[0]).not.toContain('null');
});
it('refuses extra private fields on otherwise valid metadata and malformed successful issuance without retries',async()=>{
 const f=fixture(),valid=JSON.parse((await f.invoke('token',['list'])).out)[0];
 const bad=await f.invoke('token',['list'],'owner',async()=>Response.json({data:{householdSetup:{tokens:[{...valid,privateKey:'PRIVATE_EXTRA'}]}}}));expect(bad).toMatchObject({code:1,out:''});expect(bad.err).not.toContain('PRIVATE_EXTRA');
 const malformed=await f.invoke('token',['create','{}'],'owner',async()=>Response.json({ok:true,value:{token:'PRIVATE_MALFORMED'}}));expect(malformed).toMatchObject({code:1,calls:1,out:''});expect(malformed.err).toContain('outcome unknown');expect(malformed.err).not.toContain('PRIVATE_MALFORMED');
});
it('refuses a redirect response and does not print its private body',async()=>{
 const f=fixture(),result=await f.invoke('token',['list'],'owner',async()=>new Response('PRIVATE_REDIRECT',{status:302,headers:{location:'https://other.example/private'}}));expect(result).toMatchObject({code:1,calls:1,out:''});expect(result.err).not.toContain('PRIVATE_REDIRECT');
});
it('reports an ordinary 5xx arriving after the deadline as unavailable rather than a definite refusal',async()=>{
 const f=fixture();let now=0,out='',err='',calls=0;
 const code=await runAccessClient('sessions',['revoke',JSON.stringify({ref:'e'.repeat(64)})],{stdin:Readable.from([]),stdinIsTTY:false,env:{LOOM_URL:'http://loom',LOOM_TOKEN_FILE:join(f.home,'owner')},stdout:value=>out+=value,stderr:value=>err+=value},{now:()=>now,retry:async ms=>{now+=ms;},request:async()=>{calls++;now=5000;return new Response('PRIVATE LATE FAILURE',{status:503});}});
 expect({code,calls,out}).toEqual({code:1,calls:1,out:''});expect(err).toContain('unavailable');expect(err).not.toContain('PRIVATE LATE FAILURE');
});

it('rejects partial GraphQL errors and private extras in sessions and personal Account',async()=>{
 const f=fixture();
 for(const piece of ['token','sessions','account'] as const){
  const result=JSON.parse((await f.invoke(piece,[piece==='account'?'read':'list'])).out);
  const root=piece==='account'?{account:result}:{householdSetup:{[piece==='token'?'tokens':'sessions']:result}};
  const partial=await f.invoke(piece,[piece==='account'?'read':'list'],'owner',async()=>Response.json({data:root,errors:[{message:'PRIVATE ERROR'}]}));
  expect(partial).toMatchObject({code:1,out:''});expect(partial.err).not.toContain('PRIVATE');
  if(piece==='token')continue;
  const value=piece==='account'?{account:{...result,privateKey:'PRIVATE EXTRA'}}:{householdSetup:{sessions:[{...result[0],privateKey:'PRIVATE EXTRA'}]}};
  const extra=await f.invoke(piece,[piece==='account'?'read':'list'],'owner',async()=>Response.json({data:value}));expect(extra).toMatchObject({code:1,out:''});expect(extra.err).not.toContain('PRIVATE');
 }
 const malformed=await f.invoke('sessions',['list'],'owner',async()=>new Response('PRIVATE MALFORMED',{status:200}));expect(malformed).toMatchObject({code:1,calls:1,out:''});expect(malformed.err).toContain('Invalid daemon response');
 const unsafe=await f.invoke('token',['list'],'owner',f.transport,{LOOM_URL:'https://name:secret@loom',LOOM_TOKEN_FILE:join(f.home,'owner')});expect(unsafe.err).not.toContain('secret');
});

it('uses the same API for the primary loom CLI, including links, personal Account and project/member administration',async()=>{
 const f=fixture(),paths:string[]=[];vi.stubGlobal('fetch',async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{paths.push(new URL(String(input)).pathname);return f.transport(input,init);});
 const invoke=async(args:string[],actor:'owner'|'sam'='owner')=>{let out='',err='';const code=await runCli(args,{stdin:Readable.from([]),stdinIsTTY:false,env:{LOOM_URL:'http://loom',LOOM_TOKEN_FILE:join(f.home,actor),LOOM_HOME:'/must-not-open'},stdout:value=>out+=value,stderr:value=>err+=value});return{code,out,err};};
 expect(await invoke(['household','read'])).toMatchObject({code:0});
 expect(await invoke(['household','setMember',JSON.stringify({id:'pat',role:'member',fullOwner:false,agents:[]})])).toMatchObject({code:0});
 expect(await invoke(['household','setProject',JSON.stringify({id:'demo',name:'Demo',members:['sam'],agents:[],repositories:[]})])).toMatchObject({code:0});
 expect(await invoke(['token','list'])).toMatchObject({code:0});expect(await invoke(['sessions','list'])).toMatchObject({code:0});expect(await invoke(['account','read'],'sam')).toMatchObject({code:0});
 const link=await invoke(['token','link'],'sam');expect(link).toMatchObject({code:0,err:''});expect(link.out).toMatch(/^http:\/\/loom\/login\/[0-9a-f]{64}\n$/);
 expect(paths).toEqual(['/graphql','/api/household/setMember','/api/household/setProject','/graphql','/graphql','/graphql','/api/signin/link']);
});
it('never retries a lost link reply, refuses target identity input and validates the returned path',async()=>{
 const f=fixture();
 expect(await f.invoke('token',['link','{"member":"sam"}'])).toMatchObject({code:2,calls:0});
 for(const request of [async()=>new Response('PRIVATE LINK',{status:503}),async()=>{throw Error('PRIVATE LINK');},async()=>Response.json({ok:true,value:{path:'https://other.example/PRIVATE',expiresAt:'now'}})]){
  const result=await f.invoke('token',['link'],'sam',request);expect(result).toMatchObject({code:1,calls:1,out:''});expect(result.err).toContain('outcome unknown');expect(result.err).not.toContain('PRIVATE');
 }
 expect(await f.invoke('household',['setMember','{"id":"other","role":"member","agents":[]}'],'sam')).toMatchObject({code:1});
});

it('keeps roster metadata private and validates both agent administration outputs',async()=>{
 const f=fixture();expect(await f.invoke('household',['read'],'sam')).toMatchObject({code:1,out:''});
 const valid=JSON.parse((await f.invoke('household',['read'])).out);
 const extra=await f.invoke('household',['read'],'owner',async()=>Response.json({data:{householdSetup:{...valid,privateKey:'PRIVATE ROSTER'}}}));expect(extra).toMatchObject({code:1,out:''});expect(extra.err).not.toContain('PRIVATE');
 const agent={id:'art',about:'Fixture',markBg:'#000000',markFg:'#ffffff',faceShape:'pebble',faceEyes:'dot'};
 expect(await f.invoke('household',['setAgent',JSON.stringify(agent)])).toMatchObject({code:0,paths:['/api/household/setAgent']});
 expect(await f.invoke('household',['setAgentAccounts',JSON.stringify({agent:'art',github:['art-bot']})])).toMatchObject({code:0,paths:['/api/household/setAgentAccounts']});
 const link=await f.invoke('token',['link'],'sam');expect(link.code).toBe(0);
 const redeemed=await f.root.http.request(link.out.trim(),{method:'POST'});expect(redeemed.status).toBe(303);const cookie=redeemed.headers.get('set-cookie')!.split(';')[0];
 const session=await f.root.http.request('http://loom/auth/session',{headers:{cookie}});expect(await session.json()).toEqual({viewer:{kind:'member',id:'sam'}});
});
it('answers help and invalid JSON without touching transport even when a live connection is configured',async()=>{
 const f=fixture();
 for(const [piece,args] of [['household',['setMember','--help']],['household',['setAgent','[]']],['account',['revokeSession','--help']],['token',['link','--help']]] as const){expect((await f.invoke(piece,[...args])).calls).toBe(0);}
});

it('accepts primary global flags and refuses the legacy daemon dispatch without forwarding',async()=>{
 const f=fixture();let calls=0,out='',err='';vi.stubGlobal('fetch',async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{calls++;return f.transport(input,init);});
 const io={stdin:Readable.from([]),stdinIsTTY:false,env:{LOOM_TOKEN_FILE:join(f.home,'owner')},stdout:(text:string)=>out+=text,stderr:(text:string)=>err+=text};
 expect(await runCli(['--json','token','list','--url','http://loom'],io)).toBe(0);expect(JSON.parse(out)).toHaveLength(2);expect(calls).toBe(1);
 out='';expect(await runCli(['token','link','--help'],io)).toBe(0);expect(out).toContain('usage: loom token');expect(calls).toBe(1);
 expect(await runCliLocal(['token','list'],io)).toBe(2);expect(calls).toBe(1);
});
it('keeps the same household receipt when the successful reply is lost',async()=>{
 const f=fixture();let attempts=0;
 const result=await f.invoke('household',['setMember',JSON.stringify({id:'pat',role:'member',agents:[]})],'owner',async(input,init)=>{const response=await f.transport(input,init);if(++attempts===1){await response.body?.cancel();throw Error('lost');}return response;});
 expect(result).toMatchObject({code:0,calls:2});expect(new Set(result.bodies).size).toBe(1);
});

it('rejects irrelevant global flags before issuing links or changing household data',async()=>{
 const f=fixture();let calls=0;vi.stubGlobal('fetch',async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{calls++;return f.transport(input,init);});
 const io={stdin:Readable.from([]),stdinIsTTY:false,env:{LOOM_URL:'http://loom',LOOM_TOKEN_FILE:join(f.home,'owner')},stdout:()=>{},stderr:()=>{}};
 for(const args of [['token','link','--model','x'],['household','setMember','{"id":"pat","role":"member","agents":[]}','--client','y'],['--context-dir','/forbidden','token','create','{}']])expect(await runCli(args,io)).toBe(2);
 expect(calls).toBe(0);
});
it('the dedicated household binding uses shared HTTP and never reads a local household',async()=>{
 const f=fixture(),local=join(f.home,'must-not-open');let out='',err='';
 const before=[vi.mocked(readFileSync).mock.calls.length,vi.mocked(openSync).mock.calls.length,vi.mocked(readFile).mock.calls.length];
 const io={stdin:Readable.from([]),stdinIsTTY:false,env:{LOOM_URL:'http://loom',LOOM_TOKEN_FILE:join(f.home,'owner'),LOOM_HOME:local},stdout:(text:string)=>out+=text,stderr:(text:string)=>err+=text};
 expect(await runHouseholdClient(['read'],io,{request:f.transport,retry:async()=>{}})).toBe(0);expect(JSON.parse(out)).toMatchObject({members:expect.arrayContaining([expect.objectContaining({id:'owner'})])});
 vi.stubGlobal('fetch',f.transport);expect(await runCli(['token','list'],io)).toBe(0);
 const reads=[...vi.mocked(readFileSync).mock.calls.slice(before[0]),...vi.mocked(openSync).mock.calls.slice(before[1]),...vi.mocked(readFile).mock.calls.slice(before[2])].map(args=>String(args[0]));
 expect(reads.some(path=>path.startsWith(local))).toBe(false);expect(reads).toContain(join(f.home,'owner'));expect(err).toBe('');
});
