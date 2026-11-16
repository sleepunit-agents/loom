import Database from 'better-sqlite3';
import {afterEach,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {GraphQLString} from 'graphql/index.js';
import {FakeClock} from './core/clock.js';
import {createDataSchema} from './core/data/database.js';
import {members,tokens} from './core/data/schema.js';
import {sharedRoot} from './shared-root.js';
import {z} from 'zod';
import {sharedQueryTables} from './next-data.js';
import type {ProgramGrants} from './shared-program-access.js';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {WebSocket} from 'ws';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();vi.restoreAllMocks();});
const raw={owner:'a'.repeat(64),sam:'b'.repeat(64)},hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function fixture(fields?:Parameters<typeof sharedRoot>[0]['fields']){
 const client=new Database(':memory:');clean.push(()=>client.close());const clock=new FakeClock(),at=new Date(clock.now()).toISOString(),db=createDataSchema(client,()=>new Date(clock.now()).toISOString());
 for(const id of ['owner','sam'] as const){db.insert(members).values({id,role:id==='owner'?'owner':'member',joinedAt:at}).run();db.insert(tokens).values({fingerprint:hash(raw[id]),kind:'owner',member:id,label:id,createdAt:at}).run();}
 const grants=new Map<string,ProgramGrants>(),store={read:(id:string)=>grants.get(id),readMany:(ids:readonly string[])=>new Map([...grants].filter(([id])=>ids.includes(id))),write:(id:string,value:ProgramGrants)=>{if(!client.inTransaction)throw Error('Grant write escaped token transaction');grants.set(id,value);return undefined;}};
 // A supplied writer owns the reader too. An old reader option cannot widen it.
 const root=sharedRoot({db,clock,programStore:store,programGrants:()=>undefined,fields,originAllowed:()=>true,reportError:()=>{}});clean.push(()=>root.close());
 const request=(path:string,input:unknown,who='owner')=>root.http.request('http://loom'+path,{method:'POST',headers:{authorization:'Bearer '+(who in raw?raw[who as keyof typeof raw]:who),'content-type':'application/json'},body:JSON.stringify(input)});
 return{client,db,clock,at,grants,root,request};
}
it('issues only for an actual owner and uses the written marker for subsequent outside calls',async()=>{
 const f=fixture(),input={member:'sam',label:'Task reader',records:['tasks'],operations:[]};
 expect((await f.request('/api/signin/program',input,'sam')).status).toBe(403);
 expect((await f.request('/api/signin/program',{...input,records:['tokens']})).status).toBe(400);
 const response=await f.request('/api/signin/program',input);expect(response.status).toBe(200);const {value}=await response.json();expect(value.fingerprint).toBe(hash(value.token));
 expect(await(await f.request('/graphql',{query:'{ tasks { id } }'},value.token)).json()).toEqual({data:{tasks:[]}});
 expect((await(await f.request('/graphql',{query:'{ projects { id } }'},value.token)).json()).errors).toBeDefined();
 expect((await f.request('/api/signin/program',{...input,label:'Self escape'},value.token)).status).toBe(403);
 expect((await f.request('/api/program/setGrants',{input:{fingerprint:value.fingerprint,records:['projects'],operations:[]},id:'self'},value.token)).status).toBe(403);
 expect((await f.request('/api/program/setGrants',{input:{fingerprint:value.fingerprint,records:['projects'],operations:[]},id:'nonowner'},'sam')).status).toBe(403);
 const owner=await(await f.request('/graphql',{query:'{ programSetup { owner catalogue { records operations } tokens { fingerprint label member records operations } } }'})).json();
 expect(owner.data.programSetup.owner).toBe('owner');expect(owner.data.programSetup.tokens).toEqual([{fingerprint:value.fingerprint,label:'Task reader',member:'sam',records:['tasks'],operations:[]}]);expect(owner.data.programSetup.catalogue.operations).not.toContain('program.setGrants');
 expect((await(await f.request('/graphql',{query:'{ programSetup { owner } }'},'sam')).json()).data.programSetup).toBeNull();
 const changed=await f.request('/api/program/setGrants',{input:{fingerprint:value.fingerprint,records:[],operations:[]},id:'clear'});expect(changed.status).toBe(200);expect(f.grants.get(value.fingerprint)).toEqual({records:[],operations:[]});
 expect((await(await f.request('/graphql',{query:'{ tasks { id } }'},value.token)).json()).errors).toBeDefined();
 expect(JSON.stringify(f.client.prepare('SELECT * FROM operation_results').all())).not.toContain(value.token);
});
it('withholds the raw program credential if publication demotes its issuing owner',async()=>{
 const f=fixture();let changed=false;const stop=f.root.writes.observe(()=>{if(changed||!f.db.select().from(tokens).where(eq(tokens.label,'Withheld program')).get())return;changed=true;f.db.update(members).set({role:'member'}).where(eq(members.id,'owner')).run();});clean.push(stop);
 const response=await f.request('/api/signin/program',{member:'sam',label:'Withheld program',records:[],operations:[]});expect(changed).toBe(true);expect(response.status).toBe(403);expect(await response.json()).toEqual({error:'Household owner required'});
 expect(f.db.select().from(tokens).where(eq(tokens.label,'Withheld program')).get()).toBeDefined();
});
it('withdraws a held owner-only program read after direct demotion',async()=>{
 let enter!:()=>void,release!:(value:string)=>void;const entered=new Promise<void>(resolve=>{enter=resolve;}),held=new Promise<string>(resolve=>{release=resolve;});
 const f=fixture({hold:{type:GraphQLString,resolve:()=>{enter();return held;}}});
 await f.request('/api/signin/program',{member:'sam',label:'Private programme metadata',records:['tasks'],operations:[]});
 const pending=f.request('/graphql',{query:'{ programSetup { tokens { label } } hold }'});await entered;
 f.db.update(members).set({role:'member'}).where(eq(members.id,'owner')).run();release('released');
 const response=await pending;expect(response.status).toBe(401);expect(await response.text()).not.toContain('Private programme metadata');
 expect(await(await f.request('/graphql',{query:'{ tasks { id } }'})).json()).toEqual({data:{tasks:[]}});
});

