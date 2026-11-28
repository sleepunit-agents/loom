/** The `household` brick's definition (./household.ts), held to what it commits loom to. */
import { expect, it } from 'vitest';
import { catalogue } from '../bricks.js';
import { actRow, Refused } from '../model.js';
import { agent, empty, pins } from './bench.test.helper.js';
import { household } from './house.test.helper.js';
import definition, { tokenKinds } from './household.js';

it('household: whether it can be big, what it flags itself for, how it is named, and each action with its operation', () => {
  expect(pins(definition)).toEqual({
    big: true,
    flags: [],
    linkKey: null,
    references: {},
    actions: { revokeToken: 'token.revoke', revokeSession: 'sessions.revoke', setGrants: 'program.setGrants', token: 'signin.token' },
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
  expect(() => actRow(board, 'p1', 'token', {}), 'token').toThrow(Refused);
});

const BEARER = 'loom_' + 'S'.repeat(43), FINGERPRINT = 'f'.repeat(64);
it('a token made is told by its label and kind, and by nothing else', () => {
  const board = agent(empty(), [{ change: 'place', brick: 'household', params: {} }]).board;
  const ok = (detail: Record<string, unknown>) => { try { actRow(board, 'p1', 'token', detail); return true; } catch (e) { if (e instanceof Refused) return false; throw e; } };
  expect([...tokenKinds]).toEqual(['member', 'agent', 'machine', 'program']);
  for (const kind of tokenKinds) expect(ok({ label: 'pump-laptop', kind }), kind).toBe(true);
  for (const kind of ['owner', 'runner', 'job', 'Agent', '']) expect(ok({ label: 'pump-laptop', kind }), kind).toBe(false);
  // Both are needed, and nothing else is taken: not the value, its fingerprint, who it stands for or when it ends.
  for (const typed of [{ label: 'pump-laptop' }, { kind: 'agent' }, {}]) expect(ok(typed), JSON.stringify(typed)).toBe(false);
  for (const extra of [{ token: BEARER }, { value: BEARER }, { fingerprint: FINGERPRINT }, { agent: 'art' }, { member: 'sam' }, { box: 'shed' }, { expiresAt: '2027-01-01T00:00:00Z' }, { records: 'tasks' }])
    expect(ok({ label: 'pump-laptop', kind: 'agent', ...extra }), JSON.stringify(extra)).toBe(false);
  // A label is told as a reference: no sentence, no blank, no line break, nothing past 120.
  for (const label of ['Pump laptop', 'two words', 'line\nbreak', '', '-dash', 'x'.repeat(121), BEARER + ' ']) expect(ok({ label, kind: 'agent' }), JSON.stringify(label)).toBe(false);
  for (const label of ['pump-laptop', 'shed.pi', 'art@one', 'ci/runner:2', 'x'.repeat(120)]) expect(ok({ label, kind: 'machine' }), label).toBe(true);
  const entry = catalogue().find((b) => b.name === 'household')!.actions.token as { properties: object; additionalProperties: boolean; required: string[] };
  expect(Object.keys(entry.properties).sort()).toEqual(['kind', 'label']);
  expect([entry.additionalProperties, [...entry.required].sort()]).toEqual([false, ['kind', 'label']]);
});

it('through the real operations, a token made reaches the board and the agent\'s brief by label and kind, and its value is refused and stored nowhere', async () => {
  const house = await household('household');
  try {
    for (const typed of [{ label: 'pump-laptop', kind: 'agent', token: BEARER }, { label: BEARER + ' x', kind: 'agent' }, { label: 'pump-laptop', kind: 'agent', fingerprint: FINGERPRINT }, { token: BEARER }])
      expect(await house.act('token', typed), JSON.stringify(typed)).toMatchObject({ ok: false });
    expect(await house.act('token', { label: 'pump-laptop', kind: 'agent' })).toMatchObject({ ok: true });
    expect(await house.act('token', { label: 'shed.pi', kind: 'machine' })).toMatchObject({ ok: true });
    const stored = house.stored(), read = JSON.stringify(await house.read()), brief = house.brief();
    for (const [where, text] of [['stored rows', stored], ['boards.read', read], ['brief', brief]]) {
      expect(text, where).not.toContain(BEARER);
      expect(text, where).not.toContain('S'.repeat(43));
      expect(text, where).not.toContain(FINGERPRINT);
    }
    expect(brief).toContain('used token on household() on board');
    expect(brief).toContain(': kind=agent, label=pump-laptop.');
    expect(brief).toContain(': kind=machine, label=shed.pi.');
  } finally { house.close(); }
});
