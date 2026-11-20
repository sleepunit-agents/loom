import { expect, it } from 'vitest';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleUi, legacyUiAuth } from './handler.js';
import { loadHousehold } from '../household.js';
import { piecesMoved, changed } from './live.js';

it('the single-agent handler closes a live stream when its bearer is revoked', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-live-credentials-'));
  const baseAuth = legacyUiAuth(['test']);
  let live = true, frames = '', ended = false;
  const auth = { ...baseAuth, live: (digest: Buffer) => live && baseAuth.live(digest) };
  const server = createServer((req, res) => { void handleUi(req, res, '/events', { contextDir: home, auth, env: { LOOM_HOME: home, PATH: '' } }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address() as { port: number };
  const stream = request(`http://127.0.0.1:${address.port}/events`, { headers: { authorization: 'Bearer test', accept: 'text/event-stream' } }, res => {
    res.setEncoding('utf8'); res.on('data', chunk => { frames += chunk; }); res.on('end', () => { ended = true; });
  });
  stream.on('error', () => {}); stream.end();
  try {
    await expect.poll(() => frames.includes('event: hello')).toBe(true);
    const before = frames;
    live = false; changed();
    await expect.poll(() => ended).toBe(true);
    expect(frames).toBe(before);
  } finally { stream.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(home, { recursive: true, force: true }); }
});

it('the household handler withholds a pending manifest page after membership narrows', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-live-member-'));
  for (const agent of ['art', 'mark']) mkdirSync(join(home, 'agents', agent), { recursive: true });
  const raw = { v: 1, agents: ['art', 'mark'], default: 'art', members: [{ person: 'jonathan', role: 'owner', agents: '*' as string | string[] }, { person: 'keeper', role: 'owner', agents: '*' }] };
  const save = () => writeFileSync(join(home, 'household.json'), JSON.stringify(raw)); save();
  let household = loadHousehold(home)!;
  const path = join(home, 'loom-private');
  writeFileSync(path, `#!${process.execPath}
const fs=require('node:fs'),p=${JSON.stringify(home)};
if(fs.existsSync(p+'/hold')){fs.writeFileSync(p+'/started','yes');const t=setInterval(()=>{if(fs.existsSync(p+'/release')){clearInterval(t);console.log(JSON.stringify({v:2,tile:{label:'Private',value:'after'}}));}},10);}
else {fs.writeFileSync(p+'/baseline','yes');console.log(JSON.stringify({v:2,tile:{label:'Private',value:'before'}}));}
`); chmodSync(path, 0o755);
  const auth = { ...legacyUiAuth(['test']), member: () => household.members[0] };
  let frames = '', ended = false;
  const server = createServer((req, res) => { void handleUi(req, res, '/events', { contextDir: join(home, 'agents', 'art'), household: () => household, auth, env: { LOOM_HOME: home, PATH: home } }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address() as { port: number };
  const stream = request(`http://127.0.0.1:${address.port}/events`, { headers: { authorization: 'Bearer test', accept: 'text/event-stream' } }, res => {
    res.setEncoding('utf8'); res.on('data', chunk => { frames += chunk; }); res.on('end', () => { ended = true; });
  }); stream.on('error', () => {}); stream.end();
  try {
    await expect.poll(() => existsSync(join(home, 'baseline')) && frames.includes('event: hello')).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 50));
    writeFileSync(join(home, 'hold'), 'yes'); piecesMoved(home, path);
    await expect.poll(() => existsSync(join(home, 'started'))).toBe(true);
    raw.members[0].agents = ['art']; save(); household = loadHousehold(home)!;
    const before = frames.length; writeFileSync(join(home, 'release'), 'yes');
    await expect.poll(() => ended).toBe(true);
    expect(frames.slice(before)).not.toContain('event: page');
  } finally {
    writeFileSync(join(home, 'release'), 'yes'); stream.destroy();
    await new Promise<void>(resolve => server.close(() => resolve())); rmSync(home, { recursive: true, force: true });
  }
});
