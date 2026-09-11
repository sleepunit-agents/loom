#!/usr/bin/env node
/**
 * Loom — CLI + stdio MCP entry point.
 *
 * When the first non-global token is a known CLI subcommand or
 * --help/--version, routes to src/cli/index.ts. Otherwise (or if argv is
 * empty / only flags), falls through to the MCP stdio server so existing
 * .mcp.json configs keep working.
 *
 * "First non-global token", not argv[2]: --context-dir and friends are
 * documented as global flags, so `loom --context-dir DIR knowledge write`
 * has to reach the CLI. Routing on argv[2] alone sent it to the stdio
 * server instead, which read an empty stdin and exited 0 — a write verb
 * reporting success having never entered the write path (t-665).
 *
 * Configure via environment variables:
 *   LOOM_CONTEXT_DIR         — path to identity/memory directory (required)
 *   LOOM_SQLITE_DB_PATH      — override memories.db location (optional)
 *   LOOM_FASTEMBED_MODEL     — embedding model (default fast-bge-small-en-v1.5)
 *   LOOM_FASTEMBED_CACHE_DIR — ONNX cache (default ~/.cache/loom/fastembed)
 *   LOOM_CLIENT              — runtime client adapter name (optional)
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createLoomServer } from './server.js';
import { resolveContextDir } from './config.js';
import { SUBCOMMANDS } from './cli/subcommands.js';
import { firstNonGlobalIndex } from './cli/args.js';

const CLI_KEYWORDS: ReadonlySet<string> = new Set(SUBCOMMANDS);

function isCliInvocation(argv: string[]): boolean {
  const args = argv.slice(2);
  const first = args[firstNonGlobalIndex(args)];
  if (first === undefined) return false;
  if (first === '--help' || first === '-h') return true;
  if (first === '--version' || first === '-V') return true;
  return CLI_KEYWORDS.has(first);
}

export { isCliInvocation };

async function main() {
  if (isCliInvocation(process.argv)) {
    const { runCli } = await import('./cli/index.js');
    process.exit(await runCli(process.argv.slice(2)));
  }
  const contextDir = resolveContextDir();
  const { server } = createLoomServer({ contextDir });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * True when this module is the process entry point.
 *
 * `process.argv[1]` is whatever path the shell invoked, which for every
 * packaged install (`npm i -g`, `npm link`, `npx`) is a SYMLINK in a bin
 * directory, while `import.meta.url` always resolves to the real file. A
 * raw string compare is false in exactly those cases, so `main()` never
 * runs: no CLI dispatch, no MCP server, exit 0 with no output. Resolve
 * both sides before comparing.
 */
function isEntryPoint(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  const self = fileURLToPath(import.meta.url);
  if (argv1 === self) return true;
  try {
    return realpathSync(argv1) === realpathSync(self);
  } catch {
    return false;
  }
}

export { isEntryPoint };

if (isEntryPoint()) {
  main().catch((err) => {
    console.error('Loom failed to start:', err);
    process.exit(1);
  });
}
