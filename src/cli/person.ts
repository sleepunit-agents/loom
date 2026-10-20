/**
 * loom person — read person cards (docs/specs/person-cards.md).
 *
 *   loom person show <slug> [--include-archived] [--json]
 *   loom person list [--include-archived] [--json]
 *
 * Read-only: cards are written through the MCP tools. Exit codes for show:
 * 0 found, 3 no such card, 4 archived (without --include-archived), 1 error.
 * A bridge can splice `show` output into a prompt and treat any non-zero
 * exit as "no card".
 */
import { parseArgs } from 'node:util';
import { readPerson, listPeople } from '../tools/person.js';
import { assertStackVersionCompatible } from '../config.js';
import { extractGlobalFlags, resolveEnv } from './args.js';
import { renderJson } from './io.js';
import type { IOStreams } from './io.js';

const USAGE = `Usage: loom person <subcommand> [options]

Subcommands:
  show <slug>   Print the rendered card (or the person result with --json)
  list          List cards: slug, name, freshness counts, memories since synthesis

Options:
  --include-archived   Show/list archived cards too
  --json               Machine-readable output

Exit codes (show): 0 found, 3 no such card, 4 archived, 1 error.
`;

export async function run(argv: string[], io: IOStreams): Promise<number> {
  const { flags: global, rest } = extractGlobalFlags(argv);
  const sub = rest[0];
  if (!sub || sub === '--help' || sub === '-h') {
    io.stdout(USAGE);
    return sub ? 0 : 2;
  }
  if (sub !== 'show' && sub !== 'list') {
    io.stderr(`Unknown person subcommand: ${sub}\n${USAGE}`);
    return 2;
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: rest.slice(1),
      options: { 'include-archived': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
      allowPositionals: true,
    });
  } catch (err) {
    io.stderr(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  if (parsed.values.help) { io.stdout(USAGE); return 0; }

  const env = resolveEnv(global, io.env);
  try { assertStackVersionCompatible(env.contextDir); }
  catch (err) { io.stderr(`${(err as Error).message}\n`); return 1; }
  const includeArchived = Boolean(parsed.values['include-archived']);

  if (sub === 'list') {
    if (parsed.positionals.length) { io.stderr(`person list takes no arguments.\n${USAGE}`); return 2; }
    const entries = listPeople(env.contextDir, includeArchived);
    if (env.json) { renderJson(io, entries); return 0; }
    io.stdout(
      entries.length === 0
        ? 'no person cards\n'
        : entries
            .map(
              (e) =>
                `${e.slug}\t${e.name}${e.archived ? ' [archived]' : ''}\tupdated ${e.updated}\t` +
                `synthesized ${e.synthesized_at ?? 'never'}\tstale ${e.stale}\tunverified ${e.unverified}\t` +
                `memories since synthesis ${e.memories_since_synthesis}`,
            )
            .join('\n') + '\n',
    );
    return 0;
  }

  const slug = parsed.positionals[0];
  if (!slug || parsed.positionals.length > 1) { io.stderr(`person show takes one slug.\n${USAGE}`); return 2; }
  let result;
  try {
    result = readPerson(env.contextDir, slug, includeArchived);
  } catch (err) {
    io.stderr(`${(err as Error).message}\n`);
    return 1;
  }
  if (!result.found) {
    if (env.json) renderJson(io, result);
    else io.stderr(`no card for ${slug}\n`);
    return 3;
  }
  if (!('rendered' in result)) {
    if (env.json) renderJson(io, result);
    else io.stderr(`card for ${slug} is archived (pass --include-archived)\n`);
    return 4;
  }
  if (env.json) renderJson(io, result);
  else io.stdout(result.rendered + '\n');
  return 0;
}
