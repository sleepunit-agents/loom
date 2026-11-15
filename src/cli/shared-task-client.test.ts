import Database from 'better-sqlite3';
import {afterEach,expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {createDataSchema} from '../core/data/database.js';
import {members,tokens} from '../core/data/schema.js';
import {eq} from 'drizzle-orm';
import {serveShared} from '../shared-serve.js';
import {FakeClock} from '../core/clock.js';
import {runSharedTaskClient} from './shared-task-client.js';
// Measurement helpers are MJS; this boundary test runs its built client on real HTTP.
// @ts-expect-error no declarations are shipped for measurement scripts
import {taskstoreClientAction} from '../../scripts/rebuild-taskstore-client.mjs';
const clean:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
async function fixture(){
 const folder=mkdtempSync(join(tmpdir(),'loom-task-cli-'));clean.push(()=>rmSync(folder,{recursive:true,force:true}));const client=new Database(':memory:');clean.push(()=>{client.close();});const clock=new FakeClock(Date.now()),db=createDataSchema(client),at=new Date(clock.now()).toISOString(),token='a'.repeat(64),file=join(folder,'token');writeFileSync(file,token,{mode:0o600});
 db.insert(members).values([{id:'alice',role:'member',joinedAt:at},{id:'bob',role:'member',joinedAt:at}]).run();db.insert(tokens).values({fingerprint:createHash('sha256').update(token).digest('hex'),label:'Fictitious caller',kind:'owner',member:'alice',createdAt:at}).run();
 const app=await serveShared({db,clock,originAllowed:()=>true,reportError:()=>{},port:0});clean.push(()=>app.close());
 const create=(title:string,owner='alice')=>app.writes.run(()=>app.services.tasks.create({title,goal:'Fictitious goal',why:'Verify the canonical command-line door',owner:{kind:'member',id:owner}},{kind:'member',id:owner})).value;
 let out='',err='';const io={stdin:Readable.from([]),stdinIsTTY:false,env:{LOOM_URL:app.url,LOOM_TOKEN_FILE:file},stdout:(text:string)=>{out+=text;},stderr:(text:string)=>{err+=text;}};
 const invoke=async(args:string[],request:typeof fetch=fetch)=>{out='';err='';const code=await runSharedTaskClient(args,io,{request,retry:async()=>{}});return{code,out,err};};
 return{app,db,create,invoke,token,io,folder};
}
it('reads the actual shared ready queue without guessing around invisible blockers',async()=>{
 const f=await fixture(),ready=f.create('Ready'),blocked=f.create('Blocked'),hidden=f.create('Private blocker','bob');f.app.writes.run(()=>f.app.services.tasks.link(blocked.id,hidden.id,'blocks'));
 const result=await f.invoke(['ready']);expect(result.code,result.out+result.err).toBe(0);expect(JSON.parse(result.out).entries.map((row:{id:string})=>row.id)).toEqual([ready.id]);expect(result.out).not.toContain(hidden.title);expect(result.out).not.toContain(f.token);
});
it('uses current caller attribution for commands, tolerates a lost response once and refuses revoked credentials',async()=>{
 const f=await fixture(),input={action:'create',input:{title:'CLI-created',goal:'Fictitious goal',why:'Verify write receipt',owner:{kind:'member',id:'alice'}}};
 const requests:string[]=[];let lose=true;
 const result=await f.invoke(['command',JSON.stringify(input)],async(url,init)=>{expect(new URL(String(url)).pathname).toBe('/api/tasks/command');expect(init?.redirect).toBe('error');requests.push(String(init?.body));const response=await fetch(url,init);if(lose){lose=false;await response.body?.cancel();throw Error(f.token);}return response;});
 expect(result.code,result.out+result.err).toBe(0);expect(requests).toHaveLength(2);expect(requests[0]).toBe(requests[1]);const id=JSON.parse(result.out).id;
 expect(f.app.services.tasks.list().filter(row=>row.title==='CLI-created')).toHaveLength(1);expect(f.app.services.tasks.get(id)).toMatchObject({createdByKind:'member',createdBy:'alice'});
 expect((await f.invoke(['show',id])).code).toBe(0);expect(JSON.parse((await f.invoke(['search','CLI-created'])).out).tasks).toHaveLength(1);
 const forged=await f.invoke(['command',JSON.stringify({...input,actor:'bob'})]);expect(forged.code).toBe(1);expect(f.app.services.tasks.list()).toHaveLength(1);
 f.app.writes.run(()=>f.db.update(tokens).set({revokedAt:new Date().toISOString()}).where(eq(tokens.fingerprint,createHash('sha256').update(f.token).digest('hex'))).run());
 const denied=await f.invoke(['ready']);expect(denied.code).toBe(1);expect(denied.out+denied.err).not.toContain('CLI-created');expect(denied.out+denied.err).not.toContain(f.token);
});
it('keeps hidden records absent from list/show/search and uses the same command door for stdin',async()=>{
 const f=await fixture(),hidden=f.create('Private Bob task','bob');
 expect(JSON.parse((await f.invoke(['list'])).out).tasks).toEqual([]);expect((await f.invoke(['show',hidden.id])).code).toBe(1);expect(JSON.parse((await f.invoke(['search','Private Bob'])).out).tasks).toEqual([]);
 f.io.stdin=Readable.from([JSON.stringify({action:'create',input:{title:'From stdin',goal:'Goal',why:'Reason',owner:{kind:'member',id:'alice'}}})]);expect((await f.invoke(['command','--file','-'])).code).toBe(0);
});
it('rejects malformed usage before transport and never prints credential echoes from a malformed response',async()=>{
 const f=await fixture();let calls=0;
 const request:typeof fetch=async()=>{calls++;return Response.json({errors:[{message:f.token}]});};
 expect((await f.invoke(['ready','--bad'],request)).code).toBe(2);expect(calls).toBe(0);
 const bad=await f.invoke(['ready'],request);expect(bad.code).toBe(1);expect(bad.out+bad.err).not.toContain(f.token);expect(calls).toBe(1);
});
it('runs the walkthrough helper with an actual narrow programme and the built client over loopback HTTP',async()=>{
 const f=await fixture();f.app.writes.run(()=>f.db.update(members).set({role:'owner'}).where(eq(members.id,'alice')).run());
 const page={request:{post:async(url:string,options:{headers?:Record<string,string>;data:unknown})=>{
  const response=await fetch(url,{method:'POST',headers:{...options.headers,authorization:'Bearer '+f.token,'content-type':'application/json'},body:JSON.stringify(options.data)});
  return{status:()=>response.status,json:()=>response.json()};
 }}};
 expect(await taskstoreClientAction({page,app:f.app,home:f.folder,member:'alice'})).toEqual({ok:true,builtClient:true,canonicalRead:true,canonicalWrite:true,closedLeavesQueue:true,revokedRefused:true});
});
