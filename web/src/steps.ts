// A run's steps (its tool cards), as Comms shows them (t-1944) and Activity's reader reuses (t-1972): a plan is not a
// step, three or more like steps in a row fold into one line, a step's label says what it did. No React here.

/** What a step needs: its words (null once swept), its tool and state. */
export type StepCard = { text: string | null; card?: { tool?: unknown; state?: unknown } | null };
export type StepStatus = 'complete' | 'current' | 'error';

/** A card's state as the progress list draws it. */
export const stepOf = (c: StepCard): StepStatus => { const st = String(c.card?.state ?? ''); return st === 'failed' ? 'error' : st === 'running' ? 'current' : 'complete'; };

/** A plan card (Claude's TodoWrite, Codex's todo list; t-1944): the plan, not a step. Its label is `Plan (2/5): …`. */
export const isPlan = (c: StepCard) => ['TodoWrite', 'todo_list'].includes(String(c.card?.tool ?? ''));
/** A step's kind for grouping repeats: its label's first word and its tool ("Ran", "Read", "Searched"…). */
const kindOf = (c: StepCard) => `${String(c.card?.tool ?? '')}:${(c.text ?? '').split(' ')[0]}`;
const GROUP_WORDS: Record<string, string> = { Ran: 'Ran N commands', Read: 'Read N files', Searched: 'N searches', Edited: 'Edited N files', Wrote: 'Wrote N files', Listed: 'Listed N folders', Messaged: 'N messages', Changed: 'Changed files N times' };
export const groupLabel = (cards: StepCard[]) => {
  const w = (cards[0].text ?? '').split(' ')[0];
  return (GROUP_WORDS[w] ?? `N steps: ${w}`).replace('N', String(cards.length));
};
/** Steps as the list shows them: three or more like ones in a row, all finished well, fold into one line you can open. */
export function folded<T extends StepCard>(cards: T[]): Array<{ few: T[] } | { many: T[] }> {
  const out: Array<{ few: T[] } | { many: T[] }> = [];
  for (let i = 0; i < cards.length;) {
    let j = i;
    while (j < cards.length && kindOf(cards[j]) === kindOf(cards[i]) && stepOf(cards[j]) === 'complete' && cards[j].text !== null) j++;
    if (j - i >= 3) { out.push({ many: cards.slice(i, j) }); i = j; continue; }
    const last = out.at(-1);
    if (last && 'few' in last) last.few.push(cards[i]); else out.push({ few: [cards[i]] });
    i++;
  }
  return out;
}

// ─── The Watching view's look (t-2109; Jonathan, 2026-11-10: the Claude app's folded rows, not a terminal) ───────────

/** A card's further parts as core serves them (`card.step`, sealed with its label), and its plain times and numbers. */
export type StepWords = { detail?: string; body?: string; result?: string; items?: Array<{ text: string; state: 'done' | 'now' | 'todo' }> };
export type WorkCard = StepCard & { id: string; seq: number; at: string; card?: { tool?: unknown; state?: unknown; t0?: unknown; t1?: unknown; exit?: unknown; limit?: unknown; parent?: unknown; step?: unknown } | null };
export type WorkNode<T extends WorkCard> = { c: T; kids: Array<WorkNode<T>> };

export const wordsOf = (c: WorkCard): StepWords => (c.card?.step && typeof c.card.step === 'object' ? c.card.step as StepWords : {});
export const isText = (c: WorkCard) => String(c.card?.tool ?? '') === 'text';
const ms = (v: unknown) => (typeof v === 'string' ? Date.parse(v) : NaN);

/** When a step started and ended (its own times, else when core first heard of it); `end` null while it runs. */
export function spanOf(c: WorkCard): { start: number; end: number | null } {
  const start = Number.isFinite(ms(c.card?.t0)) ? ms(c.card?.t0) : ms(c.at);
  const end = stepOf(c) === 'current' ? null : Number.isFinite(ms(c.card?.t1)) ? ms(c.card?.t1) : start;
  return { start, end: end !== null && end < start ? start : end };
}

