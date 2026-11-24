import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { afterEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { GraphQLString } from 'graphql/index.js';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { agents, agentBoxes, agentDeniedTools, agentHousePorts, agentPeople, agentRunSettings, boxes, boxAgents, boxFacts, members, memberAgents, tokens } from './core/data/schema.js';
import { sharedRoot } from './shared-root.js';
import { applyDataPatches } from '../web/src/data/graphql/client.js';
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const keys = { alice: 'a'.repeat(64), bob: 'b'.repeat(64), house: 'h'.repeat(64), art: 'x'.repeat(64), worker: 'w'.repeat(64) };
const query = '{ boxes(orderBy:{id:{direction:asc,priority:0}}) { id revokedAt } }';
function fixture(fields?: Parameters<typeof sharedRoot>[0]['fields']) {
  const client = new Database(':memory:'); cleanup.push(() => { client.close(); });
  const clock = new FakeClock(), now = () => new Date(clock.now()).toISOString(), db = createDataSchema(client, now);
  db.insert(members).values(['alice','bob','house'].map(id => ({id, role:id==='house'?'owner' as const:'member' as const,joinedAt:now()}))).run();
  db.insert(agents).values({id:'art',about:'',markBg:'#000',markFg:'#fff',faceShape:'pebble',faceEyes:'dot'}).run();
  db.insert(memberAgents).values({member:'bob',agent:'art'}).run();
  for (const [id,owner] of [['alice-box','alice'],['bob-box','bob'],['house-box','house'],['retired','alice']]) db.insert(boxes).values({id,owner,name:id,sameMachineAsLoom:false,hostsAny:true,reportOnly:false,alwaysOn:false,enrolledAt:now(),revokedAt:id==='retired'?now():null}).run();
  db.insert(boxAgents).values({box:'alice-box',agent:'art',lent:true}).run();
  for (const [id,key] of Object.entries(keys)) db.insert(tokens).values({fingerprint:createHash('sha256').update(key).digest('hex'),label:id,kind:id==='art'?'agent':id==='worker'?'runner':'owner',box:id==='worker'?'alice-box':null,agent:id==='art'?'art':null,member:id==='art'||id==='worker'?null:id,createdAt:now()}).run();
  const root=sharedRoot({db,clock,fields,originAllowed:()=>true,reportError:()=>{}});cleanup.push(()=>root.close());
  const post=(who:keyof typeof keys,source=query)=>root.http.request('/graphql',{method:'POST',headers:{authorization:'Bearer '+keys[who],'content-type':'application/json'},body:JSON.stringify({query:source})});
  return {db,root,post,now};
}
it('mounts exact ticker fields with member ownership and current household-owner precedence',async()=>{
  const f=fixture();
  for(const [who,ids] of [['alice',['alice-box','retired']],['bob',['bob-box']],['house',['alice-box','bob-box','house-box','retired']],['art',[]]] as const){
    const response=await f.post(who);expect(response.status).toBe(200);const body=await response.json();expect(body.errors).toBeUndefined();expect(body.data.boxes.map((row:{id:string})=>row.id)).toEqual(ids);
  }
  expect((await f.post('worker')).status).toBe(403);
  expect((await(await f.post('bob','{ boxes(limit:1,orderBy:{id:{direction:asc,priority:0}}) { id } }')).json()).data.boxes).toEqual([{id:'bob-box'}]);
  f.root.writes.run(()=>f.db.update(boxes).set({owner:'bob'}).where(eq(boxes.id,'alice-box')).run());
  expect((await (await f.post('alice')).json()).data.boxes.map((row:{id:string})=>row.id)).toEqual(['retired']);
});
it('shows which agents a machine allows and what it has to whoever sees the machine; an agent sees only its own rows',async()=>{
  const f=fixture();f.db.insert(boxFacts).values({box:'alice-box',fact:'gpu',fromOwner:true}).run();
  const read=async(who:keyof typeof keys)=>(await(await f.post(who,'{ boxAgents { box agent lent } boxFacts { box fact } boxes { id } }')).json()).data;
  expect(await read('alice')).toMatchObject({boxAgents:[{box:'alice-box',agent:'art',lent:true}],boxFacts:[{box:'alice-box',fact:'gpu'}]});
  expect(await read('house')).toMatchObject({boxAgents:[{box:'alice-box',agent:'art',lent:true}],boxFacts:[{box:'alice-box',fact:'gpu'}]});
  // Bob may use the agent, but the machine is Alice's.
  expect(await read('bob')).toMatchObject({boxAgents:[],boxFacts:[]});
  expect(await read('art')).toEqual({boxAgents:[{box:'alice-box',agent:'art',lent:true}],boxFacts:[],boxes:[]});
  const nested=await(await f.post('bob','{ agents { id boxAgentsByAgent { boxRow { id } } } }')).json();
  expect(nested.errors).toBeUndefined();expect(nested.data.agents).toEqual([{id:'art',boxAgentsByAgent:[]}]);
});
it('shows how an agent runs to those who see the agent, the agent included, and to nobody else',async()=>{
  const f=fixture();
  f.db.insert(agentRunSettings).values({agent:'art',houseRepository:'github:acme/house',houseFile:'house.yml',houseBranch:'main',repositorySecret:null,nestedContainers:false,gpu:true}).run();
  f.db.insert(agentBoxes).values({agent:'art',box:'alice-box',position:0}).run();f.db.insert(agentHousePorts).values({agent:'art',address:'127.0.0.1',port:8080}).run();
  f.db.insert(agentPeople).values({agent:'art',person:'discord:1',tier:2}).run();f.db.insert(agentDeniedTools).values({agent:'art',pattern:'Bash(rm *)',guestsOnly:true}).run();
  const q='{ agentRunSettings { agent houseRepository gpu } agentBoxes { box position } agentHousePorts { port } agentHouseSecrets { alias } agentPeople { person tier } agentDeniedTools { pattern guestsOnly } }';
  const full={agentRunSettings:[{agent:'art',houseRepository:'github:acme/house',gpu:true}],agentBoxes:[{box:'alice-box',position:0}],agentHousePorts:[{port:8080}],agentHouseSecrets:[],agentPeople:[{person:'discord:1',tier:2}],agentDeniedTools:[{pattern:'Bash(rm *)',guestsOnly:true}]};
  for(const who of ['bob','house','art'] as const){const body=await(await f.post(who,q)).json();expect(body.errors).toBeUndefined();expect(body.data).toEqual(full);}
  const none=await(await f.post('alice',q)).json();expect(none.errors).toBeUndefined();
  expect(none.data).toEqual({agentRunSettings:[],agentBoxes:[],agentHousePorts:[],agentHouseSecrets:[],agentPeople:[],agentDeniedTools:[]});
});
async function socket(f:ReturnType<typeof fixture>,who:keyof typeof keys){
  const server=createServer();const detach=f.root.attach(server);server.listen(0,'127.0.0.1');await once(server,'listening');
  cleanup.push(async()=>{await f.root.close();detach();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));});
  const address=server.address();if(!address||typeof address==='string')throw Error('No listener');
  const ws=new WebSocket(`ws://127.0.0.1:${address.port}/graphql`,'graphql-transport-ws',{headers:{authorization:'Bearer '+keys[who]}});cleanup.push(()=>ws.terminate());
  await once(ws,'open');const ack=once(ws,'message');ws.send(JSON.stringify({type:'connection_init'}));await ack;return ws;
}
for(const withdrawal of ['ownership','household-role'] as const) it(`updates the exact retained ticker and clears rows on ${withdrawal} withdrawal`,async()=>{
  const f=fixture(),who=withdrawal==='ownership'?'alice':'house',ws=await socket(f,who);let next=once(ws,'message');
  const apply=(raw:unknown,current:unknown)=>{
    const patches=JSON.parse(String(raw)).payload.data.observe.patches as Parameters<typeof applyDataPatches>[1];
    return applyDataPatches(current,patches);
  };
  ws.send(JSON.stringify({type:'subscribe',id:'boxes',payload:{query:`subscription { observe(query:${JSON.stringify(query)}) { revision patches { path value removed } } }`}}));
  let retained=apply((await next)[0],undefined);
  expect(retained).toEqual({boxes:who==='alice'?[{id:'alice-box',revokedAt:null},{id:'retired',revokedAt:f.now()}]:[{id:'alice-box',revokedAt:null},{id:'bob-box',revokedAt:null},{id:'house-box',revokedAt:null},{id:'retired',revokedAt:f.now()}]});
  next=once(ws,'message');f.root.writes.run(()=>f.db.update(boxes).set({revokedAt:f.now()}).where(eq(boxes.id,'alice-box')).run());
  retained=apply((await next)[0],retained);
  expect((retained as {boxes:{id:string;revokedAt:string}[]}).boxes.find(row=>row.id==='alice-box')?.revokedAt).toBe(f.now());
  next=once(ws,'message');f.root.writes.run(()=>withdrawal==='ownership'
    ?f.db.update(boxes).set({owner:'bob'}).where(eq(boxes.owner,'alice')).run()
    :f.db.update(members).set({role:'member'}).where(eq(members.id,'house')).run());
  retained=apply((await next)[0],retained);
  const remaining=withdrawal==='ownership'?[]:[{id:'house-box',revokedAt:null}];
  expect(retained).toEqual({boxes:remaining});
  expect((await(await f.post(who)).json()).data.boxes).toEqual(remaining);
});
it('withholds a held HTTP response if ownership changes before publication',async()=>{
  let began!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{began=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
  const f=fixture({hold:{type:GraphQLString,resolve:async()=>{began();await held;return 'ready';}}});
  const pending=f.post('alice','{ boxes { id } hold }');await started;
  f.root.writes.run(()=>f.db.update(boxes).set({owner:'bob'}).where(eq(boxes.owner,'alice')).run());release();
  const response=await pending;expect(response.status).toBe(503);expect(await response.text()).not.toContain('alice-box');
});
