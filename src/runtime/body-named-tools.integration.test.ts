/** A body's named tools against a started loom: the body's own tools server, its real generic tools, the
 * body's own credential, and loom's real doors. No harness: an MCP client stands where the model would. */
import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {ProjectsStore} from '../backends/projects.js';
import {PeopleStore} from '../backends/people.js';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {eq} from 'drizzle-orm';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {bodyFixture,bodyCredentials} from '../../test/fixtures/conversation-body.js';
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

async function body(options:{agent?:string;seed?:(other:{directory:string;memories:string})=>void}={agent:'art'}){
 const home=mkdtempSync(join(tmpdir(),'loom-body-named-fiction-'));clean.push(()=>rmSync(home,{recursive:true,force:true}));
 const commons=join(home,'commons'),directory=join(home,'agents','art');
 const other=join(home,'agents','mark');
 const memory={checkingAgent:'art',sources:{commons:{directory:commons,knowledge:join(commons,'knowledge.db'),people:join(commons,'people.db')},agents:[{agent:'art',directory,memories:join(directory,'memories.db')},{agent:'mark',directory:other,memories:join(other,'memories.db')}]}};
 await prepareSharedMemorySources(memory);options.seed?.(memory.sources.agents[1]);
 const fixture=await bodyFixture(clean,{memory}),sent:Sent[]=[];
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
},60_000);

/** A named call is answered as loom's door answered the generic tool under it: refused with the door's
 * own words where the door refused, and not otherwise. Everything it sent went to the doors the generic
 * tools use, with the body's credential. */
function asTheDoorAnswered(name:string,called:Called){
 expect(called.sent.length,name).toBeGreaterThan(0);
 for(const sent of called.sent){
  expect(sent.bearer,name).toBe('Bearer '+bodyCredentials.body);
  expect(sent.path,name).toMatch(/^\/graphql$|^\/api\/(?:runtime\/commandCatalog|memory\/[A-Za-z]+|mind\/[A-Za-z]+|tasks\/command|household\/propose)$/);
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
 const memory=/\((art:[a-f0-9-]{36})\)/.exec(await use('remember',{category:'reference',title:'Fictional pump lesson',content:'FICTIONAL_PUMP_WORDS'}))![1];
 expect(await use('recall',{query:'pump'})).toContain('FICTIONAL_PUMP_WORDS');
 await use('update',{id:memory,content:'FICTIONAL_PUMP_REVISED'});
 const version=Number(/## Version (\d+)/.exec(await use('memory_history',{id:memory}))![1]);
 await use('memory_restore',{id:memory,revision:version});await use('memory_archive',{id:memory});await use('memory_restore',{id:memory});await use('forget',{id:memory});
 const draft=/\((art:proposal:[a-f0-9-]{36})\)/.exec(await use('memory_propose',{category:'reference',title:'Fictional draft',content:'FICTIONAL DRAFT'}))![1];
 expect(await use('memory_drafts')).toContain('FICTIONAL DRAFT');await use('memory_ratify',{id:draft});
 await use('note_write',{path:'work/pump',body:'FICTIONAL NOTE',lifespan:'keep'});expect(await use('note_read',{path:'work/pump'})).toContain('FICTIONAL NOTE');expect(await use('note_list')).toContain('work/pump');
 await use('knowledge_write',{title:'Fictional pump page',domain:'fictional',body:'FICTIONAL PAGE'});
 expect(await use('knowledge_recall',{query:'pump'})).toContain('FICTIONAL PAGE');
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
},120_000);

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
},120_000);

it('serves no named tool to a body built without its agent\'s name',async()=>{
 const b=await body({});
 expect((await b.model.listTools()).tools.map(tool=>tool.name)).toEqual([...SECRET,...GENERIC]);
 expect(b.tools.allowedTools).toEqual([...SECRET,...GENERIC].map(name=>'mcp__loom__'+name));
 const absent=await b.model.callTool({name:'remember',arguments:{category:'reference',title:'t',content:'c'}}).catch(()=>undefined);
 expect(absent===undefined||absent.isError===true).toBe(true);expect(b.sent).toEqual([]);
},60_000);

