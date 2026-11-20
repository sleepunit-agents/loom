/** Every start of `loom serve` checks every store it opens: one an older program left is brought up to
 * date before anything writes to it, and one a newer program has changed stops the start, unaltered. */
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import Database from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FakeClock} from './core/clock.js';
import {dataDatabase} from './core/data/database.js';
import {sharedTokens} from './core/signin/shared-tokens.js';
import {MIGRATIONS} from './backends/migrations.js';
import {notesDbPath} from './notes.js';
import {startSharedHome,StartupRefusal} from './shared-startup.js';
import {serve} from './index.js';
vi.mock('./shared-holder-process.js',async()=>({startSharedHolder:vi.fn((await import('../test/fixtures/shared-holder.js')).inProcessSharedHolder)}));
vi.mock('./backends/fastembed.js',()=>({FastEmbedProvider:class{
 readonly dimensions=4;
 async embed(){return [1,0,0,0];}
 async embedBatch(texts:string[]){return texts.map(()=>[1,0,0,0]);}
}}));
beforeEach(()=>{vi.stubEnv('LOOM_PUBLIC_URL',undefined);vi.stubEnv('LOOM_WORKER_SOCKET',undefined);});
const clean:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();vi.unstubAllEnvs();});
type App=Awaited<ReturnType<typeof startSharedHome>>;
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'store-versions-')),home=join(root,'home'),webRoot=join(root,'web');mkdirSync(home);mkdirSync(webRoot);writeFileSync(join(webRoot,'next.html'),'Shared app');
 clean.push(()=>rmSync(root,{recursive:true,force:true}));
 const clock=new FakeClock();
 let app:App|undefined;
 const start=async()=>{app=await startSharedHome({home,webRoot,port:0,clock,stdout:()=>{}});const started=app;clean.push(()=>started.close());return started;};
 const stop=async()=>{await app?.close();app=undefined;};
 const agentToken=()=>{const client=new Database(join(home,'loom.db'));try{return sharedTokens(dataDatabase(client,()=>new Date(clock.now()).toISOString()),clock).issue({kind:'agent',agent:'assistant',label:'Terminal '+randomUUID()}).token;}finally{client.close();}};
 const signIn=async()=>{const response=await fetch(app!.signinLink(),{method:'POST',redirect:'manual'});expect(response.status).toBe(303);return {cookie:response.headers.get('set-cookie')!.split(';')[0]};};
 const call=async(path:string,input:unknown,who:{token:string}|{cookie:string})=>{
  const response=await fetch(app!.url+'/api/'+path,{method:'POST',headers:{...('token' in who?{authorization:'Bearer '+who.token}:{cookie:who.cookie}),origin:app!.url,'content-type':'application/json'},body:JSON.stringify({id:randomUUID(),input})});
  return await response.json() as {ok:boolean;value?:any;error?:unknown};
 };
 const agent=join(home,'agents/assistant');
 const files={knowledge:join(home,'commons/knowledge.db'),people:join(home,'commons/people.db'),memories:join(agent,'memories.db'),notes:notesDbPath(agent)};
 return {home,webRoot,files,start,stop,agentToken,signIn,call};
}
function raw<T>(path:string,work:(db:Database.Database)=>T):T{const db=new Database(path,{fileMustExist:true});try{return work(db);}finally{db.close();}}
const version=(path:string)=>raw(path,db=>db.pragma('user_version',{simple:true}) as number);
const columns=(path:string,table:string)=>raw(path,db=>(db.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[]).map(column=>column.name));
const tables=(path:string)=>raw(path,db=>(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all() as {name:string}[]).map(table=>table.name));
const shape=(path:string)=>raw(path,db=>db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY name').all());

it('brings stores an older program left up to date at start, and then writes to them',async()=>{
 const f=fixture();await f.start();
 const owner=await f.signIn(),token=f.agentToken();
 expect(await f.call('mind/knowledgeAdd',{title:'Kept fact',domain:'fiction',body:'Words from before the upgrade'},owner)).toMatchObject({ok:true});
 expect(await f.call('memory/remember',{category:'project',title:'Kept memory',content:'Remembered before the upgrade'},{token})).toMatchObject({ok:true});
 await f.stop();
 // As each file was one step ago: without what its newest step added, and with the earlier number.
 raw(f.files.knowledge,db=>{db.exec('ALTER TABLE pages DROP COLUMN author; ALTER TABLE page_revisions DROP COLUMN actor');db.pragma('user_version = 0');});
 raw(f.files.people,db=>{db.exec('DROP TABLE person_merges');db.pragma(`user_version = ${MIGRATIONS.length-1}`);});
 raw(f.files.memories,db=>{db.exec('ALTER TABLE memories DROP COLUMN authored_at; DROP TABLE person_merges');db.pragma(`user_version = ${MIGRATIONS.length-1}`);});
 raw(f.files.notes,db=>{db.pragma('user_version = 0');});
 expect(columns(f.files.knowledge,'pages')).not.toContain('author');expect(columns(f.files.memories,'memories')).not.toContain('authored_at');

 await f.start();
 expect(columns(f.files.knowledge,'pages')).toContain('author');expect(columns(f.files.knowledge,'page_revisions')).toContain('actor');
 expect(tables(f.files.people)).toContain('person_merges');
 expect(columns(f.files.memories,'memories')).toContain('authored_at');expect(tables(f.files.memories)).toContain('person_merges');
 expect([version(f.files.knowledge),version(f.files.people),version(f.files.memories),version(f.files.notes)]).toEqual([1,MIGRATIONS.length,MIGRATIONS.length,1]);
 // What was there is still there, and each store takes a write that needs the step it had lacked.
 const again=await f.signIn();
 expect(raw(f.files.knowledge,db=>db.prepare('SELECT body FROM pages').all())).toEqual([{body:'Words from before the upgrade'}]);
 expect(await f.call('mind/knowledgeAdd',{title:'Later fact',domain:'fiction',body:'Words from after the upgrade'},again)).toMatchObject({ok:true});
 expect(raw(f.files.knowledge,db=>db.prepare("SELECT author FROM pages WHERE slug='later-fact'").get())).toEqual({author:expect.any(String)});
 expect(await f.call('mind/personAdd',{name:'Later Friend'},again)).toMatchObject({ok:true,value:{slug:'later-friend'}});
 expect(await f.call('memory/remember',{category:'project',title:'Later memory',content:'Remembered after the upgrade'},{token})).toMatchObject({ok:true});
 expect(raw(f.files.memories,db=>db.prepare('SELECT title FROM memories ORDER BY id').all())).toEqual([{title:'Kept memory'},{title:'Later memory'}]);
});

it.each(['knowledge','people','memories','notes'] as const)('refuses to start on a %s store a newer program has changed, and leaves it as it is',async store=>{
 const f=fixture();await f.start();await f.stop();
 const path=f.files[store];
 raw(path,db=>{db.exec('CREATE TABLE from_the_future (words TEXT)');db.pragma('user_version = 99');});
 const before=shape(path);
 await expect(f.start()).rejects.toThrow(StartupRefusal);
 await expect(f.start()).rejects.toThrow(`The Memory file ${path} cannot be used by this program`);
 await expect(f.start()).rejects.toThrow('newer program');
 expect(shape(path)).toEqual(before);expect(version(path)).toBe(99);
 // The CLI reads its web root from the private program file. Use the same fixture
 // assets as start() so a checkout without a built web app reaches the store check.
 const program = join(f.home,'program.json');
 writeFileSync(program,JSON.stringify({...JSON.parse(readFileSync(program,'utf8')), webRoot:f.webRoot}));
 // The operator is told which file and why.
 const printed:string[]=[];
 expect(await serve(['--home',f.home,'--port','0'],{stdout:()=>{},stderr:text=>printed.push(text)})).toBe(2);
 expect(printed.join('')).toContain(`Startup refused. The Memory file ${path} cannot be used by this program`);
 // Put back as this program left it, the same home starts.
 raw(path,db=>{db.exec('DROP TABLE from_the_future');db.pragma(`user_version = ${store==='knowledge'||store==='notes'?1:MIGRATIONS.length}`);});
 await f.start();
});
