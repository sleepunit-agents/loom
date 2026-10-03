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
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest, EmptyResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createLoomServer } from '../server.js';
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

  const makeServer = opts.createServer ?? ((ctx: { contextDir: string; gapsDir?: string }) => createLoomServer(ctx));

  // One transport (+ its connected server) per live MCP session, plus the
  // identity it was opened for — a multi-token session is pinned to that
  // identity for its lifetime (see the mismatch check in the request handler).
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; identity: string }>();

  async function openSession(identity: string): Promise<StreamableHTTPServerTransport> {
    const { server } = makeServer({ contextDir: opts.contextDir, gapsDir: opts.gapsDir, identity });
    // Fires AFTER the initialize handshake completes — getClientVersion() is
    // populated here (it is not yet at onsessioninitialized). Logging the peer
    // makes the resolved harness observable and reveals an unmapped client's
    // real clientInfo.name so the alias table can be extended.
    server.server.oninitialized = () => {
      const peer = server.server.getClientVersion();
      process.stderr.write(`loom: peer connected client=${JSON.stringify(peer ?? null)}\n`);
    };
    const transport = new StreamableHTTPServerTransport({
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

  const http = createServer((req, res) => {
    void (async () => {
      // Auth gate (ac-lt-auth-gate): reject unauthenticated when a token (or
      // token map) is configured. Multi-token mode additionally resolves
      // WHICH identity made this call — the bearer itself is the identity
      // claim (t-677); there is no separate login step.
      const auth: { ok: boolean; error?: string; identity?: string } = opts.tokens
        ? checkBearerMulti(opts.tokens, req.headers['authorization'])
        : checkBearer(opts.token, req.headers['authorization']);
      if (!auth.ok) return sendError(res, 401, auth.error!);
      const identity = auth.identity ?? 'art';

      // Oversized guard (ac-lt-oversized-guard): fast path on declared length.
      const declared = Number(req.headers['content-length'] ?? 0);
      if (Number.isFinite(declared) && declared > 0 && !checkPayloadSize(declared, maxBytes).ok) {
        return sendError(res, 413, `oversized: declared ${declared} bytes exceeds cap ${maxBytes}`);
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
          return existingSession.transport.handleRequest(req, res).catch((e: unknown) =>
            sendError(res, 500, `internal: ${(e as Error).message}`),
          );
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
        transport = await openSession(identity);
      }

      // Dispatch totality + typed envelopes (unknown tool / bad args -> JSON-RPC
      // error) are the SDK server's job from here — never a raw throw out.
      await transport.handleRequest(req, res, parsed);
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
