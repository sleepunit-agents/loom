import { withNonblockingSqlite, isSqliteBusy, retrySqlite } from '../sqlite.js';
/**
 * loom HTTP MCP transport (c-loom-transport) — the mesh-reachable surface.
 *
 * A thin node:http front for the StreamableHTTP MCP transport, applying loom's
 * boundary guards: bind-safety at startup (assertSafeBind), a bearer auth gate
 * and an oversized-payload guard per request. The MCP envelope/dispatch behavior
 * itself is the SDK's McpServer — the same server factory that serves stdio, so
 * results are transport-neutral by construction (ac-lt-envelope-ok parity).
 *
 * Session mode: each MCP session gets its own server+transport, keyed by the
 * mcp-session-id header (the canonical persistent-daemon pattern, and what
 * Claude Desktop uses). loom's durable state lives in the stores, not the
 * session, so sessions are cheap routing handles over a shared contextDir.
 * WHERE it binds on the mesh is deployment (the portable-MCP ADR); THAT it
 * refuses an unsafe bind is this contract.
 *
 * Two auth modes, same plumbing (t-677):
 *   - single `token` — the full loom server (identity/memory/knowledge), one
 *     shared secret, no identity resolution. The original/default shape.
 *   - `tokens` (token → identity map) — a scoped server (e.g. the
 *     knowledge-only service) where the bearer itself names the caller, so
 *     the acting identity is derivable server-side for attribution and is
 *     bound to the session at open time (a later request on the same
 *     session presenting a DIFFERENT identity's token is refused, not
 *     silently re-attributed).
 *   - `household` (docs/specs/household.md) — one daemon for many agents.
 *     Each token in $LOOM_HOME/tokens.json has a role: `agent:<name>` gets a
 *     full server over that agent's context dir; `owner` gets the default
 *     agent's (or another's under `/agents/<name>/…`) and the page; `peer`
 *     gets the knowledge-only server. LOOM_BEARER_TOKEN, when set, is an
 *     owner token too. The role is resolved on every request and a session
 *     is pinned to the role and agent it opened with.
 */
import { PieceStore, readGrant, StoreError, type Grant } from '../stores.js';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { WebStandardStreamableHTTPServerTransport, isInitializeRequest } from '@modelcontextprotocol/server';
import type { McpServer } from '@modelcontextprotocol/server';
import { EmptyResultSchema } from '@modelcontextprotocol/core';
import { bodyHouseConversation, createLoomServer, type SessionTool } from '../server.js';
import { callOfferedTool, offeredTools, type OfferedTool, type ToolCaller } from '../offered-tools.js';
import { createBackend } from '../backends/index.js';
import { handleCliBody } from './cli-endpoint.js';
import { handleUi, isUiRequest, legacyUiAuth, pushWatch, type UiAuth } from '../ui/handler.js';
import { migratePasskeys } from '../ui/passkey-tokens.js';
import { WATCH_S } from '../ui/push.js';
import { pieceCheckers, resolveNeeds } from '../needs-resolve.js';
import { spawnBackupTick } from '../backup-tick.js';

/** How often core checks what open Needs you wait on. */
const NEEDS_TICK_MS = 60_000;
import { forgetPiecePages, pieceApi, pieceManifests, type ApiCaller } from '../ui/pieces.js';
import { stopPieceServers } from '../ui/piece-server.js';
import { closePieceSockets } from '../ui/piece-socket.js';
import { findPiece, listPieces, resolvePieceName } from '../cli/pieces.js';
import { readRecord, runtimePieces } from '../cli/pieces-managed.js';
import { AGENT_ROUTES, DELIVER_ROUTE, ENSURE_ROUTE, MERGE_ROUTE, GET_ROUTES, ROLE_ROUTES, RUNTIME_GET_ROUTES, roleReaches } from './role-routes.js';
import { deliver, DELIVER_MAX_BYTES } from '../delivery.js';
import { askGrant } from '../grants.js';
import { grantsAuthority } from '../offers-registry.js';
import { answerBatch, COLLECTIONS_MAX_BYTES, COLLECTIONS_NUDGE_ROUTE, COLLECTIONS_QUERY_ROUTE } from '../collections/serve.js';
import { nudge as collectionsNudge } from '../collections/pull.js';
import { pullPieceSoon } from '../collections/subs.js';
import { memberViewer, type Viewer } from '../collections/viewer.js';
import { writeTurn } from '../conversations.js';
import { ConversationError, foldConversations } from '../backends/conversations.js';
import { bindHouseConversation, HouseBindingError, syncVenuesQuietly, venueDirectory } from '../household-store.js';
import { AuditError, doneEntries, sweepAudit, writeAudit } from '../audit.js';
import { adapterCall as commsAdapter, CommsError, postActivity, sweepComms } from '../comms.js';
import { stopCommsWatch, watchComms } from '../ui/comms-live.js';
import { piecesMoved } from '../ui/live.js';
import { backfillRefs } from '../comms-work.js';
import { takeAudit } from '../audit-take.js';
import { computeMeasures, postFinding, postScore, recentDays, scorecards } from '../review.js';

