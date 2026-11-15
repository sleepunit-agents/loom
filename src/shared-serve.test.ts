import Database from 'better-sqlite3';
import {expect,it} from 'vitest';
import {once} from 'node:events';
import {createConnection,type Socket} from 'node:net';
import {createHash} from 'node:crypto';
import {members,tokens} from './core/data/schema.js';
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


it('owns the shared listener socket through a denied upgrade and peer reset',async()=>{
 const client=new Database(':memory:'),clock=new FakeClock();
 const now=()=>new Date(clock.now()).toISOString(),db=createDataSchema(client,now),token='shared-reset-fixture-'.repeat(4);
 db.insert(members).values({id:'owner',role:'owner',joinedAt:now()}).run();
 db.insert(tokens).values({fingerprint:createHash('sha256').update(token).digest('hex'),label:'Fixture',kind:'owner',member:'owner',createdAt:now()}).run();
 let rejected:Socket|undefined;
 const app=await serveShared({db,clock,originAllowed:request=>{rejected=request.socket;return false;},reportError:error=>{throw error;}});
 const url=new URL(app.url),peer=createConnection({host:url.hostname,port:Number(url.port)});peer.on('error',()=>{});
 try {
  await once(peer,'connect');const response=once(peer,'data');
  peer.write('GET /graphql HTTP/1.1\r\nHost: '+url.host+'\r\nAuthorization: Bearer '+token+'\r\nOrigin: https://other.invalid\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Protocol: graphql-transport-ws\r\n\r\n');
  expect(String((await response)[0])).toContain('401 Unauthorized');expect(rejected).toBeDefined();
  expect(()=>rejected!.emit('error',Object.assign(new Error('read ECONNRESET'),{code:'ECONNRESET'}))).not.toThrow();
  expect(rejected!.destroyed).toBe(true);
 }finally{peer.destroy();await app.close();client.close();}
});
