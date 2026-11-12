import { expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { movedSince } from '../comms.js';

it('publishes real Comms moves to follower thread streams across death, without waking another member or revoked viewer', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-periodic-comms-'));
  new Database(join(home, 'household.db')).close();
  movedSince(home, 0); // Install the production thread schema, with no encrypted words needed for a title move.
  const db = new Database(join(home, 'household.db'));
  for (const member of ['jonathan', 'other']) db.prepare(`INSERT INTO comms_threads
    (id,agent,member,conversation,opened,last,channel,first_id,first_hash,updated) VALUES (?, 'art', ?, ?, 'now', 'now', 1, ?, 'hash', 0)`)
    .run(member, member, member, member);
  db.close(); writeFileSync(join(home, 'allow'), 'yes');
  const url = (p: string) => JSON.stringify(new URL(p, import.meta.url).href);
  const children: ChildProcess[] = [];
  const start = async (name: string, active: boolean) => {
    const code = `import {createServer} from 'node:http';import {readFileSync,appendFileSync} from 'node:fs';
import {PeriodicOwner} from ${url('./periodic-owner.ts')};import {watchComms,openThreadStream} from ${url('../ui/comms-live.ts')};
import {onChanged} from ${url('../ui/live.ts')};import {threadOfConversation,setTitle} from ${url('../comms.ts')};
const home=${JSON.stringify(home)},name=${JSON.stringify(name)},h={home,agents:['art'],default:'art'},owner=new PeriodicOwner(home,()=>{});
onChanged(home,()=>appendFileSync(home+'/calls',name+'\\n'));watchComms(home,()=>owner);owner.setEligible(${active});
const server=createServer((req,res)=>{if(req.url.startsWith('/events/')){const thread=req.url.split('/').pop();openThreadStream(res,{},home,{thread,session:thread,from:0,may:()=>readFileSync(home+'/allow','utf8')==='yes'});return;}
if(req.url==='/activate')owner.setEligible(true);if(req.url.startsWith('/title/'))setTitle(h,threadOfConversation(home,'jonathan'),req.url.split('/').pop(),'member');res.end('ok');});server.listen(0,'127.0.0.1',()=>process.send(server.address().port));`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    children.push(child); const [port] = await once(child, 'message'); return `http://127.0.0.1:${port}`;
  };
  const streams: ReturnType<typeof request>[] = [];
  try {
    const leader = await start('leader', true), follower = await start('follower', true);
    const listen = (member: string) => {
      const state = { frames: '', closed: false };
      const req = request(`${follower}/events/${member}`, res => { res.setEncoding('utf8'); res.on('data', s => { state.frames += s; }); res.on('end', () => { state.closed = true; }); });
      req.on('error', () => {}); req.end(); streams.push(req); return state;
    };
    const mine = listen('jonathan'), other = listen('other');
    await expect.poll(() => mine.frames).toContain('retry:'); await expect.poll(() => other.frames).toContain('retry:');
    const count = () => (mine.frames.match(/event: message/g) ?? []).length;
    await fetch(`${follower}/title/first`);
    await expect.poll(count).toBe(1);
    expect(other.frames).not.toContain('event: message');
    expect(readFileSync(join(home, 'calls'), 'utf8')).toContain('leader');
    expect(readFileSync(join(home, 'calls'), 'utf8')).not.toContain('follower');
    const gone = once(children[0], 'exit'); children[0].kill('SIGKILL'); await gone;
    await fetch(`${follower}/title/second`);
    await expect.poll(count).toBe(2);
    expect(readFileSync(join(home, 'calls'), 'utf8')).toContain('follower');
    writeFileSync(join(home, 'allow'), 'no'); await fetch(`${follower}/title/third`);
    await expect.poll(() => mine.closed).toBe(true);
    expect(count()).toBe(2); expect(other.frames).not.toContain('event: message');
  } finally {
    for (const stream of streams) stream.destroy();
    await Promise.all(children.map(async child => { if (child.exitCode !== null || child.signalCode !== null) return; const gone = once(child, 'exit'); child.kill('SIGKILL'); await gone; }));
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
