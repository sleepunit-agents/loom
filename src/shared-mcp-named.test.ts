/** The named terminal tools, over the real HTTP door of a started program. */
import {expect,it,vi} from 'vitest';
import {writeFileSync} from 'node:fs';
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
   ['identity','remember','recall','update','forget','episodes','knowledge_recall','knowledge_write','note_read','note_write','note_list','loom_query','loom_command','loom_commands']));
 }finally{await art.client.close();await p.close();}
},30_000);

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
},30_000);

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
},30_000);

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
},30_000);

it('lists recent episodes',async()=>{
 const {p,connect}=await program(),art=await connect('art');
 try{
  writeFileSync(join(p.home,'agents/art/IDENTITY.md'),'FICTIONAL_IDENTITY');
  expect((await art.call('remember',{category:'episode',title:'Fictional episode title',content:'What happened in the example shed.'})).error).toBe(false);
  const episodes=await art.call('episodes');
  expect(episodes.error,episodes.text).toBe(false);expect(episodes.text).toContain('Fictional episode title');
 }finally{await art.client.close();await p.close();}
},30_000);
