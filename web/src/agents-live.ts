// Each agent's card, live (t-2028; docs/specs/collections.md): one subscription per tab to core's `agent-status`
// records, Home's own cards as loom makes them for this member (its state and why, what it has going, every job a
// piece reports, what's wrong, its readings). The desktop's agent cards and rail, and Home's cards, read this one set,
// on every page, not only while Home is the main one. Null while it isn't live and whole: each view reads its page's
// copy then.
import { liveSet } from './live-set';
import { liveOnChange } from './page';
import { attentionNow, type Attention } from './attention';
import type { Card, DeskHomeData } from './desk-agents';
import { loomNow, type TickerActivity } from './loom';
import type { QuerySpec, Rec, ViewState } from './collections/runtime';

const SPEC: QuerySpec = { type: 'loom/agent-status@^1', order: [['agent', 'asc']], limit: 100 };

/** "just now", "40m ago" (src/ui/render.ts agoText): a card's "Last seen", said again from when it was. */
function ago(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const m = Math.max(0, Math.round((now - t) / 60_000));
  return m < 1 ? 'just now' : `${m < 60 ? `${m}m` : m < 60 * 48 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`} ago`;
}
/** A card with its "Last seen" said as of now: loom doesn't move the record for the minutes passing (handler.ts). */
export function freshCard<C extends Card>(c: C, now = loomNow()): C {
  if (!c.seen?.at || !c.readings?.some((x) => x.label === 'Last seen')) return c;
  return { ...c, readings: c.readings.map((x) => (x.label === 'Last seen' ? { ...x, value: ago(c.seen!.at, now) || x.value } : x)) };
}

/** A record as Home's card: its id is the agent; `running` is the record's own (how many jobs run now). */
export function cardOf(r: Rec): Card & { running: number } {
  const { key, agent: _a, ...rest } = r;
  return freshCard({ ...(rest as unknown as Card), id: key.slice(key.lastIndexOf('/') + 1), running: typeof r.running === 'number' ? r.running : 0 });
}

export function cardsOf(state: ViewState, records: ReadonlyMap<string, Rec>): Card[] | null {
  if (state.status !== 'live' || !state.coverage?.complete) return null;
  return state.keys.flatMap((k) => { const r = records.get(k); return r ? [cardOf(r)] : []; });
}

const set = liveSet<Card[]>(SPEC, cardsOf);
// Home (house-home) is the cards and what needs you, both live: not asked again on a bare change while both are (its
// timer still asks, for its chrome: the tiles' stats, the backup and Boxes alerts). Its first-run card isn't records.
liveOnChange((view) => view === 'house-home' && set.current() !== null && attentionNow() !== null && !firstRunShown);
let firstRunShown = false;
export const useAgentCards = (csrf: string | undefined): Card[] | null => set.use(csrf);
export const agentCardsNow = (): Card[] | null => set.current();

/** Home's headline from the cards (src/ui/handler.ts, GET /): who's broken, else who's unavailable, else everyone's fine. */
export function headlineOf(cards: readonly Card[]): string {
  const down = (st: Card['state']) => cards.filter((c) => c.state === st).map((c) => c.label);
  const say = (names: string[], what: string) => `${names.join(' and ')} ${names.length === 1 ? 'is' : 'are'} ${what}`;
  const broken = down('broken'), out = down('unavailable');
  return broken.length ? say(broken, 'broken') : out.length ? say(out, 'unavailable') : 'Everyone’s fine';
}

/** Home's first few in place (attention.ts HOME_STACK). */
const STACK = 4;

/**
 * What the desktop's cards and rail read: Home's page while it's the main one, its cards read from the live set; on
 * any other page, made from the live sets alone (the cards, and what needs you), so the rail is current there too.
 * Null when neither is to hand.
 */
export function deskHomeOf(page: DeskHomeData | null, cards: Card[] | null, attention: Attention | null): DeskHomeData | null {
  if (page) return cards ? { ...page, cards, headline: headlineOf(cards) } : page;
  if (!cards || !attention) return null;
  return { headline: headlineOf(cards), needs: attention.needs.length, need: attention.needs[0], stack: attention.needs.slice(0, STACK), cards };
}

type ShellAgent = { id: string; working?: boolean; sub?: string; activity?: TickerActivity; activityUnavailable?: boolean };

/**
 * One of the shell's agents as its live card says it (src/ui/handler.ts chrome: workingOf, lastActive, tickerActivityOf):
 * at work by the card's state, "active 4m ago" from `seen.at` (the card's last step, within three days, as lastActive
 * reads it), and its ticker as the card says it. Whether that's still fresh is the ticker's to judge when it draws, on
 * loom's clock (phone-bar.tsx tickerParts, loomNow): judged here it would be on this device's clock, and only once.
 * A record from before 1.2 (no `activity`) keeps the page's ticker.
 */
export function shellAgentOf<A extends ShellAgent>(a: A, c: Card | undefined, now = loomNow()): A {
  if (!c) return a;
  const { working: _w, sub: _s, ...rest } = a;
  const recent = !!c.seen?.at && now - Date.parse(c.seen.at) < 72 * 3_600_000;
  const out = { ...rest, ...(c.state === 'working' ? { working: true } : {}), sub: recent ? `active ${ago(c.seen!.at, now) || 'a while ago'}` : 'quiet for 3 days' } as A;
  // A 1.2 card always says `activity` (null: nothing fresh); an older one doesn't, and the page's ticker stands.
  if (!('activity' in c)) return out;
  delete out.activity; delete out.activityUnavailable;
  if (c.activity) out.activity = c.activity;
  if (c.activityUnavailable) out.activityUnavailable = true;
  return out;
}

/**
 * A page's view with what the cards say read from the live set: Home's cards and headline, and the shell's agents at
 * work (the system bar's, src/ui/handler.ts workingOf: the same rule as a card's state, agentStateOf). Unchanged while
 * it isn't live.
 */
export function withAgentCards<V extends { view: string; chrome?: { shell?: { agents: ShellAgent[] } }; [k: string]: unknown }>(data: V | null, live: Card[] | null, now = loomNow()): V | null {
  if (!data || !live) return data;
  let out: V = data;
  const shell = data.chrome?.shell;
  if (shell) {
    const byId = new Map(live.map((c) => [c.id, c]));
    out = { ...out, chrome: { ...data.chrome, shell: { ...shell, agents: shell.agents.map((a) => shellAgentOf(a, byId.get(a.id), now)) } } };
  }
  if (data.view === 'house-home') firstRunShown = !!(data.home as { firstRun?: unknown } | undefined)?.firstRun;
  if (data.view === 'house-home' && data.home && typeof data.home === 'object') {
    out = { ...out, home: { ...(data.home as object), cards: live.map((c) => freshCard(c)), headline: headlineOf(live), moving: live.flatMap((c) => c.moving ?? []) } };
  }
  return out;
}
