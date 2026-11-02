/**
 * Conversations across core (docs/specs/conversations.md): who may write a turn, how a
 * conversation is shown (its venue's `render`, else core's generic render), and who may read
 * which agent's conversations. The records themselves are src/backends/conversations.ts.
 */
import { agentDir, householdOf, roleString, type Household, type Member, type Role } from './household.js';
import {
  ConversationError, openConversationsReadonly, digestsOf, findingsOf, getConversation, hubConversations, isConversationId, listConversations, parseTurn, recordTurn, turnStats,
  type Conversation, type ConversationListItem, type Digest, type HubConversation, type ListFilter,
} from './backends/conversations.js';
import { CORE_VENUE_ROWS, storeHome, venueLabel, venueOf } from './household-store.js';
import { parseFeed, type Feed, type FeedItem } from './offers.js';
import { runOffer } from './offers-registry.js';

// ─── Writing a turn ─────────────────────────────────────────────────────────

/** The venue a harness writes as the agent: an interactive session. */
export const SESSION_VENUE = 'session';

/**
 * POST /api/loom/conversations/turn, as `role`. The runtime writes for any of the
 * household's agents (the body names it, `agent`) in any venue but `session`: core's
 * `wake`, or one an installed piece declares. An agent token writes only venue `session`,
 * for itself. Every other role is refused before this is called (http-server.ts).
 */
export function writeTurn(h: Household, role: Role, raw: unknown): { conversation: string; seq: number } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConversationError('a turn is a JSON object');
  const { agent: named, ...turnRaw } = raw as Record<string, unknown>;
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
  const out = recordTurn(agentDir(h, agent), agent, turn, roleString(role));
  return { conversation: out.conversation, seq: out.seq };
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
export function genericRender(c: Conversation, digests: readonly Digest[], stats: { counts: Record<string, number>; outcomes: Record<string, number> }, label: string): Feed {
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
        ...(d.needs_owner ? { status: 'needs you' } : {}),
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
  let render: ConversationView['render'] = { by: 'core', feed: genericRender(c, digests, stats, label) };
  let v;
  try { v = Object.hasOwn(CORE_VENUE_ROWS, c.venue) ? undefined : venueOf(home, c.venue); } catch { v = undefined; }
  if (v && !v.orphaned && v.render) {
    const out = await runOffer(env, v.piece, v.render, { args: ['--conversation', id], parse: parseFeed, caller: { kind: 'agent', agent } });
    render = out.ok ? { by: 'venue', feed: out.value } : { ...render, error: `${v.piece}: ${out.error}` };
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
  return { key: 'conversations', items: hubConversations(contextDir, slug, since, (v) => venueLabel(home, v)) };
}
