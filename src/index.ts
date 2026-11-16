#!/usr/bin/env node
/**
 * loom: one program, one data folder.
 *
 *   loom serve --home <dir> [--host <address>] [--port <number>] [--program <file>]
 *       Run the household's program. Environment: LOOM_HOME, LOOM_HTTP_HOST, LOOM_HTTP_PORT.
 *   loom mcp --url <origin> --token-file <file> [--agent <id>]
 *       A stdio MCP session that proxies the running program's door. It never
 *       opens the household's stores itself. Environment: LOOM_URL, LOOM_TOKEN_FILE.
 *
 * The older program that lived here (its own stdio server, command line and
 * web pages) is gone; `--next`, which used to select this one, is accepted and ignored.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createSharedStdioServer } from './shared-mcp-stdio.js';

const USAGE = `Usage:
  loom serve --home <dir> [--host <address>] [--port <number>] [--program <file>]
  loom mcp --url <origin> --token-file <file> [--agent <id>]
  loom --version
`;

/** Shared by the executable and in-process transport tests. */
export function createStdioServer(args: string[]) { return createSharedStdioServer(args); }

export function version(): string {
  return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
}

/** Where serve writes. Tests pass their own; the executable uses the process streams. */
export interface ServeIo { stdout(text: string): void; stderr(text: string): void }
const processIo: ServeIo = { stdout: text => { process.stdout.write(text); }, stderr: text => { process.stderr.write(text); } };

export async function serve(args: string[], io: ServeIo = processIo): Promise<number> {
  let values: { home?: string; host?: string; port?: string; program?: string };
  try {
    ({ values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
      next: { type: 'boolean' }, http: { type: 'boolean' },
      home: { type: 'string' }, host: { type: 'string' }, port: { type: 'string' }, program: { type: 'string' },
    } }));
  } catch (error) { io.stderr(`${error instanceof Error ? error.message : 'Bad arguments'}\n${USAGE}`); return 2; }
  const home = resolve(values.home ?? process.env.LOOM_HOME ?? `${homedir()}/.config/loom`);
  const host = values.host ?? process.env.LOOM_HTTP_HOST ?? '127.0.0.1';
  const port = Number(values.port ?? process.env.LOOM_HTTP_PORT ?? 8787);
  if (host.includes(',') || !Number.isInteger(port) || port < 0 || port > 65535) { io.stderr('Choose one --host and a valid --port\n'); return 2; }
  const { startSharedHome } = await import('./shared-startup.js');
  let handle: Awaited<ReturnType<typeof startSharedHome>>;
  try {
    handle = await startSharedHome({ home, program: values.program, host, port, stdout: io.stdout,
      reportError: () => { io.stderr('loom: service error\n'); } });
  } catch { io.stderr('Startup refused. Supply a private program.json for an initialized household.\n'); return 2; }
  io.stderr(`loom: shared app on ${handle.url}\n`);
  await new Promise<void>(done => {
    const stop = () => {
      process.off('SIGTERM', stop); process.off('SIGINT', stop); process.off('disconnect', stop);
      void handle.close().then(done, () => { io.stderr('loom: cleanup failed\n'); done(); });
    };
    process.on('SIGTERM', stop); process.on('SIGINT', stop); if (process.connected) process.on('disconnect', stop);
  });
  return 0;
}

async function main(): Promise<number | undefined> {
  const args = process.argv.slice(2), first = args[0];
  if (first === '--version' || first === '-V') { process.stdout.write(`loom v${version()}\n`); return 0; }
  if (first === undefined || first === '--help' || first === '-h') { process.stdout.write(USAGE); return first === undefined ? 2 : 0; }
  if (first === 'serve') return serve(args.slice(1));
  if (first === 'mcp' || first === '--next') {
    const { server } = createStdioServer(args);
    await server.connect(new StdioServerTransport());
    return undefined; // the session lives until stdin closes
  }
  process.stderr.write(`Unknown command: ${first}\n${USAGE}`);
  return 2;
}

/**
 * True when this module is the process entry point. `process.argv[1]` is the
 * path the shell invoked, which for a packaged install is a symlink in a bin
 * directory, while `import.meta.url` is the real file: resolve both.
 */
export function isEntryPoint(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  const self = fileURLToPath(import.meta.url);
  if (argv1 === self) return true;
  try { return realpathSync(argv1) === realpathSync(self); } catch { return false; }
}

if (isEntryPoint()) {
  main().then(code => { if (code !== undefined) process.stdout.write('', () => process.exit(code)); },
    error => { console.error('loom failed to start:', error); process.exit(1); });
}
