/** The `secrets` brick (docs/specs/boards.md, "The first bricks"): the household's secrets from the desktop
 * Settings' selection, for an owner, and its changes by Settings' own calls. Above all what happens to a VALUE:
 * typed into a password field, sent once to `/api/secrets/set` by the desktop's helper, and found nowhere else.
 * The fields here are stand-ins for the browser's (the test renderer has none), held by the same refs. */
import { createElement as h } from 'react';
// @ts-expect-error Renderer does not ship declarations.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const feed = vi.hoisted(() => vi.fn());
vi.mock('../data/graphql', () => ({ useDataQuery: feed }));
import { settingsQuery } from '../pieces/settings/data';
import { bricks, loadBricks } from './bricks';
import { Frame } from './brick-kit';
import type { Form } from './layout';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

await loadBricks();

type Node = { type: string; props: Record<string, any>; children: (Node | string)[]; findAll(match: (node: Node) => boolean): Node[]; findAllByType(type: string): Node[] };
const VALUE = 'synthetic-private-value-7Q';
const reported = vi.fn(), raised = vi.fn(), requests: { url: string; body: any }[] = [];
const world = { reply: () => ({ status: 200, body: { ok: true, value: { saved: true } } as unknown }), fields: new Map<string, { value: string }>() };
let tree: { root: Node; toJSON(): unknown; update(element: unknown): void; unmount(): void } | undefined;
const said = (node: Node | string): string => (typeof node === 'string' ? node : node.children.map(said).join(''));
const element = (form: Form) => h(bricks.secrets.Body, { params: {}, form, act: reported, raise: raised });
/** The browser's field behind each input, by its label: what a ref to it holds. */
const createNodeMock = (made: { type: string; props: Record<string, any> }) => {
  if (made.type !== 'input' || made.props.type === 'checkbox') return {};
  const field = { value: String(made.props.defaultValue ?? '') };
  world.fields.set(made.props['aria-label'], field);
  return field;
};
const draw = (form: Form) => act(async () => { tree?.unmount(); world.fields.clear(); tree = create(element(form), { createNodeMock }); });
const redraw = (form: Form) => act(async () => tree!.update(element(form)));
const all = () => said(tree!.root);
/** Everything React drew and holds as props. A ref is left out: here it is the stand-in for the browser's own field,
 * the one place a value is while it is being typed; what that field holds is checked by name in each test. */
const text = () => JSON.stringify(tree!.toJSON(), (key, value) => (key === 'ref' ? undefined : value));
const buttons = () => tree!.root.findAllByType('button').filter((b) => !b.props['data-place']);
const button = (label: string) => buttons().find((b) => said(b) === label || b.props['aria-label'] === label)!;
const press = (label: string) => act(async () => { await button(label).props.onClick(); });
const submit = (label: string) => act(async () => { tree!.root.findAll((node) => node.type === 'form' && node.props['aria-label'] === label)[0].props.onSubmit({ preventDefault() {} }); });
const controls = () => tree!.root.findAll((node) => ['button', 'input', 'textarea', 'form', 'a', 'select'].includes(node.type) && !node.props['data-place']);
const placed = () => tree!.root.findAll((node) => !!node.props['data-place']).map((node) => JSON.parse(node.props['data-place']));

