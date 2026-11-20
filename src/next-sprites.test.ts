import { expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from './foundation.js';
import { fixture, installFixture } from './fixture.js';
import { FakeClock, type Viewer } from './core/index.js';
import { HouseholdRows } from './core/household/rows.js';
import { HouseholdDatabase } from './core/household/document.js';
import { spriteDisplay } from './core/household/sprites.js';
it('serves only imported manifest-named artwork to current authorized viewers, never legacy files',async()=>{
 const home=mkdtempSync(join(tmpdir(),'next-sprites-'));fixture(home);
 const viewers: Record<string,Viewer>={owner:{kind:'member',id:'jonathan'},pollock:{kind:'member',id:'pollock'},art:{kind:'agent',id:'art'},mark:{kind:'agent',id:'mark'}};
 const app=await startLoom({home,next:true,clock:new FakeClock(),install:installFixture,authenticate:req=>{
   const viewer=viewers[String(req.headers.authorization)];return viewer?{viewer,valid:()=>true}:undefined;
 }});
 try {
  const manifest={cell:[1,1],states:{idle:{south:[{row:0,frames:1,weight:1}]}}};
  const bytes=Buffer.from('database bytes'), raw=Buffer.from(JSON.stringify(manifest,null,2)+'\n');
  new HouseholdRows(app.db,'settings').put('agent-sprite:art',{manifest,rawManifest:raw.toString('base64'),sheets:{'sheet.png':bytes.toString('base64')},v:'saved'});
  expect(spriteDisplay(app.db,'art')).toEqual({facings:['south'],base:'/faces/art/',v:'saved'});
  mkdirSync(join(home,'faces/art'),{recursive:true});writeFileSync(join(home,'faces/art/sheet.png'),'legacy bytes');
  const get=(file:string,as?:string)=>fetch(app.url+'/faces/art/'+file,{headers:as?{authorization:as}:{}});
  for(const as of ['owner','art']) {
   const response=await get('sheet.png',as);expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
   expect(Buffer.from(await (await get('manifest.json',as)).arrayBuffer())).toEqual(raw);
   expect((await get('private.png',as)).status).toBe(404);
  }
  for(const as of [undefined,'pollock','mark'])expect((await get('sheet.png',as)).status).toBe(404);
  const change = (agents: string[]) => new HouseholdDatabase(app.db).change(home,raw=>{(raw.members as Array<{person:string;agents:unknown}>).find(m=>m.person==='pollock')!.agents=agents;});
  change(['art']);expect((await get('sheet.png','pollock')).status).toBe(200);
  change([]);expect((await get('sheet.png','pollock')).status).toBe(404);
  new HouseholdRows(app.db,'settings').remove('agent-sprite:art');
  expect((await get('sheet.png','art')).status).toBe(404);
 } finally {await app.close();rmSync(home,{recursive:true,force:true});}
});
