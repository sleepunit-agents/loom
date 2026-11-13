import { once } from 'node:events';
import { WebSocket } from 'ws';
import { expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from './foundation.js';
import { FakeClock } from './core/clock.js';
import { HouseholdDatabase } from './core/household/document.js';
import { SharingDatabase } from './core/household/sharing.js';
import { change } from './pieces/changes/fixture.js';
import { replaceChanges } from './pieces/changes/store.js';

it('next installs Changes without a fixture and reads current household project scope over HTTP', async () => {
 const home=mkdtempSync(join(tmpdir(),'changes-next-'));
 writeFileSync(join(home,'household.json'),'poisoned legacy household');
 writeFileSync(join(home,'projects.json'),'poisoned legacy projects');
 const loom=await startLoom({home,next:true,clock:new FakeClock(0),authenticate:req=>({viewer:{kind:'member',id:String(req.headers.authorization)},valid:()=>true})});
 const call=async(who:string,verb:string,input:unknown={})=>{
  const res=await fetch(`${loom.url}/api/changes/${verb}`,{method:'POST',headers:{authorization:who,'content-type':'application/json'},body:JSON.stringify({input,id:`${who}-${verb}`})});
  return res.json();
 };
 try {
  expect(loom.operations.has('changes.list')).toBe(true);
  loom.db.transaction(()=>{
   new HouseholdDatabase(loom.db).replace(home,{v:1,agents:['art'],members:[{person:'jonathan',role:'owner',agents:'*'},{person:'pollock',role:'member',agents:[]}]});
   new SharingDatabase(loom.db,home).create({slug:'pond',name:'Pond',repositories:['acme/app'],members:['pollock'],agents:[]});
   replaceChanges(loom.db,[change({project:'spoof',agent:'unknown',mine:true})]);
  })();
  expect(await call('pollock','list')).toMatchObject({ok:true,value:[{project:'pond',mine:false}]});
  const owner=await call('jonathan','show',{id:change().id});
  expect(owner).toMatchObject({ok:true,value:{project:'pond'}});
  expect(owner.value.agent).toBeUndefined();
  expect(await call('jonathan','confirm',{id:change().id,head:change().head.id})).toMatchObject({ok:true,value:{open:false}});
  expect(await call('jonathan','answer',{id:change().id,head:change().head.id,action:'yes'})).toMatchObject({ok:false});
  loom.db.transaction(()=>new SharingDatabase(loom.db,home).setMembers('pond',[]))();
  expect(await call('pollock','list')).toMatchObject({ok:true,value:[]});
  expect(await call('stranger','list')).toMatchObject({ok:true,value:[]});
  expect(loom.operations.has('changes.commit-sync')).toBe(false);
 } finally {await loom.close();rmSync(home,{recursive:true,force:true});}
});

it('next reprojects account assignment and clearing over HTTP and live without granting project access', async () => {
 const home=mkdtempSync(join(tmpdir(),'changes-accounts-next-'));
 const loom=await startLoom({home,next:true,clock:new FakeClock(0),authenticate:req=>({viewer:{kind:'member',id:String(req.headers.authorization)},valid:()=>true})});
 const owner={kind:'member' as const,id:'jonathan'};
 let socket:WebSocket|undefined;
 try {
  loom.db.transaction(()=>{
   new HouseholdDatabase(loom.db).replace(home,{v:1,agents:['art','mark'],members:[{person:'jonathan',role:'owner',agents:'*'},{person:'pollock',role:'member',agents:['art']}]});
   new SharingDatabase(loom.db,home).create({slug:'private',name:'Private',repositories:['secret/app'],members:[],agents:[]});
   replaceChanges(loom.db,[change({project:'stale',agent:'mark',mine:true,author:{login:'Art-Bot'}}),change({id:'github:secret/app#4',repo:'github:secret/app',number:4,agent:'art'})]);
  })();
  let serial=0;
  const assign=(agent:string,github:string[])=>loom.operations.call('direct',owner,'household.setAgentAccounts',{agent,accounts:{github}},`accounts-${++serial}`);
  const list=async()=>{
   const response=await fetch(`${loom.url}/api/changes/list`,{method:'POST',headers:{authorization:'pollock','content-type':'application/json'},body:JSON.stringify({input:{}})});
   return response.json();
  };
  const show=()=>loom.operations.call('direct',owner,'changes.show',{id:change().id});
  expect(show()).toMatchObject({ok:true,value:{mine:false}});
  expect((show() as {value:{agent?:string}}).value.agent).toBeUndefined();
  expect(await list()).toMatchObject({ok:true,value:[]});
  socket=new WebSocket(loom.url.replace('http:','ws:')+'/live',{headers:{authorization:'pollock'}});
  const messages:unknown[]=[],waiters:((v:unknown)=>void)[]=[];
  socket.on('message',data=>{const value=JSON.parse(String(data));const waiter=waiters.shift();if(waiter)waiter(value);else messages.push(value);});
  const next=()=>messages.length?Promise.resolve(messages.shift()):new Promise(resolve=>waiters.push(resolve));
  await once(socket,'open');socket.send(JSON.stringify({kind:'subscribe',type:'change'}));
  expect(await next()).toMatchObject({kind:'set',records:[]});
  expect(assign('art',['ART-BOT'])).toMatchObject({ok:true});
  expect(await next()).toMatchObject({kind:'put',record:{id:change().id,agent:'art',mine:false}});
  expect(await list()).toMatchObject({ok:true,value:[{id:change().id,agent:'art'}]});
  expect((await list()).value).toHaveLength(1); // Agent metadata cannot grant private project access.
  expect(loom.operations.call('direct',owner,'changes.confirm',{id:change().id,head:change().head.id})).toMatchObject({ok:true,value:{open:false}});
  expect(assign('art',[])).toMatchObject({ok:true});
  expect(await next()).toMatchObject({kind:'del',id:change().id});
  expect(await list()).toMatchObject({ok:true,value:[]});
  expect(assign('mark',['art-bot'])).toMatchObject({ok:true});
  expect(show()).toMatchObject({ok:true,value:{agent:'mark'}});
  expect(await list()).toMatchObject({ok:true,value:[]});
  loom.db.transaction(()=>new HouseholdDatabase(loom.db).replace(home,{v:1,agents:['art'],members:[{person:'jonathan',role:'owner',agents:'*'}]}))();
  expect((show() as {value:{agent?:string}}).value.agent).toBeUndefined();
 } finally {
  if(socket&&socket.readyState!==WebSocket.CLOSED){const closed=once(socket,'close');socket.terminate();await closed;}
  await loom.close();rmSync(home,{recursive:true,force:true});
 }
});
