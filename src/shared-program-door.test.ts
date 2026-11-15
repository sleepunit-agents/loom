import Database from 'better-sqlite3';
import {afterEach,expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {GraphQLString} from 'graphql/index.js';
import {FakeClock} from './core/clock.js';
import {createDataSchema} from './core/data/database.js';
import {members,tokens} from './core/data/schema.js';
import {sharedRoot} from './shared-root.js';
import type {ProgramGrants} from './shared-program-access.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
const raw={owner:'a'.repeat(64),sam:'b'.repeat(64)},hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function fixture(fields?:Parameters<typeof sharedRoot>[0]['fields']){
 const client=new Database(':memory:');clean.push(()=>client.close());const clock=new FakeClock(),at=new Date(clock.now()).toISOString(),db=createDataSchema(client,()=>new Date(clock.now()).toISOString());
 for(const id of ['owner','sam'] as const){db.insert(members).values({id,role:id==='owner'?'owner':'member',joinedAt:at}).run();db.insert(tokens).values({fingerprint:hash(raw[id]),kind:'owner',member:id,label:id,createdAt:at}).run();}
 const grants=new Map<string,ProgramGrants>(),store={read:(id:string)=>grants.get(id),write:(id:string,value:ProgramGrants)=>{if(!client.inTransaction)throw Error('Grant write escaped token transaction');grants.set(id,value);return undefined;}};
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
 const owner=await(await f.request('/graphql',{query:'{ programSetup { owner catalogue { records operations } tokens { fingerprint label member records operations } } }'})).json();
 expect(owner.data.programSetup.owner).toBe('owner');expect(owner.data.programSetup.tokens).toEqual([{fingerprint:value.fingerprint,label:'Task reader',member:'sam',records:['tasks'],operations:[]}]);expect(owner.data.programSetup.catalogue.operations).not.toContain('program.setGrants');
 expect((await(await f.request('/graphql',{query:'{ programSetup { owner } }'},'sam')).json()).data.programSetup).toBeNull();
 const changed=await f.request('/api/program/setGrants',{input:{fingerprint:value.fingerprint,records:[],operations:[]},id:'clear'});expect(changed.status).toBe(200);expect(f.grants.has(value.fingerprint)).toBe(true);
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
