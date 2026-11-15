import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {getRequestListener} from '@hono/node-server';
import {WebSocket} from 'ws';
import {GraphQLString} from 'graphql/index.js';
import {afterEach,expect,it} from 'vitest';
import {z} from 'zod';
import {FakeClock} from './core/clock.js';
import {createDataSchema} from './core/data/database.js';
import {members,agents,tokens,sessions,memberAgents,tasks} from './core/data/schema.js';
import {sharedRoot} from './shared-root.js';
import type {ProgramGrants} from './shared-program-access.js';
const cleanup:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const raw={program:'p'.repeat(64),sam:'s'.repeat(64),owner:'o'.repeat(64),cookie:'c'.repeat(64)},hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function fixture(hold?:()=>Promise<string>){
 const client=new Database(':memory:');cleanup.push(()=>client.close());const clock=new FakeClock(),at=new Date(clock.now()).toISOString(),db=createDataSchema(client,()=>new Date(clock.now()).toISOString());
 db.insert(members).values([{id:'owner',role:'owner',joinedAt:at},{id:'sam',role:'member',joinedAt:at}]).run();db.insert(agents).values({id:'art',about:'Agent',markBg:'#000',markFg:'#fff',faceShape:'pebble',faceEyes:'dot'}).run();db.insert(memberAgents).values({member:'sam',agent:'art'}).run();
 for(const kind of ['program','sam','owner'] as const)db.insert(tokens).values({fingerprint:hash(raw[kind]),label:kind,kind:'owner',member:kind==='owner'?'owner':'sam',createdAt:at}).run();
 db.insert(sessions).values({id:hash(raw.cookie),token:hash(raw.program),device:'Forbidden program browser',via:'link',isAgent:false,issuedAt:at,seenAt:at,provedAt:at}).run();
 const grants=new Map<string,ProgramGrants>([[hash(raw.program),{records:['tasks'],operations:['tasks.command']}]]);
 const root=sharedRoot({db,clock,originAllowed:()=>true,programGrants:fp=>grants.get(fp),fields:{custom:{type:GraphQLString,resolve:hold??(()=> 'Private custom words')}} ,reportError:()=>{}});cleanup.push(()=>root.close());
 root.writes.run(()=>{root.services.tasks.create({title:'Sam work',goal:'Done',why:'Fixture',owner:{kind:'agent',id:'art'}},{kind:'member',id:'owner'});root.services.tasks.create({title:'Owner private words',goal:'Done',why:'Fixture',owner:{kind:'member',id:'owner'}},{kind:'member',id:'owner'});});
 const read=(query:string,who:keyof typeof raw='program')=>root.http.request('http://loom/graphql',{method:'POST',headers:{authorization:'Bearer '+raw[who],'content-type':'application/json'},body:JSON.stringify({query})});
 const call=(operation:string,input:unknown,id='same-id',who:keyof typeof raw='program')=>root.http.request('http://loom/api/'+operation.replace('.','/'),{method:'POST',headers:{authorization:'Bearer '+raw[who],'content-type':'application/json'},body:JSON.stringify({id,input})});
 return{client,db,clock,root,grants,read,call};
}
it('limits generated records and connected/filter types while keeping the current member label policy',async()=>{
 const f=fixture();expect(await(await f.read('{ tasks { title } }')).json()).toEqual({data:{tasks:[{title:'Sam work'}]}});
 for(const query of ['{ members { id } }','{ custom }','{ account { member } }','{ householdSetup { members { id } } }','{ tasks { taskCommentsByTask { text } } }']){const answer=await(await f.read(query)).text();expect(answer).not.toContain('Owner private words');expect(JSON.parse(answer).errors).toBeDefined();}
 expect((await(await f.read('{ tasks { taskCommentsByTask { text } } }','sam')).json()).errors).toBeUndefined();
 const schema=await(await f.read('{ __schema { queryType { fields { name } } } }')).text();expect(schema).toContain('tasks');expect(schema).not.toMatch(/members|custom|account|householdSetup|taskComments/);
 expect(await(await f.read('{ custom }','sam')).json()).toEqual({data:{custom:'Private custom words'}});
});
it('requires explicit operations before effects/receipts and never turns zero grants into an ordinary member',async()=>{
 const f=fixture();const input={action:'comment',id:'t-1',text:'Program comment'};
 expect((await f.call('tasks.command',input)).status).toBe(200);
 f.grants.set(hash(raw.program),{records:[],operations:[]});
 expect((await f.call('tasks.command',input)).status).toBe(403);expect((await f.call('household.setMember',{id:'pat',role:'member',agents:[]})).status).toBe(403);
 const answer=await(await f.read('{ tasks { title } }')).json();expect(answer.errors).toBeDefined();expect(JSON.stringify(answer)).not.toContain('Sam work');
 expect(await(await f.read('{ tasks { title } }','sam')).json()).toEqual({data:{tasks:[{title:'Sam work'}]}});
});
it('denies credential ceremonies, program cookies and alternative private transports even if a grant names them',async()=>{
 const f=fixture();f.grants.set(hash(raw.program),{records:['tasks','tokens','sessions'],operations:['signin.link','signin.token','token.revoke','sessions.revoke','account.revokeSession']});
 for(const path of ['/api/signin/link','/api/signin/token','/api/token/revoke','/api/sessions/revoke','/api/account/revokeSession','/api/conversation/take','/auth/session']){const response=await f.root.http.request('http://loom'+path,{method:'POST',headers:{authorization:'Bearer '+raw.program,'content-type':'application/json'},body:'{}'});expect(response.status).toBe(403);}
 expect(f.root.credentials.authenticate(new Request('http://loom',{headers:{cookie:'loom_ui='+raw.cookie}}))).toBeUndefined();
 const auth=f.root.credentials.authenticate(new Request('http://loom',{headers:{authorization:'Bearer '+raw.program}}))!;
 expect(f.root.operations.call('http',auth.viewer,'token.revoke',{fingerprint:hash(raw.sam)},'forbidden')).toMatchObject({ok:false,code:'denied'});
});
it('isolates program receipts from ordinary tokens belonging to the same member',async()=>{
 const f=fixture();f.root.operations.register({name:'fixture.value',write:true,recheckPolicy:true,input:z.object({}).strict(),output:z.object({value:z.string()}).strict(),may:()=>true,run(ctx){return{value:f.root.credentials.program(ctx.viewer)?'Program result':'Ordinary private result'};}});
 f.grants.set(hash(raw.program),{records:[],operations:['fixture.value']});
 expect(await(await f.call('fixture.value',{},'shared','sam')).json()).toMatchObject({value:{value:'Ordinary private result'}});
 expect(await(await f.call('fixture.value',{},'shared')).json()).toMatchObject({value:{value:'Program result'}});
 expect(f.client.prepare("select count(*) as n from operation_results where id='shared'").get()).toEqual({n:2});
});
it('rechecks grants before prepared effects and keeps trusted installed calls free of outside grants',async()=>{
 let began!:()=>void,release!:()=>void;const started=new Promise<void>(r=>began=r),held=new Promise<void>(r=>release=r);const f=fixture();let effects=0,prepares=0;
 f.root.operations.register({name:'fixture.held',write:true,recheckPolicy:true,input:z.object({}).strict(),output:z.object({saved:z.literal(true)}),may:()=>true,prepare:async()=>{prepares++;began();await held;},run(){effects++;return{saved:true};}});
 expect((await f.call('fixture.held',{})).status).toBe(403);expect(prepares).toBe(0);
 f.grants.set(hash(raw.program),{records:[],operations:['fixture.held']});const pending=f.call('fixture.held',{});await started;f.grants.set(hash(raw.program),{records:[],operations:[]});release();expect((await pending).status).toBe(403);expect(effects).toBe(0);
 expect(await f.root.operations.internal('fixture').callAsync('fixture.held',{},'trusted')).toMatchObject({ok:true});expect(effects).toBe(1);
});
it('withdraws a retained live selection on grant change without waiting for a data epoch',async()=>{
 const f=fixture(),server=createServer(getRequestListener(request=>f.root.http.fetch(request))),detach=f.root.attach(server);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));cleanup.push(async()=>{detach();await f.root.close();await new Promise<void>(r=>server.close(()=>r()));});const address=server.address();if(!address||typeof address==='string')throw Error('No port');
 const ws=new WebSocket('ws://127.0.0.1:'+address.port+'/graphql','graphql-transport-ws',{headers:{authorization:'Bearer '+raw.program}});cleanup.push(()=>ws.terminate());await once(ws,'open');let next=once(ws,'message');ws.send(JSON.stringify({type:'connection_init'}));await next;
 next=once(ws,'message');ws.send(JSON.stringify({type:'subscribe',id:'tasks',payload:{query:'subscription { observe(query:"{ tasks { title } }") { patches { path value } } }'}}));expect(String((await next)[0])).toContain('Sam work');
 const closed=once(ws,'close');f.grants.set(hash(raw.program),{records:[],operations:[]});ws.send(JSON.stringify({type:'ping'}));expect((await closed)[0]).toBe(4403);
});

it('withdraws both lazy HTTP response branches after a direct grant edit',async()=>{
 const f=fixture(),response=await f.read('{ tasks { title } }'),copy=response.clone();
 f.grants.set(hash(raw.program),{records:[],operations:[]});
 await expect(response.text()).rejects.toThrow('Data access ended');await expect(copy.text()).rejects.toThrow('Data access ended');
});
it('withdraws an ordinary in-flight token when an owner first marks it as a restricted program',async()=>{
 const f=fixture(),response=await f.read('{ custom }','sam');
 f.grants.set(hash(raw.sam),{records:[],operations:[]});
 await expect(response.text()).rejects.toThrow('Data access ended');
 expect((await(await f.read('{ custom }','sam')).json()).errors).toBeDefined();
});
