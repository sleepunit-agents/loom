import { expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

it('independent listeners pull follower-only collection subscriptions and deliver locally across retirement', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-periodic-collections-'));
  writeFileSync(join(home, 'value'), 'one');
  const url = (p: string) => JSON.stringify(new URL(p, import.meta.url).href);
  const children: ChildProcess[] = [];
  const start = async (name: string, eligible: boolean) => {
    const code = `import {createServer} from 'node:http';import {readFileSync,appendFileSync} from 'node:fs';
import {handleUi,legacyUiAuth} from ${url('../ui/handler.ts')};import {changed} from ${url('../ui/live.ts')};
import {PeriodicOwner} from ${url('./periodic-owner.ts')};import {periodicContext} from ${url('./periodic-context.ts')};
import {configureCollectionBackground,openStream,closeStream,prepare,attach,deliverNow,queueCollectionNudge} from ${url('../collections/subs.ts')};
import {CORE_TYPES,registerCoreSource} from ${url('../collections/core-types.ts')};import {nudge} from ${url('../collections/pull.ts')};import {withLog,indexOf,domainOf} from ${url('../collections/log.ts')};
const home=${JSON.stringify(home)}, name=${JSON.stringify(name)}, h={home,agents:['art']}, env={LOOM_HOME:home}, viewer={kind:'core'};
const source=async()=>{const reason=readFileSync(home+'/value','utf8');if(periodicContext.getStore())appendFileSync(home+'/calls',name+':'+reason+'\\n');return [{id:'art',agent:'art',reason,audience:{members:['jonathan']}}];};registerCoreSource(home,'agent-status',source);
withLog(home,db=>domainOf(db,'loom/attention','loom'));
const owner=new PeriodicOwner(home,()=>{});configureCollectionBackground(()=>h,()=>env,owner);owner.setEligible(${eligible});
const provider={name:'loom',owners2:true,types:{'agent-status':CORE_TYPES['agent-status']}},q={id:'q',type:'agent-status',version:1,where:[],order:[],limit:100,after:null,fields:['agent','reason'],aggregates:[]};
const answer=()=>withLog(home,db=>indexOf(db,'loom/agent-status').map(r=>JSON.parse(r.record)));
const server=createServer(async(req,res)=>{try{
if(req.url==='/events'){res.writeHead(200,{'content-type':'text/event-stream'});res.write(': open\\n\\n');const port={id:'stream',session:'session',viewer:()=>viewer,frame:(event,data)=>{res.write('event: '+event+'\\ndata: '+JSON.stringify(data)+'\\n\\n');return 1;},seq:()=>0,behind:()=>0,close:()=>res.end()};openStream(()=>h,()=>env,port,viewer);res.on('close',()=>closeStream(home,port.id));const {startSeq}=await prepare(()=>h,()=>env,provider,'agent-status');await attach(()=>h,()=>env,{stream:port.id,session:port.session},viewer,provider,q,{next:null,complete:true},[],undefined,undefined,startSeq,async()=>{const rows=answer();return {rows,admitted:rows};});await nudge(home,'loom/agent-status');await deliverNow(home);return;}
if(req.url==='/hook'){req.headers.authorization='Bearer test';await handleUi(req,{writeHead(){},end(){}},'/logout',{contextDir:home,household:()=>h,auth:legacyUiAuth(['test']),env});registerCoreSource(home,'agent-status',source);await changed(['art']);res.end('ok');return;}
if(req.url==='/nudge'){for(let i=0;i<20;i++)queueCollectionNudge(home,'loom/agent-status','art');await deliverNow(home);}if(req.url==='/retire')owner.setEligible(false);if(req.url==='/activate')owner.setEligible(true);res.end('ok');}catch(e){res.statusCode=500;res.end(String(e));}});server.listen(0,'127.0.0.1',()=>process.send(server.address().port));`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    children.push(child); const [port] = await once(child, 'message'); return `http://127.0.0.1:${port}`;
  };
  let stream: ReturnType<typeof request> | undefined;
  try {
    const leader = await start('leader', true), follower = await start('follower', false);
    let frames = '';
    stream = request(`${follower}/events`, res => { res.setEncoding('utf8'); res.on('data', s => { frames += s; }); });
    stream.on('error', () => {}); stream.end();
    await expect.poll(() => frames, { timeout: 10_000 }).toContain('"reason":"one"');
    expect(existsSync(join(home, 'calls'))).toBe(true);
    expect(readFileSync(join(home, 'calls'), 'utf8')).not.toContain('follower:');
    writeFileSync(join(home, 'value'), 'two'); await fetch(`${follower}/hook`);
    await expect.poll(() => frames, { timeout: 10_000 }).toContain('"reason":"two"');
    expect(readFileSync(join(home, 'calls'), 'utf8')).toContain('leader:two');
    const log = new Database(join(home, 'collections', 'live.db'));
    try { expect(log.prepare("SELECT domain FROM refresh_requests WHERE domain = 'loom/attention'").get()).toEqual({ domain: 'loom/attention' }); } finally { log.close(); }
    // Kill the hint producer immediately after its acknowledged production change, before its delivery poll.
    const producer = await start('producer', false);
    const heldWriter = new Database(join(home, 'collections', 'live.db')); heldWriter.exec('BEGIN IMMEDIATE');
    try {
      writeFileSync(join(home, 'value'), 'producer-died');
      const started = performance.now(); await fetch(`${producer}/hook`);
      expect(performance.now() - started).toBeLessThan(1000);
      const producerGone = once(children[2], 'exit'); children[2].kill('SIGKILL'); await producerGone;
    } finally { heldWriter.exec('ROLLBACK'); heldWriter.close(); }
    await expect.poll(() => frames, { timeout: 10_000 }).toContain('\"reason\":\"producer-died\"');
    expect(readFileSync(join(home, 'calls'), 'utf8')).toContain('leader:producer-died');
    // Persist a follower hint with no eligible owner, then kill the old process before takeover.
    await fetch(`${leader}/retire`);
    writeFileSync(join(home, 'value'), 'three'); await fetch(`${follower}/nudge`);
    const gone = once(children[0], 'exit'); children[0].kill('SIGKILL'); await gone;
    await fetch(`${follower}/activate`);
    await expect.poll(() => frames, { timeout: 10_000 }).toContain('"reason":"three"');
    expect(readFileSync(join(home, 'calls'), 'utf8')).toContain('follower:three');
  } finally {
    stream?.destroy();
    await Promise.all(children.map(async c => { if (c.exitCode !== null || c.signalCode !== null) return; const gone = once(c, 'exit'); c.kill('SIGKILL'); await gone; }));
    rmSync(home, { recursive: true, force: true });
  }
}, 40_000);
it('a follower action delivers owner changes before answering, with owner work held and released', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-periodic-action-'));
  const url = (p: string) => JSON.stringify(new URL(p, import.meta.url).href);
  const children: ChildProcess[] = [];
  const start = async (name: string, eligible: boolean) => {
    const code = `import {createServer} from 'node:http';import {existsSync,writeFileSync,appendFileSync} from 'node:fs';import {setTimeout as sleep} from 'node:timers/promises';
import {PeriodicOwner} from ${url('./periodic-owner.ts')};import {configureCollectionBackground,openStream,prepare,attach,pullAfterAction} from ${url('../collections/subs.ts')};import {CORE_TYPES,registerCoreSource} from ${url('../collections/core-types.ts')};
const home=${JSON.stringify(home)},name=${JSON.stringify(name)},h={home,agents:['art']},env={LOOM_HOME:home},viewer={kind:'core'};
registerCoreSource(home,'project',async()=>{appendFileSync(home+'/calls',name+'\\n');writeFileSync(home+'/entered','yes');while(!existsSync(home+'/release'))await sleep(10);return [{id:'p',name:'owner update',audience:{household:true}}];});
const owner=new PeriodicOwner(home,()=>{});configureCollectionBackground(()=>h,()=>env,owner);owner.setEligible(${eligible});
const provider={name:'loom',owners2:true,types:{project:CORE_TYPES.project}},q={id:'q',type:'project',version:1,where:[],order:[],limit:100,after:null,fields:['name'],aggregates:[]};
const server=createServer(async(req,res)=>{try{
if(req.url==='/events'){res.writeHead(200,{'content-type':'text/event-stream'});res.write(': open\\n\\n');const port={id:'stream',session:'session',viewer:()=>viewer,frame:(event,data)=>{writeFileSync(home+'/delivered',JSON.stringify(data));res.write('event: '+event+'\\ndata: '+JSON.stringify(data)+'\\n\\n');return 1;},seq:()=>0,behind:()=>0,close:()=>res.end()};openStream(()=>h,()=>env,port,viewer);const {startSeq}=await prepare(()=>h,()=>env,provider,'project');await attach(()=>h,()=>env,{stream:port.id,session:port.session},viewer,provider,q,{next:null,complete:true},[],undefined,undefined,startSeq,async()=>({rows:[],admitted:[]}));writeFileSync(home+'/subscribed','yes');return;}
if(req.url==='/action'){await pullAfterAction(home,env,'loom');res.end(existsSync(home+'/delivered')?'delivered':'early');return;}res.end('ok');}catch(e){res.statusCode=500;res.end(String(e));}});server.listen(0,'127.0.0.1',()=>process.send(server.address().port));`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    children.push(child); const [port] = await once(child, 'message'); return `http://127.0.0.1:${port}`;
  };
  let stream: ReturnType<typeof request> | undefined;
  try {
    await start('owner', true); const follower = await start('follower', false);
    stream = request(`${follower}/events`, res => res.resume()); stream.on('error', () => {}); stream.end();
    await expect.poll(() => existsSync(join(home, 'subscribed'))).toBe(true);
    let done = false;
    const action = fetch(`${follower}/action`).then(r => r.text()).then(s => { done = true; return s; });
    await expect.poll(() => existsSync(join(home, 'entered'))).toBe(true);
    await new Promise(r => setTimeout(r, 100)); expect(done).toBe(false);
    expect(readFileSync(join(home, 'calls'), 'utf8')).not.toContain('follower');
    writeFileSync(join(home, 'release'), 'yes');
    expect(await action).toBe('delivered');
    expect(readFileSync(join(home, 'delivered'), 'utf8')).toContain('owner update');
    expect(readFileSync(join(home, 'calls'), 'utf8')).not.toContain('follower');
  } finally {
    stream?.destroy();
    await Promise.all(children.map(async c => { if (c.exitCode !== null || c.signalCode !== null) return; const gone = once(c, 'exit'); c.kill('SIGKILL'); await gone; }));
    rmSync(home, { recursive: true, force: true });
  }
}, 20_000);
