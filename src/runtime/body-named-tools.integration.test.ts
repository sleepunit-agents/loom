/** A body's named tools against a started loom: the body's own tools server, its real generic tools, the
 * body's own credential, and loom's real doors. No harness: an MCP client stands where the model would. */
import {afterEach,expect,it,vi} from 'vitest';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {ProjectsStore} from '../backends/projects.js';
import {PeopleStore} from '../backends/people.js';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {eq} from 'drizzle-orm';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Database from 'better-sqlite3';
import {bodyFixture,bodyCredentials,credentialHash} from '../../test/fixtures/conversation-body.js';
import * as schema from '../core/data/schema.js';
import {prepareSharedMemorySources} from '../shared-memory.js';
import {bodyProgramTools} from './body-program-tools.js';
import {bodySecretTools} from './body-secret-tools.js';
import {bodyNamedToolNames} from './body-named-tools.js';

vi.mock('../backends/fastembed.js',()=>({FastEmbedProvider:class{readonly dimensions=4;async embed(){return [1,0,0,0];}async embedBatch(texts:string[]){return texts.map(()=>[1,0,0,0]);}}}));
const clean:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
/** The most the named tools' definitions may add to a body's tool list, in bytes of JSON. A tool or a
 * description that takes the list past this is a decision about how lean a body's start is, not a slip. */
const NAMED_TOOLS_BYTES=20_000;
const ORIGIN='https://loom.invalid',GENERIC=['loom_commands','loom_command','loom_query'],SECRET=['request_secret','use_secret'];
type Sent={path:string;bearer:string|null;input:unknown;answer:{ok?:boolean;code?:string;message?:string;errors?:{message:string}[];data?:unknown}};
type Called={error:boolean;text:string;sent:Sent[]};