it('adds to a body\'s start only the tools\' own definitions, within a stated size',async()=>{
 const b=await body(),offered=(await b.model.listTools()).tools;
 const size=(tools:typeof offered)=>Buffer.byteLength(JSON.stringify(tools.map(tool=>({name:tool.name,description:tool.description,input_schema:tool.inputSchema}))));
 const named=size(offered.filter(tool=>bodyNamedToolNames().includes(tool.name))),before=size(offered.filter(tool=>!bodyNamedToolNames().includes(tool.name)));
 // Measured 2026-11-17: the named tools 18,766 bytes, the five a body had 3,714. No harness was run to count
 // tokens; at 3.5 to 4 bytes a token for this kind of JSON that is about 4,700 to 5,400 tokens more.
 expect(named).toBeLessThanOrEqual(NAMED_TOOLS_BYTES);expect(named).toBeGreaterThan(before);
},60_000);

it('gives a body told another agent\'s name nothing of that agent\'s: the door answers for the credential',async()=>{
 // The body's program is told it is mark. Its credential is art's. The member it works for has both agents.
 const b=await body({agent:'mark',seed:other=>{
  writeFileSync(join(other.directory,'IDENTITY.md'),'MARK_SECRET_CREED');
  const projects=new ProjectsStore({dbPath:other.memories});projects.write({slug:'fictional-mark-shed',name:'MARK_SECRET_PROJECT'});projects.close();
  const people=new PeopleStore({dbPath:other.memories});people.write({slug:'fictional-mark-friend',name:'MARK_SECRET_PERSON'});people.close();
 }});
 b.fixture.root.writes.run(()=>b.fixture.db.insert(schema.memberAgents).values({member:'alice',agent:'mark'}).run());
 const id='mark:00000000-0000-4000-8000-000000000000';
 const every:Record<string,Record<string,unknown>[]>={
  // The tools that use the agent's name: in a read's variables, in a card's id, to pick their own rows, or as a task's owner.
  identity:[{},{piece:'creed'},{piece:'all'}],note_read:[{path:'work/pump'}],note_list:[{}],memory_drafts:[{}],
  person:[{},{slug:'fictional-mark-friend'}],project:[{},{slug:'fictional-mark-shed'}],task_create:[{title:'Fictional',goal:'g',why:'w'}],
  // The rest never send the name: loom takes the agent from the credential.
  remember:[{category:'reference',title:'Fictional told-mark memory',content:'words'}],recall:[{query:'secret creed project person'}],update:[{id,content:'x'}],forget:[{id}],episodes:[{}],
  knowledge_recall:[{query:'secret'}],knowledge_write:[{title:'Fictional page',domain:'fictional',body:'words'}],knowledge_read:[{slug:'fictional-page'}],knowledge_edit:[{slug:'fictional-page',body:'more'}],
  knowledge_check:[{slug:'fictional-page',outcome:'still-true'}],knowledge_restore:[{slug:'fictional-page',revision:1}],note_write:[{path:'work/told',body:'words',lifespan:'keep'}],
  person_write:[{slug:'fictional-told',name:'Fictional told'}],project_write:[{slug:'fictional-told',name:'Fictional told'}],
  memory_propose:[{category:'reference',title:'Fictional draft',content:'words'}],memory_ratify:[{id:'mark:proposal:00000000-0000-4000-8000-000000000000'}],memory_archive:[{id}],memory_restore:[{id}],memory_history:[{id}],
  task_ready:[{}],task:[{id:'t-1'}],task_edit:[{id:'t-1',priority:1}],task_move_to_project:[{ids:['t-1'],project:null}],task_claim:[{id:'t-1'}],task_close:[{id:'t-1',reason:'done'}],task_comment:[{id:'t-1',text:'words'}],
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
},120_000);