const data = (over: object = {}) => ({
  secretsReader: { id: 'sam', defaultAnswer: 'ask' },
  secrets: [{ name: 'PUMP_TOKEN', description: 'The pond pump', changedAt: '2026-11-20T10:00:00Z', changedBy: 'sam' }, { name: 'MAIL_KEY', description: '', changedAt: '2026-11-21T10:00:00Z', changedBy: 'robin' }],
  secretGrants: [{ id: 'g-1', secret: 'PUMP_TOKEN', agent: 'art', job: null, request: 'r-0', grantedBy: 'sam', grantedAt: '2026-11-22T10:00:00Z', expiresAt: '2026-11-22T10:30:00Z' }],
  secretRequests: [
    { id: 'r-1', secret: 'MAIL_KEY', agent: 'art', job: 'j-9', conversation: null, why: 'To read the pump mail', state: 'pending', minutes: 30, answeredBy: null, always: false, askedAt: '2026-11-23T10:00:00Z', answeredAt: null },
    { id: 'r-0', secret: 'PUMP_TOKEN', agent: 'art', job: null, conversation: null, why: 'To start the pump', state: 'allowed', minutes: 30, answeredBy: 'sam', always: true, askedAt: '2026-11-22T10:00:00Z', answeredAt: '2026-11-22T10:00:00Z' },
  ],
  secretRules: [{ secret: 'PUMP_TOKEN', answer: 'auto', minutes: 45 }],
  secretRuleAgents: [{ secret: 'PUMP_TOKEN', agent: 'art', when: 'at_start' }],
  secretUses: [{ id: 'u-1', secret: 'PUMP_TOKEN', agent: 'art', job: 'j-1', at: '2026-11-22T10:05:00Z', state: 'released' }],
  secretChanges: [],
  ...over,
});
function answer(read: object) { feed.mockImplementation((query: string) => (query === settingsQuery ? read : { status: 'live', data: { deskTime: { timezone: 'UTC' } } })); }
const live = (over: object = {}) => answer({ status: 'live', data: data(over) });

beforeEach(() => {
  feed.mockReset(); reported.mockReset(); raised.mockReset(); requests.length = 0;
  world.reply = () => ({ status: 200, body: { ok: true, value: { saved: true } } });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: string }) => {
    requests.push({ url, body: JSON.parse(init.body) });
    const { status, body } = world.reply();
    return { ok: status < 400, status, json: async () => body };
  }));
});
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; vi.unstubAllGlobals(); });

it('lists the secrets by name with their rule, who may use them and their use, and the requests, from Settings\' selection', async () => {
  live();
  await draw('primary');
  expect(feed.mock.calls.some(([query, , options]) => query === settingsQuery && options?.keep === true)).toBe(true);
  for (const shown of ['2 secrets · 1 request waiting · 1 grant', 'For a secret with no rule', 'Ask each time.', 'ask your agent in this conversation to propose it', 'PUMP_TOKEN', 'The pond pump', 'by sam', 'Standing answer: Allow automatically · Automatic grant: 45 minutes', 'At startup',
    'may use it · Agent-wide', 'Granted by sam', 'Delivered', 'MAIL_KEY', 'by robin', 'No rule of its own: the household default applies.', 'asks for', 'To read the pump mail', '30 minutes', 'Job: j-9', 'Earlier requests', 'allowed', 'A standing rule was made with this answer.']) expect(all(), shown).toContain(shown);
  expect(placed().every((place) => JSON.stringify(place) === '{"brick":"agent","params":{"agent":"art"}}')).toBe(true);
  expect(placed().length).toBeGreaterThan(0);
  expect(tree!.root.findAll((node) => node.type === 'select')).toEqual([]);
  expect(bricks.secrets.title({})).toBe('Secrets');
  expect(bricks.secrets.sub({})).toBe('');
  expect(requests).toEqual([]);
});

it('the small forms count and say what waits, and hold no control', async () => {
  live();
  await draw('side');
  for (const shown of ['2 secrets · 1 request waiting · 1 grant', 'asks for', 'MAIL_KEY']) expect(all(), shown).toContain(shown);
  // A secret nobody is asking for is named in the big form only.
  expect(all()).not.toContain('PUMP_TOKEN');
  expect(all()).not.toContain('To read the pump mail');
  expect(controls()).toEqual([]);
  await draw('compact');
  const json = tree!.toJSON() as { type: string; props: { className: string } };
  expect(json.type).toBe('p'); expect(json.props.className).toBe('board-brief');
  expect(all()).toBe('2 secrets · 1 request waiting');
  expect(controls()).toEqual([]);
  live({ secrets: [], secretRequests: [], secretGrants: [] });
  await draw('compact');
  expect(all()).toBe('No secrets · no request waiting');
});

