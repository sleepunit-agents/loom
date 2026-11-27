/** The selections the conversations list and the agent bricks wrote for themselves, checked against the fields
 * loom serves (as brick-queries.test.ts does for the pull and repository bricks): every field and argument they
 * name exists. The rest of what these bricks read is the desktop's own selections, which have their suites. */
import { expect, it } from 'vitest';
// The root's graphql, the one loom's fields are built with (web/ has its own copy).
import { GraphQLObjectType, GraphQLSchema, parse, validate } from '../../../node_modules/graphql/index.js';
import { commsQueryFields, type CommsQueries } from '../../../src/core/conversations/comms-query.js';
import { jobSummaryFields, type JobSummaries } from '../../../src/runtime/job-summary.js';
import { boardsThreadsQuery } from './agents-data';
import { agentJobsQuery } from './bricks-agent';
import { agentsAtWorkQuery } from './bricks-agents';
import { threadHeadQuery } from './threads';

it('reads threads, an agent\'s jobs and the agents at work with selections loom answers', () => {
  // Nothing is resolved here: the services are never called, only their fields' shapes are read.
  const service = { activityFields: () => ({}), archivedHistory: () => ({ type: new GraphQLObjectType({ name: 'Unused', fields: { id: { type: new GraphQLObjectType({ name: 'U', fields: {} }) } } }) }) } as unknown as CommsQueries;
  const { commsArchivedQuestions: _unused, ...comms } = commsQueryFields(service);
  const schema = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: { ...comms, ...jobSummaryFields({} as JobSummaries) } }) });
  for (const query of [boardsThreadsQuery, threadHeadQuery, agentJobsQuery, agentsAtWorkQuery]) expect(validate(schema, parse(query)).map((e) => e.message), query).toEqual([]);
  expect(boardsThreadsQuery).toContain('unread');
  expect(validate(schema, parse('{ commsThreads { nonesuch } }'))).toHaveLength(1);
});
