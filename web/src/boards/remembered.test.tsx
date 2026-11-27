/** What the boards page remembers of its bricks' answers, and what a placement does with it (docs/specs/boards.md,
 * "The page": "Off screen"). The data hook is the real one over a faked client; the store's own rules are in
 * ../data/graphql/index.test.ts. */
import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer has no bundled declarations.
import { act, create } from 'react-test-renderer';

const f = vi.hoisted(() => ({ query: vi.fn(), sinks: [] as ((result: unknown) => void)[] }));
vi.mock('../data/graphql/client', () => ({ browserQueryTransport: () => ({}), generatedDataClient: () => ({ query: f.query }) }));
import { useDataQuery } from '../data/graphql';
import { Remembered, rememberedAnswers } from '../data/graphql/remembered';
import { useOwnFlag, useSettling } from './brick-kit';
import { PlacementFrame } from './placement';
import { forgetAnswers, rememberedFor } from './remember';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal('location', { protocol: 'https:', host: 'desk.invalid' });
f.query.mockImplementation(() => ({ subscribe: (sink: (result: unknown) => void) => { f.sinks.push(sink); return { unsubscribe() {} }; } }));

type Node = { type: string; props: Record<string, any>; children: (Node | string)[]; findAll(test: (n: Node) => boolean): Node[]; findAllByType(type: string): Node[] };
const text = (n: Node | string): string => (typeof n === 'string' ? n : n.children.map(text).join(''));
let tree: { root: Node; unmount(): void } | undefined;
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; f.sinks.length = 0; });
const answer = (state: string) => act(async () => { f.sinks.at(-1)!({ data: { ticket: { state } } }); });

const raised = vi.fn();
/** A brick in small: one read of its record, a flag of its own for a change to it, and a control that must not act on old data. */
function Mini() {
  const read = useDataQuery<{ ticket: { state: string } }>('query BrickMini($id:String!){ticket(id:$id){state}}', { id: 't-1' }, { keep: true });
  useOwnFlag(read.data?.ticket.state, raised, (_was, now) => 'Now ' + now);
  const stale = useSettling();
  if (read.status !== 'live') return h('p', null, read.status === 'loading' ? 'Loading…' : 'This ticket is unavailable.');
  return h('p', null, read.data!.ticket.state, h('button', { disabled: stale }, 'Act'));
}
const answers = rememberedAnswers();
const placement = () => h(Remembered.Provider, { value: answers }, h(PlacementFrame, { title: 'Ticket', sub: 't-1', form: 'side' as const, children: h(Mini) }));
const mark = () => tree!.root.findAll((n) => n.props.className === 'board-settling');
const said = () => text(tree!.root.findAllByType('p')[0]);
const button = () => tree!.root.findAllByType('button').find((b) => text(b) === 'Act')!;

it('a placement drawn again shows what it showed at once, with one mark that says it is getting new data, then the fresh answer and no mark', async () => {
  answers.clear(); raised.mockReset();
  await act(async () => { tree = create(placement()); });
  expect(said()).toBe('Loading…'); expect(mark()).toEqual([]);
  await answer('open');
  expect(said()).toBe('openAct'); expect(mark()).toEqual([]);
  // The board slid away: the body is gone, and with it its read.
  await act(async () => tree!.unmount());
  await act(async () => { tree = create(placement()); });
  expect(said()).toBe('openAct');
  expect(mark().map((m) => [m.props.role, m.props['aria-label']])).toEqual([['status', 'Getting new data']]);
  // A control that must not act on old data waits for the fresh answer.
  expect(button().props.disabled).toBe(true);
  await answer('open');
  expect(said()).toBe('openAct'); expect(mark()).toEqual([]); expect(button().props.disabled).toBe(false);
  // The record was the same when the board came back: nothing is flagged.
  expect(raised).not.toHaveBeenCalled();
});
it('a record that changed while its board was off screen flags its brick when the fresh answer arrives', async () => {
  answers.clear(); raised.mockReset();
  await act(async () => { tree = create(placement()); });
  await answer('open');
  await act(async () => tree!.unmount());
  await act(async () => { tree = create(placement()); });
  expect(said()).toBe('openAct');
  await answer('closed');
  expect(said()).toBe('closedAct');
  expect(raised.mock.calls).toEqual([['Now closed']]);
});
it('a fresh answer that is refused drops what was remembered at once, and the brick says what it says for that', async () => {
  answers.clear();
  await act(async () => { tree = create(placement()); });
  await answer('private');
  await act(async () => tree!.unmount());
  await act(async () => { tree = create(placement()); });
  expect(said()).toBe('privateAct');
  await act(async () => { f.sinks.at(-1)!({ error: new Error('Data selection refused') }); });
  expect(said()).toBe('This ticket is unavailable.');
  expect(mark()).toEqual([]);
  expect(JSON.stringify((tree as unknown as { toJSON(): unknown }).toJSON())).not.toContain('private');
});
it('remembers for one signed-in member: another member starts with nothing, and so does the same one after the session ends', () => {
  const sam = rememberedFor('sam');
  sam.set(1, { secret: 'sam' }, undefined);
  expect(rememberedFor('sam')).toBe(sam); expect(rememberedFor('sam').size).toBe(1);
  const kim = rememberedFor('kim');
  expect(kim).not.toBe(sam); expect(kim.size).toBe(0); expect(sam.size).toBe(0);
  kim.set(2, { secret: 'kim' }, undefined);
  forgetAnswers();
  expect(kim.size).toBe(0); expect(rememberedFor('kim').size).toBe(0);
});
it('a body drawn with no placement around it is never settling', () => {
  let seen: boolean | undefined;
  const Probe = () => { seen = useSettling(); return null; };
  act(() => { tree = create(h(Probe)); });
  expect(seen).toBe(false);
});
