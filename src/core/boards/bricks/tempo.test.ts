/** The `tempo` brick's definition (./tempo.ts), held to what it commits loom to. */
import { expect, it } from 'vitest';
import { changeSentences } from '../brief.js';
import { actRow, Refused } from '../model.js';
import { agent, empty, pins } from './bench.test.helper.js';
import definition from './tempo.js';

it('tempo: whether it can be big, what it flags itself for, how it is named, and each action with its operation', () => {
  expect(pins(definition)).toEqual({ big: true, flags: ['a firing failed'], linkKey: null, references: { agent: 'agent' }, actions: { create: 'tempo.set' } });
});

it('takes one agent id and nothing else: no words to search for, no folder, no day', () => {
  const place = (params: Record<string, unknown>) => () => agent(empty(), [{ change: 'place', brick: 'tempo', params }]);
  expect(place({ agent: 'art' })).not.toThrow();
  for (const params of [{}, { agent: 'the helpful one' }, { agent: '' }, { agent: 'art', search: 'water' }, { agent: 'art', day: '2026-11-27' }, { agent: 7 }])
    expect(place(params), JSON.stringify(params)).toThrow(Refused);
});

it('tells create with nothing in its detail: not the words, the times, the recipient or the label typed into the form', () => {
  const board = agent(empty(), [{ change: 'place', brick: 'tempo', params: { agent: 'art' } }], () => 'g1').board;
  expect(actRow(board, 'g1', 'create', {}).detail).toEqual({});
  for (const detail of [{ instructions: 'typed words' }, { times: '08:00' }, { note: 'Morning' }, { to: 'art' }, { id: 'tr-1' }, { target: 'tempo.sweep' }])
    expect(() => actRow(board, 'g1', 'create', detail), JSON.stringify(detail)).toThrow(Refused);
  expect(changeSentences(board, [actRow(board, 'g1', 'create', {})])).toEqual(["The member's page reported: used create on tempo(agent=art) on board b1."]);
  // A trigger that exists is acted on in its own brick, and Tempo has no delete or edit on the desktop's page.
  for (const action of ['runNow', 'stop', 'start', 'edit', 'delete', 'set']) expect(() => actRow(board, 'g1', action, {}), action).toThrow(Refused);
});
