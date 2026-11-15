/**
 * loom serve — stdio tools or the shared household HTTP app. The web app uses
 * current shared credentials, one query door and explicit prepared sources.
 *
 * `--scope knowledge` (t-677) starts the standalone knowledge-only service
 * instead of the full server — same transport, tailscale-bind-safety, and
 * bearer-gating pattern, but the MCP tool surface is knowledge_* only and
 * auth is per-identity (LOOM_KNOWLEDGE_BEARER_TOKENS, "identity:token,...")
 * so the acting identity is derivable server-side for attribution. It is
 * NOT started by default and ships disabled — nothing in this repo enables
 * or deploys it; standing it up is a separate, deliberate operational step.
 */
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createLoomServer } from '../server.js';
import { createKnowledgeOnlyServer } from '../transport/knowledge-server.js';
import { householdOf } from '../household.js';
import { startHttpServer as startServer, type HttpServeOptions } from '../transport/http-server.js';
import { acquireHttpLock } from '../transport/http-lock.js';
import { resolveContextDir } from '../config.js';
import type { IOStreams } from './io.js';

/** CLI daemons are exclusive per home; embedded transport tests may share a store. */
async function startHttpServer(opts: HttpServeOptions) {
  const release = acquireHttpLock(opts.household?.home ?? householdOf(opts.contextDir)?.household.home ?? opts.contextDir);
  try {
    const handle = await startServer(opts);
    const close = handle.close;
    handle.close = async () => { try { await close(); } finally { release(); } };
    return handle;
  } catch (error) { release(); throw error; }
}

const USAGE = `Usage: loom serve [options]

Start the MCP server. Default transport is stdio; --http starts the
shared household app instead. The knowledge-only service remains explicit.

Options:
  --next                 Alias for the shared HTTP app
  --home <dir>           Prepared shared household (env LOOM_HOME)
  --program <file>       Private explicit startup inventory (default <home>/program.json)
  --http                 Serve over HTTP instead of stdio
  --scope <full|knowledge>  Shared app or standalone knowledge service (default full)
                         knowledge without --http is rejected
  --host <h>             HTTP bind host, repeatable (env LOOM_HTTP_HOST comma-separated, default 127.0.0.1)
  --port <n>             HTTP port (env LOOM_HTTP_PORT, or LOOM_KNOWLEDGE_HTTP_PORT
                         for --scope knowledge, default 8787 / 8788)
  --help, -h             Show this help

--scope full (default): bearer token from LOOM_BEARER_TOKEN.
--scope knowledge: per-identity bearer from LOOM_KNOWLEDGE_BEARER_TOKENS,
  format "identity:token,identity:token" — e.g. "art:abc123,mark:def456".
  Required and non-empty; the knowledge-only service refuses to boot without
  at least one identity configured. Registers knowledge_* tools only — no
  identity/memory/dossier tools on this surface.

Bind-safety refuses a public host in both scopes.
`;

/**
 * Parse "identity:token,identity:token" into a token → identity map ready
 * for startHttpServer's `tokens` option (checkBearerMulti). Throws with a
 * message naming the offending pair on malformed input — fail loud at CLI
 * startup rather than silently dropping an identity.
 */
export function parseIdentityTokens(raw: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  const pairs = raw.split(',');
  for (let i = 0; i < pairs.length; i++) {
    const trimmed = pairs[i].trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(':');
    const identity = idx > 0 ? trimmed.slice(0, idx).trim() : '';
    const token = idx > 0 ? trimmed.slice(idx + 1).trim() : '';
    if (!identity || !token) {
      // Never echo `trimmed` — a malformed pair is exactly the shape a
      // pasted-without-colon secret takes, and this error can land in
      // stderr/journal/CI logs. Report position only, never content.
      throw new Error(
        `malformed identity:token pair at position ${i + 1} — expected "identity:token", ` +
          `got ${identity ? 'an identity with no token' : 'no identity'} (value withheld from this error)`,
      );
    }
    tokens[identity] = token;
  }
  return tokens;
}