it('draws the unavailable line and nothing else for a member who is not an owner, and when it cannot be read', async () => {
  for (const form of ['primary', 'side', 'compact'] as const) {
    answer({ status: 'loading' });
    await draw(form);
    expect(all(), form).toBe('Loading…');
    // The server answers secretsReader for an owner only. Whatever else a reply held, nothing of it is drawn.
    for (const read of [{ status: 'live', data: data({ secretsReader: null }) }, { status: 'denied' }, { status: 'offline', data: data() }]) {
      answer(read);
      await draw(form);
      expect(all(), form).toBe('This list of secrets is unavailable.');
      expect(controls()).toEqual([]);
      expect(text()).not.toContain('PUMP_TOKEN');
    }
  }
  expect(requests).toEqual([]);
  expect(raised).not.toHaveBeenCalled();
});

it('changes nothing from a remembered reading: while its placement is getting new data every control waits', async () => {
  live();
  const drawn = (settling: boolean) => h(Frame.Provider, { value: { settling } }, element('primary'));
  await act(async () => { tree?.unmount(); world.fields.clear(); tree = create(drawn(true), { createNodeMock }); });
  expect(buttons().length).toBeGreaterThan(4);
  expect(buttons().every((b) => b.props.disabled === true)).toBe(true);
  expect(tree!.root.findAll((node) => node.type === 'input' && node.props.type === 'checkbox').every((box) => box.props.disabled === true)).toBe(true);
  await act(async () => { tree!.update(drawn(false)); });
  expect(buttons().some((b) => b.props.disabled === true)).toBe(false);
  expect(reported).not.toHaveBeenCalled();
});

it('allows, denies and cancels a waiting request and revokes a grant by Settings\' command, telling the board only which action', async () => {
  live();
  await draw('primary');
  await press('Allow art: MAIL_KEY');
  await press('Deny art: MAIL_KEY');
  await act(async () => tree!.root.findAll((node) => node.type === 'input' && node.props.type === 'checkbox')[0].props.onChange({ target: { checked: true } }));
  await press('Allow art: MAIL_KEY');
  await press('Cancel request art: MAIL_KEY');
  await press("Revoke art's grant of PUMP_TOKEN");
  expect(requests.map((r) => [r.url, r.body.input])).toEqual([
    ['/api/secrets/command', { action: 'answer', id: 'r-1', allow: true, always: false }], ['/api/secrets/command', { action: 'answer', id: 'r-1', allow: false, always: false }],
    ['/api/secrets/command', { action: 'answer', id: 'r-1', allow: true, always: true }], ['/api/secrets/command', { action: 'cancel', id: 'r-1' }], ['/api/secrets/command', { action: 'revoke', id: 'g-1' }],
  ]);
  expect(reported.mock.calls).toEqual([['allow', {}], ['deny', {}], ['allow', {}], ['cancel', {}], ['revoke', {}]]);
  expect(all()).toContain('Saved.');
});

it('removes a secret only after asking', async () => {
  live();
  await draw('primary');
  await press('Remove PUMP_TOKEN');
  expect(all()).toContain("Remove this secret's value and revoke every access to it? It cannot be brought back.");
  expect(requests).toEqual([]);
  await press('Keep');
  expect(all()).not.toContain('It cannot be brought back.');
  expect(requests).toEqual([]);
  await press('Remove PUMP_TOKEN');
  await press('Remove value and revoke access');
  expect(requests.map((r) => [r.url, Object.keys(r.body.input).sort(), r.body.input.name])).toEqual([['/api/secrets/remove', ['id', 'name'], 'PUMP_TOKEN']]);
  // Removed and acknowledged: the board is told which secret, and that it was removed.
  expect(reported.mock.calls).toEqual([['remove', { secret: 'PUMP_TOKEN', outcome: 'removed' }]]);
});

