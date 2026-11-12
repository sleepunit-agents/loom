import { expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

it('independent listeners pull follower-only collection subscriptions and deliver locally across retirement', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-periodic-collections-'));
  writeFileSync(join(home, 'value'), 'one');
  const url = (p: string) => JSON.stringify(new URL(p, import.meta.url).href);
  const children: ChildProcess[] = [];
  const start = async (name: string, eligible: boolean) => {
    const code = `import {createServer} from 'node:http';import {readFileSync,appendFileSync} from 'node:fs';
import {PeriodicOwner} from ${url('./periodic-owner.ts')};import {periodicContext} from ${url('./periodic-context.ts')};
import {configureCollectionBackground,openStream,closeStream,prepare,attach,deliverNow} from ${url('../collections/subs.ts')};
import {CORE_TYPES,registerCoreSource} from ${url('../collections/core-types.ts')};import {nudge} from ${url('../collections/pull.ts')};import {withLog,indexOf} from ${url('../collections/log.ts')};
const home=${JSON.stringify(home)}, name=${JSON.stringify(name)}, h={home,agents:['art']}, env={LOOM_HOME:home}, viewer={kind:'core'};
registerCoreSource(home,'agent-status',async()=>{const reason=readFileSync(home+'/value','utf8');if(periodicContext.getStore())appendFileSync(home+'/calls',name+':'+reason+'\\n');return [{id:'art',agent:'art',reason,audience:{members:['jonathan']}}];});
const owner=new PeriodicOwner(home,()=>{});configureCollectionBackground(()=>h,()=>env,owner);owner.setEligible(${eligible});
const provider={name:'loom',owners2:true,types:{'agent-status':CORE_TYPES['agent-status']}},q={id:'q',type:'agent-status',version:1,where:[],order:[],limit:100,after:null,fields:['agent','reason'],aggregates:[]};
const answer=()=>withLog(home,db=>indexOf(db,'loom/agent-status').map(r=>JSON.parse(r.record)));
const server=createServer(async(req,res)=>{try{
if(req.url==='/events'){res.writeHead(200,{'content-type':'text/event-stream'});res.write(': open\\n\\n');const port={id:'stream',session:'session',viewer:()=>viewer,frame:(event,data)=>{res.write('event: '+event+'\\ndata: '+JSON.stringify(data)+'\\n\\n');return 1;},seq:()=>0,behind:()=>0,close:()=>res.end()};openStream(()=>h,()=>env,port,viewer);res.on('close',()=>closeStream(home,port.id));const {startSeq}=await prepare(()=>h,()=>env,provider,'agent-status');await attach(()=>h,()=>env,{stream:port.id,session:port.session},viewer,provider,q,{next:null,complete:true},[],undefined,undefined,startSeq,async()=>{const rows=answer();return {rows,admitted:rows};});await nudge(home,'loom/agent-status');await deliverNow(home);return;}
if(req.url==='/nudge')await nudge(home,'loom/agent-status');if(req.url==='/retire')owner.setEligible(false);if(req.url==='/activate')owner.setEligible(true);res.end('ok');}catch(e){res.statusCode=500;res.end(String(e));}});server.listen(0,'127.0.0.1',()=>process.send(server.address().port));`;
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
    writeFileSync(join(home, 'value'), 'two'); await fetch(`${follower}/nudge`);
    await expect.poll(() => frames, { timeout: 10_000 }).toContain('"reason":"two"');
    expect(readFileSync(join(home, 'calls'), 'utf8')).toContain('leader:two');
    await fetch(`${leader}/retire`); await fetch(`${follower}/activate`);
    writeFileSync(join(home, 'value'), 'three'); await fetch(`${follower}/nudge`);
    await expect.poll(() => frames, { timeout: 10_000 }).toContain('"reason":"three"');
    expect(readFileSync(join(home, 'calls'), 'utf8')).toContain('follower:three');
  } finally {
    stream?.destroy();
    await Promise.all(children.map(async c => { if (c.exitCode !== null) return; const gone = once(c, 'exit'); c.kill('SIGKILL'); await gone; }));
    rmSync(home, { recursive: true, force: true });
  }
}, 40_000);
