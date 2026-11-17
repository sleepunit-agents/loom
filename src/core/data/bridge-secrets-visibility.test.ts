import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { graphql } from 'graphql/index.js';
import { eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { createDataSchema, dataDatabase } from './database.js';
import { dataQueries } from './queries.js';
import { bridgeSecretsTables, bridgeSecretsVisibility } from './bridge-secrets-visibility.js';
import { members, memberAgents, agents, secrets, bridgeConnections, bridgeIncoming, bridgeSends, conversations, projects, projectMembers, projectAgents, tokens, bridgePeople, bridgeChannelFilters, bridgeChannels, secretGrants, secretRequests, secretRules, secretRuleAgents, secretUses, secretChanges, jobs } from './schema.js';
import { nextData } from '../../next-data.js';
import { FakeClock } from '../clock.js';
import type { Viewer } from '../../policy.js';
const opened: Database.Database[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });
function fixture() {
 const client = new Database(':memory:'); opened.push(client);
 const clock = new FakeClock(), at = new Date(clock.now()).toISOString(), db = createDataSchema(client);
 for (const id of ['owner','alice','bob']) db.insert(members).values({id,role:id==='owner'?'owner':'member',joinedAt:at}).run();
 for (const id of ['art','other']) db.insert(agents).values({id,about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();
 db.insert(memberAgents).values({member:'alice',agent:'art'}).run();
 db.insert(projects).values({id:'p',name:'p'}).run();
 db.insert(projectMembers).values({project:'p',member:'bob'}).run();
 db.insert(secrets).values({name:'TOKEN',description:'Private metadata',changedBy:'owner',changedAt:at}).run();
 for (const [id,agent] of [['c','art'],['d','other']]) db.insert(bridgeConnections).values({id,agent,platform:'slack',workspace:id,botUser:'bot',tokenSecret:'TOKEN',enabled:true,state:'connected',stateAt:at}).run();
 db.insert(bridgeChannelFilters).values({connection:'c',channel:'room',rule:'only'}).run();
 db.insert(bridgeChannels).values({platform:'slack',workspace:'c',channel:'room',answers:'art',botsMayTalk:false}).run();
 db.insert(jobs).values({id:'job',agent:'art',title:'',brief:'',model:'test',state:'running',startedByKind:'agent',startedBy:'art',houseRepository:'',houseFile:'',houseBranch:'',queuedAt:at}).run();
 db.insert(secretRequests).values({id:'request',secret:'TOKEN',agent:'art',job:'job',why:'test',state:'allowed',minutes:5,always:false,askedAt:at}).run();
 db.insert(secretGrants).values({id:'grant',secret:'TOKEN',agent:'art',job:'job',request:'request',grantedBy:'owner',grantedAt:at,expiresAt:new Date(clock.now()+300000).toISOString()}).run();
 db.insert(secretRules).values({secret:'TOKEN',answer:'ask',minutes:5}).run();
 db.insert(secretRuleAgents).values({secret:'TOKEN',agent:'art',when:'on_request'}).run();
 db.insert(secretUses).values({id:'use',secret:'TOKEN',agent:'art',job:'job',at,state:'released'}).run();
 db.insert(secretChanges).values({id:'change',secret:'TOKEN',action:'add',by:'owner',at}).run();
 db.insert(bridgePeople).values({platform:'slack',workspace:'c',user:'outside',member:'alice'}).run();
 for (const [id,member,project,agent] of [['own',null,null,'art'],['private','alice','p','art'],['project',null,'p','other']]) {
  db.insert(conversations).values({id:id!,agent:agent!,member,project,venue:'slack',place:id!,label:id!,startedAt:at,lastAt:at,turnCount:0}).run();
  db.insert(bridgeIncoming).values({id:id!,connection:'c',channel:'room',user:'u',isDm:false,text:id!,state:'delivered',postedAt:at,receivedAt:at,conversation:id!}).run();
  db.insert(bridgeSends).values({id:id!,incoming:id!,connection:'c',channel:'room',text:id!,state:'held',createdAt:at}).run();
 }
 db.insert(bridgeIncoming).values({id:'unlabelled',connection:'c',channel:'room',user:'u',isDm:false,text:'unlabelled',state:'held',postedAt:at,receivedAt:at}).run();
 const schema = (viewer:Viewer) => dataQueries(client,{tables:[...bridgeSecretsTables],visibility:bridgeSecretsVisibility(viewer)});
 const read = async (viewer:Viewer, retained=schema(viewer)) => {
  const result=await graphql({schema:retained,source:'{ bridgeConnections { id } bridgeIncoming { id } bridgeSends { id } secrets { name } bridgePeople { user } }'});
  expect(result.errors).toBeUndefined();return result.data;
 };
 return {db,client,clock,at,schema,read};
}
it('uses conversation labels for incoming and replies, preserving private-member precedence',async()=>{
 const f=fixture();
 // A household owner sets the bridges up and reads the household's rooms, and a message that went nowhere; not a member's private conversation.
 expect(await f.read({kind:'member',id:'owner'})).toMatchObject({bridgeConnections:[{id:'c'},{id:'d'}],bridgeIncoming:[{id:'own'},{id:'project'},{id:'unlabelled'}],bridgeSends:[{id:'own'},{id:'project'}],secrets:[{name:'TOKEN'}],bridgePeople:[{user:'outside'}]});
 expect(await f.read({kind:'member',id:'alice'})).toMatchObject({bridgeConnections:[{id:'c'}],bridgeIncoming:[{id:'own'},{id:'private'}],bridgeSends:[{id:'own'},{id:'private'}],secrets:[],bridgePeople:[]});
 expect(await f.read({kind:'member',id:'bob'})).toMatchObject({bridgeConnections:[],bridgeIncoming:[{id:'project'}],bridgeSends:[{id:'project'}],secrets:[]});
 expect(await f.read({kind:'agent',id:'art'})).toMatchObject({bridgeConnections:[],bridgeIncoming:[{id:'own'}],bridgeSends:[{id:'own'}],secrets:[]});
 expect(await f.read({kind:'runner',id:'r'})).toMatchObject({bridgeConnections:[],bridgeIncoming:[],bridgeSends:[],secrets:[]});
});
it('gives a direct message with no member to the agent\'s owners, and not to the agent\'s own token or the owner role',async()=>{
 const f=fixture();
 // A DM from someone with no person link, and a group DM: neither has a member to be private to.
 f.db.insert(conversations).values({id:'dm',agent:'art',direct:true,venue:'slack',place:'dm',label:'dm',startedAt:f.at,lastAt:f.at,turnCount:0}).run();
 f.db.insert(bridgeIncoming).values({id:'dm',connection:'c',channel:'D1',user:'stranger',isDm:true,text:'for the agent only',state:'delivered',postedAt:f.at,receivedAt:f.at,conversation:'dm'}).run();
 f.db.insert(bridgeSends).values({id:'dm',incoming:'dm',connection:'c',channel:'D1',text:'the answer',state:'sent',createdAt:f.at}).run();
 // A body of the same agent working anywhere else holds this identity. It reads its rooms, not its DMs.
 expect(await f.read({kind:'agent',id:'art'})).toMatchObject({bridgeIncoming:[{id:'own'}],bridgeSends:[{id:'own'}]});
 // The people the agent answers to still can.
 expect(await f.read({kind:'member',id:'alice'})).toMatchObject({bridgeIncoming:[{id:'own'},{id:'private'},{id:'dm'}],bridgeSends:[{id:'own'},{id:'private'},{id:'dm'}]});
 // A direct message that was held went into no conversation. It is still for the owners of its connection's agent.
 f.db.insert(bridgeIncoming).values({id:'held-dm',connection:'c',channel:'D2',user:'stranger',isDm:true,text:'held words',state:'held',postedAt:f.at,receivedAt:f.at}).run();
 expect((await f.read({kind:'member',id:'alice'}))?.bridgeIncoming).toContainEqual({id:'held-dm'});
 // The owner role alone does not own the agent: it reads neither, and neither does a project-mate or the agent.
 for(const viewer of [{kind:'member',id:'owner'},{kind:'member',id:'bob'},{kind:'agent',id:'art'}] as const){
  const seen=await f.read(viewer);
  expect(seen?.bridgeIncoming).not.toContainEqual({id:'dm'});expect(seen?.bridgeIncoming).not.toContainEqual({id:'held-dm'});expect(seen?.bridgeSends).not.toContainEqual({id:'dm'});
 }
});
it('keeps a held direct message from a linked member that member\'s alone, as its conversation would be',async()=>{
 const f=fixture();
 // Bob wrote to Art's bot one to one. The message was held, so it is in no conversation yet.
 f.db.insert(bridgeIncoming).values({id:'held-private',connection:'c',channel:'D3',user:'bob-outside',member:'bob',isDm:true,text:'private words',state:'held',postedAt:f.at,receivedAt:f.at}).run();
 // In a group direct message there are other senders: it is not private to one of them.
 f.db.insert(bridgeIncoming).values({id:'held-group',connection:'c',channel:'G1',user:'bob-outside',member:'bob',isDm:true,groupDm:true,text:'group words',state:'held',postedAt:f.at,receivedAt:f.at}).run();
 const seen=async(viewer:Viewer)=>((await f.read(viewer))?.bridgeIncoming as {id:string}[]).map(row=>row.id).filter(id=>id.startsWith('held-'));
 expect(await seen({kind:'member',id:'bob'})).toEqual(['held-private']);
 // Alice has the agent, and the owner runs the household: neither reads Bob's own words to it.
 expect(await seen({kind:'member',id:'alice'})).toEqual(['held-group']);
 expect(await seen({kind:'member',id:'owner'})).toEqual([]);
 expect(await seen({kind:'agent',id:'art'})).toEqual([]);
});
it('rechecks ownership and private labels in retained query schemas after revocation',async()=>{
 const f=fixture(),viewer={kind:'member',id:'alice'} as const, schema=f.schema(viewer);
 f.db.delete(memberAgents).where(eq(memberAgents.member,'alice')).run();
 f.db.update(conversations).set({member:'bob'}).where(eq(conversations.id,'private')).run();
 expect(await f.read(viewer,schema)).toMatchObject({bridgeConnections:[],bridgeIncoming:[],bridgeSends:[]});
 const owner={kind:'member',id:'owner'} as const, retained=f.schema(owner);
 f.db.update(members).set({role:'member'}).where(eq(members.id,'owner')).run();
 expect(await f.read(owner,retained)).toMatchObject({bridgeConnections:[],bridgeIncoming:[],secrets:[],bridgePeople:[]});
});
it('mounts both exact registered selections through the authenticated shared HTTP door',async()=>{
 const f=fixture(), bearer='a'.repeat(64);
 f.db.insert(tokens).values({fingerprint:createHash('sha256').update(bearer).digest('hex'),kind:'owner',member:'owner',label:'test',createdAt:f.at}).run();
 const root=nextData(f.db,f.clock,()=>true);
 try {
  const {settingsQuery}=await import('../../../web/src/pieces/settings/data');
  const {bridgesQuery}=await import('../../../web/src/pieces/bridges/data');
  const read=async(query:string,credential=bearer)=>{const response=await root.http.request('http://loom/graphql',{method:'POST',headers:{authorization:'Bearer '+credential,'content-type':'application/json'},body:JSON.stringify({query})});expect(response.status).toBe(200);return response.json();};
  expect(await read(settingsQuery)).toMatchObject({data:{secretsReader:{id:'owner',defaultAnswer:'ask'},secrets:[{name:'TOKEN'}]}});
  const bridge=await read(bridgesQuery);expect(bridge.errors).toBeUndefined();expect(bridge.data).toMatchObject({bridgeReader:{id:'owner'},bridgeActivity:[{id:'c',received:3,delivered:2,held:1},{id:'d',received:0}]});
  const alice='c'.repeat(64);
  f.db.insert(tokens).values({fingerprint:createHash('sha256').update(alice).digest('hex'),kind:'owner',member:'alice',label:'alice',createdAt:f.at}).run();
  const scoped=await read(bridgesQuery,alice);expect(scoped.errors).toBeUndefined();
  expect(scoped.data.bridgeActivity).toEqual([{id:'c',received:2,delivered:2,held:0}]);
  f.db.update(members).set({role:'member'}).where(eq(members.id,'owner')).run();root.changed();
  expect(await read(settingsQuery)).toMatchObject({data:{secretsReader:null,secrets:[]}});
  const forbidden=await read('{ secrets { value } secretWriteJournal { inputHash } }');expect(forbidden.errors).toHaveLength(2);
 } finally {await root.close();}
});

it('refreshes real live activity at deadlines, reschedules after writes and cancels on close',async()=>{
 const f=fixture(),bearer='a'.repeat(64),day=86400_000;
 f.db.insert(tokens).values({fingerprint:createHash('sha256').update(bearer).digest('hex'),kind:'owner',member:'owner',label:'test',createdAt:f.at}).run();
 f.db.update(bridgeIncoming).set({receivedAt:new Date(f.clock.now()-day+1000).toISOString()}).run();
 // Counted for this owner: none of the four messages is in a member's private conversation.
 f.db.update(conversations).set({member:null}).where(eq(conversations.id,'private')).run();
 const cancelled:ReturnType<typeof vi.fn>[]=[];
 const instrumented={now:()=>f.clock.now(),at:(time:number,fn:()=>void)=>{const cancel=f.clock.at(time,fn),spy=vi.fn(cancel);cancelled.push(spy);return spy;}};
 const root=nextData(f.db,instrumented,()=>true),http=createServer();root.attach(http);
 await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve));
 const address=http.address();if(!address||typeof address==='string')throw Error('No port');
 const ws=new WebSocket(`ws://127.0.0.1:${address.port}/graphql`,'graphql-transport-ws',{headers:{authorization:'Bearer '+bearer}});
 const frame=async(action:()=>void)=>{const pending=once(ws,'message');action();return JSON.parse(String((await pending)[0]));};
 try {
  await once(ws,'open');await frame(()=>ws.send(JSON.stringify({type:'connection_init'})));
  const initial=await frame(()=>ws.send(JSON.stringify({id:'activity',type:'subscribe',payload:{query:'subscription($query:String!){ observe(query:$query){revision patches{path removed value}}}',variables:{query:'{ bridgeActivity { id received delivered held } }'}}})));
  expect(initial.payload.data.observe.patches[0].value.bridgeActivity[0].received).toBe(4);
  const added=await frame(()=>root.writes.run(()=>f.db.insert(bridgeIncoming).values({id:'earlier',connection:'c',channel:'room',isDm:false,user:'u',text:'not selected',state:'held',postedAt:f.at,receivedAt:new Date(f.clock.now()-day+500).toISOString()}).run()));
  expect(added.payload.data.observe.patches).toContainEqual({path:['bridgeActivity',0,'received'],removed:false,value:5});
  const earlier=await frame(()=>f.clock.advance(500));
  expect(earlier.payload.data.observe.patches).toContainEqual({path:['bridgeActivity',0,'received'],removed:false,value:4});
  const expired=await frame(()=>f.clock.advance(500));
  expect(expired.payload.data.observe.patches).toContainEqual({path:['bridgeActivity',0,'received'],removed:false,value:0});
  // Leave a future expiry pending when closing; prove cancellation itself.
  await frame(()=>root.writes.run(()=>f.db.update(bridgeIncoming).set({receivedAt:new Date(f.clock.now()).toISOString()}).where(eq(bridgeIncoming.id,'earlier')).run()));
  const pending=cancelled.at(-1)!;expect(pending).not.toHaveBeenCalled();
  await root.close();expect(pending).toHaveBeenCalledOnce();
 }finally{ws.terminate();await root.close();await new Promise<void>(resolve=>http.close(()=>resolve()));}
 f.db.insert(bridgeIncoming).values({id:'after-close',connection:'c',channel:'room',isDm:false,user:'u',text:'not selected',state:'held',postedAt:f.at,receivedAt:f.at}).run();
 // A stopped composition never creates a new deadline from a later notification.
 root.changed();f.clock.advance(day);
});

