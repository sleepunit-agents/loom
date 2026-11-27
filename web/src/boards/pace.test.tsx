/** How often the boards page has loom read its data again, and how it asks for "now" (docs/specs/boards.md, "Live
 * reads and their cost"). The data hook, the placement and the session's step list are the real ones, over a faked
 * client: what is checked is what the page sends to it. The server's side is in src/core/data/live.test.ts. */
import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer has no bundled declarations.
import { act, create } from 'react-test-renderer';

type Sent = { name: string; pace: string; key?: number; context: Record<string, unknown>; sink(result: unknown): void; open: boolean };
const f = vi.hoisted(() => ({ sent: [] as Sent[], now: vi.fn() }));
vi.mock('../data/graphql/client', () => {
  const opened = (name: string, pace: string, key: number | undefined, context: Record<string, unknown>) => ({ subscribe(sink: (result: unknown) => void) {
    const one = { name, pace, key, context, sink, open: true }; f.sent.push(one);
    return { unsubscribe() { one.open = false; } };
  } });
  const named = (query: unknown) => /query (\w+)/.exec(typeof query === 'string' ? query : (query as { loc: { source: { body: string } } }).loc.source.body)![1];
  return { browserQueryTransport: () => ({ now: f.now }), generatedDataClient: () => ({
    // An eager selection is sent as every selection always was; a relaxed one is its own operation, with its pace.
    query: (query: unknown, _variables: unknown, context: Record<string, unknown>) => opened(named(query), 'eager', undefined, context),
    executeQuery: (request: { query: unknown; key: number }, context: Record<string, unknown>) => opened(named(request.query), String(context.pace), request.key, context),
  }) };
});
import { useDataQuery } from '../data/graphql';
import { Remembered, rememberedAnswers } from '../data/graphql/remembered';
import { refreshRelaxed } from '../data/graphql/pace';
import { LIVE_RELAXED_MS } from '../../../src/core/data/live-pace';
import { asOf, OWN_ACTION_MS, useOwnFlag } from './brick-kit';
import { PlacementFrame } from './placement';
import { SessionTrace } from './session-trace';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal('location', { protocol: 'https:', host: 'desk.invalid' });

type Node = { type: string; props: Record<string, any>; children: (Node | string)[]; findAll(test: (n: Node) => boolean): Node[]; findAllByType(type: string): Node[] };
let tree: { root: Node; unmount(): void; update(next: unknown): void } | undefined;
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; f.sent.length = 0; f.now.mockReset(); vi.useRealTimers(); });

const raised = vi.fn();
let mine: (() => void) | undefined;
/** A brick in small: one read of its record and a flag of its own for a change to it. */
function Mini({ id, pace }: { id: string; pace?: 'eager' }) {
  const read = useDataQuery<{ ticket: { state: string } }>('query BrickMini($id:String!){ticket(id:$id){state}}', { id }, { keep: true, pace });
  mine = useOwnFlag(read.data?.ticket.state, raised, (was, now) => was + ' → ' + now);
  return h('p', null, read.status === 'live' ? read.data!.ticket.state : read.status);
}
/** Something of the page's own, drawn outside any placement: the list of the thread's boards, the thread's row. */
function OfThePage() {
  const read = useDataQuery<{ n: number }>('query ThreadBoards($thread:String!){n(thread:$thread)}', { thread: 'th:1' }, { keep: true });
  return h('p', null, read.status);
}
const answers = rememberedAnswers();
const frame = (title: string, id: string, pace?: 'eager') => h(PlacementFrame, { key: title, title, sub: id, form: 'side' as const, children: h(Mini, { id, pace }) });
const page = (...placements: unknown[]) => h(Remembered.Provider, { value: answers }, h(OfThePage), ...(placements as never[]));
const draw = (what: unknown) => act(async () => { tree = create(what); });
const open = (name: string) => f.sent.filter((s) => s.open && s.name === name);
const answer = (to: Sent, state: string) => act(async () => { to.sink({ data: { ticket: { state } } }); });
const articles = () => tree!.root.findAllByType('article');
const mark = (article: Node) => article.findAll((n) => n.props.className === 'board-settling');
const refresh = (article: Node) => article.findAll((n) => n.props.className === 'board-refresh')[0];
const settled = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

