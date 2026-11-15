import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { startSharedLoom } from './shared-start.js';
import { tasks, sessions, members } from './core/data/schema.js';
import { z } from 'zod';
import { FakeClock } from './core/clock.js';
const clean:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
it('admits the actual empty-home first-run cookie on GraphQL and publishes later task changes',async()=>{
 const home=mkdtempSync(join(tmpdir(),'first-run-live-')),webRoot=mkdtempSync(join(tmpdir(),'first-run-web-'));
 clean.push(()=>{rmSync(home,{recursive:true,force:true});rmSync(webRoot,{recursive:true,force:true});});
 writeFileSync(join(webRoot,'next.html'),'Shared app');
 let link='';const app=await startSharedLoom({home,port:0,clock:new FakeClock(),webRoot,stdout:text=>{link=text.trim();}});clean.push(()=>app.close());
 expect(link).toMatch(/\/login\/[0-9a-f]{64}$/);
 const response=await fetch(link,{method:'POST',redirect:'manual'});expect(response.status).toBe(303);
 const cookie=response.headers.get('set-cookie')!.split(';')[0];
 const ws=new WebSocket(app.url.replace('http:','ws:')+'/graphql','graphql-transport-ws',{headers:{cookie,origin:app.url}});clean.push(()=>{ws.terminate();});
 await once(ws,'open');
 const frame=async(send:unknown)=>{const result=once(ws,'message');ws.send(JSON.stringify(send));return JSON.parse(String((await result)[0]));};
 expect(await frame({type:'connection_init'})).toEqual({type:'connection_ack'});
 const initial=await frame({type:'subscribe',id:'tasks',payload:{query:'subscription { observe(query:"{ tasks { id title } }") { revision patches { path removed value } } }'}});
 expect(initial.type).toBe('next');expect(initial.payload.data.observe.revision).toBe(1);
 const next=once(ws,'message');const at=new Date(app.operations.clock.now()).toISOString();
 app.writes.run(()=>app.db.insert(tasks).values({id:'t-1',title:'Live first-run task',ownerKind:'household',createdByKind:'member',createdBy:app.db.select().from(members).get()!.id,createdAt:at,changedAt:at}).run());
 expect(JSON.stringify(JSON.parse(String((await next)[0])))).toContain('Live first-run task');
 const http=await fetch(app.url+'/graphql',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({query:'{ tasks { id title } }'})});
 expect((await http.json()).data.tasks).toEqual([{id:'t-1',title:'Live first-run task'}]);
 const refused=new WebSocket(app.url.replace('http:','ws:')+'/live',{headers:{cookie,origin:app.url}});clean.push(()=>{refused.terminate();});
 await expect(once(refused,'open')).rejects.toThrow('404');
 const ended=once(ws,'close');app.writes.run(()=>app.db.delete(sessions).run());await ended;
 expect((await fetch(app.url+'/graphql',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({query:'{ tasks { id } }'})})).status).toBe(401);
});

