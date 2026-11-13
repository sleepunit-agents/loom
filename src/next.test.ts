import { it, expect } from 'vitest';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { mkdtempSync, rmSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
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

it('default next authentication never accepts legacy credentials on any door', async()=>{
  const home=mkdtempSync(join(tmpdir(),'loom-default-auth-'));
  const loom=await startLoom({home,next:true});
  try {
    for(const path of ['/api/tasks/list','/mcp']) expect((await fetch(loom.url+path,{method:'POST',headers:{authorization:'Bearer legacy',cookie:'fixture=jonathan','content-type':'application/json'},body:'{"input":{}}'})).status).toBe(401);
    const ws=new WebSocket(loom.url.replace('http:','ws:')+'/live',{headers:{cookie:'fixture=jonathan'}});
    const refused=new Promise<number>(ok=>ws.once('unexpected-response',(_req,res)=>{res.resume();ws.terminate();ok(res.statusCode!);}));
    ws.on('error',()=>{});expect(await refused).toBe(401);
  }finally{await loom.close();rmSync(home,{recursive:true,force:true});}
});

it('MCP tools bind concurrent callers independently and live held records use central policy',async()=>{
  const home=mkdtempSync(join(tmpdir(),'loom-next-doors-'));fixture(home);
  const loom=await startLoom({home,next:true,staging:true,clock:new FakeClock(0),install:installFixture,sharing:fixtureSharing,
    authenticate:req=>({viewer:{kind:'member',id:req.headers.authorization==='pollock'?'pollock':'jonathan'},valid:()=>true})});
  const sockets:WebSocket[]=[];
  const socket=async(who:string)=>{
    const ws=new WebSocket(loom.url.replace('http:','ws:')+'/live',{headers:{authorization:who}});sockets.push(ws);
    const queue:unknown[]=[];const waiting:((v:unknown)=>void)[]=[];
    ws.on('message',raw=>{const value=JSON.parse(raw.toString());const next=waiting.shift();if(next)next(value);else queue.push(value);});
    await once(ws,'open');return {ws,next:()=>queue.length?Promise.resolve(queue.shift()):new Promise<unknown>(ok=>waiting.push(ok))};
  };
  try{
    const tool=async(who:string)=>{
      const res=await fetch(loom.url+'/mcp',{method:'POST',headers:{authorization:who,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'tasks.list',arguments:{input:{}}}})});
      expect(res.status).toBe(200);const answer=await res.json();return JSON.parse(answer.result.content[0].text).value.result.entries;
    };
    const [owner,member]=await Promise.all([tool('jonathan'),tool('pollock')]);
    expect(owner).toHaveLength(4);expect(member.map((t:{title:string})=>t.title)).toEqual(['Pond work','Pond-bot own work']);
    const a=await socket('jonathan'),b=await socket('pollock');
    a.ws.send(JSON.stringify({kind:'subscribe',type:'core.effect'}));b.ws.send(JSON.stringify({kind:'subscribe',type:'core.effect'}));
    expect(await a.next()).toMatchObject({kind:'set',records:[]});expect(await b.next()).toMatchObject({kind:'set',records:[]});
    for(const kind of ['wake','bridge-send','body-start','push'] as const){
      expect(loom.effects!.beforeOutside({id:kind,kind,title:kind})).toBe(false);
      expect(await a.next()).toMatchObject({kind:'put',record:{id:kind,state:'due'}});
    }
    b.ws.send(JSON.stringify({kind:'call',request:'denied',name:'core.releaseEffect',input:{id:'wake'},id:'no'}));
    expect(await b.next()).toMatchObject({kind:'pending',request:'denied'});expect(await b.next()).toMatchObject({kind:'result',result:{ok:false,code:'denied'}});
    a.ws.send(JSON.stringify({kind:'call',request:'released',name:'core.releaseEffect',input:{id:'wake'},id:'yes'}));
    expect(await a.next()).toMatchObject({kind:'pending'});expect(await a.next()).toMatchObject({kind:'put',record:{id:'wake',state:'released'}});expect(await a.next()).toMatchObject({kind:'result',result:{ok:true}});
    // Closing with live sockets must finish as well as releasing its home.
    await loom.close();sockets.length=0;
  }finally{sockets.forEach(s=>s.terminate());await loom.close();rmSync(home,{recursive:true,force:true});}
});

it('normal next effects claim once without release, including across restart',async()=>{
  const home=mkdtempSync(join(tmpdir(),'loom-normal-effects-'));let loom=await startLoom({home,next:true});
  const effect={id:'push',kind:'push' as const,title:'A push'};
  try{
    expect(loom.effects!.beforeOutside(effect)).toBe(true);expect(loom.effects!.beforeOutside(effect)).toBe(false);
    await loom.close();loom=await startLoom({home,next:true});expect(loom.effects!.beforeOutside(effect)).toBe(false);
    expect(loom.db.prepare('SELECT state FROM core_effects WHERE id=?').get('push')).toEqual({state:'uncertain'});
  }finally{await loom.close();rmSync(home,{recursive:true,force:true});}
});

it('multiple next addresses share one foundation and failed later binds release all resources',async()=>{
  const home=mkdtempSync(join(tmpdir(),'loom-next-hosts-'));
  let loom=await startLoom({home,next:true,host:['127.0.0.1','127.0.0.2']});
  try{
    const other=loom.url.replace('127.0.0.1','127.0.0.2');expect(await(await fetch(other+'/health')).json()).toMatchObject({next:true});
    await loom.close();
    const blocker=createServer();await new Promise<void>(ok=>blocker.listen(0,'127.0.0.2',ok));
    const port=(blocker.address() as AddressInfo).port;
    try{await expect(startLoom({home,next:true,host:['127.0.0.1','127.0.0.2'],port})).rejects.toThrow();}
    finally{await new Promise<void>(ok=>blocker.close(()=>ok()));}
    loom=await startLoom({home,next:true,host:'127.0.0.1',port});expect((await fetch(loom.url+'/health')).status).toBe(200);
  }finally{await loom.close();rmSync(home,{recursive:true,force:true});}
});


it.runIf(process.platform==='linux')('an ownership probe cannot hold shutdown open with a withheld FIN',async()=>{
  const home=mkdtempSync(join(tmpdir(),'loom-next-owner-probe-'));let loom=await startLoom({home,next:true});
  const key=createHash('sha256').update(realpathSync(home)).digest('hex').slice(0,32);
  const probe=createConnection({path:'\0loom-next-'+key,allowHalfOpen:true});probe.on('error',()=>{});
  try{await once(probe,'connect');await loom.close();loom=await startLoom({home,next:true});expect((await fetch(loom.url+'/health')).status).toBe(200);}
  finally{probe.destroy();await loom.close();rmSync(home,{recursive:true,force:true});}
});
it.runIf(existsSync(resolve(import.meta.dirname,'../dist/web/next.html')))('default web root serves the built next shell and every initial script',async()=>{
  const home=mkdtempSync(join(tmpdir(),'loom-next-built-'));const loom=await startLoom({home,next:true});
  try{const root=await fetch(loom.url);expect(root.status).toBe(200);const html=await root.text();
    expect(html).toContain('id="root"');const assets=[...html.matchAll(/(?:src|href)="(\/app\/[^"]+)"/g)].map(m=>m[1]);expect(assets.length).toBeGreaterThan(0);
    for(const asset of assets){const res=await fetch(loom.url+asset);expect(res.status).toBe(200);expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);}
  }finally{await loom.close();rmSync(home,{recursive:true,force:true});}
});
