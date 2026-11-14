import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { fixture } from '../../fixture.js';
import { startLoom } from '../../foundation.js';
import { FakeClock } from '../clock.js';
import { signin, hash } from './index.js';
const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{vi.unstubAllEnvs();for(const f of cleanup.splice(0).reverse())await f();});
async function setup(){
  const home=mkdtempSync(join(tmpdir(),'browser-link-'));fixture(home);cleanup.push(()=>rmSync(home,{recursive:true,force:true}));
  const clock=new FakeClock(Date.parse('2026-11-12T12:00:00Z')),app=await startLoom({home,next:true,clock});cleanup.push(()=>app.close());const s=signin(app);vi.stubEnv('LOOM_PUBLIC_URL',app.url.replace('127.0.0.1','localhost'));
  for(const member of ['jonathan','pollock'])s.tokens.change(ts=>ts.push({role:'owner',member,label:member,sha256:hash(member),created:new Date(clock.now()).toISOString()}));
  const cookie=s.createSession(hash('jonathan'));
  async function socket(id:string){
    const ws=new WebSocket(app.url.replace('http:','ws:')+'/live',{headers:{cookie:`loom_ui=${id}`,origin:app.url}});await once(ws,'open');cleanup.push(()=>{ws.terminate();});
    return async(input:unknown)=>{const response=new Promise<unknown>(resolve=>{const listener=(raw:import('ws').RawData)=>{const m=JSON.parse(String(raw));if(m.kind==='result'){ws.off('message',listener);resolve(m);}};ws.on('message',listener);});ws.send(JSON.stringify({kind:'call',request:'ephemeral',name:'signin.browserLink',input}));return await response as {result:{ok:boolean;value:{path:string}}};};
  }
  async function spend(path:string){const r=await fetch(app.url+path,{method:'POST',redirect:'manual'});expect(r.status).toBe(303);return r.headers.get('set-cookie')!.match(/loom_ui=([0-9a-f]+)/)![1];}
  return{app,s,clock,cookie,socket,spend};
}
it('inherits original freshness for self, another member and repeated device hops; never journals bearer results',async()=>{
  const f=await setup(),issued=f.s.session(f.cookie)!.s.issuedAt;f.clock.advance(601_000);
  const call=await f.socket(f.cookie),before=f.app.db.prepare('SELECT * FROM core_operations').all();
  for(const member of [undefined,'pollock']){
    const r=await call(member?{member}:{});expect(r.result.ok).toBe(true);
    const path=r.result.value.path,code=path.split('/').pop();
    const landing=await fetch(f.app.url+path);expect(landing.status).toBe(200);expect(await landing.text()).not.toContain(code);
    const id=await f.spend(path);expect(f.s.session(id)?.viewer.id).toBe(member??'jonathan');expect(f.s.session(id)?.s.signedInAt).toBe(issued);expect(f.s.fresh(id)).toBeUndefined();
    expect((await fetch(f.app.url+path,{method:'POST',redirect:'manual'})).status).toBe(401);
    const denied=await fetch(f.app.url.replace('127.0.0.1','localhost')+'/passkeys/options',{method:'POST',headers:{cookie:`loom_ui=${id}`,'content-type':'application/json',host:new URL(f.app.url).host.replace('127.0.0.1','localhost')},body:JSON.stringify({_csrf:f.s.csrf(id)})});expect(denied.status).toBe(403);
    const second=await (await f.socket(id))({}),next=await f.spend(second.result.value.path);expect(f.s.session(next)?.s.signedInAt).toBe(issued);expect(f.s.fresh(next)).toBeUndefined();
  }
  expect(f.app.db.prepare('SELECT * FROM core_operations').all()).toEqual(before);
  const fresh=await f.spend(f.s.link('jonathan'));expect(f.s.fresh(fresh)).toBeDefined();
});
it('scoped members link only themselves; input cannot forge freshness or browser proof and other doors refuse',async()=>{
  const f=await setup(),id=f.s.createSession(hash('pollock')),call=await f.socket(id),before=f.s.sessions.read();
  expect((await call({member:'jonathan'})).result).toMatchObject({ok:false,code:'denied'});
  expect((await call({signedInAt:f.s.now()})).result).toMatchObject({ok:false,code:'invalid'});
  expect(f.s.sessions.read()).toEqual(before);
  expect(f.s.session(await f.spend((await call({})).result.value.path))?.viewer.id).toBe('pollock');
  for(const door of ['direct','http','mcp'] as const)expect(f.app.operations.call(door,{kind:'member',id:'jonathan'},'signin.browserLink',{})).toMatchObject({ok:false,code:'denied'});
  expect(await f.app.operations.callAsync('socket',{kind:'member',id:'jonathan'},'signin.browserLink',{},undefined,true)).toMatchObject({ok:false,code:'denied'});
  const bearer=new WebSocket(f.app.url.replace('http:','ws:')+'/live',{headers:{authorization:'Bearer jonathan',cookie:`loom_ui=${f.cookie}`,origin:f.app.url}});await once(bearer,'open');cleanup.push(()=>{bearer.terminate();});
  const response=new Promise<unknown>(resolve=>bearer.on('message',raw=>{const m=JSON.parse(String(raw));if(m.kind==='result')resolve(m.result);}));bearer.send(JSON.stringify({kind:'call',request:'bearer',name:'signin.browserLink',input:{}}));expect(await response).toMatchObject({ok:false,code:'denied'});
});
it('expires unused links at ten minutes and refuses ended source proof',async()=>{
  const f=await setup(),call=await f.socket(f.cookie),r=await call({});f.clock.advance(600_000);
  expect((await fetch(f.app.url+r.result.value.path,{method:'POST',redirect:'manual'})).status).toBe(401);
  // A trusted resolver proof cannot survive its source session ending.
  const req={headers:{cookie:`loom_ui=${f.cookie}`},method:'GET',socket:{}} as import('node:http').IncomingMessage;
  const viewer=f.s.resolve(req)!.viewer;f.s.end(f.cookie);expect(()=>f.s.browserLink(viewer)).toThrow('signed-in browser');
});
