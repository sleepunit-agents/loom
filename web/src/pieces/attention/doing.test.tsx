import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Existing renderer dependency has no bundled declarations.
import { act, create } from 'react-test-renderer';
import { Doing, doingMeta, doingPhrase, doingReading, sinceWord, type DoingItem, type DoingReading } from './doing';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
type Node = { children: Array<Node | string>; props: Record<string, any>; type: unknown };
const item = (kind: string, fields: Partial<DoingItem> = {}): DoingItem => ({ id: `id-${kind}`, kind, title: null, with: null, place: null, direct: null, ref: null,
  machine: null, since: '2026-11-19T20:15:00.000Z', state: 'running', href: null, ...fields });
const words = (node: Node | string): string => typeof node === 'string' ? node : (node.children ?? []).map(words).join('');
let tree: ReturnType<typeof create> | undefined;
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; });
const draw = async (doing: DoingReading, props: Record<string, unknown> = {}) => { const go = vi.fn();
  await act(async () => { tree = create(h(Doing, { doing, name: 'Art', go, ...props })); }); return go; };
const live = (items: DoingItem[], more = 0): DoingReading => ({ status: 'live', items, more });

it.each([
  ['At a terminal on loom · claude · loom', item('terminal', { title: 'loom · claude · loom' })],
  ['At a terminal', item('terminal')],
  ['Talking on Discord with Mark', item('discord', { with: 'mark', direct: 'person', title: 'Discord direct message with mark' })],
  ['Talking on Discord in #pond', item('discord', { place: '#pond', title: 'Discord channel #pond' })],
  ['Talking on Discord in a direct message', item('discord', { direct: 'person' })],
  ['Talking on Discord in a group direct message', item('discord', { direct: 'group' })],
  ['Talking on Slack in #foo', item('slack', { place: '#foo' })],
  ['Talking on Slack with Sam', item('slack', { with: 'sam', direct: 'person' })],
  ['Talking on Slack in a channel', item('slack', { title: '171.5' })],
  ['Talking with Jonathan in loom', item('loom', { with: 'jonathan', title: 'Pump' })],
  ['Talking in loom', item('loom')],
  ['Running Plan the night', item('trigger', { title: 'Plan the night' })],
  ['Working on Order the pump · t-2190', item('task', { title: 'Order the pump', ref: 't-2190' })],
  ['Taking a hand-off from Mark · Check the pump', item('handoff', { with: 'mark', title: 'Check the pump' })],
  ['Taking a hand-off · Check the pump', item('handoff', { title: 'Check the pump' })],
  ['On a wake · The sweep', item('wake', { title: 'The sweep' })],
  ['On a wake', item('wake')],
  ['Rebuild the index', item('job', { title: 'Rebuild the index' })],
  ['Running a job', item('something-new')],
  ['In a private conversation', item('private')],
])('says "%s" from its parts', (sentence, parts) => { expect(doingPhrase(parts)).toBe(sentence); });

it('takes a display name where it is given one, and says since when, where and a state that is not simply running', () => {
  expect(doingPhrase(item('loom', { with: 'jb' }), id => id === 'jb' ? 'Jonathan' : id)).toBe('Talking with Jonathan in loom');
  const now = Date.parse('2026-11-19T22:00:00.000Z');
  expect(sinceWord('2026-11-19T20:15:00.000Z', now)).toBe('2:15 PM');
  expect(sinceWord('2026-11-18T20:15:00.000Z', now)).toBe('Nov 18, 2:15 PM');
  expect(doingMeta(item('job'), now)).toBe('since 2:15 PM');
  expect(doingMeta(item('job', { machine: 'one', state: 'queued' }), now)).toBe('Queued · on one · since 2:15 PM');
  expect(doingMeta(item('job', { state: 'starting' }), now)).toBe('Starting · since 2:15 PM');
  expect(doingMeta(item('task', { state: 'in_progress' }), now)).toBe('since 2:15 PM');
});

it('shows one quiet line with nothing to show, and no heading or count', async () => {
  await draw(live([]));
  expect(words(tree!.toJSON() as Node)).toBe('Nothing right now.');
  expect(tree!.root.findAllByType('ul')).toHaveLength(0);
  expect(JSON.stringify(tree!.toJSON())).not.toMatch(/Runtime jobs|Current jobs|· 0/);
});

it('opens what a pill names through go, and leaves a pill with nowhere to go as plain text', async () => {
  const go = await draw(live([item('task', { title: 'Order the pump', ref: 't-2190', href: '/p/tasks-preview/task/t-2190' }), item('private'), item('job', { title: 'Rebuild' })], 3));
  const rows = tree!.root.findAllByType('li');
  expect(rows.map((row: Node) => row.props['data-kind'])).toEqual(['task', 'private', 'job', undefined]);
  expect(words(rows[3])).toBe('+3 more');
  const link = rows[0].findByType('a'); expect(link.props.href).toBe('/p/tasks-preview/task/t-2190');
  const preventDefault = vi.fn(); await act(async () => link.props.onClick({ button: 0, preventDefault }));
  expect(preventDefault).toHaveBeenCalled(); expect(go).toHaveBeenCalledWith('/p/tasks-preview/task/t-2190');
  // A modified click is the browser's.
  go.mockClear(); await act(async () => link.props.onClick({ button: 0, metaKey: true, preventDefault })); expect(go).not.toHaveBeenCalled();
  for (const row of rows.slice(1, 3)) { expect(row.findAllByType('a')).toHaveLength(0); expect(row.findAllByType('button')).toHaveLength(0); }
  expect(words(rows[1])).toContain('In a private conversation');
});

it('reads nothing from a selection that is not live or not whole', () => {
  expect(doingReading({ status: 'loading' })).toEqual({ status: 'loading', items: [], more: 0 });
  expect(doingReading({ status: 'denied', data: { agentDoing: { items: [item('job')], more: 0 } } })).toEqual({ status: 'denied', items: [], more: 0 });
  expect(doingReading({ status: 'live', data: { agentDoing: null } })).toEqual({ status: 'offline', items: [], more: 0 });
  expect(doingReading({ status: 'live', data: { agentDoing: { items: [item('job')], more: 1 } } })).toMatchObject({ status: 'live', more: 1, items: [{ kind: 'job' }] });
});
