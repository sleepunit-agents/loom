import Database from 'better-sqlite3';
import {createHash,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {afterEach,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import {FakeClock} from './core/clock.js';
import {createDataSchema} from './core/data/database.js';
import {agents,agentStatus,members,memberAgents,projects,projectMembers,projectAgents,tokens,sessions,operationResults} from './core/data/schema.js';
import {serveShared} from './shared-serve.js';
import {sharingQuery} from '../web/src/pieces/sharing/query.js';
const cleanup:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
async function fixture(){
 const client=new Database(':memory:');cleanup.push(()=>{client.close();});
 const clock=new FakeClock(),now=()=>new Date(clock.now()).toISOString(),db=createDataSchema(client,now);
 db.insert(members).values([{id:'owner',role:'owner',joinedAt:now()},{id:'peer',role:'member',joinedAt:now()}]).run();
 db.insert(agents).values(['art','mark'].map(id=>({id,about:'',markBg:'#000',markFg:'#fff',faceShape:'pebble' as const,faceEyes:'dot' as const}))).run();
 db.insert(memberAgents).values({member:'peer',agent:'art'}).run();
 db.insert(agentStatus).values(['art','mark'].map(agent=>({agent,state:'idle' as const,work:'',changedAt:now()}))).run();
 const cookies={owner:'o'.repeat(64),peer:'p'.repeat(64)};
 for(const [member,cookie] of Object.entries(cookies)){
  const fingerprint=hash(member.repeat(64));
  db.insert(tokens).values({fingerprint,label:member,kind:'owner',member,createdAt:now()}).run();
  db.insert(sessions).values({id:hash(cookie),token:fingerprint,device:'Fixture',via:'token',isAgent:false,issuedAt:now(),seenAt:now(),provedAt:now()}).run();
 }
 const errors:unknown[]=[];
 const app=await serveShared({db,clock,originAllowed:()=>true,reportError:error=>errors.push(error)});cleanup.push(()=>app.close());
 const send=(name:string,input:unknown,id:string=randomUUID(),person:keyof typeof cookies='owner')=>fetch(app.url+'/api/household/'+name,{method:'POST',headers:{'content-type':'application/json',cookie:'loom_ui='+cookies[person]},body:JSON.stringify({input,id})});
 const read=async(person:keyof typeof cookies='owner',query=sharingQuery)=>(await fetch(app.url+'/graphql',{method:'POST',headers:{'content-type':'application/json',cookie:'loom_ui='+cookies[person]},body:JSON.stringify({query})})).json();
 return {client,db,app,cookies,send,read,errors};
}
it('mounts canonical project sharing reads and atomic cookie-authenticated writes on the actual listener',async()=>{
 const f=await fixture();
 expect((await f.send('createProject',{slug:'garden',name:' Garden ',members:['peer','peer'],agents:['art']})).status).toBe(200);
 expect(await f.read()).toEqual({data:{projectSharing:{members:['owner','peer'],agents:['art','mark'],projects:[{id:'garden',name:'Garden',members:['peer'],agents:['art']}]}}});
 expect((await f.send('createProject',{slug:'garden',name:'Overwrite'})).status).toBe(409);
 for(const input of [{slug:'garden',members:['missing']},{slug:'garden',members:[],role:'owner'}])expect((await f.send('setProjectMembers',input)).status).toBe(400);
 expect(f.db.select().from(projectMembers).all()).toEqual([{project:'garden',member:'peer'}]);
 expect((await f.send('setProjectAgents',{slug:'garden',agents:['mark']})).status).toBe(200);
 expect(f.db.select().from(projectAgents).all()).toEqual([{project:'garden',agent:'mark'}]);
 expect((await f.read('peer','{agentStatus{agent}}')).data.agentStatus).toEqual([{agent:'art'},{agent:'mark'}]);
 expect(await f.read('peer')).toEqual({data:{projectSharing:null}});
 expect((await f.send('setProjectAgents',{slug:'garden',agents:['art']},'project-member','peer')).status).toBe(403);
 expect(f.db.select().from(projectAgents).all()).toEqual([{project:'garden',agent:'mark'}]);
 expect((await f.send('setProjectMembers',{slug:'garden',members:[]})).status).toBe(200);
 expect((await f.read('peer','{agentStatus{agent}}')).data.agentStatus).toEqual([{agent:'art'}]);
 expect(f.errors).toEqual([]);
});
it('withdraws administration from a demoted owner before replay and does not confuse agent ownership with household authority',async()=>{
 const f=await fixture(),input={slug:'garden',name:'Garden'};
 expect((await f.send('createProject',input,'create')).status).toBe(200);
 expect(await f.read('peer')).toEqual({data:{projectSharing:null}});
 expect((await f.send('setProjectMembers',{slug:'garden',members:['peer']},'peer','peer')).status).toBe(403);
 f.app.writes.run(()=>f.db.update(members).set({role:'member'}).where(eq(members.id,'owner')).run());
 expect(await f.read()).toEqual({data:{projectSharing:null}});
 expect((await f.send('createProject',input,'create')).status).toBe(403);
 expect(f.db.select().from(projects).all()).toEqual([{id:'garden',name:'Garden'}]);
});
it('denies authenticated agents both administration metadata and project writes',async()=>{
 const f=await fixture(),secret='a'.repeat(64),at=new Date().toISOString();
 f.db.insert(tokens).values({fingerprint:hash(secret),label:'Agent',kind:'agent',agent:'art',createdAt:at}).run();
 const headers={'content-type':'application/json',authorization:'Bearer '+secret};
 expect(await (await fetch(f.app.url+'/graphql',{method:'POST',headers,body:JSON.stringify({query:sharingQuery})})).json()).toEqual({data:{projectSharing:null}});
 expect((await fetch(f.app.url+'/api/household/createProject',{method:'POST',headers,body:JSON.stringify({id:'agent',input:{slug:'garden',name:'Garden'}})})).status).toBe(403);
 expect(f.db.select().from(projects).all()).toEqual([]);
});
it('rolls membership and the receipt back together when a write fails after deletion',async()=>{
 const f=await fixture();await f.send('createProject',{slug:'garden',name:'Garden',members:['owner']});
 f.client.exec("CREATE TEMP TRIGGER reject_members BEFORE INSERT ON project_members WHEN NEW.member='peer' BEGIN SELECT RAISE(ABORT,'fixture'); END");
 expect((await f.send('setProjectMembers',{slug:'garden',members:['peer']},'rollback')).status).toBe(503);
 expect(f.db.select().from(projectMembers).all()).toEqual([{project:'garden',member:'owner'}]);
 expect(f.db.select().from(operationResults).all().some(row=>row.id==='rollback')).toBe(false);
});
it('updates the existing live query and clears retained administration metadata after current-role withdrawal',async()=>{
 const f=await fixture(),ws=new WebSocket(f.app.url.replace(/^http/,'ws')+'/graphql','graphql-transport-ws',{headers:{cookie:'loom_ui='+f.cookies.owner,origin:f.app.url}});
 cleanup.push(()=>ws.terminate());await once(ws,'open');let next=once(ws,'message');ws.send(JSON.stringify({type:'connection_init'}));await next;
 next=once(ws,'message');ws.send(JSON.stringify({type:'subscribe',id:'sharing',payload:{query:'subscription($query:String!){observe(query:$query){patches{path value removed}}}',variables:{query:sharingQuery}}}));
 expect(JSON.parse(String((await next)[0])).payload.data.observe.patches[0].value.projectSharing.projects).toEqual([]);
 next=once(ws,'message');await f.send('createProject',{slug:'garden',name:'Garden'});
 expect(JSON.stringify(JSON.parse(String((await next)[0])).payload.data.observe.patches)).toContain('Garden');
 next=once(ws,'message');f.app.writes.run(()=>f.db.update(members).set({role:'member'}).where(eq(members.id,'owner')).run());
 expect(JSON.parse(String((await next)[0])).payload.data.observe.patches).toContainEqual({path:['projectSharing'],value:null,removed:false});
});
