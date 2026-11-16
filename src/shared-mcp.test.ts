/** The terminal door uses the running program, its credentials and canonical services. */
import Database from 'better-sqlite3';
import {expect,it,vi} from 'vitest';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {sharedUiProgram} from '../test/fixtures/shared-ui-program.js';
import {FakeClock} from './core/clock.js';
import * as s from './core/data/schema.js';
import {createStdioServer} from './index.js';
vi.mock('./backends/fastembed.js',()=>({FastEmbedProvider:class{readonly dimensions=4;async embed(){return [1,0,0,0];}async embedBatch(texts:string[]){return texts.map(()=>[1,0,0,0]);}}}));
for(const door of ['http','stdio']as const)it(`${door} reads identity, remembers and recalls, and handles Tasks without a browser or worker job`,async()=>{
 const clock=new FakeClock(Date.now()),p=await sharedUiProgram({clock,seed(db,now){db.insert(s.members).values({id:'alice',role:'owner',joinedAt:now()}).run();db.insert(s.agents).values({id:'art',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();db.insert(s.memberAgents).values({member:'alice',agent:'art'}).run();}}),client=new Client({name:'fictional-terminal',version:'1'});let server:ReturnType<typeof createStdioServer>['server']|undefined;
 try{
  writeFileSync(join(p.home,'agents/art/IDENTITY.md'),'FICTIONAL_SHARED_TERMINAL_IDENTITY');
  const setup=p.composition.writes.run(()=>p.composition.services.signin.issue({kind:'owner',member:'alice',label:'Fictional owner setup'})).value;
  const issued=await fetch(p.url+'/api/signin/token',{method:'POST',headers:{authorization:'Bearer '+setup.token,'content-type':'application/json'},body:JSON.stringify({kind:'agent',agent:'art',label:'Fictional terminal'})});expect(issued.status).toBe(200);const credential=(await issued.json()).value as {token:string;fingerprint:string};
  for(const file of ['household.json','tokens.json','loom.db'])writeFileSync(join(p.home,file),'Fictional poisoned legacy store');
  if(door==='http')await client.connect(new StreamableHTTPClientTransport(new URL('/mcp',p.url),{requestInit:{headers:{authorization:'Bearer '+credential.token}}}));
  else{const file=join(p.home,'fictional-token');writeFileSync(file,credential.token,{mode:0o600});({server}=createStdioServer(['mcp','--next','--home',p.home,'--agent','art','--url',p.url,'--token-file',file]));const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);}
  const wrong=await fetch(p.url+'/mcp',{method:'POST',headers:{authorization:'Bearer '+credential.token,'x-loom-agent':'another-agent','content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});expect(wrong.status).toBe(401);
  expect((await client.listTools()).tools.map(tool=>tool.name)).toEqual(expect.arrayContaining(['loom_commands','loom_command','loom_query']));
  const call=async(name:string,args:Record<string,unknown>)=>{const result=await client.callTool({name,arguments:args});expect(result.isError,JSON.stringify(result)).not.toBe(true);return JSON.parse((result.content as Array<{text:string}>)[0].text);};
  const command=async(operation:string,input:unknown,id:string)=>(await call('loom_command',{operation,input,id})).value;
  expect(await call('loom_query',{query:'{memoryIdentity(agent:"art"){creed}}'})).toMatchObject({data:{memoryIdentity:{creed:'FICTIONAL_SHARED_TERMINAL_IDENTITY'}}});
  const remembered=await command('memory.remember',{category:'reference',title:'Fictional terminal memory',content:'FICTIONAL_TERMINAL_MEMORY'},'terminal-remember');expect(remembered.ids).toHaveLength(1);
  expect((await command('memory.recall',{query:'terminal'},'terminal-recall')).ids).toEqual(remembered.ids);
  const note={path:'fictional/terminal-note',body:'FICTIONAL_PRIVATE_TERMINAL_NOTE',lifespan:'keep'};
  expect(await command('memory.noteWrite',note,'terminal-note')).toEqual({saved:true});expect(await command('memory.noteWrite',note,'terminal-note')).toEqual({saved:true});
  expect(await call('loom_query',{query:'{memoryNote(agent:"art",path:"fictional/terminal-note"){body by}}'})).toMatchObject({data:{memoryNote:{body:note.body,by:'art'}}});
  for(const value of [note.path,note.body,'FICTIONAL_TERMINAL_MEMORY'])expect(p.client.serialize().includes(Buffer.from(value))).toBe(false);
  const notes=new Database(join(p.home,'agents/art/notes.db'));try{
   const before=notes.prepare('SELECT * FROM notes').all();
   notes.exec("CREATE TRIGGER fail_note_receipt BEFORE INSERT ON mind_operation_receipts BEGIN SELECT RAISE(ABORT,'injected'); END");
   const failed=await client.callTool({name:'loom_command',arguments:{operation:'memory.noteWrite',input:{...note,body:'FICTIONAL_ROLLED_BACK_NOTE'},id:'terminal-note-rollback'}});expect(failed.isError).toBe(true);expect(notes.prepare('SELECT * FROM notes').all()).toEqual(before);notes.exec('DROP TRIGGER fail_note_receipt');
   p.client.exec("CREATE TRIGGER fail_note_core BEFORE INSERT ON operation_results BEGIN SELECT RAISE(ABORT,'injected'); END");
   const incomplete=await client.callTool({name:'loom_command',arguments:{operation:'memory.noteWrite',input:{...note,body:'FICTIONAL_COMMITTED_NOTE'},id:'terminal-note-recover'}});expect(incomplete.isError).toBe(true);const after=notes.serialize();p.client.exec('DROP TRIGGER fail_note_core');
   expect(await command('memory.noteWrite',{...note,body:'FICTIONAL_COMMITTED_NOTE'},'terminal-note-recover')).toEqual({saved:true});expect(notes.serialize()).toEqual(after);
  }finally{notes.close();}
  const created=await command('tasks.command',{action:'create',input:{title:'Fictional terminal task',goal:'Exercise the shared MCP door',why:'Headless work must use the actual task service',owner:{kind:'agent',id:'art'}}},'terminal-create');expect(created.id).toBeTruthy();
  for(const [action,extra] of [['claim',{}],['comment',{text:'Fictional terminal result'}],['close',{reason:'Fictional work complete'}]]as const)await command('tasks.command',{action,id:created.id,...extra},'terminal-'+action);
  expect(p.db.select().from(s.jobs).all()).toEqual([]);expect(p.client.prepare("SELECT name FROM sqlite_schema WHERE name='household_settings'").get()).toBeUndefined();
  p.composition.writes.run(()=>p.composition.services.signin.revoke(credential.fingerprint));
  const revoked=await client.callTool({name:'loom_query',arguments:{query:'{memoryIdentity(agent:"art"){creed}}'}}).catch(()=>null);expect(revoked===null||revoked.isError===true).toBe(true);
 }finally{await client.close();await server?.close();await p.close();}
});
it('keeps MCP private query bytes and clones bound to the original credential after preparation',async()=>{
 const p=await sharedUiProgram({clock:new FakeClock(Date.now()),seed(db,now){db.insert(s.members).values({id:'alice',role:'owner',joinedAt:now()}).run();db.insert(s.agents).values({id:'art',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();db.insert(s.memberAgents).values({member:'alice',agent:'art'}).run();}});
 try{writeFileSync(join(p.home,'agents/art/IDENTITY.md'),'FICTIONAL_DELAYED_MCP_IDENTITY');const credential=p.composition.writes.run(()=>p.composition.services.signin.issue({kind:'agent',agent:'art',label:'Fictional delayed MCP'})).value;
  const response=await p.composition.http.request(p.url+'/mcp',{method:'POST',headers:{authorization:'Bearer '+credential.token,'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-06-18'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'loom_query',arguments:{query:'{memoryIdentity(agent:"art"){creed}}'}}})});expect(response.status).toBe(200);const clone=response.clone();
  p.composition.writes.run(()=>p.composition.services.signin.revoke(credential.fingerprint));
  for(const held of [response,clone])await expect(held.text()).rejects.toThrow();
 }finally{await p.close();}
});
it('retains the selected Memory expiry on delayed MCP bytes even without a timer or database write',async()=>{
 let now=Date.now();const clock={now:()=>now,at:()=>()=>{}},p=await sharedUiProgram({clock,seed(db,at){db.insert(s.members).values({id:'alice',role:'owner',joinedAt:at()}).run();db.insert(s.agents).values({id:'art',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();}});
 try{const credential=p.composition.writes.run(()=>p.composition.services.signin.issue({kind:'agent',agent:'art',label:'Fictional retained MCP'})).value;
  const made=await fetch(p.url+'/api/memory/remember',{method:'POST',headers:{authorization:'Bearer '+credential.token,'content-type':'application/json'},body:JSON.stringify({input:{category:'reference',title:'Fictional expiry lease',content:'FICTIONAL_EXPIRING_MCP_WORDS'},id:'mcp-expiry'})});expect(made.status).toBe(200);const id=(await made.json()).value.ids[0] as string;
  const source=new Database(join(p.home,'agents/art/memories.db'));try{source.prepare('UPDATE memories SET expires_at=?').run(new Date(now+1000).toISOString());}finally{source.close();}
  const response=await p.composition.http.request(p.url+'/mcp',{method:'POST',headers:{authorization:'Bearer '+credential.token,'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-06-18'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'loom_query',arguments:{query:`{memoryProjectMemory(id:"${id}"){content}}`}}})});expect(response.status).toBe(200);const clone=response.clone();now+=1001;
  for(const held of [response,clone])await expect(held.text()).rejects.toThrow();
 }finally{await p.close();}
});
