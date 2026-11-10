// Each agent's card, live (t-2028; docs/specs/collections.md): one subscription per tab to core's `agent-status`
// records, Home's own cards as loom makes them for this member (its state and why, what it has going, every job a
// piece reports, what's wrong, its readings). The desktop's agent cards and rail, and Home's cards, read this one set,
// on every page, not only while Home is the main one. Null while it isn't live and whole: each view reads its page's
// copy then.
import { liveSet } from './live-set';
import type { Card, DeskHomeData } from './desk-agents';
import type { Attention } from './attention';
import type { QuerySpec, Rec, ViewState } from './collections/runtime';

const SPEC: QuerySpec = { type: 'loom/agent-status@^1', order: [['agent', 'asc']], limit: 100 };

/** A record as Home's card: its id is the agent; `running` is the record's own (how many jobs run now). */
export function cardOf(r: Rec): Card & { running: number } {
  const { key, agent: _a, ...rest } = r;
  return { ...(rest as unknown as Card), id: key.slice(key.lastIndexOf('/') + 1), running: typeof r.running === 'number' ? r.running : 0 };
}

export function cardsOf(state: ViewState, records: ReadonlyMap<string, Rec>): Card[] | null {
  if (state.status !== 'live' || !state.coverage?.complete) return null;
  return state.keys.flatMap((k) => { const r = records.get(k); return r ? [cardOf(r)] : []; });
}

const set = liveSet<Card[]>(SPEC, cardsOf);
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

/**
 * A page's view with what the cards say read from the live set: Home's cards and headline, and the shell's agents at
 * work (the system bar's, src/ui/handler.ts workingOf: the same rule as a card's state, agentStateOf). Unchanged while
 * it isn't live.
 */
export function withAgentCards<V extends { view: string; chrome?: { shell?: { agents: Array<{ id: string; working?: boolean }> } }; [k: string]: unknown }>(data: V | null, live: Card[] | null): V | null {
  if (!data || !live) return data;
  let out: V = data;
  const shell = data.chrome?.shell;
  if (shell) {
    const state = new Map(live.map((c) => [c.id, c.state]));
    out = { ...out, chrome: { ...data.chrome, shell: { ...shell, agents: shell.agents.map((a) => {
      if (!state.has(a.id)) return a;
      const { working: _w, ...rest } = a;
      return state.get(a.id) === 'working' ? { ...rest, working: true } : rest;
    }) } } };
  }
  if (data.view === 'house-home' && data.home && typeof data.home === 'object') out = { ...out, home: { ...(data.home as object), cards: live, headline: headlineOf(live) } };
  return out;
}
