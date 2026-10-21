/**
 * knowledge_maintain tool — read-only health report for the knowledge store.
 *
 * Three branches, all report-only (no fetch, no mutation):
 *   1. Expansion candidates — thin body + high hit_count (needs deepening)
 *   2. Cold pages — no recent hits (unused/undiscovered)
 *   3. Misfile audit — provisional sourcing or all-conversation citations
 *      (world/ class: should be memories, not knowledge.
 *       ours/ class with internal sourcing: NOT misfiled — these are correct.)
 *
 * Two knowledge classes (t-81, 2026-08-31):
 *   world/ — facts true independent of us (default).
 *   ours/  — Art-created artifacts; domain starts with "ours/", sourcing = "internal".
 *
 * Knowledge is a shared surface, not a scratchpad (t-677): a second identity
 * (e.g. Mark) and Jonathan can read everything filed here. A conversation-
 * only citation isn't just weakly-sourced — it's often a sign that a page is
 * really raw inner-monologue or working-out-loud that leaked out of a
 * conversation and into what's supposed to be finished, audience-ready
 * synthesis. That's doubly a misfile now: wrong store (memory, via
 * `remember`) AND wrong audience (private reasoning, not something to hand
 * another reader). The misfile audit below flags it either way.
 *
 * Person-page misfile check (criterion 13, docs/specs/person-cards.md): an
 * active page whose slug or title names an active person card — its slug or
 * exact name, as whole hyphen/space-delimited words, case-insensitive — may be
 * a person page that belongs on the card. A report, not enforcement. Cards
 * live in the memory database, so the check is opt-in (`personCards`): the
 * full server and the CLI turn it on; the knowledge-only server serves other
 * identities, never opens that database, and says the check was not run.
 *
 * Cold/expansion ranking intentionally stays on the shared pages.hit_count /
 * last_accessed aggregate rather than any per-reader breakdown (knowledge_access,
 * t-677) — any identity's read keeps a page off the cold list, which is the
 * correct aggregate signal; splitting it per-identity here would make the list
 * miss pages a *different* reader keeps alive.
 */
import { createKnowledgeBackend } from '../backends/index.js';
import type { KnowledgePageWithCitations } from '../backends/types.js';
import { listPeople } from './person.js';

export interface KnowledgeMaintainOptions {
  /** hit_count threshold for expansion candidates (default 3) */
  expansionHitThreshold?: number;
  /** body length (chars) below which a page is considered thin (default 500) */
  thinBodyThreshold?: number;
  /** days since last_accessed to consider cold (default 30) */
  coldDays?: number;
  /**
   * Run the person-page misfile check, which reads person cards from the
   * memory database. Default false — only the full server and CLI pass true.
   */
  personCards?: boolean;
}

interface PersonMisfile {
  page: KnowledgePageWithCitations;
  card: string;
}

type PersonCheck = { run: false } | { run: true; hits: PersonMisfile[] } | { run: true; error: string };

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * True for world-class pages that look like misfiles (should be in memory).
 * ours/ pages with `internal` sourcing are NEVER misfiles — excluded entirely.
 * ours/ pages that are still provisional ARE flagged: they lack a repo citation.
 */
function isMisfiled(page: KnowledgePageWithCitations): boolean {
  if (isAuditExempt(page)) return false;
  if (page.sourcing === 'provisional') return true;
  if (page.citations.length === 0) return false;
  return page.citations.every((c) => c.source_kind === 'conversation');
}

/** ours/ class with internal sourcing: correct placement, never a misfile of any kind. */
function isAuditExempt(page: KnowledgePageWithCitations): boolean {
  return page.domain.startsWith('ours/') && page.sourcing === 'internal';
}

/** Whole words, delimited by hyphens and whitespace only, lowercased. */
function words(s: string): string[] {
  return s.toLowerCase().split(/[\s-]+/).filter(Boolean);
}

