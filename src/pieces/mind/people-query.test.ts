import { afterEach,expect,it } from 'vitest';
import { existsSync,mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { GraphQLObjectType,GraphQLSchema,graphql } from 'graphql/index.js';
import { createDataSchema } from '../../core/data/database.js';
import { dataQueries } from '../../core/data/queries.js';
import { PeopleStore } from '../../backends/people.js';
import type { Sharing,Viewer } from '../../policy.js';
import { peopleQueryFields } from './people-query.js';
import { peopleReader } from './people.js';
import { ProjectsStore } from '../../backends/projects.js';
import type { PeopleConversations } from './people-conversations.js';
const homes:string[]=[],closes:Array<()=>void>=[];
afterEach(()=>{for(const close of closes.splice(0).reverse())close();for(const home of homes.splice(0))rmSync(home,{recursive:true,force:true});});
function home(){const path=mkdtempSync(join(tmpdir(),'people-query-'));homes.push(path);return path;}
function store(path:string){const s=new PeopleStore({dbPath:path,actor:'fiction'});closes.push(()=>s.close());return s;}
function fixture(directory:string,agents:Array<{agent:string;memories:string}>,conversations?:PeopleConversations) {
 let now=Date.parse('2026-11-14T18:00:00Z');
 const sharing:Sharing={members:{owner:{owner:true,agents:[]},member:{owner:false,agents:['fiction']},peer:{owner:false,agents:[]}},projects:{team:{members:['peer'],agents:['fiction']}}};
 const fields=peopleQueryFields({directory,agents,sharing:()=>sharing,now:()=>now,conversations});closes.push(fields.close);
 const db=new Database(':memory:');closes.push(()=>db.close());createDataSchema(db);const generated=dataQueries(db,{tables:['tasks'],visibility:{tasks:()=>sql`true`}});
 const schema=new GraphQLSchema({query:new GraphQLObjectType({name:'Query',fields:{...generated.getQueryType()!.toConfig().fields,...fields.fields}})});
 const query=(source:string,viewer:Viewer={kind:'member',id:'owner'})=>graphql({schema,source,contextValue:{viewer}});
 return {query,sharing,generated,at:(time:number)=>{now=time;}};
}
it('composes generated fields and complete typed cards including value kinds, provenance and ten prior versions',async()=>{
 const path=join(home(),'people.db'),s=store(path);
 s.write({slug:'friend',name:'Fictional Friend',where:{channel:{value:['one','two'],label:'Channels',source:'a conversation',verified_at:'2026-11-13T00:00:00Z',stale_after_days:30}},how:{count:3,enabled:true,style:'direct'},may:[{text:'A recorded statement',source:'fiction'}]});
 for(let i=0;i<12;i++)s.write({slug:'friend',summary:`Version ${i}`});
 const f=fixture(path,[]);
 expect((await graphql({schema:f.generated,source:'{ memoryPeople { id } }'})).errors?.[0].message).toContain('Cannot query field "memoryPeople"');
 const result=await f.query('{ tasks { id } memoryPerson(id:"commons:friend") { name card { summary where { key value { strings text number boolean } label source verified_at stale_after_days } how { key value { text number boolean } } may { text source } } history { op actor card { summary where { key value { strings } label source verified_at stale_after_days } how { key value { text number boolean } } may { text source } } } } }');
 expect(result.errors).toBeUndefined();
 expect(result.data).toMatchObject({tasks:[],memoryPerson:{name:'Fictional Friend',card:{summary:'Version 11',where:[{key:'channel',value:{strings:['one','two'],text:null,number:null,boolean:null},label:'Channels',source:'a conversation',verified_at:'2026-11-13T00:00:00Z',stale_after_days:30}],how:expect.arrayContaining([{key:'count',value:{text:null,number:3,boolean:null}},{key:'enabled',value:{text:null,number:null,boolean:true}},{key:'style',value:{text:'direct',number:null,boolean:null}}]),may:[{text:'A recorded statement',source:'fiction'}]},history:Array.from({length:10},(_,i)=>({op:'write',actor:'fiction',card:{summary:`Version ${10-i}`,where:[{key:'channel',value:{strings:['one','two']},label:'Channels',source:'a conversation',verified_at:'2026-11-13T00:00:00Z',stale_after_days:30}],how:expect.arrayContaining([{key:'count',value:{text:null,number:3,boolean:null}},{key:'enabled',value:{text:null,number:null,boolean:true}},{key:'style',value:{text:'direct',number:null,boolean:null}}]),may:[{text:'A recorded statement',source:'fiction'}]}}))}});
});
it('lazily reads conversation metadata with the authenticated viewer after card visibility',async()=>{
 const h=home(),a=store(join(h,'a.db'));a.write({slug:'friend',name:'Friend'});
 const calls:Array<{viewer:Viewer;person:string}>=[];
 const f=fixture(join(h,'absent.db'),[{agent:'fiction',memories:a.database.name}],{list(viewer,person){
  calls.push({viewer,person});return {available:true,rows:[{id:'cv-fiction',title:'Fictional conversation',href:'/conversation/cv-fiction'}]};
 }});
 expect(await f.query('{ memoryPerson(id:"fiction:friend") { name } }')).toMatchObject({data:{memoryPerson:{name:'Friend'}}});
 expect(calls).toEqual([]);
 const query='{ memoryPerson(id:"fiction:friend") { conversations { available rows { id title href } } } }';
 expect(await f.query(query,{kind:'member',id:'peer'})).toEqual({data:{memoryPerson:null}});expect(calls).toEqual([]);
 const viewer:Viewer={kind:'agent',id:'fiction'};
 expect(await f.query(query,viewer)).toEqual({data:{memoryPerson:{conversations:{available:true,rows:[{id:'cv-fiction',title:'Fictional conversation',href:'/conversation/cv-fiction'}]}}}});
 expect(calls).toEqual([{viewer,person:'friend'}]);
 f.sharing.members.member.agents=[];
 expect(await f.query(query,{kind:'member',id:'member'})).toEqual({data:{memoryPerson:null}});expect(calls).toHaveLength(1);
 const absent=fixture(join(h,'absent.db'),[{agent:'fiction',memories:a.database.name}]);
 expect(await absent.query(query)).toEqual({data:{memoryPerson:{conversations:{available:false,rows:[]}}}});
});
it('reads current conversation metadata and hides adapter failures behind a generic field error',async()=>{
 const h=home(),a=store(join(h,'a.db'));a.write({slug:'friend',name:'Friend'});
 let available=true,failed=false;
 const f=fixture(join(h,'absent.db'),[{agent:'fiction',memories:a.database.name}],{list(){
  if(failed)throw Error('PRIVATE SQL source /private/path');
  return {available,rows:available?[{id:'cv-fiction',title:'Fictional conversation',href:'/conversation/cv-fiction'}]:[]};
 }});
 const query='{ memoryPerson(id:"fiction:friend") { name conversations { available rows { id } } } }';
 expect(await f.query(query)).toMatchObject({data:{memoryPerson:{conversations:{available:true,rows:[{id:'cv-fiction'}]}}}});
 available=false;
 expect(await f.query(query)).toEqual({data:{memoryPerson:{name:'Friend',conversations:{available:false,rows:[]}}}});
 failed=true;
 const result=await f.query(query);
 expect(result.data).toEqual({memoryPerson:{name:'Friend',conversations:null}});
 expect(result.errors?.map(e=>({message:e.message,path:e.path}))).toEqual([{message:'People conversations are unavailable',path:['memoryPerson','conversations']}]);
 expect(JSON.stringify(result)).not.toContain('PRIVATE SQL');
});
it('keeps agent cards private despite project membership and applies current ownership on each query',async()=>{
 const h=home(),d=store(join(h,'directory.db')),a=store(join(h,'a.db')),b=store(join(h,'b.db'));
 d.write({slug:'friend',name:'Directory'});a.write({slug:'friend',name:'Private A'});b.write({slug:'friend',name:'Private B'});
 const f=fixture(d.database.name,[{agent:'fiction',memories:a.database.name},{agent:'other',memories:b.database.name}]);
 const query='{ memoryPeople { id } memoryPerson(id:"other:friend") { card { summary } history { id } } }';
 expect(await f.query(query,{kind:'member',id:'member'})).toEqual({data:{memoryPeople:[{id:'fiction:friend'}],memoryPerson:null}});
 expect(await f.query(query,{kind:'member',id:'peer'})).toEqual({data:{memoryPeople:[],memoryPerson:null}});
 expect(await f.query(query,{kind:'agent',id:'fiction'})).toEqual({data:{memoryPeople:[{id:'fiction:friend'}],memoryPerson:null}});
 expect(await f.query(query,{kind:'runner',id:'machine'})).toEqual({data:{memoryPeople:[],memoryPerson:null}});
 f.sharing.members.member.agents=[];
 expect(await f.query('{ memoryPeople { id } memoryPerson(id:"fiction:friend") { name } }',{kind:'member',id:'member'})).toEqual({data:{memoryPeople:[],memoryPerson:null}});
 expect((await f.query('{ memoryPeople(viewer:"owner") { id } }')).errors).toBeDefined();
});
it('reads current commits, merge redirects and archive state, and excludes expired evidence',async()=>{
 const h=home(),d=store(join(h,'directory.db')),a=store(join(h,'a.db'));
 d.write({slug:'friend',name:'Friend'});a.write({slug:'friend',name:'Friend',summary:'Before'});
 a.database.exec(`CREATE TABLE memories(created TEXT,category TEXT,title TEXT,content TEXT,metadata TEXT,archived INTEGER,expires_at TEXT);
 INSERT INTO memories VALUES('2026-11-14T00:00:00Z','user','Evidence','Full evidence','{"person":"friend"}',0,'2026-11-15T00:00:00Z')`);
 const f=fixture(d.database.name,[{agent:'fiction',memories:a.database.name}]);
 const query='{ memoryPerson(id:"fiction:friend") { card { summary } evidence { content } fields { state } } }';
 expect(await f.query(query)).toMatchObject({data:{memoryPerson:{card:{summary:'Before'},evidence:[{content:'Full evidence'}]}}});
 a.write({slug:'friend',summary:'After'});f.at(Date.parse('2026-11-15T00:00:00Z'));
 expect(await f.query(query)).toMatchObject({data:{memoryPerson:{card:{summary:'After'},evidence:[]}}});
 d.database.exec("INSERT INTO person_merges VALUES('former','friend','2026-11-14T00:00:00Z','fiction','{}')");
 expect(await f.query('{ memoryPerson(id:"fiction:former") { slug mergedFrom } }')).toEqual({data:{memoryPerson:{slug:'friend',mergedFrom:'former'}}});
 d.archive({slug:'friend',actor:'fiction',reason:'Retired'});
 expect(await f.query(query)).toEqual({data:{memoryPerson:null}});
});
it('leaves missing files absent and returns generic source errors only to visible callers',async()=>{
 const h=home(),path=join(h,'absent.db'),f=fixture(path,[]);
 expect(await f.query('{ memoryPeople { id } }')).toEqual({data:{memoryPeople:[]}});expect(existsSync(path)).toBe(false);
 const broken=join(h,'broken.db');writeFileSync(broken,'PRIVATE SOURCE');const bad=fixture(broken,[]);
 const query='{ memoryPeople { id } memoryPerson(id:"commons:friend") { name } }';
 expect(await bad.query(query,{kind:'member',id:'peer'})).toEqual({data:{memoryPeople:[],memoryPerson:null}});
 const result=await bad.query(query);expect(result.errors?.map(e=>e.message)).toEqual(['People are unavailable','People are unavailable']);
 expect(JSON.stringify(result)).not.toContain(broken);expect(JSON.stringify(result)).not.toContain('PRIVATE SOURCE');
});

it('isolates inaccessible source failures from healthy authorized cards',async()=>{
 const h=home(),a=store(join(h,'a.db')),d=store(join(h,'directory.db'));a.write({slug:'friend',name:'Healthy'});d.write({slug:'friend',name:'Directory'});
 const f=fixture(d.database.name,[{agent:'fiction',memories:a.database.name},{agent:'hidden',memories:h}]);
 expect(await f.query('{ memoryPeople { name } memoryPerson(id:"fiction:friend") { name } }',{kind:'member',id:'member'})).toEqual({data:{memoryPeople:[{name:'Healthy'}],memoryPerson:{name:'Healthy'}}});
 const owner=await f.query('{ memoryPerson(id:"hidden:friend") { name } }');expect(owner.errors?.[0].message).toBe('People are unavailable');
 const broken=join(h,'broken-directory.db');writeFileSync(broken,'private source');
 const g=fixture(broken,[{agent:'fiction',memories:a.database.name}]);
 expect(await g.query('{ memoryPerson(id:"fiction:friend") { name } }',{kind:'member',id:'member'})).toEqual({data:{memoryPerson:{name:'Healthy'}}});
});
it('opens supplied stores readonly and returns typed project references',async()=>{
 const h=home(),a=store(join(h,'a.db'));a.write({slug:'friend',name:'Friend',where:{pond:{value:'maintainer'}}});
 const projects=new ProjectsStore({dbPath:a.database.name});closes.push(()=>projects.close());projects.write({slug:'pond',name:'Fictional pond'});
 const sharing:Sharing={members:{owner:{owner:true,agents:[]}},projects:{}};
 const reader=peopleReader({agents:[{agent:'fiction',memories:a.database.name}],sharing:()=>sharing,now:()=>0});closes.push(reader.close);
 expect(()=>reader.sources.get('fiction')!.prepare("UPDATE people SET name='Changed'").run()).toThrow(/readonly/);
 const f=fixture(join(h,'absent.db'),[{agent:'fiction',memories:a.database.name}]);
 expect(await f.query('{ memoryPerson(id:"fiction:friend") { projects { agent slug name status } } }')).toMatchObject({data:{memoryPerson:{projects:[{agent:'fiction',slug:'pond',name:'Fictional pond',status:'active'}]}}});
});

it('finds all current contact and evidence deadlines without querying private content or retaining closed files',()=>{
 const path=join(home(),'people.db'),s=store(path),now=Date.parse('2026-11-14T18:00:00Z');let at=now;
 s.write({slug:'friend',name:'Fiction',where:{email:{value:'fiction@example.invalid',verified_at:new Date(now-14*86400000+1000).toISOString()}}});
 s.write({slug:'archived',name:'Archived',where:{email:{value:'fiction',verified_at:new Date(now-14*86400000).toISOString()}}});s.archive({slug:'archived',reason:'Fictional',actor:'fiction'});
 s.write({slug:'invalid',name:'Invalid',where:{email:{value:'fiction',verified_at:new Date(now).toISOString()}}});
 s.database.prepare("UPDATE people SET card_json=json_set(card_json,'$.where.email.verified_at','invalid') WHERE slug='invalid'").run();
 s.database.exec("CREATE TABLE memories(created TEXT,category TEXT,title TEXT,content TEXT,metadata TEXT,archived INTEGER,expires_at TEXT)");
 const put=s.database.prepare("INSERT INTO memories VALUES('2026-11-14T00:00:00Z','feedback','Fiction','Words',?, ?, ?)");
 put.run('{"person":"friend"}',0,new Date(now+2000).toISOString());put.run('{"person":"friend"}',1,new Date(now+1).toISOString());put.run('{}',0,new Date(now+2).toISOString());put.run('{"person":"friend"}',0,'invalid');
 const reader=peopleReader({agents:[{agent:'fiction',memories:path}],sharing:()=>({members:{},projects:{}}),now:()=>at});closes.push(reader.close);
 expect(reader.nextDeadline()).toBe(now+1001);at=now+1001;expect(reader.nextDeadline()).toBe(now+2000);at=now+2000;expect(reader.nextDeadline()).toBeUndefined();
 reader.close();expect(reader.nextDeadline()).toBeUndefined();
});
