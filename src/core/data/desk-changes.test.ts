import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { graphql } from 'graphql/index.js';
import { expect, it } from 'vitest';
import { createDataSchema } from './database';
import { dataQueries } from './queries';
import { changes } from './schema';
import { deskChangesQuery } from '../../../web/src/pieces/attention/bar-stats';

it('selects only open change IDs and check states and reapplies current fixture visibility', async () => {
  const client = new Database(':memory:');
  try {
    const db = createDataSchema(client), at = '2026-11-14T00:00:00Z';
    const row = {repository:'fixture/repo',number:1,title:'Private title',body:'Private body',url:'https://example.invalid',draft:false,authorLogin:'fixture',branch:'fixture',headCommit:'abc',baseBranch:'next',review:'required' as const,mergeable:'unknown' as const,waitingOn:'ci' as const,openedAt:at,updatedAt:at};
    db.insert(changes).values([
      {...row,id:'open',state:'open',checks:'failing'},
      {...row,id:'merged',state:'merged',checks:'failing'},
      {...row,id:'closed',state:'closed',checks:'failing'},
      {...row,id:'hidden',state:'open',checks:'failing'},
    ]).run();
    let visible = true;
    // Fixture predicate only; production Changes visibility and root composition belong to their owner.
    const schema = dataQueries(client,{tables:['changes'],visibility:{changes:f=>visible ? sql`${f.id} <> 'hidden'` : sql`false`}});
    const read = () => graphql({schema,source:deskChangesQuery});
    const result = await read();
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({changes:[{id:'open',checks:'failing'}]});
    db.update(changes).set({checks:'passing'}).where(sql`${changes.id} = 'open'`).run();
    expect((await read()).data).toEqual({changes:[{id:'open',checks:'passing'}]});
    db.update(changes).set({state:'merged'}).where(sql`${changes.id} = 'open'`).run();
    expect((await read()).data).toEqual({changes:[]});
    db.update(changes).set({state:'open'}).where(sql`${changes.id} = 'open'`).run();
    visible = false;
    expect((await read()).data).toEqual({changes:[]});
  } finally { client.close(); }
});
