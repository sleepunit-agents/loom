import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { graphql } from 'graphql/index.js';
import { expect, it } from 'vitest';
import { approvalService } from '../../apps/approvals.js';
import { FakeClock } from '../clock.js';
import { createDataSchema } from '../data/database.js';
import { dataQueries } from '../data/queries.js';
import { agents, members, timingDays } from '../data/schema.js';
import { DEFAULT_MEASURING } from './index.js';
import { measuringRuntime } from './runtime.js';
import { MEASURING_SETTINGS_OPERATION, measuringSettingsService } from './settings.js';
import { timingStore } from './store.js';
import { measuringVisibility } from './visibility.js';

// Composition regression fixture, not a second production command door. The
// real root must preserve this ordering around its own authenticated commands.
it('connects durable approvals, outer commits, the runtime and generated Measuring reads', async () => {
  const client = new Database(':memory:');
  const clock = new FakeClock(Date.UTC(2026, 10, 14));
  const now = () => new Date(clock.now()).toISOString();
  const db = createDataSchema(client, now);
  const settings = measuringSettingsService(db);
  const targets = [
    { kind: 'request', name: 'graphql' },
    { kind: 'operation', name: 'tasks.create' },
    { kind: 'job', name: 'github.read' },
  ] as const;
  const runtime = measuringRuntime(settings.read, targets, timingStore(db), undefined, clock);
  try {
    db.insert(members).values({ id: 'owner', role: 'owner', joinedAt: now() }).run();
    db.insert(agents).values({ id: 'art', about: '', markBg: '#fff', markFg: '#000', faceShape: 'pebble', faceEyes: 'dot' }).run();
    const recreateApprovals = () => approvalService(db, new Map([
      [MEASURING_SETTINGS_OPERATION, measuringSettingsService(db).apply],
    ]), now);
    const propose = (on: boolean) => recreateApprovals().request({
      ...settings.prepare({ ...DEFAULT_MEASURING, on }), agent: 'art',
      askedFrom: 'house', actingFor: 'owner', what: 'Change Measuring settings',
      why: 'Compare request, operation and job timings', ask: 'Change Measuring settings?',
      ifYes: 'Apply these settings', ifNo: 'Keep the current settings',
    });
    const schema = (kind: 'member' | 'agent', id: string) => dataQueries(client, {
      tables: ['timingDays', 'measuringSettings'], visibility: measuringVisibility({ kind, id }),
    });
    // Keep these schemas across writes; visibility must remain a live SQL check.
    const owner = schema('member', 'owner'), agent = schema('agent', 'art');
    const source = '{ timingDays { kind name count } measuringSettings { on } }';
    const read = async (querySchema: typeof owner) => {
      const result = await graphql({ schema: querySchema, source });
      expect(result.errors).toBeUndefined();
      return result.data;
    };
    await runtime.reload();
    runtime.run('request', 'graphql', () => 1);
    expect(await read(owner)).toEqual({ timingDays: [], measuringSettings: [] });
    const denied = propose(true);
    recreateApprovals().deny(denied.id, 'owner');
    expect(settings.read().on).toBe(false);

    const pending = propose(true);
    // A successful nested Approvals transaction is not the outer commit.
    expect(() => db.transaction(() => {
      recreateApprovals().allow(pending.id, 'owner');
      expect(settings.read().on).toBe(true);
      runtime.run('operation', 'tasks.create', () => 2);
      throw new Error('outer receipt failed');
    })).toThrow('outer receipt failed');
    expect(settings.read().on).toBe(false);
    expect(recreateApprovals().get(pending.id).state).toBe('pending');
    expect(db.select().from(timingDays).all()).toEqual([]);

    db.transaction(() => recreateApprovals().allow(pending.id, 'owner'));
    runtime.run('request', 'graphql', () => 3);
    expect(db.select().from(timingDays).all()).toEqual([]);
    await runtime.reload(); // Only after the outer transaction returned.
    expect(runtime.run('request', 'graphql', () => 4)).toBe(4);
    const failure = new Error('private operation words');
    expect(() => runtime.run('operation', 'tasks.create', () => { throw failure; })).toThrow(failure);
    expect(await runtime.runAsync('job', 'github.read', async () => 5)).toBe(5);
    const rows = targets.map(({ kind, name }) => ({ kind, name, count: 1 }));
    const visible = await read(agent);
    expect(visible?.timingDays).toEqual(expect.arrayContaining(rows));
    expect(visible?.timingDays).toHaveLength(3);
    expect(visible?.measuringSettings).toEqual([]);
    expect((await read(owner))?.measuringSettings).toEqual([{ on: true }]);
    expect(JSON.stringify(visible)).not.toContain('private operation words');

    const disabling = propose(false);
    db.transaction(() => recreateApprovals().allow(disabling.id, 'owner'));
    await runtime.reload();
    runtime.run('request', 'graphql', () => 6);
    expect((await read(agent))?.timingDays).toEqual(visible?.timingDays);
    expect((await read(owner))?.measuringSettings).toEqual([{ on: false }]);
    db.update(members).set({ role: 'member' }).where(eq(members.id, 'owner')).run();
    // Keep the agent row: the approval audit still references it.
    expect(await read(owner)).toEqual({ timingDays: [], measuringSettings: [] });
    expect((await read(agent))?.timingDays).toHaveLength(3);
  } finally {
    await runtime.close();
    client.close();
    clock.advance(2 * 86400_000); // No retained timer may touch the closed DB.
  }
});
