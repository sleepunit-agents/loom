import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Readable} from 'node:stream';
import {afterEach,expect,it} from 'vitest';
import {FakeClock} from '../core/clock.js';
import {createDataSchema} from '../core/data/database.js';
import {members,tokens,sessions} from '../core/data/schema.js';
import {sharedRoot} from '../shared-root.js';
import {runAccessClient} from './access-client.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
function fixture(){
 const home=mkdtempSync(join(tmpdir(),'fictional-signin-cli-'));clean.push(()=>rmSync(home,{recursive:true,force:true}));const client=new Database(':memory:');clean.push(()=>client.close());const clock=new FakeClock(),at=new Date(clock.now()).toISOString(),db=createDataSchema(client,()=>new Date(clock.now()).toISOString()),raw={owner:'a'.repeat(64),sam:'b'.repeat(64)},hash=(value:string)=>createHash('sha256').update(value).digest('hex');
 for(const member of ['owner','sam'] as const){db.insert(members).values({id:member,role:member==='owner'?'owner':'member',joinedAt:at}).run();db.insert(tokens).values({fingerprint:hash(raw[member]),kind:'owner',member,label:member,createdAt:at}).run();writeFileSync(join(home,member),raw[member],{mode:0o600});}
 db.insert(sessions).values({id:hash('c'.repeat(64)),token:hash(raw.sam),device:'Sam browser',via:'link',isAgent:false,issuedAt:at,seenAt:at,provedAt:at}).run();
 const root=sharedRoot({db,clock,originAllowed:()=>true,reportError:()=>{}});clean.push(()=>root.close());
 const transport:typeof fetch=async(input,init)=>await root.http.fetch(new Request(input,init));
 const invoke=async(piece:'token'|'sessions'|'account',args:string[],actor:'owner'|'sam'='owner',request:typeof fetch=transport,env?:NodeJS.ProcessEnv)=>{
  let out='',err='',time=0,calls=0;const bodies:string[]=[],paths:string[]=[];
  const code=await runAccessClient(piece,args,{stdin:Readable.from([]),stdinIsTTY:false,env:env??{LOOM_URL:'http://loom',LOOM_TOKEN_FILE:join(home,actor)},stdout:value=>out+=value,stderr:value=>err+=value},{now:()=>time,retry:async ms=>{time+=ms;},request:async(input,init)=>{calls++;bodies.push(String(init?.body));paths.push(new URL(String(input)).pathname);return request(input,init);}});
  return{code,out,err,calls,bodies,paths};
 };
 return{root,db,invoke,transport};
}
it('reads canonical owner lists and personal Account through the same shared GraphQL door',async()=>{
 const f=fixture();for(const piece of ['token','sessions'] as const){const result=await f.invoke(piece,['list','{}']);expect(result.code).toBe(0);expect(result.paths).toEqual(['/graphql']);expect(JSON.parse(result.out)).toHaveLength(piece==='token'?2:1);}
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
