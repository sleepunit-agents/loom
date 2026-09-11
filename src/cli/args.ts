/**
 * Shared argv helpers — global flag resolution + context-dir/env
 * precedence. Individual commands parse their own subcommand flags
 * via node:util parseArgs.
 */
import { resolve } from 'node:path';
import { resolveDefaultContextPath } from '../config.js';

export interface ResolvedEnv {
  contextDir: string;
  client?: string;
  model?: string;
  json: boolean;
}

export interface RawGlobalFlags {
  contextDir?: string;
  client?: string;
  model?: string;
  json?: boolean;
}

export function resolveEnv(
  flags: RawGlobalFlags,
  processEnv: NodeJS.ProcessEnv,
): ResolvedEnv {
  const contextDir =
    flags.contextDir ??
    processEnv.LOOM_CONTEXT_DIR ??
    resolveDefaultContextPath(processEnv.HOME);
  return {
    contextDir: resolve(contextDir),
    client: flags.client ?? processEnv.LOOM_CLIENT,
    model: flags.model ?? processEnv.LOOM_MODEL,
    json: Boolean(flags.json),
  };
}

/**
 * Global flags that consume the NEXT argv token as their value. Shared by
 * `extractGlobalFlags` and `firstNonGlobalIndex` so the two cannot drift:
 * a flag that takes a value must be skipped in pairs when we are looking
 * past the globals for a subcommand, or `--context-dir recall` reads as an
 * invocation of `recall`.
 */
const VALUED_GLOBAL_FLAGS: ReadonlySet<string> = new Set([
  '--context-dir', '--client', '--model',
]);

/** Global flags that stand alone. */
const BARE_GLOBAL_FLAGS: ReadonlySet<string> = new Set(['--json']);

/**
 * Index of the first token in `argv` that is neither a leading global flag
 * nor a global flag's value — i.e. where the subcommand is, if there is
 * one. Returns `argv.length` when argv holds nothing but globals.
 *
 * The help text calls --context-dir/--client/--model/--json GLOBAL, which
 * has to mean they are accepted before the subcommand as well as after.
 * Both entry points resolve the subcommand through this so that promise
 * holds: src/index.ts to decide CLI-vs-MCP, runCli to dispatch. Scanning
 * only over *leading* globals (rather than searching all of argv for a
 * known verb) is what keeps a flag's value from being mistaken for one.
 */
export function firstNonGlobalIndex(argv: string[]): number {
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (VALUED_GLOBAL_FLAGS.has(a)) { i += 2; continue; }
    if (BARE_GLOBAL_FLAGS.has(a))   { i += 1; continue; }
    return i;
  }
  return argv.length;
}

/**
 * Extracts global flags from an argv slice, returning the remaining argv.
 * Recognizes: --context-dir, --client, --model, --json — in any position.
 */
export function extractGlobalFlags(argv: string[]): {
  flags: RawGlobalFlags;
  rest: string[];
} {
  const flags: RawGlobalFlags = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--context-dir') { flags.contextDir = argv[++i]; continue; }
    if (a === '--client')      { flags.client     = argv[++i]; continue; }
    if (a === '--model')       { flags.model      = argv[++i]; continue; }
    if (a === '--json')        { flags.json = true;            continue; }
    rest.push(a);
  }
  return { flags, rest };
}
