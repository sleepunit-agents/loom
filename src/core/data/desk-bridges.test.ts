import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { graphql } from 'graphql/index.js';
import { expect, it } from 'vitest';
import { createDataSchema } from './database';
import { dataQueries } from './queries';
import { agents, members, secrets, bridgeConnections } from './schema';
import { deskBridgesQuery } from '../../../web/src/pieces/attention/bar-stats';

it('reads minimal bridge configuration, observes enablement and reapplies current fixture visibility', async () => {
  const client = new Database(':memory:');
  try {
    const db = createDataSchema(client);
    const at = '2026-11-14T00:00:00Z';
    db.insert(members).values({id:'member',role:'owner',joinedAt:at}).run();
    db.insert(agents).values({id:'art',about:'',markBg:'#000',markFg:'#fff',faceShape:'pebble',faceEyes:'dot'}).run();
    db.insert(secrets).values({name:'bot',description:'Synthetic fixture reference',changedAt:at,changedBy:'member'}).run();
    const row = {platform:'discord' as const,agent:'art',workspace:'Private workspace',botUser:'bot',tokenSecret:'bot',state:'disconnected' as const,stateAt:at};
    db.insert(bridgeConnections).values([{...row,id:'enabled',enabled:true},{...row,id:'off',enabled:false},{...row,id:'hidden',enabled:true}]).run();
    let visible = true;
    // Fixture predicate only; the production bridge policy and root composition belong to their owner.
    const schema = dataQueries(client,{tables:['bridgeConnections'],visibility:{bridgeConnections:f=>visible ? sql`${f.id} <> 'hidden'` : sql`false`}});
    const read = () => graphql({schema,source:deskBridgesQuery});
    const result = await read();
    expect(result.errors).toBeUndefined();
    expect(result.data?.bridgeConnections).toEqual(expect.arrayContaining([{id:'enabled',enabled:true},{id:'off',enabled:false}]));
    expect(result.data?.bridgeConnections).toHaveLength(2);
    db.update(bridgeConnections).set({enabled:false}).where(sql`${bridgeConnections.id} = 'enabled'`).run();
    expect((await read()).data?.bridgeConnections).toEqual(expect.arrayContaining([{id:'enabled',enabled:false}]));
    visible = false;
    expect((await read()).data).toEqual({bridgeConnections:[]});
  } finally { client.close(); }
});
