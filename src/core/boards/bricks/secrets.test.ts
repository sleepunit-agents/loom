/** The `secrets` brick's definition (./secrets.ts), held to what it commits loom to. */
import { expect, it } from 'vitest';
import { z } from 'zod';
import { secretName as storeName } from '../../../pieces/secrets/input.js';
import { catalogue } from '../bricks.js';
import { live, Refused } from '../model.js';
import { agent, empty, pins } from './bench.test.helper.js';
import { household } from '../house.fixture.js';
import { ACCEPTED_NAMES, REFUSED_NAMES } from '../value-shape.fixture.js';
import { secretName } from './kit.js';
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

it('takes no parameter; an answer, a cancel or a revoke is told with nothing, and no detail takes a value, a description or a request', () => {
  expect(live(agent(empty(), [{ change: 'place', brick: 'secrets', params: {} }]).board)[0].params).toEqual({});
  for (const params of [{ secret: 'TOKEN' }, { name: 'TOKEN' }, { value: 'x' }]) expect(() => agent(empty(), [{ change: 'place', brick: 'secrets', params }]), JSON.stringify(params)).toThrow(Refused);
  const entry = catalogue().find((c) => c.name === 'secrets')!;
  for (const name of ['allow', 'deny', 'cancel', 'revoke']) {
    expect(definition.actions[name].detail.safeParse({}).success, name).toBe(true);
    for (const typed of [{ value: 'x' }, { name: 'TOKEN' }, { description: 'words' }, { secret: 'TOKEN' }, { id: 'r-1' }]) expect(definition.actions[name].detail.safeParse(typed).success, name).toBe(false);
    expect((entry.actions[name] as { properties?: object }).properties ?? {}, name).toEqual({});
  }
  for (const name of ['setValue', 'remove']) {
    for (const typed of [{ value: 'x' }, { description: 'words' }, { id: 'r-1' }]) expect(definition.actions[name].detail.safeParse({ secret: 'TOKEN', outcome: name === 'remove' ? 'removed' : 'added', ...typed }).success, `${name} ${JSON.stringify(typed)}`).toBe(false);
    expect(Object.keys((entry.actions[name] as { properties: object }).properties).sort(), name).toEqual(['outcome', 'secret']);
  }
});

it('a value set or a secret removed is told by the secret\'s name and its outcome, and by nothing else', () => {
  const detail = (name: string, typed: unknown) => definition.actions[name].detail.safeParse(typed).success;
  for (const outcome of ['added', 'replaced']) expect(detail('setValue', { secret: 'PUMP_TOKEN', outcome }), outcome).toBe(true);
  expect(detail('remove', { secret: 'PUMP_TOKEN', outcome: 'removed' })).toBe(true);
  // Each outcome belongs to its own action: a removal is not reported as a value set, nor the other way round.
  expect(detail('setValue', { secret: 'PUMP_TOKEN', outcome: 'removed' })).toBe(false);
  for (const outcome of ['added', 'replaced', 'saved']) expect(detail('remove', { secret: 'PUMP_TOKEN', outcome }), outcome).toBe(false);
  // Both are needed: a report without the name or without the outcome says nothing the agent can use.
  for (const name of ['setValue', 'remove']) for (const typed of [{}, { secret: 'PUMP_TOKEN' }, { outcome: name === 'remove' ? 'removed' : 'added' }]) expect(detail(name, typed), `${name} ${JSON.stringify(typed)}`).toBe(false);
  // The name is the secrets store's own shape and nothing wider: no sentence, no blank, nothing past 64.
  for (const secret of ['two words', 'MAIL KEY', '-LEADING', '.hidden', 'a/b', 'x'.repeat(65), 'line\nbreak', '']) expect(detail('setValue', { secret, outcome: 'added' }), JSON.stringify(secret)).toBe(false);
  expect(detail('setValue', { secret: 'x'.repeat(64), outcome: 'added' })).toBe(true);
  expect(secretName.safeParse('x'.repeat(65)).success).toBe(false);
  // The kit's shape is the store's, character for character.
  expect(z.toJSONSchema(secretName)).toEqual(z.toJSONSchema(storeName));
});

