/**
 * loom memory — list / prune / similar / audit the memory store.
 */
import { parseArgs } from 'node:util';
import { memoryList } from '../tools/memory-list.js';
import { prune } from '../tools/prune.js';
import { recomputeSalienceForContext, digestForContext } from '../backends/salience.js';
import { tapeForContext } from '../backends/episodes.js';
import { findSimilar } from '../tools/find-similar.js';
import { memoryAudit } from '../tools/memory-audit.js';
import { archive } from '../tools/archive.js';
import { restore } from '../tools/restore.js';
import {
  propose,
  listProposals,
  ratifyProposal,
  rejectProposal,
  UnknownProposalError,
} from '../backends/proposals.js';
import { createBackend } from '../backends/index.js';
import {
  readRecallObservations,
  summarizeRecallObservations,
  formatRecallStats,
  parseSinceDuration,
} from '../backends/recall-log.js';
import { assertStackVersionCompatible } from '../config.js';
import { extractGlobalFlags, resolveEnv } from './args.js';
import { renderJson } from './io.js';
import type { IOStreams } from './io.js';

const USAGE = `Usage: loom memory <subcommand> [options]

Subcommands:
  list      Browse memories (table or --json)
  prune     Report / archive expired memories; report stale ones
  similar   Surface memories semantically near a ref or text
  audit     One-shot health report (counts, stale, duplicates, expired)
  archive   Soft-retire a memory with a tombstone (recoverable)
  restore   Return an archived memory to the active set
  propose   Stage a draft memory in the capture-propose queue (not yet canon)
  proposals List pending proposals awaiting ratification
  ratify    Ratify a pending proposal into a real memory (with optional overrides)
  reject    Discard a pending proposal without committing it
  recompute-salience  Refresh stored salience from timestamps (consolidation lane)
  digest    Preview the Top-of-Mind boot digest
  tape      The episode tape: last --hours (default 24) across all bodies, time-ordered
  recall-stats  Summarize the recall observation log (hit rate, latency, misses)

Options (list):
  --category <name>    Filter
  --project <name>     Filter
  --limit <n>          Max entries
  --json               Emit MemoryEntry[]

Options (prune):
  --stale-days <n>     Stale threshold in days
  --dry-run            Report what would be archived, don't archive
  --json               Emit PruneResult

Options (similar):
  --ref <ref>          Anchor memory ref (excludes self from results)
  --text <text>        Or anchor on fresh text
  --category <name>    Restrict candidates
  --project <name>     Restrict candidates
  --limit <n>          Max neighbours (default 10)
  --min-relevance <f>  Drop matches below this cosine (0..1)
  --json               Emit MemoryMatch[]

Options (audit):
  --stale-days <n>             Stale threshold in days (default 30)
  --similarity-threshold <f>   Duplicate floor, 0..1 (default 0.85)
  --max-duplicates <n>         Cap on duplicate pairs (default 20)
  --json                       Emit AuditReport

Options (archive):
  <ref>                Memory ref to archive (positional)
  --category <name>    Category (used with --title)
  --title <name>       Title of memory to archive (used with --category)
  --note <text>        Tombstone note: why this memory is being retired
  --json               Emit ArchiveResult

Options (restore):
  <ref>                Memory ref to restore (positional)
  --category <name>    Category (used with --title)
  --title <name>       Title of archived memory to restore (used with --category)
  --json               Emit RestoreResult

Options (propose):
  --category <name>    Proposed category (required)
  --title <name>       Proposed title (required)
  --content <text>     Proposed content (required)
  --project <name>     Associated project
  --ttl <value>        Time-to-live ("7d", "permanent", ...)
  --source <name>      Where the proposal came from (e.g. a lane name)
  --json               Emit the staged ProposalRef

Options (proposals):
  --json               Emit ProposalRow[]

Options (ratify):
  <id>                 Proposal id to ratify (positional)
  --title <text>       Override the proposed title on accept
  --content <text>     Override the proposed content on accept
  --category <name>    Override the proposed category on accept
  --project <name>     Override the proposed project on accept
  --ttl <value>        Override the proposed TTL on accept
  --json               Emit the resulting MemoryRef

Options (reject):
  <id>                 Proposal id to reject (positional)
  --json               Emit { rejected: boolean }

Options (recall-stats):
  --since <window>     Look back this far: 30m, 24h, 7d (default), 2w
  --json               Emit RecallStats

Global: --context-dir, --help/-h
`;

