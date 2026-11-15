import Database from 'better-sqlite3';
import {afterEach,expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {eq} from 'drizzle-orm';
import {FakeClock} from './core/clock.js';
import {createDataSchema} from './core/data/database.js';
import {agents,household,members,memberAgents,tokens,triggers,triggerLog,agentPauses} from './core/data/schema.js';
import {serveShared} from './shared-serve.js';
import {deskTempoQuery} from '../web/src/pieces/attention/bar-stats';
import {deskTimeQuery} from '../web/src/pieces/attention/bar-system';
const cleanups:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();});
const raw={owner:'o'.repeat(64),member:'m'.repeat(64)},hash=(value:string)=>createHash('sha256').update(value).digest('hex');
async function fixture(){
 const client=new Database(':memory:');cleanups.push(()=>{client.close();});
 const clock=new FakeClock(),at=new Date(clock.now()).toISOString(),db=createDataSchema(client,()=>new Date(clock.now()).toISOString());
 db.insert(members).values([{id:'owner',role:'owner',joinedAt:at},{id:'member',role:'member',joinedAt:at}]).run();
 db.insert(agents).values(['art','mark'].map(id=>({id,about:'',markBg:'#000',markFg:'#fff',faceShape:'pebble' as const,faceEyes:'dot' as const}))).run();
 db.insert(memberAgents).values({member:'member',agent:'art'}).run();
 db.insert(tokens).values(Object.entries(raw).map(([member,secret])=>({fingerprint:hash(secret),kind:'owner' as const,label:member,member,createdAt:at}))).run();
 const app=await serveShared({db,clock,originAllowed:()=>true,reportError:error=>{throw error;}});cleanups.push(()=>app.close());
 return {app,db,clock,at};
}
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

it('mounts the exact Tempo ticker with its unchanged reviewed policy before latest-event limits',async()=>{
 const f=await fixture();
 const read=async(member:keyof typeof raw='member')=>(await fetch(f.app.url+'/graphql',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+raw[member]},body:JSON.stringify({query:deskTempoQuery})})).json();
 f.app.writes.run(()=>{
  f.db.insert(triggers).values(['art','mark'].map(agent=>({id:'trigger-'+agent,ownerKind:'agent' as const,owner:agent,sourceKind:'time' as const,lifespan:'once' as const,targetKind:'operation' as const,target:'fixture',note:'Not selected',enabled:false,state:'standing' as const,createdAt:f.at,changedAt:f.at}))).run();
  f.db.insert(agentPauses).values(['art','mark'].map(agent=>({agent,since:f.at}))).run();
  f.db.insert(triggerLog).values([{seq:1,trigger:'trigger-art',at:f.at,event:'set',note:'Not selected'},{seq:2,trigger:'trigger-mark',at:f.at,event:'set',note:'Hidden newer event'}]).run();
 });
 expect(await read()).toEqual({data:{triggers:[{id:'trigger-art',enabled:false,state:'standing'}],triggerLog:[{seq:1,event:'set'}],agentPauses:[{agent:'art'}]}});
 expect((await read('owner')).data.triggers).toHaveLength(2);
 f.app.writes.run(()=>f.db.delete(memberAgents).run());expect(await read()).toEqual({data:{triggers:[],triggerLog:[],agentPauses:[]}});
});
