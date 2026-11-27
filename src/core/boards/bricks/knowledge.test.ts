/** The `knowledge` brick's definition (./knowledge.ts), held to what it commits loom to. */
import { describe, expect, it } from 'vitest';
import { bricks, catalogue } from '../bricks.js';
import { actRow, Refused } from '../model.js';
import { agent, empty, pins } from './bench.test.helper.js';
import definition from './knowledge.js';

it('knowledge: whether it can be big, what it flags itself for, how it is named, and each action with its operation', () => {
  expect(pins(definition)).toEqual({
    big: true,
    flags: [],
    linkKey: null,
    references: { domain: 'knowledge topic' },
    actions: { add: 'mind.knowledgeAdd' },
  });
});

describe('the knowledge list', () => {
  const place = (params: Record<string, unknown>) => () => agent(empty(), [{ change: 'place', brick: 'knowledge', params }]);
  it('takes one of Knowledge\'s lists and a topic, and no words to search for', () => {
    expect(agent(empty(), [{ change: 'place', brick: 'knowledge', params: {} }]).board.placements[0].params).toEqual({ show: 'all' });
    for (const params of [{ show: 'due' }, { show: 'recent', domain: 'pond' }, { domain: 'ours/pond.pump_2' }]) expect(place(params), JSON.stringify(params)).not.toThrow();
    for (const params of [{ show: 'stale' }, { domain: 'Pond' }, { domain: 'home network' }, { domain: '' }, { domain: 'a'.repeat(121) }, { query: 'pump' }, { show: 'all', search: 'pump' }])
      expect(place(params), JSON.stringify(params)).toThrow(Refused);
    const entry = catalogue().find((b) => b.name === 'knowledge')!;
    expect(entry).toMatchObject({ canBeBig: true, linkKey: null, references: { domain: 'knowledge topic' }, flagsItselfFor: [] });
    expect(Object.keys((entry.params as { properties: object }).properties).sort()).toEqual(['domain', 'show']);
    const board = place({})().board;
    expect(() => actRow(board, 'p1', 'add', {})).not.toThrow();
    expect(() => actRow(board, 'p1', 'add', { title: 'I typed this' })).toThrow(Refused);
    expect(() => actRow(board, 'p1', 'search', {})).toThrow(Refused);
    expect(bricks.find((b) => b.name === 'knowledge')!.actions.add.operation).toBe('mind.knowledgeAdd');
  });
});
