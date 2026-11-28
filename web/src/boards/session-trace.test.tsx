/** The session brick's trace, drawn from fake data (docs/specs/boards.md, "Sessions"). */
import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer has no bundled declarations.
import { act, create } from 'react-test-renderer';
import type { TraceStep } from './session-trace';

const f = vi.hoisted(() => ({ asked: [] as { document: string; variables: Record<string, unknown>; options?: { pause?: boolean } }[], venue: 'handoff', steps: [] as unknown[], gone: false, total: null as number | null, all: [] as { seq: number }[] }));
vi.mock('../data/graphql', () => ({ useDataQuery: (document: string, variables: Record<string, unknown>, options?: { pause?: boolean }) => {
  f.asked.push({ document, variables, options });
  if (document.includes('BrickSessionJob')) return { status: 'live', data: { rows: [{ brief: 'Compare the fictional pumps', logTail: null, endedNote: null, claimedAt: '2026-11-27T10:00:00.000Z', endedAt: null }] } };
  if (document.includes('BrickSessionEarlier')) return options?.pause ? { status: 'loading' } : { status: 'live', data: { steps: f.all.filter((s) => s.seq < (variables.b as number)).slice(-(variables.n as number)) } };
  if (document.includes('BrickSessionTrace')) return { status: 'live', data: { steps: f.steps, total: f.total ?? f.steps.length, gone: f.gone } };
  if (document.includes('BrickSessionStep')) return { status: 'live', data: { steps: f.steps.slice(-1) } };
  return { status: 'live', data: { jobs: [{ id: 'child-job', title: 'Compare pumps', state: 'running', queuedAt: '2026-11-27T10:00:00.000Z', usage: { model: 'fictional-model', harness: 'claude', tools: [{ name: 'Bash', count: 2 }] } }], cv: { agent: 'art', label: 'Compare pumps', venue: f.venue } } };
} }));
vi.mock('../data/operation', () => ({ memberOperation: vi.fn() }));
import { brickView, loadBricks } from './bricks';
import { traceEvents } from './session-trace';

// A brick's body is fetched when it is first drawn (./bricks.tsx). Here they are all fetched first, so each draws at once.
await loadBricks();

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// The work-trace cards' collapsible asks for a frame when it mounts; there is no browser here.
vi.stubGlobal('requestAnimationFrame', (fn: () => void) => setTimeout(fn, 0));
vi.stubGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
let tree: ReturnType<typeof create>;
afterEach(async () => { await act(async () => tree?.unmount()); f.asked.length = 0; f.venue = 'handoff'; f.steps = []; f.gone = false; f.total = null; f.all = []; });
const call = '1'.repeat(24), other = '2'.repeat(24);
const step = (seq: number, id: string, tool: string, cardState: TraceStep['cardState'], words: string | null): TraceStep =>
  ({ seq, job: 'child-job', at: '2026-11-27T10:0' + seq + ':00.000Z', tool, cardState, clientId: `child-job:pair.${id}.-.${seq}`, words });
const steps = [step(1, call, 'Terminal', 'running', 'ls house'), step(2, call, 'Terminal', 'done', 'notes.md'), step(3, other, 'Read', 'running', 'Read')];
const draw = async (form: 'primary' | 'side' | 'compact') => {
  await act(async () => { tree = create(h(brickView('session').Body, { params: { session: 'cv-child' }, form, act: () => {}, raise: () => {} })); });
  return JSON.stringify(tree.toJSON());
};
type Drawn = string | { type: string; props: Record<string, unknown>; children: Drawn[] | null };
const text = (node: Drawn): string => (typeof node === 'string' ? node : (node.children ?? []).map(text).join(''));
const slots = (node: Drawn | Drawn[] | null, slot: string): Drawn[] =>
  !node || typeof node === 'string' ? [] : Array.isArray(node) ? node.flatMap((n) => slots(n, slot))
    : [...(node.props['data-slot'] === slot ? [node] : []), ...slots(node.children, slot)];
const titles = () => slots(tree.toJSON(), 'trace-title').map(text);

