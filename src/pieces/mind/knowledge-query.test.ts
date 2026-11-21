import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphQLObjectType, GraphQLSchema, graphql } from 'graphql/index.js';
import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { createDataSchema } from '../../core/data/database.js';
import { dataQueries } from '../../core/data/queries.js';
import { KnowledgePages } from '../../../test/fixtures/knowledge-pages.js';
import type { Sharing } from '../../policy.js';
import { knowledgeQueryFields, type MemoryQueryContext } from './knowledge-query.js';
const homes:string[]=[],closes:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();for(const home of homes.splice(0))rmSync(home,{recursive:true,force:true});});
const home=()=>{const h=mkdtempSync(join(tmpdir(),'knowledge-query-'));homes.push(h);return h;};
function fixture(path:string){
 let now=Date.parse('2026-11-14T18:00:00Z');
 const sharing:Sharing={members:{owner:{owner:true,agents:[]},member:{owner:false,agents:['fiction']}},projects:{}};
 const reader=knowledgeQueryFields({path,sharing:()=>sharing,now:()=>now});closes.push(reader.close);
 const client=new Database(':memory:');closes.push(()=>client.close());createDataSchema(client);
 const generated=dataQueries(client,{tables:['tasks'],visibility:{tasks:()=>sql`true`}});
 const schema=new GraphQLSchema({query:new GraphQLObjectType({name:'Query',fields:{...generated.getQueryType()!.toConfig().fields,...reader.fields}})});
 const query=(source:string,contextValue:MemoryQueryContext={viewer:{kind:'member',id:'owner'}})=>graphql({schema,source,contextValue});
 return {query,generated,sharing,reader,at:(at:number)=>{now=at;}};
}
it('lets a generated endpoint compose typed file-backed fields and return exactly the selected content',async()=>{
 const path=join(home(),'knowledge.db'),store=new KnowledgePages({dbPath:path});closes.push(()=>store.close());
 const body='Fictional factual content. '.repeat(1000)+'Final fact.';
 await store.writePage({slug:'hose',title:'The hose',domain:'pond',body,citations:[{claim:'25 mm',source_kind:'web',source_locator:'https://example.com/hose',excerpt:'25 mm'}]});
 await store.writePage({slug:'ref',title:'Referring fact',domain:'pond',body:'[[hose]]'});
 await store.verifyPages({slug:'hose',verified_at:'2026-11-13T00:00:00Z'});
 const f=fixture(path);
 expect((await graphql({schema:f.generated,source:'{ memoryKnowledge { total } }'})).errors?.[0].message).toContain('Cannot query field "memoryKnowledge"');
 const result=await f.query('{ tasks { id } memoryKnowledge { total checkDays pages { slug title fresh } } memoryKnowledgePage(slug:"hose") { body sources { claim locator excerpt retrievedAt createdAt } citedBy { slug title } } }');
 expect(result.errors).toBeUndefined();
 expect(JSON.parse(JSON.stringify(result.data))).toEqual({tasks:[],memoryKnowledge:{total:2,checkDays:30,pages:expect.arrayContaining([{slug:'hose',title:'The hose',fresh:'fresh'},{slug:'ref',title:'Referring fact',fresh:'fresh'}])},memoryKnowledgePage:{body,sources:[{claim:'25 mm',locator:'https://example.com/hose',excerpt:'25 mm',retrievedAt:expect.any(String),createdAt:expect.any(String)}],citedBy:[{slug:'ref',title:'Referring fact'}]}});
 expect(await f.query('{memoryKnowledgeAccess{allowed canAdd canVerify canRecheck} memoryKnowledgePage(slug:"hose"){body}}',{viewer:{kind:'agent',id:'fiction'}})).toMatchObject({data:{memoryKnowledgeAccess:{allowed:true,canAdd:true,canVerify:true,canRecheck:true},memoryKnowledgePage:{body}}});
 f.at(Date.parse('2026-12-14T18:00:00Z'));
 expect(await f.query('{ memoryKnowledgePage(slug:"hose") { fresh } }')).toMatchObject({data:{memoryKnowledgePage:{fresh:'due'}}});
 await store.archivePage({slug:'hose'});
 expect(await f.query('{ memoryKnowledgePage(slug:"hose") { title } memoryKnowledge { total } }')).toMatchObject({data:{memoryKnowledgePage:null,memoryKnowledge:{total:1}}});
});
it('uses the current authenticated context and central sharing on every execution, with no viewer argument or mutations',async()=>{
 const f=fixture(join(home(),'absent.db'));
 const source='{ memoryKnowledge { total } }';
 expect(await f.query(source)).toMatchObject({data:{memoryKnowledge:{total:0}}});
 for(const viewer of [{kind:'member',id:'member'},{kind:'runner',id:'machine'},{kind:'member',id:'unknown'}] as const)
  expect(await f.query(source,{viewer})).toMatchObject({data:{memoryKnowledge:null}});
 expect(await f.query(source,{viewer:{kind:'agent',id:'fiction'}})).toMatchObject({data:{memoryKnowledge:{total:0}}});
 f.sharing.members.owner.owner=false;
 expect(await f.query(source)).toMatchObject({data:{memoryKnowledge:null}});
 expect((await f.query('{ memoryKnowledge(viewer:"owner") { total } }')).errors).toBeDefined();
 expect((await f.query('mutation { memoryKnowledge { total } }')).errors).toBeDefined();
});
it('keeps absent files absent and hides source failures from callers without visibility',async()=>{
 const path=join(home(),'absent.db'),f=fixture(path);
 expect(await f.query('{ memoryKnowledge { total pages { title } } }')).toMatchObject({data:{memoryKnowledge:{total:0,pages:[]}}});
 expect(existsSync(path)).toBe(false);
 const broken=join(home(),'broken.db');writeFileSync(broken,'not a database');const bad=fixture(broken);
 const denied=await bad.query('{ memoryKnowledge { total } }',{viewer:{kind:'member',id:'member'}});
 expect(denied).toMatchObject({data:{memoryKnowledge:null}});expect(denied.errors).toBeUndefined();
 const result=await bad.query('{ memoryKnowledge { total } }');
 expect(result.errors?.[0].message).toBe('Knowledge is unavailable');
 expect(JSON.stringify(result)).not.toContain(broken);
});
it('matches complete backlink targets and keeps an uncited page provisional in query output',async()=>{
 const path=join(home(),'knowledge.db'),store=new KnowledgePages({dbPath:path});closes.push(()=>store.close());
 await store.writePage({slug:'hose',title:'The hose',domain:'pond',body:'Uncited fictional fact'});
 await store.writePage({slug:'prefix',title:'Prefix only',domain:'pond',body:'knowledge:hose-adapter /knowledge/hose-adapter [[hose-adapter]]'});
 await store.writePage({slug:'wiki',title:'Wiki alias',domain:'pond',body:'[[hose|the pump hose]]'});
 await store.writePage({slug:'exact',title:'Exact reference',domain:'pond',body:'knowledge:hose and /knowledge/hose?from=pond'});
 const f=fixture(path),result=await f.query('{ memoryKnowledgePage(slug:"hose") { sourcing sources { claim } citedBy { slug } } }');
 expect(result.errors).toBeUndefined();
 expect(result.data).toEqual({memoryKnowledgePage:{sourcing:'provisional',sources:[],citedBy:[{slug:'exact'},{slug:'wiki'}]}});
});
it('selects the newest ten prior versions without changing the current page',async()=>{
 const path=join(home(),'knowledge.db'),store=new KnowledgePages({dbPath:path});closes.push(()=>store.close());
 for(let i=0;i<13;i++)await store.writePage({slug:'hose',title:'Hose',domain:'pond',body:`Version ${i}`,mode:'replace'});
 const f=fixture(path),result=await f.query('{ memoryKnowledgePage(slug:"hose") { body history { body op replacedAt } } }');
 expect(result.errors).toBeUndefined();
 expect(result.data).toEqual({memoryKnowledgePage:{body:'Version 12',history:Array.from({length:10},(_,i)=>({body:`Version ${11-i}`,op:'write-replace',replacedAt:expect.any(String)}))}});
 expect(await f.query('{ memoryKnowledgePage(slug:"hose") { history { body } } }',{viewer:{kind:'member',id:'member'}})).toEqual({data:{memoryKnowledgePage:null}});
});

