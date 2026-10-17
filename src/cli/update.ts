/**
 * loom update — modify an existing memory.
 */
import { parseArgs } from 'node:util';
import { update } from '../tools/update.js';
import { createBackend } from '../backends/index.js';
import { assertStackVersionCompatible } from '../config.js';
import { extractGlobalFlags, resolveEnv } from './args.js';
import { readBody, renderJson } from './io.js';
import type { IOStreams } from './io.js';
import type { UpdateInput } from '../backends/types.js';

const USAGE = `Usage: loom update <ref> [options]
       loom update --category <cat> --title <exact> [options]

Updates content (from stdin or \$EDITOR) and/or metadata on an existing
memory. --confirm/--contradict record an observation against a feedback
memory's confidence instead — no body required for those.

Options:
  --category <name>      Identify by category (with --title)
  --title <exact>        Identify by title (with --category)
  --confirm               Feedback memories only: raise confidence (+0.05)
  --contradict            Feedback memories only: lower confidence (-0.1)
  --json                 Emit UpdateResult
  --context-dir <path>   Agent context dir
  --help, -h             Show this help
`;

export async function run(argv: string[], io: IOStreams): Promise<number> {
  const { flags: global, rest } = extractGlobalFlags(argv);
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        category:   { type: 'string' },
        title:      { type: 'string' },
        confirm:    { type: 'boolean' },
        contradict: { type: 'boolean' },
        help:       { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (err) {
    io.stderr(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  if (parsed.values.help) { io.stdout(USAGE); return 0; }

  const ref = parsed.positionals[0];
  const hasIdentifier = ref || (parsed.values.category && parsed.values.title);
  if (!hasIdentifier) {
    io.stderr(`Provide a <ref> or --category+--title.\n${USAGE}`);
    return 2;
  }
  if (parsed.values.confirm && parsed.values.contradict) {
    io.stderr(`--confirm and --contradict are mutually exclusive.\n${USAGE}`);
    return 2;
  }
  const observation = parsed.values.confirm
    ? 'confirm' as const
    : parsed.values.contradict
      ? 'contradict' as const
      : undefined;

  const env = resolveEnv(global, io.env);
  try { assertStackVersionCompatible(env.contextDir); }
  catch (err) { io.stderr(`${(err as Error).message}\n`); return 1; }

  // A pure observation needs no new body — --confirm/--contradict alone is a
  // complete update. Any other call still requires one (existing behavior).
  let body: string | undefined;
  if (!observation) {
    try {
      body = await readBody(io, 'update');
    } catch (err) {
      io.stderr(`${(err as Error).message}\n`);
      return 1;
    }
    if (!body) { io.stderr(`body cannot be empty\n`); return 2; }
  }

  const input: UpdateInput = {
    ref,
    category: parsed.values.category,
    title:    parsed.values.title,
    content:  body,
    observation,
  };

  if (env.json) {
    const backend = createBackend(env.contextDir);
    const result = await backend.update(input);
    renderJson(io, result);
    return result.updated ? 0 : 3;
  }
  const text = await update(env.contextDir, input);
  io.stdout(text.endsWith('\n') ? text : text + '\n');
  return /not found/i.test(text) ? 3 : 0;
}
