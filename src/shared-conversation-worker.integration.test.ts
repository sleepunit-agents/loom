/** Real builder and body children through the production worker, fictitious only. */
import {afterEach,expect,it,vi} from 'vitest';
import {createServer} from 'node:http';
import {resolve,join} from 'node:path';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {getRequestListener} from '@hono/node-server';
import {eq} from 'drizzle-orm';
import {bodyFixture,bodyCredentials as raw,credentialHash as hash} from '../test/fixtures/conversation-body.js';
import {httpWorkerControl} from './runtime/worker-http.js';
import {commandWorkerExecutor} from './runtime/worker-process.js';
import {workOnce} from './runtime/worker.js';
import * as s from './core/data/schema.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
it.each(['fixture','claude'] as const)('builds and runs a real %s private Comms recipient through production worker enrollment, running ACK and stdin bootstrap',async harness=>{
 const f=await bodyFixture(clean,{initialTime:Date.now(),modelRoles:()=>[{model:'requested-model',provider:'provider',harness,series:'series'}]});
 f.root.writes.run(()=>{
  f.db.delete(s.tokens).where(eq(s.tokens.job,'job')).run();f.db.update(s.conversations).set({job:null}).run();f.db.delete(s.jobs).run();
  f.db.insert(s.boxAgents).values({box:'box',agent:'art',lent:false}).run();f.db.insert(s.agentBoxes).values({agent:'art',box:'box',position:0}).run();f.db.insert(s.agentModels).values({agent:'art',model:'requested-model',position:0}).run();
  f.db.insert(s.agentRunSettings).values({agent:'art',houseRepository:'fixture',houseFile:'Housefile',houseBranch:'next',nestedContainers:false,gpu:false}).run();
  f.db.insert(s.modelAccounts).values({id:'account',owner:'alice',provider:'provider',label:'Fixture account',hasRoom:true}).run();
  f.db.insert(s.modelAccountBoxes).values({account:'account',box:'box'}).run();f.db.insert(s.modelAccountWindows).values({account:'account',window:'week',usage:0.1,usageReadAt:new Date(f.clock.now()).toISOString(),resetsAt:new Date(f.clock.now()+7*86400000).toISOString(),durationMs:7*86400000}).run();
  f.db.insert(s.tempoSettings).values({whoKind:'agent',who:'art',settleSeconds:1}).run();
 });
 const server=createServer(getRequestListener(f.root.http.fetch));await new Promise<void>(yes=>server.listen(0,'127.0.0.1',yes));clean.push(async()=>{server.closeAllConnections();await new Promise<void>(yes=>server.close(()=>yes()));});
 const address=server.address();if(!address||typeof address==='string')throw Error('No worker listener');const url='http://127.0.0.1:'+address.port;
 const sent=await fetch(url+'/api/comms/send',{method:'POST',headers:{cookie:'loom_ui='+raw.memberCookie,'content-type':'application/json'},body:JSON.stringify({input:{thread:f.thread.id,words:'PRIVATE WORKER INPUT',clientId:'worker-input'},id:'worker-send'})});expect(sent.status).toBe(200);f.clock.advance(1000);
 const abort=new AbortController();clean.push(()=>abort.abort());
 const control=httpWorkerControl({url,token:raw.runner,signal:abort.signal});
 const enroll=control.enrollBody!;let owned:Uint8Array|undefined,tokenCopy:Buffer|undefined;
 clean.push(()=>{tokenCopy?.fill(0);});
 control.enrollBody=async(...args)=>{const result=await enroll(...args);owned=result.token;tokenCopy=Buffer.from(result.token);expect(f.db.select().from(s.jobs).get()?.state).toBe('starting');return result;};
 let acknowledged=false;const started=control.started.bind(control);control.started=async(...args)=>{expect(f.db.select().from(s.jobs).get()?.state).toBe('starting');await started(...args);expect(f.db.select().from(s.jobs).get()?.state).toBe('running');acknowledged=true;};
 const finish=vi.spyOn(control,'finish');
 const env={PATH:process.env.PATH??'',NODE_NO_WARNINGS:'1'},cwd=resolve(import.meta.dirname,'..');
 let bodyArgs=['--import','tsx','test/fixtures/conversation-worker-child.mjs'];
 if(harness==='claude'){
  const directory=await mkdtemp(join(tmpdir(),'loom-claude-proof-'));clean.push(()=>rm(directory,{recursive:true,force:true}));
  const provider=join(directory,'fake-claude.cjs'),config=join(directory,'body.json');
  await writeFile(provider,[
   '#!'+process.execPath,
   "const args=process.argv.slice(2),session=args[args.indexOf('--session-id')+1];",
   "if(args[args.indexOf('--model')+1]!=='requested-model'||!args.includes('--no-session-persistence'))process.exit(9);",
   "let words='';process.stdin.setEncoding('utf8');process.stdin.on('data',part=>words+=part);",
   "process.stdin.on('end',()=>{if(words!=='PRIVATE WORKER INPUT')process.exit(8);",
   "process.stderr.write('PRIVATE NATIVE DIAGNOSTIC');",
   "process.stdout.write(JSON.stringify({type:'assistant',parent_tool_use_id:null,session_id:session,message:{model:'fixture-actual-model',content:[{type:'text',text:'PRIVATE WORKER REPLY'}]}})+'\\n');",
   "process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,session_id:session,result:'PRIVATE WORKER REPLY'})+'\\n');});",
  ].join('\n'),{mode:0o700});
  await writeFile(config,JSON.stringify({command:provider,cwd}),{mode:0o600});
  bodyArgs=['--import','tsx','src/body.ts',config];
 }
 const executor=commandWorkerExecutor({build:{command:process.execPath,args:['-e',"let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const value=JSON.parse(input);if(typeof value.job!=='string'||value.bootstrap||value.house.repository!=='fixture')process.exitCode=1;else process.stdout.write(JSON.stringify({build:'fixture-image'}));});"],cwd,env},runners:{[harness]:{command:process.execPath,args:bodyArgs,cwd,env,bodyBootstrap:true}}});
 // Retain the native executor; observe its exact release boundary against the real ACK.
 const start=executor.start.bind(executor);executor.start=(...args)=>{const body=start(...args),release=body.release.bind(body);body.release=(...input)=>{expect(acknowledged).toBe(true);return release(...input);};return body;};
 const running=workOnce({box:'box',control,executor,signal:abort.signal,schedule:{every:()=>()=>{}}});clean.push(async()=>{abort.abort();await running.catch(()=>{});});
 expect(await running).toBe('finished');const job=f.db.select().from(s.jobs).get()!;
 expect(job).toMatchObject({state:'done',brief:'',logTail:null,exitCode:0,build:'fixture-image'});expect(finish).toHaveBeenCalledExactlyOnceWith(job.id,0,'');expect(owned?.every(byte=>byte===0)).toBe(true);
 // The callback pause before confirmation is independently asserted by the real native recipient proof.
 expect(f.db.select().from(s.inbox).get()).toMatchObject({state:'done',toKind:'agent',to:'art',job:job.id});expect(f.db.select().from(s.messages).all().map(row=>row.delivery)).toEqual(['delivered',null]);
 expect(f.db.select().from(s.turns).all()).toMatchObject([{kind:'message',fromKind:'person'},{kind:'reply',run:job.id,model:'fixture-actual-model',outcome:harness==='fixture'?'answered':'progressed',...(harness==='fixture'?{latencyMs:23}:{})}]);expect(f.db.select().from(s.conversations).get()).toMatchObject({job:null,turnCount:2});
 if(harness==='fixture')expect(f.db.select().from(s.digests).get()).toMatchObject({run:job.id,revision:1,summary:'Completed fictitious worker input'});
 else expect(f.db.select().from(s.digests).all()).toEqual([]);
 expect(f.db.select().from(s.agentStatus).get()).toMatchObject({state:'idle',work:harness==='fixture'?'Fictitious work complete':''});
 const messages=f.db.select().from(s.messages).all();expect(await Promise.all(messages.map(row=>f.key.open(row.words!)))).toEqual(['PRIVATE WORKER INPUT','PRIVATE WORKER REPLY']);
 expect(tokenCopy).toBeDefined();const token=tokenCopy!.toString();expect(f.db.select().from(s.tokens).where(eq(s.tokens.fingerprint,hash(token))).get()).toMatchObject({job:job.id,madeFrom:hash(raw.runner)});
 const denied=await fetch(url+'/api/conversation/status',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({input:{state:'working',work:''},id:'ended'})});expect(denied.status).toBe(401);
 const durable=f.db.$client.serialize();for(const value of [token,'PRIVATE WORKER INPUT','PRIVATE WORKER REPLY','PRIVATE NATIVE DIAGNOSTIC'])expect(durable.includes(Buffer.from(value))).toBe(false);
},20000);
