import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { graphql } from 'graphql/index.js';
import { createDataSchema } from './database';
import { dataQueries } from './queries';
import { withQueryFields } from './http';
import { taskVisibility } from './visibility';
import { agents, members, memberAgents } from './schema';
import { CommsQueries, commsQueryFields } from '../conversations/comms-query';
import { deskRoster, deskRosterQuery, type DeskRosterData } from '../../../web/src/pieces/attention/roster';
it('executes actual shared ownership and directory selection without promoting visible colleagues', async () => {
 const client = new Database(':memory:');
 try {
  const at = '2026-11-14T00:00:00.000Z', db = createDataSchema(client, () => at);
  db.insert(members).values([{ id:'member', role:'owner', joinedAt:at }, { id:'other', role:'owner', joinedAt:at }]).run();
  const defaults = { about:'',markBg:'#000000',markFg:'#ffffff',faceShape:'pebble' as const,faceEyes:'dot' as const };
  db.insert(agents).values([{...defaults,id:'z',position:1},{...defaults,id:'a',position:3}]).run();
  db.insert(memberAgents).values({member:'member',agent:'z'}).run();
  const key = { seal:async(s:string)=>Buffer.from(s),hash:(s:string)=>s,open:async()=>{throw Error('Roster must not read words');} };
  const service = new CommsQueries(db,key,()=>sql`false`,()=>at);
  const read = async (id='member') => {
    const viewer={kind:'member' as const,id};
    const schema=withQueryFields(dataQueries(client,{tables:['agents'],visibility:taskVisibility(viewer)}),commsQueryFields(service));
    const result=await graphql({schema,source:deskRosterQuery,contextValue:{viewer}});
    expect(result.errors).toBeUndefined();return result.data as unknown as DeskRosterData;
  };
  const first=await read();
  expect(first).toEqual({homeComms:{member:'member',agents:['z']},agents:[{id:'z',position:1},{id:'a',position:3}]});
  expect(deskRoster({status:'live',data:first}).records).toEqual([{id:'z',name:'Z',position:1}]);
  expect(deskRoster({status:'live',data:await read('other')}).records).toEqual([]);
  db.delete(memberAgents).run();
  const revoked=await read();expect(revoked.agents).toHaveLength(2);
  expect(deskRoster({status:'live',data:revoked}).records).toEqual([]);
  expect(deskRoster({status:'live',data:await read('missing')})).toEqual({status:'denied',records:[]});
 } finally {client.close();}
});
