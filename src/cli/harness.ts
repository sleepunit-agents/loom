/**
/**
 * loom harness — manifest lifecycle for harness adapters.
 *
 * The only subcommand is `init`: writes a manifest template to
 * <contextDir>/harnesses/<name>.md. Reading is implicit — identity()
 * already composes the manifest from disk.
 */
import { parseArgs } from 'node:util';
import { assertStackVersionCompatible } from '../config.js';
import { extractGlobalFlags, resolveEnv } from './args.js';
import { renderJson } from './io.js';
import type { IOStreams } from './io.js';
import { initHarness } from '../blocks/harness.js';

const USAGE = `Usage: loom harness <subcommand> [options]

Subcommands:
  init [<name>]    Write a manifest template for <name>

Options (init):
  --force          Overwrite existing manifest
  --json           Emit InitResult as JSON

<name> falls back to --client, then $LOOM_CLIENT.

Global: --context-dir, --client, --json, --help
`;

export async function run(argv: string[], io: IOStreams): Promise<number> {
  const { flags: global, rest } = extractGlobalFlags(argv);
  const sub = rest[0];
  const subRest = rest.slice(1);

  if (!sub || sub === '--help' || sub === '-h') {
    io.stdout(USAGE);
    return sub ? 0 : 2;
  }
  if (sub !== 'init') {
    io.stderr(`Unknown harness subcommand: ${sub}\n${USAGE}`);
    return 2;
  }

  let parsed;
  try {
    parsed = parseArgs({
      args: subRest,
      options: {
        force: { type: 'boolean' },
        help:  { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (err) {
    io.stderr(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  if (parsed.values.help) { io.stdout(USAGE); return 0; }

  // After the flags (t-1950): checking the stack's version stamps a fresh context dir, so --help came first.
  const env = resolveEnv(global, io.env);
  try { assertStackVersionCompatible(env.contextDir); }
  catch (err) { io.stderr(`${(err as Error).message}\n`); return 1; }

  const name = parsed.positionals[0] ?? env.client;
  if (!name) {
    io.stderr(
      'loom harness init: <name> required (or pass --client / set $LOOM_CLIENT)\n',
    );
    return 2;
  }

  try {
    const result = await initHarness(env.contextDir, name, {
      overwrite: parsed.values.force === true,
    });
    if (env.json) { renderJson(io, result); return 0; }
    io.stdout(`${result.name}: ${result.path} (${result.action})\n`);
    return 0;
  } catch (err) {
    if ((err as Error).message.startsWith('Invalid harness name')) {
      io.stderr(`${(err as Error).message}\n`);
      return 2;
    }
    io.stderr(`loom harness init: ${(err as Error).message}\n`);
    return 1;
  }
}
