import { it,expect,afterEach } from 'vitest';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { startLoom } from '../foundation.js';
import { fixtureSharing } from '../fixture.js';
import { FakeClock,type Viewer } from '../core/index.js';
import { installChanges } from '../pieces/changes/index.js';
import { change } from '../pieces/changes/fixture.js';
import { replaceChanges } from '../pieces/changes/store.js';
import { runCli, runCliLocal } from './index.js';
import { runChangesClient } from './changes-client.js';
const dirs:string[]=[],close:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const fn of close.splice(0)) await fn();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
async function setup(){
 const home=mkdtempSync(join(tmpdir(),'changes-client-'));dirs.push(home);const clock=new FakeClock();const owner:Viewer={kind:'member',id:'jonathan'};
 const app=await startLoom({home,clock,sharing:fixtureSharing,authenticate:()=>({viewer:owner,valid:()=>true}),install:app=>installChanges(app.db,app.operations,app.live,fixtureSharing)});close.push(app.close);
 const token=join(home,'token');writeFileSync(token,'fixture-token');
 const run=async(args:string[],request:typeof fetch=fetch)=>{let stdout='',stderr='';const bodies:string[]=[];const code=await runChangesClient(args,{stdout:s=>stdout+=s,stderr:s=>stderr+=s,stdin:Readable.from([]),stdinIsTTY:false,env:{LOOM_URL:app.url,LOOM_TOKEN_FILE:token}},{request:async(url,init)=>{bodies.push(String(init?.body));return request(url,init);},retry:async()=>{}});return {code,stdout,stderr,bodies};};
 return {...app,home,clock,owner,run};
}
it('prints open list lines and refresh acknowledgement through the real HTTP operation',async()=>{
 const app=await setup();replaceChanges(app.db,[change(),change({id:'github:acme/app#4',number:4,state:'merged',closed:new Date(app.clock.now()).toISOString()})]);
 expect(await app.run(['list'])).toMatchObject({code:0,stderr:'',stdout:'github:acme/app#3  CI green, approved, Waiting on you  — A change\n'});
 expect(await app.run(['refresh'])).toMatchObject({code:0,stdout:'asked for a read\n'});
 expect(app.db.prepare('SELECT due FROM changes_jobs').get()).toEqual({due:app.clock.now()});
});
it('ports compact project and cited-by output and ignores caller repo spoofing',async()=>{
 const app=await setup();replaceChanges(app.db,[change({project:'pond',body:'t-123'})]);
 const feed=await app.run(['project-feed','--json','--project','pond','--since','2099-01-01','--repo','other/private']);
 expect(feed.code).toBe(0);expect(JSON.parse(feed.stdout)).toEqual({groups:[{title:'Waiting on you',waiting:true,items:[{title:'app#3 A change',when:'2026-11-12T00:00:00Z',who:['art-bot'],status:'Waiting on you',ref:change().id,page:change().page}]}]});
 expect(JSON.parse((await app.run(['cited-by','t-123','--json'])).stdout)).toEqual([{id:change().id,title:'A change',short:'app#3',page:change().page,words:'CI green, approved, Waiting on you'}]);
 expect(JSON.parse((await app.run(['project-feed','--json','--project','other','--repo','acme/app'])).stdout)).toEqual({groups:[]});
});
it('puts made changes first, deduplicates explicit refs and preserves untracked hrefs',async()=>{
 const app=await setup();replaceChanges(app.db,[change({project:'pond'}),change({id:'github:acme/app#4',number:4,project:'pond',title:'Named'})]);
 expect(app.operations.call('direct',app.owner,'tasks.create',{title:'Made here',description:'acme/app#3',source:'conversation:cv-123456789abc',actor:'art',at:new Date(app.clock.now()).toISOString()},'make')).toMatchObject({ok:true,value:{result:{ok:true}}});
 // The attribution contract marks household task descriptions as trusted.
 const r=await app.run(['thread-feed','--json','--conversation','cv-123456789abc','--ref','github:ACME/APP#4','--ref','github:acme/app#3','--ref','github:other/app#9','--ref','github:other/app#9']);
 expect(r.code).toBe(0);const items=JSON.parse(r.stdout).items;
 expect(items).toHaveLength(3);expect(items[0]).toMatchObject({ref:change().id,made:true,tone:'warn'});expect(items[1]).toMatchObject({ref:'github:acme/app#4'});expect(items[2]).toEqual({title:'other/app#9',ref:'github:other/app#9',status:'Not tracked',href:'https://github.com/other/app/issues/9'});
});
it('caps project feeds at fifty across groups and rejects bad command/schema input',async()=>{
 const app=await setup();replaceChanges(app.db,Array.from({length:60},(_,i)=>change({id:`github:acme/app#${i+1}`,number:i+1,project:'pond',draft:i>29})));
 const feed=JSON.parse((await app.run(['project-feed','--project','pond'])).stdout);
 expect(feed.groups.map((g:{items:unknown[]})=>g.items.length)).toEqual([30,20]);
 expect(await app.run(['thread-feed','--conversation','no'])).toMatchObject({code:1,stdout:''});
 expect(await app.run(['cited-by','invalid'])).toMatchObject({code:1,stdout:''});
 expect(await app.run(['bogus'])).toMatchObject({code:2,stdout:''});
 expect(await app.run(['thread-feed','--ref'])).toMatchObject({code:2,stdout:''});
});
it('retries a dropped refresh with the same operation id and reports only generic failures',async()=>{
 const app=await setup();let calls=0;
 const result=await app.run(['refresh'],async(url,init)=>{const response=await fetch(url,init);if(++calls===1)throw new Error('SECRET upstream detail');return response;});
 expect(result.code).toBe(0);expect(result.bodies).toHaveLength(2);expect(result.bodies[0]).toBe(result.bodies[1]);expect(app.db.prepare('SELECT count(*) AS n FROM core_operations WHERE name=?').get('changes.refresh')).toEqual({n:1});
 expect(await app.run(['list'],async()=>{throw new Error('SECRET');})).toMatchObject({code:1,stdout:'',stderr:'loom-changes: loom daemon is unavailable\n'});
});
it('does not turn hidden records into untracked thread links for a restricted member',async()=>{
 const app=await setup();replaceChanges(app.db,[change({project:'other'}),change({id:'github:acme/app#4',number:4,project:'pond'})]);
 const answer=app.operations.call('direct',{kind:'member',id:'pollock'},'changes.thread-feed',{conversation:'cv-123456789abc',references:[change().id,'github:acme/app#4','github:public/app#99']});
 expect(answer).toMatchObject({ok:true,value:{items:[{ref:'github:acme/app#4'},{ref:'github:public/app#99',status:'Not tracked'}]}});
 if(answer.ok)expect((answer.value as {items:unknown[]}).items).toHaveLength(2);
});

