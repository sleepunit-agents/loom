import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { graphql } from 'graphql/index.js';
import type { Viewer } from '../../policy.js';
import { createDataSchema, type DataDatabase } from '../data/database.js';
import { dataQueries } from '../data/queries.js';
import { agents, members, measuringSettings, timingDays } from '../data/schema.js';
import { measuringVisibility } from './visibility.js';

let client: Database.Database;
let db: DataDatabase;
let statements: string[];
beforeEach(() => {
  statements = [];
  client = new Database(':memory:', { verbose: statement => statements.push(String(statement)) });
  db = createDataSchema(client);
  db.insert(members).values([
    { id: 'owner', role: 'owner', joinedAt: '2026-11-14T00:00:00Z' },
    { id: 'member', role: 'member', joinedAt: '2026-11-14T00:00:00Z' },
  ]).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000000', markFg: '#ffffff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(measuringSettings).values({ on: true, sendOutside: true, outsideAddress: 'https://collector.example/v1/traces' }).run();
  db.insert(timingDays).values([
    { day: '2026-11-13', kind: 'request', name: 'graphql', count: 2, totalMs: 20, slowestMs: 15, typicalMs: 10 },
    { day: '2026-11-14', kind: 'job', name: 'github.read', count: 1, totalMs: 4, slowestMs: 4, typicalMs: 4 },
  ]).run();
});
afterEach(() => client.close());
const schemaFor = (viewer: Viewer) => dataQueries(client, {
  tables: ['timingDays', 'measuringSettings'], visibility: measuringVisibility(viewer),
});
const source = '{ timingDays { day kind name count totalMs slowestMs typicalMs } measuringSettings { on outsideAddress } }';

it.each([
  [{ kind: 'member', id: 'owner' }, 2, 1],
  [{ kind: 'agent', id: 'art' }, 2, 0],
  [{ kind: 'member', id: 'member' }, 0, 0],
  [{ kind: 'member', id: 'absent' }, 0, 0],
  [{ kind: 'agent', id: 'absent' }, 0, 0],
  [{ kind: 'runner', id: 'owner' }, 0, 0],
  [{ kind: 'service', id: 'art' }, 0, 0],
] as const)('reads only the Measuring projection for %j', async (viewer, timings, settings) => {
  const result = await graphql({ schema: schemaFor(viewer), source });
  expect(result.errors).toBeUndefined();
  expect(result.data?.timingDays).toHaveLength(timings);
  expect(result.data?.measuringSettings).toHaveLength(settings);
  if (timings) expect(result.data?.timingDays).toContainEqual({
    day: '2026-11-13', kind: 'request', name: 'graphql', count: 2, totalMs: 20, slowestMs: 15, typicalMs: 10,
  });
});

it('rechecks owner role and agent existence for already generated schemas', async () => {
  const owner = schemaFor({ kind: 'member', id: 'owner' });
  const agent = schemaFor({ kind: 'agent', id: 'art' });
  expect((await graphql({ schema: owner, source })).data?.timingDays).toHaveLength(2);
  expect((await graphql({ schema: agent, source })).data?.timingDays).toHaveLength(2);
  db.update(members).set({ role: 'member' }).where(eq(members.id, 'owner')).run();
  db.delete(agents).where(eq(agents.id, 'art')).run();
  for (const schema of [owner, agent]) {
    const result = await graphql({ schema, source });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ timingDays: [], measuringSettings: [] });
  }
});

it('cannot replace the captured identity or bypass policy with aliases and filters', async () => {
  const viewer: Viewer = { kind: 'member', id: 'member' };
  const schema = schemaFor(viewer);
  viewer.id = 'owner';
  const result = await graphql({ schema, source: '{ stolen: timingDays(limit: 1, where: { name: { eq: "graphql" } }) { count } settings: measuringSettings { outsideAddress } }' });
  expect(result.errors).toBeUndefined();
  expect(result.data).toEqual({ stolen: [], settings: [] });
  expect(schema.getMutationType()).toBeUndefined();
});

it('constrains generated database reads with the live SQL membership predicate', async () => {
  for (const viewer of [{ kind: 'member', id: 'member' }, { kind: 'agent', id: 'art' }] as const) {
    const schema = schemaFor(viewer);
    statements.length = 0;
    const result = await graphql({ schema, source });
    expect(result.errors).toBeUndefined();
    const reads = statements.filter(statement => /^select /i.test(statement));
    expect(reads).toHaveLength(2);
    const timings = reads.find(statement => /from "timing_days"/.test(statement));
    const settings = reads.find(statement => /from "measuring_settings"/.test(statement));
    expect(timings).toMatch(viewer.kind === 'member'
      ? /where.*exists.*from "members".*"role" = 'owner'/is
      : /where.*exists.*from "agents"/is);
    expect(settings).toMatch(viewer.kind === 'member'
      ? /where.*exists.*from "members".*"role" = 'owner'/is
      : /where.*false/is);
  }
});

it('does not consult the supplied object after capturing its identity', async () => {
  const reads: PropertyKey[] = [];
  const caller = Proxy.revocable<Viewer>({ kind: 'agent', id: 'art' }, {
    get(target, key, receiver) {
      // What the rules read of a viewer: who it is and, for an agent's body, the member it works for.
      if (key !== 'kind' && key !== 'id' && key !== 'workingFor') throw new Error('Non-identity read');
      reads.push(key);
      return Reflect.get(target, key, receiver);
    },
    ownKeys() { throw new Error('Caller enumeration'); },
  });
  const visibility = measuringVisibility(caller.proxy);
  expect(reads).toEqual(['kind', 'kind', 'id', 'workingFor']);
  caller.revoke();
  const schema = dataQueries(client, { tables: ['timingDays', 'measuringSettings'], visibility });
  const result = await graphql({ schema, source });
  expect(result.errors).toBeUndefined();
  expect(result.data?.timingDays).toHaveLength(2);
  expect(result.data?.measuringSettings).toEqual([]);
});
