/** Fresh shared composition. The caller initializes the approved schema and owns
 * the connection; this never bootstraps legacy tables or opens another store. */
import type { IncomingMessage } from 'node:http';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { DataDatabase } from './core/data/database.js';
import { dataAuthentication } from './core/data/authentication.js';
import { OperationResults } from './core/data/operation-results.js';
import type { Clock } from './core/clock.js';
import { Operations, failure, type Change } from './core/operations/index.js';
import { taskService } from './apps/tasks.js';
import { approvalService, type ApprovedOperations } from './apps/approvals.js';
import { Conversations } from './core/conversations/index.js';
import { nextData } from './next-data.js';

const envelope = z.object({ input: z.unknown(), id: z.string().min(1).max(200).optional() }).strict();
export function sharedRoot(options: {
  db: DataDatabase;
  clock: Clock;
  originAllowed(request: IncomingMessage): boolean;
  publicOrigin?: string;
  fields?: Parameters<typeof nextData>[4];
  approvedOperations?: ApprovedOperations;
  changed?(changes: Change[]): void;
  reportError(error: unknown): void;
}) {
  const { db, clock } = options;
  const now = () => new Date(clock.now()).toISOString();
  const data = nextData(db, clock, options.originAllowed, options.publicOrigin, options.fields);
  const operations = new Operations(db.$client, clock, changes => options.changed?.(changes), {
    receipts: new OperationResults(db), writes: data.writes, reportError: options.reportError,
  });
  const services = {
    tasks: taskService(db, now),
    approvals: approvalService(db, options.approvedOperations, now),
    conversations: new Conversations(db, now),
  };
  const authenticate = dataAuthentication(db, () => clock.now());
  let closing: Promise<void> | undefined;
  const http = new Hono();
  http.use('*', async (c, next) => {
    c.header('cache-control', 'no-store');
    if (closing) return c.json(failure('unavailable', 'Loom is closing'), 503);
    await next();
  });
  http.all('/graphql', c => data.http.fetch(c.req.raw));
  http.use('/api/*', bodyLimit({ maxSize: 1024 * 1024, onError: c => c.json(failure('invalid', 'Request body too large'), 413) }));
  http.onError(() => Response.json(failure('unavailable', 'Request could not complete'), { status: 503, headers: { 'cache-control': 'no-store' } }));
  http.post('/api/:piece/:operation', async c => {
    const request = c.req.raw, origin = request.headers.get('origin'), url = new URL(request.url);
    if (request.headers.get('sec-fetch-site') === 'cross-site' || (origin && origin !== url.origin && !(origin === options.publicOrigin && new URL(origin).host === url.host)))
      return c.json(failure('denied', 'Cross-origin request refused'), 403);
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) return c.json(failure('invalid', 'Use application/json'), 415);
    const auth = authenticate(request);
    if (!auth?.valid()) return c.json(failure('denied', 'Authentication required'), 401);
    let body: unknown;
    try { body = await request.json(); } catch { return c.json(failure('invalid', 'Invalid JSON'), 400); }
    const parsed = envelope.safeParse(body);
    if (!parsed.success) return c.json(failure('invalid', 'Expected {input, id?}'), 400);
    if (closing || !auth.valid()) return c.json(failure('denied', 'Authentication ended'), 403);
    const answer = await operations.callAsync('http', auth.viewer, `${c.req.param('piece')}.${c.req.param('operation')}`,
      parsed.data.input, parsed.data.id, false, () => !closing && auth.valid());
    return c.json(answer, answer.ok ? 200 : ({ denied: 403, 'not-found': 404, invalid: 400, conflict: 409, unavailable: 503 } as const)[answer.code]);
  });
  return {
    http, operations, services, writes: data.writes,
    attach(server: Parameters<typeof data.attach>[0]) {
      if (closing) throw new Error('Loom is closing');
      return data.attach(server);
    },
    /** Stop admission synchronously; the caller closes SQLite only after this. */
    close() {
      if (closing) return closing;
      closing = Promise.resolve().then(async () => { try { await data.close(); } finally { operations.close(); } });
      return closing;
    },
  };
}
