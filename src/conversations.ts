/**
 * Conversations across core (docs/specs/conversations.md): who may write a turn, how a
 * conversation is shown (its venue's `render`, else core's generic render), and who may read
 * which agent's conversations. The records themselves are src/backends/conversations.ts.
 */
import { createHash } from 'node:crypto';
import { agentDir, householdOf, roleString, type Household, type Member, type Role } from './household.js';
import {
  ConversationError, conversationId, openConversationsReadonly, digestsOf, findingsOf, getConversation, hubConversations, isConversationId, listConversations, openNeedDigest, parseTurn, recordTurn, turnStats,
  type TurnInput, type Conversation, type ConversationListItem, type Digest, type HubConversation, type ListFilter,
} from './backends/conversations.js';
import { COMMS_VENUE, filedThreads, noteLoopPause } from './comms.js';
import { coreVenue, markStrangers, noteModels, storeHome, venueLabel, venueOf, withHouseholdDb } from './household-store.js';
import { isStranger } from './review.js';
import { parseFeed, type Feed, type FeedItem } from './offers.js';
import { runOffer } from './offers-registry.js';
import { askGrant } from './grants.js';

// ─── Writing a turn ─────────────────────────────────────────────────────────

/** A turn's idempotency key (the runtime's `<source>:<id>`): printable ASCII, kept 24 hours. */
export const MAX_TURN_KEY = 240;
const TURN_KEY = /^[\x20-\x7e]{1,240}$/;
export const TURN_KEY_MS = 24 * 60 * 60 * 1000;

/** The venue a harness writes as the agent: an interactive session. */
export const SESSION_VENUE = 'session';

/**
 * POST /api/loom/conversations/turn, as `role`. The runtime writes for any of the
 * household's agents (the body names it, `agent`) in any venue but `session`: core's
 * `wake`, or one an installed piece declares. An agent token writes only venue `session`,
 * for itself. Every other role is refused before this is called (http-server.ts).
 */
export function writeTurn(h: Household, role: Role, raw: unknown, nowMs: number = Date.now()): { conversation: string; seq: number } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConversationError('a turn is a JSON object');
  const { agent: named, key, ...turnRaw } = raw as Record<string, unknown>;
  if (key !== undefined) {
    if (role.kind !== 'runtime') throw new ConversationError('only the runtime sends a key (an idempotency key, <source>:<id>)', 403);
    if (typeof key !== 'string' || !TURN_KEY.test(key)) throw new ConversationError(`key is 1-${MAX_TURN_KEY} printable characters`);
  }
  let agent: string;
  if (role.kind === 'runtime') {
    if (typeof named !== 'string' || !h.agents.includes(named)) throw new ConversationError(`agent names one of this household's agents (${h.agents.join(', ')})`);
    agent = named;
  } else if (role.kind === 'agent') {
    if (named !== undefined && named !== role.agent) throw new ConversationError(`this token is ${role.agent}'s: it writes only its own conversations`, 403);
    agent = role.agent;
  } else {
    throw new ConversationError('a turn is written by the runtime, or by an agent for its own session', 403);
  }
  const turn = parseTurn(turnRaw, agent);
  if (role.kind === 'agent' && turn.venue !== SESSION_VENUE) {
    throw new ConversationError(`an agent token writes only venue ${SESSION_VENUE} (its own harness session); ${turn.venue} is the runtime's`, 403);
  }
  if (role.kind === 'runtime') {
    if (turn.venue === SESSION_VENUE) throw new ConversationError(`venue ${SESSION_VENUE} is written by the harness, as the agent`, 403);
    const v = venueOf(h.home, turn.venue);
    if (!v) throw new ConversationError(`no venue ${turn.venue}: it's core's wake, or one an installed piece declares`);
    if (v.orphaned) throw new ConversationError(`venue ${turn.venue} is orphaned (its piece was removed): its conversations stay, but no new turns go there`, 409);
  }
  // A repeat of a key answers the first turn and writes nothing; the same key on another turn is a 409.
  const hash = key === undefined ? undefined : turnHash(agent, turn);
  if (key !== undefined) {
    const kept = withHouseholdDb(h.home, (db) => db.prepare('SELECT turn_sha256, conversation, seq FROM turn_keys WHERE agent = ? AND key = ? AND at > ?')
      .get(agent, key, nowMs - TURN_KEY_MS) as { turn_sha256: string; conversation: string; seq: number } | undefined);
    if (kept) {
      if (kept.turn_sha256 !== hash) throw new ConversationError(`key ${key} was already used for a different turn of ${agent}'s in the last 24 hours`, 409);
      return { conversation: kept.conversation, seq: kept.seq };
    }
  }
  // A turn from someone other than the agent's owners marks the conversation for good, before
  // the turn is recorded: a failed mark refuses the turn rather than let it look owner-only.
  if (isStranger(h, agent, turn.from)) markStrangers(h.home, agent, conversationId(agent, turn.venue, turn.place));
  // Its model and harness, kept household-wide for good: redaction and grader families outlive the fold.
  noteModels(h.home, { model: turn.model, harness: turn.harness });
  const out = recordTurn(agentDir(h, agent), agent, turn, roleString(role));
  // The runtime paused a Comms thread as a loop (its deferred note): the thread says so in words (comms.md, section 7).
  if (role.kind === 'runtime' && turn.venue === COMMS_VENUE && turn.kind === 'note' && turn.outcome === 'deferred') {
    try { noteLoopPause(h.home, out.conversation); } catch (e) { process.stderr.write(`loom: couldn't tell a Comms thread of its pause: ${(e as Error).name}\n`); }
  }
  if (key !== undefined) {
    // writeTurn is synchronous, so nothing in this process writes between the lookup above and here.
    withHouseholdDb(h.home, (db) => db.transaction(() => {
      db.prepare('DELETE FROM turn_keys WHERE at <= ?').run(nowMs - TURN_KEY_MS);
      db.prepare('INSERT OR REPLACE INTO turn_keys (agent, key, at, turn_sha256, conversation, seq) VALUES (?, ?, ?, ?, ?, ?)')
        .run(agent, key, nowMs, hash, out.conversation, out.seq);
    })());
  }
  return { conversation: out.conversation, seq: out.seq };
}

