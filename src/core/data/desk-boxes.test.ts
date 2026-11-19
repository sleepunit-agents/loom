import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { graphql } from 'graphql/index.js';
import { expect, it } from 'vitest';
import { createDataSchema } from './database';
import { dataQueries } from './queries';
import { boxes, members } from './schema';
import { deskBoxesQuery } from '../../../web/src/pieces/attention/bar-stats';

it('executes the minimal enrollment selection and reapplies current visibility without exposing machine details', async () => {
  const client = new Database(':memory:');
  try {
    const db = createDataSchema(client);
    const at = '2026-11-14T00:00:00Z';
    db.insert(members).values([{id:'member',role:'member',joinedAt:at},{id:'other',role:'member',joinedAt:at}]).run();
    const row = {owner:'member',sameMachineAsLoom:false,hostsAny:false,reportOnly:false,alwaysOn:false,enrolledAt:at};
    db.insert(boxes).values([
      {...row,id:'live',name:'Private machine name'},
      {...row,id:'gone',name:'Removed machine',revokedAt:at},
      {...row,id:'hidden',name:'Other machine',owner:'other'},
    ]).run();
    db.update(boxes).set({readers:['fern']}).where(sql`${boxes.id} = 'live'`).run();
    let visible = true;
    // Fixture SQL predicate only; production Runtime visibility and root mounting belong to their owner.
    const schema = dataQueries(client, {tables:['boxes'],visibility:{boxes:f=>visible ? sql`${f.owner} = 'member'` : sql`false`}});
    const read = () => graphql({schema,source:deskBoxesQuery});
    const settings = await graphql({schema,source:'{ boxes { id readers } }'});
    expect(settings.errors).toBeUndefined();
    expect(settings.data?.boxes).toContainEqual({id:'live',readers:['fern']});
    const result = await read();
    expect(result.errors).toBeUndefined();
    expect(result.data?.boxes).toEqual(expect.arrayContaining([{id:'live',revokedAt:null},{id:'gone',revokedAt:at}]));
    expect(result.data?.boxes).toHaveLength(2);
    db.update(boxes).set({revokedAt:at}).where(sql`${boxes.id} = 'live'`).run();
    expect((await read()).data?.boxes).toEqual(expect.arrayContaining([{id:'live',revokedAt:at}]));
    visible = false;
    expect((await read()).data).toEqual({boxes:[]});
  } finally { client.close(); }
});