it('a change that is not acknowledged says only that, shows nothing of the reply, and reports nothing', async () => {
  live();
  await draw('primary');
  world.reply = () => ({ status: 409, body: { ok: false, message: 'PRIVATE UPSTREAM WORDS' } });
  await press('Allow art: MAIL_KEY');
  expect(all()).toContain('Change not confirmed. Check the current item before starting a new change.');
  expect(text()).not.toContain('PRIVATE');
  expect(reported).not.toHaveBeenCalled();
});

it('a value goes from a password field to /api/secrets/set once, by the desktop\'s helper, and is found nowhere else', async () => {
  const logged: unknown[][] = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, level).mockImplementation((...words: unknown[]) => { logged.push(words); });
  live();
  await draw('primary');
  await press('Replace the value of PUMP_TOKEN');
  const input = tree!.root.findAll((node) => node.type === 'input' && node.props['aria-label'] === 'Value')[0];
  // As the desktop has it: a password field the browser is told not to fill, with no value or handler of React's.
  expect(input.props).toMatchObject({ type: 'password', autoComplete: 'new-password', spellCheck: false, required: true });
  for (const held of ['value', 'defaultValue', 'onChange', 'onInput', 'name']) expect(input.props, held).not.toHaveProperty(held);
  expect(all()).toContain('The value is write-only. It cannot be read back here.');
  const field = world.fields.get('Value')!;
  field.value = VALUE; world.fields.get('Description')!.value = 'The pond pump, new';
  await redraw('primary');
  expect(text()).not.toContain(VALUE);
  let finish!: () => void;
  const held = new Promise<void>((resolve) => { finish = resolve; });
  const reply = world.reply;
  (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async (url: string, init: { body: string }) => {
    requests.push({ url, body: JSON.parse(init.body) });
    expect(field.value).toBe(''); // emptied before the request was made
    await held;
    return { ok: true, status: 200, json: async () => reply().body };
  });
  await submit('Replace PUMP_TOKEN');
  // While the request is in flight the field is already empty and nothing drawn holds the value.
  expect(field.value).toBe('');
  expect(text()).not.toContain(VALUE);
  expect(reported).not.toHaveBeenCalled();
  await act(async () => { finish(); });
  expect(requests).toHaveLength(1);
  expect(requests[0].url).toBe('/api/secrets/set');
  expect(requests[0].body.input).toMatchObject({ name: 'PUMP_TOKEN', description: 'The pond pump, new', mode: 'replace', value: VALUE });
  expect(Object.keys(requests[0].body.input).sort()).toEqual(['description', 'id', 'mode', 'name', 'value']);
  // The board is told which secret and that its value was replaced: no description, no value.
  expect(reported.mock.calls).toEqual([['setValue', { secret: 'PUMP_TOKEN', outcome: 'replaced' }]]);
  expect(JSON.stringify(reported.mock.calls)).not.toContain('The pond pump, new');
  expect(JSON.stringify(reported.mock.calls)).not.toContain(VALUE);
  expect(JSON.stringify(raised.mock.calls)).not.toContain(VALUE);
  expect(text()).not.toContain(VALUE);
  expect(all()).toContain('Saved.');
  // The form is gone once the change is acknowledged.
  expect(tree!.root.findAll((node) => node.type === 'input' && node.props.type === 'password')).toEqual([]);
  expect(JSON.stringify(logged)).not.toContain(VALUE);
  expect(JSON.stringify(feed.mock.calls)).not.toContain(VALUE);
});

