/**
 * loom serve — MCP startup. Default is stdio; `--http` starts the mesh-reachable
 * HTTP daemon (c-loom-transport) bound to a loopback/mesh interface with an
 * optional bearer token. Host/port/token come from flags or env:
 *   --http  --host <h>  --port <n>   (LOOM_HTTP_HOST, LOOM_HTTP_PORT, LOOM_BEARER_TOKEN)
 * Bind-safety refuses a public/0.0.0.0 host; Tailscale is the access control.
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
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createLoomServer } from '../server.js';
import { createKnowledgeOnlyServer } from '../transport/knowledge-server.js';
import { startHttpServer } from '../transport/http-server.js';
import { resolveContextDir } from '../config.js';
import type { IOStreams } from './io.js';

const USAGE = `Usage: loom serve [options]

Start the MCP server. Default transport is stdio; --http starts the
mesh-reachable HTTP daemon instead.

Options:
  --http                 Serve over HTTP instead of stdio
  --scope <full|knowledge>  Tool surface for --http (default full)
  --host <h>             HTTP bind host (env LOOM_HTTP_HOST, default 127.0.0.1)
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
        http: { type: 'boolean', default: false },
        scope: { type: 'string', default: 'full' },
        host: { type: 'string' },
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

  const contextDir = resolveContextDir();
  // Optional: gaps directory for recall-miss logging (LOOM_GAPS_DIR env var).
  // When set, knowledge_recall misses are appended to ${gapsDir}/recall-miss.jsonl
  // so the knowledge-mine script can surface them as expansion candidates.
  const gapsDir = process.env.LOOM_GAPS_DIR || undefined;

  if (values.http && values.scope === 'knowledge') {
    const host = values.host ?? process.env.LOOM_HTTP_HOST ?? '127.0.0.1';
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
      `loom: knowledge-only HTTP MCP daemon on http://${handle.host}:${handle.port} ` +
        `(per-identity bearer: ${Object.keys(tokens).join(', ')})\n`,
    );
    await new Promise<void>(() => {});
    return 0;
  }

  if (values.http) {
    const host = values.host ?? process.env.LOOM_HTTP_HOST ?? '127.0.0.1';
    const port = Number(values.port ?? process.env.LOOM_HTTP_PORT ?? 8787);
    const token = process.env.LOOM_BEARER_TOKEN || undefined;
    const handle = await startHttpServer({ contextDir, host, port, token, gapsDir });
    io.stderr(
      `loom: HTTP MCP daemon on http://${handle.host}:${handle.port} ` +
        `(${token ? 'bearer-gated' : 'open — network is the boundary'})\n`,
    );
    // Hold open until the process is signalled.
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
