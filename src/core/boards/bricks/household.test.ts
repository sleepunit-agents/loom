/** The `household` brick's definition (./household.ts), held to what it commits loom to. */
import { expect, it } from 'vitest';
import { catalogue } from '../bricks.js';
import { actRow, Refused } from '../model.js';
import { agent, empty, pins } from './bench.test.helper.js';
import { household } from '../house.fixture.js';
import { ACCEPTED_NAMES, REFUSED_BY_KIND, REFUSED_NAMES, SYNTHETIC_BEARER } from '../value-shape.fixture.js';
import { ref } from './kit.js';
import definition, { portraitOutcomes, tokenKinds } from './household.js';

it('household: whether it can be big, what it flags itself for, how it is named, and each action with its operation', () => {
  expect(pins(definition)).toEqual({
    big: true,
    flags: [],
    linkKey: null,
    references: {},
    actions: { revokeToken: 'token.revoke', revokeSession: 'sessions.revoke', setGrants: 'program.setGrants', setPortrait: 'household.setPortrait', token: 'signin.token' },
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
  for (const action of ['createToken', 'uploadPortrait', 'addMember']) expect(() => actRow(board, 'p1', action, {}), action).toThrow(Refused);
  expect(() => actRow(board, 'p1', 'token', {}), 'token').toThrow(Refused);
});

const BEARER = SYNTHETIC_BEARER, FINGERPRINT = 'f'.repeat(64);
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
  // A label in the shape of a secret value: every synthetic credential the one fixture list holds that a reference's
  // shape would take (../value-shape.fixture.ts), one of each kind among them; and every name it lists is taken.
  const refused = REFUSED_NAMES.filter((label) => ref.safeParse(label).success);
  for (const value of Object.values(REFUSED_BY_KIND)) expect(refused, value).toContain(value);
  for (const label of refused) expect(ok({ label, kind: 'agent' }), label).toBe(false);
  const accepted = ACCEPTED_NAMES.filter((label) => ref.safeParse(label).success);
  expect(accepted).toEqual(ACCEPTED_NAMES);
  for (const label of [...accepted, 'pump-laptop', 'x'.repeat(120)]) expect(ok({ label, kind: 'machine' }), label).toBe(true);
  const entry = catalogue().find((b) => b.name === 'household')!.actions.token as { properties: object; additionalProperties: boolean; required: string[] };
  expect(Object.keys(entry.properties).sort()).toEqual(['kind', 'label']);
  expect([entry.additionalProperties, [...entry.required].sort()]).toEqual([false, ['kind', 'label']]);
});

it('through the real operations, a token made reaches the board and the agent\'s brief by label and kind, and its value, beside the label or as the label, is refused and stored nowhere', async () => {
  const house = await household('household');
  try {
    for (const typed of [{ label: 'pump-laptop', kind: 'agent', token: BEARER }, { label: BEARER + ' x', kind: 'agent' }, { label: BEARER, kind: 'agent' }, { label: 'laptop/' + BEARER, kind: 'machine' }, { label: 'pump-laptop', kind: 'agent', fingerprint: FINGERPRINT }, { token: BEARER }])
      expect(await house.act('token', typed), JSON.stringify(typed)).toMatchObject({ ok: false });
    expect(JSON.stringify(await house.act('token', { label: BEARER, kind: 'agent' }))).toContain('That looks like a secret value, not a name.');
    expect(await house.act('token', { label: 'pump-laptop', kind: 'agent' })).toMatchObject({ ok: true });
    expect(await house.act('token', { label: 'shed.pi', kind: 'machine' })).toMatchObject({ ok: true });
    const stored = house.stored(), read = JSON.stringify(await house.read()), brief = house.brief();
    for (const [where, text] of [['stored rows', stored], ['boards.read', read], ['brief', brief]]) {
      expect(text, where).not.toContain(BEARER);
      expect(text, where).not.toContain(BEARER.slice(5));
      expect(text, where).not.toContain(FINGERPRINT);
    }
    expect(brief).toContain('used token on household() on board');
    expect(brief).toContain(': kind=agent, label=pump-laptop.');
    expect(brief).toContain(': kind=machine, label=shed.pi.');
  } finally { house.close(); }
});