it('opens every selection under a placement relaxed and the page\'s own eager, each as its own selection', async () => {
  answers.clear();
  await draw(page(frame('Ticket', 't-1'), frame('Other', 't-2')));
  // The page's own read is sent exactly as before there were two paces: no pace, no name.
  expect(open('ThreadBoards').map((s) => [s.pace, s.context])).toEqual([['eager', { requestPolicy: 'network-only' }]]);
  expect(open('BrickMini').map((s) => [s.pace, s.context])).toEqual([['relaxed', { requestPolicy: 'network-only', pace: 'relaxed' }], ['relaxed', { requestPolicy: 'network-only', pace: 'relaxed' }]]);
  const [one, two] = open('BrickMini');
  expect(one.key).not.toBe(two.key);
  // The same selection drawn outside a placement is eager and is another operation: neither takes the other's pace.
  await act(async () => tree!.unmount()); f.sent.length = 0;
  await draw(h('div', null, h(Mini, { id: 't-1' })));
  expect(open('BrickMini').map((s) => s.pace)).toEqual(['eager']);
});

it('lets a brick say that one of its reads is eager, as the running session\'s steps do, and relaxed once the job has ended', async () => {
  answers.clear();
  await draw(page(frame('Ticket', 't-1', 'eager')));
  expect(open('BrickMini').map((s) => s.pace)).toEqual(['eager']);
  await act(async () => tree!.unmount()); f.sent.length = 0;
  const steps = (running: boolean) => h(PlacementFrame, { title: 'Session', sub: 'cv-1', form: 'primary' as const, children: h(SessionTrace, { conversation: 'cv-1', job: 'job-1', running }) });
  await draw(steps(true));
  expect(open('BrickSessionTrace').map((s) => s.pace)).toEqual(['eager']);
  await act(async () => { open('BrickSessionTrace')[0].sink({ data: { steps: [{ seq: 1, job: 'job-1', at: '2026-11-27T10:00:00Z', tool: 'Terminal', cardState: 'done', clientId: 'c1', words: 'ls' }], gone: false } }); });
  // The job ended: the same list is read like the rest of the brick, and its steps stay drawn while that opens.
  await act(async () => tree!.update(steps(false)));
  expect(open('BrickSessionTrace').map((s) => s.pace)).toEqual(['relaxed']);
  expect(tree!.root.findAll((n) => n.props.className === 'board-step')).toHaveLength(1);
  expect(JSON.stringify((tree as unknown as { toJSON(): unknown }).toJSON())).not.toContain('Loading');
});

it('asks for one placement\'s selections with its refresh control, marks that placement until loom answers, and says when its data was confirmed', async () => {
  answers.clear();
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.parse('2026-11-27T10:00:00Z'));
  await draw(page(frame('Ticket', 't-1'), frame('Other', 't-2')));
  const [one, two] = open('BrickMini');
  await answer(one, 'open'); await answer(two, 'open');
  // A brick that is only waiting out its few seconds shows nothing.
  expect(articles().map((a) => mark(a).length)).toEqual([0, 0]);
  expect(refresh(articles()[0]).props).toMatchObject({ type: 'button', 'aria-label': 'Refresh Ticket', title: 'Refresh' });
  vi.setSystemTime(Date.parse('2026-11-27T10:00:12Z'));
  f.now.mockResolvedValue([String(one.key)]);
  await act(async () => refresh(articles()[0]).props.onClick());
  // Loom is asked for that placement's selection by its name on the socket, and for no other.
  expect(f.now.mock.calls).toEqual([[[String(one.key)]]]);
  expect(articles().map((a) => mark(a).length)).toEqual([1, 0]);
  expect(mark(articles()[0])[0].props).toMatchObject({ role: 'status', 'aria-label': 'Getting new data', 'aria-description': 'as of 12 s ago', title: 'Getting new data, as of 12 s ago' });
  // The selection stays open as it was: nothing is opened again, so nothing shows the loading line.
  expect(f.sent.filter((s) => s.name === 'BrickMini')).toHaveLength(2);
  expect(articles().map((a) => a.findAllByType('p')[0].children)).toEqual([['open'], ['open']]);
  // Loom's answer, changed or not, ends the mark.
  await answer(one, 'open');
  expect(articles().map((a) => mark(a).length)).toEqual([0, 0]);
});

