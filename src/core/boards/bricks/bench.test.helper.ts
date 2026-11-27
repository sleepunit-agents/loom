/** What the suites beside each brick's definition share: an empty board, the agent's hand on it, and the pins of
 * a definition. A brick's own suite (./<name>.test.ts) states its pins once; no suite lists the bricks. */
import type { Brick } from './kit.js';
import { applyChanges, type Board, type Change } from '../model.js';

export const empty = (): Board => ({ id: 'b1', title: '', revision: 1, closed: false, placements: [] });
export function ids() {
  let n = 0;
  return () => 'p' + ++n;
}
export const agent = (board: Board, changes: Change[], id = ids()) => applyChanges(board, changes, 'agent', id);
/** What a definition commits loom to beyond its parameters: whether it has a big form, what it flags itself for,
 * how it is written in words, the records it names, and each action with the operation it reports. */
export const pins = (b: Brick) => ({
  big: b.big, flags: [...b.flags], linkKey: b.linkKey ?? null, references: b.references,
  actions: Object.fromEntries(Object.entries(b.actions).map(([name, a]) => [name, a.operation])),
});
