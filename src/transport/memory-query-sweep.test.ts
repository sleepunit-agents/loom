import {expect,it} from 'vitest';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {GraphQLObjectType,GraphQLSchema,graphql} from 'graphql/index.js';
import {createDataSchema} from '../core/data/database.js';
import {agents,household,inbox} from '../core/data/schema.js';
import {Conversations} from '../core/conversations/index.js';
import {FakeClock} from '../core/clock.js';
import {createTempo} from '../core/tempo/tempo.js';
import {SqliteKnowledgeBackend} from '../backends/sqlite-knowledge.js';
import {memoryQueryFields} from './memory-queries.js';
import {installMemoryTempo} from './memory-tempo.js';
it('uses the actual Memory query reader for the shared Tempo sweep without legacy tables or verification writes',async()=>{
 const home=mkdtempSync(join(tmpdir(),'memory-query-sweep-')),client=new Database(':memory:'),db=createDataSchema(client);
 const clock=new FakeClock(Date.parse('2026-11-14T13:16:59Z')),path=join(home,'knowledge.db'),knowledge=new SqliteKnowledgeBackend({dbPath:path});
 await knowledge.writePage({slug:'fictional-pump',title:'Fictional pump',domain:'fiction',body:'Fictional fact',verified_at:'2020-01-01T00:00:00Z'});
 db.insert(household).values({singleton:1,name:'Fictional household',timezone:'America/Chicago'}).run();
 db.insert(agents).values({id:'checker',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();
 const tables=()=>client.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all();const before=tables();
 const queries=memoryQueryFields(db,{sources:{commons:{directory:home,knowledge:path,people:join(home,'absent.db')},agents:[]},sharing:()=>({members:{owner:{owner:true,agents:[]}},projects:{},services:{}}),now:()=>clock.now(),projects:{list(){throw Error('Unexpected Projects read');},read(){throw Error('Unexpected Projects read');},memoryRead(){throw Error('Unexpected Projects read');},access(){throw Error('Unexpected Projects read');}},activity:{window(){throw Error('Unexpected Activity read');},read(){throw Error('Unexpected Activity read');}},conversationHref:id=>'/conversation/'+id,projectHref:(_agent,slug)=>'/project/'+slug});
 const tempo=createTempo(db,clock,{conversations:new Conversations(db,()=>new Date(clock.now()).toISOString()),admit:()=>false,operation(){throw Error('Unexpected operation');}});
 let unregister:(()=>void)|undefined;
 const source=new Database(path,{readonly:true});
 try{
  const schema=new GraphQLSchema({query:new GraphQLObjectType({name:'Query',fields:queries.fields})});
  expect(await graphql({schema,source:'{ memoryKnowledge { pages { slug fresh } } }',contextValue:{viewer:{kind:'member',id:'owner'}}})).toMatchObject({data:{memoryKnowledge:{pages:[{slug:'fictional-pump',fresh:'due'}]}}});
  unregister=installMemoryTempo(db,tempo,queries,'checker');tempo.start();expect(db.select().from(inbox).all()).toEqual([]);
  clock.advance(1000);expect(db.select().from(inbox).all()).toMatchObject([{to:'checker',source:'notice',words:expect.stringContaining('fictional-pump')}]);
  expect(source.prepare('SELECT verified_at FROM pages').get()).toEqual({verified_at:'2020-01-01T00:00:00Z'});expect(tables()).toEqual(before);
 }finally{unregister?.();tempo.close();queries.close();source.close();knowledge.close();client.close();rmSync(home,{recursive:true,force:true});}
});
