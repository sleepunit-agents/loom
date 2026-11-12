import { expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

it('an owner with no browsers refreshes follower-only HTTP streams, serves follower requests and hands off on retirement', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-periodic-streams-'));
  const piece = join(home, 'loom-probe');
  writeFileSync(join(home, 'value'), 'one');
  writeFileSync(piece, `#!${process.execPath}
const fs=require('node:fs'),home=${JSON.stringify(home)};
fs.appendFileSync(home+'/calls','call\\n');
console.log(JSON.stringify({v:2,scope:true,owners:2,tile:{label:'Probe',value:fs.readFileSync(home+'/value','utf8')+':'+process.env.LOOM_SCOPE+':'+process.env.LOOM_OWNER_SCOPE}}));
`); chmodSync(piece, 0o755);
  const env = { PATH: `${home}:/usr/bin:/bin`, LOOM_HOME: home, LOOM_SCOPE: 'art', LOOM_OWNER_SCOPE: 'art' };
  const live = new URL('../ui/live.ts', import.meta.url).href;
  const pieces = new URL('../ui/pieces.ts', import.meta.url).href;
  const owner = new URL('./periodic-owner.ts', import.meta.url).href;
  const children: ChildProcess[] = [];
  const start = async (eligible: boolean) => {
    const code = `import {createServer} from 'node:http';import {PeriodicOwner} from ${JSON.stringify(owner)};import {configureManifestBackground,openStream,piecesMoved} from ${JSON.stringify(live)};import {pieceManifests,sharedPiecePrints} from ${JSON.stringify(pieces)};
const env=${JSON.stringify(env)},owner=new PeriodicOwner(env.LOOM_HOME,()=>{});configureManifestBackground(env.LOOM_HOME,env,owner);owner.setEligible(${eligible});
const server=createServer(async(req,res)=>{if(req.url==='/events'){openStream(res,env,env.LOOM_HOME,{}, {sees:'*',session:'probe',place:()=>'*'});return;}if(req.url==='/retire')owner.setEligible(false);if(req.url==='/activate')owner.setEligible(true);if(req.url==='/move')piecesMoved(env.LOOM_HOME,${JSON.stringify(piece)});res.end(req.url==='/read'?JSON.stringify(await pieceManifests(env)):req.url==='/cached'?JSON.stringify([...sharedPiecePrints(env)]):'ok');});server.listen(0,'127.0.0.1',()=>process.send(server.address().port));`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    children.push(child); const [port] = await once(child, 'message'); return `http://127.0.0.1:${port}`;
  };
  let stream: ReturnType<typeof request> | undefined;
  try {
    const leader = await start(true), follower = await start(false);
    let frames = '';
    stream = request(`${follower}/events`, res => { res.setEncoding('utf8'); res.on('data', s => { frames += s; }); });
    stream.on('error', () => {}); stream.end();
    await expect.poll(() => existsSync(join(home, 'calls')), { timeout: 10_000 }).toBe(true);
    const calls = () => readFileSync(join(home, 'calls'), 'utf8').trim().split('\n').length;
    const read = async () => JSON.stringify(await (await fetch(`${follower}/read`)).json());
    const cached = async () => (await fetch(`${follower}/cached`)).text();
    await expect.poll(cached, { timeout: 10_000 }).toContain('one:art:art');
    expect(await read()).toContain('one:art:art'); expect(calls()).toBe(1);
    // Changed results reach the follower's own stream; delivery never moves to the owner.
    writeFileSync(join(home, 'value'), 'two'); await fetch(`${follower}/move`);
    await expect.poll(() => frames.includes('event: page'), { timeout: 15_000 }).toBe(true);
    await expect.poll(cached, { timeout: 15_000 }).toContain('two:art:art');
    expect(await read()).toContain('two:art:art'); expect(calls()).toBe(2);
    await fetch(`${leader}/retire`); await fetch(`${follower}/activate`);
    writeFileSync(join(home, 'value'), 'three'); await fetch(`${follower}/move`);
    await expect.poll(cached, { timeout: 15_000 }).toContain('three:art:art');
    expect(calls()).toBe(3);
  } finally {
    stream?.destroy();
    await Promise.all(children.map(async c => { const gone = once(c, 'exit'); c.kill('SIGKILL'); await gone; }));
    rmSync(home, { recursive: true, force: true });
  }
}, 45_000);
