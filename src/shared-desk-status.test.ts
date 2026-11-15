import Database from 'better-sqlite3';
import {afterEach,expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {eq} from 'drizzle-orm';
import {FakeClock} from './core/clock.js';
import {createDataSchema} from './core/data/database.js';
import {agents,agentStatus,household,members,memberAgents,projects,projectMembers,projectAgents,tokens} from './core/data/schema.js';
import {serveShared} from './shared-serve.js';
import {deskTimeQuery} from '../web/src/pieces/attention/bar-system';
import {deskAgentStatusQuery} from '../web/src/pieces/attention/agent-status';
const cleanups:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();});
const raw={owner:'o'.repeat(64),member:'m'.repeat(64)},hash=(value:string)=>createHash('sha256').update(value).digest('hex');
async function fixture(){
 const client=new Database(':memory:');cleanups.push(()=>client.close());
 const clock=new FakeClock(),at=new Date(clock.now()).toISOString(),db=createDataSchema(client,()=>new Date(clock.now()).toISOString());
 db.insert(members).values([{id:'owner',role:'owner',joinedAt:at},{id:'member',role:'member',joinedAt:at}]).run();
 db.insert(agents).values(['art','mark'].map(id=>({id,about:'',markBg:'#000',markFg:'#fff',faceShape:'pebble' as const,faceEyes:'dot' as const}))).run();
 db.insert(memberAgents).values({member:'member',agent:'art'}).run();
 db.insert(agentStatus).values([{agent:'art',state:'working',work:'Own fixture status',changedAt:at},{agent:'mark',state:'waiting',work:'Other fixture status',changedAt:at}]).run();
 db.insert(tokens).values(Object.entries(raw).map(([member,secret])=>({fingerprint:hash(secret),kind:'owner' as const,label:member,member,createdAt:at}))).run();
 const app=await serveShared({db,clock,originAllowed:()=>true,reportError:error=>{throw error;}});cleanups.push(()=>app.close());
 const read=async(member:keyof typeof raw)=>(await fetch(app.url+'/graphql',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+raw[member]},body:JSON.stringify({query:deskAgentStatusQuery})})).json();
 return {app,db,clock,at,read};
}
it('mounts the exact desk status selection behind the current agent policy on HTTP',async()=>{
 const f=await fixture();
 expect(await f.read('member')).toEqual({data:{agentStatus:[{agent:'art',state:'working',work:'Own fixture status',changedAt:f.at}]}});
 expect((await f.read('owner')).data.agentStatus).toHaveLength(2);
 f.app.writes.run(()=>f.db.update(agentStatus).set({state:'idle',work:''}).where(eq(agentStatus.agent,'art')).run());
 expect((await f.read('member')).data.agentStatus[0]).toMatchObject({state:'idle',work:''});
 f.app.writes.run(()=>f.db.delete(memberAgents).run());
 expect(await f.read('member')).toEqual({data:{agentStatus:[]}});
 // The status rows remain; withdrawal follows current ownership rather than deletion.
 expect(f.db.select().from(agentStatus).all()).toHaveLength(2);
});
it('uses that same policy on the live socket and clears a retained status after ownership withdrawal',async()=>{
 const f=await fixture(),ws=new WebSocket(f.app.url.replace(/^http/,'ws')+'/graphql','graphql-transport-ws',{headers:{authorization:'Bearer '+raw.member}});
 cleanups.push(()=>ws.terminate());await once(ws,'open');
 let message=once(ws,'message');ws.send(JSON.stringify({type:'connection_init'}));await message;
 message=once(ws,'message');ws.send(JSON.stringify({type:'subscribe',id:'desk-status',payload:{query:'subscription($query:String!){observe(query:$query){patches{path value removed}}}',variables:{query:deskAgentStatusQuery}}}));
 const first=JSON.parse(String((await message)[0]));expect(first.payload.data.observe.patches[0].value).toEqual({agentStatus:[{agent:'art',state:'working',work:'Own fixture status',changedAt:f.at}]});
 message=once(ws,'message');f.app.writes.run(()=>f.db.delete(memberAgents).run());
 const cleared=JSON.parse(String((await message)[0]));expect(cleared.payload.data.observe.patches).toContainEqual({path:['agentStatus',0],value:null,removed:true});
 expect(await f.read('member')).toEqual({data:{agentStatus:[]}});
});

it('publishes the exact server-minute query and current household timezone on the same live socket',async()=>{
 const f=await fixture(),ws=new WebSocket(f.app.url.replace(/^http/,'ws')+'/graphql','graphql-transport-ws',{headers:{authorization:'Bearer '+raw.member}});
 cleanups.push(()=>ws.terminate());await once(ws,'open');let message=once(ws,'message');ws.send(JSON.stringify({type:'connection_init'}));await message;
 message=once(ws,'message');ws.send(JSON.stringify({type:'subscribe',id:'desk-time',payload:{query:'subscription($query:String!){observe(query:$query){patches{path value removed}}}',variables:{query:deskTimeQuery}}}));
 const first=JSON.parse(String((await message)[0]));expect(first.payload.data.observe.patches[0].value).toEqual({deskTime:{at:f.clock.now(),timezone:'UTC'}});
 message=once(ws,'message');f.clock.advance(61000);const tick=JSON.parse(String((await message)[0]));expect(tick.payload.data.observe.patches).toContainEqual({path:['deskTime','at'],value:Math.floor(f.clock.now()/60000)*60000,removed:false});
 message=once(ws,'message');f.app.writes.run(()=>f.db.insert(household).values({timezone:'America/Chicago'}).run());
 const zone=JSON.parse(String((await message)[0]));expect(zone.payload.data.observe.patches).toContainEqual({path:['deskTime','timezone'],value:'America/Chicago',removed:false});
 const http=await fetch(f.app.url+'/graphql',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+raw.member},body:JSON.stringify({query:deskTimeQuery})});
 expect(await http.json()).toEqual({data:{deskTime:{at:Math.floor(f.clock.now()/60000)*60000,timezone:'America/Chicago'}}});
});

it('keeps status scope identical to current shared-project agent visibility, including nested selection',async()=>{
 const f=await fixture();
 f.app.writes.run(()=>{f.db.insert(projects).values({id:'pond',name:'Pond'}).run();f.db.insert(projectMembers).values({project:'pond',member:'member'}).run();f.db.insert(projectAgents).values({project:'pond',agent:'mark'}).run();});
 expect((await f.read('member')).data.agentStatus.map((row:{agent:string})=>row.agent).sort()).toEqual(['art','mark']);
 const read=async()=> (await fetch(f.app.url+'/graphql',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+raw.member},body:JSON.stringify({query:'{ agents(where:{id:{eq:"mark"}}){ id agentStatusByAgent { agent work } } }'})})).json();
 expect(await read()).toEqual({data:{agents:[{id:'mark',agentStatusByAgent:[{agent:'mark',work:'Other fixture status'}]}]}});
 f.app.writes.run(()=>f.db.delete(projectMembers).run());expect(await read()).toEqual({data:{agents:[]}});expect((await f.read('member')).data.agentStatus.map((row:{agent:string})=>row.agent)).toEqual(['art']);
});
