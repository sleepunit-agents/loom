import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { graphql } from 'graphql/index.js';
import { expect, it } from 'vitest';
import { createDataSchema } from './database';
import { dataQueries } from './queries';
import { deskTempoQuery } from '../../../web/src/pieces/attention/bar-stats';

it('executes the ticker selection, bounds the latest event and reapplies current SQL visibility', async () => {
  const db = new Database(':memory:');
  try {
    createDataSchema(db);
    db.exec(`INSERT INTO triggers (id,owner_kind,source_kind,lifespan,target_kind,target,note,enabled,state,created_at,changed_at)
      VALUES ('tr-1','household','time','once','operation','test','Private instructions omitted',1,'standing','2026-11-14T00:00:00Z','2026-11-14T00:00:00Z')`);
    const insert = db.prepare("INSERT INTO trigger_log (seq,trigger,at,event,note) VALUES (?,'tr-1','2026-11-14T00:00:00Z',?,'Private note omitted')");
    insert.run(1, 'set'); insert.run(2, 'fired');
    let visible = true;
    // Fixture policy checks query execution and revocation; production Tempo policy belongs to its owner.
    const current = () => visible ? sql`true` : sql`false`;
    const schema = dataQueries(db, { tables: ['triggers', 'triggerLog', 'agentPauses'], visibility: {
      triggers: current, triggerLog: current, agentPauses: current,
    } });
    const read = () => graphql({ schema, source: deskTempoQuery });
    const result = await read();
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ triggers: [{ id: 'tr-1', enabled: true, state: 'standing' }], triggerLog: [{ seq: 2, event: 'fired' }], agentPauses: [] });
    insert.run(3, 'stopped');
    expect((await read()).data?.triggerLog).toEqual([{ seq: 3, event: 'stopped' }]);
    visible = false;
    expect((await read()).data).toEqual({ triggers: [], triggerLog: [], agentPauses: [] });
  } finally { db.close(); }
});
