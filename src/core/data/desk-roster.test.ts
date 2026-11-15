import {expect,it} from 'vitest';
it('executes the desk selection against the generated schema with the existing SQL policy',async()=>{
 const [{default:Database},{graphql},{createDataSchema},{dataQueries},{taskVisibility},schema] = await Promise.all([
  import('better-sqlite3'),import('graphql/index.js'),import('./database'),
  import('./queries'),import('./visibility'),import('./schema'),
 ]);
 const client=new Database(':memory:');
 try {
  const db=createDataSchema(client,()=> '2026-11-14T00:00:00.000Z');
  db.insert(schema.members).values({id:'member',role:'member',joinedAt:'2026-11-14T00:00:00.000Z'}).run();
  db.insert(schema.agents).values([{id:'z',position:1,about:'',markBg:'#000000',markFg:'#ffffff',faceShape:'pebble',faceEyes:'dot'},{id:'a',position:3,about:'',markBg:'#000000',markFg:'#ffffff',faceShape:'pebble',faceEyes:'dot'}]).run();
  db.insert(schema.memberAgents).values({member:'member',agent:'z'}).run();
  const generated=dataQueries(client,{tables:['agents'],visibility:taskVisibility({kind:'member',id:'member'})});
  const {deskRosterQuery}=await import('../../../web/src/pieces/attention/roster');
  const result=await graphql({schema:generated,source:deskRosterQuery});
  expect(result.errors).toBeUndefined();expect(result.data).toEqual({agents:[{id:'z',position:1}]});
  db.delete(schema.memberAgents).run();
  expect((await graphql({schema:generated,source:deskRosterQuery})).data).toEqual({agents:[]});
 }finally{client.close();}
});
