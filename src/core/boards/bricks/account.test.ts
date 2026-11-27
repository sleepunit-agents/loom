/** The `account` brick's definition (./account.ts), held to what it commits loom to. */
import { expect, it } from 'vitest';
import { catalogue } from '../bricks.js';
import { live, Refused } from '../model.js';
import { agent, empty, pins } from './bench.test.helper.js';
import definition from './account.js';

it('account: whether it can be big, what it flags itself for, how it is named, and each action with its operation', () => {
  expect(pins(definition)).toEqual({
    big: true,
    flags: [],
    linkKey: null,
    references: {},
    actions: { removePasskey: 'account.removePasskey', revokeSession: 'account.revokeSession', removeDevice: 'notifications.removeDevice', enableNotifications: 'notifications.subscribe' },
  });
});

it('takes no parameter, so it can only be the member\'s own, and every action\'s detail is empty', () => {
  expect(live(agent(empty(), [{ change: 'place', brick: 'account', params: {} }]).board)[0].params).toEqual({});
  for (const params of [{ member: 'sam' }, { person: 'member:sam' }, { ref: 'a'.repeat(64) }]) expect(() => agent(empty(), [{ change: 'place', brick: 'account', params }]), JSON.stringify(params)).toThrow(Refused);
  const entry = catalogue().find((c) => c.name === 'account')!;
  expect(entry.canBeBig).toBe(true);
  for (const [name, detail] of Object.entries(entry.actions)) {
    expect(definition.actions[name].detail.safeParse({}).success, name).toBe(true);
    for (const typed of [{ ref: 'a'.repeat(64) }, { label: 'Laptop' }, { link: '/login/x' }]) expect(definition.actions[name].detail.safeParse(typed).success, name).toBe(false);
    expect((detail as { properties?: object }).properties ?? {}, name).toEqual({});
  }
});
