/**
 * loom knowledge — write / recall / maintain the knowledge store.
 */
import { parseArgs } from 'node:util';
import { knowledgeWrite } from '../tools/knowledge-write.js';
import { knowledgeRecall } from '../tools/knowledge-recall.js';
import { knowledgeMaintain } from '../tools/knowledge-maintain.js';
import { createKnowledgeBackend } from '../backends/index.js';
import { resolveIdentityName } from '../config.js';
import { extractGlobalFlags, resolveEnv } from './args.js';
import { renderJson } from './io.js';
import type { IOStreams } from './io.js';

const USAGE = `Usage: loom knowledge <subcommand> [options]

Subcommands:
  write     Upsert an entity page (create or append/revise body in place)
  recall    Search knowledge pages (LIKE over title+body+domain)
  maintain  Read-only health report (expansion candidates, cold pages, misfile audit)

Options (write):
  --slug <slug>              Entity key for upsert (default: derived from title)
  --title <title>            Page title (required)
  --domain <domain>          Domain tag, e.g. music/eurorack (required)
  --body <text>              Page body markdown (required)
  --citation <json>          Citation JSON: '{"claim":"...","source_kind":"web","source_locator":"...","excerpt":"..."}' (repeatable)
  --json                     Emit KnowledgeWriteResult

Options (recall):
  <query>                    Search terms (positional, optional)
  --domain <domain>          Filter by domain prefix
  --limit <n>                Max results (default 10)
  --json                     Emit KnowledgePageWithCitations[]

Options (maintain):
  --expansion-hit-threshold <n>   hit_count floor for expansion candidates (default 3)
  --thin-body-threshold <n>       body char ceiling for thin pages (default 500)
  --cold-days <n>                 days without access = cold (default 30)
  --json                          Emit raw report object

Global: --context-dir, --help/-h
`;

const SUBCOMMANDS = new Set(['write', 'recall', 'maintain']);

export async function run(argv: string[], io: IOStreams): Promise<number> {
  const { flags: global, rest } = extractGlobalFlags(argv);
  const sub = rest[0];
  const subRest = rest.slice(1);

  if (!sub || sub === '--help' || sub === '-h') {
    io.stdout(USAGE);
    return sub ? 0 : 2;
  }
  if (!SUBCOMMANDS.has(sub)) {
    io.stderr(`Unknown knowledge subcommand: ${sub}\n${USAGE}`);
    return 2;
  }
  // Subcommand-level --help, honoured before any side effect (see memory.ts).
  if (subRest[0] === '--help' || subRest[0] === '-h') {
    io.stdout(USAGE);
    return 0;
  }

  const env = resolveEnv(global, io.env);

  if (sub === 'write') {
    let parsed;
    try {
      parsed = parseArgs({
        args: subRest,
        options: {
          slug:     { type: 'string' },
          title:    { type: 'string' },
          domain:   { type: 'string' },
          body:     { type: 'string' },
          citation: { type: 'string', multiple: true },
        },
        strict: true,
        allowPositionals: false,
      });
    } catch (err) {
      io.stderr(`${(err as Error).message}\n${USAGE}`);
      return 2;
    }

    const { title, domain, body } = parsed.values;
    if (!title || !domain || !body) {
      io.stderr(`--title, --domain, and --body are required for knowledge write.\n`);
      return 2;
    }

    const rawCitations = parsed.values.citation ?? [];
    const citations: Array<{
      claim: string;
      source_kind: 'web' | 'loom_memory' | 'conversation';
      source_locator?: string;
      excerpt: string;
    }> = [];

    for (const raw of rawCitations) {
      try {
        const cit = JSON.parse(raw);
        if (!cit.claim || !cit.source_kind || !cit.excerpt) {
          io.stderr(`Invalid citation JSON (missing claim, source_kind, or excerpt): ${raw}\n`);
          return 2;
        }
        citations.push(cit);
      } catch {
        io.stderr(`Could not parse --citation as JSON: ${raw}\n`);
        return 2;
      }
    }

    if (env.json) {
      if (citations.length === 0) {
        io.stderr('Error: at least one citation is required for knowledge write.\n');
        return 1;
      }
      const sourcing = citations.every((c) => c.source_kind === 'conversation') ? 'provisional' : 'sourced';
      const backend = createKnowledgeBackend(env.contextDir);
      try {
        const result = await backend.writePage({
          slug: parsed.values.slug ?? title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
          title,
          domain,
          body,
          sourcing,
          citations,
          actor: resolveIdentityName(env.contextDir),
        });
        renderJson(io, result);
        return 0;
      } finally {
        backend.close();
      }
    }

    const text = await knowledgeWrite(env.contextDir, {
      slug: parsed.values.slug,
      title,
      domain,
      body,
      citations,
    });
    io.stdout(text.endsWith('\n') ? text : text + '\n');
    return text.startsWith('Error') ? 1 : 0;
  }

  if (sub === 'recall') {
    let parsed;
    try {
      parsed = parseArgs({
        args: subRest,
        options: {
          domain: { type: 'string' },
          limit:  { type: 'string' },
        },
        strict: true,
        allowPositionals: true,
      });
    } catch (err) {
      io.stderr(`${(err as Error).message}\n${USAGE}`);
      return 2;
    }

    const query = parsed.positionals[0];
    const limit = parsed.values.limit !== undefined
      ? Number.parseInt(parsed.values.limit, 10)
      : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
      io.stderr(`--limit must be a positive integer.\n`);
      return 2;
    }

    if (env.json) {
      const backend = createKnowledgeBackend(env.contextDir);
      try {
        const pages = await backend.queryPages({
          query,
          domain: parsed.values.domain,
          excludeStatus: 'archived',
          limit: limit ?? 10,
        });
        renderJson(io, pages);
        return 0;
      } finally {
        backend.close();
      }
    }

    const text = await knowledgeRecall(env.contextDir, {
      query,
      domain: parsed.values.domain,
      limit,
    });
    io.stdout(text.endsWith('\n') ? text : text + '\n');
    return 0;
  }

  // maintain
  let parsed;
  try {
    parsed = parseArgs({
      args: subRest,
      options: {
        'expansion-hit-threshold': { type: 'string' },
        'thin-body-threshold':     { type: 'string' },
        'cold-days':               { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (err) {
    io.stderr(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }

  const expansionHitThreshold = parsed.values['expansion-hit-threshold'] !== undefined
    ? Number.parseInt(parsed.values['expansion-hit-threshold'], 10)
    : undefined;
  const thinBodyThreshold = parsed.values['thin-body-threshold'] !== undefined
    ? Number.parseInt(parsed.values['thin-body-threshold'], 10)
    : undefined;
  const coldDays = parsed.values['cold-days'] !== undefined
    ? Number.parseInt(parsed.values['cold-days'], 10)
    : undefined;

  const text = await knowledgeMaintain(env.contextDir, {
    expansionHitThreshold,
    thinBodyThreshold,
    coldDays,
  });
  io.stdout(text.endsWith('\n') ? text : text + '\n');
  return 0;
}