it('asks for every placement on screen at once, never for the page\'s own reads, and stops waiting for a selection loom did not have open', async () => {
  answers.clear();
  await draw(page(frame('Ticket', 't-1'), frame('Other', 't-2')));
  const [one, two] = open('BrickMini');
  await answer(one, 'open'); await answer(two, 'open');
  // What the page does after the member's own write, and when its tab is seen again (./page.test.tsx).
  f.now.mockResolvedValue([String(one.key)]);
  await act(async () => refreshRelaxed());
  expect(f.now.mock.calls).toEqual([[[String(one.key), String(two.key)]]]);
  await settled();
  // The one loom did not name will not be answered for this asking: its mark is gone. The other waits for its answer.
  expect(articles().map((a) => mark(a).length)).toEqual([1, 0]);
  await act(async () => { one.sink({ error: new Error('Connection closed') }); });
  expect(articles().map((a) => mark(a).length)).toEqual([0, 0]);
  // A placement that left the screen holds no read and is not asked for.
  f.now.mockClear();
  await act(async () => tree!.update(page(frame('Other', 't-2'))));
  await act(async () => refreshRelaxed());
  expect(f.now.mock.calls).toEqual([[[String(two.key)]]]);
  await act(async () => tree!.unmount()); tree = undefined; f.now.mockClear();
  refreshRelaxed();
  expect(f.now).not.toHaveBeenCalled();
});

it('reads a board that comes back on screen at once: its selections are opened anew, and the mark says how old what is drawn is', async () => {
  answers.clear();
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.parse('2026-11-27T10:00:00Z'));
  await draw(page(frame('Ticket', 't-1')));
  await answer(open('BrickMini')[0], 'open');
  await act(async () => tree!.unmount());
  expect(open('BrickMini')).toEqual([]);
  vi.setSystemTime(Date.parse('2026-11-27T10:03:00Z'));
  await draw(page(frame('Ticket', 't-1')));
  // A new selection: loom answers a selection's first reading without waiting, so no "now" is needed, and none is sent.
  expect(open('BrickMini').map((s) => s.pace)).toEqual(['relaxed']);
  expect(f.now).not.toHaveBeenCalled();
  expect(mark(articles()[0])[0].props).toMatchObject({ 'aria-label': 'Getting new data', 'aria-description': 'as of 3 min ago' });
  await answer(open('BrickMini')[0], 'open');
  expect(mark(articles()[0])).toEqual([]);
});

it('flags a brick once for the difference when several changes arrive as one, and not for the member\'s own action that asked for now', async () => {
  answers.clear(); raised.mockReset();
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.parse('2026-11-27T10:00:00Z'));
  await draw(page(frame('Ticket', 't-1')));
  const [one] = open('BrickMini');
  await answer(one, 'open');
  // Somebody else moved it twice inside one relaxed time: one answer, one flag, named for where it was and is.
  await answer(one, 'done');
  expect(raised.mock.calls).toEqual([['open → done']]);
  // It went away and came back between two readings: the answer is the same, and nothing is flagged.
  await answer(one, 'done');
  expect(raised).toHaveBeenCalledTimes(1);
  // The member acts here. Their write is answered, the page asks for now, and loom's answer is their own change.
  raised.mockReset(); f.now.mockResolvedValue([String(one.key)]);
  await act(async () => { mine!(); refreshRelaxed(); });
  vi.setSystemTime(Date.now() + 150);
  await answer(one, 'open');
  expect(raised).not.toHaveBeenCalled();
  // If that asking is lost, their change comes with the next relaxed reading, and is still theirs.
  expect(OWN_ACTION_MS).toBeGreaterThan(LIVE_RELAXED_MS + 1000);
  await act(async () => { mine!(); });
  vi.setSystemTime(Date.now() + LIVE_RELAXED_MS + 500);
  await answer(one, 'blocked');
  expect(raised).not.toHaveBeenCalled();
  // After that, somebody else's change is flagged as ever.
  vi.setSystemTime(Date.now() + 1000);
  await answer(one, 'done');
  expect(raised.mock.calls).toEqual([['blocked → done']]);
});

it('says how long ago a brick\'s data was confirmed in the kit\'s words', () => {
  const now = Date.parse('2026-11-27T10:00:00Z');
  expect([0, 12_000, 59_400, 90_000, 3 * 3_600_000].map((ago) => asOf(now - ago, now))).toEqual(['as of 0 s ago', 'as of 12 s ago', 'as of 59 s ago', 'as of 2 min ago', 'as of 3 h ago']);
});