/** A stranger's call (a box asking to join) is small: a name, its facts, a proof hash. */
const STRANGER_MAX_BYTES = 8 * 1024;
import { createKnowledgeOnlyServer } from './knowledge-server.js';
import { personEnsure, personMergeRun } from '../tools/person.js';
import { PersonMergeError } from '../backends/people-merge.js';
import { PersonCardError } from '../backends/people.js';
import { ensureAgentEntries, ensureMemberEntries, hasUnsplitPeople } from '../backends/people-household.js';
import { agentName } from '../ui/core.js';
import { agentDir, assertRealAgentDir, commonsProblem, firstOwner, liveHousehold, memberOf, mintReviewToken, TokenLimitError, roleString, TokenResolver, type Household, type Role } from '../household.js';
import { createHash, timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto';
import { watchStalls } from './stall-watch.js';
import {
  assertSafeBind,
  checkBearer,
  checkBearerMulti,
  checkPayloadSize,
  DEFAULT_MAX_BODY_BYTES,
} from './guards.js';

/**
 * SSE keep-alive: the SDK opens the standalone GET stream but sends no
 * heartbeat, so an idle stream gets reaped by proxies/NAT (Traefik's default
 * idle is ~180s) and the session bricks. We drive a protocol-native `ping` to
 * the client over the stream — it keeps the connection warm AND detects a dead
 * client (after a few misses the session is closed, and the client re-inits via
 * the 404 path). The interval stays well under typical idle windows.
 */
const HEARTBEAT_MS = 25_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const HEARTBEAT_MISSES_BEFORE_CLOSE = 2;

export interface HttpServeOptions {
  contextDir: string;
  host: string;
  port: number;
  /** Single-token mode: every request must present this bearer token. */
  token?: string;
  /**
   * Multi-token mode (t-677): token → identity. Mutually exclusive with
   * `token` — when set, `checkBearerMulti` resolves the caller's identity
   * from whichever configured token it presents instead of a single shared
   * secret. Required for `createServer` factories that need an identity
   * (e.g. the knowledge-only service); refuses every call if empty.
   */
  tokens?: Record<string, string>;
  maxBytes?: number;
  /** SSE keep-alive ping interval (ms). Default HEARTBEAT_MS; tests use a small value. */
  heartbeatMs?: number;
  /**
   * Optional path to the knowledge-gaps directory. Forwarded to the server
   * factory so zero-result knowledge_recall calls can log misses.
   */
  gapsDir?: string;
  /**
   * Server factory for this endpoint. Defaults to the full loom server
   * (createLoomServer, identity 'art') — pass createKnowledgeOnlyServer to
   * scope the endpoint to knowledge tools only. `identity` is resolved from
   * `tokens` per connection; always 'art' in single-token/no-auth mode.
   */
  createServer?: (ctx: { contextDir: string; gapsDir?: string; identity: string }) => { server: McpServer };
  /**
   * Household mode: tokens resolve to roles from household.home/tokens.json
   * (plus `token`, if set, as an owner token). Mutually exclusive with
   * `tokens` and `createServer`; `contextDir` should be the default agent's.
   */
  household?: Household;
}

/** Who a request is, in household mode, and which stack it gets. */
interface Caller {
  role: Role;
  /** The agent whose context dir serves it (the default agent's, for a peer). */
  agent: string;
  contextDir: string;
  /** What a session is pinned to: role and agent. */
  key: string;
}

export interface HttpServeHandle {
  /** The actually-bound port (resolves a 0 request to the OS-assigned port). */
  port: number;
  host: string;
  setBackgroundActive(active: boolean): void;
  close(): Promise<void>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** The error envelope's leading word for a status: the one cascade core's /api/loom routes use. */
function statusWord(status: number): string {
  switch (status) {
    case 403: return 'forbidden';
    case 404: return 'not-found';
    case 409: return 'conflict';
    case 410: return 'gone';
    case 503: return 'unavailable';
    default: return status >= 500 ? 'error' : 'bad-input';
  }
}

function sendError(res: ServerResponse, status: number, message: string): void {
  // A typed error ENVELOPE, never a raw throw across the boundary.
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

/**
 * The split 2.x transport speaks Web Standard Request/Response, not node's
 * (req, res) pair — bridge node:http to it. Only method/url/headers are
 * needed on the way in: bodies are pre-read/parsed by collectBody and handed
 * to handleRequest via options.parsedBody, so the Request itself is bodyless.
 */
function nodeRequestToWebRequest(req: IncomingMessage): Request {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }
  return new Request(url, { method: req.method, headers });
}

async function sendWebResponse(res: ServerResponse, webRes: Response): Promise<void> {
  const headers: Record<string, string> = {};
  webRes.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(webRes.status, headers);
  // Announce SSE immediately, before the first heartbeat, so the proxy can
  // recognize and drain an otherwise idle stream.
  if (headers['content-type']?.startsWith('text/event-stream')) res.flushHeaders();
  if (!webRes.body) {
    res.end();
    return;
  }
  const nodeStream = Readable.fromWeb(webRes.body as import('node:stream/web').ReadableStream<Uint8Array>);
  await new Promise<void>((resolve, reject) => {
    nodeStream.pipe(res);
    nodeStream.on('end', resolve);
    nodeStream.on('error', reject);
    res.on('close', () => {
      nodeStream.destroy();
      resolve();
    });
  });
}

const OVERSIZED = Symbol('oversized');

function collectBody(req: IncomingMessage, cap: number): Promise<string | typeof OVERSIZED> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > cap) {
        resolve(OVERSIZED);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function startHttpServer(opts: HttpServeOptions): Promise<HttpServeHandle> {
  return withNonblockingSqlite(() => startHttpServerImpl(opts));
}

async function startHttpServerImpl(opts: HttpServeOptions): Promise<HttpServeHandle> {
  // Bind-safety (ac-lt-bind-safety): refuse an unsafe host BEFORE we open a socket.
  assertSafeBind(opts.host);
  const workerSocket = process.connected ? process.env.LOOM_WORKER_SOCKET : undefined;
  let backgroundActive = !workerSocket;
  if (opts.token && opts.tokens) {
    throw new Error('startHttpServer: pass either token or tokens, not both');
  }
  if (opts.household && (opts.tokens || opts.createServer)) {
    throw new Error('startHttpServer: household mode resolves roles itself; pass neither tokens nor createServer');
  }
  const household = opts.household;
  if (household) {
    // Each of these points every agent at one store or one name, which would
    // quietly merge the household. Refuse rather than serve it that way.
    for (const v of ['LOOM_SQLITE_DB_PATH', 'LOOM_KNOWLEDGE_DB_PATH', 'LOOM_IDENTITY']) {
      if (process.env[v]) throw new Error(`startHttpServer: ${v} is set; a household gives each agent its own store and name, so unset it`);
    }
    for (const a of household.agents) assertRealAgentDir(household, a);
    const problem = commonsProblem(household);
    if (problem) throw new Error(`startHttpServer: ${problem}`);
    for (const a of household.agents) {
      if (hasUnsplitPeople(agentDir(household, a))) {
        throw new Error(`startHttpServer: agents/${a}'s person cards haven't been split into the commons; with every loom daemon stopped, run: loom household commons`);
      }
    }
  }
  // Read fresh on each use: an agent added from the page is served at once.
  // Every agent has a directory entry (docs/specs/agents-in-people.md), at start and when one is added.
  const live = household ? liveHousehold(household, (h) => {
    const wrote = [...ensureAgentEntries(h, (a) => agentName(agentDir(h, a))), ...ensureMemberEntries(h)];
    if (wrote.length) process.stderr.write(`loom: made directory entries for ${wrote.join(', ')} (People entries for the household's agents and members)\n`);
  }) : undefined;
  live?.();
  // The runtime piece is read per request, so removing it (or installing a second) ends its tokens at once.
  const resolver = live ? new TokenResolver(live, { runtimePieces: () => runtimePieces(process.env) }) : undefined;
  const ownerDigest = opts.token ? createHash('sha256').update(opts.token).digest() : undefined;
  // Passkeys made before t-1969 signed in as the adding session's token: each moves to a token of its own, once.
  if (live) {
    try {
      const { moved, failed } = migratePasskeys(live(), ownerDigest?.toString('hex'));
      if (moved.length) process.stderr.write(`loom: gave ${moved.length} passkey${moved.length === 1 ? '' : 's'} a sign-in token of its own (t-1969)\n`);
      for (const f of failed) process.stderr.write(`loom: a passkey (added as ${f.id.slice(0, 8)}…) kept its old token: ${f.error}\n`);
    } catch (e) { process.stderr.write(`loom: the passkey migration didn't run: ${(e as Error).message}\n`); }
  }
  /** An owner's caller for a piece: who, and what they own (docs/specs/owners.md). */
  const ownerCaller = (member: string | undefined): ApiCaller => {
    const m = live ? memberOf(live(), member) : undefined;
    return m ? { kind: 'owner', who: m.person, agents: m.agents } : { kind: 'owner' };
  };

  /** The role a presented bearer has: 401 (none/unknown) or 503 (tokens.json unreadable). */
  function roleFor(header: string | undefined): Role | { status: number; error: string } {
    const presented = (header ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!presented) return { status: 401, error: 'unauthorized: missing bearer token' };
    // The env owner token first: a broken tokens.json must not lock it out.
    let role: Role | null = null;
    if (ownerDigest && cryptoTimingSafeEqual(createHash('sha256').update(presented).digest(), ownerDigest)) {
      // The env owner token is the first household owner's.
      role = { kind: 'owner', ...(live ? { member: firstOwner(live()).person } : {}) };
    }
    if (!role) {
      try {
        role = resolver!.resolve(presented);
      } catch (err) {
        // Fail closed, and keep the details (paths) out of the response.
        process.stderr.write(`loom: household tokens unreadable: ${(err as Error).message}\n`);
        return { status: 503, error: 'unavailable: the household token file is unreadable; see the daemon log' };
      }
    }
    if (!role) return { status: 401, error: 'unauthorized: bearer token not recognized' };
    // A credential minted for an old piece name (piece:box/<id>) acts as the piece it now is, its
    // subject unchanged, so every check after this (own API, store, grants) sees that piece.
    if (role.kind === 'piece') {
      const now = resolvePieceName(process.env, role.piece);
      if (now !== role.piece) role = { ...role, piece: now };
    }
    return role;
  }

  /** Resolve a household caller: 401 (no/unknown token), 403 (not allowed there) or 404 (no such agent). */
  function callerFor(header: string | undefined, target: string | undefined): Caller | { status: number; error: string } {
    const role = roleFor(header);
    if ('status' in role) return role;
    // Every kind is handled by name: an unlisted one must never fall through to the owner's branch.
    if (role.kind === 'piece') return { status: 403, error: `forbidden: a piece credential reaches only /api/${role.piece}/` };
    if (role.kind === 'runtime' || role.kind === 'review') return { status: 403, error: `forbidden: a ${role.kind} token reaches only its own /api/loom/ routes` };
    const h = live!();
    if (role.kind === 'peer') {
      if (target) return { status: 403, error: 'forbidden: a peer token reaches the commons only' };
      return { role, agent: h.default, contextDir: agentDir(h, h.default), key: `${roleString(role)}>${h.default}` };
    }
    if (role.kind === 'agent') {
      if (target && target !== role.agent) return { status: 403, error: `forbidden: this token is ${role.agent}'s` };
      return { role, agent: role.agent, contextDir: agentDir(h, role.agent), key: `${roleString(role)}>${role.agent}` };
    }
    if (role.kind !== 'owner') return { status: 403, error: 'forbidden' };
    // An agent owner reaches only their agents (docs/specs/owners.md); with none named, the
    // household's default if it's theirs, else their first.
    const m = memberOf(h, role.member);
    const own = m && m.agents !== '*' ? m.agents : null;
    const agent = target ?? (own && !own.includes(h.default) ? own[0] : h.default);
    if (!h.agents.includes(agent)) return { status: 404, error: `not-found: no agent named ${agent}` };
    if (own && !own.includes(agent)) return { status: 403, error: `forbidden: ${agent} isn't one of ${m!.person}'s agents` };
    return { role, agent, contextDir: agentDir(h, agent), key: own ? `owner:${m!.person}>${agent}` : `owner>${agent}` };
  }
  // A scoped server factory (e.g. the knowledge-only service) always needs
  // to know WHO is calling for attribution — refuse to boot it open or on a
  // single shared secret with no identity behind it.
  if (opts.createServer && (!opts.tokens || Object.keys(opts.tokens).length === 0)) {
    throw new Error(
      'startHttpServer: a scoped createServer requires a non-empty tokens map ' +
        '(per-identity bearer) — refusing to serve it unauthenticated or identity-less.',
    );
  }
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BODY_BYTES;
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;

  // Eager-migrate (t-1270): the default full server's memory backend runs
  // pending schema migrations in its constructor (strict — throws loud on a
  // bad migration), but that constructor previously only ran lazily, on
  // whichever session's first backend-touching tool call happened to land
  // first. A restart with new pending migrations looked fully up — the
  // daemon bound its port and answered health probes — while memories.db
  // still had the old schema underneath it, until some real caller's first
  // write tripped over missing columns. Force that construction now, before
  // the socket opens, so a bad or pending migration fails startup instead of
  // a session three hops later. Scoped to the default server only — a scoped
  // createServer (e.g. the knowledge-only service) never touches this
  // backend, so forcing it there would just pay for an unused embedder load.
  if (household) for (const a of household.agents) createBackend(agentDir(household, a));
  else if (!opts.createServer) createBackend(opts.contextDir);

  // What held the loop, when it's held (stall-watch.ts): the background jobs below run through stalls.timed.
  const stalls = watchStalls();
  // Conversations (docs/specs/conversations.md): the venues registry is reconciled with what's
  // installed (a sync a piece change couldn't do is done now), and the retention fold runs at
  // start and daily. Neither ever stops the daemon.
  const foldAll = () => {
    if (!backgroundActive) return;
    const dirs = live ? live().agents.map((a) => agentDir(live(), a)) : opts.createServer ? [] : [opts.contextDir];
    for (const d of dirs) {
      try { stalls.timed('conversations fold', () => foldConversations(d)); } catch (e) { process.stderr.write(`loom: the conversations fold failed for ${d}: ${(e as Error).message}\n`); }
    }
  };
  if (household && backgroundActive) stalls.timed('venues sync', () => syncVenuesQuietly(process.env));
  foldAll();
  const foldTimer = setInterval(foldAll, 24 * 60 * 60 * 1000);
  foldTimer.unref();
  // The audit log's sweep (docs/specs/conversations.md, "The audit log"): every entry older
  // than 7 days goes, hourly and at start. The same pass settles the last days' metadata
  // measures on the scorecards. Neither ever stops the daemon.
  const sweepAll = () => {
    if (!backgroundActive || !live) return;
    const h = live();
    try { stalls.timed('audit sweep', () => sweepAudit(h.home)); } catch (e) { process.stderr.write(`loom: the audit sweep failed: ${(e as Error).message}\n`); }
    for (const day of recentDays()) {
      try { stalls.timed(`scorecard measures ${day}`, () => computeMeasures(h, day)); } catch (e) { process.stderr.write(`loom: the scorecard measures for ${day} failed: ${(e as Error).message}\n`); }
    }
  };
  sweepAll();
  const sweepTimer = setInterval(sweepAll, 60 * 60 * 1000);
  sweepTimer.unref();
  // Comms (docs/specs/comms.md): the words' sweep and a queued message's busy line, each minute; and every
  // listener watches for thread moves, so a member's own shared stream hears of their threads.
  const commsTimer = live && !opts.createServer ? setInterval(() => { if (!backgroundActive) return; try { stalls.timed('comms sweep', () => sweepComms(live!())); } catch (e) { process.stderr.write(`loom: the Comms sweep failed: ${(e as Error).name}\n`); } }, 60_000) : undefined;
  commsTimer?.unref();
  if (live && !opts.createServer) {
    try { if (backgroundActive) stalls.timed('comms sweep', () => sweepComms(live())); } catch (e) { process.stderr.write(`loom: the Comms sweep failed: ${(e as Error).name}\n`); }
    watchComms(live().home);
    // Threads from before the refs index get it once (comms.md, "Older threads"); a start that finds it done reads nothing.
    if (backgroundActive) void backfillRefs(live(), process.env).catch((e) => process.stderr.write(`loom: the Comms refs backfill failed: ${(e as Error).name}\n`));
  }

  // The page is the owner's: in a household, only owner tokens log in to it.
  const uiAuth: UiAuth = household
    ? {
        enabled: true,
        check: (t) => {
          const d = createHash('sha256').update(t).digest();
          if (ownerDigest && cryptoTimingSafeEqual(d, ownerDigest)) return d;
          try { return resolver!.resolve(t)?.kind === 'owner' ? d : null; } catch { return null; }
        },
        live: (d) => {
          if (ownerDigest !== undefined && cryptoTimingSafeEqual(d, ownerDigest)) return true;
          try { return resolver!.ownerDigestLive(d.toString('hex')); } catch { return false; }
        },
        member: (d) => {
          if (ownerDigest !== undefined && cryptoTimingSafeEqual(d, ownerDigest)) return firstOwner(live!());
          try { return resolver!.ownerMember(d.toString('hex')); } catch { return undefined; }
        },
      }
    : legacyUiAuth(opts.token ? [opts.token] : Object.values(opts.tokens ?? {}));

  const makeServer = opts.createServer ?? ((ctx: { contextDir: string; gapsDir?: string }) => createLoomServer({ ...ctx, remote: true }));
  const serverFor = (c: Caller | undefined, identity: string) => {
    if (!c) return makeServer({ contextDir: opts.contextDir, gapsDir: opts.gapsDir, identity });
    if (c.role.kind === 'peer') return createKnowledgeOnlyServer({ contextDir: c.contextDir, gapsDir: opts.gapsDir, identity: c.role.name });
    return createLoomServer({ contextDir: c.contextDir, gapsDir: opts.gapsDir, remote: true,
      // Which house this session's agent token names (t-2061): its digests go only to the conversation that house holds.
      ...(c.role.kind === 'agent' && (c.role.house || c.role.service) ? { caller: { ...(c.role.house ? { house: c.role.house } : {}), ...(c.role.service ? { service: c.role.service } : {}) } } : {}),
      tools: toolsFor(c.role.kind === 'agent' ? { kind: 'agent', agent: c.agent, ...(c.role.service ? { service: c.role.service } : {}), ...(c.role.house ? { house: c.role.house } : {}) } : { kind: 'agent', agent: c.agent }) });
  };

  /**
   * The tools the installed pieces offer (src/offered-tools.ts), read as the session opens, each
   * called as this session's own agent. An owner session acting for an agent calls them as that
   * agent; it gains nothing the agent's own token doesn't have.
   */
  function toolsFor(as: ToolCaller): SessionTool[] {
    let offered: OfferedTool[];
    try { offered = offeredTools(process.env); } catch { offered = []; }
    return offered.map((t) => ({
      name: t.name, description: t.offer.description, inputSchema: t.offer.input_schema,
      call: (args: unknown) => callOfferedTool(process.env, t, as, args),
    }));
  }

  // One transport (+ its connected server) per live MCP session, plus the
  // identity it was opened for — a multi-token session is pinned to that
  // identity for its lifetime (see the mismatch check in the request handler).
  const sessions = new Map<string, { transport: WebStandardStreamableHTTPServerTransport; identity: string }>();

  async function openSession(identity: string, caller?: Caller): Promise<WebStandardStreamableHTTPServerTransport> {
    const { server } = serverFor(caller, identity);
    // Fires AFTER the initialize handshake completes — getClientVersion() is
    // populated here (it is not yet at onsessioninitialized). Logging the peer
    // makes the resolved harness observable and reveals an unmapped client's
    // real clientInfo.name so the alias table can be extended.
    server.server.oninitialized = () => {
      const peer = server.server.getClientVersion();
      process.stderr.write(`loom: peer connected client=${JSON.stringify(peer ?? null)}\n`);
    };
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sid) => {
        sessions.set(sid, { transport, identity });
      },
    });

    // SSE keep-alive: ping the client over the standalone stream. The first tick
    // is one interval out, by when the client has opened the stream. A live
    // client pongs (the SDK answers ping automatically); repeated misses mean a
    // dead peer or a reaped stream → close the session so it can't zombie, and
    // the client recovers via the 404 re-init path.
    let misses = 0;
    const heartbeat = setInterval(() => {
      void server.server
        .request({ method: 'ping' }, EmptyResultSchema, { timeout: HEARTBEAT_TIMEOUT_MS })
        .then(() => {
          misses = 0;
        })
        .catch(() => {
          misses += 1;
          if (misses >= HEARTBEAT_MISSES_BEFORE_CLOSE) {
            clearInterval(heartbeat);
            void transport.close().catch(() => undefined);
          }
        });
    }, heartbeatMs);
    // Don't let the heartbeat keep the event loop alive (clean process exit / test teardown).
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    transport.onclose = () => {
      clearInterval(heartbeat);
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
        if (workerSocket && process.connected) process.send?.({ type: 'loom-session-close', id: transport.sessionId }, () => undefined);
      }
    };
    await server.connect(transport);
    return transport;
  }

  /**
   * POST /api/<piece>/<path>. Like /cli: JSON only, no Origin (a browser
   * always sends one, and this route grants no CORS), within the body cap.
   * An owner or agent token calls as itself; a piece credential only its own
   * piece, as its subject; a peer never.
   */
  async function handlePieceApi(req: IncomingMessage, res: ServerResponse, named: string, subpath: string): Promise<void> {
    // An old piece name (PIECE_ALIASES: /api/box/… while the runtime is installed and no box is) is its piece.
    const piece = named === 'loom' ? named : resolvePieceName(process.env, named);
    // GET /api/loom/venues (role-routes.ts, RUNTIME_GET_ROUTES): the runtime's view of every venue.
    if (piece === 'loom' && RUNTIME_GET_ROUTES.includes(subpath)) {
      if (req.method !== 'GET') return sendError(res, 405, `method-not-allowed: GET /api/loom/${subpath}`);
      if (req.headers['origin'] !== undefined) return sendError(res, 403, 'forbidden: /api refuses browser requests');
      if (req.headers['authorization'] === undefined) return sendError(res, 401, 'unauthorized: a bearer token is required');
      const role = roleFor(req.headers['authorization']);
      if ('status' in role) return sendError(res, role.status, role.error);
      if (role.kind !== 'runtime') return sendError(res, 403, `forbidden: GET /api/loom/${subpath} takes the runtime's token`);
      // The body first, then the head: a failure to read is the 503, never a 200 cut short.
      let body: string;
      try {
        body = JSON.stringify({ venues: venueDirectory(process.env) });
      } catch (e) {
        process.stderr.write(`loom: couldn't list venues: ${(e as Error).message}\n`);
        return sendError(res, 503, 'unavailable: couldn\'t list venues; see the daemon log');
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(body);
      return;
    }
    // GET_ROUTES (the scorecards, the review's settings: a runtime token) are GET; everything else is POST.
    const getRoute = piece === 'loom' && GET_ROUTES.includes(subpath);
    if (getRoute ? req.method !== 'GET' : req.method !== 'POST') return sendError(res, 405, `method-not-allowed: ${getRoute ? 'GET' : 'POST'} /api/${piece}/${getRoute ? subpath : ''}`);
    // No token at all: only a path the piece declared open to strangers (its loom block, fixed at
    // install), with a small body, as {kind:'stranger', address}. Everything else still needs a token.
    if (req.headers['authorization'] === undefined) {
      const rec = piece === 'loom' ? undefined : readRecord(process.env, piece);
      if (!rec?.loom.strangers?.includes(subpath)) return sendError(res, 401, 'unauthorized: a bearer token is required');
      return pieceCall(req, res, piece, subpath, { kind: 'stranger', address: (workerSocket && typeof req.headers['x-loom-peer-address'] === 'string' ? req.headers['x-loom-peer-address'] : req.socket.remoteAddress) ?? 'unknown' }, STRANGER_MAX_BYTES);
    }
    const role = roleFor(req.headers['authorization']);
    if ('status' in role) return sendError(res, role.status, role.error);
    // POST /api/loom/deliver (docs/specs/agent-runtime.md, "Delivery"): the one core route every
    // piece credential reaches, as its piece, beside its own API; and the runtime's own token.
    if (piece === 'loom' && subpath === DELIVER_ROUTE) {
      if (role.kind !== 'piece' && role.kind !== 'runtime') return sendError(res, 403, `forbidden: /api/loom/${DELIVER_ROUTE} takes a piece's own token (a source delivering), or the runtime's`);
      return deliverApi(req, res, role.piece);
    }
    // POST /api/loom/people/ensure (docs/specs/person-cards.md, "Ensure"): a household owner, a piece
    // in an owner's action (its credential and the grant loom gave it), or the runtime.
    if (piece === 'loom' && subpath === ENSURE_ROUTE) return ensureApi(req, res, role);
    // POST /api/loom/people/merge (docs/specs/person-cards.md, "Merge"): a household owner, or the runtime.
    if (piece === 'loom' && subpath === MERGE_ROUTE) return mergeApi(req, res, role);
    // POST /api/loom/collections/query (docs/specs/collections.md, "Asking: queries"): an owner's, an agent's or a house's
    // token, each as a viewer of its own kind. No stream here: subscribing is the page's.
    if (piece === 'loom' && subpath === COLLECTIONS_QUERY_ROUTE) return collectionsApi(req, res, role);
    // POST /api/loom/collections/nudge {domain}: someone wrote; core pulls that domain soon (collections.md, "A nudge").
    if (piece === 'loom' && subpath === COLLECTIONS_NUDGE_ROUTE) return nudgeApi(req, res, role, req.headers['authorization'] ?? '');
    // The runtime and review roles reach only core's routes ROLE_ROUTES names for them.
    if (role.kind === 'runtime' || role.kind === 'review') {
      if (piece !== 'loom' || !roleReaches(role.kind, subpath)) return sendError(res, 403, `forbidden: a ${role.kind} token reaches only ${reachList(role.kind)}`);
      return loomApi(req, res, subpath, role, runOf(req.headers['authorization']));
    }
    // An agent's own session turns (docs/specs/conversations.md): the one core route an agent token reaches.
    if (piece === 'loom' && role.kind === 'agent' && AGENT_ROUTES.includes(subpath)) return loomApi(req, res, subpath, role, '');
    // Core's own routes for those roles refuse everyone else by name, before the store's 404.
    if (piece === 'loom' && Object.values(ROLE_ROUTES).some((paths) => paths.includes(subpath))) {
      return sendError(res, 403, `forbidden: /api/loom/${subpath} takes a runtime or review token${AGENT_ROUTES.includes(subpath) ? ', or an agent token for its own session' : ''}`);
    }
    // A piece's own store in loom (docs/specs/piece-storage.md): its credential, or a household owner.
    if (piece === 'loom') return storeApi(req, res, subpath, role);
    let caller: ApiCaller;
    switch (role.kind) {
      case 'owner':
        caller = ownerCaller(role.member);
        // An agent owner reaches only a piece that understands them (its manifest says owners: 2).
        if (caller.kind === 'owner' && caller.agents !== undefined && caller.agents !== '*') {
          const { pieces } = await pieceManifests(process.env);
          if (pieces.find((p) => p.piece === piece)?.manifest.owners !== 2) {
            return sendError(res, 403, `forbidden: ${piece} doesn't scope an owner to their agents yet; a household owner can use it`);
          }
        }
        break;
      case 'agent': {
        caller = { kind: 'agent', agent: role.agent, ...(role.service ? { service: role.service } : {}), ...(role.house ? { house: role.house } : {}) };
        // The grants authority, if one is installed, decides before the piece runs (src/grants.ts).
        // A piece that isn't there is still its 404 below, asked or not.
        if (piece !== 'loom' && findPiece(piece, process.env)) {
          // Read before asking: an authority installed mid-call leaves the piece's own list to decide.
          const decided = grantsAuthority(process.env).piece !== undefined;
          const no = await askGrant(process.env, { agent: role.agent, piece, path: subpath });
          if (no) return sendError(res, no.status, no.error);
          // The authority said yes, so the piece doesn't consult its own agent list (agent-runtime.md section 6, t-1971).
          if (decided) caller = { ...caller, granted: true };
        }
        break;
      }
      case 'piece':
        if (role.piece !== piece) return sendError(res, 403, `forbidden: this credential is ${role.piece}'s`);
        caller = { kind: 'piece', subject: role.subject };
        break;
      case 'peer': return sendError(res, 403, 'forbidden: a peer token reaches the commons only');
    }
    return pieceCall(req, res, piece, subpath, caller, maxBytes);
  }

  /**
   * POST /api/loom/collections/query {queries: [...]}: the answers for the token's own viewer (src/collections/serve.ts).
   * Piece, peer, review and runtime tokens are programs with their own seams, and are refused.
   */
  async function collectionsApi(req: IncomingMessage, res: ServerResponse, role: Role): Promise<void> {
    if (req.headers['origin'] !== undefined) return sendError(res, 403, 'forbidden: /api refuses browser requests');
    const h = live?.();
    if (!h) return sendError(res, 404, 'not-found: this server has no household');
    let viewer: Viewer;
    if (role.kind === 'owner') {
      // An owner token naming no member is the first household owner's (owners.md); one naming a member who left is no one's.
      const m = role.member === undefined ? firstOwner(h) : memberOf(h, role.member);
      if (!m) return sendError(res, 403, 'forbidden: this token\'s member isn\'t one of the household\'s');
      viewer = memberViewer(h, m);
    } else if (role.kind === 'agent') {
      if (!h.agents.includes(role.agent)) return sendError(res, 403, `forbidden: ${role.agent} isn't one of the household's agents`);
      viewer = { kind: 'agent', agent: role.agent, ...(role.house ? { house: role.house } : {}), ...(role.service ? { service: role.service } : {}) };
    } else {
      return sendError(res, 403, `forbidden: a ${role.kind} token doesn't read shared collections (it has its own seam)`);
    }
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return sendError(res, 415, 'unsupported-media-type: POST /api takes application/json');
    const raw = await collectBody(req, COLLECTIONS_MAX_BYTES);
    if (raw === OVERSIZED) return sendError(res, 413, `oversized: a batch of queries is ${COLLECTIONS_MAX_BYTES / 1024} KB at most`);
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return sendError(res, 400, 'bad-input: malformed JSON'); }
    const r = await answerBatch({ env: process.env, household: h }, viewer, body);
    if (r.status !== 200) return sendError(res, r.status, `bad-input: ${r.body.error}`);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(r.body));
  }

  /**
   * POST /api/loom/collections/nudge {domain}: an agent's, a house's, an owner's or a piece's token (never a peer's or a
   * review's), at most one a second per token. It carries a domain name and nothing else, and the answer is the same
   * whether or not the domain exists, so a nudge can't probe what's installed; a forged one costs at most one pull.
   */
  const nudgedAt = new Map<string, number>();
  async function nudgeApi(req: IncomingMessage, res: ServerResponse, role: Role, bearer: string): Promise<void> {
    if (req.headers['origin'] !== undefined) return sendError(res, 403, 'forbidden: /api refuses browser requests');
    if (role.kind !== 'agent' && role.kind !== 'owner' && role.kind !== 'piece') return sendError(res, 403, `forbidden: a ${role.kind} token doesn't nudge`);
    const h = live?.();
    if (!h) return sendError(res, 404, 'not-found: this server has no household');
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return sendError(res, 415, 'unsupported-media-type: POST /api takes application/json');
    const raw = await collectBody(req, 1024);
    if (raw === OVERSIZED) return sendError(res, 413, 'oversized: a nudge is a domain name');
    let body: { domain?: unknown };
    try { body = JSON.parse(raw); } catch { return sendError(res, 400, 'bad-input: malformed JSON'); }
    // Per token: the credential itself, as roleFor reads it, so another spelling of the header is the same token.
    const who = createHash('sha256').update(bearer.replace(/^Bearer\s+/i, '').trim()).digest('hex');
    const now = Date.now();
    if (now - (nudgedAt.get(who) ?? 0) < 1000) return sendError(res, 429, 'too-many: one nudge a second');
    nudgedAt.delete(who);
    nudgedAt.set(who, now);
    // Oldest first (a Map keeps insertion order): past the cap, the oldest go, whatever their age.
    for (const k of nudgedAt.keys()) { if (nudgedAt.size <= 4096) break; nudgedAt.delete(k); }
    if (typeof body?.domain === 'string') collectionsNudge(h.home, body.domain);
    res.writeHead(202, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end('{"ok":true}');
  }

  /** POST /api/loom/deliver as `piece`: checked and forwarded by src/delivery.ts. Like /api: JSON only, no Origin. */
  async function deliverApi(req: IncomingMessage, res: ServerResponse, piece: string): Promise<void> {
    if (req.headers['origin'] !== undefined) return sendError(res, 403, 'forbidden: /api refuses browser requests');
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return sendError(res, 415, 'unsupported-media-type: POST /api takes application/json');
    // A declared length over the cap is refused before reading (as pieceCall does), so the caller gets the 413.
    const declared = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(declared) && declared > DELIVER_MAX_BYTES) return sendError(res, 413, `oversized: a delivery is ${DELIVER_MAX_BYTES / 1024} KB at most`);
    const raw = await collectBody(req, DELIVER_MAX_BYTES);
    if (raw === OVERSIZED) return sendError(res, 413, `oversized: a delivery is ${DELIVER_MAX_BYTES / 1024} KB at most`);
    let body: unknown;
    try { body = raw === '' ? {} : JSON.parse(raw); } catch { return sendError(res, 400, 'bad-input: malformed JSON'); }
    let out;
    try {
      out = await deliver(process.env, live!(), { piece }, body);
    } catch (e) {
      // Keep the details (paths) out of the response.
      process.stderr.write(`loom: couldn't deliver: ${(e as Error).message}\n`);
      return sendError(res, 503, 'unavailable: couldn\'t deliver; see the daemon log');
    }
    if (out.status !== 200) return sendError(res, out.status, (out.body as { error: string }).error);
    return sendJson(res, 200, out.body);
  }

  /**
   * POST /api/loom/people/ensure {slug, name, role?, source, where?, agent?, dry_run?}: make sure a
   * person has a card (backends/people-ensure.ts). Who may: a household owner; the runtime; a
   * piece's credential carrying, in X-Loom-Store-Grant, the owner's grant loom gave that piece's
   * process for the action in progress (checked as `loom store` checks it: signed by loom, not
   * expired, this piece's, owner). Agents write cards with person_write; nobody else reaches it.
   */
  async function ensureApi(req: IncomingMessage, res: ServerResponse, role: Role): Promise<void> {
    if (req.headers['origin'] !== undefined) return sendError(res, 403, 'forbidden: /api refuses browser requests');
    const h = live?.();
    if (!h) return sendError(res, 404, 'not-found: this server has no household');
    let actor: string;
    if (role.kind === 'owner') {
      const c = ownerCaller(role.member);
      if (c.kind !== 'owner' || (c.agents !== undefined && c.agents !== '*')) return sendError(res, 403, 'forbidden: a card is made by a household owner, a piece in their action, or the runtime');
      actor = c.who ?? 'owner';
    } else if (role.kind === 'runtime') {
      actor = `runtime:${role.piece}`;
    } else if (role.kind === 'piece') {
      const raw = req.headers['x-loom-store-grant'];
      const g = readGrant(h.home, typeof raw === 'string' ? raw : undefined);
      if (!g || g.piece !== role.piece || !g.owner) {
        return sendError(res, 403, `forbidden: a piece makes a card only in an owner's action: send the owner's grant loom gave ${role.piece}'s process (X-Loom-Store-Grant)`);
      }
      actor = `${g.who ?? 'owner'} via ${role.piece}`;
    } else {
      return sendError(res, 403, role.kind === 'agent'
        ? 'forbidden: an agent writes its cards with person_write; people/ensure is the owner\'s, a piece\'s in their action, and the runtime\'s'
        : `forbidden: a ${role.kind} token doesn't make cards`);
    }
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return sendError(res, 415, 'unsupported-media-type: POST /api takes application/json');
    const raw = await collectBody(req, 16 * 1024);
    if (raw === OVERSIZED) return sendError(res, 413, 'oversized: an ensure is 16 KB at most');
    let body: unknown;
    try { body = raw === '' ? {} : JSON.parse(raw); } catch { return sendError(res, 400, 'bad-input: malformed JSON'); }
    try {
      return sendJson(res, 200, personEnsure(agentDir(h, h.default), body, actor));
    } catch (e) {
      if (e instanceof PersonCardError) {
        const conflict = /is archived|already on .*'s card/.test(e.message);
        return sendError(res, conflict ? 409 : 400, `${conflict ? 'conflict' : 'bad-input'}: ${e.message}`);
      }
      process.stderr.write(`loom: couldn't ensure a person card: ${(e as Error).message}\n`);
      return sendError(res, 503, 'unavailable: couldn\'t ensure the card; see the daemon log');
    }
  }

  /**
   * POST /api/loom/people/merge {from, into, dry_run?}: make two person cards one
   * (backends/people-merge.ts), across the household's directory and every agent's store. Who
   * may: a household owner; the runtime. An agent merges with person_merge; nobody else reaches it.
   */
  async function mergeApi(req: IncomingMessage, res: ServerResponse, role: Role): Promise<void> {
    if (req.headers['origin'] !== undefined) return sendError(res, 403, 'forbidden: /api refuses browser requests');
    const h = live?.();
    if (!h) return sendError(res, 404, 'not-found: this server has no household');
    let actor: string;
    if (role.kind === 'owner') {
      const c = ownerCaller(role.member);
      if (c.kind !== 'owner' || (c.agents !== undefined && c.agents !== '*')) return sendError(res, 403, 'forbidden: cards are merged by a household owner or the runtime');
      actor = c.who ?? 'owner';
    } else if (role.kind === 'runtime') {
      actor = `runtime:${role.piece}`;
    } else {
      return sendError(res, 403, role.kind === 'agent'
        ? 'forbidden: an agent merges cards with person_merge; people/merge is the owner\'s and the runtime\'s'
        : `forbidden: a ${role.kind} token doesn't merge cards`);
    }
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return sendError(res, 415, 'unsupported-media-type: POST /api takes application/json');
    const raw = await collectBody(req, 4 * 1024);
    if (raw === OVERSIZED) return sendError(res, 413, 'oversized: a merge is 4 KB at most');
    let body: unknown;
    try { body = raw === '' ? {} : JSON.parse(raw); } catch { return sendError(res, 400, 'bad-input: malformed JSON'); }
    try {
      return sendJson(res, 200, personMergeRun(agentDir(h, h.default), body, actor));
    } catch (e) {
      if (e instanceof PersonMergeError) {
        const code = e.status === 404 ? 'not-found' : e.status === 409 ? 'conflict' : 'bad-input';
        return sendError(res, e.status, `${code}: ${e.message}`);
      }
      if (e instanceof PersonCardError) return sendError(res, 400, `bad-input: ${e.message}`);
      process.stderr.write(`loom: couldn't merge person cards: ${(e as Error).message}\n`);
      return sendError(res, 503, 'unavailable: couldn\'t merge the cards; see the daemon log');
    }
  }

  const reachList = (kind: 'runtime' | 'review') =>
    ROLE_ROUTES[kind].length ? ROLE_ROUTES[kind].map((p) => `${GET_ROUTES.includes(p) ? 'GET' : 'POST'} /api/loom/${p}`).join(', ') : 'nothing yet';

  /**
   * A review run's id: a digest of its token (one token per run), so the refs a take hands out
   * answer only that run's scores, findings and done. A digest, never the token itself.
   */
  const runOf = (header: string | undefined): string =>
    `rv-${createHash('sha256').update((header ?? '').replace(/^Bearer\s+/i, '').trim()).digest('hex').slice(0, 16)}`;

  /** The body cap per core route: raw text for the audit write, refs for done, small for the rest. */
  const bodyCap = (subpath: string) => subpath === 'audit' || subpath === 'comms/adapter' ? 256 * 1024 : subpath === 'audit/done' || subpath === 'comms/activity' ? 64 * 1024 : 4 * 1024;

  const auditFail = (res: ServerResponse, e: unknown, what: string) => {
    if (e instanceof AuditError || e instanceof ConversationError) return sendError(res, e.status, `${statusWord(e.status)}: ${e.message}`);
    // Never the details: an audit error must not carry text or paths into a response.
    process.stderr.write(`loom: couldn't ${what}: ${(e as Error).name}\n`);
    return sendError(res, 503, `unavailable: couldn't ${what}; see the daemon log`);
  };

  /**
   * POST /api/loom/<path> for the runtime and review roles (src/transport/role-routes.ts):
   * the caller already passed roleReaches. Like /api: JSON only, no Origin.
   */
  async function loomApi(req: IncomingMessage, res: ServerResponse, subpath: string, role: Extract<Role, { kind: 'runtime' | 'review' | 'agent' }>, run: string): Promise<void> {
    if (req.headers['origin'] !== undefined) return sendError(res, 403, 'forbidden: /api refuses browser requests');
    // GET /api/loom/scorecards (docs/specs/conversations.md, "Review", step 4): the runtime's model choice reads it.
    if (subpath === 'scorecards' && role.kind === 'runtime') {
      try {
        const since = new URL(req.url ?? '/', 'http://localhost').searchParams.get('since') ?? undefined;
        return sendJson(res, 200, { rows: scorecards(live!().home, since) });
      } catch (e) { return auditFail(res, e, 'read the scorecards'); }
    }
    // GET /api/loom/review/config (docs/specs/conversations.md, "Review"): the runtime reads the
    // setting here, never from the file.
    if (subpath === 'review/config' && role.kind === 'runtime') {
      const h = live!();
      return sendJson(res, 200, { review: h.review ?? 'on', tz: h.tz ?? 'UTC' });
    }
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return sendError(res, 415, 'unsupported-media-type: POST /api takes application/json');
    const cap = bodyCap(subpath);
    const raw = await collectBody(req, cap);
    if (raw === OVERSIZED) return sendError(res, 413, `oversized: this call is ${cap / 1024} KB at most`);
    let body: unknown = {};
    try { if (raw !== '') body = JSON.parse(raw); } catch { return sendError(res, 400, 'bad-input: malformed JSON'); }
    // POST /api/loom/conversations/turn (docs/specs/conversations.md, "Who writes what"): metadata only.
    if (subpath === 'conversations/turn' && (role.kind === 'runtime' || role.kind === 'agent')) {
      try {
        return sendJson(res, 200, writeTurn(live!(), role, body));
      } catch (e) {
        if (e instanceof ConversationError) return sendError(res, e.status, `${statusWord(e.status)}: ${e.message}`);
        process.stderr.write(`loom: couldn't record a turn: ${(e as Error).message}\n`);
        return sendError(res, 503, 'unavailable: couldn\'t record the turn; see the daemon log');
      }
    }
    // POST /api/loom/conversations/house (t-2061): the runtime says which one conversation a body's house holds, before it
    // hands the house a body. Set once: another conversation for the same house is a 409. conversation_digest from that
    // house then writes only there (server.ts).
    if (subpath === 'conversations/house' && role.kind === 'runtime') {
      const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
      const h = live!();
      if (typeof b.agent !== 'string' || !h.agents.includes(b.agent)) return sendError(res, 400, `bad-input: agent names one of this household's agents (${h.agents.join(', ')})`);
      if (typeof b.house !== 'string' || !/^h-[0-9]{1,9}$/.test(b.house)) return sendError(res, 400, 'bad-input: house is a house id (h-<n>)');
      if (typeof b.conversation !== 'string' || !/^cv-[0-9a-f]{12}$/.test(b.conversation)) return sendError(res, 400, 'bad-input: conversation is a conversation id (cv-<12 hex>)');
      try {
        return sendJson(res, 200, bindHouseConversation(h.home, { agent: b.agent, house: b.house, conversation: b.conversation }));
      } catch (e) {
        if (e instanceof HouseBindingError) return sendError(res, 409, `conflict: ${e.message}`);
        process.stderr.write(`loom: couldn't record a house's conversation: ${(e as Error).name}\n`);
        return sendError(res, 503, 'unavailable: couldn\'t record the house\'s conversation; see the daemon log');
      }
    }
    // POST /api/loom/audit (docs/specs/conversations.md, "Who writes what"): a turn's raw text, by its writer.
    if (subpath === 'audit' && (role.kind === 'runtime' || role.kind === 'agent')) {
      try { return sendJson(res, 200, writeAudit(live!(), role, body)); } catch (e) { return auditFail(res, e, 'write the audit entry'); }
    }
    // Its manifest moved (docs/extensions.md, "agents"; t-1945): the open apps ask the pieces again now. No body to read.
    if (subpath === 'pieces/changed' && role.kind === 'runtime') {
      // Only the runtime's own manifest moved: the other pieces keep theirs (t-2065).
      const runtime = runtimePieces(process.env);
      piecesMoved(live!().home, runtime.length === 1 ? listPieces(process.env).find((p) => p.name === runtime[0])?.path : undefined);
      return sendJson(res, 200, { ok: true });
    }
    // Venue loom's adapter calls and tool cards (docs/specs/comms.md, sections 1 and 3): the runtime's only.
    if ((subpath === 'comms/adapter' || subpath === 'comms/activity') && role.kind === 'runtime') {
      if (!body || typeof body !== 'object' || Array.isArray(body)) return sendError(res, 400, 'bad-input: a JSON object');
      try {
        return sendJson(res, 200, subpath === 'comms/adapter' ? commsAdapter(live!(), process.env, body as Record<string, unknown>) : postActivity(live!(), process.env, body as Record<string, unknown>));
      } catch (e) {
        if (e instanceof CommsError) return sendError(res, e.status, e.message.startsWith(`${statusWord(e.status)}:`) ? e.message : `${statusWord(e.status)}: ${e.message}`);
        process.stderr.write(`loom: a Comms runtime call failed: ${(e as Error).name}\n`);
        return sendError(res, 503, 'unavailable: Comms couldn\'t answer; see the daemon log');
      }
    }
    // The review run's routes (docs/specs/conversations.md, "Review tokens"), all scoped to its run.
    if (role.kind === 'review') {
      try {
        if (subpath === 'audit/take') {
          // Raw text, redacted: never cached.
          const out = takeAudit(live!(), run, body);
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify(out));
          return;
        }
        if (subpath === 'audit/done') return sendJson(res, 200, doneEntries(live!().home, run, body));
        if (subpath === 'scores') return sendJson(res, 200, postScore(live!(), run, body));
        if (subpath === 'findings') return sendJson(res, 200, postFinding(live!(), run, body));
      } catch (e) { return auditFail(res, e, `answer ${subpath}`); }
    }
    // POST /api/loom/review/token (docs/specs/conversations.md, "Review tokens"): one per run.
    if (subpath === 'review/token' && role.kind === 'runtime') {
      try {
        const { token, record } = mintReviewToken(live!(), role.piece);
        // A credential: never cached.
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ token, expires: record.expires }));
        return;
      } catch (e) {
        if (e instanceof TokenLimitError) return sendError(res, 429, `too-many: ${e.message}`);
        // Keep the details (paths) out of the response, as roleFor does.
        process.stderr.write(`loom: couldn't mint a review token: ${(e as Error).message}\n`);
        return sendError(res, 503, 'unavailable: couldn\'t mint a review token; see the daemon log');
      }
    }
    return sendError(res, 404, `not-found: /api/loom/${subpath}`);
  }

  /**
   * POST /api/loom/store/<piece>/<op> {collection, key?, doc?, ifRev?, prefix?, limit?, revision?}.
   * A piece's credential (piece:<piece>/<subject>) reads and writes its own store as the piece;
   * a household owner, any store, as the owner. Nobody else: an agent writes through the piece.
   */
  async function storeApi(req: IncomingMessage, res: ServerResponse, subpath: string, role: Role): Promise<void> {
    const m = /^store\/([a-z][a-z0-9-]{0,39})\/(get|list|put|del|history|revert)$/.exec(subpath);
    if (!m) return sendError(res, 404, 'not-found: /api/loom/store/<piece>/<get|list|put|del|history|revert>');
    const [, storeNamed, op] = m;
    const storePiece = resolvePieceName(process.env, storeNamed);
    let grant: Grant;
    if (role.kind === 'piece' && role.piece === storePiece) grant = { piece: storePiece, exp: Number.MAX_SAFE_INTEGER };
    else if (role.kind === 'owner') {
      const c = ownerCaller(role.member);
      if (c.kind !== 'owner' || (c.agents !== undefined && c.agents !== '*')) return sendError(res, 403, 'forbidden: a piece\'s store is its own and the household owner\'s');
      grant = { piece: storePiece, owner: true, ...(c.who ? { who: c.who } : {}), exp: Number.MAX_SAFE_INTEGER };
    } else return sendError(res, 403, 'forbidden: a piece\'s store is its own and the household owner\'s');
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return sendError(res, 415, 'unsupported-media-type: application/json');
    const raw = await collectBody(req, 512 * 1024);
    if (raw === OVERSIZED) return sendError(res, 413, 'oversized: a store call is 512 KB at most');
    let b: Record<string, unknown>;
    try { b = raw === '' ? {} : JSON.parse(raw); } catch { return sendError(res, 400, 'bad-input: malformed JSON'); }
    const rec = readRecord(process.env, storePiece);
    if (!rec) return sendError(res, 404, `not-found: no managed piece ${storePiece}`);
    try {
      const out = await retrySqlite(() => {
        const st = new PieceStore(live!().home, storePiece);
        try {
          const decl = rec.loom.store ?? {};
          const c = String(b.collection ?? ''), k = String(b.key ?? '');
          const ifRev = typeof b.ifRev === 'number' ? b.ifRev : undefined;
          const out = op === 'get' ? st.get(c, k)
            : op === 'list' ? st.list(c, { prefix: typeof b.prefix === 'string' ? b.prefix : undefined, limit: typeof b.limit === 'number' ? b.limit : undefined })
            : op === 'put' ? { rev: st.put(c, k, b.doc, grant, decl, ifRev) }
            : op === 'del' ? { deleted: st.del(c, k, grant, decl, ifRev) }
            : op === 'history' ? st.history(c, k)
            : { rev: st.revert(c, k, Number(b.revision), grant, decl) };
          return out;
        } finally { st.close(); }
      });
      return sendJson(res, out === null ? 404 : 200, out ?? { error: `no ${String(b.collection ?? '')}/${String(b.key ?? '')}` });
    } catch (e) {
      if (e instanceof StoreError) return sendError(res, e.status, e.message);
      throw e;
    }
  }

  async function pieceCall(req: IncomingMessage, res: ServerResponse, piece: string, subpath: string, caller: ApiCaller, maxBytes: number): Promise<void> {
    if (req.headers['origin'] !== undefined) return sendError(res, 403, 'forbidden: /api refuses browser requests');
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
      return sendError(res, 415, 'unsupported-media-type: POST /api takes application/json');
    }
    const declared = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(declared) && declared > 0 && !checkPayloadSize(declared, maxBytes).ok) {
      return sendError(res, 413, `oversized: declared ${declared} bytes exceeds cap ${maxBytes}`);
    }
    const raw = await collectBody(req, maxBytes);
    if (raw === OVERSIZED) return sendError(res, 413, `oversized: body exceeds cap ${maxBytes}`);
    let body: unknown;
    try { body = raw === '' ? {} : JSON.parse(raw); } catch (e) { return sendError(res, 400, `bad-input: malformed JSON (${(e as Error).message})`); }
    // "loom" is core's own name; a piece can't take it.
    const path = piece === 'loom' ? null : findPiece(piece, process.env);
    if (!path) return sendError(res, 404, `not-found: no piece named ${piece}`);
    // A caller that hangs up while queued gives its place back.
    const gone = new AbortController();
    res.on('close', () => { if (!res.writableEnded) gone.abort(); });
    const out = await pieceApi(path, { caller, path: subpath, body }, process.env, gone.signal);
    // The piece said it wrote: its shared collections are pulled soon, so open windows hear it at once (t-2029).
    // Not on a stranger's word: a tokenless call can't make loom pull (a pull it caused would cost the household, not it).
    if (out.changed && live && caller.kind !== 'stranger') {
      forgetPiecePages(path);
      try { pullPieceSoon(live().home, process.env, piece); } catch { /* a hint; the 15 s pull still runs */ }
    }
    if (gone.signal.aborted) return;
    res.writeHead(out.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(out.body));
  }

  // Push for Your call: each listener tries the watch each minute; one of them gets it (push.ts).
  const pushTimer = opts.createServer ? undefined : setInterval(() => {
    if (!backgroundActive) return;
    stalls.timed('push watch', () => void pushWatch({ contextDir: opts.contextDir, auth: uiAuth, env: process.env, household: live })
      .catch((e) => console.error(`[loom:push] watch failed: ${(e as Error).message}`)));
  }, WATCH_S * 1000);
  pushTimer?.unref();
  // Needs you that wait on something (an approval, a task) clear themselves once it's resolved (src/needs-resolve.ts):
  // checked each minute, and at start, through the pieces' own APIs. Never stops the daemon.
  const resolveAll = () => {
    if (!backgroundActive || !live) return;
    stalls.timed('needs resolve', () => void resolveNeeds(live!(), pieceCheckers(process.env))
      .catch((e) => console.error(`[loom:needs] the resolve pass failed: ${(e as Error).message}`)));
  };
  const needsTimer = opts.createServer || !household ? undefined : setInterval(resolveAll, NEEDS_TICK_MS);
  needsTimer?.unref();
  const needsFirst = needsTimer ? setTimeout(resolveAll, 2_000) : undefined;
  needsFirst?.unref();
  // The nightly backup (docs/specs/keeping-watch.md): every 10 minutes each listener starts `loom backup tick`, a
  // child process; the one that takes the run lock says a miss and runs a backup that's due. Never stops the daemon.
  // Never throws out of a timer: a backup that can't start is the backup's to report, not the listener's to die of.
  const backupTick = () => { try { if (backgroundActive && live) stalls.timed('backup tick', () => spawnBackupTick(live!(), process.env)); } catch (e) { process.stderr.write(`loom: the backup tick didn't start: ${(e as Error).message}\n`); } };
  const backupTimer = opts.createServer || !household ? undefined : setInterval(backupTick, 10 * 60_000);
  backupTimer?.unref();
  const backupFirst = backupTimer ? setTimeout(backupTick, 60_000) : undefined;
  backupFirst?.unref();

  const http = createServer((req, res) => {
    const done = stalls.request(req.method, req.url);
    res.once('close', done);
    void withNonblockingSqlite(async () => {
      // loom's web page (src/ui), at the root. Its own auth (a session from
      // the bearer, or the bearer header), so it comes before the bearer gate.
      // Full scope only: a scoped server has no memory to show.
      const fullPath = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (isUiRequest(req, fullPath)) {
        if (opts.createServer) return sendError(res, 404, 'not-found: this server has no UI');
        return handleUi(req, res, fullPath, {
          contextDir: opts.contextDir,
          auth: uiAuth,
          env: process.env,
          household: live,
          ...(ownerDigest ? { envOwnerDigest: ownerDigest.toString('hex') } : {}),
        });
      }

      // POST /api/<piece>/…: a piece's API (docs/extensions.md, "The API"),
      // for callers that aren't a browser: a box calling home, a body asking
      // for a house. Household only, bearer only, JSON only.
      if (household && (fullPath === '/api' || fullPath.startsWith('/api/'))) {
        const api = /^\/api\/([a-z][a-z0-9-]{0,39})((?:\/[A-Za-z0-9._~-]+)*)\/?$/.exec(fullPath);
        if (!api || api[2].split('/').some((s) => s === '.' || s === '..')) return sendError(res, 404, 'not-found: /api/<piece>/<path>');
        return handlePieceApi(req, res, api[1], api[2].replace(/^\//, ''));
      }

      // Household: `/agents/<name>/…` names the agent (the owner's way to
      // reach a non-default one; an agent's own token may use its own name).
      const scoped = household ? /^\/agents\/([a-z][a-z0-9-]{0,39})(\/.*)?$/.exec(fullPath) : null;
      // A path under /agents/ that doesn't name an agent cleanly is a mistake,
      // not a request for the default agent.
      if (household && !scoped && (fullPath === '/agents' || fullPath.startsWith('/agents/'))) {
        return sendError(res, 404, 'not-found: /agents/<name>/ takes a lowercase agent name');
      }
      const target = scoped?.[1];
      const path = scoped ? (scoped[2] ?? '/') : fullPath;
      // In a household the only routes past the page are MCP and /cli: any
      // other path (/AGENTS/mark/mcp, /x/agents/mark/mcp) is a 404, not the
      // default agent.
      if (household && path !== '/' && path !== '/mcp' && path !== '/cli') {
        return sendError(res, 404, 'not-found: in a household, use /, /mcp or /cli, optionally under /agents/<name>/');
      }

      // Auth gate (ac-lt-auth-gate): reject unauthenticated when a token (or
      // token map) is configured. Multi-token mode additionally resolves
      // WHICH identity made this call — the bearer itself is the identity
      // claim (t-677); there is no separate login step.
      let caller: Caller | undefined;
      let identity: string;
      if (household) {
        const c = callerFor(req.headers['authorization'], target);
        if ('status' in c) return sendError(res, c.status, c.error);
        caller = c;
        identity = c.key;
      } else {
        const auth: { ok: boolean; error?: string; identity?: string } = opts.tokens
          ? checkBearerMulti(opts.tokens, req.headers['authorization'])
          : checkBearer(opts.token, req.headers['authorization']);
        if (!auth.ok) return sendError(res, 401, auth.error!);
        identity = auth.identity ?? 'art';
      }

      // Oversized guard (ac-lt-oversized-guard): fast path on declared length.
      const declared = Number(req.headers['content-length'] ?? 0);
      if (Number.isFinite(declared) && declared > 0 && !checkPayloadSize(declared, maxBytes).ok) {
        return sendError(res, 413, `oversized: declared ${declared} bytes exceeds cap ${maxBytes}`);
      }

      // POST /cli: the CLI's remote mode (cli-endpoint.ts). Same gate and cap
      // as /mcp above. Full server only: a scoped server (knowledge-only)
      // can't offer the memory verbs, so it has no /cli at all.
      if (path === '/cli') {
        if (opts.createServer || caller?.role.kind === 'peer') return sendError(res, 404, 'not-found: this server has no CLI endpoint');
        // Unlike /mcp (initialize handshake + mcp-session-id header), a bare
        // POST could be a browser's "simple" cross-site request. So /cli needs
        // a configured token, a JSON content type (forces a CORS preflight,
        // which this server never grants), and no Origin header at all: the
        // CLI never sends one, and a browser always does.
        if (!opts.token && !opts.tokens && !household) return sendError(res, 403, 'forbidden: /cli requires LOOM_BEARER_TOKEN');
        if (req.headers['origin'] !== undefined) return sendError(res, 403, 'forbidden: /cli refuses browser requests');
        if (req.method !== 'POST') return sendError(res, 405, 'method-not-allowed: POST /cli');
        if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
          return sendError(res, 415, 'unsupported-media-type: POST /cli takes application/json');
        }
        const body = await collectBody(req, maxBytes);
        if (body === OVERSIZED) return sendError(res, 413, `oversized: body exceeds cap ${maxBytes}`);
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch (e) {
          return sendError(res, 400, `bad-input: malformed JSON (${(e as Error).message})`);
        }
        // From a house (or a service's token), what it reads is the conversation it holds (t-2118).
        const cliRole = caller?.role.kind === 'agent' ? caller.role : undefined;
        const held = cliRole && (cliRole.house || cliRole.service)
          ? bodyHouseConversation(caller!.contextDir, { ...(cliRole.house ? { house: cliRole.house } : {}), ...(cliRole.service ? { service: cliRole.service } : {}) })
          : undefined;
        const outcome = await handleCliBody(caller?.contextDir ?? opts.contextDir, parsed, held);
        if (!outcome.ok) return sendError(res, 400, outcome.error);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(outcome.response));
        return;
      }

      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      // A session is pinned to the identity that opened it. Presenting a
      // DIFFERENT identity's valid token against an existing session id is
      // refused outright rather than silently re-attributed or routed —
      // the per-identity bearer only means anything if a session can't be
      // hijacked across identities by replaying its id with another token.
      const existingSession = sessionId ? sessions.get(sessionId) : undefined;
      if (existingSession && existingSession.identity !== identity) {
        return sendError(res, 401, 'unauthorized: session belongs to a different identity');
      }

      // GET = the server->client SSE stream (server push: listChanged, progress,
      // elicitation, ui:// updates). It attaches to an established session, so a
      // GET routes to that session's transport. The stream is kept alive by the
      // per-session heartbeat. A GET for a session we no longer hold is 404 (the
      // client re-initializes); a GET with no session at all is 405.
      if (req.method === 'GET' || req.method === 'DELETE') {
        if (existingSession) {
          return existingSession.transport
            .handleRequest(nodeRequestToWebRequest(req))
            .then((webRes) => sendWebResponse(res, webRes))
            .catch((e: unknown) => sendError(res, 500, `internal: ${(e as Error).message}`));
        }
        if (sessionId) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'session not found; reinitialize' }));
          return;
        }
        res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' });
        res.end(JSON.stringify({ error: 'method-not-allowed: open a session with an initialize POST first' }));
        return;
      }

      if (req.method !== 'POST') return sendError(res, 405, 'method-not-allowed');

      // POST: read + cap the body, then route by session / initialize.
      const body = await collectBody(req, maxBytes);
      if (body === OVERSIZED) return sendError(res, 413, `oversized: body exceeds cap ${maxBytes}`);
      let parsed: unknown;
      try {
        parsed = body ? JSON.parse(body) : undefined;
      } catch (e) {
        return sendError(res, 400, `bad-input: malformed JSON (${(e as Error).message})`);
      }

      let transport = existingSession?.transport;
      if (!transport) {
        if (sessionId) {
          // A session id we don't have (expired / dropped). Per MCP spec, 404
          // tells the client to start over with a fresh initialize — so an idle
          // disconnect self-heals instead of bricking on a 400.
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'session not found; reinitialize' }));
          return;
        }
        if (!isInitializeRequest(parsed)) {
          return sendError(res, 400, 'bad-input: no valid session; expected an initialize request');
        }
        transport = await openSession(identity, caller);
      }

      // Dispatch totality + typed envelopes (unknown tool / bad args -> JSON-RPC
      // error) are the SDK server's job from here — never a raw throw out.
      const webRes = await transport.handleRequest(nodeRequestToWebRequest(req), { parsedBody: parsed });
      await sendWebResponse(res, webRes);
    }).catch((e: unknown) => {
      if (isSqliteBusy(e)) {
        res.setHeader('retry-after', '1');
        return sendError(res, 503, 'unavailable: database busy; try again');
      }
      sendError(res, 500, `internal: ${(e as Error).message}`);
    });
  });

  // Traefik keeps backend connections idle for up to 90 seconds. Close
  // after its reuse window, so a reused POST cannot race Node's 5 s default.
  http.keepAliveTimeout = 120_000;
  http.headersTimeout = 125_000;

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    // A supervised worker has a private Unix socket, inaccessible to other
    // users. All request/auth handling stays in this server.
    if (workerSocket) http.listen(workerSocket, () => resolve());
    else http.listen(opts.port, opts.host, () => resolve());
  });
  const addr = http.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port;

  return {
    port,
    host: opts.host,
    setBackgroundActive(active) {
      return withNonblockingSqlite(() => {
      const was = backgroundActive;
      backgroundActive = active;
      if (active && !was) stalls.timed('worker activation', () => {
        if (household) stalls.timed('venues sync', () => syncVenuesQuietly(process.env));
        foldAll(); sweepAll();
        if (live && !opts.createServer) {
          try { stalls.timed('comms sweep', () => sweepComms(live!())); } catch { /* next timer retries */ }
          stalls.timed('comms refs backfill', () => void backfillRefs(live!(), process.env).catch(() => undefined));
        }
      });
      });
    },
    async close() {
      stalls.stop();
      if (pushTimer) clearInterval(pushTimer);
      if (needsTimer) clearInterval(needsTimer);
      if (backupTimer) clearInterval(backupTimer);
      if (backupFirst) clearTimeout(backupFirst);
      if (needsFirst) clearTimeout(needsFirst);
      clearInterval(foldTimer);
      clearInterval(sweepTimer);
      if (commsTimer) { clearInterval(commsTimer); stopCommsWatch(); }
      stopPieceServers();
      closePieceSockets();
      for (const s of sessions.values()) await s.transport.close().catch(() => undefined);
      sessions.clear();
      await new Promise<void>((resolve) => {
        // Force-close lingering keep-alive/SSE sockets so close() can't hang.
        http.closeAllConnections?.();
        http.close(() => resolve());
      });
    },
  };
}