it('schedules the earliest future freshness boundary and recomputes from current metadata',async()=>{
 const path=join(home(),'knowledge.db'),store=new KnowledgePages({dbPath:path});closes.push(()=>store.close());
 const writer=new Database(path);closes.push(()=>writer.close());
 const f=fixture(path),now=Date.parse('2026-11-14T18:00:00Z'),day=86400_000;
 expect(f.reader.nextDeadline()).toBeUndefined();
 for(const slug of ['old','invalid','archived','recent','aging','due'])await store.writePage({slug,title:slug,domain:'fiction',body:'Fiction'});
 const stamp=(slug:string,at:string)=>writer.prepare('UPDATE pages SET updated=?,verified_at=? WHERE slug=?').run(at,at,slug);
 stamp('old',new Date(now-40*day).toISOString());stamp('invalid','invalid');
 stamp('archived',new Date(now-7*day+1).toISOString());await store.archivePage({slug:'archived'});
 stamp('recent',new Date(now-7*day+1000).toISOString());
 stamp('aging',new Date(now-20*day+2000).toISOString());stamp('due',new Date(now-30*day+3000).toISOString());
 expect(f.reader.nextDeadline()).toBe(now+1000);
 f.at(now+1000);expect(f.reader.nextDeadline()).toBe(now+2000);
 f.at(now+2000);expect(f.reader.nextDeadline()).toBe(now+3000);
 // Rechecking moves a pending due boundary; it does not leave an old timer due.
 stamp('due',new Date(now+2000).toISOString());
 expect(f.reader.nextDeadline()).toBe(now+2000+7*day);
 f.reader.close();expect(f.reader.nextDeadline()).toBeUndefined();
});

