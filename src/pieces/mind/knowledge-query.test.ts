import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphQLObjectType, GraphQLSchema, graphql } from 'graphql/index.js';
import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { createDataSchema } from '../../core/data/database.js';
import { dataQueries } from '../../core/data/queries.js';
import { SqliteKnowledgeBackend } from '../../backends/sqlite-knowledge.js';
import type { Sharing } from '../../policy.js';
import { knowledgeQueryFields, type MemoryQueryContext } from './knowledge-query.js';
const homes:string[]=[],closes:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();for(const home of homes.splice(0))rmSync(home,{recursive:true,force:true});});
const home=()=>{const h=mkdtempSync(join(tmpdir(),'knowledge-query-'));homes.push(h);return h;};
function fixture(path:string){
 let now=Date.parse('2026-11-14T18:00:00Z');
 const sharing:Sharing={members:{owner:{owner:true,agents:[]},member:{owner:false,agents:['fiction']}},projects:{},services:{}};
 const reader=knowledgeQueryFields({path,sharing:()=>sharing,now:()=>now});closes.push(reader.close);
 const client=new Database(':memory:');closes.push(()=>client.close());createDataSchema(client);
 const generated=dataQueries(client,{tables:['tasks'],visibility:{tasks:()=>sql`true`}});
 const schema=new GraphQLSchema({query:new GraphQLObjectType({name:'Query',fields:{...generated.getQueryType()!.toConfig().fields,...reader.fields}})});
 const query=(source:string,contextValue:MemoryQueryContext={viewer:{kind:'member',id:'owner'}})=>graphql({schema,source,contextValue});
 return {query,generated,sharing,at:(at:number)=>{now=at;}};
}
it('lets a generated endpoint compose typed file-backed fields and return exactly the selected content',async()=>{
 const path=join(home(),'knowledge.db'),store=new SqliteKnowledgeBackend({dbPath:path});closes.push(()=>store.close());
 const body='Fictional factual content. '.repeat(1000)+'Final fact.';
 await store.writePage({slug:'hose',title:'The hose',domain:'pond',body,citations:[{claim:'25 mm',source_kind:'web',source_locator:'https://example.com/hose',excerpt:'25 mm'}]});
 await store.writePage({slug:'ref',title:'Referring fact',domain:'pond',body:'[[hose]]'});
 await store.verifyPages({slug:'hose',verified_at:'2026-11-13T00:00:00Z'});
 const f=fixture(path);
 expect((await graphql({schema:f.generated,source:'{ memoryKnowledge { total } }'})).errors?.[0].message).toContain('Cannot query field "memoryKnowledge"');
 const result=await f.query('{ tasks { id } memoryKnowledge { total checkDays pages { slug title fresh } } memoryKnowledgePage(slug:"hose") { body sources { claim locator excerpt retrievedAt createdAt } citedBy { slug title } } }');
 expect(result.errors).toBeUndefined();
 expect(JSON.parse(JSON.stringify(result.data))).toEqual({tasks:[],memoryKnowledge:{total:2,checkDays:30,pages:expect.arrayContaining([{slug:'hose',title:'The hose',fresh:'fresh'},{slug:'ref',title:'Referring fact',fresh:'fresh'}])},memoryKnowledgePage:{body,sources:[{claim:'25 mm',locator:'https://example.com/hose',excerpt:'25 mm',retrievedAt:expect.any(String),createdAt:expect.any(String)}],citedBy:[{slug:'ref',title:'Referring fact'}]}});
 f.at(Date.parse('2026-12-14T18:00:00Z'));
 expect(await f.query('{ memoryKnowledgePage(slug:"hose") { fresh } }')).toMatchObject({data:{memoryKnowledgePage:{fresh:'due'}}});
 await store.archivePage({slug:'hose'});
 expect(await f.query('{ memoryKnowledgePage(slug:"hose") { title } memoryKnowledge { total } }')).toMatchObject({data:{memoryKnowledgePage:null,memoryKnowledge:{total:1}}});
});
it('uses the current authenticated context and central sharing on every execution, with no viewer argument or mutations',async()=>{
 const f=fixture(join(home(),'absent.db'));
 const source='{ memoryKnowledge { total } }';
 expect(await f.query(source)).toMatchObject({data:{memoryKnowledge:{total:0}}});
 for(const viewer of [{kind:'member',id:'member'},{kind:'agent',id:'fiction'},{kind:'runner',id:'machine'},{kind:'member',id:'unknown'}] as const)
  expect(await f.query(source,{viewer})).toMatchObject({data:{memoryKnowledge:null}});
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
 expect(await bad.query('{ memoryKnowledge { total } }',{viewer:{kind:'member',id:'member'}})).toMatchObject({data:{memoryKnowledge:null}});
 const result=await bad.query('{ memoryKnowledge { total } }');
 expect(result.errors?.[0].message).toBe('Knowledge is unavailable');
 expect(JSON.stringify(result)).not.toContain(broken);
});
