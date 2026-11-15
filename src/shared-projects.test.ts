import Database from 'better-sqlite3';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {getRequestListener} from '@hono/node-server';
import {WebSocket} from 'ws';
import {GraphQLString,type GraphQLFieldConfigMap} from 'graphql/index.js';
import type {Viewer} from './policy.js';
import {createHash} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterEach,expect,it} from 'vitest';
import {FakeClock} from './core/clock.js';
import {createDataSchema} from './core/data/database.js';
import {members,agents,tokens,projects,projectMembers,projectAgents,projectRepositories,changes} from './core/data/schema.js';
import {sharedRoot} from './shared-root.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
function fixture(fields:GraphQLFieldConfigMap<unknown,{viewer:Viewer}>={}){
 const client=new Database(':memory:');clean.push(()=>client.close());const clock=new FakeClock(),at=new Date(clock.now()).toISOString(),db=createDataSchema(client,()=>new Date(clock.now()).toISOString());
 db.insert(members).values([{id:'owner',role:'owner',joinedAt:at},{id:'sam',role:'member',joinedAt:at}]).run();db.insert(agents).values({id:'art',about:'',markBg:'#000',markFg:'#fff',faceShape:'pebble',faceEyes:'dot'}).run();
 const raw={owner:'a'.repeat(64),sam:'b'.repeat(64),art:'c'.repeat(64)},hash=(value:string)=>createHash('sha256').update(value).digest('hex');
 for(const member of ['owner','sam'] as const)db.insert(tokens).values({fingerprint:hash(raw[member]),kind:'owner',member,label:member,createdAt:at}).run();db.insert(tokens).values({fingerprint:hash(raw.art),kind:'agent',agent:'art',label:'art',createdAt:at}).run();
 const root=sharedRoot({db,clock,fields,originAllowed:()=>true,reportError:()=>{}});clean.push(()=>root.close());
 const call=(input:unknown,actor:keyof typeof raw='owner',id='save')=>root.http.request('http://loom/api/household/setProject',{method:'POST',headers:{authorization:'Bearer '+raw[actor],'content-type':'application/json'},body:JSON.stringify({input,id})});
 const read=(query:string,actor:keyof typeof raw='owner')=>root.http.request('http://loom/graphql',{method:'POST',headers:{authorization:'Bearer '+raw[actor],'content-type':'application/json'},body:JSON.stringify({query})}).then(r=>r.json());
 return{client,db,root,call,read};
}
const project={id:'pond',name:'Pond',members:['sam'],agents:['art'],repositories:['github:fixture/pond']};
it('commits plain project lists and exposes sharing setup only to owners',async()=>{
 const f=fixture();expect((await f.call(project)).status).toBe(200);
 expect((await f.read('{ householdSharing { members agents projects { id name members agents repositories } } }')).data.householdSharing.projects).toEqual([project]);
 for(const actor of ['sam','art'] as const){expect((await f.call({...project,name:'Changed'},actor)).status).toBe(403);expect((await f.read('{ householdSharing { members } }',actor)).data.householdSharing).toBeNull();}
});
it('validates references and repository uniqueness atomically with its retry receipt',async()=>{
 const f=fixture();expect((await f.call(project)).status).toBe(200);
 expect((await f.call({...project,id:'other'},'owner','other')).status).toBe(409);
 expect((await f.call({...project,id:'other',repositories:['github:FIXTURE/POND']},'owner','mixed-case')).status).toBe(409);
 for(const patch of [{members:['missing']},{agents:['missing']},{repositories:['https://github.com/fixture/pond']}])expect((await f.call({...project,...patch},'owner',JSON.stringify(patch))).status).toBe(400);
 expect(f.db.select().from(projectMembers).all()).toEqual([{project:'pond',member:'sam'}]);expect(f.db.select().from(projectAgents).all()).toEqual([{project:'pond',agent:'art'}]);
 f.client.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON operation_results BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
 expect((await f.call({...project,name:'Rolled back',members:[]},'owner','rollback')).status).toBe(503);expect(f.db.select().from(projects).get()?.name).toBe('Pond');
 expect(f.db.select().from(projectRepositories).all()).toEqual([{project:'pond',repository:'github:fixture/pond'}]);
 expect(f.db.select().from(projectMembers).all()).toEqual([{project:'pond',member:'sam'}]);
});
it('withdraws current project task visibility and owner administration before replay',async()=>{
 const f=fixture();await f.call(project);
 f.root.writes.run(()=>f.root.services.tasks.create({title:'Shared work',goal:'Works',why:'Needed',owner:{kind:'agent',id:'art'},project:'pond'},{kind:'member',id:'owner'}));
 expect((await f.read('{ tasks { title } }','sam')).data.tasks).toEqual([{title:'Shared work'}]);
 expect((await f.call({...project,members:[]},'owner','remove')).status).toBe(200);
 expect((await f.read('{ tasks { title } }','sam')).data.tasks).toEqual([]);
 f.root.writes.run(()=>f.db.update(members).set({role:'member'}).where(eq(members.id,'owner')).run());
 expect((await f.call(project)).status).toBe(403);
});

