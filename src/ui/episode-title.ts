/**
 * An episode's title as people read it (t-1972). A harness that writes an episode for a body that didn't (Art's
 * episode-fallback hook) titled it with the session's first prompt, and a body the runtime starts in a conversation
 * opens on its spawn preamble: "You are art, in a conversation on wake: Daily review. (bridge spawn token …: ignore this
 * line) Its conversation is cv-… and this run is run-…". That line is the runtime talking to the body, never something
 * that happened, so it never reaches a page: the conversation's own label stands in for it (the preamble's label when
 * the conversation isn't there), and where it happened is the conversation's venue, not the terminal the body ran in.
 *
 * No I/O here: the caller looks the conversation up (data.ts tapeRows, activity.ts), so this is tested on its own.
 */

/** The runtime's spawn preamble, at the start of a title or of a fallback episode's "Ask:" line. */
const PREAMBLE = /^(?:Ask:\s*)?You are ([a-z][a-z0-9-]{0,39}), in a conversation on ([a-z][a-z0-9-]{0,39})(?::\s*(.*?))?\s*(?:\(bridge\b|Its conversation is\b|$)/s;
/** The conversation a preamble names. */
const NAMED = /\bIts conversation is (cv-[0-9a-f]{12})\b/;
/** Anything that opens like a prompt to the body, preamble or not: never shown as a title. */
const PROMPTISH = /^(?:Ask:\s*)?You are (?:a |an |the )?[\w -]{1,40}?[,.:]/;

/** What a page needs of the conversation an episode belongs to. */
export interface ConversationFacts { venue: string; place: string; label: string | null }

export interface PlainEpisode {
  title: string;
  where: string;
  /** The conversation the episode belongs to, when it names one. */
  conversation?: string;
  /** Its title was a prompt (now replaced). */
  wasPrompt: boolean;
}

const VENUE_WORD: Record<string, string> = { loom: 'Comms', wake: 'a wake', slack: 'Slack', discord: 'Discord', relay: 'a relay', session: 'a session', cli: 'the terminal', terminal: 'the terminal' };

/** "Art in Slack", "Art in a wake": what a title says when nothing better is known. */
export function inVenue(agentLabel: string, venue: string): string {
  const v = VENUE_WORD[venue] ?? (venue ? venue[0].toUpperCase() + venue.slice(1) : 'a session');
  return `${agentLabel} in ${v}`;
}

/** The label a preamble carries ("Daily review." → "Daily review"), or null. */
function preambleLabel(raw: string | undefined): string | null {
  const s = (raw ?? '').replace(/\s+/g, ' ').trim().replace(/\.$/, '').trim();
  return s ? s : null;
}

/** Where a conversation happened, as an episode's `where` says it (data.ts whereLabel reads it). */
export function whereOfConversation(c: ConversationFacts): string {
  if (c.venue === 'wake') return 'wake';
  if (c.venue === 'loom') return `loom:${c.place}`;
  const label = (c.label ?? '').trim();
  // "Relay from Mark" under venue relay says its venue already.
  if (!label || label.toLowerCase().startsWith(c.venue.toLowerCase())) return c.venue;
  return `${c.venue}:${label}`;
}

/**
 * An episode's title and where, plain. `title` and `content` are the memory's; `where` is its metadata's; `conversation`
 * looks a conversation up by id in the agent's own store (undefined when it isn't there); `meta` is its metadata.
 */
export function plainEpisode(e: { title: string; content?: string | null; where: string; meta?: Record<string, unknown> },
  agentLabel: string, conversation: (id: string) => ConversationFacts | undefined): PlainEpisode {
  const title = e.title ?? '';
  const content = e.content ?? '';
  const named = typeof e.meta?.conversation === 'string' && /^cv-[0-9a-f]{12}$/.test(e.meta.conversation) ? e.meta.conversation : NAMED.exec(content)?.[1] ?? NAMED.exec(title)?.[1];
  // The body's copy first: a title is cut at 72 characters, the body's Ask line at 280.
  const prompt = PREAMBLE.test(title) || PROMPTISH.test(title);
  if (!prompt) return { title, where: e.where, ...(named ? { conversation: named } : {}), wasPrompt: false };
  const pre = PREAMBLE.exec(content) ?? PREAMBLE.exec(title);
  const c = named ? conversation(named) : undefined;
  const venue = c?.venue ?? pre?.[2] ?? (e.where.split(/[:/]/)[0] === '?' ? '' : e.where.split(/[:/]/)[0]);
  const label = preambleLabel(c?.label ?? undefined) ?? preambleLabel(pre?.[3]);
  // The body ran in a terminal; it was in the conversation's venue (or the preamble's, when the conversation is gone).
  const terminal = /^(terminal|cli|\?)(:|$)/.test(e.where) || !e.where;
  const where = c ? whereOfConversation(c) : terminal && venue ? venue : e.where;
  return { title: label ?? inVenue(agentLabel, venue), where, ...(named ? { conversation: named } : {}), wasPrompt: true };
}

/**
 * A fallback episode's body (Art's hook: "Ask: …", "Last said: …", "Shipped: …", then its own bookkeeping line), as
 * what was asked and what came of it. The ask loses its preamble; the bookkeeping line is dropped.
 */
export function fallbackParts(content: string): { asked?: string; said?: string; shipped?: string[] } | null {
  if (!/^Ask:/.test(content) || !/\(fallback episode, auto-extracted\b/.test(content)) return null;
  const line = (k: string) => new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(content)?.[1]?.trim();
  let asked = line('Ask');
  if (asked && PREAMBLE.test(asked)) {
    // What follows the preamble's bookkeeping, when it says anything ("It has history this session…" is the runtime's).
    asked = undefined;
  }
  const said = line('Last said');
  const shipped = line('Shipped')?.split(/;\s*/).filter(Boolean);
  return { ...(asked && asked !== '(no prompt captured)' ? { asked } : {}), ...(said && said !== '(nothing said yet)' ? { said } : {}), ...(shipped?.length ? { shipped } : {}) };
}
