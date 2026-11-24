import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { graphql } from 'graphql/index.js';
import { expect, it } from 'vitest';
import { createDataSchema } from '../data/database';
import { dataQueries } from '../data/queries';
import { withQueryFields } from '../data/http';
import { tempoQueryFields } from './queries';
import { tempoQuery, triggerHistoryQuery } from '../../../web/src/pieces/tempo/query';

it('executes the actual browser selection against generated shared tables and bounds recent logs', async () => {
  const db = new Database(':memory:');
  try {
    const shared=createDataSchema(db);
    db.exec(`INSERT INTO triggers (id,owner_kind,source_kind,lifespan,target_kind,target,note,enabled,state,created_at,changed_at)
      VALUES ('tr-1','household','time','once','operation','test','Example',1,'standing','2026-11-14T00:00:00Z','2026-11-14T00:00:00Z')`);
    db.prepare('UPDATE triggers SET needs=?, prefers=? WHERE id=?').run('["gpu"]', '["local"]', 'tr-1');
    const insert = db.prepare("INSERT INTO trigger_log (seq,trigger,at,event,note) VALUES (?,'tr-1','2026-11-14T00:00:00Z','set','Example')");
    db.transaction(() => { for (let i = 1; i <= 201; i++) insert.run(i); })();
    // Trusted fixture policies test the generated shape, not external authority.
    const schema = withQueryFields(dataQueries(db, { tables: ['triggers', 'triggerLog', 'agentPauses'], visibility: {
      triggers: () => sql`true`, triggerLog: () => sql`true`, agentPauses: () => sql`true`,
    } }), tempoQueryFields(shared,{kind:'member',id:'owner'}));
    const result = await graphql({ schema, source: tempoQuery });
    expect(result.errors).toBeUndefined();
    expect(result.data?.triggers).toMatchObject([{ id: 'tr-1', enabled: true, note: 'Example', needs: ['gpu'], prefers: ['local'] }]);
    expect(result.data).not.toHaveProperty('triggerLog');
    db.exec(`INSERT INTO triggers (id,owner_kind,source_kind,lifespan,target_kind,target,note,enabled,state,created_at,changed_at)
      SELECT 'busy',owner_kind,source_kind,lifespan,target_kind,target,note,enabled,state,created_at,changed_at FROM triggers WHERE id='tr-1';
      INSERT INTO trigger_log (trigger,at,event,note) SELECT 'busy',at,event,note FROM trigger_log;
      INSERT INTO trigger_log (trigger,at,event,note) SELECT 'tr-1',at,'source-snapshot',note FROM trigger_log WHERE trigger='busy'`);
    const history = await graphql({schema, source: triggerHistoryQuery, variableValues: {id:'tr-1'}});
    expect(history.errors).toBeUndefined();
    const rows = history.data?.triggerLog as {seq:number; trigger:string; event:string}[];
    expect(rows).toHaveLength(200);
    expect(rows.every(row => row.trigger === 'tr-1' && row.event === 'set')).toBe(true);
    expect(rows[0].seq).toBe(201);
    expect(rows[199].seq).toBe(2);
    expect(result.data?.agentPauses).toEqual([]);
  } finally { db.close(); }
});