async function body(options:{agent?:string;wakeToolProfiles?:NonNullable<Parameters<typeof bodyFixture>[1]>['wakeToolProfiles'];seed?:(other:{directory:string;memories:string})=>void}={agent:'art'}){
 const home=mkdtempSync(join(tmpdir(),'loom-body-named-fiction-'));clean.push(()=>rmSync(home,{recursive:true,force:true}));
 const commons=join(home,'commons'),directory=join(home,'agents','art');
 const other=join(home,'agents','mark');
 const memory={checkingAgent:'art',sources:{commons:{directory:commons,knowledge:join(commons,'knowledge.db'),people:join(commons,'people.db')},agents:[{agent:'art',directory,memories:join(directory,'memories.db')},{agent:'mark',directory:other,memories:join(other,'memories.db')}]}};
 await prepareSharedMemorySources(memory);options.seed?.(memory.sources.agents[1]);
 const fixture=await bodyFixture(clean,{memory,wakeToolProfiles:options.wakeToolProfiles}),sent:Sent[]=[];
 // Every request the body's tools make, with what loom answered.
 const fetcher:typeof fetch=async(url,init)=>{
  const response=await fixture.root.http.request(new Request(url,init)),payload=JSON.parse(String(init?.body));
  sent.push({path:new URL(String(url)).pathname,bearer:new Headers(init?.headers).get('authorization'),input:payload.input??payload,answer:await response.clone().json()});
  return response;
 };
 const abort=new AbortController(),access={url:ORIGIN,token:bodyCredentials.body,signal:abort.signal,clock:fixture.clock,fetch:fetcher};
 const generic=bodyProgramTools({...access,onStop:()=>{},onStatus:()=>{}});clean.push(()=>generic.close());
 const tools=await bodySecretTools({...access,job:'job',conversation:fixture.thread.conversation,extraTools:generic.extensions,agent:options.agent});clean.push(()=>tools.close());
 const endpoint=JSON.parse(tools.config.toString()).mcpServers.loom,model=new Client({name:'fictional-model',version:'1'});
 await model.connect(new StreamableHTTPClientTransport(new URL(endpoint.url),{requestInit:{headers:endpoint.headers}}));clean.push(()=>model.close());
 const call=async(name:string,args:Record<string,unknown>={}):Promise<Called>=>{
  const from=sent.length,result=await model.callTool({name,arguments:args});
  return {error:result.isError===true,text:(result.content as {text:string}[]).map(part=>part.text).join('\n'),sent:sent.slice(from)};
 };
 /** What a terminal session of the same agent is offered, through loom's own /mcp door. */
 const terminal=async()=>{
  const client=new Client({name:'fictional-terminal',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp',ORIGIN),{fetch:async(url,init)=>fixture.root.http.request(new Request(url,init)),requestInit:{headers:{authorization:'Bearer '+bodyCredentials.agent}}}));
  try{return (await client.listTools()).tools;}finally{await client.close();}
 };
 return {fixture,tools,model,call,terminal,sent,home};
}

it('serves a body the named tools a terminal session of its agent is offered, under the same names',async()=>{
 const b=await body(),offered=(await b.model.listTools()).tools,terminal=await b.terminal();
 const named=terminal.filter(tool=>!GENERIC.includes(tool.name));
 expect(named.map(tool=>tool.name)).toEqual([...bodyNamedToolNames()]);
 expect(offered.map(tool=>tool.name)).toEqual([...SECRET,...GENERIC,...bodyNamedToolNames()]);
 // The same definition: every word of each description and every field of each input.
 const shape=(tool:typeof offered[number])=>({name:tool.name,description:tool.description,inputSchema:tool.inputSchema});
 expect(offered.filter(tool=>bodyNamedToolNames().includes(tool.name)).map(shape)).toEqual(named.map(shape));
 // What the harness is told it may call: in Claude Code, the very strings a terminal session sees.
 expect(b.tools.allowedTools).toEqual([...SECRET,...GENERIC,...bodyNamedToolNames()].map(name=>'mcp__loom__'+name));
 expect(b.sent).toEqual([]);
});

/** A named call is answered as loom's door answered the generic tool under it: refused with the door's
 * own words where the door refused, and not otherwise. Everything it sent went to the doors the generic
 * tools use, with the body's credential. */
function asTheDoorAnswered(name:string,called:Called){
 expect(called.sent.length,name).toBeGreaterThan(0);
 for(const sent of called.sent){
  expect(sent.bearer,name).toBe('Bearer '+bodyCredentials.body);
  expect(sent.path,name).toMatch(/^\/graphql$|^\/api\/(?:runtime\/commandCatalog|memory\/[A-Za-z]+|mind\/[A-Za-z]+|tasks\/command|machine\/read|household\/propose)$/);
 }
 // A command goes out only after the catalogue was asked about it, as the generic tool does.
 called.sent.forEach((sent,index)=>{if(sent.path.startsWith('/api/')&&sent.path!=='/api/runtime/commandCatalog')expect(called.sent[index-1]?.path,name).toBe('/api/runtime/commandCatalog');});
 const refusal=called.sent.find(sent=>sent.path!=='/graphql'&&sent.answer.ok!==true),unread=called.sent.find(sent=>sent.path==='/graphql'&&(sent.answer.errors?.length||!sent.answer.data));
 if(refusal)expect(called,name).toMatchObject({error:true,text:refusal.answer.message+' ('+refusal.answer.code+')'});
 else if(unread)expect(called.error,name).toBe(true);
 else expect(called.error,name+': '+called.text).toBe(false);
}

it('lets a body call every named tool it is offered, each answered as the door answers its generic tool',async()=>{
 const b=await body(),called=new Set<string>(),refused:string[]=[];
 // A proposal needs a household owner to wait for. The body still works for alice, who is not one.
 b.fixture.root.writes.run(()=>b.fixture.db.update(schema.members).set({role:'owner'}).where(eq(schema.members.id,'bob')).run());
 const use=async(name:string,args:Record<string,unknown>={})=>{const result=await b.call(name,args);called.add(name);asTheDoorAnswered(name,result);if(result.error)refused.push(name);return result.text;};
 // The body in this fixture is handed no identity; the tool still answers for its own agent and no other.
 expect(await use('identity')).toContain('Agent: art');
 const roles=join(b.home,'agents','art','roles');mkdirSync(roles,{recursive:true});
 writeFileSync(join(roles,'review.md'),['```loom-contract','{"inputs":[],"outputs":[]}','```','Review the plan.'].join('\n'));
 expect(JSON.parse(await use('dossier',{role:'review',format:'json'}))).toEqual({role:'review',brief:'Review the plan.',contract:{inputs:[],outputs:[]}});
 expect(await use('machine_read',{machine:'fictional',read:'memory',args:{}})).toContain('Machine read refused');
 const memory=/\((art:[a-f0-9-]{36})\)/.exec(await use('remember',{category:'reference',title:'Fictional pump lesson',content:'FICTIONAL_PUMP_WORDS'}))![1];
 expect(await use('recall',{query:'pump'})).toContain('FICTIONAL_PUMP_WORDS');
 await use('update',{id:memory,content:'FICTIONAL_PUMP_REVISED'});
 const version=Number(/## Version (\d+)/.exec(await use('memory_history',{id:memory}))![1]);
 await use('memory_restore',{id:memory,revision:version});await use('memory_archive',{id:memory});await use('memory_restore',{id:memory});await use('forget',{id:memory});
 const draft=/\((art:proposal:[a-f0-9-]{36})\)/.exec(await use('memory_propose',{category:'reference',title:'Fictional draft',content:'FICTIONAL DRAFT'}))![1];
 expect(await use('memory_drafts')).toContain('FICTIONAL DRAFT');await use('memory_ratify',{id:draft});
 await use('note_write',{path:'work/pump',body:'FICTIONAL NOTE',lifespan:'keep'});expect(await use('note_read',{path:'work/pump'})).toContain('FICTIONAL NOTE');expect(await use('note_list')).toContain('work/pump');
 await use('knowledge_write',{title:'Fictional pump page',domain:'fictional',body:'FICTIONAL PAGE'});
 await use('knowledge_write',{mode:'append',slug:'fictional-pump-page',body:'EXTRA FINDING'});
 expect(await use('knowledge_recall',{query:'pump'})).toContain('FICTIONAL PAGE\n\nEXTRA FINDING');
 await use('knowledge_edit',{slug:'fictional-pump-page',body:'FICTIONAL PAGE REVISED'});
 const kept=Number(/^- (\d+) \(/m.exec((await use('knowledge_read',{slug:'fictional-pump-page'})).split('## Earlier versions')[1])![1]);
 await use('knowledge_check',{slug:'fictional-pump-page',outcome:'still-true'});await use('knowledge_restore',{slug:'fictional-pump-page',revision:kept});
 await use('person_write',{slug:'fictional-bob',name:'Fictional Bob'});expect(await use('person')).toContain('fictional-bob');
 await use('project_write',{slug:'fictional-pond',name:'Fictional pond'});expect(await use('project')).toContain('fictional-pond');
 const task=/^Filed (t-\d+)/.exec(await use('task_create',{title:'Fictional task',goal:'A goal',why:'A reason',project:'pond'}))![1];
 expect(await use('task_ready')).toContain(task);expect(await use('task',{id:task})).toContain('Fictional task');
 await use('task_edit',{id:task,priority:1});await use('task_claim',{id:task});await use('task_comment',{id:task,text:'FICTIONAL COMMENT'});
 await use('task_move_to_project',{ids:[task],project:null});await use('task_close',{id:task,reason:'done'});
 expect(await use('propose',{change:'settings',input:{commsDays:7},why:'FICTIONAL_REASON'})).toMatch(/^Filed approval /);
 // The card is filed for a household owner. This body works for alice, who is not one and may not read it,
 // so the named read shows the body what its generic read shows it: nothing.
 expect(b.fixture.db.select().from(schema.approvals).all()).toHaveLength(1);
 expect(JSON.parse((await b.call('loom_query',{query:'{approvals{id}}'})).text)).toEqual({data:{approvals:[]}});
 expect(await use('approvals')).toBe('No approvals.');await use('inbox');await use('episodes');
 expect([...called].sort()).toEqual([...bodyNamedToolNames()].sort());
 // In this household nothing above is refused to this body. Where a door does refuse, see the next test.
 expect(refused).toEqual([]);
});

it('files a colleague proposal through the named tool and leaves the decision with the owner',async()=>{
 const b=await body();
 b.fixture.root.writes.run(()=>b.fixture.db.update(schema.members).set({role:'owner'}).where(eq(schema.members.id,'bob')).run());
 const proposal={agent:'art',platform:'slack',workspace:'TWORK',user:'UROBIN',tier:2,project:'pond'};
 const reply=await b.call('propose',{change:'colleague',input:proposal,why:'Review field support access.'});
 expect(reply.text).toMatch(/^Filed approval /);
 const card=b.fixture.db.select().from(schema.approvals).get()!;
 expect(card.state).toBe('pending');
 expect(JSON.parse(card.details)).toMatchObject({change:'colleague',after:proposal});
 expect(b.fixture.db.select().from(schema.agentPeople).where(eq(schema.agentPeople.person,JSON.stringify(['slack','TWORK','UROBIN']))).all()).toEqual([]);
 expect(b.fixture.db.select().from(schema.projectOutsidePeople).where(eq(schema.projectOutsidePeople.user,'UROBIN')).all()).toEqual([]);
});

it('refuses a named tool exactly where the body\'s generic tool is refused, in the same words',async()=>{
 const b=await body();
 // A task in a project neither the body's agent nor the member it works for is on.
 b.fixture.root.writes.run(()=>b.fixture.db.insert(schema.tasks).values({id:'t-900',title:'Fictional other',project:'other',ownerKind:'agent',owner:'mark',goal:'g',why:'w',createdByKind:'member',createdBy:'bob',createdAt:new Date(b.fixture.clock.now()).toISOString(),changedAt:new Date(b.fixture.clock.now()).toISOString()}).run());
 const generic=async(operation:string,input:unknown)=>JSON.parse((await b.call('loom_command',{operation,input,id:crypto.randomUUID()})).text) as {ok:boolean;code:string;message:string};
 const pairs:[string,Record<string,unknown>,string,unknown][]=[
  ['task_comment',{id:'t-900',text:'words'},'tasks.command',{action:'comment',id:'t-900',text:'words'}],
  ['task_claim',{id:'t-900'},'tasks.command',{action:'claim',id:'t-900'}],
  ['task_close',{id:'t-900',reason:'done'},'tasks.command',{action:'close',id:'t-900',reason:'done'}],
  ['task_create',{title:'Fictional',goal:'g',why:'w',project:'other'},'tasks.command',{action:'create',input:{title:'Fictional',goal:'g',why:'w',project:'other',owner:{kind:'agent',id:'art'}}}],
  ['forget',{id:'mark:00000000-0000-4000-8000-000000000000'},'memory.forget',{id:'mark:00000000-0000-4000-8000-000000000000'}],
  ['knowledge_edit',{slug:'no-such-page',body:'words'},'mind.knowledgeEdit',{slug:'no-such-page',body:'words'}],
  ['propose',{change:'settings',input:{commsDays:99999},why:'x'},'household.propose',{change:'settings',input:{commsDays:99999},why:'x'}],
 ];
 for(const [name,args,operation,input] of pairs){
  const named=await b.call(name,args),door=await generic(operation,input);
  expect(door.ok,name).toBe(false);
  expect(named,name).toMatchObject({error:true,text:door.message+' ('+door.code+')'});
  asTheDoorAnswered(name,named);
 }
 // A read the door narrows shows the named tool no more than the generic read does.
 const seen=JSON.parse((await b.call('loom_query',{query:'{tasks(where:{id:{eq:"t-900"}}){id}}'})).text) as {data:{tasks:unknown[]}};
 expect(seen.data.tasks).toEqual([]);expect((await b.call('task',{id:'t-900'})).text).toBe('No task t-900 that you may see.');
 expect(b.fixture.db.select().from(schema.tasks).where(eq(schema.tasks.id,'t-900')).get()).toMatchObject({status:'open',assignee:null});
 // What the body's generic tool refuses before any door, a named tool cannot reach either: there is no named tool for it.
 expect((await b.call('loom_command',{operation:'conversation.accept',input:{},id:crypto.randomUUID()})).error).toBe(true);
});

it('serves no named tool to a body built without its agent\'s name',async()=>{
 const b=await body({});
 expect((await b.model.listTools()).tools.map(tool=>tool.name)).toEqual([...SECRET,...GENERIC]);
 expect(b.tools.allowedTools).toEqual([...SECRET,...GENERIC].map(name=>'mcp__loom__'+name));
 const absent=await b.model.callTool({name:'remember',arguments:{category:'reference',title:'t',content:'c'}}).catch(()=>undefined);
 expect(absent===undefined||absent.isError===true).toBe(true);expect(b.sent).toEqual([]);
});

it('adds to a body\'s start only the tools\' own definitions, within a stated size',async()=>{
 const b=await body(),offered=(await b.model.listTools()).tools;
 const size=(tools:typeof offered)=>Buffer.byteLength(JSON.stringify(tools.map(tool=>({name:tool.name,description:tool.description,input_schema:tool.inputSchema}))));
 const named=size(offered.filter(tool=>bodyNamedToolNames().includes(tool.name))),before=size(offered.filter(tool=>!bodyNamedToolNames().includes(tool.name)));
 // Measured 2026-11-17: the named tools 18,766 bytes, the five a body had 3,714. No harness was run to count
 // tokens; at 3.5 to 4 bytes a token for this kind of JSON that is about 4,700 to 5,400 tokens more.
 expect(named).toBeLessThanOrEqual(NAMED_TOOLS_BYTES);expect(named).toBeGreaterThan(before);
});

it('gives a body told another agent\'s name nothing of that agent\'s: the door answers for the credential',async()=>{
 // The body's program is told it is mark. Its credential is art's. The member it works for has both agents.
 const b=await body({agent:'mark',seed:other=>{
  mkdirSync(join(other.directory,'roles'),{recursive:true});writeFileSync(join(other.directory,'roles','review.md'),'MARK_SECRET_ROLE');
  writeFileSync(join(other.directory,'IDENTITY.md'),'MARK_SECRET_CREED');
  const projects=new ProjectsStore({dbPath:other.memories});projects.write({slug:'fictional-mark-shed',name:'MARK_SECRET_PROJECT'});projects.close();
  const people=new PeopleStore({dbPath:other.memories});people.write({slug:'fictional-mark-friend',name:'MARK_SECRET_PERSON'});people.close();
 }});
 b.fixture.root.writes.run(()=>b.fixture.db.insert(schema.memberAgents).values({member:'alice',agent:'mark'}).run());
 const id='mark:00000000-0000-4000-8000-000000000000';
 const every:Record<string,Record<string,unknown>[]>={
  // The tools that use the agent's name: in a read's variables, in a card's id, to pick their own rows, or as a task's owner.
  identity:[{},{piece:'creed'},{piece:'all'}],dossier:[{role:'review',format:'json'}],note_read:[{path:'work/pump'}],note_list:[{}],memory_drafts:[{}],
  person:[{},{slug:'fictional-mark-friend'}],project:[{},{slug:'fictional-mark-shed'}],task_create:[{title:'Fictional',goal:'g',why:'w'}],
  // The rest never send the name: loom takes the agent from the credential.
  remember:[{category:'reference',title:'Fictional told-mark memory',content:'words'}],recall:[{query:'secret creed project person'}],update:[{id,content:'x'}],forget:[{id}],episodes:[{}],
  knowledge_recall:[{query:'secret'}],knowledge_write:[{title:'Fictional page',domain:'fictional',body:'words'}],knowledge_read:[{slug:'fictional-page'}],knowledge_edit:[{slug:'fictional-page',body:'more'}],
  knowledge_check:[{slug:'fictional-page',outcome:'still-true'}],knowledge_restore:[{slug:'fictional-page',revision:1}],note_write:[{path:'work/told',body:'words',lifespan:'keep'}],
  person_write:[{slug:'fictional-told',name:'Fictional told'}],project_write:[{slug:'fictional-told',name:'Fictional told'}],
  memory_propose:[{category:'reference',title:'Fictional draft',content:'words'}],memory_ratify:[{id:'mark:proposal:00000000-0000-4000-8000-000000000000'}],memory_archive:[{id}],memory_restore:[{id}],memory_history:[{id}],
  task_ready:[{}],task:[{id:'t-1'}],task_edit:[{id:'t-1',priority:1}],task_move_to_project:[{ids:['t-1'],project:null}],task_claim:[{id:'t-1'}],task_close:[{id:'t-1',reason:'done'}],task_comment:[{id:'t-1',text:'words'}],
  machine_read:[{machine:'fictional',read:'memory',args:{}}],
  propose:[{change:'settings',input:{commsDays:7},why:'Fictional'}],approvals:[{}],inbox:[{}],
 };
 expect(Object.keys(every).sort()).toEqual([...bodyNamedToolNames()].sort());
 const answers:Record<string,Called[]>={};
 for(const [name,calls] of Object.entries(every)){
  answers[name]=[];
  for(const args of calls){
   const called=await b.call(name,args);answers[name].push(called);
   // Not in what the model is shown, and not in anything loom sent back for it.
   expect(JSON.stringify([called.text,called.sent.map(sent=>sent.answer)]),name).not.toContain('MARK_SECRET');
  }
 }
 const said=(name:string)=>answers[name].map(called=>[called.error,called.text]);
 // Where the name matters: refused, or told there is nothing. Never mark's.
 expect(said('identity')).toEqual([[true,'Identity unavailable'],[true,'Identity unavailable'],[true,'Identity unavailable']]);
 expect(said('note_list')).toEqual([[true,'Notes are not readable with this credential']]);
 expect(said('note_read')).toEqual([[false,'No note at work/pump']]);
 expect(said('memory_drafts')).toEqual([[false,'No drafts.']]);
 expect(said('person')).toEqual([[false,'No person cards.'],[false,'No person card for fictional-mark-friend']]);
 expect(said('project')).toEqual([[false,'No project cards.'],[false,'No project card for fictional-mark-shed']]);
 expect(said('task_create')).toEqual([[true,'Permission denied (denied)']]);
 // The lists are empty because loom showed this credential no card of mark's, not because the tool hid one.
 expect(JSON.parse((await b.call('loom_query',{query:'{memoryPeople{slug agent} memoryProjects{slug agent}}'})).text).data).toEqual({memoryPeople:[{slug:'fictional-told',agent:'art'}],memoryProjects:[{slug:'fictional-told',agent:'art'}]});
 // Where it does not: the tool acted as art, whatever the body was told.
 expect(said('remember')[0][1]).toMatch(/^Remembered "Fictional told-mark memory" \(art:[a-f0-9-]{36}\)$/);
 expect(said('memory_propose')[0][1]).toMatch(/\(art:proposal:/);
 for(const name of ['update','forget','memory_archive','memory_restore','memory_ratify'])expect(answers[name][0].error,name).toBe(true);
 expect(readFileSync(join(b.home,'agents','mark','IDENTITY.md'),'utf8')).toBe('MARK_SECRET_CREED');
 const marks=new ProjectsStore({dbPath:join(b.home,'agents','mark','memories.db')});try{expect(marks.rows(false)).toHaveLength(1);expect(JSON.stringify(marks.read('fictional-mark-shed'))).toContain('MARK_SECRET_PROJECT');}finally{marks.close();}
});

it('identifies the scheduled instant and job of one accepted journal delivery', async () => {
 const b = await body(), {db,root,clock} = b.fixture;
 const due = new Date(clock.now()+1000).toISOString();
 const t = root.services.tempo.triggers.set({ownerKind:'agent', owner:'art', project:'pond',sourceKind:'time',times:due,
   lifespan:'until-stopped', targetKind:'inbox',toKind:'agent',to:'art',note:'Verify',instructions:'Verify'});
 clock.advance(1000);
 const item = db.select().from(schema.inbox).where(eq(schema.inbox.sourceId,t.id+':time:'+due)).get()!;
 db.update(schema.jobs).set({conversation:item.conversation,member:null}).where(eq(schema.jobs.id,'job')).run();
 db.update(schema.inbox).set({state:'taken',job:'job',takenVolume:'full'}).where(eq(schema.inbox.id,item.id)).run();
 const read = (id:string) => b.call('loom_command',{operation:'tempo.readJournal',input:{item:id},id:'read-'+id});
 expect((await read(item.id)).text).toContain('denied');
 expect((await b.fixture.call('accept',{items:[item.id]},'accept-time')).status).toBe(200);
 expect(JSON.parse((await read(item.id)).text).value.firing).toEqual({job:'job',item:item.id,scheduledAt:due});
 expect((await read('another-delivery')).text).toContain('denied');
});

it.each(['matched','no configuration','other trigger','other agent'] as const)('checks a clock batch against its profile (%s)', async mode => {
 const trigger = 'tr-clock';
 const b = await body({wakeToolProfiles:mode === 'no configuration' ? [] : [{
   agent:mode === 'other agent' ? 'mark' : 'art', trigger:mode === 'other trigger' ? 'tr-other' : trigger, omitClaudeTools:['Workflow'],
 }]});
 const {db,root,clock} = b.fixture;
 db.insert(schema.household).values({timezone:'UTC'}).onConflictDoUpdate({target:schema.household.singleton,set:{timezone:'UTC'}}).run();
 root.services.tempo.triggers.set({id:trigger,ownerKind:'agent',owner:'art',project:'pond',sourceKind:'time',times:'18:01,18:02',
   lifespan:'until-stopped',targetKind:'inbox',toKind:'agent',to:'art',note:'Test schedule',instructions:'Check'});
 const ids:string[] = [];
 const profile = async (items:string[]) => JSON.parse((await b.call('loom_command',{
   operation:'tempo.wakeToolProfile',input:{items},id:'read-profile',
 })).text).value;
 for (let minute = 1; minute <= 2; minute++) {
   clock.advance(60_000);
   const sourceId = trigger + ':time:' + new Date(clock.now()).toISOString();
   const item = db.select().from(schema.inbox).where(eq(schema.inbox.sourceId,sourceId)).get()!;
   db.update(schema.jobs).set({conversation:item.conversation,member:null}).where(eq(schema.jobs.id,'job')).run();
   db.update(schema.inbox).set({state:'taken',job:'job',takenVolume:'full'}).where(eq(schema.inbox.id,item.id)).run();
   ids.push(item.id);
   expect(await profile(ids)).toEqual([]);
   expect((await b.fixture.call('accept',{items:[item.id]},'accept-'+item.id)).status).toBe(200);
   expect(await profile(ids)).toEqual(mode === 'matched' ? ['Workflow'] : []);
 }
 expect(await profile([...ids,'unrelated'])).toEqual([]);
 expect(await profile([ids[0],ids[0]])).toEqual([]);
 db.update(schema.inbox).set({sourceId:'missing-occurrence'}).where(eq(schema.inbox.id,ids[0])).run();
 expect(await profile(ids)).toEqual([]);
});

it('recovers an interrupted verification from the journal without stamping the same page twice', async () => {
 const b=await body(), {db,root,clock}=b.fixture;
 db.insert(schema.household).values({timezone:'UTC'}).onConflictDoUpdate({target:schema.household.singleton,set:{timezone:'UTC'}}).run();
 const trigger=root.services.tempo.triggers.set({id:'verify',ownerKind:'agent',owner:'art',sourceKind:'time',times:'18:01,18:02',
   lifespan:'until-stopped',targetKind:'inbox',toKind:'agent',to:'art',project:'pond',note:'Verify pages',instructions:'Verify'});
 async function command(token:string, operation:string,input:unknown,id:string) {
   const res=await root.http.request('/api/'+operation.replace('.','/'),{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},
     body:JSON.stringify({input,id})});
   const reply=await res.json();
   expect(res.status,JSON.stringify(reply)).toBe(200);
   return reply.value;
 }
 const nextDelivery=() => {
   const at=new Date(clock.now()+60_000).toISOString();
   clock.advance(60_000);
   return db.select().from(schema.inbox).where(eq(schema.inbox.sourceId,trigger.id+':time:'+at)).get()!;
 };
 async function accept(item:typeof schema.inbox.$inferSelect, job:string, token:string) {
   db.update(schema.inbox).set({state:'taken',job,takenVolume:'full'}).where(eq(schema.inbox.id,item.id)).run();
   expect((await b.fixture.call('accept',{items:[item.id]},'accept-'+item.id,token)).status).toBe(200);
   return command(token,'tempo.readJournal',{item:item.id},'read-'+item.id);
 }
 const first=nextDelivery(), token=bodyCredentials.body;
 db.update(schema.jobs).set({conversation:first.conversation,member:null}).where(eq(schema.jobs.id,'job')).run();
 const initial=await accept(first,'job',token);
 const page=await command(token,'mind.knowledgeAdd',{title:'Fixture pump',domain:'fixture',body:'Check the pump.'},'create-page');
 const intent={id:'verify-first-pump',operation:'mind.knowledgeVerify',input:{slug:page.slugs[0]}};
 const claim={scheduledAt:initial.firing.scheduledAt,job:initial.firing.job,pending:intent};
 await command(token,'tempo.replaceJournalState',{revision:0,state:JSON.stringify(claim)},'record-intent');
 await command(token,intent.operation,intent.input,intent.id);
 // The page write committed. The first worker died before it could checkpoint the result.
 db.update(schema.jobs).set({state:'lost',endedAt:new Date(clock.now()).toISOString()}).where(eq(schema.jobs.id,'job')).run();
 const second=nextDelivery(), replacement='e'.repeat(64);
 const previous=db.select().from(schema.jobs).where(eq(schema.jobs.id,'job')).get()!;
 db.insert(schema.jobs).values({...previous,id:'replacement',state:'running',endedAt:null}).run();
 db.insert(schema.tokens).values({fingerprint:credentialHash(replacement),kind:'agent',label:'Replacement body',agent:'art',job:'replacement',createdAt:previous.queuedAt}).run();
 const recovered=await accept(second,'replacement',replacement);
 expect(recovered.firing.job).toBe('replacement');
 expect(recovered.firing.scheduledAt).not.toBe(initial.firing.scheduledAt);
 const saved=JSON.parse(recovered.state);
 expect(saved).toEqual(claim);
 const status=await command(replacement,'tempo.readJournal',{item:second.id,priorJob:saved.job},'holder-state');
 expect(status.priorJobState).toBe('lost');
 db.insert(schema.jobs).values({...previous,id:'unrelated',conversation:b.fixture.thread.conversation,member:'alice'}).run();
 expect((await command(replacement,'tempo.readJournal',{priorJob:'unrelated'},'unknown-holder')).priorJobState).toBeNull();
 const takeover=await command(replacement,'tempo.replaceJournalState',{revision:recovered.stateRevision,
   state:JSON.stringify({...saved,job:recovered.firing.job})},'take-over-original');
 const receipt=await command(replacement,saved.pending.operation,saved.pending.input,saved.pending.id);
 expect(receipt.stamped).toBe(true);
 const source=new Database(join(b.home,'commons','knowledge.db'),{readonly:true});
 try {expect(source.prepare('SELECT count(*) AS n FROM verifications').get()).toEqual({n:1});} finally {source.close();}
 const complete={lastCompleted:saved.scheduledAt,claim:null};
 await command(replacement,'tempo.replaceJournalState',{revision:takeover.revision,state:JSON.stringify(complete)},'finish-original');
 expect(JSON.parse((await command(replacement,'tempo.readJournal',{},'verify-checkpoint')).state)).toEqual(complete);
});
it('carries a journal between actual trigger deliveries and confines body commands to the accepted wake', async () => {
 const b = await body({wakeToolProfiles:[{agent:'art',trigger:'tr-journal',omitClaudeTools:['Workflow']}]}), {db,root,clock} = b.fixture;
 const engine = root.services.tempo.triggers;
 const t = engine.set({ id:'tr-journal', ownerKind:'agent', owner:'art', project:'pond', sourceKind:'answer', watches:'approval:example',
   lifespan:'until-stopped', targetKind:'inbox', toKind:'agent', to:'art', note:'Test journal', instructions:'Check both sources' });
 engine.event('answer','approval:example','first');
 const first = db.select().from(schema.inbox).where(eq(schema.inbox.sourceId,t.id+':first')).get()!;
 const cmd = (operation:string, input:Record<string,unknown>, id:string) => b.call('loom_command',{operation,input,id});
 const read = () => cmd('tempo.readJournal',{},'read');
 expect((await read()).text).toContain('denied');
 db.update(schema.jobs).set({conversation:first.conversation, member:null}).where(eq(schema.jobs.id,'job')).run();
 expect((await read()).text).toContain('denied');
 db.update(schema.inbox).set({state:'taken', job:'job', firstAcceptedAt:new Date(clock.now()).toISOString()}).where(eq(schema.inbox.id,first.id)).run();
 expect((await read()).text).toContain('denied');
 expect((await b.fixture.call('accept',{items:[first.id]},'accept-first')).status).toBe(200);
 expect((await read()).text).toContain('"stateRevision":0');
 const save = () => cmd('tempo.appendLesson',{lesson:'Count each source once.'},'lesson');
 expect((await save()).text).toContain('"saved":true');
 expect((await save()).text).toContain('"saved":true');
 expect((await cmd('tempo.replaceJournalState',{revision:0,state:'page 2'},'state')).text).toContain('"revision":1');
 expect((await cmd('tempo.replaceJournalState',{revision:0,state:'old'},'other-write')).text).toContain('changed since');
 const longInstructions = 'x'.repeat(100000);
 engine.edit(t.id,{instructions:longInstructions},{kind:'agent',id:'art'});
 engine.event('answer','approval:example','second');
 const second = db.select().from(schema.inbox).where(eq(schema.inbox.sourceId,t.id+':second')).get()!;
 expect(second.words).toBe(longInstructions);
 db.update(schema.inbox).set({job:'job'}).where(eq(schema.inbox.id,second.id)).run();
 const taken = await root.http.request('/api/conversation/take', {method:'POST', headers:{
   'content-type':'application/json', authorization:'Bearer '+bodyCredentials.body,
 }, body:JSON.stringify({input:{}})});
 expect(taken.status).toBe(200);
 const items = (await taken.json()).value.items as {id:string;words:string}[];
 expect(items.find(item=>item.id===second.id)?.words).toBe(longInstructions);
 const carry = () => cmd('tempo.wakeLessons',{items:[second.id]},'carry');
 expect(JSON.parse((await carry()).text).value).toBeNull();
 expect((await b.fixture.call('accept',{items:[second.id]},'accept-second')).status).toBe(200);
 expect(JSON.parse((await carry()).text).value).toBe('Count each source once.');
 expect(JSON.parse((await cmd('tempo.wakeToolProfile',{items:[second.id]},'event-profile')).text).value).toEqual([]);
 expect(JSON.parse((await cmd('tempo.readJournal',{item:second.id},'event-firing')).text).value.firing).toEqual({job:'job',item:second.id,scheduledAt:null});
 expect(db.select().from(schema.inbox).where(eq(schema.inbox.conversation,first.conversation!)).all()).toHaveLength(2);
 expect((await read()).text).toContain('page 2');
 const late = await root.http.request('/api/tempo/readJournal', {method:'POST', headers:{
   'content-type':'application/json', authorization:'Bearer '+bodyCredentials.body,
 }, body:JSON.stringify({input:{}})});
 expect(late.status).toBe(200);
 root.writes.run(() => db.update(schema.jobs).set({state:'done'}).where(eq(schema.jobs.id,'job')).run());
 await expect(late.text()).rejects.toThrow('Data access ended');
 expect((await save()).text).toMatch(/denied|refused|unavailable/i);
});
