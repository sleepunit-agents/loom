import { Hono } from 'hono';
import { GraphQLObjectType, GraphQLSchema, type GraphQLFieldConfigMap } from 'graphql/index.js';
import { bodyLimit } from 'hono/body-limit';
import type { Viewer } from '../../policy.js';
import { createYoga } from 'graphql-yoga';
import type { Authentication } from '../live/index.js';
import { dataQueries } from './queries.js';
import { taskVisibility } from './visibility.js';
import { dataAuthentication } from './authentication.js';
import type { DataDatabase } from './database.js';

/** Authenticated GraphQL HTTP door on the shared connection. Authentication is
 * supplied by the composition's session/token resolver, never a request viewer.
 * No credential, session, plumbing or service-only table enters this schema.
 */
/** The fourth argument accepts either extra query fields or a caller-specific
 * root schema. The fifth adds shared fields to that root (e.g. Memory). */
export function dataHttp(db: DataDatabase, authenticate: (request: Request) => Authentication | undefined = dataAuthentication(db), publicOrigin?: string, schemaOrFields: ((viewer: Viewer) => GraphQLSchema) | GraphQLFieldConfigMap<unknown, { viewer: Viewer }> = {}, fields: GraphQLFieldConfigMap<unknown, { viewer: Viewer }> = {}) {
  const app = new Hono();
  app.use('*', bodyLimit({ maxSize: 1024 * 1024 }));
  app.use('*', async (c, next) => { await next(); c.header('cache-control', 'no-store'); });
  app.onError(() => Response.json({ errors: [{ message: 'Data request could not complete' }] }, { status: 503, headers: { 'cache-control': 'no-store' } }));
  app.all('/graphql', async c => {
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
    if (!auth?.valid()) return c.json({ errors: [{ message: 'Authentication required' }] }, 401);
    // Outside programs are never treated as installed services. Runner reads
    // will get a separate safe projection rather than inheriting member reads.
    if (auth.viewer.kind === 'service' || auth.viewer.kind === 'runner') return c.json({ errors: [{ message: 'Caller has no data projection' }] }, 403);
    const generated = typeof schemaOrFields === 'function' ? schemaOrFields(auth.viewer) : dataQueries(db.$client, { tables: ['tasks', 'taskComments', 'taskLinks', 'projects', 'agents'], visibility: taskVisibility(auth.viewer) });
    const extraFields = typeof schemaOrFields === 'function' ? fields : { ...schemaOrFields, ...fields };
    const query = generated.getQueryType()!;
    const schema = new GraphQLSchema({ ...generated.toConfig(), types: generated.toConfig().types.filter(type => type !== query), query: new GraphQLObjectType({
      ...query.toConfig(), fields: { ...query.toConfig().fields, ...extraFields },
    }) });
    const yoga = createYoga({ schema, graphqlEndpoint: '/graphql', graphiql: false, logging: false,
      cors: false, batching: false,
      context: () => Object.freeze({ viewer: auth!.viewer }),
      plugins: [{ onExecute() { if (!auth!.valid()) throw new Error('Authentication ended'); } }],
    });
    const response = await yoga.fetch(c.req.raw);
    // Body parsing and execution can yield. Never release buffered words after
    // a session ends, even if revocation happened during that async boundary.
    const body = await response.text();
    if (!auth.valid()) return c.json({ errors: [{ message: 'Authentication ended' }] }, 401);
    auth.activity?.();
    return new Response(body, { status: response.status, headers: response.headers });
  });
  return app;
}