export async function run(argv: string[], io: IOStreams): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        next: { type: 'boolean', default: false },
        staging: { type: 'boolean', default: false },
        'secret-authority': { type: 'string' },
        'secret-holder': { type: 'string' },
        'secret-writes': { type: 'string' },
        home: { type: 'string' },
        program: { type: 'string' },
        http: { type: 'boolean', default: false },
        scope: { type: 'string', default: 'full' },
        host: { type: 'string', multiple: true },
        port: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: true,
    }));
  } catch (err) {
    io.stderr(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  if (values.help) { io.stdout(USAGE); return 0; }

  if (values.scope !== 'full' && values.scope !== 'knowledge') {
    io.stderr(`Unknown --scope "${values.scope}" — expected "full" or "knowledge".\n${USAGE}`);
    return 2;
  }

  // The knowledge-only surface exists only as an HTTP service. Without
  // --http the stdio branch below would open the FULL server — every
  // identity/memory/dossier tool — under a flag that asked for less
  // (PR #124 review). Refuse before any transport opens.
  if (values.scope === 'knowledge' && !values.http) {
    io.stderr(
      `--scope knowledge requires --http — the knowledge-only surface is HTTP-only; ` +
        `refusing to start the full stdio server instead.\n${USAGE}`,
    );
    return 2;
  }

  if (values.next || (values.http && values.scope === 'full')) {
    if (values.scope !== 'full') { io.stderr('--next cannot use --scope\n'); return 2; }
    if (values.staging || values['secret-authority'] || values['secret-holder'] || values['secret-writes']) {
      io.stderr('Configure shared service adapters in the prepared household program; legacy startup options are retired\n'); return 2;
    }
    if (process.env.LOOM_WORKER_SOCKET) { io.stderr('The legacy HTTP worker configuration needs the separate service cutover\n'); return 2; }
    const {startSharedHome}=await import('../shared-startup.js');
    const {resolve}=await import('node:path');
    const {homedir}=await import('node:os');
    const home=resolve(values.home??process.env.LOOM_HOME??`${homedir()}/.config/loom`);
    const hosts=values.host??(process.env.LOOM_HTTP_HOST??'127.0.0.1').split(',');
    const port=Number(values.port??process.env.LOOM_HTTP_PORT??8787);
    if(hosts.length!==1||!Number.isInteger(port)||port<0||port>65535){io.stderr('Choose one --host and a valid --port\n');return 2;}
    let handle:Awaited<ReturnType<typeof startSharedHome>>;
    try{handle=await startSharedHome({home,program:values.program,host:hosts[0],port,stdout:io.stdout,reportError:()=>io.stderr('loom: shared service error\n')});}
    catch{io.stderr('Shared startup refused. Supply a private program.json for an initialized shared household; existing homes require the separate move.\n');return 2;}
    io.stderr(`loom: shared app on ${handle.url}\n`);
    await new Promise<void>(done=>{
      const stop=()=>{process.off('SIGTERM',stop);process.off('SIGINT',stop);process.off('disconnect',stop);void handle.close().then(done,()=>{io.stderr('loom: shared cleanup failed\n');done();});};
      process.on('SIGTERM',stop);process.on('SIGINT',stop);if(process.connected)process.on('disconnect',stop);
    });
    return 0;
  }
  if(values.program||values.staging||values.home||values['secret-authority']||values['secret-holder']||values['secret-writes']){io.stderr('Shared program options require --http\n');return 2;}
  const contextDir = resolveContextDir();
  // Optional: gaps directory for recall-miss logging (LOOM_GAPS_DIR env var).
  // When set, knowledge_recall misses are appended to ${gapsDir}/recall-miss.jsonl
  // so the knowledge-mine script can surface them as expansion candidates.
  const gapsDir = process.env.LOOM_GAPS_DIR || undefined;

  const host = values.host ?? (process.env.LOOM_HTTP_HOST ?? '127.0.0.1').split(',');
  if (values.http && values.scope === 'knowledge') {
    const port = Number(values.port ?? process.env.LOOM_KNOWLEDGE_HTTP_PORT ?? 8788);
    const rawTokens = process.env.LOOM_KNOWLEDGE_BEARER_TOKENS ?? '';
    let tokens: Record<string, string>;
    try {
      tokens = parseIdentityTokens(rawTokens);
    } catch (err) {
      io.stderr(`${(err as Error).message}\n${USAGE}`);
      return 2;
    }
    if (Object.keys(tokens).length === 0) {
      io.stderr(
        `--scope knowledge requires LOOM_KNOWLEDGE_BEARER_TOKENS ` +
          `("identity:token,identity:token") — refusing to start unauthenticated.\n${USAGE}`,
      );
      return 2;
    }
    const handle = await startHttpServer({
      contextDir, host, port, tokens, gapsDir, createServer: createKnowledgeOnlyServer,
    });
    io.stderr(
      `loom: knowledge-only HTTP MCP daemon on http://${handle.hosts.join(',')}:${handle.port} ` +
        `(per-identity bearer: ${Object.keys(tokens).join(', ')})\n`,
    );
    await new Promise<void>(() => {});
    return 0;
  }

  const { server } = createLoomServer({ contextDir, gapsDir });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // connect() resolves when the stdio transport STARTS, not when it closes.
  // Returning here would let the CLI dispatcher process.exit(0) and kill the
  // server the instant it came up. Hold until the client hangs up.
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
  return 0;
}