it('draws the handed-off job\'s steps in the big form, oldest first, beside the facts it already showed', async () => {
  f.steps = steps;
  const drawn = await draw('primary');
  // A call and its result are one card; the newest step is last.
  const log = tree.root.find((node: { props: Record<string, unknown> }) => node.props['data-session-trace'] === '');
  expect(log.props.role).toBe('log');
  expect(slots(tree.toJSON(), 'trace')).toHaveLength(2);
  expect(titles()).toHaveLength(2);
  expect(titles()[0]).toContain('ls house');
  expect(titles()[1]).toBe('Read');
  expect(slots(tree.toJSON(), 'trace-description').map(text)).toEqual(['done', 'running']);
  // The facts are kept.
  for (const kept of ['Asked', 'Compare the fictional pumps', 'Running on', 'fictional-model', 'Result', 'Steps', 'Stop…']) expect(drawn).toContain(kept);
  const asked = f.asked.find((q) => q.document.includes('BrickSessionTrace'))!;
  expect(asked.variables).toEqual({ c: 'cv-child', j: 'child-job', n: 100 });
});

it('says so when no step has been reported, and asks for no trace outside a handoff', async () => {
  expect(await draw('primary')).toContain('No steps reported yet.');
  await act(async () => tree.unmount());
  f.asked.length = 0; f.venue = 'wake';
  const drawn = await draw('primary');
  expect(drawn).not.toContain('Steps');
  expect(f.asked.some((q) => q.document.includes('sessionTrace'))).toBe(false);
});

it('gives the small form the latest step as one line, without asking for any words', async () => {
  f.steps = steps;
  const drawn = await draw('side');
  expect(drawn).toContain('Latest step: ');
  expect(tree.root.find((node: { props: Record<string, unknown> }) => node.props['data-session-step'] === '').children.join('')).toBe('Latest step: Read · running');
  expect(f.asked.find((q) => q.document.includes('BrickSessionStep'))!.document).not.toContain('words');
  expect(f.asked.some((q) => q.document.includes('BrickSessionTrace'))).toBe(false);
  await act(async () => tree.unmount());
  f.asked.length = 0;
  await draw('compact');
  expect(f.asked.some((q) => q.document.includes('sessionTrace'))).toBe(false);
});

it('hands the transcript\'s work-trace cards a step whose words are no longer kept', () => {
  expect(traceEvents([step(1, call, 'Terminal', 'done', null)])).toEqual([{ thread: '', sender: '', kind: 'card', seq: 1, at: '2026-11-27T10:01:00.000Z', run: 'child-job', tool: 'Terminal', cardState: 'done', clientId: `child-job:pair.${call}.-.1`, words: null }]);
});

it('says plainly that the steps are no longer kept when loom says the job is past the keep time, in place of "none recorded"', async () => {
  // An expired step is deleted, so the read has no steps; loom tells the page the job is older than a step is kept.
  f.gone = true;
  const drawn = await draw('primary');
  const gone = tree.root.find((node: { props: Record<string, unknown> }) => node.props['data-session-trace-gone'] === '');
  expect(gone.children.join('')).toBe('Its steps are no longer kept. Loom keeps a step for a limited time and then deletes it.');
  expect(drawn).not.toContain('No steps were recorded.');
  expect(drawn).not.toContain('No steps reported yet.');
  expect(slots(tree.toJSON(), 'trace')).toHaveLength(0);
  expect(f.asked.find((q) => q.document.includes('BrickSessionTrace'))!.document).toContain('gone:sessionTraceExpired(conversation:$c,job:$j)');
  // A job with no steps that is not past the keep time never had any.
  await act(async () => tree.unmount());
  f.gone = false;
  expect(await draw('primary')).not.toContain('no longer kept');
  // While any step is kept, the steps are drawn.
  await act(async () => tree.unmount());
  f.steps = [step(1, call, 'Terminal', 'done', 'ls'), step(2, other, 'Read', 'done', 'Read')];
  expect(await draw('primary')).not.toContain('no longer kept');
  expect(slots(tree.toJSON(), 'trace')).toHaveLength(2);
});

type Found = { type: string; props: Record<string, any>; children: (Found | string)[] };
const words = (node: Found | string): string => (typeof node === 'string' ? node : node.children.map(words).join(''));
const find = (slot: string) => tree.root.findAll((node: Found) => typeof node.type === 'string' && node.props['data-slot'] === slot) as Found[];
const buttons = (label: string) => tree.root.findAll((node: Found) => node.type === 'button' && words(node).includes(label)) as Found[];
const press = async (button: Found) => { await act(async () => button.props.onClick()); };
const each = (n: number, from = 1) => Array.from({ length: n }, (_, i) => step(from + i, String((from + i) % 10).repeat(24), 'Read', 'done', 'Read'));

