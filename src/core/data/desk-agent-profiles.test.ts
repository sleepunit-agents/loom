import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { graphql } from 'graphql/index.js';
import { createDataSchema } from './database';
import { dataQueries } from './queries';
import { taskVisibility } from './visibility';
import { agents, members, memberAgents } from './schema';
import { deskAgentProfiles, deskAgentProfilesQuery, type DeskAgentProfilesData } from '../../../web/src/pieces/attention/agent-profiles';
it('executes the minimal profile selection with current generated row visibility and updates',async()=>{
 const client=new Database(':memory:');
 try {
  const at='2026-11-14T00:00:00Z',db=createDataSchema(client,()=>at);
  db.insert(members).values({id:'sam',role:'member',joinedAt:at}).run();
  const defaults={markBg:'#000',markFg:'#fff',faceShape:'pebble' as const,faceEyes:'dot' as const};
  db.insert(agents).values([{...defaults,id:'art',about:'Shared description',aboutAskedAt:at},{...defaults,id:'mark',about:'Hidden profile'}]).run();
  db.insert(memberAgents).values({member:'sam',agent:'art'}).run();
  const schema=dataQueries(client,{tables:['agents'],visibility:taskVisibility({kind:'member',id:'sam'})});
  const read=async()=>{const result=await graphql({schema,source:deskAgentProfilesQuery});expect(result.errors).toBeUndefined();return deskAgentProfiles({status:'live',data:result.data as unknown as DeskAgentProfilesData});};
  expect((await read()).records).toEqual([{id:'art',agent:'art',description:'Shared description',requestedAt:at}]);
  db.update(agents).set({about:'Changed description',aboutAskedAt:null}).where(eq(agents.id,'art')).run();
  expect((await read()).records).toEqual([{id:'art',agent:'art',description:'Changed description'}]);
  db.delete(memberAgents).run();expect((await read()).records).toEqual([]);
 }finally{client.close();}
});
