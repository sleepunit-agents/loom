/**
 * loom remember — save a new memory. Body from stdin or $EDITOR.
 */
import { parseArgs } from 'node:util';
import { remember } from '../tools/remember.js';
import { MEMORY_CATEGORIES, isMemoryCategory } from '../categories.js';
import { assertStackVersionCompatible } from '../config.js';
import { extractGlobalFlags, resolveEnv } from './args.js';
import { readBody, renderJson } from './io.js';
import type { IOStreams } from './io.js';

const USAGE = `Usage: loom remember <title> [options]

Body is read from stdin (when piped) or $EDITOR (when interactive).

Options:
  --category <name>      Category: user|project|self|feedback|reference|pursuit (default: reference)
  --project <name>       Project tag
  --scope <project|global>  Override recall visibility (default: category default — see
                          backends/scope.ts; "global" for a fact that applies regardless
                          of which project it was learned on)
  --ttl <dur>            TTL like "7d", "30d", or "permanent"
  --refs <csv>           Comma-separated reference refs stored in metadata
  --meta <json>          JSON object merged into metadata (e.g. '{"where":"voice"}')
  --json                 Emit MemoryRef
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
        scope:    { type: 'string' },
        ttl:      { type: 'string' },
        refs:     { type: 'string' },
        meta:     { type: 'string' },
        help:     { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (err) {
    io.stderr(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  if (parsed.values.help) { io.stdout(USAGE); return 0; }

  const title = parsed.positionals[0];
  if (!title) { io.stderr(`Missing title.\n${USAGE}`); return 2; }

  const category = parsed.values.category ?? 'reference';
  if (!isMemoryCategory(category)) {
    io.stderr(`Unknown category "${category}". Valid categories: ${MEMORY_CATEGORIES.join(', ')}.\n`);
    return 2;
  }

  const scope = parsed.values.scope;
  if (scope !== undefined && scope !== 'project' && scope !== 'global') {
    io.stderr(`--scope must be "project" or "global".\n`);
    return 2;
  }

  const env = resolveEnv(global, io.env);
  try { assertStackVersionCompatible(env.contextDir); }
  catch (err) { io.stderr(`${(err as Error).message}\n`); return 1; }

  let body: string;
  try {
    body = await readBody(io, 'remember');
  } catch (err) {
    io.stderr(`${(err as Error).message}\n`);
    return 1;
  }
  if (!body) { io.stderr(`body cannot be empty\n`); return 2; }

  const refsList = parsed.values.refs
    ? parsed.values.refs.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;

  let meta: Record<string, unknown> | undefined;
  if (parsed.values.meta) {
    try {
      const parsedMeta: unknown = JSON.parse(parsed.values.meta);
      if (!parsedMeta || typeof parsedMeta !== 'object' || Array.isArray(parsedMeta)) throw new Error('not an object');
      meta = parsedMeta as Record<string, unknown>;
    } catch (err) {
      io.stderr(`--meta must be a JSON object: ${(err as Error).message}\n`);
      return 2;
    }
  }
  const metadata = refsList || meta ? { ...(meta ?? {}), ...(refsList ? { refs: refsList } : {}) } : undefined;

  const ref = await remember(env.contextDir, {
    category,
    title,
    content: body,
    project:  parsed.values.project,
    scope,
    ttl:      parsed.values.ttl,
    metadata,
  });

  if (env.json) { renderJson(io, ref); return 0; }
  io.stdout(`Remembered: ${ref.ref} — ${ref.title}\n`);
  return 0;
}