function containsRun(hay: string[], needle: string[]): boolean {
  if (needle.length === 0) return false;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

function personMisfiles(contextDir: string, pages: KnowledgePageWithCitations[]): PersonCheck {
  let cards;
  try {
    cards = listPeople(contextDir);
  } catch (e) {
    return { run: true, error: (e as Error).message ?? String(e) };
  }
  const needles = cards.map((c) => ({ slug: c.slug, runs: [words(c.slug), words(c.name)] }));
  const hits: PersonMisfile[] = [];
  for (const page of pages) {
    if (page.status !== 'active' || isAuditExempt(page)) continue;
    const hays = [words(page.slug), words(page.title)];
    const match = needles.find((n) => n.runs.some((r) => hays.some((h) => containsRun(h, r))));
    if (match) hits.push({ page, card: match.slug });
  }
  return { run: true, hits };
}

function isCold(page: KnowledgePageWithCitations, thresholdMs: number): boolean {
  if (page.hit_count === 0 && !page.last_accessed) return true;
  if (!page.last_accessed) return true;
  const lastMs = new Date(page.last_accessed).getTime();
  return Number.isNaN(lastMs) ? true : Date.now() - lastMs > thresholdMs;
}

export async function knowledgeMaintain(
  contextDir: string,
  options: KnowledgeMaintainOptions = {},
): Promise<string> {
  const hitThreshold = options.expansionHitThreshold ?? 3;
  const bodyThreshold = options.thinBodyThreshold ?? 500;
  const coldMs = (options.coldDays ?? 30) * DAY_MS;

  const backend = createKnowledgeBackend(contextDir);
  try {
    const pages = await backend.listPages({ limit: 1000 });

    const expansionCandidates = pages.filter(
      (p) => p.hit_count >= hitThreshold && p.body.length < bodyThreshold && p.status === 'active',
    );
    const coldPages = pages.filter(
      (p) => isCold(p, coldMs) && p.status === 'active',
    );
    const misfiled = pages.filter(
      (p) => isMisfiled(p) && p.status === 'active',
    );

    const people: PersonCheck = options.personCards ? personMisfiles(contextDir, pages) : { run: false };

    const activeCount = pages.filter((p) => p.status === 'active').length;
    return formatMaintainReport(activeCount, expansionCandidates, coldPages, misfiled, people, {
      hitThreshold,
      bodyThreshold,
      coldDays: options.coldDays ?? 30,
    });
  } finally {
    backend.close();
  }
}

function formatMaintainReport(
  total: number,
  expansion: KnowledgePageWithCitations[],
  cold: KnowledgePageWithCitations[],
  misfiled: KnowledgePageWithCitations[],
  people: PersonCheck,
  thresholds: { hitThreshold: number; bodyThreshold: number; coldDays: number },
): string {
  const lines: string[] = [];
  lines.push('# Knowledge maintain report');
  lines.push('');
  lines.push(`**Total active pages:** ${total}`);

  // ── Expansion candidates ──────────────────────────────────────────────────
  lines.push('');
  lines.push(`## Expansion candidates (hit_count ≥ ${thresholds.hitThreshold}, body < ${thresholds.bodyThreshold} chars)`);
  lines.push('');
  if (expansion.length === 0) {
    lines.push('None — no thin but frequently-accessed pages.');
  } else {
    lines.push(`${expansion.length} page${expansion.length === 1 ? '' : 's'} are thin but frequently accessed — consider deepening:`);
    for (const p of expansion) {
      lines.push(`- \`${p.slug}\` — *${p.title}* (${p.domain}) — ${p.hit_count} hits, ${p.body.length} chars`);
    }
  }

  // ── Cold pages ────────────────────────────────────────────────────────────
  lines.push('');
  lines.push(`## Cold pages (no access in ${thresholds.coldDays}+ days, or never accessed)`);
  lines.push('');
  if (cold.length === 0) {
    lines.push('None — all active pages have been accessed recently.');
  } else {
    lines.push(`${cold.length} page${cold.length === 1 ? '' : 's'} have not been accessed recently:`);
    for (const p of cold) {
      const lastAccess = p.last_accessed ? p.last_accessed.slice(0, 10) : 'never';
      lines.push(`- \`${p.slug}\` — *${p.title}* (${p.domain}) — last access: ${lastAccess}`);
    }
  }

  // ── Misfile audit ─────────────────────────────────────────────────────────
  lines.push('');
  lines.push('## Misfile audit (provisional sourcing or conversation-only citations)');
  lines.push('');
  if (misfiled.length === 0) {
    lines.push('None — all active pages have independent citation support.');
  } else {
    lines.push(
      `${misfiled.length} page${misfiled.length === 1 ? '' : 's'} may need attention:`,
    );
    lines.push(
      '> **World class:** knowledge is true independent of Jonathan — provisional/conversation-only pages belong in memory.\n' +
      '> **Ours class (domain: ours/):** should have at least one `repo` citation to reach `internal` sourcing.\n' +
      '> Knowledge is shared with other identities and Jonathan now — a conversation-only page may also be ' +
      'private inner-monologue that never belonged here, not just under-cited.',
    );
    for (const p of misfiled) {
      const reason = p.sourcing === 'provisional' ? 'provisional' : 'conversation-only citations';
      const hint = p.domain.startsWith('ours/')
        ? '→ add a repo citation (git path / commit)'
        : '→ add a web citation or relocate to memory';
      lines.push(`- \`${p.slug}\` — *${p.title}* (${p.domain}) — ${reason} ${hint}`);
    }
  }

  // ── Person-page misfile check ─────────────────────────────────────────────
  lines.push('');
  lines.push('## Person-page misfile check (slug or title names a person card)');
  lines.push('');
  if (!people.run) {
    lines.push(
      'Not run — person cards live in the memory database, which this surface does not read ' +
      '(the knowledge-only server never opens it). `loom knowledge maintain` and the full loom server run it.',
    );
  } else if ('error' in people) {
    lines.push(`Not run — could not read person cards: ${people.error}`);
  } else if (people.hits.length === 0) {
    lines.push('None — no active page names a person card.');
  } else {
    lines.push(
      `${people.hits.length} page${people.hits.length === 1 ? '' : 's'} may be about a person:`,
    );
    lines.push(
      '> A heuristic, not enforcement. Contextual state about a person belongs on their card ' +
      '(person_write), not in knowledge; a page about a public figure\'s published work can stay.',
    );
    for (const { page: p, card } of people.hits) {
      lines.push(`- \`${p.slug}\` — *${p.title}* (${p.domain}) — names card \`${card}\``);
    }
  }

  return lines.join('\n');
}
