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
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { WebStandardStreamableHTTPServerTransport, isInitializeRequest } from '@modelcontextprotocol/server';
import type { McpServer } from '@modelcontextprotocol/server';
import { EmptyResultSchema } from '@modelcontextprotocol/core';
import { createLoomServer } from '../server.js';
import { createBackend } from '../backends/index.js';
import { handleCliBody } from './cli-endpoint.js';
import { handleUi, isUiRequest, legacyUiAuth, pushWatch, type UiAuth } from '../ui/handler.js';
import { WATCH_S } from '../ui/push.js';
import { pieceApi, type ApiCaller } from '../ui/pieces.js';
import { findPiece } from '../cli/pieces.js';
import { readRecord } from '../cli/pieces-managed.js';

/** A stranger's call (a box asking to join) is small: a name, its facts, a proof hash. */
const STRANGER_MAX_BYTES = 8 * 1024;
import { createKnowledgeOnlyServer } from './knowledge-server.js';
import { ensureAgentEntries, ensureMemberEntries, hasUnsplitPeople } from '../backends/people-household.js';
import { agentName } from '../ui/core.js';
import { agentDir, assertRealAgentDir, commonsProblem, firstOwner, liveHousehold, memberOf, roleString, TokenResolver, type Household, type Role } from '../household.js';
import { createHash, timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto';
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
  close(): Promise<void>;
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

export async function startHttpServer(opts: HttpServeOptions): Promise<HttpServeHandle> {
  // Bind-safety (ac-lt-bind-safety): refuse an unsafe host BEFORE we open a socket.
  assertSafeBind(opts.host);
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
  const resolver = live ? new TokenResolver(live) : undefined;
  const ownerDigest = opts.token ? createHash('sha256').update(opts.token).digest() : undefined;
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
    return role;
  }

  /** Resolve a household caller: 401 (no/unknown token), 403 (not allowed there) or 404 (no such agent). */
  function callerFor(header: string | undefined, target: string | undefined): Caller | { status: number; error: string } {
    const role = roleFor(header);
    if ('status' in role) return role;
    // Every kind is handled by name: an unlisted one must never fall through to the owner's branch.
    if (role.kind === 'piece') return { status: 403, error: `forbidden: a piece credential reaches only /api/${role.piece}/` };
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
    const agent = target ?? h.default;
    if (!h.agents.includes(agent)) return { status: 404, error: `not-found: no agent named ${agent}` };
    return { role, agent, contextDir: agentDir(h, agent), key: `owner>${agent}` };
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
    return createLoomServer({ contextDir: c.contextDir, gapsDir: opts.gapsDir, remote: true, relay: relayAs(c.agent) });
  };

  /**
   * The relay tool's reach (t-1597): the clock piece's `relay`, called the way
   * a house calls it, as this session's own agent. An owner session acting
   * for an agent relays as that agent; it gains nothing the agent's own token
   * doesn't have.
   */
  function relayAs(agent: string) {
    return async (argv: string[]): Promise<{ ok: boolean; text: string }> => {
      const path = findPiece('clock', process.env);
      if (!path) return { ok: false, text: 'relay: this loom has no clock piece' };
      const out = await pieceApi(path, { caller: { kind: 'agent', agent }, path: 'run', body: { argv } }, process.env);
      const b = (out.body ?? {}) as { exit?: number; stdout?: string; stderr?: string; error?: string };
      const ok = out.status === 200 && b.exit === 0;
      return { ok, text: (ok ? b.stdout : b.stderr || b.error || b.stdout || `the clock answered ${out.status}`)?.trim() || '(no answer)' };
    };
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
      if (transport.sessionId) sessions.delete(transport.sessionId);
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
  async function handlePieceApi(req: IncomingMessage, res: ServerResponse, piece: string, subpath: string): Promise<void> {
    if (req.method !== 'POST') return sendError(res, 405, `method-not-allowed: POST /api/${piece}/`);
    // No token at all: only a path the piece declared open to strangers (its loom block, fixed at
    // install), with a small body, as {kind:'stranger', address}. Everything else still needs a token.
    if (req.headers['authorization'] === undefined) {
      const rec = piece === 'loom' ? undefined : readRecord(process.env, piece);
      if (!rec?.loom.strangers?.includes(subpath)) return sendError(res, 401, 'unauthorized: a bearer token is required');
      return pieceCall(req, res, piece, subpath, { kind: 'stranger', address: req.socket.remoteAddress ?? 'unknown' }, STRANGER_MAX_BYTES);
    }
    const role = roleFor(req.headers['authorization']);
    if ('status' in role) return sendError(res, role.status, role.error);
    let caller: ApiCaller;
    switch (role.kind) {
      case 'owner': caller = ownerCaller(role.member); break;
      case 'agent': caller = { kind: 'agent', agent: role.agent, ...(role.service ? { service: role.service } : {}), ...(role.house ? { house: role.house } : {}) }; break;
      case 'piece':
        if (role.piece !== piece) return sendError(res, 403, `forbidden: this credential is ${role.piece}'s`);
        caller = { kind: 'piece', subject: role.subject };
        break;
      case 'peer': return sendError(res, 403, 'forbidden: a peer token reaches the commons only');
    }
    return pieceCall(req, res, piece, subpath, caller, maxBytes);
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
    if (gone.signal.aborted) return;
    res.writeHead(out.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(out.body));
  }

  // Push for Your call: each listener tries the watch each minute; one of them gets it (push.ts).
  const pushTimer = opts.createServer ? undefined : setInterval(() => {
    void pushWatch({ contextDir: opts.contextDir, auth: uiAuth, env: process.env, household: live })
      .catch((e) => console.error(`[loom:push] watch failed: ${(e as Error).message}`));
  }, WATCH_S * 1000);
  pushTimer?.unref();

  const http = createServer((req, res) => {
    void (async () => {
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
        const outcome = await handleCliBody(caller?.contextDir ?? opts.contextDir, parsed);
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
    })().catch((e: unknown) => sendError(res, 500, `internal: ${(e as Error).message}`));
  });

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(opts.port, opts.host, () => resolve());
  });
  const addr = http.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port;

  return {
    port,
    host: opts.host,
    async close() {
      if (pushTimer) clearInterval(pushTimer);
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