it('uses normalized repository identities and reprojects cached pull requests in the project edit transaction',async()=>{
 const f=fixture();await f.call({...project,repositories:['github:FIXTURE/POND']});
 f.db.insert(changes).values({id:'github:fixture/pond#1',repository:'fixture/pond',number:1,title:'Cached PR',body:'',url:'https://github.com/fixture/pond/pull/1',state:'open',draft:false,authorLogin:'author',project:'pond',branch:'feature',headCommit:'a'.repeat(40),baseBranch:'next',checks:'passing',review:'approved',mergeable:'yes',waitingOn:'you',openedAt:'2026-11-14T19:00:00.000Z',updatedAt:'2026-11-14T19:00:00.000Z'}).run();
 expect((await f.read('{ changes { id } }','sam')).data.changes).toHaveLength(1);
 expect((await f.call({...project,repositories:[]},'owner','remove-repo')).status).toBe(200);
 expect(f.db.select().from(changes).get()?.project).toBeNull();expect((await f.read('{ changes { id } }','sam')).data.changes).toEqual([]);
 f.root.writes.run(()=>f.root.services.projects.save({...project,id:'other',name:'Other'}));
 expect(f.db.select().from(changes).get()?.project).toBe('other');
});
it('lets trusted modules manage project lists without outside owner permission',()=>{
 const f=fixture();
 f.root.writes.run(()=>f.root.services.projects.save(project));
 expect(f.db.select().from(projectMembers).all()).toEqual([{project:'pond',member:'sam'}]);
 const installed=f.root.operations.internal('project-maintenance');
 expect(installed.call('household.setProject',{...project,members:[]},'trusted')).toMatchObject({ok:true});
 expect(f.db.select().from(projectMembers).all()).toEqual([]);
});

it('rolls back newly added grants when saving its receipt fails',async()=>{
 const f=fixture();await f.call({...project,members:[],agents:[]});
 f.client.exec("CREATE TRIGGER refuse_new_grants BEFORE INSERT ON operation_results BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
 expect((await f.call(project,'owner','new-grants')).status).toBe(503);
 expect(f.db.select().from(projectMembers).all()).toEqual([]);expect(f.db.select().from(projectAgents).all()).toEqual([]);
});

it('withdraws selected sharing metadata if its owner is demoted during an awaited sibling',async()=>{
 let began!:()=>void,release!:()=>void;const started=new Promise<void>(r=>began=r),held=new Promise<void>(r=>release=r);
 const f=fixture({hold:{type:GraphQLString,resolve:async()=>{began();await held;return 'Done';}}});await f.call({...project,name:'Private project label'});
 const pending=f.read('{ householdSharing { projects { name } } hold }');await started;
 f.db.update(members).set({role:'member'}).where(eq(members.id,'owner')).run();release();
 expect(await pending).toEqual({errors:[{message:'Authentication ended'}]});
});

it('keeps owner witnesses scoped to the selected request, allowing unrelated concurrent reads after demotion',async()=>{
 let began!:()=>void,release!:()=>void,count=0;const started=new Promise<void>(r=>began=r),held=new Promise<void>(r=>release=r);
 const f=fixture({hold:{type:GraphQLString,resolve:async()=>{if(++count===2)began();await held;return 'Still allowed';}}});await f.call(project);
 const privateRead=f.read('{ householdSharing { members agents projects { name } } hold }');
 const ordinaryRead=f.read('{ hold }');await started;
 f.db.update(members).set({role:'member'}).where(eq(members.id,'owner')).run();release();
 expect(await privateRead).toEqual({errors:[{message:'Authentication ended'}]});expect(await ordinaryRead).toEqual({data:{hold:'Still allowed'}});
 expect(await f.read('{ hold }')).toEqual({data:{hold:'Still allowed'}});
});
it('withdraws selected Sharing words on the actual live socket when owner permission changes during execution',async()=>{
 let began!:()=>void,release!:()=>void;const started=new Promise<void>(r=>began=r),held=new Promise<void>(r=>release=r);
 const f=fixture({hold:{type:GraphQLString,resolve:async()=>{began();await held;return 'Done';}}});await f.call({...project,name:'Private live label'});
 const server=createServer(getRequestListener(request=>f.root.http.fetch(request))),detach=f.root.attach(server);
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));clean.push(async()=>{detach();await f.root.close();await new Promise<void>(r=>server.close(()=>r()));});
 const address=server.address();if(!address||typeof address==='string')throw Error('No port');
 const ws=new WebSocket('ws://127.0.0.1:'+address.port+'/graphql','graphql-transport-ws',{headers:{authorization:'Bearer '+'a'.repeat(64)}});clean.push(()=>ws.terminate());const frames:string[]=[];ws.on('message',raw=>frames.push(String(raw)));await once(ws,'open');
 let next=once(ws,'message');ws.send(JSON.stringify({type:'connection_init'}));await next;
 ws.send(JSON.stringify({type:'subscribe',id:'sharing',payload:{query:'subscription { observe(query:"{ householdSharing { members agents projects { name } } hold }") { patches { path value } } }'}}));await started;
 const closed=once(ws,'close');f.db.update(members).set({role:'member'}).where(eq(members.id,'owner')).run();release();
 expect((await closed)[0]).toBe(4403);expect(frames.join(' ')).not.toContain('Private live label');
});
