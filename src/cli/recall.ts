/**
 * loom recall — semantic memory search.
 */
import { parseArgs } from 'node:util';
import { recall } from '../tools/recall.js';
import { createBackend } from '../backends/index.js';
import { assertStackVersionCompatible } from '../config.js';
import { extractGlobalFlags, resolveEnv } from './args.js';
import { renderJson } from './io.js';
import type { IOStreams } from './io.js';

const USAGE = `Usage: loom recall <query> [options]

Search memories semantically.

Options:
  --category <name>      Filter by category
  --project <name>       Scope to a project — excludes other projects' project-scoped
                          memories (t-337); global-scoped memories still come through
  --limit <n>            Max results (default backend-specific)
  --diversity <f>        MMR diversity 0..1 (default 0.3); 0 = pure relevance order
  --json                 Emit MemoryMatch[] as JSON
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
        category: { type: 'string' },
        project:  { type: 'string' },
        limit:     { type: 'string' },
        diversity: { type: 'string' },
        help:      { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (err) {
    io.stderr(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  if (parsed.values.help) { io.stdout(USAGE); return 0; }

  const query = parsed.positionals[0];
  if (!query) { io.stderr(`Missing query.\n${USAGE}`); return 2; }

  const env = resolveEnv(global, io.env);
  try { assertStackVersionCompatible(env.contextDir); }
  catch (err) { io.stderr(`${(err as Error).message}\n`); return 1; }

  const limit = parsed.values.limit !== undefined
    ? Number.parseInt(parsed.values.limit, 10)
    : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    io.stderr(`--limit must be a positive integer.\n`);
    return 2;
  }

  const diversity = parsed.values.diversity !== undefined
    ? Number.parseFloat(parsed.values.diversity)
    : undefined;
  if (diversity !== undefined && (Number.isNaN(diversity) || diversity < 0 || diversity > 1)) {
    io.stderr(`--diversity must be between 0 and 1.\n`);
    return 2;
  }

  const input = {
    query,
    category: parsed.values.category,
    project:  parsed.values.project,
    limit,
    diversity,
  };

  if (env.json) {
    const backend = createBackend(env.contextDir);
    const matches = await backend.recall(input);
    renderJson(io, matches);
    return 0;
  }
  const text = await recall(env.contextDir, input);
  io.stdout(text.endsWith('\n') ? text : text + '\n');
  return 0;
}