it('projects the same current capabilities without a legacy record subscription',async()=>{
 const f=fixture(join(home(),'absent.db'));
 const source='{ memoryKnowledgeAccess { allowed canAdd canVerify canRecheck } }';
 expect(await f.query(source)).toMatchObject({data:{memoryKnowledgeAccess:{allowed:true,canAdd:true,canVerify:true,canRecheck:true}}});
 expect(await f.query(source,{viewer:{kind:'member',id:'member'}})).toMatchObject({data:{memoryKnowledgeAccess:{allowed:false,canAdd:false,canVerify:false,canRecheck:false}}});
 f.sharing.members.owner.owner=false;
 expect(await f.query(source)).toMatchObject({data:{memoryKnowledgeAccess:{allowed:false,canAdd:false,canVerify:false,canRecheck:false}}});
});
it('lists every active page beyond the old two-thousand-page ceiling',async()=>{
 const path=join(home(),'knowledge.db'),store=new KnowledgePages({dbPath:path});closes.push(()=>store.close());
 await store.writePage({slug:'first',title:'First',domain:'fiction',body:'Fictional'});
 const writer=new Database(path);closes.push(()=>writer.close());
 const insert=writer.prepare("INSERT INTO pages(uuid,slug,title,domain,body,created,updated,status) VALUES(?,?,?,'fiction','Fictional','2026-11-14T00:00:00Z','2026-11-14T00:00:00Z','active')");
 writer.transaction(()=>{for(let i=0;i<2001;i++)insert.run(`uuid-${i}`,`fiction-${i}`,`Fiction ${i}`);})();
 const f=fixture(path),result=await f.query('{ memoryKnowledge { total pages { slug } } }');
 expect(result.errors).toBeUndefined();const index=result.data!.memoryKnowledge as {total:number;pages:Array<{slug:string}>};
 expect(index.total).toBe(2002);expect(index.pages).toHaveLength(2002);expect(index.pages).toContainEqual({slug:'fiction-2000'});
});

