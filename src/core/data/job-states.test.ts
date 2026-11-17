import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { createDataSchema } from './database.js';
import { activeJobStates } from './authentication.js';
import { claimedJobStates, endedJobStates, unendedJobStates } from './job-states.js';
import { jobs } from './schema.js';

it('sorts every job state the column allows into ended or not, once', () => {
  expect([...unendedJobStates, ...endedJobStates].sort()).toEqual([...jobs.state.enumValues].sort());
  expect(unendedJobStates.filter(state => state !== 'queued')).toEqual([...claimedJobStates]);
});
it('agrees with the index that allows a conversation one unended job', () => {
  const client = new Database(':memory:');
  try {
    createDataSchema(client, () => '2026-11-16T00:00:00.000Z');
    const index = client.prepare("select sql from sqlite_master where name = 'jobs_one_active_unique'").get() as { sql: string };
    const listed = [...index.sql.slice(index.sql.toLowerCase().lastIndexOf('where')).matchAll(/'([a-z]+)'/g)].map(match => match[1]);
    expect(listed.sort()).toEqual([...unendedJobStates].sort());
  } finally { client.close(); }
});
// The body-credential rule keeps its own list until it imports this one; meanwhile this holds the two equal.
it('agrees with the states in which a body credential is good', () => {
  expect([...activeJobStates].sort()).toEqual([...claimedJobStates].sort());
});
