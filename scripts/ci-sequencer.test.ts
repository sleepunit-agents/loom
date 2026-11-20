import { expect, it } from 'vitest';
import { partition } from './ci-sequencer.js';

it('assigns every file once, independent of discovery order, including unknown files', () => {
  const files = ['a', 'b', 'c', 'new', 'tiny'];
  const weight = (f: string) => ({ a: 100, b: 90, c: 80, tiny: 1 }[f] ?? 10);
  const shards = partition(files, 4, f => f, weight);
  expect(partition([...files].reverse(), 4, f => f, weight)).toEqual(shards);
  expect(shards.flat().sort()).toEqual([...files].sort());
  expect(shards.map(s => s.reduce((n, f) => n + weight(f), 0))).toEqual([100, 90, 80, 11]);
  expect(partition(['only'], 4, f => f, weight)).toEqual([['only'], [], [], []]);
});