it('keeps an owner-subject program out of credential and grant administration',async()=>{
 const f=fixture(),response=await f.request('/api/signin/program',{member:'owner',label:'Owner programme',records:['tasks'],operations:['tasks.command']});expect(response.status).toBe(200);const {value}=await response.json();
 expect((await f.request('/api/signin/program',{member:'owner',label:'Escape',records:[],operations:[]},value.token)).status).toBe(403);
 expect((await f.request('/api/signin/token',{kind:'owner',member:'owner',label:'Escape'},value.token)).status).toBe(403);
 expect((await f.request('/api/program/setGrants',{input:{fingerprint:value.fingerprint,records:['projects'],operations:[]},id:'escape'},value.token)).status).toBe(403);
 expect((await(await f.request('/graphql',{query:'{ programSetup { owner } }'},value.token)).json()).errors).toBeDefined();
 expect(f.grants.get(value.fingerprint)).toEqual({records:['tasks'],operations:['tasks.command']});
 const trusted=f.root.services.programSetup!;expect(trusted.catalogue().operations).toContain('tasks.command');
 const issued=trusted.issue({member:'sam',label:'Trusted installed helper',records:['tasks'],operations:[]});expect(f.root.credentials.authenticate(new Request('http://loom',{headers:{authorization:'Bearer '+issued.token}}))?.valid()).toBe(true);
});
it.each(['oversize','origin','cross-site','closed'] as const)('guards the program ceremony for %s',async reason=>{
 const f=fixture();if(reason==='closed')await f.root.close();
 const response=await f.root.http.request('http://loom/api/signin/program',{method:'POST',headers:{authorization:'Bearer '+raw.owner,'content-type':'application/json',...(reason==='origin'?{origin:'https://other.invalid'}:{}),...(reason==='cross-site'?{'sec-fetch-site':'cross-site'}:{})},body:JSON.stringify({member:'sam',label:reason==='oversize'?'x'.repeat(33000):'Guarded',records:[],operations:[]})});
 expect(response.status).toBe(reason==='oversize'?413:reason==='closed'?503:403);expect(f.db.select().from(tokens).all()).toHaveLength(2);
});
it.each(['revoke','demote'] as const)('rechecks program issuer authority at write entry after %s',async change=>{
 const f=fixture(),run=f.root.writes.run.bind(f.root.writes);vi.spyOn(f.root.writes,'run').mockImplementationOnce(action=>{
 if(change==='revoke')f.db.update(tokens).set({revokedAt:f.at}).where(eq(tokens.fingerprint,hash(raw.owner))).run();else f.db.update(members).set({role:'member'}).where(eq(members.id,'owner')).run();return run(action);
 });
 expect((await f.request('/api/signin/program',{member:'sam',label:'Refused',records:[],operations:[]})).status).toBe(403);expect(f.db.select().from(tokens).where(eq(tokens.label,'Refused')).all()).toEqual([]);
});
it.each([false,true])('withdraws a held program owner socket read after demotion, live=%s',async live=>{
 let enter!:()=>void,release!:(value:string)=>void;const entered=new Promise<void>(resolve=>{enter=resolve;}),held=new Promise<string>(resolve=>{release=resolve;});
 const f=fixture({hold:{type:GraphQLString,resolve:()=>{enter();return held;}}});await f.request('/api/signin/program',{member:'sam',label:'Private socket metadata',records:[],operations:[]});
 const server=createServer(),detach=f.root.attach(server);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));clean.push(async()=>{release('released');detach();await f.root.close();await new Promise<void>(resolve=>server.close(()=>resolve()));});
 const address=server.address();if(!address||typeof address==='string')throw Error('No address');const ws=new WebSocket(`ws://127.0.0.1:${address.port}/graphql`,'graphql-transport-ws',{headers:{authorization:'Bearer '+raw.owner}});clean.push(()=>ws.terminate());await once(ws,'open');
 let next=once(ws,'message');ws.send(JSON.stringify({type:'connection_init'}));await next;
 const selection='{ programSetup { tokens { label } } hold }',query=live?'subscription { observe(query:'+JSON.stringify(selection)+') { revision patches { path value removed } } }':selection;
 const frames:string[]=[];ws.on('message',value=>frames.push(String(value)));const closed=once(ws,'close');ws.send(JSON.stringify({type:'subscribe',id:'private',payload:{query}}));await entered;f.db.update(members).set({role:'member'}).where(eq(members.id,'owner')).run();release('released');
 expect((await closed)[0]).toBe(4403);expect(frames.join(' ')).not.toContain('Private socket metadata');
});
it('withholds a program credential when publication closes admission',async()=>{
 const f=fixture();let closing:Promise<void>|undefined;const stop=f.root.writes.observe(()=>{if(!closing&&f.db.select().from(tokens).where(eq(tokens.label,'Closed issuance')).get())closing=f.root.close();});clean.push(stop);
 const response=await f.request('/api/signin/program',{member:'sam',label:'Closed issuance',records:[],operations:[]});expect(closing).toBeDefined();expect(response.status).toBe(503);expect(await response.json()).toEqual({error:'Sign-in unavailable'});await closing;
});

