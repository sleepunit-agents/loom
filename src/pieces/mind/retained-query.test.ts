import {afterEach,expect,it,vi} from 'vitest';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {GraphQLSchema,GraphQLObjectType,graphql} from 'graphql/index.js';
import {FakeClock,type Sharing,type Viewer} from '../../core/index.js';
import {SqliteVecBackend} from '../../backends/sqlite-vec.js';
import {propose,rejectProposal} from '../../backends/proposals.js';
import {createProjectsReader} from './projects.js';
import {readDeadline,keepReadUntil} from '../../core/data/read-lease.js';
import {retainedQueryFields} from './retained-query.js';
const close:Array<()=>void>=[];
afterEach(()=>{for(const stop of close.splice(0).reverse())stop();vi.unstubAllEnvs();});
const owner:Viewer={kind:'member',id:'owner'};
function fixture(legacy=false){
 const home=mkdtempSync(join(tmpdir(),'retained-memory-'));close.push(()=>rmSync(home,{recursive:true,force:true}));const path=join(home,'memories.db'),missing=join(home,'missing.db');
 const db=new Database(path);close.push(()=>db.close());
 const backend=legacy?undefined:new SqliteVecBackend({dbPath:path,notifyWrites:false},{dimensions:4,embed:async()=>[1,0,0,0],embedBatch:async texts=>texts.map(()=>[1,0,0,0])});if(backend)close.push(()=>backend.close());
 const sharing:Sharing={members:{owner:{owner:true,agents:[]},coowner:{owner:false,agents:['fiction']},peer:{owner:false,agents:[]}},projects:{pond:{members:['peer'],agents:['fiction']}},services:{}};
 const reader=createProjectsReader(new FakeClock(Date.now()),{agents:[{agent:'fiction',memories:path},{agent:'ghost',memories:missing}],sharing:()=>sharing});close.push(()=>reader.close());
 const schema=new GraphQLSchema({query:new GraphQLObjectType({name:'Query',fields:retainedQueryFields(reader)})});
 const query=(source:string,viewer:Viewer=owner,variables?:Record<string,unknown>)=>graphql({schema,source,contextValue:{viewer},variableValues:variables});
 return {home,path,db,backend,missing,sharing,schema,query,reader};
}
it('paginates archived memories and pending proposals from their declared file without changing it',async()=>{
 const f=fixture(),backend=f.backend!,refs:string[]=[];
 for(let i=0;i<3;i++){const made=await backend.remember({category:'project',title:'PRIVATE_ARCHIVE_'+i,content:'Archive words '+i});refs.push(made.ref);await backend.archive({ref:made.ref,note:'Reason '+i});}
 const active=await backend.remember({category:'project',title:'Active only',content:'Active words'});
 const first=propose(f.home,{category:'rough category',title:'PRIVATE_PROPOSAL_ONE',content:'Proposal words one',source:'fiction'},null),second=propose(f.home,{category:'project',title:'PRIVATE_PROPOSAL_TWO',content:'Proposal words two'},null);
 const before=f.db.serialize();vi.stubEnv('LOOM_SQLITE_DB_PATH',f.missing);
 const a=await f.query('{memoryArchive(agent:"fiction",first:2){entries{id ref title content note archivedAt} nextBefore}}');expect(a.errors).toBeUndefined();const page=a.data!.memoryArchive as {entries:{id:string;ref:string;note:string}[];nextBefore:string};expect(page.entries.map(row=>row.ref)).toEqual([refs[2],refs[1]]);expect(page.entries[0].id).toMatch(/^fiction:[a-f0-9-]{36}$/);expect(page.entries[0].note).toBe('Reason 2');
 const rest=await f.query('query($before:String!){memoryArchive(agent:"fiction",first:2,before:$before){entries{ref} nextBefore}}',owner,{before:page.nextBefore});expect(rest.errors).toBeUndefined();expect(rest.data).toEqual({memoryArchive:{entries:[{ref:refs[0]}],nextBefore:null}});
 const d=await f.query('{memoryProposals(agent:"fiction",first:1){entries{id title content category source} nextBefore}}');expect(d.errors).toBeUndefined();const proposal=d.data!.memoryProposals as {entries:{id:string;title:string}[];nextBefore:string};expect(proposal.entries).toMatchObject([{id:'fiction:proposal:'+second.uuid,title:'PRIVATE_PROPOSAL_TWO'}]);
 expect((await f.query('query($cursor:String!){memoryProposals(agent:"fiction",before:$cursor){entries{id title} nextBefore}}',owner,{cursor:proposal.nextBefore})).data).toEqual({memoryProposals:{entries:[{id:'fiction:proposal:'+first.uuid,title:'PRIVATE_PROPOSAL_ONE'}],nextBefore:null}});
 expect(f.db.serialize()).toEqual(before);expect(existsSync(f.missing)).toBe(false);expect((await backend.recall({query:'words'})).map(row=>row.path)).toEqual([active.ref]);
 expect(rejectProposal(f.home,second.id,null)).toBe(true);expect((await f.query('{memoryProposals(agent:"fiction"){entries{title}}}')).data).toEqual({memoryProposals:{entries:[{title:'PRIVATE_PROPOSAL_ONE'}]}});
});
it('checks current Memory visibility rather than project membership and never creates a missing source',async()=>{
 const f=fixture();const made=await f.backend!.remember({category:'project',title:'PRIVATE_OWNER_WORDS',content:'Private words'});await f.backend!.archive({ref:made.ref});
 const query='{memoryArchive(agent:"fiction"){entries{title}} memoryProposals(agent:"fiction"){entries{content}}}';
 for(const viewer of [{kind:'member',id:'peer'},{kind:'agent',id:'other'}] as Viewer[])expect((await f.query(query,viewer)).data).toEqual({memoryArchive:null,memoryProposals:null});
 expect(JSON.stringify((await f.query(query,{kind:'member',id:'coowner'})).data)).toContain('PRIVATE_OWNER_WORDS');f.sharing.members.coowner.agents=[];expect((await f.query(query,{kind:'member',id:'coowner'})).data).toEqual({memoryArchive:null,memoryProposals:null});
 expect((await graphql({schema:f.schema,source:query,contextValue:{}})).data).toEqual({memoryArchive:null,memoryProposals:null});expect((await f.query('{memoryArchive(agent:"ghost"){entries{title}}}')).data).toEqual({memoryArchive:null});expect(existsSync(f.missing)).toBe(false);
});
it('reads legacy rows with exact signed64-bit pagination cursors and no UUID or migration',async()=>{
 const f=fixture(true);f.db.exec("CREATE TABLE memories(id INTEGER PRIMARY KEY,ref TEXT,title TEXT,content TEXT,archived INTEGER);INSERT INTO memories VALUES(-1,'oldest','Oldest','Old words',1),(0,'middle','Middle','Middle words',1),(9223372036854775807,'newest','Newest','New words',1)");const before=f.db.serialize();
 const a=await f.query('{memoryArchive(agent:"fiction",first:1){entries{id ref} nextBefore}}');expect(a.errors).toBeUndefined();expect(a.data).toEqual({memoryArchive:{entries:[{id:null,ref:'newest'}],nextBefore:'9223372036854775807'}});
 const b=await f.query('{memoryArchive(agent:"fiction",first:1,before:"9223372036854775807"){entries{ref} nextBefore}}');expect(b.data).toEqual({memoryArchive:{entries:[{ref:'middle'}],nextBefore:'0'}});
 expect((await f.query('{memoryArchive(agent:"fiction",before:"0"){entries{ref} nextBefore} memoryProposals(agent:"fiction"){entries{title} nextBefore}}')).data).toEqual({memoryArchive:{entries:[{ref:'oldest'}],nextBefore:null},memoryProposals:{entries:[],nextBefore:null}});expect(f.db.serialize()).toEqual(before);
});
it('rejects invalid bounds and sanitizes unsupported or closed source errors',async()=>{
 const f=fixture(true);for(const args of ['first:0','first:201','before:"1 OR 1=1"','before:"9223372036854775808"','before:"-9223372036854775809"']){const result=await f.query(`{memoryArchive(agent:"fiction",${args}){nextBefore}}`);expect(result.errors?.[0].message).toBe('Retained Memory selection is invalid');}
 f.db.exec('CREATE TABLE memories(id INTEGER PRIMARY KEY,content TEXT)');const before=f.db.serialize(),result=await f.query('{memoryArchive(agent:"fiction"){entries{content}}}');expect(result.errors?.[0].message).toBe('Retained Memory is unavailable');expect(JSON.stringify(result)).not.toContain(f.path);expect(f.db.serialize()).toEqual(before);f.reader.close();expect((await f.query('{memoryArchive(agent:"fiction"){entries{content}}}')).errors?.[0].message).toBe('Retained Memory is unavailable');
});

