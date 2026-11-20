/** The named terminal tools, over the real HTTP door of a started program. */
import {expect,it,vi} from 'vitest';
import {writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {sharedUiProgram} from '../test/fixtures/shared-ui-program.js';
import {FakeClock} from './core/clock.js';
import * as s from './core/data/schema.js';

vi.mock('./backends/fastembed.js',()=>({FastEmbedProvider:class{readonly dimensions=4;async embed(){return [1,0,0,0];}async embedBatch(texts:string[]){return texts.map(()=>[1,0,0,0]);}}}));

async function program(){
 const clock=new FakeClock(Date.now());
 const p=await sharedUiProgram({clock,seed(db,now){
  db.insert(s.members).values({id:'alice',role:'owner',joinedAt:now()}).run();
  db.insert(s.agents).values(['art','mark'].map(id=>({id,about:'',markBg:'',markFg:'',faceShape:'pebble' as const,faceEyes:'dot' as const}))).run();
  db.insert(s.memberAgents).values([{member:'alice',agent:'art'},{member:'alice',agent:'mark'}]).run();
  // art is on one project; nobody is on the other.
  db.insert(s.projects).values(['fictional-pond','fictional-shed'].map(id=>({id,name:id}))).run();
  db.insert(s.projectAgents).values({project:'fictional-pond',agent:'art'}).run();
 }});
 const connect=async(agent:string)=>{
  const credential=p.composition.writes.run(()=>p.composition.services.signin.issue({kind:'agent',agent,label:'Fictional terminal '+agent})).value;
  const client=new Client({name:'fictional-terminal',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp',p.url),{requestInit:{headers:{authorization:'Bearer '+credential.token}}}));
  const call=async(name:string,args:Record<string,unknown>={})=>{
   const result=await client.callTool({name,arguments:args});
   return {error:result.isError===true,text:(result.content as Array<{text:string}>).map(part=>part.text).join('\n')};
  };
  return {client,call};
 };
 return {p,connect};
}

it('lists the names a terminal session already calls',async()=>{
 const {p,connect}=await program(),art=await connect('art');
 try{
  expect((await art.client.listTools()).tools.map(tool=>tool.name)).toEqual(expect.arrayContaining(
   ['identity','remember','recall','update','forget','episodes','knowledge_recall','knowledge_write','note_read','note_write','note_list','person','person_write','project','project_write','memory_propose','memory_drafts','memory_ratify','memory_archive','memory_restore','memory_history','knowledge_read','knowledge_edit','knowledge_check','knowledge_restore',
    'task_ready','task','task_create','task_edit','task_move_to_project','task_claim','task_close','task_comment','propose','approvals','inbox','loom_query','loom_command','loom_commands']));
 }finally{await art.client.close();await p.close();}
});

it('remembers, recalls with words, updates and forgets',async()=>{
 const {p,connect}=await program(),art=await connect('art');
 try{
  const remembered=await art.call('remember',{category:'reference',title:'Fictional pump lesson',content:'FICTIONAL_PUMP_WORDS'});
  expect(remembered.error,remembered.text).toBe(false);
  const id=/\((art:[a-f0-9-]{36})\)/.exec(remembered.text)?.[1];expect(id).toBeTruthy();
  const recalled=await art.call('recall',{query:'pump'});
  expect(recalled.text).toContain('## Fictional pump lesson');expect(recalled.text).toContain('FICTIONAL_PUMP_WORDS');expect(recalled.text).toContain(id);
  expect((await art.call('update',{id,content:'FICTIONAL_PUMP_REVISED'})).error).toBe(false);
  expect((await art.call('recall',{query:'pump'})).text).toContain('FICTIONAL_PUMP_REVISED');
  expect((await art.call('forget',{id})).error).toBe(false);
  expect((await art.call('recall',{query:'pump'})).text).toBe('No memories matched.');
  expect((await art.call('recall',{query:''})).error).toBe(true);
 }finally{await art.client.close();await p.close();}
});

it('writes, reads and lists notes, and keeps them from another agent',async()=>{
 const {p,connect}=await program(),art=await connect('art'),mark=await connect('mark');
 try{
  expect((await art.call('note_write',{path:'fictional/first',body:'FICTIONAL_NOTE_ONE',lifespan:'keep'})).error).toBe(false);
  expect((await art.call('note_write',{path:'fictional/second',body:'FICTIONAL_NOTE_TWO',lifespan:'short'})).error).toBe(false);
  expect((await art.call('note_write',{path:'other/third',body:'FICTIONAL_NOTE_THREE',lifespan:'keep'})).error).toBe(false);
  expect((await art.call('note_read',{path:'fictional/first'})).text).toContain('FICTIONAL_NOTE_ONE');
  expect((await art.call('note_read',{path:'fictional/missing'})).text).toBe('No note at fictional/missing');
  const listed=(await art.call('note_list',{prefix:'fictional'})).text;
  expect(listed).toContain('fictional/first');expect(listed).toContain('fictional/second');expect(listed).not.toContain('other/third');expect(listed).not.toContain('FICTIONAL_NOTE');
  expect((await art.call('note_list',{limit:1})).text.split('\n')).toHaveLength(1);
  // A new note without a lifespan is refused in the door's own words, not as an outage.
  const refused=await art.call('note_write',{path:'fictional/no-lifespan',body:'x'});expect(refused.error).toBe(true);
  // Mark's own list is his own store; he cannot name Art's through the query either.
  expect((await mark.call('note_list',{prefix:'fictional'})).text).not.toContain('fictional/first');
  const foreign=JSON.parse((await mark.call('loom_query',{query:'{memoryNotes(agent:"art"){path} memoryNote(agent:"art",path:"fictional/first"){body}}'})).text);
  expect(foreign.data).toEqual({memoryNotes:null,memoryNote:null});
 }finally{await art.client.close();await mark.client.close();await p.close();}
});

it('writes and searches knowledge by every word',async()=>{
 const {p,connect}=await program(),art=await connect('art');
 try{
  const wrote=await art.call('knowledge_write',{title:'Fictional shed hinges',domain:'fictional/shed',body:'Brass hinges resist the example rain. 100%_literal'});
  expect(wrote.error,wrote.text).toBe(false);
  await art.call('knowledge_write',{title:'Fictional garden hose',domain:'fictional/garden',body:'The hose is twelve example metres.'});
  const found=(await art.call('knowledge_recall',{query:'brass hinges'})).text;
  expect(found).toContain('## Fictional shed hinges');expect(found).toContain('Brass hinges resist');expect(found).not.toContain('garden hose');
  expect((await art.call('knowledge_recall',{query:'hinges hose'})).text).toBe('No knowledge pages matched.');
  expect((await art.call('knowledge_recall',{query:'fictional',domain:'fictional/garden'})).text).not.toContain('shed hinges');
  // LIKE wildcards in a query are literal words.
  expect((await art.call('knowledge_recall',{query:'100%_literal'})).text).toContain('shed hinges');
  expect((await art.call('knowledge_recall',{query:'1%l'})).text).toBe('No knowledge pages matched.');
 }finally{await art.client.close();await p.close();}
});

it('lists recent episodes',async()=>{
 const {p,connect}=await program(),art=await connect('art');
 try{
  writeFileSync(join(p.home,'agents/art/IDENTITY.md'),'FICTIONAL_IDENTITY');
  expect((await art.call('remember',{category:'episode',title:'Fictional episode title',content:'What happened in the example shed.'})).error).toBe(false);
  const episodes=await art.call('episodes');
  expect(episodes.error,episodes.text).toBe(false);expect(episodes.text).toContain('Fictional episode title');
 }finally{await art.client.close();await p.close();}
});

it('loads identity as a core with an index, and further pieces by name',async()=>{
 const {p,connect}=await program(),art=await connect('art'),mark=await connect('mark');
 try{
  const home=join(p.home,'agents/art');
  writeFileSync(join(home,'IDENTITY.md'),'FICTIONAL_CREED');writeFileSync(join(home,'self-model.md'),'FICTIONAL_SELF_MODEL');
  for(const [folder,name,words] of [['harnesses','fictional-terminal','FICTIONAL_HARNESS'],['models','fictional-model','FICTIONAL_MODEL_FAMILY'],['roles','tend','FICTIONAL_ROLE']] as const){
   mkdirSync(join(home,folder),{recursive:true});writeFileSync(join(home,folder,name+'.md'),words);
  }
  const core=(await art.call('identity',{client:'fictional-terminal',model:'fictional-model-9'})).text;
  expect(core).toContain('Agent: art');expect(core).toContain('FICTIONAL_CREED');expect(core).toContain('# Pieces');
  for(const absent of ['FICTIONAL_SELF_MODEL','FICTIONAL_HARNESS','FICTIONAL_MODEL_FAMILY','FICTIONAL_ROLE'])expect(core).not.toContain(absent);
  expect((await art.call('identity',{piece:'self-model'})).text).toBe('Agent: art\n\n# Self-Model\n\nFICTIONAL_SELF_MODEL');
  expect((await art.call('identity',{piece:'harness',client:'fictional-terminal'})).text).toContain('FICTIONAL_HARNESS');
  writeFileSync(join(home,'harnesses','codex-mcp-client.md'),'EXISTING_CODEX_MANIFEST');
  expect((await art.call('identity',{piece:'harness',client:'codex'})).text).toContain('EXISTING_CODEX_MANIFEST');
  writeFileSync(join(home,'harnesses','codex.md'),'SHORT_CODEX_MANIFEST');
  expect((await art.call('identity',{piece:'harness',client:'codex'})).text).toBe('Agent: art\n\n# Harness: codex\n\nSHORT_CODEX_MANIFEST');
  expect((await art.call('identity',{piece:'harness',client:'codex-mcp-client'})).text).toContain('EXISTING_CODEX_MANIFEST');
  // A dated model name falls back to its family's page.
  expect((await art.call('identity',{piece:'model',model:'fictional-model-9-1'})).text).toContain('FICTIONAL_MODEL_FAMILY');
  expect((await art.call('identity',{role:'tend'})).text).toContain('# Mode: tend\n\nFICTIONAL_ROLE');
  const all=(await art.call('identity',{piece:'all',client:'fictional-terminal',model:'fictional-model'})).text;
  for(const present of ['FICTIONAL_CREED','FICTIONAL_SELF_MODEL','FICTIONAL_HARNESS','FICTIONAL_MODEL_FAMILY'])expect(all).toContain(present);
  // No path leaves the declared folder, and no caller reads another agent's pages.
  expect((await art.call('identity',{piece:'harness',client:'../IDENTITY'})).text).not.toContain('FICTIONAL_CREED');
  expect((await art.call('identity',{agent:'mark'})).error).toBe(true);
  const foreign=JSON.parse((await mark.call('loom_query',{query:'{memoryIdentity(agent:"art"){page(kind:"harness",name:"fictional-terminal")}}'})).text);
  expect(foreign.data).toEqual({memoryIdentity:null});
  const escape=JSON.parse((await art.call('loom_query',{query:'{memoryIdentity(agent:"art"){a:page(kind:"harness",name:"..") b:page(kind:"__proto__",name:"x") c:page(kind:"role",name:"tend")}}'})).text);
  expect(escape.data).toEqual({memoryIdentity:{a:null,b:null,c:'FICTIONAL_ROLE'}});
 }finally{await art.client.close();await mark.client.close();await p.close();}
});

it('writes, reads and lists person and project cards, and keeps them from another agent',async()=>{
 const {p,connect}=await program(),art=await connect('art'),mark=await connect('mark');
 try{
  expect((await art.call('person_write',{slug:'fictional-pat',name:'Pat Fictional',summary:'FICTIONAL_PERSON_SUMMARY'})).error).toBe(false);
  const person=(await art.call('person',{slug:'fictional-pat'})).text;
  expect(person).toContain('# Pat Fictional');expect(person).toContain('FICTIONAL_PERSON_SUMMARY');
  expect((await art.call('person',{})).text).toContain('- fictional-pat (Pat Fictional)');
  expect((await art.call('person',{slug:'nobody-here'})).text).toBe('No person card for nobody-here');
  expect((await art.call('person_write',{slug:'fictional-pat',summary:'FICTIONAL_SECOND_SUMMARY',merge:true})).error).toBe(false);
  const merged=(await art.call('person',{slug:'fictional-pat'})).text;
  expect(merged).toContain('# Pat Fictional');expect(merged).toContain('FICTIONAL_SECOND_SUMMARY');
  expect((await art.call('project_write',{slug:'fictional-pond',name:'Fictional Pond',status:'active',summary:'FICTIONAL_PROJECT_SUMMARY',goal:'FICTIONAL_GOAL'})).error).toBe(false);
  const project=(await art.call('project',{slug:'fictional-pond'})).text;
  expect(project).toContain('# Fictional Pond');expect(project).toContain('active');expect(project).toContain('FICTIONAL_PROJECT_SUMMARY');expect(project).toContain('FICTIONAL_GOAL');
  expect((await art.call('project',{})).text).toContain('- fictional-pond (Fictional Pond)');
  expect((await art.call('person_write',{slug:'Not A Slug'})).error).toBe(true);
  // Mark has his own store: Art's cards are not in his lists or readable by slug.
  expect((await mark.call('person',{slug:'fictional-pat'})).text).toBe('No person card for fictional-pat');
  expect((await mark.call('person',{})).text).not.toContain('fictional-pat');
  expect((await mark.call('project',{slug:'fictional-pond'})).text).toBe('No project card for fictional-pond');
 }finally{await art.client.close();await mark.client.close();await p.close();}
});

it('files, reads, claims, comments on and closes a task through the named tools',async()=>{
 const {p,connect}=await program(),art=await connect('art');
 try{
  const filed=(await art.call('task_create',{title:'Fictional pump order',goal:'FICTIONAL_GOAL',why:'FICTIONAL_WHY',priority:1})).text;
  const id=/^Filed (t-\d+):/.exec(filed)?.[1];expect(id).toBeTruthy();
  expect((await art.call('task_ready',{})).text).toContain('- '+id+' P1 Fictional pump order');
  expect((await art.call('task_edit',{id,doneWhen:'FICTIONAL_DONE'})).error).toBe(false);
  expect((await art.call('task_comment',{id,text:'FICTIONAL_COMMENT'})).error).toBe(false);
  expect((await art.call('task_claim',{id})).text).toBe('Claimed '+id);
  const read=(await art.call('task',{id})).text;
  for(const words of ['# Fictional pump order','in_progress','FICTIONAL_GOAL','FICTIONAL_WHY','FICTIONAL_DONE','FICTIONAL_COMMENT','held by art'])expect(read).toContain(words);
  expect((await art.call('task_ready',{})).text).toBe('Nothing is ready.');
  expect((await art.call('task_claim',{id,release:true})).text).toBe('Released '+id);
  expect((await art.call('task_close',{id})).error).toBe(true);
  expect((await art.call('task_close',{id,reason:'FICTIONAL_REASON'})).text).toBe('Closed '+id);
  expect((await art.call('task',{id})).text).toContain('**Closed:** FICTIONAL_REASON');
  expect((await art.call('task_close',{id,reopen:true})).text).toBe('Reopened '+id);
  expect((await art.call('task',{id:'t-999'})).text).toBe('No task t-999 that you may see.');
  // Out of a project it is not in: nothing to do. Into a project it is not on, or with a task it cannot see: refused whole.
  expect((await art.call('task_move_to_project',{ids:[id],project:null})).text).toBe('Nothing moved: none of them is in a project.');
  const refused=await art.call('task_move_to_project',{ids:[id],project:'fictional-nowhere'});expect(refused.error).toBe(true);expect(refused.text).toMatch(/\(denied\)$/);
  expect((await art.call('task_move_to_project',{ids:[id,'t-999'],project:null})).error).toBe(true);
  expect((await art.call('task_move_to_project',{ids:[],project:null})).error).toBe(true);
  // Into the project art is on, and not into one it is not on. The move leaves its record on the task.
  expect((await art.call('task_move_to_project',{ids:[id],project:'fictional-shed'})).error).toBe(true);
  expect((await art.call('task_move_to_project',{ids:[id],project:'fictional-pond'})).text).toBe('Moved '+id+' to project fictional-pond.');
  expect((await art.call('task_move_to_project',{ids:[id],project:'fictional-pond'})).text).toBe('Nothing moved: they are already in project fictional-pond.');
  const movedTask=(await art.call('task',{id})).text;expect(movedTask).toContain('· fictional-pond ·');expect(movedTask).toContain('**art** ');expect(movedTask).toContain('Moved from no project to project fictional-pond');
  // Its project retired, the task reads as shelved with what it was, and is not ready.
  p.composition.writes.run(()=>p.composition.services.projects.setRetired({project:'fictional-pond'},true));
  expect((await art.call('task',{id})).text).toContain('shelved with its retired project, was open');
  expect((await art.call('task_ready',{})).text).toBe('Nothing is ready.');
  p.composition.writes.run(()=>p.composition.services.projects.setRetired({project:'fictional-pond'},false));
  expect((await art.call('task',{id})).text).not.toContain('shelved');
  expect((await art.call('task_move_to_project',{ids:[id],project:null})).text).toBe('Moved '+id+' out of every project.');
 }finally{await art.client.close();await p.close();}
});

it('drafts, ratifies, archives and restores a memory, and reads its earlier versions',async()=>{
 const {p,connect}=await program(),art=await connect('art');
 try{
  const drafted=(await art.call('memory_propose',{category:'project',title:'Fictional draft',content:'FICTIONAL_DRAFT_BODY'})).text;
  const draft=/\(([^)]+)\)$/.exec(drafted)?.[1];expect(draft).toBeTruthy();
  expect((await art.call('memory_drafts',{})).text).toContain('FICTIONAL_DRAFT_BODY');
  expect((await art.call('recall',{query:'Fictional draft'})).text).not.toContain('FICTIONAL_DRAFT_BODY');
  expect((await art.call('memory_ratify',{id:draft})).error).toBe(false);
  expect((await art.call('memory_drafts',{})).text).toBe('No drafts.');
  const recalled=(await art.call('recall',{query:'Fictional draft'})).text;
  expect(recalled).toContain('FICTIONAL_DRAFT_BODY');
  const id=/ · (art:[0-9a-f-]+) · /.exec(recalled)?.[1];expect(id).toBeTruthy();
  expect((await art.call('update',{id,content:'FICTIONAL_SECOND_BODY'})).error).toBe(false);
  const history=(await art.call('memory_history',{id})).text;
  expect(history).toContain('FICTIONAL_DRAFT_BODY');
  const version=Number(/## Version (\d+)/.exec(history)?.[1]);
  expect((await art.call('memory_restore',{id,revision:version})).error).toBe(false);
  expect((await art.call('recall',{query:'Fictional draft'})).text).toContain('FICTIONAL_DRAFT_BODY');
  const near=(await art.call('remember',{category:'reference',title:'Related',content:'Fictional related draft.'})).text;
  const other=/\(([^)]+)\)$/.exec(near)?.[1];expect(other).toBeTruthy();
  const merge=async(sources:(string|undefined)[],opId:string)=>JSON.parse((await art.call('loom_command',{operation:'memory.merge',input:{target:id,sources},id:opId})).text);
  expect((await merge([other,other],'duplicate-sources')).ok).toBe(false);
  expect((await merge(['mark:00000000-0000-4000-8000-000000000001'],'wrong-agent')).ok).toBe(false);
  const merged=await merge([other],'merge-fixture');
  expect(merged).toMatchObject({ok:true,value:{ids:[id]}});
  expect(await merge([other],'merge-fixture')).toEqual(merged);
  expect((await art.call('recall',{query:'Fictional related draft'})).text).not.toContain('Fictional related draft.');
  expect((await art.call('memory_archive',{id,note:'set aside'})).text).toBe('Archived '+id);
  expect((await art.call('recall',{query:'Fictional draft'})).text).toBe('No memories matched.');
  expect((await art.call('memory_restore',{id})).text).toBe('Restored '+id);
  expect((await art.call('recall',{query:'Fictional draft'})).text).toContain('FICTIONAL_DRAFT_BODY');
 }finally{await art.client.close();await p.close();}
});

it('reads, edits, checks and restores a knowledge page',async()=>{
 const {p,connect}=await program(),art=await connect('art');
 try{
  expect((await art.call('knowledge_write',{title:'Fictional hose',domain:'pond',body:'FICTIONAL_FIRST_FACT'})).text).toBe('Wrote knowledge page fictional-hose');
  expect((await art.call('knowledge_edit',{slug:'fictional-hose',body:'FICTIONAL_SECOND_FACT'})).error).toBe(false);
  expect((await art.call('knowledge_check',{slug:'fictional-hose',outcome:'still-true'})).text).toBe('Marked fictional-hose still true');
  const page=(await art.call('knowledge_read',{slug:'fictional-hose'})).text;
  expect(page).toContain('# Fictional hose');expect(page).toContain('FICTIONAL_SECOND_FACT');expect(page).toContain('## Earlier versions');
  // A check without a note leaves the words alone; one with a note appends it.
  expect(page).not.toContain('## Verification');expect(page).not.toContain('(verify-note');
  expect((await art.call('knowledge_check',{slug:'fictional-hose',outcome:'still-true',note:'FICTIONAL_CHECK_NOTE',freshnessAnchor:'Hose 1.2'})).error).toBe(false);
  const noted=(await art.call('knowledge_read',{slug:'fictional-hose'})).text;expect(noted).toContain('## Verification');expect(noted).toContain('FICTIONAL_CHECK_NOTE');expect(noted).toContain('(verify-note');
  const version=Number(/^- (\d+) \(edit/m.exec(page)?.[1]);expect(version).toBeGreaterThan(0);
  expect((await art.call('knowledge_restore',{slug:'fictional-hose',revision:version})).error).toBe(false);
  expect((await art.call('knowledge_read',{slug:'fictional-hose'})).text).toContain('FICTIONAL_FIRST_FACT');
  expect((await art.call('knowledge_check',{slug:'fictional-hose',outcome:'due-a-check'})).error).toBe(false);
  // A source alone: the words stay, no version is kept, and the page becomes sourced.
  expect((await art.call('knowledge_read',{slug:'fictional-hose'})).text).toContain('provisional');
  expect((await art.call('knowledge_edit',{slug:'fictional-hose',source:'https://example.invalid/hose'})).error).toBe(false);
  const sourced=(await art.call('knowledge_read',{slug:'fictional-hose'})).text;
  expect(sourced).toContain('FICTIONAL_FIRST_FACT');expect(sourced).toContain('· sourced ·');expect(sourced).toContain('- https://example.invalid/hose');
  expect((await art.call('knowledge_edit',{slug:'fictional-hose',source:'https://example.invalid/hose'})).error).toBe(true);
  expect((await art.call('knowledge_edit',{slug:'fictional-hose',source:'Pond pump thread'})).error).toBe(true);
  expect((await art.call('knowledge_edit',{slug:'fictional-hose'})).error).toBe(true);
  expect((await art.call('knowledge_read',{slug:'no-such-page'})).text).toBe('No knowledge page no-such-page');
 }finally{await art.client.close();await p.close();}
});

it('lists the current attributed approval answer after an owner answers through MCP',async()=>{
 const {p,connect}=await program(),art=await connect('art');
 const owner=new Client({name:'fictional-owner-terminal',version:'1'});
 try{
  const token=p.composition.writes.run(()=>p.composition.services.signin.issue({kind:'owner',member:'alice',label:'Owner terminal'})).value.token;
  await owner.connect(new StreamableHTTPClientTransport(new URL('/mcp',p.url),{requestInit:{headers:{authorization:'Bearer '+token}}}));
  const card=p.composition.writes.run(()=>p.composition.services.approvals.request({
   kind:'command',target:'fixture',what:'Apply fixture',why:'Test the terminal',agent:'art',actingFor:'alice',
   askedFrom:'terminal',ask:'Apply?',ifYes:'Apply',ifNo:'Wait',
  })).value;
  for(const [answer,quote] of [['allow','Proceed with the fixture'],['deny','Hold the fixture']] as const){
   const result=await owner.callTool({name:'loom_command',arguments:{operation:'approvals.answer',id:'answer-'+answer,
    input:{id:card.id,answer,onWord:{venue:'terminal',through:'mark',quote}}}});
   expect(result.isError,JSON.stringify(result.content)).not.toBe(true);
  }
  const listed=await art.call('approvals',{state:'denied'});
  expect(listed.error,listed.text).toBe(false);
  expect(listed.text).toContain('Denied by alice as told to mark at the terminal');
  expect(listed.text).toContain('Hold the fixture');
  expect(listed.text).not.toContain('Proceed with the fixture');
 }finally{await owner.close();await art.client.close();await p.close();}
});

it('proposes a change, sees the approval waiting, and reads its own inbox',async()=>{
 const {p,connect}=await program(),art=await connect('art');
 try{
  const filed=(await art.call('propose',{change:'settings',input:{commsDays:7},why:'FICTIONAL_REASON\n# heading <img> `code`'})).text;
  expect(filed).toMatch(/^Filed approval a-[0-9a-f-]+\. It waits for a household owner\.$/);
  const pending=(await art.call('approvals',{state:'pending'})).text;
  expect(pending).toContain('## Have Comms keep words for 7 days');expect(pending).not.toContain('Days Comms keeps words: 7');expect(pending).toContain('Why: FICTIONAL_REASON &#35; heading &#60;img&#62; &#96;code&#96;');
  // An agent reading its own pending asks reads the card's sentence and plain facts: never the raw input.
  expect(pending).not.toContain('{"');
  expect((await art.call('approvals',{state:'denied'})).text).toBe('No approvals are denied.');
  // A refusal carries the door's own words, not a bare "refused".
  const refusedChange=await art.call('propose',{change:'settings',input:{commsDays:8},why:'again'});
  expect(refusedChange.error).toBe(true);expect(refusedChange.text).toBe('A card for this is already waiting for an answer (conflict)');
  const tool={name:'status',description:'Read station status',program:'bin/status',repository:'https://github.com/example/house.git',commit:'a'.repeat(40),image:'sha256:'+'b'.repeat(64),args:[],parameters:{},secrets:{KIT_TEST:'PRIVATE_TEST_SECRET'}};
  expect((await art.call('propose',{change:'kit',input:{agent:'art',kit:'pond-kit',tools:[tool]},why:'Request kit definition'})).error).toBe(false);
  const kitTitle=(await art.call('approvals',{state:'pending'})).text;
  expect(kitTitle).toContain('Give art a kit called pond-kit');
  expect(kitTitle).not.toMatch(/PRIVATE_TEST_SECRET|Read station status|bin\/status/);
  const same=await art.call('task_close',{id:'t-999',reason:'x'});expect(same.error).toBe(true);expect(same.text).not.toBe('The command was refused');expect(same.text).toMatch(/\((denied|not-found|invalid|conflict)\)$/);
  expect((await art.call('propose',{change:'settings',input:{commsDays:99},why:'x'})).error).toBe(true);
  expect(p.composition.services.household.settings().commsDays).toBe(14);
  expect((await art.call('inbox',{})).error).toBe(false);
  // A merge of two projects is proposed like any other household change, and nothing is merged by asking.
  expect((await art.call('propose',{change:'projectMerge',input:{from:'fictional-pond',into:'fictional-shed'},why:'FICTIONAL_MERGE'})).text).toMatch(/^Filed approval a-[0-9a-f-]+\. It waits for a household owner\.$/);
  expect((await art.call('approvals',{state:'pending'})).text).toContain('## Merge the project fictional-pond into the project fictional-shed');
  expect((await art.call('propose',{change:'projectMerge',input:{from:'fictional-pond'},why:'x'})).error).toBe(true);
  expect(p.composition.services.projects.describe('fictional-pond')).toMatchObject({removed:false,agents:['art']});
  // Retiring a project is proposed the same way, and its mirror.
  expect((await art.call('propose',{change:'projectRetire',input:{project:'fictional-shed'},why:'FICTIONAL_RETIRE'})).text).toMatch(/^Filed approval a-[0-9a-f-]+\. It waits for a household owner\.$/);
  expect((await art.call('approvals',{state:'pending'})).text).toContain('## Retire the project fictional-shed');
  expect((await art.call('propose',{change:'projectRevive',input:{project:'fictional-shed'},why:'FICTIONAL_REVIVE'})).error).toBe(false);
  // Asking to be let onto a project: for itself only, and not onto one it is already on.
  expect((await art.call('propose',{change:'projectJoin',input:{project:'fictional-shed',agent:'art'},why:'FICTIONAL_JOIN'})).text).toMatch(/^Filed approval a-[0-9a-f-]+\. It waits for a household owner\.$/);
  expect((await art.call('approvals',{state:'pending'})).text).toContain('## Let art work on the project fictional-shed');
  // A grant to an outside account says who, as far as the card itself says it: the id, with no name looked up.
  expect((await art.call('propose',{change:'kitGrant',input:{agent:'art',kit:'pond-et-livonia',to:{platform:'slack',workspace:'T02AYL3QM',user:'U07V8CZUC1J'},grant:true},why:'FICTIONAL_GRANT'})).error).toBe(false);
  const listed=(await art.call('approvals',{state:'pending'})).text;
  expect(listed).toContain('## Let the Slack account U07V8CZUC1J (workspace T02AYL3QM) use art’s pond-et-livonia kit');
  expect(listed).not.toContain('Account id: U07V8CZUC1J');expect(listed).not.toContain('{"');
  const forMark=await art.call('propose',{change:'projectJoin',input:{project:'fictional-shed',agent:'mark'},why:'x'});expect(forMark.error).toBe(true);expect(forMark.text).toMatch(/\(denied\)$/);
  expect((await art.call('propose',{change:'projectJoin',input:{project:'fictional-pond',agent:'art'},why:'x'})).text).toBe('art is already on project fictional-pond (invalid)');
  expect(p.composition.services.projects.describe('fictional-shed')).toMatchObject({agents:[]});
 }finally{await art.client.close();await p.close();}
});
