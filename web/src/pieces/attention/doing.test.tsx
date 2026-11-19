import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Existing renderer dependency has no bundled declarations.
import { act, create } from 'react-test-renderer';
import { busyCount, claimedPath, Doing, doingMeta, doingPhrase, doingReading, sinceWord, type DoingItem, type DoingReading } from './doing';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
type Node = { children: Array<Node | string>; props: Record<string, any>; type: unknown };
const item = (kind: string, fields: Partial<DoingItem> = {}): DoingItem => ({ id: `id-${kind}`, kind, title: null, with: null, place: null, direct: null, ref: null,
  machine: null, since: '2026-11-19T20:15:00.000Z', state: 'running', href: null, ...fields });
const words = (node: Node | string): string => typeof node === 'string' ? node : (node.children ?? []).map(words).join('');
let tree: ReturnType<typeof create> | undefined;
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; });
const draw = async (doing: DoingReading, props: Record<string, unknown> = {}) => { const go = vi.fn();
  await act(async () => { tree = create(h(Doing, { doing, name: 'Art', go, ...props })); }); return go; };
const live = (items: DoingItem[], more = 0, claimed = 0): DoingReading => ({ status: 'live', items, more, claimed });

it.each([
  ['At a terminal on loom · claude · loom', item('terminal', { machine: 'loom', title: 'claude · loom' })],
  ['At a terminal · claude · loom', item('terminal', { title: 'claude · loom' })],
  ['At a terminal on loom', item('terminal', { machine: 'loom' })],
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
  // A task says when it was last touched; a terminal's machine is in its phrase, not said twice.
  expect(doingMeta(item('task', { state: 'in_progress', ref: 't-7' }), now)).toBe('touched 2:15 PM');
  expect(doingMeta(item('terminal', { machine: 'loom' }), now)).toBe('since 2:15 PM');
  // A job in the conversation a task was filed from names the task, quietly.
  expect(doingMeta(item('loom', { ref: 't-2190', task: 'Order the pump', machine: 'one' }), now)).toBe('t-2190 · Order the pump · on one · since 2:15 PM');
  // A job nothing has been heard from says so, with its true state.
  expect(doingMeta(item('job', { state: 'running', quietSince: '2026-11-14T20:15:00.000Z' }), now)).toBe('no word since Nov 14, 2:15 PM');
  expect(doingMeta(item('job', { state: 'queued', quietSince: '2026-11-14T20:15:00.000Z' }), now)).toBe('Queued · no word since Nov 14, 2:15 PM');
});

it('shows one quiet line with nothing to show, and no heading or count', async () => {
  await draw(live([]));
  expect(words(tree!.toJSON() as Node)).toBe('Nothing right now.');
  expect(tree!.root.findAllByProps({ className: 'desk-doing-claimed' })).toHaveLength(0);
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
  expect(doingReading({ status: 'loading' })).toEqual({ status: 'loading', items: [], more: 0, claimed: 0 });
  expect(doingReading({ status: 'denied', data: { agentDoing: { items: [item('job')], more: 0 } } })).toEqual({ status: 'denied', items: [], more: 0, claimed: 0 });
  expect(doingReading({ status: 'live', data: { agentDoing: null } })).toEqual({ status: 'offline', items: [], more: 0, claimed: 0 });
  expect(doingReading({ status: 'live', data: { agentDoing: { items: [item('job')], more: 1, claimed: 52 } } })).toMatchObject({ status: 'live', more: 1, claimed: 52, items: [{ kind: 'job' }] });
});

it('says the tasks an agent has only claimed in one quiet line under the pills, opening Tasks on them, and never counts them as more', async () => {
  const go = await draw(live([item('job', { title: 'Rebuild' })], 0, 54), { agent: 'art/1' });
  const line = tree!.root.findByProps({ className: 'desk-doing-claimed' });
  expect(words(line)).toBe('54 tasks in progress ›'); expect(line.props.href).toBe('/p/tasks-preview/?folder=progress&assignee=art%2F1');
  expect(claimedPath('art')).toBe('/p/tasks-preview/?folder=progress&assignee=art');
  const preventDefault = vi.fn(); await act(async () => line.props.onClick({ button: 0, preventDefault }));
  expect(preventDefault).toHaveBeenCalled(); expect(go).toHaveBeenCalledWith('/p/tasks-preview/?folder=progress&assignee=art%2F1');
  expect(JSON.stringify(tree!.toJSON())).not.toContain(' more');
  // With no pill at all the line still stands, under "Nothing right now."; one task is singular.
  await act(async () => tree!.update(h(Doing, { doing: live([], 0, 1), name: 'Art', agent: 'art', go })));
  expect(JSON.stringify(tree!.toJSON())).toContain('Nothing right now.'); expect(words(tree!.root.findByProps({ className: 'desk-doing-claimed' }))).toBe('1 task in progress ›');
  // None, or a compact card (the rail, a folded card): no line.
  await act(async () => tree!.update(h(Doing, { doing: live([item('job')], 0, 0), name: 'Art', agent: 'art', go })));
  expect(tree!.root.findAllByProps({ className: 'desk-doing-claimed' })).toHaveLength(0);
  await act(async () => tree!.update(h(Doing, { doing: live([item('job')], 0, 54), name: 'Art', agent: 'art', go, compact: true })));
  expect(tree!.root.findAllByProps({ className: 'desk-doing-claimed' })).toHaveLength(0);
});

it('says what an agent is waiting to be woken for, quietly, and does not count a wait as work', async () => {
  const wait = item('waiting', { id: 'tr-wake-1', title: 'checks on sleepunit-agents/loom#33', state: 'standing', href: '/p/tempo' });
  expect(doingPhrase(wait)).toBe('Waiting on checks on sleepunit-agents/loom#33');
  expect(doingPhrase(item('waiting', { ref: '2026-11-14T20:15:00.000Z' }))).toBe('Waiting until Nov 14, 2:15 PM');
  expect(doingPhrase(item('waiting'))).toBe('Waiting to be woken');
  // When it asked, not a task reference; and no "since", which is for something running.
  expect(doingMeta(item('waiting', { ref: '2026-11-14T20:15:00.000Z', state: 'standing' }), Date.parse('2026-11-19T21:00:00.000Z'))).toBe('asked 2:15 PM');
  expect(busyCount([wait, item('loom'), item('task')])).toBe(2);
  expect(busyCount([wait])).toBe(0);
  const go = await draw(live([item('loom', { href: '/p/comms-preview/thread/1' }), wait]));
  const pills = (tree!.root as unknown as { findAll(test: (node: Node) => boolean): Node[] }).findAll(node => node.type === 'li');
  expect(pills.map(node => [node.props['data-kind'], node.props['data-quiet']])).toEqual([['loom', undefined], ['waiting', '']]);
  expect(words(pills[1])).toContain('Waiting on checks on sleepunit-agents/loom#33');
  expect(go).not.toHaveBeenCalled();
});