it('routes loom changes to scoped operations despite a legacy executable and refuses HTTP CLI forwarding',async()=>{
 const app=await setup();replaceChanges(app.db,[change()]);
 const bin=mkdtempSync(join(tmpdir(),'changes-legacy-'));dirs.push(bin);
 writeFileSync(join(bin,'loom-changes'),'#!/bin/sh\necho legacy-adapter\n',{mode:0o755});
 let stdout='',stderr='';
 const io={stdout:(s:string)=>stdout+=s,stderr:(s:string)=>stderr+=s,stdin:Readable.from([]),stdinIsTTY:false,
  env:{PATH:bin,LOOM_URL:app.url,LOOM_TOKEN_FILE:join(app.home,'token')}};
 expect(await runCli(['changes','list'],io)).toBe(0);
 expect(stdout).toBe('github:acme/app#3  CI green, approved, Waiting on you  — A change\n');expect(stderr).toBe('');
 stdout='';
 expect(await runCliLocal(['changes','refresh'],io)).toBe(2);
 expect(stdout).toBe('');expect(stderr).toContain('use /api/changes operations directly');
 expect(app.db.prepare('SELECT due FROM changes_jobs').get()).toBeUndefined();
});

it('rejects implicit and malformed origins before reading or sending credentials',async()=>{
 const app=await setup();
 for(const url of [undefined,'ftp://example.com','https://user:pass@example.com','https://example.com/path','https://example.com/?query','https://example.com/#fragment']) {
  let calls=0,stdout='',stderr='';
  const code=await runChangesClient(['refresh'],{stdout:s=>stdout+=s,stderr:s=>stderr+=s,stdin:Readable.from([]),stdinIsTTY:false,env:{LOOM_URL:url,LOOM_TOKEN_FILE:join(app.home,'token')}},{request:async()=>{calls++;throw Error('secret');},retry:async()=>{}});
  expect(code).toBe(1);expect(stdout).toBe('');expect(calls).toBe(0);expect(stderr).not.toContain('secret');
 }
});
it('rejects HTTP failures and malformed success values and redacts decoded credentials',async()=>{
 const app=await setup();
 for(const [args,value,status] of [
  [['list'],{stdout:'diagnostic'},401], [['refresh'],{message:'diagnostic'},500],
  [['thread-feed','--conversation','cv-123456789abc'],{items:[{title:'bad'}]},200],
  [['project-feed'],{groups:'diagnostic'},200], [['cited-by','t-1'],{},200],
  [['list'],null,200], [['refresh'],{message:'arbitrary diagnostic'},200],
 ] as [string[],unknown,number][]) {
  const result=await app.run(args,async()=>Response.json({ok:true,value},{status}));
  expect(result).toMatchObject({code:1,stdout:''});expect(result.stderr).not.toContain('diagnostic');
 }
 const result=await app.run(['list'],async()=>Response.json({ok:true,value:{stdout:'fixture-token ghp_OTHERSECRET'}}));
 expect(result).toMatchObject({code:0,stdout:'[redacted] [redacted]'});
});
it('retries a committed refresh after a dropped response body with the same id',async()=>{
 const app=await setup();let calls=0;
 const result=await app.run(['refresh'],async(url,init)=>{
  const response=await fetch(url,init);
  if(++calls===1){await response.body?.cancel();return new Response(new ReadableStream({start(controller){controller.error(Error('secret body'));}}));}
  return response;
 });
 expect(result).toMatchObject({code:0,stdout:'asked for a read\n'});expect(result.bodies).toHaveLength(2);expect(result.bodies[0]).toBe(result.bodies[1]);
 expect(app.db.prepare('SELECT count(*) AS n FROM core_operations WHERE name=?').get('changes.refresh')).toEqual({n:1});
});
it('refuses a same-origin redirect before it can receive the bearer at another path',async()=>{
 const {createServer}=await import('node:http');let redirected=0;
 const server=createServer((req,res)=>{if(req.url==='/api/changes/list'){res.writeHead(307,{location:'/unexpected'});res.end();}else{redirected++;res.end('{}');}});
 await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok));close.push(()=>new Promise<void>(ok=>server.close(()=>ok())));
 const address=server.address();if(!address||typeof address==='string')throw Error('no address');
 const app=await setup();let stdout='';
 const code=await runChangesClient(['list'],{stdout:s=>stdout+=s,stderr:()=>{},stdin:Readable.from([]),stdinIsTTY:false,env:{LOOM_URL:`http://127.0.0.1:${address.port}`,LOOM_TOKEN_FILE:join(app.home,'token')}},{request:fetch,retry:async()=>{}});
 expect(code).toBe(1);expect(stdout).toBe('');expect(redirected).toBe(0);
});
