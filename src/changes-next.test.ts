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