it('filters retained connected reads with current connection and conversation authority',async()=>{
 const f=fixture(),viewer={kind:'member',id:'alice'} as const,schema=f.schema(viewer);
 const read=async()=>{const result=await graphql({schema,source:'{ bridgeConnections { id tokenSecretRow { name } bridgeChannelFiltersByConnection { channel } bridgeIncomingByConnection { id bridgeSendsByIncoming { id } } } }'});expect(result.errors).toBeUndefined();return result.data?.bridgeConnections;};
 expect(await read()).toEqual([{id:'c',tokenSecretRow:null,bridgeChannelFiltersByConnection:[],bridgeIncomingByConnection:[{id:'own',bridgeSendsByIncoming:[{id:'own'}]},{id:'private',bridgeSendsByIncoming:[{id:'private'}]}]}]);
 f.db.update(conversations).set({member:'bob'}).where(eq(conversations.id,'private')).run();
 expect(await read()).toMatchObject([{bridgeIncomingByConnection:[{id:'own'}]}]);
 f.db.delete(memberAgents).where(eq(memberAgents.member,'alice')).run();expect(await read()).toEqual([]);
});
it('populates every owner metadata projection and revokes retained parent and child reads',async()=>{
 const f=fixture(),viewer={kind:'member',id:'owner'} as const,schema=f.schema(viewer);
 const query='{ bridgeChannelFilters { channel } bridgeChannels { channel } secretGrants { id } secretRequests { id } secretRules { secret } secretRuleAgents { secret } secretUses { id } secretChanges { id } secrets { name secretGrantsBySecret { id } secretRequestsBySecret { id } secretRulesBySecret { secret } secretRuleAgentsBySecret { secret } secretUsesBySecret { id } secretChangesBySecret { id } } }';
 const read=async(retained=schema)=>{const result=await graphql({schema:retained,source:query});expect(result.errors).toBeUndefined();return result.data!;};
 const visible=await read();for(const rows of Object.values(visible))expect(rows).toHaveLength(1);
 expect(visible.secrets).toMatchObject([{secretGrantsBySecret:[{id:'grant'}],secretRequestsBySecret:[{id:'request'}],secretRulesBySecret:[{secret:'TOKEN'}],secretRuleAgentsBySecret:[{secret:'TOKEN'}],secretUsesBySecret:[{id:'use'}],secretChangesBySecret:[{id:'change'}]}]);
 for(const rows of Object.values(await read(f.schema({kind:'member',id:'alice'}))))expect(rows).toEqual([]);
 f.db.update(members).set({role:'member'}).where(eq(members.id,'owner')).run();
 for(const rows of Object.values(await read()))expect(rows).toEqual([]);
});

it('rechecks project-only outside agent access in retained incoming and reply reads',async()=>{
 const f=fixture(),viewer={kind:'agent',id:'art'} as const;
 f.db.update(conversations).set({agent:'other'}).run();
 f.db.insert(projectAgents).values({project:'p',agent:'art'}).run();
 const schema=f.schema(viewer);
 expect(await f.read(viewer,schema)).toMatchObject({bridgeIncoming:[{id:'project'}],bridgeSends:[{id:'project'}]});
 f.db.delete(projectAgents).where(eq(projectAgents.agent,'art')).run();
 expect(await f.read(viewer,schema)).toMatchObject({bridgeIncoming:[],bridgeSends:[]});
});

it('does not scan application data until a real activity selection succeeds',async()=>{
 const statements:string[]=[],client=new Database(':memory:',{verbose:sql=>statements.push(sql)});opened.push(client);
 const db=dataDatabase(client),clock=new FakeClock(),root=nextData(db,clock,()=>true);
 expect(statements).toEqual([]);root.changed();expect(statements).toEqual([]);
 await root.close();clock.advance(86400_000);expect(statements).toEqual([]);
});
