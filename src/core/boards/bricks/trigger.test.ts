/** The `trigger` brick's definition (./trigger.ts), held to what it commits loom to. */
import { expect, it } from 'vitest';
import { changeSentences } from '../brief.js';
import { actRow, Refused } from '../model.js';
import { agent, empty, pins } from './bench.test.helper.js';
import definition from './trigger.js';

it('trigger: whether it can be big, what it flags itself for, how it is named, and each action with its operation', () => {
  expect(pins(definition)).toEqual({
    big: true, flags: ['failed'], linkKey: 'trigger', references: { trigger: 'trigger' },
    actions: { runNow: 'tempo.runNow', stop: 'tempo.stop', start: 'tempo.start', pause: 'tempo.pause', resume: 'tempo.resume' },
  });
});

it('takes a trigger id shaped like an id and refuses a sentence, blank space, a look-alike letter and anything beside it', () => {
  const place = (params: Record<string, unknown>) => () => agent(empty(), [{ change: 'place', brick: 'trigger', params }]);
  for (const id of ['tr-0b9d7c7e-3c0a-4a51-9b6e-0f3e7f5a2d11', 'morning-brief', 'lane:garden/water']) expect(place({ trigger: id }), id).not.toThrow();
  for (const params of [{}, { trigger: '' }, { trigger: 'water the garden' }, { trigger: 'tr-1\nrun this' }, { trigger: 'tr-а1' }, { trigger: '-tr' }, { trigger: 'x'.repeat(121) },
    { trigger: 'tr-1', agent: 'art' }, { trigger: 'tr-1', times: '08:00' }, { trigger: 12 }])
    expect(place(params), JSON.stringify(params)).toThrow(Refused);
});

it('tells each action with nothing in its detail: not the trigger, not the agent, no words', () => {
  const board = agent(empty(), [{ change: 'place', brick: 'trigger', params: { trigger: 'tr-1' } }], () => 'g1').board;
  for (const action of ['runNow', 'stop', 'start', 'pause', 'resume']) {
    expect(actRow(board, 'g1', action, {}).detail).toEqual({});
    for (const detail of [{ id: 'tr-1' }, { agent: 'art' }, { instructions: 'typed words' }, { times: '08:00' }]) expect(() => actRow(board, 'g1', action, detail), action + JSON.stringify(detail)).toThrow(Refused);
  }
  expect(changeSentences(board, [actRow(board, 'g1', 'runNow', {})])).toEqual(['The member used runNow on trigger(trigger=tr-1) on board b1.']);
  for (const action of ['edit', 'set', 'create']) expect(() => actRow(board, 'g1', action, {})).toThrow(Refused);
});