const SUBCOMMANDS = new Set([
  'list', 'prune', 'similar', 'audit', 'archive', 'restore',
  'propose', 'proposals', 'ratify', 'reject',
  'recompute-salience', 'digest', 'tape', 'recall-stats',
]);

export async function run(argv: string[], io: IOStreams): Promise<number> {
  const { flags: global, rest } = extractGlobalFlags(argv);
  const sub = rest[0];
  const subRest = rest.slice(1);

  if (!sub || sub === '--help' || sub === '-h') {
    io.stdout(USAGE);
    return sub ? 0 : 2;
  }
  if (!SUBCOMMANDS.has(sub)) {
    io.stderr(`Unknown memory subcommand: ${sub}\n${USAGE}`);
    return 2;
  }
  // Subcommand-level --help, honoured BEFORE any side effect. Without this,
  // the subcommands that take no flags (recompute-salience, digest) fell
  // through to their body and ran: asking for help mutated the store.
  if (subRest[0] === '--help' || subRest[0] === '-h') {
    io.stdout(USAGE);
    return 0;
  }

  const env = resolveEnv(global, io.env);
  try { assertStackVersionCompatible(env.contextDir); }
  catch (err) { io.stderr(`${(err as Error).message}\n`); return 1; }

  // recompute-salience — the consolidation lane's entry point (it-loom-salience):
  // refresh the stored temperature for every memory from its timestamps.
  if (sub === 'recompute-salience') {
    if (subRest.length) {
      io.stderr(`memory recompute-salience takes no arguments.\n${USAGE}`);
      return 2;
    }
    const n = recomputeSalienceForContext(env.contextDir, Date.now());
    io.stdout(`recomputed salience for ${n ?? 0} memories\n`);
    return 0;
  }
  // digest — preview the assembled boot digest (the same view injected at identity-load).
  if (sub === 'digest') {
    if (subRest.length) {
      io.stderr(`memory digest takes no arguments.\n${USAGE}`);
      return 2;
    }
    const d = digestForContext(env.contextDir);
    io.stdout((d ?? '(no digest — empty store)') + '\n');
    return 0;
  }
  // tape — the episode tier (t-142): what happened across all bodies, time-ordered.
  if (sub === 'tape') {
    let parsed;
    try {
      parsed = parseArgs({ args: subRest, options: { hours: { type: 'string' } }, strict: true });
    } catch (err) {
      io.stderr(`${(err as Error).message}\n${USAGE}`);
      return 2;
    }
    const hours = parsed.values.hours ? Number(parsed.values.hours) : undefined;
    if (hours !== undefined && !(hours > 0)) { io.stderr(`--hours must be a positive number\n`); return 2; }
    const t = tapeForContext(env.contextDir, { hours, tokenBudget: 6000 });
    io.stdout((t ?? `(no episodes in the last ${hours ?? 24}h)`) + '\n');
    return 0;
  }

  // recall-stats — read the local recall observation log (telemetry/recall.jsonl).
  if (sub === 'recall-stats') {
    let parsed;
    try {
      parsed = parseArgs({ args: subRest, options: { since: { type: 'string' } }, strict: true });
    } catch (err) {
      io.stderr(`${(err as Error).message}\n${USAGE}`);
      return 2;
    }
    const window = parsed.values.since ?? '7d';
    let sinceMs: number;
    try { sinceMs = parseSinceDuration(window); }
    catch (err) { io.stderr(`${(err as Error).message}\n`); return 2; }
    const rows = readRecallObservations(env.contextDir, { since: new Date(Date.now() - sinceMs) });
    const stats = summarizeRecallObservations(rows);
    if (env.json) { renderJson(io, { since: window, ...stats }); return 0; }
    io.stdout(formatRecallStats(stats, window) + '\n');
    return 0;
  }

  if (sub === 'list') {
    let parsed;
    try {
      parsed = parseArgs({
        args: subRest,
        options: {
          category: { type: 'string' },
          project:  { type: 'string' },
          limit:    { type: 'string' },
        },
        strict: true,
        allowPositionals: false,
      });
    } catch (err) {
      io.stderr(`${(err as Error).message}\n${USAGE}`);
      return 2;
    }
    const limit = parsed.values.limit !== undefined
      ? Number.parseInt(parsed.values.limit, 10)
      : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
      io.stderr(`--limit must be a positive integer.\n`);
      return 2;
    }
    const input = {
      category: parsed.values.category,
      project:  parsed.values.project,
      limit,
    };
    if (env.json) {
      const backend = createBackend(env.contextDir);
      renderJson(io, await backend.list(input));
      return 0;
    }
    const text = await memoryList(env.contextDir, input);
    io.stdout(text.endsWith('\n') ? text : text + '\n');
    return 0;
  }

  if (sub === 'similar') {
    let parsed;
    try {
      parsed = parseArgs({
        args: subRest,
        options: {
          ref:             { type: 'string' },
          text:            { type: 'string' },
          category:        { type: 'string' },
          project:         { type: 'string' },
          limit:           { type: 'string' },
          'min-relevance': { type: 'string' },
        },
        strict: true,
        allowPositionals: false,
      });
    } catch (err) {
      io.stderr(`${(err as Error).message}\n${USAGE}`);
      return 2;
    }
    if (!parsed.values.ref && !parsed.values.text) {
      io.stderr(`memory similar requires --ref or --text.\n`);
      return 2;
    }
    const limit = parsed.values.limit !== undefined
      ? Number.parseInt(parsed.values.limit, 10)
      : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
      io.stderr(`--limit must be a positive integer.\n`);
      return 2;
    }
    const minRelevance = parsed.values['min-relevance'] !== undefined
      ? Number.parseFloat(parsed.values['min-relevance'])
      : undefined;
    if (minRelevance !== undefined && (Number.isNaN(minRelevance) || minRelevance < 0 || minRelevance > 1)) {
      io.stderr(`--min-relevance must be between 0 and 1.\n`);
      return 2;
    }
    const input = {
      ref: parsed.values.ref,
      text: parsed.values.text,
      category: parsed.values.category,
      project: parsed.values.project,
      limit,
      minRelevance,
    };
    try {
      if (env.json) {
        const backend = createBackend(env.contextDir);
        renderJson(io, await backend.findSimilar(input));
        return 0;
      }
      const text = await findSimilar(env.contextDir, input);
      io.stdout(text.endsWith('\n') ? text : text + '\n');
      return 0;
    } catch (err) {
      io.stderr(`${(err as Error).message}\n`);
      return 1;
    }
  }

  if (sub === 'audit') {
    let parsed;
    try {
      parsed = parseArgs({
        args: subRest,
        options: {
          'stale-days':            { type: 'string' },
          'similarity-threshold':  { type: 'string' },
          'max-duplicates':        { type: 'string' },
        },
        strict: true,
        allowPositionals: false,
      });
    } catch (err) {
      io.stderr(`${(err as Error).message}\n${USAGE}`);
      return 2;
    }
    const staleDays = parsed.values['stale-days'] !== undefined
      ? Number.parseInt(parsed.values['stale-days'], 10)
      : undefined;
    if (staleDays !== undefined && (!Number.isInteger(staleDays) || staleDays <= 0)) {
      io.stderr(`--stale-days must be a positive integer.\n`);
      return 2;
    }
    const similarityThreshold = parsed.values['similarity-threshold'] !== undefined
      ? Number.parseFloat(parsed.values['similarity-threshold'])
      : undefined;
    if (similarityThreshold !== undefined &&
        (Number.isNaN(similarityThreshold) || similarityThreshold < 0 || similarityThreshold > 1)) {
      io.stderr(`--similarity-threshold must be between 0 and 1.\n`);
      return 2;
    }
    const maxDuplicates = parsed.values['max-duplicates'] !== undefined
      ? Number.parseInt(parsed.values['max-duplicates'], 10)
      : undefined;
    if (maxDuplicates !== undefined && (!Number.isInteger(maxDuplicates) || maxDuplicates <= 0)) {
      io.stderr(`--max-duplicates must be a positive integer.\n`);
      return 2;
    }
    const options = { staleDays, similarityThreshold, maxDuplicates };
    if (env.json) {
      const backend = createBackend(env.contextDir);
      renderJson(io, await backend.audit(options));
      return 0;
    }
    const text = await memoryAudit(env.contextDir, options);
    io.stdout(text.endsWith('\n') ? text : text + '\n');
    return 0;
  }

  if (sub === 'archive') {
    let parsed;
    try {
      parsed = parseArgs({
        args: subRest,
        options: {
          category: { type: 'string' },
          title:    { type: 'string' },
          note:     { type: 'string' },
        },
        strict: true,
        allowPositionals: true,
      });
    } catch (err) {
      io.stderr(`${(err as Error).message}\n${USAGE}`);
      return 2;
    }
    const input = {
      ref:      parsed.positionals[0],
      category: parsed.values.category,
      title:    parsed.values.title,
      note:     parsed.values.note,
    };
    if (!input.ref && !input.category) {
      io.stderr(`Nothing to archive. Provide a ref or --category + --title.\n`);
      return 2;
    }
    if (env.json) {
      const backend = createBackend(env.contextDir);
      renderJson(io, await backend.archive(input));
      return 0;
    }
    const text = await archive(env.contextDir, input);
    io.stdout(text.endsWith('\n') ? text : text + '\n');
    return /not found/i.test(text) ? 3 : 0;
  }

  if (sub === 'restore') {
    let parsed;
    try {
      parsed = parseArgs({
        args: subRest,
        options: {
          category: { type: 'string' },
          title:    { type: 'string' },
        },
        strict: true,
        allowPositionals: true,
      });
    } catch (err) {
      io.stderr(`${(err as Error).message}\n${USAGE}`);
      return 2;
    }
    const input = {
      ref:      parsed.positionals[0],
      category: parsed.values.category,
      title:    parsed.values.title,
    };
    if (!input.ref && !input.category) {
      io.stderr(`Nothing to restore. Provide a ref or --category + --title.\n`);
      return 2;
    }
    if (env.json) {
      const backend = createBackend(env.contextDir);
      renderJson(io, await backend.restore(input));
      return 0;
    }
    const text = await restore(env.contextDir, input);
    io.stdout(text.endsWith('\n') ? text : text + '\n');
    return /not found/i.test(text) ? 3 : 0;
  }

  if (sub === 'propose') {
    let parsed;
    try {
      parsed = parseArgs({
        args: subRest,
        options: {
          category: { type: 'string' },
          title:    { type: 'string' },
          content:  { type: 'string' },
          project:  { type: 'string' },
          ttl:      { type: 'string' },
          source:   { type: 'string' },
        },
        strict: true,
        allowPositionals: false,
      });
    } catch (err) {
      io.stderr(`${(err as Error).message}\n${USAGE}`);
      return 2;
    }
    const { category, title, content, project, ttl, source } = parsed.values;
    if (!category || !title || !content) {
      io.stderr(`memory propose requires --category, --title, and --content.\n`);
      return 2;
    }
    try {
      const ref = propose(env.contextDir, { category, title, content, project, ttl, source });
      if (env.json) { renderJson(io, ref); return 0; }
      io.stdout(`Proposal staged: #${ref.id} "${title}" — pending ratification\n`);
      return 0;
    } catch (err) {
      io.stderr(`${(err as Error).message}\n`);
      return 1;
    }
  }

  if (sub === 'proposals') {
    if (subRest.length > 0) {
      io.stderr(`memory proposals takes no positional arguments.\n${USAGE}`);
      return 2;
    }
    const rows = listProposals(env.contextDir);
    if (env.json) { renderJson(io, rows); return 0; }
    if (rows.length === 0) {
      io.stdout(`No pending proposals.\n`);
      return 0;
    }
    const lines = rows.map((r) => {
      const src = r.source ? ` [${r.source}]` : '';
      const body = (r.content ?? '').replace(/\s+/g, ' ').trim();
      const clipped = body.length > 120 ? body.slice(0, 117).trimEnd() + '…' : body;
      return `#${r.id} (${r.category ?? '?'})${src} ${r.title ?? '(untitled)'} — ${clipped}`;
    });
    io.stdout(`${rows.length} pending proposal(s):\n${lines.join('\n')}\n`);
    return 0;
  }

  if (sub === 'ratify') {
    let parsed;
    try {
      parsed = parseArgs({
        args: subRest,
        options: {
          title:    { type: 'string' },
          content:  { type: 'string' },
          category: { type: 'string' },
          project:  { type: 'string' },
          ttl:      { type: 'string' },
        },
        strict: true,
        allowPositionals: true,
      });
    } catch (err) {
      io.stderr(`${(err as Error).message}\n${USAGE}`);
      return 2;
    }
    const id = Number.parseInt(parsed.positionals[0] ?? '', 10);
    if (!Number.isInteger(id) || id <= 0) {
      io.stderr(`memory ratify requires a positive proposal id.\n`);
      return 2;
    }
    const overrides = {
      title:    parsed.values.title,
      content:  parsed.values.content,
      category: parsed.values.category,
      project:  parsed.values.project,
      ttl:      parsed.values.ttl,
    };
    try {
      const ref = await ratifyProposal(env.contextDir, id, overrides);
      if (env.json) { renderJson(io, ref); return 0; }
      io.stdout(`Proposal #${id} ratified → ${ref.ref}\n`);
      return 0;
    } catch (err) {
      if (err instanceof UnknownProposalError) {
        io.stderr(`Proposal #${id} not found.\n`);
        return 3;
      }
      io.stderr(`Proposal #${id} refused — ${(err as Error).message}. It remains pending.\n`);
      return 1;
    }
  }

  if (sub === 'reject') {
    let parsed;
    try {
      parsed = parseArgs({
        args: subRest,
        options: {},
        strict: true,
        allowPositionals: true,
      });
    } catch (err) {
      io.stderr(`${(err as Error).message}\n${USAGE}`);
      return 2;
    }
    const id = Number.parseInt(parsed.positionals[0] ?? '', 10);
    if (!Number.isInteger(id) || id <= 0) {
      io.stderr(`memory reject requires a positive proposal id.\n`);
      return 2;
    }
    const removed = rejectProposal(env.contextDir, id);
    if (env.json) { renderJson(io, { rejected: removed }); return removed ? 0 : 3; }
    if (removed) {
      io.stdout(`Proposal #${id} rejected and removed.\n`);
      return 0;
    }
    io.stderr(`Proposal #${id} not found.\n`);
    return 3;
  }

  // prune
  let parsed;
  try {
    parsed = parseArgs({
      args: subRest,
      options: {
        'stale-days': { type: 'string' },
        'dry-run':    { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (err) {
    io.stderr(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  const staleDays = parsed.values['stale-days'] !== undefined
    ? Number.parseInt(parsed.values['stale-days'], 10)
    : undefined;
  if (staleDays !== undefined && (!Number.isInteger(staleDays) || staleDays <= 0)) {
    io.stderr(`--stale-days must be a positive integer.\n`);
    return 2;
  }
  const dryRun = Boolean(parsed.values['dry-run']);
  const options = { staleDays, dryRun };

  if (env.json) {
    const backend = createBackend(env.contextDir);
    renderJson(io, await backend.prune(options));
    return 0;
  }
  const text = await prune(env.contextDir, options);
  io.stdout(text.endsWith('\n') ? text : text + '\n');
  return 0;
}
