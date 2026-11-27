/** The `secrets` brick's definition (./secrets.ts), held to what it commits loom to. */
import { expect, it } from 'vitest';
import { catalogue } from '../bricks.js';
import { live, Refused } from '../model.js';
import { agent, empty, pins } from './bench.test.helper.js';
import definition from './secrets.js';

it('secrets: whether it can be big, what it flags itself for, how it is named, and each action with its operation', () => {
  expect(pins(definition)).toEqual({
    big: true,
    flags: ['new request'],
    linkKey: null,
    references: {},
    actions: { allow: 'secrets.command', deny: 'secrets.command', cancel: 'secrets.command', revoke: 'secrets.command', setValue: 'secrets.set', remove: 'secrets.remove' },
  });
});

it('takes no parameter, and no action\'s detail can carry a name, a description or a value', () => {
  expect(live(agent(empty(), [{ change: 'place', brick: 'secrets', params: {} }]).board)[0].params).toEqual({});
  for (const params of [{ secret: 'TOKEN' }, { name: 'TOKEN' }, { value: 'x' }]) expect(() => agent(empty(), [{ change: 'place', brick: 'secrets', params }]), JSON.stringify(params)).toThrow(Refused);
  const entry = catalogue().find((c) => c.name === 'secrets')!;
  for (const [name, detail] of Object.entries(entry.actions)) {
    expect(definition.actions[name].detail.safeParse({}).success, name).toBe(true);
    for (const typed of [{ value: 'x' }, { name: 'TOKEN' }, { description: 'words' }, { secret: 'TOKEN' }, { id: 'r-1' }]) expect(definition.actions[name].detail.safeParse(typed).success, name).toBe(false);
    expect((detail as { properties?: object }).properties ?? {}, name).toEqual({});
  }
});
