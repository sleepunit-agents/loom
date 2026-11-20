import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {eq} from 'drizzle-orm';
import {afterEach,expect,it} from 'vitest';
import {bodyFixture,bodyCredentials} from '../test/fixtures/conversation-body.js';
import {agentDeniedTools,inbox,jobs,messages,turns} from './core/data/schema.js';
import {bodyProgramTools} from './runtime/body-program-tools.js';
import {bodySecretTools} from './runtime/body-secret-tools.js';
import {houseRuntimeCli} from './house-runtime-cli.js';

const clean:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});

it('records a CLI update in its assigned Comms conversation and leaves the mail for the final reply',async()=>{
 const f=await bodyFixture(clean);
 const cv=f.thread.conversation;
 expect((await f.send('Work on it','start')).status).toBe(200);
 f.root.writes.run(()=>f.root.services.conversations.take(cv,'job'));
 const access={url:'https://loom.invalid',token:bodyCredentials.body,signal:new AbortController().signal,
   agent:'art',job:'job',conversation:cv,clock:f.clock,fetch:async(url:RequestInfo|URL,init?:RequestInit)=>f.root.http.request(new Request(url,init))};
 const port=bodyProgramTools({...access,onStop(){},onStatus(){}});clean.push(port.close);
 const protectedWords='fixture-private-value';
 const tools=await bodySecretTools({...access,houseSend:{venue:'loom',denied:[],call:port.call},alsoSecret:()=>[Buffer.from(protectedWords)]});clean.push(tools.close);
 const env={LOOM_BODY_HOUSE_SEND:tools.houseSend};
 const [portNumber,sendKey]=tools.houseSend!.split('.');
 for(const route of ['/house/note','/mcp']){
  const response=await fetch('http://127.0.0.1:'+portNumber+route,{method:'POST',headers:{authorization:'Bearer '+sendKey}});
  expect(response.status).toBe(403);
 }
 const disabled=await bodySecretTools({...access,houseSend:{venue:'loom',denied:['mcp__loom_secrets__runtime_*'],call:port.call}});
 clean.push(disabled.close);
 expect(disabled.houseSend).toBeUndefined();
 const execute=async(text:string,ref=randomUUID(),conversation=cv)=>{
  let stdout='';
  const code=await houseRuntimeCli(['send','--conversation',conversation,'--text',text,'--id',ref],{stdout:s=>{stdout+=s;},stderr(){}},env);
  return {code,result:JSON.parse(stdout)};
 };
 const ref=randomUUID(),text='Still working on it';
 const args=['src/index.ts','runtime','send','--conversation',cv,'--id',ref,'--text',text];
 const first=await promisify(execFile)(process.execPath,['--import','tsx',...args],{env:{...process.env,...env}});
 expect(JSON.parse(first.stdout)).toEqual({ok:true,recorded:true,ref,seq:2});
 expect(await execute(text,ref)).toMatchObject({code:0,result:{seq:2}});
 expect((await execute('Different',ref)).code).toBe(1);
 expect((await execute(protectedWords)).code).toBe(1);
 expect((await execute(text,randomUUID(),'different')).code).toBe(1);
 expect(f.db.select().from(inbox).get()?.state).toBe('taken');
 expect(f.db.select().from(turns).all().at(-1)).toMatchObject({kind:'note',fromKind:'agent',run:'job'});
 expect(f.db.select().from(messages).all()).toHaveLength(2);
 f.root.writes.run(()=>f.db.insert(agentDeniedTools).values({agent:'art',pattern:'mcp__loom__runtime_send',guestsOnly:false}).run());
 expect((await execute('Denied after the room changed')).code).toBe(1);
 expect((await execute(text,ref)).code).toBe(1);
 f.root.writes.run(()=>f.db.delete(agentDeniedTools).where(eq(agentDeniedTools.agent,'art')).run());
 f.root.writes.run(()=>f.db.update(jobs).set({state:'done'}).where(eq(jobs.id,'job')).run());
 expect((await execute(text,ref)).code).toBe(1);
});
