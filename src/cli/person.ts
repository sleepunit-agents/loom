/**
 * loom person — read person cards (docs/specs/person-cards.md).
 *
 *   loom person show <slug> [--include-archived] [--json]
 *   loom person list [--include-archived] [--json]
 *   loom person reach <slug> <field> <id> --label <name> [--source <s>] [--at <iso>]
 *
 * Cards are written through the MCP tools, with one exception: `reach` files where
 * someone was just seen (a bridge heard them speak as <id> on <field>, named <name>)
 * on a card that already exists, and nothing else: the id joins the field's value,
 * its label and check time are set. Name, summary, how and may are out of its reach. Exit codes for show:
 * 0 found, 3 no such card, 4 archived (without --include-archived), 1 error.
 * A bridge can splice `show` output into a prompt and treat any non-zero
 * exit as "no card".
 */
import { parseArgs } from 'node:util';
import { readPerson, listPeople, personEvidence, personWrite } from '../tools/person.js';
import { assertStackVersionCompatible } from '../config.js';
import { extractGlobalFlags, resolveEnv } from './args.js';
import { renderJson } from './io.js';
import type { IOStreams } from './io.js';

const USAGE = `Usage: loom person <subcommand> [options]

Subcommands:
  show <slug>   Print the rendered card (or the person result with --json)
  list          List cards: slug, name, freshness counts, memories since synthesis
  evidence <slug> [--since <iso>]
                The memories the card condenses: active, unexpired user and
                feedback memories tagged to the person, oldest first
  reach <slug> <field> <id> --label <name> [--source <s>] [--at <iso>]
                File where someone was seen: <id> joins where.<field>, with the
                name the service shows and the time it was seen. Only on a card
                that exists (exit 3 otherwise); nothing else on it changes

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
  if (sub !== 'show' && sub !== 'list' && sub !== 'evidence' && sub !== 'reach') {
    io.stderr(`Unknown person subcommand: ${sub}\n${USAGE}`);
    return 2;
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: rest.slice(1),
      options: { 'include-archived': { type: 'boolean' }, since: { type: 'string' }, help: { type: 'boolean', short: 'h' },
        label: { type: 'string' }, source: { type: 'string' }, at: { type: 'string' } },
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

  if (sub === 'evidence') {
    const slug = parsed.positionals[0];
    if (!slug || parsed.positionals.length > 1) { io.stderr(`person evidence takes one slug.\n${USAGE}`); return 2; }
    const since = parsed.values.since ?? null;
    if (since !== null && Number.isNaN(Date.parse(since))) { io.stderr(`--since takes an ISO time.\n`); return 2; }
    const rows = personEvidence(env.contextDir, slug, since);
    if (env.json) { renderJson(io, rows); return 0; }
    io.stdout(rows.map((r) => `## ${r.title}\n*${r.category} — ${r.created.slice(0, 10)}*\n\n${r.content}\n`).join('\n'));
    io.stderr(`(${rows.length} memories tagged ${slug})\n`);
    return 0;
  }

  if (sub === 'reach') {
    const [slug, field, id] = parsed.positionals;
    const label = parsed.values.label;
    if (!slug || !field || !id || parsed.positionals.length > 3 || !label) { io.stderr(`person reach takes <slug> <field> <id> --label <name>.\n${USAGE}`); return 2; }
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(field)) { io.stderr(`person reach: field must be a plain word (discord, slack, ...)\n`); return 2; }
    const at = parsed.values.at ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    let current;
    try { current = readPerson(env.contextDir, slug, false); } catch (err) { io.stderr(`${(err as Error).message}\n`); return 1; }
    if (!current.found || !('card' in current)) { io.stderr(`no card for ${slug}: reach files only on a card that exists\n`); return 3; }
    const was = (current.card.where ?? {})[field];
    // The id joins what's there: a second account is kept beside the first, never in its place.
    const ids = was === undefined ? [] : Array.isArray(was.value) ? was.value.map(String) : [String(was.value)];
    const value = ids.includes(id) ? (ids.length === 1 ? ids[0] : ids) : ids.length ? [...ids, id] : id;
    const source = was?.source ?? parsed.values.source;
    const out = await personWrite(env.contextDir, { slug, where: { [field]: {
      value, label, verified_at: at, ...(source ? { source } : {}), ...(was?.stale_after_days ? { stale_after_days: was.stale_after_days } : {}),
    } } });
    if (out.startsWith('Error')) { io.stderr(`${out}\n`); return 1; }
    if (env.json) io.stdout(out.endsWith('\n') ? out : `${out}\n`);
    else io.stdout(`${slug}: ${field} ${Array.isArray(value) ? value.join(', ') : value} (${label})\n`);
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
