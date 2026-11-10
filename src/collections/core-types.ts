/**
 * Core as a provider (docs/specs/collections.md: "Core declares its own types … through the same structures, and
 * serves them through the same `query` interface. Core gets no shortcut that a piece can't have."). Its declarations
 * are checked by the same parser as a piece's, its answers go through the same checks, and it decides first for a
 * viewer exactly as a piece's provider does, so core's own filter isn't the only boundary.
 *
 * The first two types, the ones the contract's authorization cases need: `agent` (the household's agents, each
 * its owners' and its own) and `thread` (a Comms thread's metadata, its member's alone: comms.md, rule 4). The domain
 * tasks (t-2025 onward) add the rest.
 */
import { agentDir, type Household } from '../household.js';
import { allThreads } from '../comms.js';
import { agentName } from '../ui/core.js';
import { parseTypeDecl, type TypeDecl } from './contract.js';
import { answerFrom, type MemRecord, type ProviderAnswer, type ProviderQuery } from './memory.js';
import type { Viewer } from './viewer.js';

/**
 * Where a core type's records come from when they aren't core's own files to read here: the attention items are built
 * by the Inbox's own code (src/ui/handler.ts, inboxItems: every piece's manifest, the conversations' asks, the
 * member's read state), which registers itself for the household it serves. Answers the records that viewer gets, the
 * viewer's own choice already made (as any provider decides first); none registered: no records.
 */
export type CoreSource = (viewer: Viewer, now: number) => Promise<MemRecord[]>;
const sources = new Map<string, Map<string, CoreSource>>();
/** The core types whose records only a registered source makes. */
const SOURCED = new Set(['attention']);
export function registerCoreSource(home: string, type: string, f: CoreSource): void {
  let m = sources.get(home);
  if (!m) sources.set(home, (m = new Map()));
  m.set(type, f);
}

const declare = (name: string, raw: unknown): TypeDecl => {
  const d = parseTypeDecl(name, raw, `loom.${name}`);
  if (typeof d === 'string') throw new Error(`core's collection type ${name}: ${d}`);
  return d;
};

export const CORE_TYPES: Readonly<Record<string, TypeDecl>> = {
  agent: declare('agent', {
    version: '1.0',
    schema: { type: 'object', properties: { agent: { type: 'string' }, name: { type: 'string' } } },
    agent: 'agent',
    fields: {
      agent: { class: 'household', filter: ['eq', 'in'], order: true },
      name: { class: 'household', order: true },
    },
    default_fields: ['agent', 'name'],
    max_page: 100,
    aggregates: { count: {} },
  }),
  thread: declare('thread', {
    version: '1.0',
    schema: { type: 'object', properties: { agent: { type: 'string' }, title: { type: ['string', 'null'] }, updated: { type: 'string' } } },
    agent: 'agent',
    fields: {
      agent: { class: 'member', filter: ['eq', 'in'] },
      title: { class: 'member' },
      updated: { class: 'member', filter: ['lt', 'lte', 'gt', 'gte'], order: true },
      opened: { class: 'member', order: true },
      pinned: { class: 'member', filter: ['eq'] },
      archived: { class: 'member', filter: ['has'] },
      project: { class: 'member', filter: ['eq', 'has'] },
    },
    default_fields: ['agent', 'title', 'updated', 'pinned'],
    max_page: 200,
    aggregates: { count: {} },
  }),
  // One Inbox item (t-2025): an ask, a notice, an answered one, an FYI, as this member's Inbox files it. Its id is the
  // Inbox's own item key, so Home, the Inbox, the badges, an agent card and a thread's ask card name the same record.
  // What a viewer gets is decided for them by the Inbox's own code (their agents, their pieces, their read state), so
  // it's an `ask` type: when anything in it moves, each subscription is asked again as its viewer.
  attention: declare('attention', {
    version: '1.0',
    schema: { type: 'object', properties: { kind: { type: 'string' }, box: { type: 'string' }, attention: { type: 'boolean' }, text: { type: 'string' } } },
    agent: 'agent',
    fields: {
      agent: { class: 'member', filter: ['eq', 'in', 'has'] },
      kind: { class: 'member', filter: ['eq', 'in'] },
      box: { class: 'member', filter: ['eq', 'in'] },
      attention: { class: 'member', filter: ['eq'] },
      unread: { class: 'member', filter: ['eq'] },
      seen: { class: 'member' },
      sort: { class: 'member', order: true },
      at: { class: 'member' },
      text: { class: 'member' },
      meta: { class: 'member' },
      outcome: { class: 'member' },
      source: { class: 'member' },
      sourceLabel: { class: 'member' },
      page: { class: 'member' },
      label: { class: 'member' },
      href: { class: 'member' },
      actions: { class: 'member' },
      reply: { class: 'member' },
      needs: { class: 'member' },
      approval: { class: 'member' },
      waitsOnApproval: { class: 'member', filter: ['eq'] },
      fine: { class: 'member' },
      relayedFrom: { class: 'member' },
      conversation: { class: 'member', filter: ['eq'] },
      // How many members have opened it: what the core viewer's snapshot holds instead of anyone's own read state, so
      // a read moves the record and every subscription is asked again. Household owners' only, and never asked for.
      reads: { class: 'owner' },
      // A digest of every member's own copy of it (the snapshot's alone, as `reads`): a copy that moves moves the record.
      copies: { class: 'owner' },
    },
    default_fields: ['agent', 'kind', 'box', 'attention', 'unread', 'seen', 'sort', 'at', 'text', 'meta', 'outcome', 'source', 'sourceLabel', 'page', 'label', 'href',
      'actions', 'reply', 'needs', 'approval', 'waitsOnApproval', 'fine', 'relayedFrom', 'conversation'],
    max_page: 500,
    aggregates: { count: {} },
    audience: 'ask',
  }),
};