/**
 * What a turn's key stands for: a hash of agent, venue, place, from, kind and at. A repeat
 * (the runtime retrying after a lost answer) matches it; the label and the agent's own fields
 * aren't compared, so a place's newer name doesn't turn a retry into a conflict.
 */
export function turnHash(agent: string, turn: TurnInput): string {
  return createHash('sha256').update(JSON.stringify([agent, turn.venue, turn.place, turn.from, turn.kind, turn.at])).digest('hex');
}

// ─── Showing a conversation ─────────────────────────────────────────────────

/** The household home a context dir's venues registry is under. */
export function homeFor(contextDir: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return householdOf(contextDir)?.household.home ?? storeHome(env);
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/**
 * Core's generic render, in the section-feed schema (a venue's `render` answers the same, so
 * the page draws both alike): the conversation, its digests newest first, and its turn counts
 * and outcomes. It needs nothing but core's records, so it works after the venue is gone.
 */
export function genericRender(c: Conversation, digests: readonly Digest[], stats: { counts: Record<string, number>; outcomes: Record<string, number> }, label: string, openDigest?: string): Feed {
  const total = Object.values(stats.counts).reduce((a, b) => a + b, 0);
  const head: FeedItem = {
    title: (c.label ?? c.place).slice(0, 200),
    when: c.last,
    ...(c.people.length ? { who: c.people.slice(0, 8), person: c.people.slice(0, 8) } : {}),
    status: label.slice(0, 24),
    ref: c.id,
    body: [`${label}`, `started ${c.started}`, `last ${c.last}`, plural(total, 'turn'), ...(c.agents.length ? [`with ${c.agents.join(', ')}`] : [])].join(' · ').slice(0, 600),
  };
  const groups: Feed['groups'] = [{ title: 'Conversation', items: [head] }];
  if (digests.length) {
    groups.push({
      title: 'Digests',
      // At most 50 items in a feed: the head, then up to 40 digests and the counts.
      items: digests.slice(0, 40).map((d) => ({
        title: d.summary.replace(/\s+/g, ' ').slice(0, 200), when: d.at, ref: d.id, body: d.summary,
        // Only the ask the Inbox still shows needs you; one answered or cleared was asked, and is history.
        ...(d.needs_owner ? { status: d.id === openDigest ? 'needs you' : 'asked' } : {}),
      })),
    });
  }
  const counts = Object.entries(stats.counts).sort((a, b) => b[1] - a[1]).map(([k, n]): FeedItem => ({ title: `${k}: ${n}` }));
  const outcomes = Object.entries(stats.outcomes).sort((a, b) => b[1] - a[1]).map(([k, n]): FeedItem => ({ title: `${k}: ${n}`, status: 'outcome' }));
  if (counts.length || outcomes.length) groups.push({ title: 'Turns', items: [...counts, ...outcomes].slice(0, 9) });
  return { groups };
}

export interface ConversationView {
  conversation: Conversation & { venue_label: string; turns: number };
  digests: Digest[];
  findings: Array<Record<string, unknown>>;
  /** The venue's render when it's live and answers, else core's; `error` says why the venue's wasn't used, when it was tried. */
  render: { by: 'venue' | 'core'; feed: Feed; error?: string };
}

/**
 * `conversation({id})`: the record, its digests, its findings, and its render: the venue's when
 * its venue is installed (not orphaned) with a `render`, run through the section-feed runner
 * (`--conversation <id>`, 3 s, the feed schema); else, or when that fails, core's generic one.
 */
export async function conversationView(contextDir: string, agent: string, id: string, env: NodeJS.ProcessEnv = process.env): Promise<ConversationView | undefined> {
  const c = isConversationId(id) ? getConversation(contextDir, id) : undefined;
  if (!c) return undefined;
  const home = homeFor(contextDir, env);
  const digests = digestsOf(contextDir, id);
  const stats = turnStats(contextDir, id);
  const total = Object.values(stats.counts).reduce((a, b) => a + b, 0);
  const label = venueLabel(home, c.venue);
  let render: ConversationView['render'] = { by: 'core', feed: genericRender(c, digests, stats, label, openNeedDigest(contextDir, id)) };
  let v;
  try { v = coreVenue(c.venue) ? undefined : venueOf(home, c.venue); } catch { v = undefined; }
  if (v && !v.orphaned && v.render) {
    // The render runs as the agent (its store grant), so the grants authority decides first, as for any
    // agent's call to a piece (src/grants.ts, path `render`); a no, or one it can't give, is core's render.
    const no = await askGrant(env, { agent, piece: v.piece, path: 'render' });
    if (no) render = { ...render, error: `${v.piece}: not asked to render (${no.error})` };
    else {
      const out = await runOffer(env, v.piece, v.render, { args: ['--conversation', id], parse: parseFeed, caller: { kind: 'agent', agent } });
      render = out.ok ? { by: 'venue', feed: out.value } : { ...render, error: `${v.piece}: ${out.error}` };
    }
  }
  return {
    conversation: { ...c, venue_label: label, turns: total },
    digests,
    findings: findingsOf(contextDir, { conversation: id }),
    render,
  };
}

/** `conversations(...)`, with each venue's label. */
export function conversationsList(contextDir: string, f: ListFilter = {}, env: NodeJS.ProcessEnv = process.env): Array<ConversationListItem & { venue_label: string }> {
  const home = homeFor(contextDir, env);
  return listConversations(contextDir, f).map((c) => ({ ...c, venue_label: venueLabel(home, c.venue) }));
}


// ─── Who reads which agent's ────────────────────────────────────────────────

/**
 * Who is reading (conversations.md, "Who sees what"): an agent's token sees its own
 * agent's conversations; a household member, those of the agents their `agents` covers
 * (owners.md: `'*'` or a list), and no others.
 */
export type Viewer = { kind: 'agent'; agent: string } | { kind: 'member'; member: Member };

export function viewerAgents(h: Household, v: Viewer): string[] {
  if (v.kind === 'agent') return h.agents.includes(v.agent) ? [v.agent] : [];
  return v.member.agents === '*' ? [...h.agents] : h.agents.filter((a) => (v.member.agents as string[]).includes(a));
}

/** Refused: a request naming an agent the viewer doesn't cover. */
export class ScopeError extends Error {}

/**
 * The conversations a viewer may see, newest `last` first, at most 100: every agent they
 * cover, or `agent` alone when named (refused when it isn't one of theirs).
 */
export function householdConversations(h: Household, v: Viewer, f: ListFilter & { agent?: string } = {}, env: NodeJS.ProcessEnv = process.env): Array<ConversationListItem & { venue_label: string }> {
  const mine = viewerAgents(h, v);
  if (f.agent !== undefined && !mine.includes(f.agent)) {
    throw new ScopeError(v.kind === 'agent' ? `this token is ${v.agent}'s: it reads only its own conversations` : `${f.agent} isn't one of ${v.member.person}'s agents`);
  }
  const { agent, ...filter } = f;
  const agents = agent ? [agent] : mine;
  return agents.flatMap((a) => conversationsList(agentDir(h, a), filter, env))
    .sort((x, y) => (x.last < y.last ? 1 : x.last > y.last ? -1 : x.id.localeCompare(y.id)))
    .slice(0, 100);
}

/** Which of the viewer's agents has conversation `id`, if any. */
export function conversationOwner(h: Household, v: Viewer, id: string): string | undefined {
  if (!isConversationId(id)) return undefined;
  return viewerAgents(h, v).find((a) => getConversation(agentDir(h, a), id) !== undefined);
}

// ─── The project hub (docs/specs/projects.md, "Core sections") ──────────────

/**
 * The hub's `conversations` core section, which comes after `people`
 * (conversations.md, "Projects"): the 20 conversations with the newest `last` whose digests
 * name project `slug` (its slug: digests store names resolved), each with its venue's label,
 * label, people, last, the newest digest's summary, any open needs_owner, and `new` (last after
 * `since`). `since` marks, it doesn't filter. project_hub calls this with the project's slug.
 */
export function conversationsSection(contextDir: string, slug: string, since: string, env: NodeJS.ProcessEnv = process.env): { key: 'conversations'; items: HubConversation[] } | null {
  // No conversations store yet: the section is absent, as projects.md has it for a missing store.
  const db = openConversationsReadonly(contextDir);
  if (!db) return null;
  db.close();
  const home = homeFor(contextDir, env);
  // Comms threads filed under the project count from their first message, digest or not (comms.md, "Project").
  const agent = householdOf(contextDir)?.agent;
  const filed = home && agent ? filedThreads(home, agent, slug) : [];
  return { key: 'conversations', items: hubConversations(contextDir, slug, since, (v) => venueLabel(home, v), filed) };
}