it('a portrait changed is told by the agent and whether it was uploaded or restored, and by nothing of its files', () => {
  const board = agent(empty(), [{ change: 'place', brick: 'household', params: {} }]).board;
  const ok = (detail: Record<string, unknown>) => { try { actRow(board, 'p1', 'setPortrait', detail); return true; } catch (e) { if (e instanceof Refused) return false; throw e; } };
  expect([...portraitOutcomes]).toEqual(['uploaded', 'restored']);
  for (const outcome of portraitOutcomes) for (const id of ['art', 'fern', 'agent.two', 'a'.repeat(120)]) expect(ok({ agent: id, outcome }), `${id} ${outcome}`).toBe(true);
  for (const outcome of ['removed', 'saved', 'Uploaded', '', 'sheet.png']) expect(ok({ agent: 'art', outcome }), outcome).toBe(false);
  // The agent in the shape of an id, no sentence and nothing past 120.
  for (const id of ['two words', 'art\n', '', '-art', 'a'.repeat(121), 'sheet.png contents']) expect(ok({ agent: id, outcome: 'uploaded' }), JSON.stringify(id)).toBe(false);
  // Both are needed, and nothing of the files is taken: no name, size, type, contents, layout or version.
  for (const typed of [{ agent: 'art' }, { outcome: 'uploaded' }, {}]) expect(ok(typed), JSON.stringify(typed)).toBe(false);
  for (const extra of [{ file: 'sheet.png' }, { name: 'fern.png' }, { size: '1024' }, { type: 'image/png' }, { png: 'iVBORw0KGgo=' }, { layout: '{}' }, { metadata: '{"spritesheet":{}}' }, { version: 'v2' }, { frames: '4' }])
    expect(ok({ agent: 'art', outcome: 'uploaded', ...extra }), JSON.stringify(extra)).toBe(false);
  const entry = catalogue().find((b) => b.name === 'household')!.actions.setPortrait as { properties: Record<string, { enum?: string[] }>; additionalProperties: boolean; required: string[] };
  expect(Object.keys(entry.properties).sort()).toEqual(['agent', 'outcome']);
  expect(entry.properties.outcome.enum).toEqual(['uploaded', 'restored']);
  expect([entry.additionalProperties, [...entry.required].sort()]).toEqual([false, ['agent', 'outcome']]);
});

it('through the real operations, a portrait changed reaches the board and the agent\'s brief by agent and outcome, and a file\'s name or contents is refused and stored nowhere', async () => {
  const house = await household('household');
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk', FILE = 'fern-portrait-sheet.png';
  try {
    for (const typed of [{ agent: 'fern', outcome: 'uploaded', png: PNG }, { agent: 'fern', outcome: 'uploaded', file: FILE }, { agent: FILE + ' x', outcome: 'uploaded' }, { agent: 'fern', outcome: PNG }])
      expect(await house.act('setPortrait', typed), JSON.stringify(typed)).toMatchObject({ ok: false });
    expect(await house.act('setPortrait', { agent: 'fern', outcome: 'uploaded' })).toMatchObject({ ok: true });
    expect(await house.act('setPortrait', { agent: 'moss', outcome: 'restored' })).toMatchObject({ ok: true });
    const stored = house.stored(), read = JSON.stringify(await house.read()), brief = house.brief();
    for (const [where, text] of [['stored rows', stored], ['boards.read', read], ['brief', brief]]) {
      expect(text, where).not.toContain(PNG);
      expect(text, where).not.toContain(FILE);
    }
    expect(brief).toContain(': agent=fern, outcome=uploaded.');
    expect(brief).toContain(': agent=moss, outcome=restored.');
  } finally { house.close(); }
});