/** `4s`, `2m 13s`, `1h 5m`. */
export function took(msN: number): string {
  const s = Math.max(0, Math.round(msN / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Steps as rows: each under the step that started it (a helper's, its `parent`), in order; the plan left out. */
export function workTree<T extends WorkCard>(cards: T[]): Array<WorkNode<T>> {
  const nodes = new Map<string, WorkNode<T>>();
  const top: Array<WorkNode<T>> = [];
  // Whether `p` is `n` or already sits somewhere under it.
  const under = (p: WorkNode<T>, n: WorkNode<T>): boolean => p === n || n.kids.some((k) => under(p, k));
  for (const c of cards) if (!isPlan(c)) nodes.set(c.id, { c, kids: [] });
  for (const c of cards) {
    if (isPlan(c)) continue;
    const n = nodes.get(c.id)!;
    const p = typeof c.card?.parent === 'string' ? nodes.get(c.card.parent) : undefined;
    // Under its parent unless that would close a loop (a→b, b→a): then at the top, never lost.
    if (p && !under(p, n)) p.kids.push(n); else top.push(n);
  }
  return top;
}

/** Every step under a group (not its words), for its header's count. */
export const stepsUnder = <T extends WorkCard>(n: WorkNode<T>): number => n.kids.reduce((k, x) => k + (isText(x.c) ? 0 : 1) + stepsUnder(x), 0);

/** Whether a running step is past its own time limit, with a 30-second grace (the runtime polls a few seconds behind). */
export const LIMIT_GRACE_MS = 30_000;
export const pastLimit = (c: WorkCard, now: number) => spanOf(c).end === null && Number.isInteger(c.card?.limit) && now - spanOf(c).start > (c.card!.limit as number) * 1000 + LIMIT_GRACE_MS;

/** Quiet this long, its body still up: "quiet". Twice the plain quiet, or a step past its own limit: "stuck". */
export const QUIET_MS = 2 * 60_000;
export const STUCK_MS = 12 * 60_000;

export type Alive = { face: 'working' | 'quiet' | 'stuck'; quiet: number; step: WorkCard | null; running: number; tokens: number | null; over: boolean };

/**
 * Working, quiet or stuck (t-2109), for a thread that's working: its last sign of life is the newest of its body's
 * record moving (`alive_at`) and a step starting or ending. Stuck when quiet for STUCK_MS, or a step running past its
 * own time limit (and a half-minute's grace).
 */
export function aliveOf(state: { alive_at?: string; tokens?: number; working_since?: string | null }, cards: WorkCard[], now: number): Alive {
  // With nothing else heard, since it started working: a body that never says anything is quiet, then stuck.
  // A time ahead of now (a clock that runs ahead) counts as now, never as later.
  const seen = (t: number) => (Number.isFinite(t) ? Math.min(t, now) : 0);
  let last = Math.max(seen(ms(state.alive_at)), seen(ms(state.working_since)));
  let step: WorkCard | null = null, late: WorkCard | null = null;
  // Only this spell's steps: one from an earlier run (its end never told) isn't running now.
  const since = Number.isFinite(ms(state.working_since)) ? ms(state.working_since) - 60_000 : -Infinity;
  for (const c of cards.filter((x) => spanOf(x).start >= since)) {
    const s = spanOf(c);
    last = Math.max(last, seen(s.end ?? s.start));
    if (s.end === null && !isPlan(c)) { step = c; if (!late && pastLimit(c, now)) late = c; }
  }
  // Any step still running past its own limit, not only the newest (a helper's, while its child runs).
  if (late) step = late;
  const quiet = last ? Math.max(0, now - last) : 0;
  const running = step ? Math.max(0, now - spanOf(step).start) : 0;
  const over = !!late;
  const face = over || quiet >= STUCK_MS ? 'stuck' : quiet >= QUIET_MS ? 'quiet' : 'working';
  return { face, quiet, step, running, tokens: typeof state.tokens === 'number' ? state.tokens : null, over };
}

/** `4.1k`, `12k`, `1.2M` tokens. */
export const tokensWord = (n: number) => (n < 1000 ? String(n) : n < 10_000 ? `${(n / 1000).toFixed(1)}k` : n < 1e6 ? `${Math.round(n / 1000)}k` : `${(n / 1e6).toFixed(1)}M`);

/** ANSI colour codes in shown text, as runs of text and their style; nothing but text and a few names ever comes out. */
export type Ansi = { text: string; fg?: string; bold?: true };
const FG: Record<number, string> = { 30: 'black', 31: 'red', 32: 'green', 33: 'yellow', 34: 'blue', 35: 'magenta', 36: 'cyan', 37: 'white', 90: 'gray', 91: 'red', 92: 'green', 93: 'yellow', 94: 'blue', 95: 'magenta', 96: 'cyan', 97: 'white' };
export function ansiRuns(s: string): Ansi[] {
  const out: Ansi[] = [];
  let fg: string | undefined, bold = false;
  const re = /\x1b\[([0-9;]{0,30})m/g;
  let at = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index > at) out.push({ text: s.slice(at, m.index), ...(fg ? { fg } : {}), ...(bold ? { bold: true as const } : {}) });
    for (const p of (m[1] || '0').split(';').map(Number)) {
      if (p === 0) { fg = undefined; bold = false; } else if (p === 1) bold = true; else if (p === 22) bold = false; else if (p === 39) fg = undefined; else if (FG[p]) fg = FG[p];
    }
    at = re.lastIndex;
  }
  if (at < s.length) out.push({ text: s.slice(at), ...(fg ? { fg } : {}), ...(bold ? { bold: true as const } : {}) });
  // Any escape left (none should reach here: core takes only colour codes) shows as nothing.
  return out.map((r) => ({ ...r, text: r.text.replace(/\x1b/g, '') })).filter((r) => r.text);
}