it('can restart after failed web startup without losing first-run access; a signed-in home does not print another link',async()=>{
 const home=mkdtempSync(join(tmpdir(),'first-restart-')),webRoot=mkdtempSync(join(tmpdir(),'restart-web-'));
 clean.push(()=>{rmSync(home,{recursive:true,force:true});rmSync(webRoot,{recursive:true,force:true});});
 await expect(startSharedLoom({home,port:0,webRoot,stdout:()=>{throw Error('must not print');}})).rejects.toThrow();
 writeFileSync(join(webRoot,'next.html'),'Shared app');let link='';
 const first=await startSharedLoom({home,port:0,webRoot,stdout:text=>{link=text.trim();}});
 try{expect((await fetch(link,{method:'POST',redirect:'manual'})).status).toBe(303);}finally{await first.close();}
 const key=readFileSync(join(home,'comms.key'),'utf8');let printed='';
 const restarted=await startSharedLoom({home,port:0,webRoot,stdout:text=>{printed+=text;}});clean.push(()=>restarted.close());
 expect(printed).toBe('');expect(readFileSync(join(home,'comms.key'),'utf8')).toBe(key);
 expect(restarted.db.select().from(members).all()).toHaveLength(1);
 expect(restarted.db.$client.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'household_%' OR name='core_migrations'").all()).toEqual([]);
});

it.each([false,true])('refuses nonempty non-shared homes without altering memories (empty database: %s)',async database=>{
 const home=mkdtempSync(join(tmpdir(),'legacy-refused-'));clean.push(()=>rmSync(home,{recursive:true,force:true}));
 writeFileSync(join(home,'precious-memory.md'),'Keep these words');if(database)writeFileSync(join(home,'loom.db'),'');
 const before=readdirSync(home).sort();
 await expect(startSharedLoom({home,port:0,webRoot:home,stdout:()=>{throw Error('must not print');}})).rejects.toThrow('separate data move');
 expect(readdirSync(home).sort()).toEqual(before);expect(readFileSync(join(home,'precious-memory.md'),'utf8')).toBe('Keep these words');
 if(database)expect(statSync(join(home,'loom.db')).size).toBe(0);
});
it('refuses a symlink database without following it',async()=>{
 const home=mkdtempSync(join(tmpdir(),'symlink-refused-')),target=mkdtempSync(join(tmpdir(),'symlink-target-'));
 clean.push(()=>{rmSync(home,{recursive:true,force:true});rmSync(target,{recursive:true,force:true});});
 writeFileSync(join(target,'db'),'PRIVATE EXISTING BYTES');symlinkSync(join(target,'db'),join(home,'loom.db'));
 await expect(startSharedLoom({home,port:0,webRoot:home,stdout:()=>{}})).rejects.toThrow();
 expect(readFileSync(join(target,'db'),'utf8')).toBe('PRIVATE EXISTING BYTES');expect(readdirSync(home)).toEqual(['loom.db']);
});
it('keeps the home exclusive and credentials private until in-flight HTTP shutdown drains',async()=>{
 const home=mkdtempSync(join(tmpdir(),'owned-shared-')),webRoot=mkdtempSync(join(tmpdir(),'owned-web-'));
 clean.push(()=>{rmSync(home,{recursive:true,force:true});rmSync(webRoot,{recursive:true,force:true});});writeFileSync(join(webRoot,'next.html'),'Shared app');
 let link='';const options={home,port:0,webRoot,stdout:(text:string)=>{link=text.trim();}};
 const app=await startSharedLoom(options);clean.push(()=>app.close());
 const response=await fetch(link,{method:'POST',redirect:'manual'}),cookie=response.headers.get('set-cookie')!.split(';')[0];
 for(const name of readdirSync(home).filter(name=>name.startsWith('loom.db')||name==='comms.key'))expect(statSync(join(home,name)).mode&0o777).toBe(0o600);
 await expect(startSharedLoom(options)).rejects.toThrow('already running');
 let began!:()=>void,release!:()=>void;const entered=new Promise<void>(ok=>{began=ok;}),held=new Promise<void>(ok=>{release=ok;});
 app.operations.register({name:'fixture.held',input:z.object({}),output:z.null(),may:()=>true,async prepare(){began();await held;},run:()=>null});
 const request=fetch(app.url+'/api/fixture/held',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({input:{}})}).catch(()=>undefined);
 await entered;const stopped=app.close();
 try{await expect(startSharedLoom(options)).rejects.toThrow('already running');}finally{release();await stopped;await request;}
 const restarted=await startSharedLoom(options);clean.push(()=>restarted.close());expect(restarted.db.select().from(members).all()).toHaveLength(1);
});

it('refuses a preexisting empty database without initializing it',async()=>{
 const home=mkdtempSync(join(tmpdir(),'empty-db-refused-'));clean.push(()=>rmSync(home,{recursive:true,force:true}));writeFileSync(join(home,'loom.db'),'');
 await expect(startSharedLoom({home,port:0,webRoot:home,stdout:()=>{}})).rejects.toThrow('separate data move');
 expect(readdirSync(home)).toEqual(['loom.db']);expect(statSync(join(home,'loom.db')).size).toBe(0);
});
it('prints usable local-owner access after the only signed-in browser expires',async()=>{
 const home=mkdtempSync(join(tmpdir(),'expired-start-')),webRoot=mkdtempSync(join(tmpdir(),'expired-web-')),clock=new FakeClock();
 clean.push(()=>{rmSync(home,{recursive:true,force:true});rmSync(webRoot,{recursive:true,force:true});});writeFileSync(join(webRoot,'next.html'),'Shared app');
 let link='';const options={home,port:0,webRoot,clock,stdout:(text:string)=>{link=text.trim();}};
 const first=await startSharedLoom(options);try{expect((await fetch(link,{method:'POST',redirect:'manual',headers:{'user-agent':'HeadlessChrome/1'}})).status).toBe(303);}finally{await first.close();}
 clock.advance(6*3600000);link='';const recovered=await startSharedLoom(options);clean.push(()=>recovered.close());
 expect(link).toMatch(/\/login\/[0-9a-f]{64}$/);
 const response=await fetch(link,{method:'POST',redirect:'manual'});expect(response.status).toBe(303);
 expect((await fetch(recovered.url+'/auth/session',{headers:{cookie:response.headers.get('set-cookie')!.split(';')[0]}})).status).toBe(200);
});

it('releases home ownership after a real bind failure and recovers the first-run link',async()=>{
 const home=mkdtempSync(join(tmpdir(),'bind-failed-')),webRoot=mkdtempSync(join(tmpdir(),'bind-web-'));clean.push(()=>{rmSync(home,{recursive:true,force:true});rmSync(webRoot,{recursive:true,force:true});});writeFileSync(join(webRoot,'next.html'),'Shared app');
 const blocker=createServer();blocker.listen(0,'127.0.0.1');await once(blocker,'listening');const address=blocker.address();if(!address||typeof address==='string')throw Error('No bind address');
 try{await expect(startSharedLoom({home,port:address.port,webRoot,stdout:()=>{throw Error('must not print');}})).rejects.toThrow('EADDRINUSE');}finally{await new Promise<void>(ok=>blocker.close(()=>ok()));}
 let link='';const app=await startSharedLoom({home,port:address.port,webRoot,stdout:text=>{link=text.trim();}});clean.push(()=>app.close());
 expect((await fetch(link,{method:'POST',redirect:'manual'})).status).toBe(303);
});
