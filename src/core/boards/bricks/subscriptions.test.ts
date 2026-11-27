/** The `subscriptions` brick's definition (./subscriptions.ts), held to what it commits loom to. */
import { expect, it } from 'vitest';
import { catalogue } from '../bricks.js';
import { actRow, Refused } from '../model.js';
import { agent, empty, pins } from './bench.test.helper.js';
import definition from './subscriptions.js';

it('subscriptions: whether it can be big, what it flags itself for, how it is named, and each action with its operation', () => {
  expect(pins(definition)).toEqual({
    big: true,
    flags: ['sign-in needed'],
    linkKey: null,
    references: {},
    actions: { signIn: 'runtime.accountSignIn', create: 'runtime.accountCreate' },
  });
});

it('takes no parameter, and tells the board that a sign-in was asked for or a subscription added and nothing about which', () => {
  const place = (params: Record<string, unknown>) => () => agent(empty(), [{ change: 'place', brick: 'subscriptions', params }]);
  expect(place({})().board.placements[0].params).toEqual({});
  for (const params of [{ account: 'account-1' }, { search: 'main' }, { provider: 'acme' }]) expect(place(params), JSON.stringify(params)).toThrow(Refused);
  expect(catalogue().find((b) => b.name === 'subscriptions')).toMatchObject({ canBeBig: true, linkKey: null, references: {}, flagsItselfFor: ['sign-in needed'] });
  const board = place({})().board;
  for (const action of ['signIn', 'create']) {
    expect(() => actRow(board, 'p1', action, {}), action).not.toThrow();
    for (const detail of [{ account: 'account-1' }, { box: 'box-1' }, { label: 'I typed this' }, { provider: 'acme' }]) expect(() => actRow(board, 'p1', action, detail), action).toThrow(Refused);
  }
  expect(() => actRow(board, 'p1', 'rename', {})).toThrow(Refused);
});
