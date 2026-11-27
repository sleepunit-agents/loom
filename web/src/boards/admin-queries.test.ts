/** The selections the bricks for running the household wrote for themselves, checked against the fields loom
 * serves (as brick-queries.test.ts and agents-queries.test.ts do): every field and argument they name exists.
 * The rest of what these bricks read is the desktop's own selections, which have their suites. */
import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
// The root's graphql, the one loom's fields are built with (web/ has its own copy).
import { graphql, GraphQLObjectType, GraphQLSchema, parse, validate } from '../../../node_modules/graphql/index.js';
import { sql } from 'drizzle-orm';
import { createDataSchema } from '../../../src/core/data/database.js';
import { dataQueries, type QueryVisibility } from '../../../src/core/data/queries.js';
import * as s from '../../../src/core/data/schema.js';
import { jobSummaryFields, type JobSummaries } from '../../../src/runtime/job-summary.js';
import { machineJobSummaryField } from '../../../src/runtime/machine-job-summaries.js';
import { machineFactsQuery, machineJobsQuery } from './bricks-machines';

it('reads a machine\'s facts and the alert lines with a selection the generated schema answers', async () => {
  const client = new Database(':memory:');
  try {
    const at = '2026-11-14T00:00:00.000Z';
    const db = createDataSchema(client, () => at);
    db.insert(s.members).values({ id: 'sam', role: 'owner', joinedAt: at }).run();
    db.insert(s.boxes).values({ id: 'box-1', name: 'Den', owner: 'sam', sameMachineAsLoom: true, hostsAny: false, reportOnly: true, alwaysOn: false, enrolledAt: at, lastSeenAt: at, slots: 3 }).run();
    const tables = ['boxes', 'boxAlertSettings'] as const;
    const schema = dataQueries(client, { tables, visibility: Object.fromEntries(tables.map(name => [name, () => sql`true`])) as QueryVisibility });
    const result = await graphql({ schema, source: machineFactsQuery });
    expect(result.errors).toBeUndefined();
    expect((result.data as { boxes: object[] }).boxes).toEqual([{ id: 'box-1', sameMachineAsLoom: true, lastSeenAt: at, slots: 3 }]);
    expect(Array.isArray((result.data as { boxAlertSettings: object[] }).boxAlertSettings)).toBe(true);
  } finally { client.close(); }
});

it('reads the jobs of several agents in one request with fields loom serves', () => {
  const viewer = { kind: 'member', id: 'sam' } as const;
  const schema = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: { ...jobSummaryFields({} as JobSummaries), privateMachineJobs: machineJobSummaryField({} as never, viewer as never) } }) });
  for (const count of [1, 3]) expect(validate(schema, parse(machineJobsQuery(count))).map((e) => e.message), String(count)).toEqual([]);
  expect(validate(schema, parse('{ jobHistory(agent:"a") { nonesuch } }'))).toHaveLength(1);
});
