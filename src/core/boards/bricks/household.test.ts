/** The `household` brick's definition (./household.ts), held to what it commits loom to. */
import { expect, it } from 'vitest';
import { catalogue } from '../bricks.js';
import { actRow, Refused } from '../model.js';
import { agent, empty, pins } from './bench.test.helper.js';
import definition from './household.js';

it('household: whether it can be big, what it flags itself for, how it is named, and each action with its operation', () => {
  expect(pins(definition)).toEqual({
    big: true,
    flags: [],
    linkKey: null,
    references: {},
    actions: { revokeToken: 'token.revoke', revokeSession: 'sessions.revoke', setGrants: 'program.setGrants' },
  });
});

it('takes no parameter, and tells the board that something was revoked or allowed and never which token, browser or grant', () => {
  const place = (params: Record<string, unknown>) => () => agent(empty(), [{ change: 'place', brick: 'household', params }]);
  expect(place({})().board.placements[0].params).toEqual({});
  for (const params of [{ member: 'sam' }, { token: 'abc' }]) expect(place(params), JSON.stringify(params)).toThrow(Refused);
  expect(catalogue().find((b) => b.name === 'household')).toMatchObject({ canBeBig: true, linkKey: null, references: {}, flagsItselfFor: [] });
  const board = place({})().board;
  for (const action of ['revokeToken', 'revokeSession', 'setGrants']) {
    expect(() => actRow(board, 'p1', action, {}), action).not.toThrow();
    for (const detail of [{ fingerprint: 'a'.repeat(64) }, { ref: 'b'.repeat(64) }, { label: 'laptop' }, { records: 'tasks' }]) expect(() => actRow(board, 'p1', action, detail), action).toThrow(Refused);
  }
  for (const action of ['createToken', 'setPortrait', 'addMember']) expect(() => actRow(board, 'p1', action, {}), action).toThrow(Refused);
});
