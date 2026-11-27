/** What the `question` brick shows around its answer, as the desktop's opened Inbox item does: the linked page,
 * everything the item is about, a household change's approval by its plain title, and how loudly the item is
 * shown (docs/specs/boards.md, "The first bricks"). Its answer is checked in bricks-drawn.test.tsx. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer does not ship declarations.
import { act, create } from 'react-test-renderer';

const feed = vi.hoisted(() => vi.fn());
vi.mock('../data/graphql', () => ({ useDataQuery: feed }));
import { brickView } from './bricks';
import type { Form } from './layout';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Node = { type: string; props: Record<string, any>; children: (Node | string)[]; findAll(match: (node: Node) => boolean): Node[]; findAllByType(type: string): Node[] };
let tree: { root: Node; toJSON(): unknown; unmount(): void } | undefined;
const sent = vi.fn(), reported = vi.fn();
let ok = true;
const item = { id: 'in-pump', canAnswer: true, source: 'thread', agent: 'art', project: 'pond', at: '2026-11-14T20:00:00Z', state: 'waiting', volume: 'full', answers: 'yes-no',
  read: false, refs: ['t-12'], body: { words: 'Replace the pump filter?', why: 'It is clogged.' } as Record<string, string> };
const world = { item: item as object, approvals: [] as object[], titles: [] as object[] };
beforeEach(() => {
  feed.mockReset(); sent.mockReset(); reported.mockReset(); ok = true;
  Object.assign(world, { item, approvals: [], titles: [] });
  feed.mockImplementation((query: string, _variables: object, options?: { pause?: boolean }) => {
    const name = /^query (\w+)/.exec(query)![1];
    if (name === 'InboxItem') return { status: 'live', data: { inboxItem: world.item } };
    if (name === 'InboxApprovals') return options?.pause ? { status: 'loading' } : { status: 'live', data: { approvals: world.approvals } };
    if (name === 'InboxProposalTitles') return options?.pause ? { status: 'loading' } : { status: 'live', data: { inboxProposalTitles: world.titles } };
    throw new Error('A read the question brick should not make: ' + name);
  });
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    sent(url, JSON.parse(init.body).input);
    return { ok, status: ok ? 200 : 409, json: async () => (ok ? { ok: true, value: { saved: true } } : { ok: false }) };
  });
});
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; vi.unstubAllGlobals(); });

async function draw(form: Form = 'side') { await act(async () => { tree?.unmount(); tree = create(h(brickView('question').Body, { params: { item: 'in-pump' }, form, act: reported, raise: () => {} })); }); }
const said = (node: Node): string => node.children.map((child) => (typeof child === 'string' ? child : said(child))).join('');
const text = () => said(tree!.root as Node);
const group = () => tree!.root.findAll((node) => node.props.role === 'group' && node.props['aria-label'] === 'Notify');
const notify = () => group().flatMap((node) => node.findAllByType('button')).map((b) => [said(b), b.props['aria-pressed'], b.props.disabled]);
const press = (label: string) => act(async () => { await tree!.root.findAllByType('button').find((b) => said(b) === label)!.props.onClick(); });

it('offers the linked page only for a web address or a path of this site, and in no compact form', async () => {
  for (const [link, shown] of [['https://example.test/pump', true], ['/p/tasks/t-12', true], ['javascript:alert(1)', false], ['//evil.test/x', false], ['mailto:a@example.test', false]] as const) {
    world.item = { ...item, body: { ...item.body, link } };
    await draw();
    const links = tree!.root.findAllByType('a');
    expect(links.map((a) => [a.props.href, a.props.target, a.props.rel, said(a)]), link).toEqual(shown ? [[link, '_blank', 'noreferrer', 'Open linked page']] : []);
  }
  world.item = { ...item, body: { ...item.body, link: 'https://example.test/pump' } };
  await draw('compact');
  expect(tree!.root.findAllByType('a')).toEqual([]);
});

it('shows everything the item is about: a chip where a brick draws it, the id where none does', async () => {
  world.item = { ...item, refs: ['t-12', 'a-7', 'c-99'] };
  await draw();
  expect(tree!.root.findAll((node) => !!node.props['data-place']).map((node) => JSON.parse(node.props['data-place'])).filter((place) => ['ticket', 'approval'].includes(place.brick)))
    .toEqual([{ brick: 'ticket', params: { ticket: 't-12' } }, { brick: 'approval', params: { approval: 'a-7' } }]);
  expect(text()).toContain('c-99');
});

it('says a household change\'s approval by its plain title, as the Inbox does, and every other item in its own words', async () => {
  world.item = { ...item, source: 'approval', waitsOnKind: 'approval', waitsOnId: 'a-9', body: { words: 'stored words of the filing agent' } };
  world.approvals = [{ id: 'a-9', operation: 'household.change', what: 'stored', details: '{}' }];
  world.titles = [{ approval: 'a-9', title: 'Make Robin an owner' }];
  for (const form of ['primary', 'side', 'compact'] as const) {
    await draw(form);
    expect(text(), form).toContain('Make Robin an owner');
    expect(text(), form).not.toContain('stored words of the filing agent');
  }
  // An approval that is not a household change keeps the item's words.
  world.approvals = [{ id: 'a-9', operation: null, what: 'Merge it', details: '' }];
  await draw();
  expect(text()).toContain('stored words of the filing agent');
});

it('sets how loudly the item is shown through inbox.volume, only where the member may, and tells the board which of the three', async () => {
  await draw();
  expect(group()).toEqual([]);
  world.item = { ...item, canSetVolume: true };
  for (const form of ['primary', 'side'] as const) { await draw(form); expect(notify(), form).toEqual([['Normal', true, true], ['Quiet', false, false], ['Hidden', false, false]]); }
  await draw('compact');
  expect(tree!.root.findAllByType('button')).toEqual([]);
  await draw();
  await press('Normal');
  expect(sent).not.toHaveBeenCalled();
  await press('Quiet');
  expect(sent.mock.calls).toEqual([['/api/inbox/volume', { item: 'in-pump', volume: 'dim' }]]);
  expect(reported.mock.calls).toEqual([['volume', { volume: 'dim' }]]);
  // What the chosen one means, and when it ends, as the Inbox says it.
  world.item = { ...item, canSetVolume: true, volume: 'dim', quietUntil: '2026-11-20T20:00:00Z' };
  await draw();
  expect(notify()).toEqual([['Normal', false, false], ['Quiet', true, true], ['Hidden', false, false]]);
  expect(text()).toContain('One line in the list, no notifications · back to normal Nov 20, 2026');
  // A refused write is said and the board is told nothing.
  ok = false; sent.mockClear(); reported.mockClear();
  await press('Hidden');
  expect(sent.mock.calls).toEqual([['/api/inbox/volume', { item: 'in-pump', volume: 'mute' }]]);
  expect(reported).not.toHaveBeenCalled();
  expect(tree!.root.findAll((node) => node.props.role === 'alert').map(said)).toEqual(['Could not save. Try again.']);
});
