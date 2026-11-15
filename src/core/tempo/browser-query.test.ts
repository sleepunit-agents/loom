import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { graphql } from 'graphql/index.js';
import { expect, it } from 'vitest';
import { createDataSchema } from '../data/database';
import { dataQueries } from '../data/queries';
import { tempoQuery } from '../../../web/src/pieces/tempo/query';

it('executes the actual browser selection against generated shared tables and bounds recent logs', async () => {
  const db = new Database(':memory:');
  try {
    createDataSchema(db);
    db.exec(`INSERT INTO triggers (id,owner_kind,source_kind,lifespan,target_kind,target,note,enabled,state,created_at,changed_at)
      VALUES ('tr-1','household','time','once','operation','test','Example',1,'standing','2026-11-14T00:00:00Z','2026-11-14T00:00:00Z')`);
    const insert = db.prepare("INSERT INTO trigger_log (seq,trigger,at,event,note) VALUES (?,'tr-1','2026-11-14T00:00:00Z','set','Example')");
    db.transaction(() => { for (let i = 1; i <= 201; i++) insert.run(i); })();
    // Trusted fixture policies test the generated shape, not external authority.
    const schema = dataQueries(db, { tables: ['triggers', 'triggerLog', 'agentPauses'], visibility: {
      triggers: () => sql`true`, triggerLog: () => sql`true`, agentPauses: () => sql`true`,
    } });
    const result = await graphql({ schema, source: tempoQuery });
    expect(result.errors).toBeUndefined();
    expect(result.data?.triggers).toMatchObject([{ id: 'tr-1', enabled: true, note: 'Example' }]);
    expect(result.data?.triggerLog).toHaveLength(200);
    expect((result.data?.triggerLog as {seq: number}[])[0].seq).toBe(201);
    expect(result.data?.agentPauses).toEqual([]);
  } finally { db.close(); }
});