it('adds a secret by the same path, and a value that was not confirmed is not kept, shown or sent again', async () => {
  live();
  await draw('primary');
  await press('Add a secret…');
  await submit('Add a secret');
  expect(requests).toEqual([]); // nothing typed: nothing sent
  world.fields.get('Name')!.value = 'NEW_KEY'; world.fields.get('Description')!.value = 'A new one'; world.fields.get('Value')!.value = VALUE;
  world.reply = () => ({ status: 503, body: { ok: false, message: VALUE } });
  await submit('Add a secret');
  expect(requests).toHaveLength(1);
  expect(requests[0].body.input).toMatchObject({ name: 'NEW_KEY', description: 'A new one', mode: 'add', value: VALUE });
  expect(world.fields.get('Value')!.value).toBe('');
  expect(all()).toContain('Change not confirmed. Check the current item before starting a new change.');
  expect(text()).not.toContain(VALUE);
  expect(reported).not.toHaveBeenCalled();
  await submit('Add a secret');
  expect(requests).toHaveLength(1); // the field is empty: there is nothing to send, and nothing is replayed
  await press('Cancel');
  expect(tree!.root.findAllByType('form')).toEqual([]);
});

it('flags itself when a new request arrives, and not for an answer', async () => {
  live({ secretRequests: [] });
  await draw('side');
  live();
  await redraw('side');
  expect(raised.mock.calls).toEqual([['New request']]);
  live({ secretRequests: [] });
  await redraw('side');
  expect(raised).toHaveBeenCalledOnce();
});

it('adds a secret and, once loom acknowledged it, tells the board its name and "added", and nothing typed beside the name', async () => {
  live();
  await draw('primary');
  await press('Add a secret…');
  world.fields.get('Name')!.value = 'NEW_KEY'; world.fields.get('Description')!.value = 'A private description'; world.fields.get('Value')!.value = VALUE;
  await submit('Add a secret');
  expect(requests.map((r) => [r.url, r.body.input.mode, r.body.input.name])).toEqual([['/api/secrets/set', 'add', 'NEW_KEY']]);
  expect(reported.mock.calls).toEqual([['setValue', { secret: 'NEW_KEY', outcome: 'added' }]]);
  for (const typed of [VALUE, 'A private description']) {
    expect(JSON.stringify(reported.mock.calls), typed).not.toContain(typed);
    expect(JSON.stringify(raised.mock.calls), typed).not.toContain(typed);
    expect(JSON.stringify(feed.mock.calls), typed).not.toContain(typed);
    expect(text(), typed).not.toContain(typed);
  }
  expect(all()).toContain('Saved.');
});

it('tells the board nothing when a value set or a removal is refused or not confirmed, for each outcome', async () => {
  for (const status of [403, 409, 503]) {
    live();
    await draw('primary');
    world.reply = () => ({ status, body: { ok: false, message: 'PRIVATE UPSTREAM WORDS' } });
    await press('Add a secret…');
    world.fields.get('Name')!.value = 'NEW_KEY'; world.fields.get('Value')!.value = VALUE;
    await submit('Add a secret');
    await press('Cancel');
    await press('Replace the value of PUMP_TOKEN');
    world.fields.get('Value')!.value = VALUE;
    await submit('Replace PUMP_TOKEN');
    await press('Cancel');
    await press('Remove MAIL_KEY');
    await press('Remove value and revoke access');
    expect(requests.map((r) => r.url).slice(-3), String(status)).toEqual(['/api/secrets/set', '/api/secrets/set', '/api/secrets/remove']);
    expect(all()).toContain('Change not confirmed.');
    expect(text()).not.toContain('PRIVATE');
  }
  // A reply that is 200 but does not say saved is not an acknowledgement either.
  live();
  await draw('primary');
  world.reply = () => ({ status: 200, body: { ok: true, value: { saved: false } } });
  await press('Remove PUMP_TOKEN');
  await press('Remove value and revoke access');
  expect(reported).not.toHaveBeenCalled();
});

it('sends nothing for a name the secrets store would refuse, so the board is never told one', async () => {
  live();
  await draw('primary');
  await press('Add a secret…');
  for (const name of ['two words', '-dash', 'a/b', 'x'.repeat(65)]) {
    world.fields.get('Name')!.value = name; world.fields.get('Value')!.value = VALUE;
    await submit('Add a secret');
    expect(world.fields.get('Value')!.value, name).toBe(VALUE); // nothing was read out of the field
  }
  expect(requests).toEqual([]);
  expect(reported).not.toHaveBeenCalled();
});
