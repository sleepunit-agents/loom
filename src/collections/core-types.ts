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
import { allThreads, threadRowStates, messageRecords, messageRevisions, messagesBySeq } from '../comms.js';
import { agentName } from '../ui/core.js';
import { listProjects } from '../tools/project.js';
import { parseTypeDecl, type TypeDecl } from './contract.js';
import { answerFrom, type MemRecord, type ProviderAnswer, type ProviderQuery } from './memory.js';
import type { Viewer } from './viewer.js';

/**
 * Where a core type's records come from when they aren't core's own files to read here: the attention items are built
 * by the Inbox's own code (src/ui/handler.ts, inboxItems: every piece's manifest, the conversations' asks, the
 * member's read state), which registers itself for the household it serves. Answers the records that viewer gets, the
 * viewer's own choice already made (as any provider decides first); none registered: no records.
 */
export type CoreSource = (viewer: Viewer, now: number, ids?: readonly string[]) => Promise<MemRecord[]>;
const sources = new Map<string, Map<string, CoreSource>>();
/** The core types whose records only a registered source makes. */
const SOURCED = new Set(['attention', 'agent-status']);
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
  // The project directory (t-2029), from the same reader as project_list and the Projects app. Piece feeds and
  // waiting counts remain their sources' responsibility; no piece calls or copied work state enter this type.
  project: declare('project', {
    version: '1.0',
    schema: { type: 'object', properties: { slug: { type: 'string' }, name: { type: 'string' }, status: { type: 'string' } } },
    agent: 'agent',
    fields: {
      agent: { class: 'household', filter: ['eq', 'in'], order: true },
      slug: { class: 'household', filter: ['eq', 'in'], order: true },
      name: { class: 'household', order: true },
      status: { class: 'household', filter: ['eq', 'in'], order: true },
      links: { class: 'household' },
      activity: { class: 'household', filter: ['lt', 'lte', 'gt', 'gte'], order: true },
      updated: { class: 'household', filter: ['lt', 'lte', 'gt', 'gte'], order: true },
      synthesized_at: { class: 'household' },
      stale: { class: 'household' },
      unverified: { class: 'household' },
      memories_since_synthesis: { class: 'household' },
      unreadable: { class: 'household' },
    },
    default_fields: ['agent', 'slug', 'name', 'status', 'links', 'activity', 'updated', 'synthesized_at', 'stale', 'unverified', 'memories_since_synthesis', 'unreadable'],
    max_page: 500,
    aggregates: { count: { by: ['status'] } },
  }),
  thread: declare('thread', {
    version: '1.2',
    schema: { type: 'object', properties: { agent: { type: 'string' }, title: { type: ['string', 'null'] }, updated: { type: 'string' } } },
    agent: 'agent',
    fields: {
      agent: { class: 'member', filter: ['eq', 'in'] },
      title: { class: 'member' },
      updated: { class: 'member', filter: ['lt', 'lte', 'gt', 'gte'], order: true },
      opened: { class: 'member', order: true },
      pinned: { class: 'member', filter: ['eq'] },
      archived: { class: 'member', filter: ['eq', 'has'] },
      project: { class: 'member', filter: ['eq', 'has'] },
      // Its list row's state (comms.ts threadRowStates, t-2027): a reply past its member's read, its body at work, a job's
      // thread its member hasn't written in (Background work), and its newest message's seq. Never its words.
      unread: { class: 'member', filter: ['eq'] },
      working: { class: 'member', filter: ['eq'] },
      background: { class: 'member', filter: ['eq'] },
      last_seq: { class: 'member' },
      // The rest of its Comms list row (1.2, t-2027): what the list and a thread's menu draw (comms-routes.ts view, stateOf).
      channel: { class: 'member' },
      titled_by: { class: 'member' },
      read_seq: { class: 'member' },
      conversation: { class: 'member' },
      working_since: { class: 'member' },
      queued: { class: 'member' },
      failed: { class: 'member' },
    },
    default_fields: ['agent', 'title', 'updated', 'pinned'],
    max_page: 200,
    aggregates: { count: {} },
  }),
  // Message words never enter the bridge/index/log. `message` is opened only for a member's bounded page; the
  // encrypted revision is enough to re-ask its live window (including retention, edits and delivery outcomes).
  message: declare('message', {
    version: '1.0',
    schema: { type: 'object', properties: { thread: { type: 'string' }, seq: { type: 'number' } } },
    agent: 'agent', audience: 'ask',
    fields: {
      agent: { class: 'member', filter: ['eq', 'in'] },
      thread: { class: 'member', filter: ['eq', 'in'] },
      seq: { class: 'member', filter: ['lt', 'lte', 'gt', 'gte', 'eq'], order: true },
      at: { class: 'member' },
      kind: { class: 'member' },
      from: { class: 'member' },
      run: { class: 'member' },
      delivered: { class: 'member' },
      revision: { class: 'member' },
      message: { class: 'member', heavy: true, kept: false },
    },
    default_fields: ['agent', 'thread', 'seq', 'at', 'kind', 'from', 'run', 'delivered', 'revision'],
    max_page: 500,
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
  // One agent's card (t-2028): its state and why, what it has going (doing), every job a piece reports for it (running,
  // waiting, scheduled, backlog), what's wrong, its readings, when it was last seen, its last few steps; as Home's own
  // code makes it for this member (src/ui/handler.ts agentCards over their pieces; a Comms thread's job is its member's
  // alone, handler.ts atWorkFor). So it's an `ask` type, each row's audience the viewer, as attention is.
  'agent-status': declare('agent-status', {
    version: '1.2',
    schema: { type: 'object', properties: { agent: { type: 'string' }, state: { type: 'string' }, reason: { type: 'string' } } },
    agent: 'agent',
    fields: {
      agent: { class: 'member', filter: ['eq', 'in'], order: true },
      label: { class: 'member' },
      bg: { class: 'member' },
      fg: { class: 'member' },
      face: { class: 'member' },
      state: { class: 'member', filter: ['eq', 'in'] },
      reason: { class: 'member' },
      doing: { class: 'member' },
      jobs: { class: 'member' },
      // How many of its jobs are running now (the rail's boxes, t-2077; "Working · N things").
      running: { class: 'member', filter: ['eq', 'gt', 'gte'] },
      problems: { class: 'member' },
      seen: { class: 'member' },
      readings: { class: 'member' },
      steps: { class: 'member' },
      // What's moving for it (1.1): each piece that says it's working, and why; Home's list is every card's.
      moving: { class: 'member' },
      // The system bar's ticker (1.2): its newest fresh observation (action, where, observedAt, expiresAt, href; never
      // an excerpt), or `activityUnavailable` when loom can't say (no runtime, or it's unavailable or broken).
      activity: { class: 'member' },
      activityUnavailable: { class: 'member' },
      // A digest of every member's own copy (the core viewer's snapshot alone): a copy that moves moves the record.
      copies: { class: 'owner' },
    },
    default_fields: ['agent', 'label', 'bg', 'fg', 'face', 'state', 'reason', 'doing', 'jobs', 'running', 'problems', 'seen', 'readings', 'steps', 'moving', 'activity', 'activityUnavailable'],
    max_page: 100,
    aggregates: { count: {} },
    audience: 'ask',
  }),
};

/** Core's records of `type` that core, as the provider, answers this viewer: it decides first, as any provider does. */
function recordsFor(h: Household, type: string, viewer: Viewer, now = Date.now(), ids?: readonly string[]): MemRecord[] {
  if (type === 'project') {
    if (viewer.kind !== 'core' && !(viewer.kind === 'member' && viewer.household)) return [];
    return h.agents.flatMap((agent) => listProjects(agentDir(h, agent), { nowMs: now }).map((p) => ({
      ...p, id: `${agent}:${p.slug}`, agent, audience: { owners: true },
    })));
  }
  if (type === 'agent') {
    const mine = viewer.kind === 'core' ? h.agents : viewer.kind === 'member' ? h.agents.filter((a) => viewer.agents.includes(a)) : h.agents.filter((a) => a === viewer.agent);
    return mine.map((a) => ({ id: a, agent: a, name: agentName(agentDir(h, a)), audience: { ownersOf: [a], agents: [a] } }));
  }
  if (type === 'thread' || type === 'message') {
    if (viewer.kind === 'agent') return [];
    const mine = allThreads(h.home)
      .filter((t) => (!ids || type === 'message' || ids.includes(t.id)) && h.agents.includes(t.agent) && (viewer.kind === 'core' || (t.member === viewer.person && viewer.agents.includes(t.agent))));
    if (type === 'message') return messageRecords(h.home, mine);
    const state = threadRowStates(h, mine);
    return mine.map((t) => ({ id: t.id, agent: t.agent, title: t.title, updated: t.last, opened: t.opened, pinned: t.pinned, archived: t.archived, project: t.project,
        channel: t.channel, titled_by: t.titled_by, read_seq: t.read_seq, conversation: t.conversation, working_since: t.working_since,
        queued: t.queued_since !== null, failed: t.last_failed, ...state.get(t.id)!, audience: { members: [t.member] } }));
  }
  return [];
}

/** Core's answer to a batch of queries for one viewer, in the shape a piece's provider answers. */
export async function coreAnswers(h: Household, viewer: Viewer, queries: readonly ProviderQuery[], now = Date.now(), env: NodeJS.ProcessEnv = process.env): Promise<ProviderAnswer[]> {
  const held = new Map<string, MemRecord[] | 'unavailable'>();
  const out: ProviderAnswer[] = [];
  for (const q of queries) {
    const decl = CORE_TYPES[q.type];
    if (!decl) { out.push({ id: q.id, rows: [], more: false, error: 'unsupported-version' }); continue; }
    const idClause = q.where.find(c => c[0] === 'id' && c[1] === 'in');
    const ids = idClause ? idClause[2] as string[] : undefined;
    const cacheKey = JSON.stringify([q.type, ids ?? null]);
    if (!held.has(cacheKey)) {
      const src = sources.get(h.home)?.get(q.type);
      // A source that fails says unavailable for this answer, never "none" (which would read as everything gone).
      // A type whose records come from a source no one has registered yet (loom just started, no page asked yet): not
      // "none", which would read as nothing needing anyone, but unavailable until it is.
      held.set(cacheKey, src ? await src(viewer, now, ids).catch((e: unknown) => { process.stderr.write(`loom: collections ${q.type} failed: ${(e as Error).message}\n`); return 'unavailable' as const; })
        : SOURCED.has(q.type) ? 'unavailable' : recordsFor(h, q.type, viewer, now, ids));
    }
    const recs = held.get(cacheKey)!;
    if (q.type === 'message' && recs !== 'unavailable') {
      const answer = answerFrom(recs, { ...q, fields: [...new Set([...q.fields, 'thread', 'seq'])] }, decl, now);
      if (!q.fields.includes('message') || viewer.kind !== 'member') {
        const revisions = messageRevisions(h.home, answer.rows as Array<{ thread: string; seq: number }>);
        answer.rows.forEach((r, i) => { r.revision = revisions[i]; });
        out.push(answer); continue;
      }
      try {
        const threads = new Map(allThreads(h.home).filter((t) => t.member === viewer.person && viewer.agents.includes(t.agent) && h.agents.includes(t.agent)).map((t) => [t.id, t]));
        for (const tid of new Set(answer.rows.map((r) => String(r.thread)))) {
          const t = threads.get(tid);
          if (!t) continue;
          const rows = answer.rows.filter((r) => r.thread === tid);
          const messages = await messagesBySeq(h, env, t, rows.map((r) => Number(r.seq)));
          const bySeq = new Map(messages.map((m) => [m.message.seq, m]));
          for (const r of rows) {
            const opened = bySeq.get(Number(r.seq));
            if (!opened) throw new Error('message moved during page read');
            r.message = opened.message;
            r.revision = opened.revision;
            // Mutable metadata and its words come from the same selected row, even when another listener wrote
            // between the metadata scan and this bounded payload read.
            for (const f of ['at', 'kind', 'from', 'run', 'delivered'] as const) if (q.fields.includes(f)) r[f] = opened.message[f];
          }
        }
        out.push(answer);
      } catch { out.push({ id: q.id, rows: [], more: false, error: 'unavailable' }); }
      continue;
    }
    out.push(recs === 'unavailable' ? { id: q.id, rows: [], more: false, error: 'unavailable' } : answerFrom(recs, q, decl, now));
  }
  return out;
}

/** All message metadata for the bridge, once per pull. History is not capped at the generic bridge's fixed prefix. */
export async function coreMessageSnapshot(h: Household): Promise<MemRecord[]> {
  const records = recordsFor(h, 'message', { kind: 'core' });
  const revisions = messageRevisions(h.home, records as Array<MemRecord & { thread: string; seq: number }>);
  return records.map((r, i) => ({ ...r, revision: revisions[i] }));
}
