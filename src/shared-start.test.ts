import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { startSharedLoom } from './shared-start.js';
import { tasks, sessions, members } from './core/data/schema.js';
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

it('can restart after a failed first listen without losing first-run access; a signed-in home does not print another link',async()=>{
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
