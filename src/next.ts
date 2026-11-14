import { installAsyncSecretValuesFromFile, type SecretRetryKeyFiles } from './pieces/secrets/retry-key.js';
import type { AsyncSecretMutations } from './pieces/secrets/async-values.js';
import { startSecretReconciliation } from './pieces/secrets/reconciliation.js';
import { heldSecretMutations } from './pieces/secrets/staging.js';
import { bridgeRuntime } from './pieces/runtime/bridges.js';
import { randomUUID } from 'node:crypto';
import { installStartRetries } from './pieces/runtime/start-retries.js';
import { runtimeOwnerApplication } from './pieces/runtime/owner-application.js';
import { storedSprite } from './core/household/sprites.js';
import { installComms } from './pieces/comms/index.js';
import { loadKey } from './pieces/comms/crypto.js';
import { stagingHold } from './pieces/comms/role.js';
import { attentionRole } from './pieces/attention/role.js';
import { conversationRuntime } from './pieces/runtime/conversations.js';
import { MANIFEST, nextWorker } from './next-pwa.js';
import { installMindActivity } from './pieces/mind/activity.js';
/** The sole composition root for --next. No old page routes or piece programs. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { Hono } from 'hono';
import { getRequestListener } from '@hono/node-server';
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Socket } from 'node:net';
import type { Foundation } from './core/app.js';
import { httpDoor } from './core/app.js';
import type { Authentication } from './core/live/index.js';
import { maySee, mayAct } from './core/index.js';
import type { Sharing } from './core/index.js';
import { installSharing } from './pieces/sharing/index.js';
import { clockVouchApplication } from './pieces/clock/role.js';
import { installClock } from './pieces/clock/index.js';
import { clockVouchFiling } from './pieces/clock/dependencies/filing.js';
import { clockAnswers } from './pieces/clock/dependencies/answers.js';
import { installTasks } from './pieces/tasks/index.js';
import { Bridges } from './pieces/bridges/engine.js';
import { venueAdapters } from './pieces/bridges/adapters.js';
import { personFor, setupRevision } from './pieces/bridges/store.js';
import type { BridgeRuntime } from './pieces/bridges/role.js';
import type { Venue } from './pieces/bridges/model.js';
import { bridgeCredentials } from './pieces/bridges/credentials.js';
import type { HolderGeneration } from './pieces/secrets/local-holder.js';
import { installDiscordDaemon, type DiscordDaemonOptions } from './pieces/bridges/discord-daemon.js';
import { installSlackDaemon, type SlackDaemonOptions } from './pieces/bridges/slack-daemon.js';
import { installBridges } from './pieces/bridges/index.js';
import { installApprovals } from './pieces/approvals/index.js';
import { installRunnerInput } from './pieces/runtime/input.js';
import { installRuntime } from './pieces/runtime/index.js';
import { clockRuntime } from './pieces/runtime/clock.js';
import { centralRuntimeCredentials } from './pieces/runtime/central-credentials.js';
import { listenHolderAuthority, type AuthorityServerConfig } from './pieces/secrets/holder-authority.js';
import { installHouseSecrets } from './pieces/secrets/house.js';
import { installSecrets } from './pieces/secrets/index.js';
import { secretGrantAttention } from './pieces/secrets/attention.js';
import { installSecretServices, secretUseRole, type SecretValueSource } from './pieces/secrets/service.js';
import { githubSecrets } from './pieces/changes/secrets.js';
import { changesApprovals } from './pieces/changes/approvals.js';
import { installChangesDaemon, householdAttribution } from './pieces/changes/daemon.js';
import { migrateHouseholdTables } from './core/household/schema.js';
import { HouseholdDatabase } from './core/household/document.js';
import { SharingDatabase } from './core/household/sharing.js';
import { installEffects } from './core/effects.js';
import { signin, installSignin, sameOrigin } from './core/signin/index.js';
import { signinRoutes } from './core/signin/routes.js';
import { mindSources } from './pieces/mind/sources.js';
import { mindTouchSources, mindTouchResolver } from './pieces/mind/binding.js';
import { installMindProjects } from './pieces/mind/projects.js';
import { projectTasks, projectChanges } from './pieces/mind/projects-roles.js';
import { tasksRole } from './pieces/tasks/role.js';
import { mindRole } from './pieces/mind/role.js';
import { installMindPeople } from './pieces/mind/people.js';
import { installMindPeopleActions } from './pieces/mind/people-actions.js';
import { createPersonHalf } from './backends/people-creation.js';
import { installMindKnowledge } from './pieces/mind/index.js';
import { installMindKnowledgeActions } from './pieces/mind/actions.js';
import { verifyKnowledgePages, deriveSlaClass } from './backends/knowledge-verification.js';
import { installTouched, type TouchSource } from './core/touched/index.js';
import { listenForTouchSources } from './core/touched/group.js';
import { prepareTouchSources } from './core/touched/prepare.js';
import { installAttentionMaintenance } from './pieces/attention/daemon.js';
import { attentionWaits } from './pieces/attention/wait-roles.js';
import { approvalAnswers } from './pieces/approvals/role.js';
import { attentionThreadProject } from './pieces/attention/comms.js';
import { attentionProjects } from './pieces/attention/projects.js';
import { installAttention, attentionSources as installedAttentionSources } from './pieces/attention/index.js';
const mindTransports = new WeakMap<Foundation, TouchSource[]>();
export type NextSessionResolver = (req: IncomingMessage, transport?: 'upgrade') => Authentication | undefined;
/** t-2203 plugs the loom.db session resolver in here. No legacy fallback. */
export function nextSessionResolver(app: Foundation): NextSessionResolver { return (req,transport) => signin(app).resolve(req,transport); }
/** Trusted in-process composition only; never accepted from an operation or HTTP input.
 * source must be an authenticated separate holder transport delivering owned buffers.
 * Bindings contain public forge owner names and secret names, never credential values.
 */