/** Core's records of `type` that core, as the provider, answers this viewer: it decides first, as any provider does. */
function recordsFor(h: Household, type: string, viewer: Viewer): MemRecord[] {
  if (type === 'agent') {
    const mine = viewer.kind === 'core' ? h.agents : viewer.kind === 'member' ? h.agents.filter((a) => viewer.agents.includes(a)) : h.agents.filter((a) => a === viewer.agent);
    return mine.map((a) => ({ id: a, agent: a, name: agentName(agentDir(h, a)), audience: { ownersOf: [a], agents: [a] } }));
  }
  if (type === 'thread') {
    if (viewer.kind === 'agent') return [];
    return allThreads(h.home)
      .filter((t) => h.agents.includes(t.agent) && (viewer.kind === 'core' || (t.member === viewer.person && viewer.agents.includes(t.agent))))
      .map((t) => ({ id: t.id, agent: t.agent, title: t.title, updated: t.last, opened: t.opened, pinned: t.pinned, archived: t.archived, project: t.project, audience: { members: [t.member] } }));
  }
  return [];
}

/** Core's answer to a batch of queries for one viewer, in the shape a piece's provider answers. */
export async function coreAnswers(h: Household, viewer: Viewer, queries: readonly ProviderQuery[], now = Date.now()): Promise<ProviderAnswer[]> {
  const held = new Map<string, MemRecord[] | 'unavailable'>();
  const out: ProviderAnswer[] = [];
  for (const q of queries) {
    const decl = CORE_TYPES[q.type];
    if (!decl) { out.push({ id: q.id, rows: [], more: false, error: 'unsupported-version' }); continue; }
    if (!held.has(q.type)) {
      const src = sources.get(h.home)?.get(q.type);
      // A source that fails says unavailable for this answer, never "none" (which would read as everything gone).
      // A type whose records come from a source no one has registered yet (loom just started, no page asked yet): not
      // "none", which would read as nothing needing anyone, but unavailable until it is.
      held.set(q.type, src ? await src(viewer, now).catch((e: unknown) => { process.stderr.write(`loom: collections ${q.type} failed: ${(e as Error).message}\n`); return 'unavailable' as const; })
        : SOURCED.has(q.type) ? 'unavailable' : recordsFor(h, q.type, viewer));
    }
    const recs = held.get(q.type)!;
    out.push(recs === 'unavailable' ? { id: q.id, rows: [], more: false, error: 'unavailable' } : answerFrom(recs, q, decl, now));
  }
  return out;
}
