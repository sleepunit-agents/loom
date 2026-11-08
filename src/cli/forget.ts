/**
 * loom forget — remove memories by ref, category+title, or title pattern.
 */
import { parseArgs } from 'node:util';
import { forget } from '../tools/forget.js';
import { createBackend } from '../backends/index.js';
import { assertStackVersionCompatible } from '../config.js';
import { extractGlobalFlags, resolveEnv } from './args.js';
import { renderJson } from './io.js';
import type { IOStreams } from './io.js';
import type { ForgetInput } from '../backends/types.js';

const USAGE = `Usage:
  loom forget <ref>
  loom forget --category <cat> --title <exact>
  loom forget --title-pattern <glob> (--category <cat> | --project <name>)

Options:
  --confirm              Required for scope deletion (category/project/pattern
                         without an exact target). Without it, prints a preview
                         of what would be deleted and deletes nothing.
  --json                 Emit ForgetResult
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
        category:        { type: 'string' },
        title:           { type: 'string' },
        project:         { type: 'string' },
        'title-pattern': { type: 'string' },
        confirm:         { type: 'boolean' },
        help:            { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (err) {
    io.stderr(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  if (parsed.values.help) { io.stdout(USAGE); return 0; }

  const input: ForgetInput = {
    ref:           parsed.positionals[0],
    category:      parsed.values.category,
    title:         parsed.values.title,
    project:       parsed.values.project,
    title_pattern: parsed.values['title-pattern'],
  };
  const confirm = parsed.values.confirm === true;
  const isSingleTarget = Boolean(input.ref) || Boolean(input.category && input.title);

  if (input.title_pattern && !input.category && !input.project) {
    io.stderr(`--title-pattern requires --category or --project as a scope guard.\n`);
    return 2;
  }
  const hasAny = input.ref || input.category || input.project || input.title_pattern;
  if (!hasAny) {
    io.stderr(`Nothing to forget.\n${USAGE}`);
    return 2;
  }

  const env = resolveEnv(global, io.env);
  try { assertStackVersionCompatible(env.contextDir); }
  catch (err) { io.stderr(`${(err as Error).message}\n`); return 1; }

  // Scope deletion ceremony holds at every surface (store-convergence
  // §"One guard grammar") — the --json fast path must not bypass the gate.
  if (!isSingleTarget && !confirm) {
    const preview = await forget(env.contextDir, { ...input, confirm: false });
    if (env.json) {
      renderJson(io, { deleted: [], preview, confirmRequired: true });
    } else {
      io.stdout(preview.endsWith('\n') ? preview : preview + '\n');
      io.stdout('Re-run with --confirm to delete.\n');
    }
    return 2;
  }

  if (env.json) {
    const backend = createBackend(env.contextDir);
    const result = await backend.forget(input);
    renderJson(io, result);
    return result.deleted.length === 0 ? 3 : 0;
  }

  const text = await forget(env.contextDir, { ...input, confirm });
  io.stdout(text.endsWith('\n') ? text : text + '\n');
  return /not found|No memories matched/i.test(text) ? 3 : 0;
}
