import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getRequestListener } from '@hono/node-server';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { openDb, type Db } from './db/index.js';
import { Operations, failure } from './operations/index.js';
import { Live, type Authentication } from './live/index.js';
import { clock as realClock, type Clock } from './clock.js';
/** No piece imports: the composition root installs pieces through this public registry. */
export interface Foundation { db: Db; operations: Operations; live: Live; close(): void }
export function createFoundation({ home, clock = realClock }: { home: string; clock?: Clock }): Foundation {
  const store = openDb(home);
  let live: Live;
  const operations = new Operations(store.db, clock, changes => live.changed(changes));
  live = new Live(clock, operations);
  return { db: store.db, operations, live, close() { operations.close(); live.close(); store.close(); } };
}
export function httpDoor(app: Foundation, authenticate: (req: IncomingMessage) => Authentication | undefined) {
  const routes = new Hono<{ Bindings: { authentication: Authentication } }>();
  routes.use('*', bodyLimit({ maxSize: 1024 * 1024, onError: c => c.json(failure('invalid', 'Request body too large'), 413) }));
  routes.onError(() => Response.json(failure('unavailable', 'Request could not complete'), { status: 503 }));
  routes.post('/api/:piece/:operation', async c => {
    const auth = c.env.authentication;
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json(failure('invalid', 'Invalid JSON'), 400); }
    if (!body || typeof body !== 'object' || !('input' in body)) return c.json(failure('invalid', 'Expected {input, id?}'), 400);
    if (!auth.valid()) return c.json(failure('denied', 'Authentication ended'), 403);
    const id = 'id' in body ? body.id : undefined;
    if (id !== undefined && typeof id !== 'string') return c.json(failure('invalid', 'Invalid operation id'), 400);
    const answer = app.operations.call('http', auth.viewer, `${c.req.param('piece')}.${c.req.param('operation')}`, body.input, id);
    return c.json(answer, answer.ok ? 200 : ({ denied: 403, 'not-found': 404, invalid: 400, conflict: 409, unavailable: 503 } as const)[answer.code]);
  });
  return (req: IncomingMessage, res: ServerResponse) => {
    let auth: Authentication | undefined;
    try { auth = authenticate(req); } catch { /* invalid credentials fail closed */ }
    if (!auth || !auth.valid()) { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify(failure('denied', 'Authentication required'))); return; }
    const listener = getRequestListener(request => routes.fetch(request, { authentication: auth }));
    // Bind this resolved caller to this request, never a shared mutable current viewer.
    void listener(req, res);
  };
}
