/**
 * loom serve — MCP startup. Default is stdio; `--http` starts the mesh-reachable
 * HTTP daemon (c-loom-transport) bound to a loopback/mesh interface with an
 * optional bearer token. Host/port/token come from flags or env:
 *   --http  --host <h>  --port <n>   (LOOM_HTTP_HOST, LOOM_HTTP_PORT, LOOM_BEARER_TOKEN)
 * Bind-safety refuses a public/0.0.0.0 host; Tailscale is the access control.
 */
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createLoomServer } from '../server.js';
import { startHttpServer } from '../transport/http-server.js';
import { resolveContextDir } from '../config.js';
import type { IOStreams } from './io.js';

const USAGE = `Usage: loom serve [options]

Start the MCP server. Default transport is stdio; --http starts the
mesh-reachable HTTP daemon instead.

Options:
  --http                 Serve over HTTP instead of stdio
  --host <h>             HTTP bind host (env LOOM_HTTP_HOST, default 127.0.0.1)
  --port <n>             HTTP port (env LOOM_HTTP_PORT, default 8787)
  --help, -h             Show this help

Bearer token comes from LOOM_BEARER_TOKEN. Bind-safety refuses a public host.
`;

export async function run(argv: string[], io: IOStreams): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        http: { type: 'boolean', default: false },
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

  const contextDir = resolveContextDir();
  // Optional: gaps directory for recall-miss logging (LOOM_GAPS_DIR env var).
  // When set, knowledge_recall misses are appended to ${gapsDir}/recall-miss.jsonl
  // so the knowledge-mine script can surface them as expansion candidates.
  const gapsDir = process.env.LOOM_GAPS_DIR || undefined;

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