const VALUE = 'synthetic-private-value-7Q', ABOUT = 'The pond pump, private words';
it('through the real operations, the name and outcome reach the board and the agent\'s brief, and a value or description in its own field is refused and stored nowhere', async () => {
  const house = await household('secrets');
  try {
    // `{ secret: VALUE }` is refused here only for its missing outcome: what is in `secret` is told as a name.
    for (const typed of [{ value: VALUE }, { description: ABOUT }, { secret: 'PUMP_TOKEN', outcome: 'added', value: VALUE }, { secret: 'PUMP_TOKEN', outcome: 'replaced', description: ABOUT }])
      expect(await house.act('setValue', typed), JSON.stringify(typed)).toMatchObject({ ok: false });
    expect(await house.act('remove', { secret: 'PUMP_TOKEN', outcome: 'removed', value: VALUE })).toMatchObject({ ok: false });
    expect(await house.act('setValue', { secret: 'PUMP_TOKEN', outcome: 'added' })).toMatchObject({ ok: true });
    expect(await house.act('setValue', { secret: 'PUMP_TOKEN', outcome: 'replaced' })).toMatchObject({ ok: true });
    expect(await house.act('remove', { secret: 'PUMP_TOKEN', outcome: 'removed' })).toMatchObject({ ok: true });
    const stored = house.stored(), read = JSON.stringify(await house.read()), brief = house.brief();
    for (const [where, text] of [['stored rows', stored], ['boards.read', read], ['brief', brief]]) {
      expect(text, where).not.toContain(VALUE);
      expect(text, where).not.toContain(ABOUT);
    }
    expect(brief).toContain('used setValue on secrets() on board');
    expect(brief).toContain(': outcome=added, secret=PUMP_TOKEN.');
    expect(brief).toContain(': outcome=replaced, secret=PUMP_TOKEN.');
    expect(brief).toContain('used remove on secrets() on board');
    expect(brief).toContain(': outcome=removed, secret=PUMP_TOKEN.');
  } finally { house.close(); }
});

// What the detail cannot know: a name-shaped value typed into Name is told as the name. A value with a credential's
// shape is refused, by the same function the page uses (../value-shape.ts); anything else name-shaped is a name.
// Every synthetic credential of the one fixture list that the store's name shape takes (../value-shape.fixture.ts).
const PASTED = REFUSED_NAMES.filter((name) => secretName.safeParse(name).success);
it('a name in the shape of a secret value is refused with the page\'s words and stored nowhere; a name-shaped value of no known shape is told as a name', async () => {
  const house = await household('secrets');
  try {
    for (const secret of PASTED) for (const [action, outcome] of [['setValue', 'added'], ['setValue', 'replaced'], ['remove', 'removed']]) {
      const answer = await house.act(action, { secret, outcome });
      expect(answer, `${action} ${secret}`).toMatchObject({ ok: false });
      expect(JSON.stringify(answer), secret).toContain('That looks like a secret value, not a name.');
    }
    expect(PASTED.length).toBeGreaterThanOrEqual(10);
    for (const secret of [...ACCEPTED_NAMES.filter((name) => secretName.safeParse(name).success), 'x'.repeat(64), VALUE])
      expect(await house.act('setValue', { secret, outcome: 'added' }), secret).toMatchObject({ ok: true });
    const stored = house.stored(), read = JSON.stringify(await house.read()), brief = house.brief();
    for (const [where, text] of [['stored rows', stored], ['boards.read', read], ['brief', brief]]) for (const secret of PASTED) expect(text, `${where} ${secret}`).not.toContain(secret);
    // The residual risk, stated (docs/accepted-tradeoffs.md): this one is told, because nothing marks it as a value.
    expect(brief).toContain(`secret=${VALUE}.`);
  } finally { house.close(); }
});
