/**
 * POST /cli — the server half of the CLI's remote mode (src/cli/remote.ts,
 * t-1472).
 *
 * Runs the real CLI in-process against THIS server's stack, with captured
 * streams, and returns what it printed and its exit code. It sits behind the
 * same bearer gate and payload cap as /mcp, and grants nothing /mcp doesn't:
 *
 *   - only REMOTE_VERBS (the store verbs, all of which have MCP tools),
 *     minus the memory subcommands that have none
 *   - never --context-dir or --url: the stack is the server's, full stop
 *   - a fixed env: the server's HOME and stack, plus the caller's
 *     LOOM_CLIENT / LOOM_MODEL hints and nothing else
 *   - stdin is never a TTY here, so no verb can reach $EDITOR server-side
 */
import { Readable } from 'node:stream';
import { runCli } from '../cli/index.js';
import { extractGlobalFlags, firstNonGlobalIndex } from '../cli/args.js';
import { LOCAL_MEMORY_SUBCOMMANDS, REMOTE_VERBS, type CliRequest, type CliResponse } from '../cli/remote.js';
import type { IOStreams } from '../cli/io.js';

const MAX_ARGV = 256;

export type CliOutcome =
  | { ok: true; response: CliResponse }
  | { ok: false; error: string };

function isStringRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validate a POST /cli body; returns the request or why it's refused. */
export function parseCliRequest(body: unknown): CliRequest | string {
  if (!isStringRecord(body)) return 'bad-input: expected a JSON object';
  const { argv, stdin, env } = body;
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > MAX_ARGV || !argv.every((a) => typeof a === 'string')) {
    return `bad-input: argv must be 1..${MAX_ARGV} strings`;
  }
  if (stdin !== undefined && typeof stdin !== 'string') return 'bad-input: stdin must be a string';
  let hints: CliRequest['env'];
  if (env !== undefined) {
    if (!isStringRecord(env)) return 'bad-input: env must be an object';
    hints = {};
    for (const [k, v] of Object.entries(env)) {
      if (k !== 'LOOM_CLIENT' && k !== 'LOOM_MODEL') return `refused: env may only carry LOOM_CLIENT and LOOM_MODEL, not ${k}`;
      if (typeof v !== 'string') return `bad-input: env.${k} must be a string`;
      hints[k] = v;
    }
  }
  const args = argv as string[];
  if (args.some((a) => a === '--context-dir' || a.startsWith('--context-dir=') || a === '--url' || a.startsWith('--url='))) {
    return 'refused: --context-dir and --url name a stack; this server only serves its own';
  }
  const verbIdx = firstNonGlobalIndex(args);
  const verb = args[verbIdx];
  if (verb === undefined || !REMOTE_VERBS.has(verb)) {
    return `refused: ${verb ?? '(no verb)'} doesn't run remotely; remote verbs are ${[...REMOTE_VERBS].join(', ')}`;
  }
  if (verb === 'memory') {
    // memory.ts dispatches on its first token after the globals are pulled out.
    const after = [...args.slice(0, verbIdx), ...args.slice(verbIdx + 1)];
    const sub = extractGlobalFlags(after).rest[0];
    if (sub !== undefined && LOCAL_MEMORY_SUBCOMMANDS.has(sub)) {
      return `refused: memory ${sub} has no MCP tool, so it doesn't run remotely`;
    }
  }
  return { argv: args, stdin: stdin as string | undefined, env: hints };
}

/** Run a validated request's argv against `contextDir`. */
export async function runCliRequest(contextDir: string, request: CliRequest): Promise<CliResponse> {
  let stdout = '';
  let stderr = '';
  const env: NodeJS.ProcessEnv = { LOOM_CONTEXT_DIR: contextDir, ...request.env };
  if (process.env.HOME) env.HOME = process.env.HOME;
  const io: IOStreams = {
    stdout: (s) => { stdout += s; },
    stderr: (s) => { stderr += s; },
    stdin: Readable.from([request.stdin ?? '']),
    stdinIsTTY: false,
    env,
  };
  let exitCode: number;
  try {
    exitCode = await runCli(request.argv, io);
  } catch (err) {
    // The local CLI would crash with a stack trace; a remote one gets the message and exit 1.
    stderr += `${(err as Error).message}\n`;
    exitCode = 1;
  }
  return { exitCode, stdout, stderr };
}

export async function handleCliBody(contextDir: string, body: unknown): Promise<CliOutcome> {
  const request = parseCliRequest(body);
  if (typeof request === 'string') return { ok: false, error: request };
  return { ok: true, response: await runCliRequest(contextDir, request) };
}
