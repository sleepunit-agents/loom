import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, createConnection } from 'node:net';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { startLoom } from '../../foundation.js';
import { createFoundation } from '../../core/app.js';
import { migrateHouseholdTables } from '../../core/household/schema.js';
import { HouseholdDatabase } from '../../core/household/document.js';
import { FakeClock, type Sharing } from '../../core/index.js';
import { touchSocketPath } from '../../core/touched/index.js';
import { SqliteKnowledgeBackend } from '../../backends/sqlite-knowledge.js';
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const sharing: Sharing = { members:{ owner:{owner:true,agents:['art']}, partial:{owner:false,agents:['art']} }, projects:{}, services:{} };
const owner = { kind:'member' as const, id:'owner' };
function home(metadata = true) {
  const home = mkdtempSync(join(tmpdir(), 'mind-next-')); cleanup.push(() => rmSync(home,{recursive:true,force:true}));
  if (metadata) {
    const app = createFoundation({home}); migrateHouseholdTables(app.db);
    app.db.transaction(() => new HouseholdDatabase(app.db).replace(home,{v:1,agents:['art'],default:'art',owner:'owner'}))(); app.close();
  }
  return home;
}
async function start(home: string, extra = {}) {
  const app = await startLoom({home,next:true,clock:new FakeClock(Date.parse('2026-11-12T12:00:00Z')),sharing:()=>sharing,authenticate:()=>({viewer:owner,valid:()=>true}),...extra});
  cleanup.push(()=>app.close()); return app;
}
async function store(home: string) {
  const backend = new SqliteKnowledgeBackend({dbPath:join(home,'commons/knowledge.db')}); cleanup.push(()=>backend.close());
  await backend.writePage({slug:'fact',title:'A fact',domain:'systems',body:'Original'}); return backend;
}
async function notify(directory: string, change: {type:string;id:string}) {
  const socket = createConnection(touchSocketPath(directory)); socket.on('error',()=>{});
  try { await once(socket,'connect'); const data=once(socket,'data'); socket.write(JSON.stringify(change)+'\n'); return JSON.parse((await data)[0].toString()); }
  finally { socket.destroy(); }
}
it('installs absent Knowledge without discovering an unlisted file or creating source directories', async () => {
  const h=home(false); await store(h);
  const app=await start(h);
  expect(app.operations.call('direct',owner,'mind.knowledgeList',{})).toMatchObject({value:{pages:[],total:0}});
  expect(existsSync(touchSocketPath(join(h,'commons')))).toBe(false);
  expect(app.operations.call('direct',owner,'mind.knowledgeVerify',{slug:'fact'},'absent')).toMatchObject({code:'not-found'});
  const empty=home(); const missing=await start(empty);
  expect(existsSync(join(empty,'commons'))).toBe(false);
  expect(missing.operations.call('direct',owner,'mind.knowledgeList',{})).toMatchObject({value:{pages:[]}});
});
it('binds canonical source identities, refreshes two windows after an outside write, and closes before restart', async () => {
  const h=home(); const backend=await store(h); const app=await start(h);
  expect(app.operations.call('direct',{kind:'agent',id:'art'},'core.touched',{type:'knowledge',id:'fact'})).toMatchObject({code:'denied'});
  expect(await notify(join(h,'commons'),{type:'memory',id:'fact'})).toMatchObject({ok:false});
  const windows=await Promise.all([1,2].map(async()=>{
    const ws=new WebSocket(app.url.replace('http:','ws:')+'/live'); const frames:any[]=[]; let changed:((v:any)=>void)|undefined;
    ws.on('message',b=>{const frame=JSON.parse(b.toString()); frames.push(frame);changed?.(frame);});
    await once(ws,'open'); ws.send(JSON.stringify({kind:'subscribe',type:'knowledge'}));
    await new Promise<void>(resolve=>{const check=(f:any)=>{if(f.kind==='set')resolve();};if(frames.some(f=>f.kind==='set'))resolve();else changed=check;});
    cleanup.push(()=>ws.close());
    return {ws,put:()=>new Promise<any>(resolve=>{changed=f=>{if(f.kind==='put')resolve(f);};})};
  }));
  const puts=windows.map(w=>w.put());
  await backend.writePage({slug:'fact',title:'Changed outside',domain:'systems',body:'Changed body'});
  // Await an acknowledged notification; no polling or fixed sleeps.
  expect(await notify(join(h,'commons'),{type:'knowledge',id:'fact'})).toMatchObject({ok:true});
  for(const put of puts) expect(await put).toMatchObject({record:{title:'Changed outside',body:'Changed body'}});
  expect(app.operations.call('direct',owner,'mind.knowledgeVerify',{slug:'fact'},'verify')).toMatchObject({ok:true,value:{stamped:true}});
  expect(app.operations.call('direct',{kind:'member',id:'partial'},'mind.knowledgeRecheck',{slug:'fact'},'deny')).toMatchObject({code:'denied'});
  windows.forEach(w=>w.ws.close()); await app.close();
  expect(existsSync(touchSocketPath(join(h,'commons')))).toBe(false);
  const restarted=await start(h);
  expect(restarted.operations.call('direct',owner,'mind.knowledgeVerify',{slug:'fact'},'verify')).toMatchObject({ok:true});
  expect(await backend.getVerifications('fact')).toHaveLength(1);
});
it('preserves occupied endpoints and releases the home lock on failed startup', async () => {
  const h=home(); await store(h); const directory=join(h,'commons'); mkdirSync(join(directory,'.loom-live'));
  const server=createServer(s=>s.end()); await new Promise<void>(resolve=>server.listen(touchSocketPath(directory),resolve));
  cleanup.push(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  await expect(start(h)).rejects.toThrow('occupied');
  expect(server.listening).toBe(true);
  await new Promise<void>(resolve=>server.close(()=>resolve()));
  const app=await start(h); expect(app.operations.has('mind.knowledgeRead')).toBe(true);
});
it('refuses non-socket endpoints without deleting their data', async()=>{
  const h=home();await store(h);mkdirSync(join(h,'commons/.loom-live'));const path=touchSocketPath(join(h,'commons'));writeFileSync(path,'keep');
  await expect(start(h)).rejects.toThrow('not a socket');expect(existsSync(path)).toBe(true);
});

it('recovers a refused stale socket under home ownership', async()=>{
  const h=home();await store(h);const directory=join(h,'commons');mkdirSync(join(directory,'.loom-live'));
  const path=touchSocketPath(directory), parked=path+'.parked';
  const server=createServer();await new Promise<void>(resolve=>server.listen(path,resolve));
  renameSync(path,parked);await new Promise<void>(resolve=>server.close(()=>resolve()));renameSync(parked,path);
  expect(existsSync(path)).toBe(true);
  const app=await start(h);expect(await notify(directory,{type:'knowledge',id:'fact'})).toMatchObject({ok:true});await app.close();expect(existsSync(path)).toBe(false);
});

it('distinguishes denied Knowledge access from an empty authorized store', async()=>{
  const h=home();const app=await start(h,{authenticate:()=>({viewer:{kind:'member',id:'partial'},valid:()=>true})});
  const ws=new WebSocket(app.url.replace('http:','ws:')+'/live');cleanup.push(()=>ws.close());
  await once(ws,'open');const reply=once(ws,'message');ws.send(JSON.stringify({kind:'subscribe',type:'knowledge.access'}));
  expect(JSON.parse((await reply)[0].toString())).toMatchObject({kind:'set',records:[{id:'knowledge',allowed:false,canVerify:false,canRecheck:false}]});
});
it('rolls source transports back on HTTP startup failure and shares concurrent shutdown', async()=>{
  const h=home();await store(h);
  await expect(start(h,{host:[]})).rejects.toThrow('bind host');
  expect(existsSync(touchSocketPath(join(h,'commons')))).toBe(false);
  const app=await start(h);const first=app.close(),second=app.close();expect(second).toBe(first);await first;
  expect(existsSync(touchSocketPath(join(h,'commons')))).toBe(false);
  const restarted=await start(h);await restarted.close();
});
it('releases home ownership even when a synchronous reader shutdown fails', async()=>{
  const h=home();
  const app=await startLoom({home:h,next:true,sharing:()=>sharing,install:app=>app.onClose(()=>{throw new Error('injected reader close');})});
  await expect(app.close()).rejects.toThrow('injected reader close');
  const restarted=await start(h);await restarted.close();
});