export interface NextChangesOptions {
  source: SecretValueSource;
  github: Readonly<Record<string, string>>;
  request?: typeof fetch;
  interval?: number;
}
export interface NextBridgesOptions extends Omit<SlackDaemonOptions, 'secrets' | 'credentialEpoch' | 'observeCredentials' | 'name' | 'receive'> { name?: SlackDaemonOptions['name']; receive?: SlackDaemonOptions['receive']; runtime?: BridgeRuntime; source: SecretValueSource & HolderGeneration; discordSocket?: DiscordDaemonOptions['socket'] }
const secretMutationClosers = new WeakMap<Foundation, () => Promise<void>>();
const secretAuthorities = new WeakMap<Foundation, Awaited<ReturnType<typeof listenHolderAuthority>>>();
const bridgeDaemons = new WeakMap<Foundation, {close(): Promise<void>}>();
/** Await outstanding bridge IO before Foundation closes SQLite, including startup failure. */
const runtimeClosers = new WeakMap<Foundation, () => Promise<void>>();
export async function closeNext(app: Foundation) {
  try { await secretMutationClosers.get(app)?.(); }
  finally {
    try { await bridgeDaemons.get(app)?.close(); }
    finally {
      try { await secretAuthorities.get(app)?.close(); secretAuthorities.delete(app); }
      finally { await runtimeClosers.get(app)?.(); }
    }
  }
}
export interface NextOptions {
  home: string; staging?: boolean; host?: string | string[]; port?: number; webRoot?: string;
  authenticate?: NextSessionResolver; sharing?: () => Sharing;
  changes?: NextChangesOptions;
  secretAuthority?: AuthorityServerConfig;
  /** Trusted authenticated holder only; no discovery or automatic grants. */
  secretWrites?: {holder: AsyncSecretMutations; retryKeys: string | SecretRetryKeyFiles};
  bridges?: NextBridgesOptions;
  /** Explicit opt-in for fixed 24-hour safety wakes, acting as the named agents. */
  clockDeadmanAgents?: readonly string[];
}
export async function installNext(app: Foundation, options: NextOptions) {
  if (options.secretWrites && !options.secretAuthority) throw new Error('Secret writes require holder authority');
  migrateHouseholdTables(app.db);
  if (!app.operations.has('signin.link')) installSignin(app);
  if (!app.operations.has('household.createProject')) installSharing(app, options.home);
  const sharing = options.sharing ?? (() => new SharingDatabase(app.db, options.home).sharing());
  const attentionSources = !app.operations.has('attention.raise') ? installAttention(app.db, app.operations, app.live, sharing, { projects: attentionProjects(mindRole(app.operations)), threadProject: attentionThreadProject(app.operations) }, attentionWaits(approvalAnswers(app.db, sharing, () => app.operations.clock.now()), tasksRole(app.operations), () => new HouseholdDatabase(app.db).household(options.home)?.owner)) : installedAttentionSources(app.operations);
  const secretAttention = (!app.operations.has('secrets.list') || options.secretWrites) && attentionSources ? secretGrantAttention(attentionSources, app.operations) : undefined;
  if (!app.operations.has('secrets.list')) installSecrets(app.db, app.operations, app.live, sharing, secretAttention);
  if (!app.operations.has('tasks.list')) installTasks(app.db, app.operations, app.live, sharing);
  if (!app.operations.has('bridges.putVenues')) installBridges(app, sharing);
  const conversations=conversationRuntime(app,sharing,v=>signin(app).agent(v));
  const bridgeBodies=bridgeRuntime(app,sharing,v=>signin(app).agent(v));
  conversations.connectBridges(bridgeBodies);
  app.onClose(bridgeBodies.close);
  if (!app.operations.has('approvals.list')) installApprovals(app.db, app.operations, app.live, sharing, {
    caller: conversations.approvalCaller,
    localAgent:()=>new HouseholdDatabase(app.db).household(options.home)?.default ?? 'agent',
    applications: { clock: clockVouchApplication(app.operations), runtime: runtimeOwnerApplication(app.operations) },
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
  if (!app.operations.has('runtime.listBoxes')) installRuntime(app.db, app.operations, app.live, sharing, { credentials: centralRuntimeCredentials, privateStart:i=>conversations.privateStart(i)||bridgeBodies.privateStart(i) });
  if (!app.operations.has('secrets.houseRequest')) installHouseSecrets(app);
  if (!app.operations.has('changes.list')) {
    const attribution = () => householdAttribution(app.db, options.home);
    const approvals = changesApprovals(app.operations);
    // No default holder, legacy token lookup, or installation-time grant. An
    // unconfigured reader fails before acquiring a value or contacting GitHub.
    const credentials = options.changes;
    if (credentials) {
      if (!app.operations.has('secrets.grantService')) installSecretServices(app.db, app.operations, sharing);
    }
    const secrets = githubSecrets(credentials
      ? secretUseRole(app.db, credentials.source, sharing, {kind: 'service', id: 'changes'}, () => app.operations.clock.now(), app.live)
      : {async withValue() { throw new Error('GitHub credential unavailable'); }}, credentials?.github ?? {});
    installChangesDaemon(app, {home: options.home, clock: app.operations.clock, sharing, attribution, approvals, secrets,
      staging: options.staging, interval: credentials?.interval, request: credentials?.request});
  }
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
  if (!app.operations.has('mind.projectsList')) {
    const projects = installMindProjects(app.operations, app.live, { agents: inventory?.agents ?? [], sharing, people: mindRole(app.operations),
      tasks: projectTasks(tasksRole(app.operations), v => v.kind === 'member' && maySee(v, {type:'task'}, sharing())), changes: projectChanges(app.operations) });
    app.onClose(() => projects.close());
  }
  if (!app.operations.has('mind.activityList')) {
    const household = new HouseholdDatabase(app.db).household(options.home);
    const activity = installMindActivity(app.operations, app.live, {agents:inventory?.agents??[],sharing,owner:household?.owner,timezone:household?.tz,github:household?.github});
    app.onClose(() => activity.close());
  }
  const sources = mindTouchSources(inventory);
  if (!app.operations.has('core.touched')) installTouched(app.operations, mindTouchResolver(sources));
  mindTransports.set(app, sources);
  const effects = installEffects(app, sharing, !!options.staging);
  if (!app.operations.has('clock.list')) {
    const jobs = installClock(app.db, app.operations, app.live, sharing, { caller: conversations.approvalCaller, capacityConversation: conversations.capacityConversation, runtime: clockRuntime(app, effects), deadmanAgents: options.clockDeadmanAgents, vouchFiling: clockVouchFiling(app.operations), approvals: clockAnswers(app.db, app.operations, app.live, sharing), notices: attentionSources?.register('clock', () => { /* Acknowledging a notice never retries work. */ }) });
    app.onClose(jobs.close);
  }
  if (options.bridges && !bridgeDaemons.has(app)) {
    if (!app.operations.has('secrets.grantService')) installSecretServices(app.db, app.operations, sharing);
    const secrets=secretUseRole(app.db,options.bridges.source,sharing,{kind:'service',id:'bridges'},()=>app.operations.clock.now(),app.live);
    const credentials=bridgeCredentials(options.bridges.source,app.operations.clock);
    const lifetime={credentialEpoch:credentials.current,observeCredentials:credentials.observe};
    let closed=false,serial=0;
    const readAttempts=new Map<string,{key:string;id:string}>();
    const marker=(v:Venue)=>{
      const epoch=credentials.current();
      return closed || epoch===undefined ? undefined : JSON.stringify([serial,epoch,setupRevision(app.db),v]);
    };
    const adapters=venueAdapters(secrets,{request:options.bridges.request,lifetime:marker,beforeRead:v=>{
      const key=marker(v);if(key===undefined)return false;
      let attempt=readAttempts.get(v.id);
      if(attempt?.key!==key){if(attempt)effects.finish(attempt.id);attempt={key,id:`bridges:inspect:${randomUUID()}`};readAttempts.set(v.id,attempt);}
      return effects.status(attempt.id)==='started' || effects.beforeOutside({id:attempt.id,kind:'bridge-send',title:'Inspect bridge recipients'});
    }});
    const engine=new Bridges(app,app.operations.clock,options.bridges.runtime??bridgeBodies.runtime,adapters,effects);
    bridgeBodies.connect(engine);
    const receive=options.bridges.receive??((venue,message)=>engine.receive(venue,message));
    const name=options.bridges.name??((v,user)=>{
      const person=personFor(app.db,v,user);if(!person)return;
      const result=mindRole(app.operations).call({kind:'agent',id:v.agent},'personRead',{id:`${v.agent}:${person}`});
      if(result.ok && result.value && typeof result.value==='object' && 'name' in result.value && typeof result.value.name==='string')return result.value.name;
    });
    const slack=installSlackDaemon(app,effects,{...options.bridges,...lifetime,secrets,receive,name});
    const discord=installDiscordDaemon(app,effects,{...options.bridges,...lifetime,secrets,receive,socket:options.bridges.discordSocket});
    const stopCredentials=credentials.observe(()=>{serial++;void engine.flush();});
    const stopLive=app.live.observe(changes=>{if(changes.some(c=>c.type==='secret.name'||c.type==='secret.grant'))serial++;if(changes.some(c=>['bridges.venue','bridges.route','bridges.link','bridges.send','secret.name','secret.grant'].includes(c.type)))void engine.flush();});
    void engine.flush();
    bridgeDaemons.set(app,{async close(){closed=true;bridgeBodies.close();stopCredentials();stopLive();const pending=[slack.close(),discord.close(),engine.close()];credentials.close();await Promise.all(pending);for(const attempt of readAttempts.values())effects.finish(attempt.id);}});
  }
  if (!app.operations.has('runtime.startProgress')) installStartRetries(app,sharing);
  installAttentionMaintenance(app);
  if (!app.operations.has('comms.open')) {
    const comms=installComms({db:app.db,operations:app.operations,live:app.live,clock:app.operations.clock,sharing,
      key:await loadKey(options.home),filing:conversations.refile,runtime:conversations.delivery,hold:stagingHold(effects),attention:attentionRole(app.operations),
      recipients:()=>{const h=new HouseholdDatabase(app.db).household(options.home);return {agents:h?.agents??[],default:h?.default};},
    });
    conversations.connect(comms);
    runtimeClosers.set(app,async()=>{await conversations.close();await comms.close();});
    app.onClose(()=>{void conversations.close();void comms.close();});
  }
  if (!app.operations.has('runtime.takeInput')) installRunnerInput(app.db, app.operations, sharing, effects,
    {valid:id=>conversations.validInput(id)||bridgeBodies.valid(id),issue:(agent,job)=>signin(app).issueBody(agent,job)});
  if (options.secretAuthority && !secretAuthorities.has(app)) {
    const current = () => new SharingDatabase(app.db, options.home).sharing();
    secretAuthorities.set(app, await listenHolderAuthority(options.secretAuthority, member =>
      mayAct({kind:'member',id:member},{type:'secret.name'},current(),'household','secrets.set')));
  }
  if (options.secretWrites) {
    const holder = heldSecretMutations(options.secretWrites.holder, effects);
    app.onClose(()=>{void holder.close();});
    const recovery = installAsyncSecretValuesFromFile(app.db, app.operations, sharing, holder,
      options.secretWrites.retryKeys, secretAttention);
    const job = startSecretReconciliation(app, recovery);
    secretMutationClosers.set(app,async()=>{job.close();await holder.close();});
  }
  return effects;
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
  routes.get('/faces/:agent/:file', c => {
    const authentication = auth(c.env.incoming as IncomingMessage);
    if (!authentication?.valid()) return c.notFound();
    const agent = c.req.param('agent'), file = c.req.param('file');
    if (!new HouseholdDatabase(app.db).household(options.home)?.agents.includes(agent) ||
      !maySee(authentication.viewer, { agent, type: 'household.agentDisplay' }, new SharingDatabase(app.db, options.home).sharing())) return c.notFound();
    const sprite = storedSprite(app.db, agent);
    if (!sprite || (file !== 'manifest.json' && !Object.hasOwn(sprite.sheets, file))) return c.notFound();
    return new Response(new Uint8Array(Buffer.from(file === 'manifest.json' ? sprite.rawManifest : sprite.sheets[file], 'base64')), {
      headers: { 'content-type': file === 'manifest.json' ? 'application/json' : 'image/png', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
    });
  });
  const publicRoot = resolve(import.meta.dirname, '../assets');
  const built = existsSync(resolve(root, 'assets')) ? readdirSync(resolve(root, 'assets')).filter(f => /\.(js|css|woff2)$/.test(f)).sort().map(f => `/app/assets/${f}`) : [];
  routes.get('/manifest.webmanifest', () => new Response(MANIFEST, { headers: { 'content-type': 'application/manifest+json', 'cache-control': 'no-cache' } }));
  routes.get('/sw.js', () => new Response(nextWorker(built), { headers: { 'content-type': 'text/javascript', 'cache-control': 'no-cache', 'service-worker-allowed': '/' } }));
  routes.get('*', c => {
    const pathname = new URL(c.req.url).pathname;
    if (pathname.startsWith('/api/') || pathname === '/events' || pathname.startsWith('/collections') || pathname === '/live') return c.notFound();
    const asset = pathname.startsWith('/app/');
    const publicAsset = /^\/(icons|fonts)\//.test(pathname);
    // A missing resource must never be mistaken for an HTML navigation.
    if (!asset && !publicAsset && (extname(pathname) || /^\/(assets|faces|pixel-icons)(\/|$)/.test(pathname))) return c.notFound();
    const base = publicAsset ? publicRoot : root;
    const file = publicAsset ? resolve(base, '.' + pathname) : asset ? resolve(root, '.' + pathname.slice(4)) : resolve(root, 'next.html');
    if (!file.startsWith(base + sep) || !existsSync(file) || !statSync(file).isFile()) return c.notFound();
    const body = asset || publicAsset ? readFileSync(file) : readFileSync(file,'utf8').replace('<html ', `<html data-fixture="${app.operations.has('example.put')}" data-staging="${!!options.staging}" `);
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