it('keeps the successful stamp after a stale check and recomputes backlinks from current source content',async()=>{
 const path=join(home(),'knowledge.db'),store=new KnowledgePages({dbPath:path});closes.push(()=>store.close());
 await store.writePage({slug:'fact',title:'Fact',domain:'fiction',body:'Fictional fact'});
 await store.writePage({slug:'ref',title:'Reference',domain:'fiction',body:'[[fact]]'});
 await store.verifyPages({slug:'fact',verified_at:'2026-11-10T00:00:00.000Z',verifier:'checker'});
 const f=fixture(path),read=()=>f.query('{memoryKnowledgePage(slug:"fact"){fresh verified_at checked{outcome} checks{at outcome by} citedBy{slug}}}');
 expect(await read()).toMatchObject({data:{memoryKnowledgePage:{fresh:'fresh',citedBy:[{slug:'ref'}]}}});
 await store.verifyPages({slug:'fact',outcome:'stale',verified_at:'2026-11-11T00:00:00.000Z'});
 expect(await read()).toMatchObject({data:{memoryKnowledgePage:{fresh:'due',verified_at:'2026-11-10T00:00:00.000Z',checked:{outcome:'stale'},checks:[{at:'2026-11-11T00:00:00.000Z',outcome:'stale'},{at:'2026-11-10T00:00:00.000Z',outcome:'confirmed',by:'checker'}]}}});
 const index=()=>f.query('{memoryKnowledge{pages{slug checked{outcome}}}}');
 expect((await index()).data?.memoryKnowledge).toMatchObject({pages:expect.arrayContaining([{slug:'fact',checked:{outcome:'stale'}},{slug:'ref',checked:null}])});
 await store.verifyPages({slug:'fact',verifier:'checker'});
 expect((await index()).data?.memoryKnowledge).toMatchObject({pages:expect.arrayContaining([{slug:'fact',checked:{outcome:'confirmed'}}])});
 await store.writePage({slug:'ref',title:'Reference',domain:'fiction',body:'No link',mode:'replace'});
 expect(await read()).toMatchObject({data:{memoryKnowledgePage:{citedBy:[]}}});
 await store.writePage({slug:'ref',title:'Reference',domain:'fiction',body:'/knowledge/fact',mode:'replace'});
 await store.renamePage({slug:'ref',new_slug:'renamed'});
 expect(await read()).toMatchObject({data:{memoryKnowledgePage:{citedBy:[{slug:'renamed'}]}}});
 await store.archivePage({slug:'renamed'});expect(await read()).toMatchObject({data:{memoryKnowledgePage:{citedBy:[]}}});
 await store.restorePage({slug:'renamed'});expect(await read()).toMatchObject({data:{memoryKnowledgePage:{citedBy:[{slug:'renamed'}]}}});
 await store.archivePage({slug:'renamed'});await store.purgePages(['renamed']);
 expect(await read()).toMatchObject({data:{memoryKnowledgePage:{citedBy:[]}}});
});

it('reviews active shared pages by sourcing and pages through candidates by slug',async()=>{
 const path=join(home(),'knowledge.db'),store=new KnowledgePages({dbPath:path});closes.push(()=>store.close());
 const conversation={claim:'Fictional claim',source_kind:'conversation' as const,excerpt:'Fictional excerpt'};
 const web={...conversation,source_kind:'web' as const};
 for(const [slug,domain,sourcing,citations] of [
  ['a','world','provisional',[web]],['b','world','sourced',[conversation,conversation]],
  ['c','ours/project','provisional',[]],['d','ours/project','internal',[conversation]],
  ['e','world','sourced',[conversation,web]],['f','world','sourced',[]],
  ['g','world','provisional',[]],
 ] as const)await store.writePage({slug,title:slug,domain,sourcing,citations:[...citations],body:'Fictional body'});
 await store.archivePage({slug:'g'});
 const f=fixture(path),query=(args:string)=>'{memoryKnowledgeFilingReview('+args+'){slug reason}}';
 const first=await f.query(query('first:2'));
 expect(first).toEqual({data:{memoryKnowledgeFilingReview:[
  {slug:'a',reason:'Provisional sourcing'},{slug:'b',reason:'All citations are conversations'},
 ]}});
 expect(await f.query(query('after:"b",first:2'),{viewer:{kind:'agent',id:'fiction'}})).toEqual({data:{memoryKnowledgeFilingReview:[{slug:'c',reason:'Provisional sourcing'}]}});
 expect(await f.query(query('first:0'),{viewer:{kind:'runner',id:'fixture'}})).toEqual({data:{memoryKnowledgeFilingReview:null}});
 expect((await f.query(query('first:101'))).errors?.[0].message).toContain('1 to 100');
});

it('reviews recorded provisional sourcing in older Knowledge files without a citations table',async()=>{
 const path=join(home(),'legacy.db'),db=new Database(path);
 db.exec("CREATE TABLE pages(id INTEGER PRIMARY KEY, slug TEXT, title TEXT, domain TEXT, status TEXT, sourcing TEXT); INSERT INTO pages VALUES(1,'old','Old','world','active','provisional'),(2,'known','Known','world','active','sourced')");
 db.close();
 const {query}=fixture(path);
 expect(await query('{memoryKnowledgeFilingReview{slug reason}}')).toEqual({data:{memoryKnowledgeFilingReview:[{slug:'old',reason:'Provisional sourcing'}]}});
});
