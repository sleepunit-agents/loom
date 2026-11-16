export { withQueryFields } from './query-fields.js';
import { withQueryFields } from './query-fields.js';
import { guardedResponse } from './guarded-response.js';
import { Hono } from 'hono';
import { GraphQLSchema, type execute, type ExecutionArgs, type GraphQLFieldConfigMap } from 'graphql/index.js';
import { bodyLimit } from 'hono/body-limit';
import type { Viewer } from '../../policy.js';
import { createYoga } from 'graphql-yoga';
import type { Authentication } from '../live/index.js';
import { dataQueries } from './queries.js';
import { taskVisibility } from './visibility.js';
import { dataAuthentication } from './authentication.js';
import type { DataDatabase } from './database.js';
import { readRetained } from './read-lease.js';
import { ExecutionDrain } from './execution.js';

/** Authenticated GraphQL HTTP door on the shared connection. Authentication is
 * supplied by the composition's session/token resolver, never a request viewer.
 * No credential, session, plumbing or service-only table enters this schema.
 */
/** The fourth argument accepts either extra query fields or a caller-specific
 * root schema. The fifth adds shared fields to that root (e.g. Memory). */
export function dataHttp(db: DataDatabase, authenticate: (request: Request) => Authentication | undefined = dataAuthentication(db), publicOrigin?: string, schemaOrFields: ((viewer: Viewer) => GraphQLSchema) | GraphQLFieldConfigMap<unknown, { viewer: Viewer }> = {}, fields: GraphQLFieldConfigMap<unknown, { viewer: Viewer }> = {}, readVersion?: () => number, now: () => number = Date.now) {
  const app = new Hono();
  const executions = new ExecutionDrain();
  let stopping = false;
  app.use('*', bodyLimit({ maxSize: 1024 * 1024 }));
  app.use('*', async (c, next) => { await next(); c.res.headers.set('cache-control', 'no-store'); });
  app.onError(() => Response.json({ errors: [{ message: 'Data request could not complete' }] }, { status: 503, headers: { 'cache-control': 'no-store' } }));
  app.all('/graphql', async c => {
    if (stopping) return c.json({ errors: [{ message: 'Data request could not complete' }] }, 503);
    // No CORS: cookies must remain same-origin. Fetch Metadata also covers
    // browser requests without Origin. Bearers may be used by outside clients.
    const origin = c.req.header('origin');
    const url = new URL(c.req.url);
    const originAllowed = !origin || origin === url.origin || (origin === publicOrigin && new URL(publicOrigin).host === url.host);
    if (c.req.header('sec-fetch-site') === 'cross-site' || !originAllowed) return c.json({ errors: [{ message: 'Cross-origin request refused' }] }, 403);
    // The only live transport will be graphql-ws; do not negotiate Yoga SSE.
    if ((c.req.header('accept') ?? '').toLowerCase().includes('text/event-stream')) return c.json({ errors: [{ message: 'SSE is not supported' }] }, 406);
    if (c.req.method !== 'POST') return c.json({ errors: [{ message: 'Use POST' }] }, 405);
    if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('content-type') ?? '')) return c.json({ errors: [{ message: 'Use application/json' }] }, 415);
    let auth: Authentication | undefined;
    try { auth = authenticate(c.req.raw); } catch { /* fail closed */ }
    if (stopping) return c.json({ errors: [{ message: 'Data request could not complete' }] }, 503);
    if (!auth?.valid() || stopping) return c.json({ errors: [{ message: 'Authentication required' }] }, 401);
    // Outside programs are never treated as installed services. Runner reads
    // will get a separate safe projection rather than inheriting member reads.
    if (auth.viewer.kind === 'service' || auth.viewer.kind === 'runner') return c.json({ errors: [{ message: 'Caller has no data projection' }] }, 403);
    const version = readVersion?.();
    const generated = typeof schemaOrFields === 'function' ? schemaOrFields(auth.viewer) : dataQueries(db.$client, { tables: ['tasks', 'taskComments', 'taskLinks', 'projects', 'agents'], visibility: taskVisibility(auth.viewer) });
    const extraFields = typeof schemaOrFields === 'function' ? fields : { ...schemaOrFields, ...fields };
    const schema = executions.schema(withQueryFields(generated, extraFields), () => !stopping);
    const context = Object.freeze({ viewer: auth.viewer });
    let executionContext: unknown = context;
    const current = () => (!readVersion || version === readVersion()) && readRetained(executionContext, now());
    const yoga = createYoga({ schema, graphqlEndpoint: '/graphql', graphiql: false, logging: false,
      cors: false, batching: false,
      context: () => context,
      plugins: [{
        // The adapter's fetch() can race abort and return before this handler.
        // Retain the actual pipeline, including result serialization, instead.
        onRequest({ requestHandler, setRequestHandler }) {
          setRequestHandler((...args) => executions.run(() => requestHandler(...args)));
        },
        onExecute({ args, executeFn, setExecuteFn }: { args: ExecutionArgs; executeFn: typeof execute; setExecuteFn(fn: typeof execute): void }) {
          if (stopping || !auth!.valid() || stopping) throw new Error('Authentication ended');
          executionContext = args.contextValue;
          setExecuteFn(args => executions.run(() => executeFn(args)));
        },
        onSubscribe() { throw new Error('Use the websocket for subscriptions'); },
      }],
    });
    const response = await yoga.fetch(c.req.raw);
    // Body parsing and execution can yield. Never release buffered words after
    // a session ends, even if revocation happened during that async boundary.
    const body = await response.text();
    if (stopping) return c.json({ errors: [{ message: 'Data request could not complete' }] }, 503);
    if (!auth.valid() || stopping) return c.json({ errors: [{ message: 'Authentication ended' }] }, 401);
    if (!current()) return c.json({ errors: [{ message: 'Data changed; retry the query' }] }, 503);
    auth.activity?.();
    if (stopping) return c.json({ errors: [{ message: 'Data request could not complete' }] }, 503);
    if (!auth.valid() || stopping) return c.json({ errors: [{ message: 'Authentication ended' }] }, 401);
    if (!current()) return c.json({ errors: [{ message: 'Data changed; retry the query' }] }, 503);
    const available = () => !stopping && auth!.valid() && !stopping && current();
    return guardedResponse(body, { status: response.status, headers: response.headers }, available);
  });
  return Object.assign(app, { stop() { stopping = true; }, drain: () => executions.drain() });
}
