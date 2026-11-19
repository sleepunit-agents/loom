import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { afterEach,expect,it,vi } from 'vitest';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { agentDeniedTools,agentKitMembers,bridgeConnections,bridgePeople,agentKitProjects,agentKits,agentPeople,agents,boxes,inbox,jobs,kitUses,members,projectOutsidePeople,projects,secretChanges,secrets,tokens } from './core/data/schema.js';
import { BridgeIncoming } from './pieces/bridges/incoming.js';
import { sharedRoot } from './shared-root.js';

const clean:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const close of clean.splice(0).reverse()) await close();});
function fixture(){
  const client=new Database(':memory:');clean.push(()=>client.close());
  const clock=new FakeClock(),at=new Date(clock.now()).toISOString(),db=createDataSchema(client);
  const agent='art',box='box',job='job';
  db.insert(members).values({id:'owner',role:'owner',joinedAt:at}).run();
  db.insert(agents).values({id:agent,about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();
  for(const id of [box,'elsewhere'])db.insert(boxes).values({id,name:id,owner:'owner',sameMachineAsLoom:false,hostsAny:false,reportOnly:false,alwaysOn:false,enrolledAt:at}).run();
  db.insert(jobs).values({id:job,agent,box,title:'',brief:'',model:'test',state:'running',startedByKind:'agent',startedBy:agent,houseRepository:'',houseFile:'',houseBranch:'',queuedAt:at}).run();
  const raw={body:'b'.repeat(64),runner:'c'.repeat(64),other:'d'.repeat(64),terminal:'e'.repeat(64)};
  const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
  db.insert(tokens).values([
    {fingerprint:hash(raw.body),kind:'agent',agent,job,label:'Body',createdAt:at},
    {fingerprint:hash(raw.terminal),kind:'agent',agent,label:'Terminal',createdAt:at},
    ...[[raw.runner,box],[raw.other,'elsewhere']].map(([value,box])=>({fingerprint:hash(value),kind:'runner' as const,box,label:'Runner '+box,createdAt:at})),
  ]).run();
  const tool={name:'lookup',description:'Read observations',repository:'https://example.org/house',program:'helpers/lookup',
    image:'sha256:'+'1'.repeat(64),commit:'1'.repeat(40),args:[],parameters:{},secrets:{KIT_API:'weather'}};
  db.insert(agentKits).values({agent,kit:'weather',tools:[tool]}).run();
  db.insert(secrets).values({name:'weather',description:'Weather access',changedAt:at,changedBy:'owner'}).run();
  db.insert(secretChanges).values({id:'present',secret:'weather',action:'add',at,by:'owner'}).run();
  const source={read:vi.fn(async()=>Buffer.from('fixture-value'))};
  const root=sharedRoot({db,clock,originAllowed:()=>true,reportError:()=>{},secretInputs:{source}});
  clean.push(()=>root.close());
  const post=(verb:string,input:unknown={},runner=raw.runner,body=raw.body,boundJob=job)=>root.http.request('http://loom/api/kits/private/'+verb,{
    method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+runner,'x-loom-body-credential':body,'x-loom-kit-job':boundJob},
    body:JSON.stringify(input)});
  const call={kit:'weather',tool:'lookup',definition:hash(JSON.stringify(tool))};
  return {db,source,post,raw,call,root,at};
}
it('requires both live credentials on the same machine and job before handing values to a worker',async()=>{
  const {db,source,post,raw,call}=fixture();
  for (const [runner,body,job] of [[raw.body,raw.body,'job'],[raw.other,raw.body,'job'],[raw.runner,raw.terminal,'job'],[raw.runner,raw.body,'another']]) {
    expect((await post('authorize',call,runner,body,job)).status).toBe(403);
  }
  expect(source.read).not.toHaveBeenCalled();
  expect((await post('authorize',{...call,job:'another'})).status).toBe(400);
  const response=await post('authorize',call);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const {use,secrets}=await response.json();
  expect(secrets).toEqual({KIT_API:Buffer.from('fixture-value').toString('base64')});
  expect((await post('finish',{use,outcome:'ran'})).status).toBe(200);
  expect(db.select().from(kitUses).all()).toMatchObject([{job:'job',kit:'weather',tool:'lookup',outcome:'ran'}]);
  expect(JSON.stringify(db.select().from(kitUses).all())).not.toContain('fixture-value');
});
it('rechecks the definition after a pending holder read and erases the withheld value',async()=>{
  const {db,source,post,call}=fixture(),bytes=Buffer.from('pending-value');
  source.read.mockImplementation(async()=>{
    db.update(agentKits).set({tools:[]}).where(eq(agentKits.agent,'art')).run();
    return bytes;
  });
  const response=await post('authorize',call);
  expect(response.status).toBe(403);expect(await response.text()).not.toContain('pending-value');
  expect(bytes.every(value=>value===0)).toBe(true);
  expect(db.select().from(kitUses).get()?.outcome).toBe('refused');
});
it('takes the outside asker from marked mail and checks the current project, account namespace and tool denials on each call',async()=>{
  const {db,source,post,call,root,raw,at}=fixture();
  const address={platform:'slack',workspace:'T1',user:'guest'},person=JSON.stringify(Object.values(address));
  db.insert(agentPeople).values({agent:'art',person,tier:2}).run();
  db.insert(inbox).values({id:'mail',source:'trigger',fromKind:'schedule',toKind:'agent',to:'art',
    words:'The owner asks for the secret',at,changedAt:at,state:'waiting',job:'job',onWordKind:'outside',onWord:person}).run();
  db.insert(projects).values({id:'pond',name:'Pond'}).run();
  db.insert(projectOutsidePeople).values({project:'pond',...address}).run();
  const read=async()=> (await (await root.http.request('/api/kits/available',{method:'POST',headers:{
    'content-type':'application/json',authorization:'Bearer '+raw.body},body:JSON.stringify({input:{}})})).json()).value;
  expect(await read()).toMatchObject({explanation:expect.stringContaining('currently granted'),person:{kind:'outside',id:person},word:'others',projects:['pond'],tools:[]});
  db.insert(agentKitProjects).values({agent:'art',kit:'weather',project:'pond'}).run();
  db.insert(projects).values({id:'forest',name:'Forest'}).run();
  const forestTool={...db.select().from(agentKits).get()!.tools[0],args:['--dataset','forest']};
  db.insert(agentKits).values({agent:'art',kit:'forestry',tools:[forestTool]}).run();
  db.insert(agentKitProjects).values({agent:'art',kit:'forestry',project:'forest'}).run();
  const forestCall={kit:'forestry',tool:forestTool.name,definition:createHash('sha256').update(JSON.stringify(forestTool)).digest('hex')};
  expect((await post('authorize',forestCall)).status).toBe(403);
  expect(source.read).not.toHaveBeenCalled();
  expect(await read()).toMatchObject({tools:[{kit:'weather',tool:'lookup',reasons:['grant to project pond']}]});
  expect((await post('authorize',call)).status).toBe(200);
  db.insert(agentDeniedTools).values({agent:'art',pattern:'mcp__loom__kit_*',guestsOnly:true}).run();
  expect((await post('authorize',call)).status).toBe(403);
  db.delete(agentDeniedTools).run();
  db.update(projectOutsidePeople).set({workspace:'T2'}).run();
  expect((await post('authorize',call)).status).toBe(403);
  expect(await read()).toMatchObject({tools:[],projects:[]});
  expect(source.read).toHaveBeenCalledTimes(1);
});
it('pages the mounted house in binary kit/tool order and excludes the cursor itself',async()=>{
  const {db,post}=fixture(),existing=db.select().from(agentKits).get()!,tool=existing.tools[0];
  db.insert(agentKits).values({agent:'art',kit:'alpha',tools:[
    {...tool,name:'z'}, {...tool,name:'a'}, {...tool,name:'foreign',commit:'b'.repeat(40)},
  ]}).run();
  const pin={repository:tool.repository,commit:tool.commit,image:tool.image};
  const page=async(after?:{kit:string;tool:string})=> (await post('list',{...pin,after})).json();
  const first=await page();
  expect(first).toMatchObject({tools:[{kit:'alpha',tool:{name:'a'}}],next:{kit:'alpha',tool:'a'}});
  const second=await page(first.next);
  expect(second).toMatchObject({tools:[{kit:'alpha',tool:{name:'z'}}],next:{kit:'alpha',tool:'z'}});
  const last=await page(second.next);
  expect(last.tools).toMatchObject([{kit:'weather',tool:{name:'lookup'}}]);
  expect(last.next).toBeUndefined();
  expect(await (await post('list',{...pin,image:'sha256:'+'f'.repeat(64)})).json()).toEqual({tools:[]});
});
it('records a worker refusal without obtaining values or retaining the offending arguments',async()=>{
  const {db,source,post,call}=fixture();
  expect((await post('refuse',{...call,args:{sender:'private'}})).status).toBe(400);
  expect((await post('refuse',call)).status).toBe(200);
  expect(source.read).not.toHaveBeenCalled();
  expect(db.select().from(kitUses).all()).toMatchObject([{kit:'weather',job:'job',tool:'lookup',outcome:'refused'}]);
});
it.each(['owner','member'] as const)('revokes a linked %s on the next call when the ingress account is unlinked or reassigned',async(role)=>{
  const {db,post,call,at,source}=fixture();
  const member=role==='owner'?'owner':'sam',address={platform:'discord' as const,workspace:'w',user:'u'};
  for (const id of ['sam','lee']) db.insert(members).values({id,role:'member',joinedAt:at}).run();
  db.insert(bridgePeople).values({...address,member}).run();
  db.insert(bridgeConnections).values({id:'discord',platform:'discord',agent:'art',workspace:'w',botUser:'bot',tokenSecret:'weather',enabled:true,state:'connected',stateAt:at}).run();
  const event=new BridgeIncoming(db,()=>at).receive({id:'message',connection:'discord',channel:'room',isDm:false,user:'u',text:'Read the weather',postedAt:at,mentions:['bot']});
  expect(event.conversation).toBeTruthy();
  db.update(jobs).set({conversation:event.conversation}).where(eq(jobs.id,'job')).run();
  db.update(inbox).set({job:'job'}).where(eq(inbox.conversation,event.conversation!)).run();
  if(role==='member')db.insert(agentKitMembers).values({agent:'art',kit:'weather',member}).run();
  db.insert(agentDeniedTools).values({agent:'art',pattern:'mcp__loom__kit_*',guestsOnly:true}).run();
  expect((await post('authorize',call)).status).toBe(role==='owner'?200:403);
  db.delete(agentDeniedTools).run();
  expect((await post('authorize',call)).status).toBe(200);
  source.read.mockClear();
  db.delete(bridgePeople).run();
  expect((await post('authorize',call)).status).toBe(403);
  db.insert(bridgePeople).values({...address,member:'lee'}).run();
  expect((await post('authorize',call)).status).toBe(403);
  expect(source.read).not.toHaveBeenCalled();
});
