/**
 * loom person — read person cards (docs/specs/person-cards.md).
 *
 *   loom person show <slug> [--include-archived] [--json]
 *   loom person list [--include-archived] [--json]
 *   loom person reach <slug> <field> <id> --label <name> [--source <s>] [--at <iso>]
 *   loom person ensure <slug> --name <n> [--role <r>] [--source <s>] [--where <field>=<value>]... [--agent <a>] [--dry-run]
 *   loom person ensure [--dry-run] < body.json        (the same body as POST /api/loom/people/ensure)
 *
 * `ensure` makes sure someone has a card (backends/people-ensure.ts): with none, a minimal
 * one; with one, only the `where` values it lacks. It's the owner's, on loom's machine, and
 * a piece's process in an owner's action (LOOM_STORE_GRANT, owner); a piece's own process,
 * or one serving an agent, is refused (exit 5). It never runs over POST /cli: agents write
 * cards with person_write.
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
import { readPerson, listPeople, personEvidence, personWrite, personEnsure } from '../tools/person.js';
import { holdsValue, valuesOf } from '../backends/people-ensure.js';
import { PersonCardError } from '../backends/people.js';
import { householdHome } from '../household.js';
import { readGrant } from '../stores.js';
import { readStdin } from './io.js';
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
  ensure <slug> --name <n> [--role <r>] [--source <s>] [--where <field>=<value>]...
         [--agent <a>] [--dry-run]
  ensure [--dry-run] < body.json
                Make sure someone has a card: with none, a minimal one (the name,
                "<role>. From <source>.", the where values); with one, only the
                where values it lacks. Name, summary, how and may are never
                changed. A value already on another card is refused. The JSON
                body is POST /api/loom/people/ensure's. The owner's, and a piece's
                in an owner's action; exit 5 for anyone else, 4 for an archived
                card, 1 for a refusal

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
  if (sub !== 'show' && sub !== 'list' && sub !== 'evidence' && sub !== 'reach' && sub !== 'ensure') {
    io.stderr(`Unknown person subcommand: ${sub}\n${USAGE}`);
    return 2;
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: rest.slice(1),
      options: { 'include-archived': { type: 'boolean' }, since: { type: 'string' }, help: { type: 'boolean', short: 'h' },
        label: { type: 'string' }, source: { type: 'string' }, at: { type: 'string' },
        name: { type: 'string' }, role: { type: 'string' }, where: { type: 'string', multiple: true }, agent: { type: 'string' },
        'dry-run': { type: 'boolean' } },
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

  if (sub === 'ensure') return ensure(parsed, env, io);

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
    const ids = valuesOf(was);
    // A value written by hand may be a note around the id ("U02AYL3QX (Onterris), DM D0…"): the id in it counts as there.
    const there = holdsValue(ids, id);
    const value = there ? (ids.length === 1 ? ids[0] : ids) : ids.length ? [...ids, id] : id;
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

/**
 * Who may ensure a card from this process: the owner at loom's machine (no grant, not a
 * piece's own process), or a piece's process in an owner's action (a grant loom signed,
 * `owner`). Returns the actor to record, or why not.
 */
export function ensureActor(env: NodeJS.ProcessEnv): { actor: string } | { refused: string } {
  const token = env.LOOM_STORE_GRANT;
  if (token) {
    const g = readGrant(householdHome(env), token);
    if (!g) return { refused: 'the grant in LOOM_STORE_GRANT isn\'t one loom signed, or it expired' };
    if (!g.owner) return { refused: `${g.piece} is serving ${g.agent ? `the agent ${g.agent}` : 'itself'}, not an owner: only an owner's action makes a card (an agent writes cards with person_write)` };
    return { actor: `${g.who ?? 'owner'} via ${g.piece}` };
  }
  if (env.LOOM_PIECE_NAME) return { refused: `${env.LOOM_PIECE_NAME}'s own process isn't an owner's action: a card is made while the owner acts` };
  return { actor: 'owner' };
}

type Parsed = { values: Record<string, unknown>; positionals: string[] };

async function ensure(parsed: Parsed, env: ReturnType<typeof resolveEnv>, io: IOStreams): Promise<number> {
  const procEnv = io.env ?? process.env;
  const who = ensureActor(procEnv);
  if ('refused' in who) { io.stderr(`person ensure: ${who.refused}\n`); return 5; }
  const v = parsed.values as { name?: string; role?: string; source?: string; where?: string[]; agent?: string; label?: string; 'dry-run'?: boolean };
  let body: Record<string, unknown>;
  if (parsed.positionals.length === 0) {
    if (v.name || v.role || v.where || v.label) { io.stderr(`person ensure: give a <slug> with --name, or the JSON body on stdin, not both.\n${USAGE}`); return 2; }
    if (io.stdinIsTTY) { io.stderr(`person ensure: give a <slug> with --name, or pipe the JSON body on stdin.\n${USAGE}`); return 2; }
    try { body = JSON.parse(await readStdin(io.stdin ?? process.stdin)); } catch { io.stderr('person ensure: the body on stdin isn\'t JSON\n'); return 2; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) { io.stderr('person ensure: the body is a JSON object\n'); return 2; }
  } else {
    const [slug, ...more] = parsed.positionals;
    if (more.length || !v.name) { io.stderr(`person ensure takes <slug> --name <name>.\n${USAGE}`); return 2; }
    const where: Record<string, { value: string[] }> = {};
    for (const w of v.where ?? []) {
      const eq = w.indexOf('=');
      if (eq < 1 || eq === w.length - 1) { io.stderr(`person ensure: --where is <field>=<value> (slack=U0123), not ${w}\n`); return 2; }
      (where[w.slice(0, eq)] ??= { value: [] }).value.push(w.slice(eq + 1));
    }
    body = {
      slug, name: v.name, source: v.source ?? `the owner on loom's machine ${new Date().toISOString().slice(0, 10)}`,
      ...(v.role ? { role: v.role } : {}),
      ...(Object.keys(where).length ? { where: Object.fromEntries(Object.entries(where).map(([f, e]) => [f, e.value.length === 1 ? { value: e.value[0] } : e])) } : {}),
    };
  }
  if (v.agent !== undefined) body.agent = v.agent;
  if (v['dry-run']) body.dry_run = true;
  let out;
  try {
    out = personEnsure(env.contextDir, body, who.actor);
  } catch (e) {
    io.stderr(`person ensure: ${(e as Error).message}\n`);
    if (e instanceof PersonCardError && /is archived/.test(e.message)) return 4;
    return 1;
  }
  if (env.json) { renderJson(io, out); return 0; }
  const adds = Object.entries(out.added).map(([f, vs]) => `${f} ${vs.join(', ')}`).join('; ');
  const would = out.dry_run ? 'would ' : '';
  io.stdout(out.created ? `${out.slug}: ${would}${out.dry_run ? 'make' : 'made'} a card${adds ? ` (${adds})` : ''}\n`
    : out.unchanged ? `${out.slug}: has a card with all of that already\n`
    : `${out.slug}: ${would}${out.dry_run ? 'add' : 'added'} ${adds}\n`);
  return 0;
}
