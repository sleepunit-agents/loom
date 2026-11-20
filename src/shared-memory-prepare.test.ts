/** First-start preparation of the declared Memory files is all-or-nothing: a start that stops
 * part-way leaves no file under its real name that a later start would take for a prepared one. */
import {afterEach,expect,it,vi} from 'vitest';
import Database,{type Database as Connection} from 'better-sqlite3';
import {existsSync,mkdirSync,mkdtempSync,readdirSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
const stop=vi.hoisted(()=>({opens:0,at:0,links:0,linkAt:0}));
// Every step of preparation opens the file it works on, so refusing the Nth open stops
// preparation before its Nth step, as a kill there would: nothing after it runs.
vi.mock('better-sqlite3',async importOriginal=>{
 const original=await importOriginal<{default:typeof Database}>();
 return {default:new Proxy(original.default,{construct(target,args,newTarget){if(++stop.opens===stop.at)throw Error('interrupted before open '+stop.at);return Reflect.construct(target,args,newTarget) as Connection;}})};
});
vi.mock('node:fs',async importOriginal=>{
 const original=await importOriginal<typeof import('node:fs')>();
 return {...original,linkSync:(...args:Parameters<typeof original.linkSync>)=>{if(++stop.links===stop.linkAt)throw Error('interrupted before naming '+stop.linkAt);return original.linkSync(...args);}};
});
import {prepareSharedMemorySources} from './shared-memory.js';
import {notesDbPath} from './notes.js';
import {mindReceiptsReady} from './pieces/mind/receipt-schema.js';
import {semanticMemoryReady,semanticCardsReady} from './pieces/mind/semantic-schema.js';
const cleanup:Array<()=>void>=[];
afterEach(()=>{stop.at=0;stop.linkAt=0;for(const close of cleanup.splice(0).reverse())close();});
function fixture(){
 const home=mkdtempSync(join(tmpdir(),'memory-prepare-'));cleanup.push(()=>rmSync(home,{recursive:true,force:true}));
 const commons=join(home,'commons'),agent=join(home,'agents/fiction');
 const memory={checkingAgent:'fiction',sources:{commons:{directory:commons,knowledge:join(commons,'knowledge.db'),people:join(commons,'people.db')},agents:[{agent:'fiction',directory:agent,memories:join(agent,'memories.db')}]}};
 const files=[memory.sources.commons.knowledge,memory.sources.commons.people,notesDbPath(agent),memory.sources.agents[0].memories];
 return {home,memory,files};
}
const tables=(db:Connection)=>(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all() as {name:string}[]).map(row=>row.name);
/** A file under its real name is whole: its own tables, its receipts and, for an agent's memories, the command and card tables. */
function whole(path:string){
 const db=new Database(path,{readonly:true,fileMustExist:true});
 try{
  expect(mindReceiptsReady(db)).toBe(true);
  const names=tables(db);
  if(path.endsWith('knowledge.db'))expect(names).toContain('pages');
  if(path.endsWith('people.db'))expect(names).toContain('people');
  if(path.endsWith('notes.db'))expect(names).toContain('notes');
  if(path.endsWith('memories.db')){expect(names).toEqual(expect.arrayContaining(['people','projects']));expect(semanticMemoryReady(db)).toBe(true);expect(semanticCardsReady(db)).toBe(true);}
 }finally{db.close();}
}
const leftovers=(files:string[])=>files.flatMap(path=>existsSync(dirname(path))?readdirSync(dirname(path)).filter(name=>name.includes('.preparing')):[]);
async function run(f:ReturnType<typeof fixture>,at:{open?:number;link?:number}){
 stop.opens=0;stop.links=0;stop.at=at.open??0;stop.linkAt=at.link??0;
 try{await prepareSharedMemorySources(f.memory);return true;}catch(error){expect(String(error)).toContain('interrupted before');return false;}
 finally{stop.at=0;stop.linkAt=0;}
}
it('leaves only whole files when preparation stops before any of its steps, and the next start finishes',async()=>{
 const clean=fixture();expect(await run(clean,{})).toBe(true);const opens=stop.opens,links=stop.links;
 expect(opens).toBeGreaterThan(8);expect(links).toBe(clean.files.length);for(const path of clean.files)whole(path);
 const interrupted=[...Array.from({length:opens},(_,index)=>({open:index+1})),...Array.from({length:links},(_,index)=>({link:index+1}))];
 for(const at of interrupted){
  const f=fixture();expect(await run(f,at)).toBe(false);
  // Whatever has its real name is whole; the one being made does not have it yet.
  const present=f.files.filter(path=>existsSync(path));expect(present.length).toBeLessThan(f.files.length);for(const path of present)whole(path);
  expect(await run(f,{})).toBe(true);
  for(const path of f.files){whole(path);expect(statSync(path).mode&0o777).toBe(0o600);}
  expect(leftovers(f.files)).toEqual([]);
 }
});
it('replaces an empty file left under the real name by a start that was killed as it created it',async()=>{
 const f=fixture();for(const path of f.files){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,'');}
 expect(await run(f,{})).toBe(true);for(const path of f.files)whole(path);
});