it('says how many steps there are in all, and offers no earlier ones when every step is shown', async () => {
  f.steps = steps;
  await draw('primary');
  const line = tree.root.find((node: Found) => node.props['data-session-trace-count'] === '');
  expect(words(line)).toBe('3 steps in all.');
  expect(buttons('Load earlier steps')).toHaveLength(0);
  expect(f.asked.find((q) => q.document.includes('BrickSessionTrace'))!.document).toContain('total:sessionTraceCount(conversation:$c,job:$j)');
  // Nothing earlier is asked for until the member asks.
  expect(f.asked.filter((q) => q.document.includes('BrickSessionEarlier')).every((q) => q.options?.pause)).toBe(true);
});

it('draws a step as its command\'s first line and its state, and opens in place to the whole command and its output', async () => {
  f.steps = [step(1, call, 'Terminal', 'running', 'cd house\nls -la\nwc -l notes.md'), step(2, call, 'Terminal', 'failed', 'no such file')];
  await draw('primary');
  expect(titles()).toEqual(['cd house']);
  expect(slots(tree.toJSON(), 'trace-description').map(text)).toEqual(['failed']);
  // The latest finished terminal step is open already; it is closed and opened again by its line.
  const line = tree.root.find((node: Found) => node.type === 'button' && node.props.className === 'board-step-line');
  if (line.props['aria-expanded']) await press(line);
  expect(find('trace-command')).toHaveLength(0);
  await press(tree.root.find((node: Found) => node.type === 'button' && node.props.className === 'board-step-line'));
  expect(find('trace-command').map(words)).toEqual(['cd house\nls -la\nwc -l notes.md']);
  expect(find('trace-output').map(words)).toEqual(['no such file']);
  // A one-line command is all on its line, and is not repeated when opened.
  await act(async () => tree.unmount());
  f.steps = [step(1, call, 'Terminal', 'running', 'ls house'), step(2, call, 'Terminal', 'done', 'notes.md')];
  await draw('primary');
  expect(titles()).toEqual(['ls house']);
  expect(find('trace-command')).toHaveLength(0);
  expect(find('trace-output').map(words)).toEqual(['notes.md']);
});

it('draws each https address in a step\'s output as a link that opens in a new tab, and nothing else as one', async () => {
  f.steps = [step(1, call, 'Terminal', 'running', 'gh pr create'), step(2, call, 'Terminal', 'done',
    'Opened https://github.com/example/fictional/pull/7. Also http://plain.example/x, javascript:alert(1) and ftp://files.example/y\nsee (https://docs.example/a?b=1#c)')];
  await draw('primary');
  const links = tree.root.findAll((node: Found) => node.type === 'a') as Found[];
  expect(links.map((a) => a.props.href)).toEqual(['https://github.com/example/fictional/pull/7', 'https://docs.example/a?b=1#c']);
  for (const a of links) { expect(a.props.target).toBe('_blank'); expect(a.props.rel).toBe('noopener noreferrer'); expect(words(a)).toBe(a.props.href); }
  // Every word of the output is still there, in order, around the links.
  expect(find('trace-output').map(words)).toEqual(['Opened https://github.com/example/fictional/pull/7. Also http://plain.example/x, javascript:alert(1) and ftp://files.example/y\nsee (https://docs.example/a?b=1#c)']);
});

it('loads earlier steps a page at a time when there are more than the page holds, keeping the ones it has', async () => {
  f.all = each(5); f.steps = f.all.slice(-2); f.total = 5;
  await draw('primary');
  const line = () => words(tree.root.find((node: Found) => node.props['data-session-trace-count'] === ''));
  expect(line()).toBe('5 steps in all, the latest 2 shown.');
  expect(find('trace')).toHaveLength(2);
  await press(buttons('Load earlier steps')[0]);
  const asked = f.asked.filter((q) => q.document.includes('BrickSessionEarlier') && !q.options?.pause);
  expect(asked.at(-1)!.variables).toEqual({ c: 'cv-child', j: 'child-job', n: 100, b: 4 });
  expect(asked.at(-1)!.document).toContain('before:$b');
  expect(find('trace')).toHaveLength(5);
  expect(line()).toBe('5 steps in all.');
  expect(buttons('Load earlier steps')).toHaveLength(0);
});
