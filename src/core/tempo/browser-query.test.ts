import Database from 'better-sqlite3';
import { eq, sql } from 'drizzle-orm';
import { graphql } from 'graphql/index.js';
import { expect, it } from 'vitest';
import { createDataSchema } from '../data/database';
import { agents, approvals, boxes, members, triggers } from '../data/schema';
import { dataQueries } from '../data/queries';
import { withQueryFields } from '../data/http';
import { tempoQueryFields } from './queries';
import { tempoQuery } from '../../../web/src/pieces/tempo/query';

it('executes the actual browser selection against generated shared tables and bounds recent logs', async () => {
  const db = new Database(':memory:');
  try {
    const shared=createDataSchema(db);
    db.exec(`INSERT INTO triggers (id,owner_kind,source_kind,lifespan,target_kind,target,note,enabled,state,created_at,changed_at)
      VALUES ('tr-1','household','time','once','operation','test','Example',1,'standing','2026-11-14T00:00:00Z','2026-11-14T00:00:00Z')`);
    const insert = db.prepare("INSERT INTO trigger_log (seq,trigger,at,event,note) VALUES (?,'tr-1','2026-11-14T00:00:00Z','set','Example')");
    db.transaction(() => { for (let i = 1; i <= 201; i++) insert.run(i); })();
    // Trusted fixture policies test the generated shape, not external authority.
    let visibleMachine = true;
    const schema = withQueryFields(dataQueries(db, { tables: ['triggers', 'triggerLog', 'agentPauses','approvals','boxes'], visibility: {
      triggers: () => sql`true`, triggerLog: () => sql`true`, agentPauses: () => sql`true`, approvals: () => visibleMachine ? sql`true` : sql`false`, boxes: () => visibleMachine ? sql`true` : sql`false`,
    } }), tempoQueryFields(shared,{kind:'member',id:'owner'}));
    const result = await graphql({ schema, source: tempoQuery });
    expect(result.errors).toBeUndefined();
    expect(result.data?.triggers).toMatchObject([{ id: 'tr-1', enabled: true, note: 'Example' }]);
    expect(result.data?.triggerLog).toHaveLength(200);
    expect((result.data?.triggerLog as {seq: number}[])[0].seq).toBe(201);
    expect(result.data?.agentPauses).toEqual([]);
    expect(result.data?.triggers).toMatchObject([{ machineRow: null, machineApprovalRow: null }]);
    const at = '2026-11-14T00:00:00Z';
    shared.insert(members).values({ id: 'owner', role: 'owner', joinedAt: at }).run();
    shared.insert(boxes).values({ id: 'b', name: 'Desk', owner: 'owner', sameMachineAsLoom: true, hostsAny: true, reportOnly: false, alwaysOn: false, enrolledAt: at }).run();
    shared.insert(agents).values({ id: 'art', about: '', markBg: '#fff', markFg: '#000', faceShape: 'pebble', faceEyes: 'dot' }).run();
    shared.insert(approvals).values({ id: 'a', kind: 'setting', target: 'tr-1', what: 'machine', why: 'schedule', agent: 'art', actingFor: 'owner',
      askedFrom: 'tempo', state: 'used', minutes: 1, ask: 'Allow?', ifYes: 'Allow', ifNo: 'Stop', details: '', askedAt: at, decidedAt: at, decidedBy: 'owner' }).run();
    shared.update(triggers).set({ targetKind: 'inbox', toKind: 'agent', to: 'art', target: null, machine: 'b', machineApproval: 'a', machineWords: 'a'.repeat(64) }).where(eq(triggers.id, 'tr-1')).run();
    const machine = await graphql({ schema, source: tempoQuery });
    expect(machine.errors).toBeUndefined();
    expect(machine.data?.triggers).toMatchObject([{ machineRow: { name: 'Desk' }, machineApprovalRow: { decidedAt: at, decidedBy: 'owner' } }]);
    visibleMachine = false;
    const hidden = await graphql({ schema, source: tempoQuery });
    expect(hidden.errors).toBeUndefined();
    expect(hidden.data?.triggers).toMatchObject([{ machineRow: null, machineApprovalRow: null }]);
  } finally { db.close(); }
});
