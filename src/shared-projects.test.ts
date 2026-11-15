import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterEach,expect,it} from 'vitest';
import {FakeClock} from './core/clock.js';
import {createDataSchema} from './core/data/database.js';
import {members,agents,tokens,projects,projectMembers,projectAgents,projectRepositories} from './core/data/schema.js';
import {sharedRoot} from './shared-root.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
function fixture(){
 const client=new Database(':memory:');clean.push(()=>client.close());const clock=new FakeClock(),at=new Date(clock.now()).toISOString(),db=createDataSchema(client,()=>new Date(clock.now()).toISOString());
 db.insert(members).values([{id:'owner',role:'owner',joinedAt:at},{id:'sam',role:'member',joinedAt:at}]).run();db.insert(agents).values({id:'art',about:'',markBg:'#000',markFg:'#fff',faceShape:'pebble',faceEyes:'dot'}).run();
 const raw={owner:'a'.repeat(64),sam:'b'.repeat(64),art:'c'.repeat(64)},hash=(value:string)=>createHash('sha256').update(value).digest('hex');
 for(const member of ['owner','sam'] as const)db.insert(tokens).values({fingerprint:hash(raw[member]),kind:'owner',member,label:member,createdAt:at}).run();db.insert(tokens).values({fingerprint:hash(raw.art),kind:'agent',agent:'art',label:'art',createdAt:at}).run();
 const root=sharedRoot({db,clock,originAllowed:()=>true,reportError:()=>{}});clean.push(()=>root.close());
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
 for(const patch of [{members:['missing']},{agents:['missing']},{repositories:['https://github.com/fixture/pond']}])expect((await f.call({...project,...patch},'owner',JSON.stringify(patch))).status).toBe(400);
 expect(f.db.select().from(projectMembers).all()).toEqual([{project:'pond',member:'sam'}]);expect(f.db.select().from(projectAgents).all()).toEqual([{project:'pond',agent:'art'}]);
 f.client.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON operation_results BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
 expect((await f.call({...project,name:'Rolled back',members:[]},'owner','rollback')).status).toBe(503);expect(f.db.select().from(projects).get()?.name).toBe('Pond');
 expect(f.db.select().from(projectRepositories).all()).toEqual([{project:'pond',repository:'github:fixture/pond'}]);
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
