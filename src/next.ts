/** The sole composition root for --next. No old page routes or piece programs. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { Hono } from 'hono';
import { getRequestListener } from '@hono/node-server';
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Socket } from 'node:net';
import type { Foundation } from './core/app.js';
import { httpDoor } from './core/app.js';
import type { Authentication } from './core/live/index.js';
import type { Sharing } from './core/index.js';
import { installSharing } from './pieces/sharing/index.js';
import { installTasks } from './pieces/tasks/index.js';
import { installBridges } from './pieces/bridges/index.js';
import { installApprovals } from './pieces/approvals/index.js';
import { installRuntime } from './pieces/runtime/index.js';
import { installChanges } from './pieces/changes/index.js';
import { householdProjects, householdAttribution } from './pieces/changes/daemon.js';
import { migrateHouseholdTables } from './core/household/schema.js';
import { HouseholdDatabase } from './core/household/document.js';
import { SharingDatabase } from './core/household/sharing.js';
import { installEffects } from './core/effects.js';
import { signin, installSignin, sameOrigin } from './core/signin/index.js';
import { signinRoutes } from './core/signin/routes.js';
import { mindSources } from './pieces/mind/sources.js';
import { mindTouchSources, mindTouchResolver } from './pieces/mind/binding.js';
import { installMindPeople } from './pieces/mind/people.js';
import { installMindPeopleActions } from './pieces/mind/people-actions.js';
import { createPersonHalf } from './backends/people-creation.js';
import { installMindKnowledge } from './pieces/mind/index.js';
import { installMindKnowledgeActions } from './pieces/mind/actions.js';
import { verifyKnowledgePages, deriveSlaClass } from './backends/knowledge-verification.js';
import { installTouched, type TouchSource } from './core/touched/index.js';
import { listenForTouchSources } from './core/touched/group.js';
import { prepareTouchSources } from './core/touched/prepare.js';
const mindTransports = new WeakMap<Foundation, TouchSource[]>();
export type NextSessionResolver = (req: IncomingMessage) => Authentication | undefined;
/** t-2203 plugs the loom.db session resolver in here. No legacy fallback. */
export function nextSessionResolver(app: Foundation): NextSessionResolver { return req => signin(app).resolve(req); }
export interface NextOptions {
  home: string; staging?: boolean; host?: string | string[]; port?: number; webRoot?: string;
  authenticate?: NextSessionResolver; sharing?: () => Sharing;
}
export function installNext(app: Foundation, options: NextOptions) {
  migrateHouseholdTables(app.db);
  if (!app.operations.has('signin.link')) installSignin(app);
  if (!app.operations.has('household.createProject')) installSharing(app, options.home);
  const sharing = options.sharing ?? (() => new SharingDatabase(app.db, options.home).sharing());
  if (!app.operations.has('tasks.list')) installTasks(app.db, app.operations, app.live, sharing);
  if (!app.operations.has('bridges.putVenues')) installBridges(app, sharing);
  if (!app.operations.has('approvals.list')) installApprovals(app.db, app.operations, app.live, sharing, {
    projects: () => {
      try {
        const store = new SharingDatabase(app.db, options.home);
        return store.projectIds().map(id => {
          const project = store.project(id)!;
          return { slug: project.slug, repos: project.repositories.map(raw => {
            const selector = raw.trim();
            const repo = /^[a-z][a-z0-9-]{0,23}:/.test(selector) ? selector : `github:${selector}`;
            const colon = repo.indexOf(':');
            return repo.slice(0, colon + 1) + repo.slice(colon + 1).toLowerCase();
          }) };
        });
      } catch { return undefined; } // Unreadable metadata must preserve the asking fallback.
    },
  });
  if (!app.operations.has('runtime.listBoxes')) installRuntime(app.db, app.operations, app.live, sharing);
  if (!app.operations.has('changes.list')) installChanges(app.db, app.operations, app.live, sharing, {
    projects: householdProjects(new SharingDatabase(app.db, options.home)),
    attribution: () => householdAttribution(app.db, options.home),
    knownAgents: () => new HouseholdDatabase(app.db).household(options.home)?.agents ?? [],
  });
  const inventory = mindSources(app.db, options.home);
  if (!app.operations.has('mind.knowledgeList')) {
    const path = inventory?.commons.knowledge;
    const reader = installMindKnowledge(app.operations, app.live, { path, sharing });
    app.onClose(() => reader.close());
    const actions = installMindKnowledgeActions(app.operations, { path, sharing, verify: verifyKnowledgePages, classify: domain => deriveSlaClass(null, domain) });
    app.onClose(() => actions.close());
  }

  if (!app.operations.has('mind.peopleList')) {
    const reader = installMindPeople(app.operations, app.live, { directory: inventory?.commons.people, agents: inventory?.agents ?? [], sharing,
      projectHref: (agent, slug) => app.operations.has('mind.projectsList') ? `/p/projects-preview/project/${encodeURIComponent(`${agent}:${slug}`)}` : undefined });
    app.onClose(() => reader.close());
    const agent = new HouseholdDatabase(app.db).household(options.home)?.default;
    const actions = installMindPeopleActions(app.operations, { directory: inventory?.commons.people,
      relationship: inventory?.agents.find(a => a.agent === agent)?.memories, agent, sharing, create: createPersonHalf });
    app.onClose(() => actions.close());
  }
  const sources = mindTouchSources(inventory);
  if (!app.operations.has('core.touched')) installTouched(app.operations, mindTouchResolver(sources));
  mindTransports.set(app, sources);
  return installEffects(app, sharing, !!options.staging);
}
export async function listenNext(app: Foundation, options: NextOptions) {
  const sources = mindTransports.get(app) ?? [];
  await prepareTouchSources(sources);
  const stopTouches = await listenForTouchSources(app.operations, sources);
  const auth = options.authenticate ?? nextSessionResolver(app);
  const api = httpDoor(app, auth);
  const root = resolve(options.webRoot ?? resolve(import.meta.dirname, '../dist/web'));
  const routes = new Hono<{ Bindings: { incoming: IncomingMessage } }>();
  routes.route('/', signinRoutes(app));
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
    const body = asset ? readFileSync(file) : readFileSync(file,'utf8').replace('<html ', `<html data-fixture="${app.operations.has('example.put')}" data-staging="${!!options.staging}" `);
    return new Response(body, { headers: {
      'content-type': ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png' } as Record<string,string>)[extname(file)] ?? 'application/octet-stream',
      'cache-control': asset ? 'public, max-age=31536000, immutable' : 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'",
    } });
  });
  const servers: ReturnType<typeof createServer>[] = [];
  const detaches: (() => void)[] = [];
  const sockets = new Set<Socket>();
  const hosts = typeof options.host === 'string' ? [options.host] : options.host ?? ['127.0.0.1'];
  let port = options.port ?? 0;
  const close = async () => {
    detaches.forEach(detach => detach());
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map(http => {
      http.closeAllConnections();
      return new Promise<void>(ok => http.close(() => ok()));
    }));
    await stopTouches();
  };
  try {
    if (!hosts.length) throw new Error('next mode needs a bind host');
    for (const host of [...new Set(hosts)]) {
      const http = createServer((req: IncomingMessage, res: ServerResponse) => {
        if (!sameOrigin(req)) { res.writeHead(403); res.end(); return; }
        // The ephemeral credential endpoint authenticates a bearer itself. Generic
        // operation routing cannot mint a link, even with encoded path parameters.
        if (req.url?.startsWith('/api/') && req.url.split('?')[0] !== '/api/signin/link') return api(req, res);
        void getRequestListener(request => routes.fetch(request, { incoming: req }))(req, res);
      });
      http.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
      servers.push(http); detaches.push(app.live.attach(http,auth,sameOrigin));
      await new Promise<void>((ok, no) => { http.once('error', no); http.listen(port,host,ok); });
      const address = http.address();
      if (!address || typeof address === 'string') throw new Error('no next address');
      port = address.port;
    }
  } catch (error) { await close(); throw error; }
  const host = hosts[0].includes(':') ? `[${hosts[0]}]` : hosts[0];
  return { url: `http://${host}:${port}`, close };
}
