import {afterEach,expect,it} from 'vitest';
import Database from 'better-sqlite3';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync}from'node:fs';
import {tmpdir}from'node:os';
import {join,dirname}from'node:path';
import {openDb}from'../../core/index.js';
import {importBridges}from'./importer.js';
import {readBridgeImport,type BridgeImportSources}from'./import-plan.js';
import type {BridgeSourceFile}from'./import-source.js';
const roots:string[]=[];afterEach(()=>{for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
const h={agents:['art','mark'],members:['jonathan','loren']};
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'bridges-import-'));roots.push(root);
 const file=(name:string,kind:BridgeSourceFile['kind'],value:unknown)=>{const path=join(root,name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(value));return{name,path,kind};};
 const sources:BridgeImportSources={files:[file('instance/shuttle.json','shuttle',{agent:{slug:'art'},discord:{token_file:'/never/open'}}),file('instance/people.json','people',{people:{jonathan:{discord:['123']}}}),file('instance/routes.json','routes',{guild:'789',bots:{art:'100'},channels:{'300':{primary:'art'}}})],stores:[]};
 const options={instances:[{shuttle:'instance/shuttle.json',people:'instance/people.json',routes:'instance/routes.json'}],connections:[{agent:'art',platform:'discord',workspace:'789',bot:'100',tokenSecret:'art-discord'}]};
 const store=(kind:'shuttle'|'runtime',docs:[string,string,unknown][])=>{
  const path=join(root,`${kind}.db`),d=new Database(path);d.exec('CREATE TABLE docs(collection TEXT,key TEXT,doc TEXT,rev INTEGER,updated TEXT,by TEXT);CREATE TABLE revisions(id INTEGER,collection TEXT,key TEXT,doc TEXT,rev INTEGER,op TEXT,at TEXT,by TEXT)');
  for(const[c,k,v]of docs)d.prepare('INSERT INTO docs VALUES (?,?,?,1,?,?)').run(c,k,JSON.stringify(v),'today','owner');d.close();sources.stores.push({name:`${kind}.db`,path,kind});
 };
 const open=(path:string)=>new Database(path,{readonly:true,fileMustExist:true});return{root,sources,options,store,open};
}
it('imports source-derived disabled setup, compares every row, repeats and refuses a changed mapping',()=>{
 const f=fixture(),{db,close}=openDb(join(f.root,'new'));
 try{
  const result=importBridges(db,f.sources,f.options,h,f.open);expect(result.imported).toBe(true);
  expect(JSON.parse((db.prepare('SELECT record FROM bridges_venues').get()as{record:string}).record)).toMatchObject({enabled:false,agent:'art',bot:'100',tokenSecret:'art-discord'});
  expect(JSON.parse((db.prepare('SELECT record FROM bridges_links').get()as{record:string}).record)).toMatchObject({person:'jonathan',user:'123'});
  expect(importBridges(db,f.sources,f.options,h,f.open).imported).toBe(false);
  expect(()=>importBridges(db,f.sources,{...f.options,connections:[{...f.options.connections[0],tokenSecret:'different'}]},h,f.open)).toThrow('different Bridges source');
 }finally{close();}
});
it('rolls back schema and rows on interruption and refuses populated destinations',()=>{
 const f=fixture(),{db,close}=openDb(join(f.root,'new'));try{
 expect(()=>importBridges(db,f.sources,f.options,h,f.open,{interrupt:()=>{throw Error('interrupted');}})).toThrow('interrupted');
 expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='bridges_venues'").get()).toBeUndefined();
 importBridges(db,f.sources,f.options,h,f.open);db.prepare("DELETE FROM bridges_meta WHERE key='source-checksum'").run();
 expect(()=>importBridges(db,f.sources,f.options,h,f.open)).toThrow('must be empty');
 }finally{close();}
});
it('selects Runtime people before shuttle and file, retaining every exact private store row',()=>{
 const f=fixture();f.store('shuttle',[['people','art',{people:{loren:{discord:['456']}}}],['moved','art',{}],['proposals','pending',{discord:['bad']}]]);
 f.store('runtime',[['gates','art',{people:{jonathan:{discord:['999']}}}],['unknown','private',{opaque:'words'}]]);
 const s=readBridgeImport(f.sources,f.options,h,f.open);expect(s.expected.links.map(l=>l.user)).toEqual(['999']);
 expect(JSON.parse(s.evidence).stores.stores.flatMap((s:{documents:unknown[]})=>s.documents)).toHaveLength(5);
});
it('refuses moved-without-Runtime rather than falling back to stale people',()=>{
 const f=fixture();f.store('shuttle',[['moved','art',{}],['people','art',{people:{jonathan:{discord:['old']}}}]]);
 expect(()=>readBridgeImport(f.sources,f.options,h,f.open)).toThrow('Invalid offline');
});
it('assembles all accepted agent parts and flags, never proposal flags',()=>{
 const f=fixture();f.store('shuttle',[['routes','household',{guild:'789',channel_names:{'300':'work'}}],['channels','art',{bot:'100',answers:{'300':'work'},flags:{'300':{guest_venue:true,readers:['jonathan']}}}],['channels','mark',{bot:'200',answers:{'400':'mark'},threads:{'500':{primary:'mark',parent:'400',peer:true}}}],['route-offers','art',{doc:{bots:{art:'100',mark:'200'},channels:{'300':{peer:true}}}}]]);
 const s=readBridgeImport(f.sources,f.options,h,f.open);expect(s.expected.routes).toEqual(expect.arrayContaining([expect.objectContaining({channel:'300',guest:true,peer:false,readers:['jonathan']}),expect.objectContaining({channel:'400',primary:'mark'}),expect.objectContaining({channel:'500',parent:'400',peer:false})]));
});
it('falls back to files when accepted routes lack an offered agent part',()=>{
 const f=fixture();f.store('shuttle',[['routes','household',{guild:'wrong'}],['channels','art',{bot:'wrong'}],['route-offers','art',{doc:{bots:{art:'100',mark:'200'}}}]]);
 expect(readBridgeImport(f.sources,f.options,h,f.open).expected.venues[0].workspace).toBe('789');
});
it('refuses contradictory identities, route claims and incomplete mapping',()=>{
 const f=fixture();writeFileSync(f.sources.files[1].path,JSON.stringify({people:{jonathan:{discord:['123']},loren:{discord:['123']}}}));
 expect(()=>readBridgeImport(f.sources,f.options,h,f.open)).toThrow();
 writeFileSync(f.sources.files[1].path,'{}');f.store('shuttle',[['routes','household',{guild:'789'}],['channels','art',{bot:'100',answers:{'300':'a'}}],['channels','mark',{bot:'200',answers:{'300':'b'}}]]);
 expect(()=>readBridgeImport(f.sources,f.options,h,f.open)).toThrow();
 expect(()=>readBridgeImport(f.sources,{...f.options,connections:[]},h,f.open)).toThrow();
});
