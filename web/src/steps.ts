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
