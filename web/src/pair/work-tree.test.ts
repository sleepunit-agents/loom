import { expect, it } from 'vitest';
import { workTree, type EventMessage } from './work-tree';
const key = (n: number) => String(n).padStart(24, '0');
function step(
  seq: number,
  tool: string,
  cardState: 'running' | 'done',
  id?: number,
  parent?: number,
): EventMessage {
  return {
    seq,
    kind: 'card',
    tool,
    cardState,
    run: 'run',
    thread: 'pair',
    at: '',
    sender: 'art',
    words: tool,
    clientId: id ? 'run:pair.' + key(id) + '.' + (parent ? key(parent) : '-') + '.fixture' : null,
  };
}
it('keeps concurrent identically named delegates separate and pairs interleaved terminal outputs', () => {
  const tree = workTree([
    step(1, 'Subagent · review', 'running', 1),
    step(2, 'Subagent · review', 'running', 2),
    step(3, 'Terminal', 'running', 3, 1),
    step(4, 'Terminal', 'running', 4, 2),
    step(5, 'Terminal', 'done', 4, 2),
    step(6, 'Terminal', 'done', 3, 1),
    step(7, 'Subagent · review', 'done', 2),
    step(8, 'Subagent · review', 'done', 1),
  ]);
  expect(
    tree.map((n) => [n.events.map((e) => e.seq), n.children.map((c) => c.events.map((e) => e.seq))]),
  ).toEqual([
    [[1, 8], [[3, 6]]],
    [[2, 7], [[4, 5]]],
  ]);
});
it('groups unambiguous legacy pairs while preserving separate conversation turns', () => {
  const a = step(1, 'Terminal', 'running'),
    b = step(2, 'Terminal', 'done');
  expect(workTree([a, b])).toHaveLength(1);
  expect(workTree([a, { ...a, seq: 2, kind: 'reply' }, { ...b, seq: 3 }])).toHaveLength(3);
});
