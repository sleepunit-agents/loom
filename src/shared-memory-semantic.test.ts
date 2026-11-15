/** Core memory helpers and the running program share the actual declared file. */
import {afterEach,expect,it,vi} from 'vitest';
import Database from 'better-sqlite3';
import {generateX25519Identity} from 'age-encryption';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {WebSocket} from 'ws';
vi.mock('./backends/fastembed.js',()=>({FastEmbedProvider:class{
 readonly dimensions=4;
 async embed(text:string){const words=text.toLowerCase(),v=['alpha','beta','gamma','delta'].map(word=>words.includes(word)?1:0);if(!v.some(Boolean))v[3]=1;const length=Math.hypot(...v);return v.map(n=>n/length);}
 async embedBatch(texts:string[]){return Promise.all(texts.map(text=>this.embed(text)));}
}}));
import {FakeClock} from './core/clock.js';
import {createDataSchema} from './core/data/database.js';
import {members,agents,household,memberAgents} from './core/data/schema.js';
import {prepareSharedMemorySources} from './shared-memory.js';
import {startSharedHome} from './shared-startup.js';
import {requestLocalLink} from './core/signin/operator.js';
import {PeopleStore} from './backends/people.js';
import {ProjectsStore} from './backends/projects.js';
import {createBackend,closeAllBackends} from './backends/index.js';
import {propose,ratifyProposal} from './backends/proposals.js';
import {remember} from './tools/remember.js';
import {recall} from './tools/recall.js';
import {memoryList} from './tools/memory-list.js';
import {update} from './tools/update.js';
import {archive} from './tools/archive.js';
import {restore} from './tools/restore.js';
import {forget} from './tools/forget.js';
const cleanups:Array<()=>unknown|Promise<unknown>>=[];
afterEach(async()=>{closeAllBackends();for(const close of cleanups.splice(0).reverse())await close();vi.useRealTimers();vi.unstubAllEnvs();});
async function fixture(){
 const home=mkdtempSync(join(tmpdir(),'memory-semantic-fiction-'));cleanups.push(()=>rmSync(home,{recursive:true,force:true}));
 // Date is deterministic; real HTTP/socket scheduling is untouched.
 vi.useFakeTimers({toFake:['Date']});const at=Date.parse('2026-11-15T12:00:00Z');vi.setSystemTime(at);vi.stubEnv('LOOM_PUBLIC_URL',undefined);
 const clock=new FakeClock(at),database=join(home,'app.db'),client=new Database(database),db=createDataSchema(client);
 db.insert(members).values([{id:'owner',role:'owner',joinedAt:new Date(at).toISOString()},{id:'peer',role:'member',joinedAt:new Date(at).toISOString()}]).run();
 db.insert(agents).values({id:'fiction',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();db.insert(memberAgents).values({member:'owner',agent:'fiction'}).run();db.insert(household).values({defaultAgent:'fiction',timezone:'UTC'}).run();client.close();
 const directory=join(home,'agents/fiction'),common=join(home,'commons'),memory={checkingAgent:'fiction',sources:{commons:{directory:common,knowledge:join(common,'knowledge.db'),people:join(common,'people.db')},agents:[{agent:'fiction',directory,memories:join(directory,'memories.db')}]}};
 await prepareSharedMemorySources(memory);const selection={agent:'fiction'},poison=join(home,'unselected.db');vi.stubEnv('LOOM_SQLITE_DB_PATH',poison);
 vi.setSystemTime(at-90*86400000);const project=await remember(directory,{category:'project',title:'Alpha project fact',content:'alpha pump details',project:'pond'},selection);vi.setSystemTime(at);
 const preference=await remember(directory,{category:'user',title:'Beta preference',content:'beta preference',metadata:{person:'friend'}},selection);
 for(const path of [memory.sources.commons.people,memory.sources.agents[0].memories]){const people=new PeopleStore({dbPath:path,actor:'fiction'});people.write({slug:'friend',name:'Fictional friend',summary:'Fictional relationship'});people.close();}
 const projects=new ProjectsStore({dbPath:memory.sources.agents[0].memories});projects.write({slug:'pond',name:'Fictional pond'});projects.close();
 const webRoot=join(home,'web');mkdirSync(webRoot);writeFileSync(join(webRoot,'next.html'),'<main>Fictional shared app</main>');const commsKey=join(home,'comms.key');writeFileSync(commsKey,await generateX25519Identity(),{mode:0o600});writeFileSync(join(home,'program.json'),JSON.stringify({database,webRoot,commsKey,signinMember:'owner',memory}),{mode:0o600});
 let link='';const app=await startSharedHome({home,clock,port:0,stdout:text=>{link=text.trim();}});cleanups.push(()=>app.close());
 const login=async(url:string)=>{const response=await fetch(url,{method:'POST',redirect:'manual',headers:{origin:app.url}});expect(response.status).toBe(303);return response.headers.get('set-cookie')!.split(';',1)[0];};const cookie=await login(link);
 const query=async(source:string,as=cookie)=>{const response=await fetch(app.url+'/graphql',{method:'POST',headers:{cookie:as,origin:app.url,'content-type':'application/json'},body:JSON.stringify({query:source})});expect(response.status).toBe(200);const result=await response.json();expect(result.errors).toBeUndefined();return result.data;};
 const socket=new WebSocket(app.url.replace('http:','ws:')+'/graphql','graphql-transport-ws',{headers:{cookie,origin:app.url}});socket.on('error',()=>{});cleanups.push(()=>socket.terminate());await once(socket,'open');
 const next=async(action:()=>unknown)=>{const message=once(socket,'message');await action();return JSON.parse(String((await message)[0]));};expect((await next(()=>socket.send(JSON.stringify({type:'connection_init'})))).type).toBe('connection_ack');
 const observe=(source:string)=>next(()=>socket.send(JSON.stringify({type:'subscribe',id:'semantic',payload:{query:'subscription($query:String!){observe(query:$query){revision patches{path value removed}}}',variables:{query:source}}})));
 const peerLink=await requestLocalLink(home,{request:'link',member:'peer'}),peer=await login(app.url+peerLink.path);
 return {home,app,directory,selection,poison,project,preference,query,peer,next,observe};
}
it('ratifies real drafts into Activity, publishes core writes and keeps bounded history on the declared private store',async()=>{
 const f=await fixture(),query='{memoryActivity{entries{id title}} memoryPerson(id:"fiction:friend"){evidence{title content}}}';
 expect(await f.query(query)).toMatchObject({memoryActivity:{entries:[]},memoryPerson:{evidence:[{title:'Beta preference'}]}});await f.observe(query);
 const draft=propose(f.directory,{category:'episode',title:'Gamma drafted episode',content:'gamma fictional episode',ttl:'2d'},f.selection);
 expect(await memoryList(f.directory,{},f.selection)).not.toContain('Gamma drafted episode');expect(await recall(f.directory,{query:'gamma'},f.selection)).not.toContain('Gamma drafted episode');expect((await f.query(query)).memoryActivity.entries).toEqual([]);
 let episode!:Awaited<ReturnType<typeof ratifyProposal>>;const ratified=await f.next(async()=>{episode=await ratifyProposal(f.directory,draft.id,{},f.selection);});expect(JSON.stringify(ratified)).toContain('Gamma drafted episode');
 expect((await f.query(query)).memoryActivity.entries).toHaveLength(1);
 for(let i=0;i<12;i++)await f.next(()=>update(f.directory,{ref:f.preference.ref,content:`beta revision ${i}`},f.selection));
 expect(await createBackend(f.directory,f.selection).listRevisions(f.preference.ref)).toHaveLength(10);expect(JSON.stringify(await f.query(query))).toContain('beta revision 11');
 await f.next(()=>archive(f.directory,{ref:episode.ref},f.selection));expect((await f.query(query)).memoryActivity.entries).toEqual([]);
 await f.next(()=>restore(f.directory,{ref:episode.ref},f.selection));expect((await f.query(query)).memoryActivity.entries).toHaveLength(1);
 await f.next(()=>forget(f.directory,{ref:episode.ref},f.selection));expect((await f.query(query)).memoryActivity.entries).toEqual([]);
 const source=new Database(join(f.directory,'memories.db'),{readonly:true});try{expect(source.prepare('SELECT ref FROM memory_deletions WHERE ref=?').get(episode.ref)).toEqual({ref:episode.ref});}finally{source.close();}
 expect(await f.query(query,f.peer)).toMatchObject({memoryActivity:null,memoryPerson:null});expect(existsSync(f.poison)).toBe(false);
});
it('recalls from the declared store and adds heat without changing its content',async()=>{
 const f=await fixture();
 const source=new Database(join(f.directory,'memories.db'),{readonly:true});
 try{
  const row=()=>source.prepare('SELECT content,recall_heat,last_accessed FROM memories WHERE ref=?').get(f.project.ref) as {content:string;recall_heat:number|null;last_accessed:string|null};
  const before=row();
  for(let i=0;i<3;i++)expect(await recall(f.directory,{query:'alpha',project:'pond',limit:1},f.selection)).toContain('Alpha project fact');
  const after=row();expect(after.content).toBe(before.content);expect(after.recall_heat).toBeGreaterThan(before.recall_heat??0);expect(after.last_accessed).toBe(new Date().toISOString());
  expect(await f.query('{memoryProjectMemory(id:"fiction:'+f.project.ref+'"){content title}}')).toMatchObject({memoryProjectMemory:{content:before.content,title:'Alpha project fact'}});
  expect(existsSync(f.poison)).toBe(false);
 }finally{source.close();}
});
