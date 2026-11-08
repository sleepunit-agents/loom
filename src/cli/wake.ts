/**
 * loom wake — prints agent identity markdown to stdout.
 */
import { parseArgs } from 'node:util';
import { loadIdentity } from '../tools/identity.js';
import { assertStackVersionCompatible } from '../config.js';
import { extractGlobalFlags, resolveEnv } from './args.js';
import type { IOStreams } from './io.js';

const USAGE = `Usage: loom wake [options]

Prints the agent's wake output (identity, preferences, self-model,
harness manifest, model manifest) to stdout.

Options:
  --project <name>       Load projects/<name>.md as additional context
  --context-dir <path>   Agent context dir
  --client <name>        Harness adapter hint
  --model <name>         Model manifest hint
  --help, -h             Show this help
`;

export async function run(argv: string[], io: IOStreams): Promise<number> {
  const { flags: global, rest } = extractGlobalFlags(argv);
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        project: { type: 'string' },
        help:    { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (err) {
    io.stderr(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  if (parsed.values.help) { io.stdout(USAGE); return 0; }

  const env = resolveEnv(global, io.env);
  try {
    assertStackVersionCompatible(env.contextDir);
  } catch (err) {
    io.stderr(`${(err as Error).message}\n`);
    return 1;
  }

  const md = await loadIdentity(
    env.contextDir,
    parsed.values.project,
    env.client,
    env.model,
  );
  io.stdout(md.endsWith('\n') ? md : md + '\n');
  return 0;
}
