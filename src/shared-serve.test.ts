import Database from 'better-sqlite3';
import {expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FakeClock} from './core/clock.js';
import {createDataSchema} from './core/data/database.js';
import {serveShared} from './shared-serve.js';
it('serves the built desk on the actual shared listener while keeping API failures out of the HTML fallback',async()=>{
 const home=mkdtempSync(join(tmpdir(),'desk-shared-listener-')),client=new Database(':memory:'),clock=new FakeClock();
 const webRoot=join(home,'web');mkdirSync(join(webRoot,'assets'),{recursive:true});
 writeFileSync(join(webRoot,'next.html'),'<html>Shared desk entry</html>');writeFileSync(join(webRoot,'assets/app.js'),'public fixture');
 const db=createDataSchema(client,()=>new Date(clock.now()).toISOString());
 let app:Awaited<ReturnType<typeof serveShared>>|undefined;
 try {
  app=await serveShared({db,clock,webRoot,originAllowed:()=>true,reportError:error=>{throw error;}});
  const page=await fetch(app.url+'/p/home-preview');expect(page.status).toBe(200);expect(await page.text()).toContain('Shared desk entry');
  expect(await (await fetch(app.url+'/app/assets/app.js')).text()).toBe('public fixture');
  const denied=await fetch(app.url+'/graphql',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:'{ agents { id } }'})});
  expect(denied.status).toBe(401);expect(await denied.text()).not.toContain('Shared desk entry');
  for(const path of ['/api/missing','/live','/faces/missing/manifest.json','/app/missing.js'])expect((await fetch(app.url+path)).status).toBe(404);
  const post=await fetch(app.url+'/p/home-preview',{method:'POST'});expect(post.status).toBe(404);
  expect((await fetch(app.url+'/manifest.webmanifest')).headers.get('content-type')).toContain('manifest');
  expect((await fetch(app.url+'/sw.js')).headers.get('service-worker-allowed')).toBe('/');
 } finally {await app?.close();client.close();rmSync(home,{recursive:true,force:true});}
});
