/**
 * loom project — read project cards and hubs (docs/specs/projects.md).
 *
 *   loom project show <name> [--include-archived] [--json]
 *   loom project list [--status <s>] [--include-archived] [--json]
 *   loom project hub <name> [--since <iso>] [--include-archived] [--json]
 *   loom project orphans [--json]
 *
 * Cards are written through the MCP tools. A name is a slug or a live alias.
 * Exit codes: 0 found (for `hub`, even with failed sections: the failures are
 * in the output), 3 no such project, 4 archived without --include-archived,
 * 1 error, 2 usage.
 */
import { parseArgs } from 'node:util';
import { readProject, listProjects, projectHubOf, projectOrphans, type HubSection } from '../tools/project.js';
import { assertStackVersionCompatible } from '../config.js';
import { extractGlobalFlags, resolveEnv } from './args.js';
import { renderJson } from './io.js';
import type { IOStreams } from './io.js';

const USAGE = `Usage: loom project <subcommand> [options]

Subcommands:
  show <name>   Print the rendered card (or the project result with --json)
  list          List projects, most recent activity first: slug, name, status,
                activity, freshness counts, memories since synthesis
  hub <name>    The card and its sections: memories, notes, people
  orphans       Memory project tags that are no live project's name, with counts

A name is a project's slug or one of its live aliases.

Options:
  --include-archived   Show/list/hub archived projects too
  --status <s>         list: only active, paused or done
  --since <iso>        hub: mark items changed after this as new (default 7 days ago)
  --json               Machine-readable output

Exit codes: 0 found, 3 no such project, 4 archived, 1 error.
`;

const SUBS = new Set(['show', 'list', 'hub', 'orphans']);

function sectionText(s: HubSection): string {
  if ('error' in s) return `### ${s.key}\n_(error: ${s.error})_`;
  const lines: string[] = [];
  if (s.key === 'memories' && 'counts' in s) {
    const counts = Object.entries(s.counts).map(([c, n]) => `${c} ${n}`).join(', ');
    lines.push(`### memories (${s.total}${counts ? `: ${counts}` : ''})`);
    for (const m of s.items) lines.push(`- ${m.new ? '[new] ' : ''}${m.ref} (${m.created.slice(0, 10)}) ${m.snippet}`);
  } else if (s.key === 'notes' && 'total' in s) {
    lines.push(`### notes (${s.total})`);
    for (const n of s.items as Array<{ path: string; lifespan: string; updated: string; new: boolean }>) {
      lines.push(`- ${n.new ? '[new] ' : ''}${n.path} (${n.lifespan}, ${n.updated.slice(0, 10)})`);
    }
  } else if (s.key === 'people' && 'items' in s) {
    lines.push('### people');
    for (const p of s.items as Array<{ name: string; slug: string; field: string; value: unknown; marker: string }>) {
      lines.push(`- ${p.name} (${p.slug}) ${p.field}: ${Array.isArray(p.value) ? p.value.join(', ') : String(p.value)} ${p.marker}`);
    }
  } else {
    lines.push(`### ${s.key}`, JSON.stringify(s));
  }
  if (lines.length === 1) lines.push('_(nothing here)_');
  return lines.join('\n');
}

export async function run(argv: string[], io: IOStreams): Promise<number> {
  const { flags: global, rest } = extractGlobalFlags(argv);
  const sub = rest[0];
  if (!sub || sub === '--help' || sub === '-h') {
    io.stdout(USAGE);
    return sub ? 0 : 2;
  }
  if (!SUBS.has(sub)) {
    io.stderr(`Unknown project subcommand: ${sub}\n${USAGE}`);
    return 2;
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: rest.slice(1),
      options: {
        'include-archived': { type: 'boolean' }, status: { type: 'string' }, since: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
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

  try {
    if (sub === 'list' || sub === 'orphans') {
      if (parsed.positionals.length) { io.stderr(`project ${sub} takes no arguments.\n${USAGE}`); return 2; }
      if (sub === 'orphans') {
        const tags = projectOrphans(env.contextDir);
        if (env.json) renderJson(io, tags);
        else io.stdout(tags.length ? tags.map((t) => `${t.tag}\t${t.count}`).join('\n') + '\n' : 'no orphan tags\n');
        return 0;
      }
      const entries = listProjects(env.contextDir, { status: parsed.values.status, include_archived: includeArchived });
      if (env.json) { renderJson(io, entries); return 0; }
      io.stdout(
        entries.length === 0
          ? 'no projects\n'
          : entries
              .map(
                (e) =>
                  `${e.slug}\t${e.name}\t${e.status}${e.archived ? ' [archived]' : ''}\tactivity ${e.activity}\t` +
                  `stale ${e.stale}\tunverified ${e.unverified}\tmemories since synthesis ${e.memories_since_synthesis}`,
              )
              .join('\n') + '\n',
      );
      return 0;
    }

    const name = parsed.positionals[0];
    if (!name || parsed.positionals.length > 1) { io.stderr(`project ${sub} takes one name.\n${USAGE}`); return 2; }
    const result = sub === 'show'
      ? readProject(env.contextDir, name, includeArchived)
      : await projectHubOf(env.contextDir, { slug: name, since: parsed.values.since, include_archived: includeArchived });
    if (!result.found) {
      if (env.json) renderJson(io, result);
      else io.stderr(`no project ${name}\n`);
      return 3;
    }
    if (!('rendered' in result)) {
      if (env.json) renderJson(io, result);
      else io.stderr(`project ${name} is archived (pass --include-archived)\n`);
      return 4;
    }
    if (env.json) { renderJson(io, result); return 0; }
    if (!('sections' in result)) { io.stdout(result.rendered + '\n'); return 0; }
    const hub = result as Extract<Awaited<ReturnType<typeof projectHubOf>>, { sections: HubSection[] }>;
    io.stdout([hub.rendered, `_activity ${hub.activity} · new since ${hub.since}_`, ...hub.sections.map(sectionText)].join('\n\n') + '\n');
    return 0;
  } catch (err) {
    io.stderr(`${(err as Error).message}\n`);
    return 1;
  }
}
