/** The sole composition root for --next. No old page routes or piece programs. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { Hono } from 'hono';
import { getRequestListener } from '@hono/node-server';
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Foundation } from './core/app.js';
import { httpDoor } from './core/app.js';
import type { Authentication } from './core/live/index.js';
import type { Sharing } from './core/index.js';
import { installTasks } from './pieces/tasks/index.js';
import { migrateHouseholdTables } from './core/household/schema.js';
import { SharingDatabase } from './core/household/sharing.js';
import { installEffects } from './core/effects.js';
export type NextSessionResolver = (req: IncomingMessage) => Authentication | undefined;
/** t-2203 plugs the loom.db session resolver in here. No legacy fallback. */
export function nextSessionResolver(_app: Foundation): NextSessionResolver { return () => undefined; }
export interface NextOptions {
  home: string; staging?: boolean; host?: string; port?: number; webRoot?: string;
  authenticate?: NextSessionResolver; sharing?: () => Sharing;
}
export function installNext(app: Foundation, options: NextOptions) {
  migrateHouseholdTables(app.db);
  const sharing = options.sharing ?? (() => new SharingDatabase(app.db, options.home).sharing());
  if (!app.operations.has('tasks.list')) installTasks(app.db, app.operations, app.live, sharing);
  return installEffects(app, sharing, !!options.staging);
}
export async function listenNext(app: Foundation, options: NextOptions) {
  const auth = options.authenticate ?? nextSessionResolver(app);
  const api = httpDoor(app, auth);
  const root = resolve(options.webRoot ?? resolve(import.meta.dirname, 'web'));
  const routes = new Hono<{ Bindings: { incoming: IncomingMessage } }>();
  routes.get('/health', c => c.json({ ok: true, next: true, staging: !!options.staging }));
  routes.all('/mcp', async c => {
    // A stateless transport per request binds every call to this caller.
    const authentication = auth(c.env.incoming as IncomingMessage);
    if (!authentication?.valid()) return c.json({ error: 'Authentication required' }, 401);
    const server = new McpServer({ name: 'loom-next', version: '1' });
    for (const op of app.operations.offered('mcp')) server.registerTool(op.name, {
      inputSchema: z.object({ input: op.input, id: z.string().optional() }),
    }, async args => {
      const result = authentication.valid() ? app.operations.call('mcp', authentication.viewer, op.name, args.input, args.id) : { ok: false, code: 'denied', message: 'Authentication ended' };
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], isError: !result.ok };
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try { return await transport.handleRequest(c.req.raw); }
    finally { await transport.close(); await server.close(); }
  });
  routes.get('*', c => {
    const pathname = new URL(c.req.url).pathname;
    if (pathname.startsWith('/api/') || pathname === '/events' || pathname.startsWith('/collections') || pathname === '/live') return c.notFound();
    const asset = pathname.startsWith('/app/');
    const file = asset ? resolve(root, '.' + pathname.slice(4)) : resolve(root, 'next.html');
    if (!file.startsWith(root + sep) || !existsSync(file)) return c.notFound();
    return new Response(!asset && app.operations.has('example.put') ? readFileSync(file,'utf8').replace('<html ', '<html data-fixture="true" ') : readFileSync(file), { headers: {
      'content-type': ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png' } as Record<string,string>)[extname(file)] ?? 'application/octet-stream',
      'cache-control': asset ? 'public, max-age=31536000, immutable' : 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'",
    } });
  });
  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url?.startsWith('/api/')) return api(req, res);
    void getRequestListener(request => routes.fetch(request, { incoming: req }))(req, res);
  });
  const detach = app.live.attach(http, auth);
  try {
    await new Promise<void>((ok, no) => { http.once('error', no); http.listen(options.port ?? 0, options.host ?? '127.0.0.1', ok); });
  } catch (e) { detach(); throw e; }
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('no next address');
  return { url: `http://${options.host ?? '127.0.0.1'}:${address.port}`, async close() {
    detach(); http.closeAllConnections();
    await new Promise<void>((ok, no) => http.close(e => e ? no(e) : ok()));
  } };
}
