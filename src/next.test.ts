import { it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from './foundation.js';
import { fixture, installFixture, fixtureSharing } from './fixture.js';
import { FakeClock } from './core/clock.js';

it('next serves only the new root, foundation doors and live, ignoring poisoned legacy stores', async () => {
  const home = mkdtempSync(join(tmpdir(),'loom-next-'));
  fixture(home); writeFileSync(join(home,'household.json'),'not json');
  writeFileSync(join(home,'tokens.json'),'not json'); writeFileSync(join(home,'next.html'),'<html next>new shell</html>');
  const loom = await startLoom({home,next:true,clock:new FakeClock(0),install:installFixture,sharing:fixtureSharing,webRoot:home,
    authenticate: req => req.headers.authorization === 'fixture' ? { viewer:{kind:'member',id:'jonathan'},valid:()=>true } : undefined });
  try {
    await expect(startLoom({home,next:true})).rejects.toThrow('already running');
    expect((await fetch(loom.url+'/api/tasks/list',{method:'POST',headers:{origin:'https://other.test',authorization:'fixture','content-type':'application/json'},body:JSON.stringify({input:{}})})).status).toBe(403);
    expect(await (await fetch(loom.url)).text()).toContain('new shell');
    for (const path of ['/events','/collections/tasks','/api/tasks/list']) expect((await fetch(loom.url+path)).status).toBe(path.startsWith('/api')?401:404);
    const read = await fetch(loom.url+'/api/tasks/list',{method:'POST',headers:{authorization:'fixture','content-type':'application/json'},body:JSON.stringify({input:{}})});
    expect((await read.json()).ok).toBe(true);
    expect((await fetch(loom.url+'/mcp',{method:'POST'})).status).toBe(401);
    const mcp = await fetch(loom.url+'/mcp',{method:'POST',headers:{authorization:'fixture','content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}}})});
    expect(mcp.status).toBe(200);
    expect((await mcp.json()).result.serverInfo.name).toBe('loom-next');
  } finally { await loom.close(); rmSync(home,{recursive:true,force:true}); }
});

it('staging holds every effect, releases one claim once, and never retries an interrupted outside call', async () => {
  const home = mkdtempSync(join(tmpdir(),'loom-effects-'));
  const options = {home,next:true,staging:true,clock:new FakeClock(0),sharing:fixtureSharing};
  let loom = await startLoom(options);
  try {
    for (const kind of ['wake','bridge-send','body-start','push'] as const) expect(loom.effects!.beforeOutside({id:kind,kind,title:kind})).toBe(false);
    const release = (id:string,who='jonathan',nonce=id) => loom.operations.call('direct',{kind:'member',id:who},'core.releaseEffect',{id},nonce);
    expect(release('wake','pollock')).toMatchObject({ok:false,code:'denied'});
    expect(release('wake')).toMatchObject({ok:true});
    expect(loom.effects!.beforeOutside({id:'wake',kind:'wake',title:'wake'})).toBe(true);
    expect(loom.effects!.beforeOutside({id:'wake',kind:'wake',title:'wake'})).toBe(false);
    expect(loom.effects!.beforeOutside({id:'push',kind:'push',title:'push'})).toBe(false);
    await loom.close(); loom=await startLoom(options);
    expect(loom.db.prepare('SELECT state FROM core_effects WHERE id=?').get('wake')).toEqual({state:'uncertain'});
    expect(loom.effects!.beforeOutside({id:'wake',kind:'wake',title:'wake'})).toBe(false);
    expect(release('wake','jonathan','again')).toMatchObject({ok:false,code:'conflict'});
    expect(release('bridge-send')).toMatchObject({ok:true});
    expect(loom.effects!.beforeOutside({id:'bridge-send',kind:'bridge-send',title:'bridge-send'})).toBe(true);
    loom.effects!.finish('bridge-send');
    expect(loom.effects!.beforeOutside({id:'bridge-send',kind:'bridge-send',title:'bridge-send'})).toBe(false);
  } finally { await loom.close(); rmSync(home,{recursive:true,force:true}); }
});
