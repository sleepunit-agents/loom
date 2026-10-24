/**
 * Remote mode — run a CLI verb against a loom-http server instead of a
 * local stack (t-1472).
 *
 * A body whose loom lives elsewhere (a container, another host) still has
 * hooks and scripts that shell out to `loom recall`, `loom remember --json`,
 * `loom person show`. With `--url` or LOOM_URL set, those verbs ship their
 * argv (and stdin body) to loom-http's POST /cli, which runs the SAME CLI
 * server-side against its own stack and returns stdout, stderr and the exit
 * code. Output, --json shapes and exit codes match the local CLI by
 * construction, not by a second implementation that could drift.
 *
 * The server's half is src/transport/cli-endpoint.ts. Only REMOTE_VERBS
 * travel: the ones that read or write the stores, every one of which the
 * MCP tools already expose under the same bearer token, so /cli grants
 * nothing /mcp doesn't. Verbs about the local machine (inject, install,
 * doctor, serve, bootstrap, migrate, harness, update-identity) always run
 * locally.
 *
 * The bearer token comes from a file (LOOM_TOKEN_FILE), never argv, so it
 * stays out of `ps` and shell history.
 */
import { readFile } from 'node:fs/promises';
import { readBody } from './io.js';
import type { IOStreams } from './io.js';

export const REMOTE_VERBS: ReadonlySet<string> = new Set([
  'wake', 'recall', 'remember', 'update', 'forget', 'memory', 'knowledge', 'person',
]);

/** POST /cli request body. */
export interface CliRequest {
  argv: string[];
  /** The body for verbs that read one (remember, update). */
  stdin?: string;
  /** Harness hints only; the server owns everything else in its env. */
  env?: { LOOM_CLIENT?: string; LOOM_MODEL?: string };
}

/** POST /cli 200 response body. */
export interface CliResponse {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const REMOTE_TIMEOUT_MS = 300_000;

/** `argv` with every `--url <value>` pair removed. */
function withoutUrl(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url') { i++; continue; }
    out.push(argv[i]);
  }
  return out;
}

/**
 * Whether the local CLI would read a body for this call. Mirrors the verbs'
 * own rules (remember always; update unless --observation; neither under
 * --help). Reading stdin for any other verb would hang a caller whose stdin
 * is an open pipe it never writes to.
 */
function readsBody(sub: string, argv: string[]): boolean {
  if (argv.includes('--help') || argv.includes('-h')) return false;
  if (sub === 'remember') return true;
  if (sub === 'update') return !argv.some((a) => a === '--observation' || a.startsWith('--observation='));
  return false;
}

/** The /cli endpoint next to the MCP URL: http://h:8787/mcp → http://h:8787/cli. */
export function cliEndpoint(url: string): URL {
  return new URL('cli', url);
}

/**
 * Run `sub` with `rest` (the argv minus the subcommand token, globals
 * included) on the loom-http at `url`.
 */
export async function runRemote(
  sub: string,
  rest: string[],
  url: string,
  io: IOStreams,
): Promise<number> {
  const args = withoutUrl(rest);
  if (args.some((a) => a === '--context-dir' || a.startsWith('--context-dir='))) {
    io.stderr(
      `loom: --context-dir names a local stack, but this call goes to ${url}. ` +
      `Drop --url / unset LOOM_URL to use the local one.\n`,
    );
    return 2;
  }

  let endpoint: URL;
  try { endpoint = cliEndpoint(url); }
  catch { io.stderr(`loom: not a URL: ${url}\n`); return 2; }

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const tokenFile = io.env.LOOM_TOKEN_FILE;
  if (tokenFile) {
    let token: string;
    try { token = (await readFile(tokenFile, 'utf-8')).trim(); }
    catch (err) { io.stderr(`loom: can't read LOOM_TOKEN_FILE: ${(err as Error).message}\n`); return 1; }
    headers.authorization = `Bearer ${token}`;
  }

  const request: CliRequest = { argv: [sub, ...args] };
  if (readsBody(sub, args)) {
    // Local stdin or the local $EDITOR: an editor can't run over the wire.
    try { request.stdin = await readBody(io, sub); }
    catch (err) { io.stderr(`${(err as Error).message}\n`); return 1; }
  }
  const hints: CliRequest['env'] = {};
  if (io.env.LOOM_CLIENT) hints.LOOM_CLIENT = io.env.LOOM_CLIENT;
  if (io.env.LOOM_MODEL) hints.LOOM_MODEL = io.env.LOOM_MODEL;
  if (Object.keys(hints).length) request.env = hints;

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
    });
  } catch (err) {
    const cause = (err as { cause?: { message?: string } }).cause?.message;
    io.stderr(`loom: can't reach ${endpoint}: ${cause ?? (err as Error).message}\n`);
    return 1;
  }

  const text = await res.text();
  if (res.status !== 200) {
    let message = text;
    try { message = (JSON.parse(text) as { error?: string }).error ?? text; } catch { /* not JSON */ }
    if (res.status === 404) message = `no CLI endpoint at ${endpoint} (an older loom-http, or a knowledge-only server)`;
    io.stderr(`loom: ${endpoint} answered ${res.status}: ${message}\n`);
    return res.status === 400 ? 2 : 1;
  }

  let out: CliResponse;
  try { out = JSON.parse(text) as CliResponse; }
  catch { io.stderr(`loom: ${endpoint} sent a response that isn't JSON\n`); return 1; }
  io.stdout(out.stdout);
  io.stderr(out.stderr);
  return out.exitCode;
}
