import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { graphql } from 'graphql/index.js';
import { createDataSchema } from './database';
import { dataQueries } from './queries';
import { taskVisibility } from './visibility';
import { agents, members, memberAgents } from './schema';
import { deskAgentDisplays, deskAgentDisplaysQuery, type DeskAgentDisplaysData } from '../../../web/src/pieces/attention/agent-displays';
it('selects exact drawn metadata from shared agents, sees updates and withdraws hidden rows',async()=>{
 const client=new Database(':memory:');
 try {
  const at='2026-11-14T00:00:00Z',db=createDataSchema(client,()=>at);
  db.insert(members).values({id:'sam',role:'member',joinedAt:at}).run();
  const defaults={about:'',markBg:'#000000',markFg:'#ffffff',faceShape:'pebble' as const,faceEyes:'dot' as const};
  db.insert(agents).values([{...defaults,id:'art'},{...defaults,id:'hidden'}]).run();
  db.insert(memberAgents).values({member:'sam',agent:'art'}).run();
  const schema=dataQueries(client,{tables:['agents'],visibility:taskVisibility({kind:'member',id:'sam'})});
  const read=async()=>{const result=await graphql({schema,source:deskAgentDisplaysQuery});expect(result.errors).toBeUndefined();return deskAgentDisplays({status:'live',data:result.data as unknown as DeskAgentDisplaysData});};
  expect(await read()).toEqual([{id:'art',agent:'art',mark:{bg:'#000000',fg:'#ffffff'},face:{shape:'pebble',eyes:'dot'}}]);
  db.update(agents).set({markBg:'#123456',faceShape:'drop',faceEyes:'oval'}).where(eq(agents.id,'art')).run();
  expect((await read())[0]).toMatchObject({mark:{bg:'#123456'},face:{shape:'drop',eyes:'oval'}});
  db.delete(memberAgents).run();expect(await read()).toEqual([]);
 }finally{client.close();}
});