it('keeps explicit retained words outside current-memory freshness leases without clearing other selected deadlines',async()=>{
 const f=fixture(),made=await f.backend!.remember({category:'project',title:'Retained only',content:'Retained words',ttl:'1h'});await f.backend!.archive({ref:made.ref});propose(f.home,{category:'project',title:'Proposal only',content:'Proposed words'},null);
 const source='{memoryArchive(agent:"fiction"){entries{content}} memoryProposals(agent:"fiction"){entries{content}}}',context={viewer:owner};
 const selected=await graphql({schema:f.schema,source,contextValue:context});expect(selected.errors).toBeUndefined();expect(selected.data).toEqual({memoryArchive:{entries:[{content:'Retained words'}]},memoryProposals:{entries:[{content:'Proposed words'}]}});expect(readDeadline(context)).toBeUndefined();
 keepReadUntil(context,123);expect((await graphql({schema:f.schema,source,contextValue:context})).errors).toBeUndefined();expect(readDeadline(context)).toBe(123);
});

it('returns fifty records by default, follows the remaining page, and accepts the two-hundred maximum',async()=>{
 const f=fixture(true);f.db.exec('CREATE TABLE memories(id INTEGER PRIMARY KEY,title TEXT,archived INTEGER);CREATE TABLE proposals(id INTEGER PRIMARY KEY,title TEXT,status TEXT)');
 f.db.transaction(()=>{for(let i=1;i<=51;i++){f.db.prepare('INSERT INTO memories VALUES(?,?,1)').run(i,'Archived '+i);f.db.prepare("INSERT INTO proposals VALUES(?,?,'pending')").run(i,'Proposal '+i);}})();const before=f.db.serialize();
 for(const field of ['memoryArchive','memoryProposals']){
  const first=await f.query(`{${field}(agent:"fiction"){entries{title} nextBefore}}`);expect(first.errors).toBeUndefined();const page=first.data![field] as {entries:{title:string}[];nextBefore:string};expect(page.entries).toHaveLength(50);expect(page.nextBefore).toBe('2');
  const last=await f.query(`{${field}(agent:"fiction",before:"2"){entries{title} nextBefore}}`);expect(last.errors).toBeUndefined();expect(last.data![field]).toEqual({entries:[{title:field==='memoryArchive'?'Archived 1':'Proposal 1'}],nextBefore:null});
  const maximum=await f.query(`{${field}(agent:"fiction",first:200){entries{title} nextBefore}}`);expect(maximum.errors).toBeUndefined();const complete=maximum.data![field] as {entries:unknown[];nextBefore:null};expect(complete.entries).toHaveLength(51);expect(complete.nextBefore).toBeNull();
 }expect(f.db.serialize()).toEqual(before);
});