it('withholds a program credential after publication revokes its issuer',async()=>{
 const f=fixture();let changed=false;const stop=f.root.writes.observe(()=>{if(changed||!f.db.select().from(tokens).where(eq(tokens.label,'Revoked issuer')).get())return;changed=true;f.db.update(tokens).set({revokedAt:f.at}).where(eq(tokens.fingerprint,hash(raw.owner))).run();});clean.push(stop);
 const response=await f.request('/api/signin/program',{member:'sam',label:'Revoked issuer',records:[],operations:[]});expect(changed).toBe(true);expect(response.status).toBe(403);expect(await response.json()).toEqual({error:'Household owner required'});
});

it('builds the public catalogue from current generated records and HTTP operations',async()=>{
 const f=fixture(),service=f.root.services.programSetup!;expect(service.catalogue().records).toEqual([...sharedQueryTables].sort());
 for(const name of ['sessions','signinLinks','tokens'])expect((await f.request('/api/signin/program',{member:'sam',label:'Private record attempt',records:[name],operations:[]})).status).toBe(400);
 const operation={name:'tasks.lateRegistered',input:z.object({}),output:z.boolean(),may:()=>true,run:()=>true};expect(service.catalogue().operations).not.toContain(operation.name);f.root.operations.register(operation);expect(service.catalogue().operations).toContain(operation.name);
});
