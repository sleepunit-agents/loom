/** The session brick's trace, drawn from fake data (docs/specs/boards.md, "Sessions"). */
import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer has no bundled declarations.
import { act, create } from 'react-test-renderer';
import type { TraceStep } from './session-trace';

const f = vi.hoisted(() => ({ asked: [] as { document: string; variables: Record<string, unknown>; options?: { pause?: boolean } }[], venue: 'handoff', steps: [] as unknown[], gone: false, total: null as number | null, all: [] as { seq: number }[], state: 'running', report: null as string | null, failedWhy: null as string | null }));
vi.mock('../data/graphql', () => ({ useDataQuery: (document: string, variables: Record<string, unknown>, options?: { pause?: boolean }) => {
  f.asked.push({ document, variables, options });
  if (document.includes('BrickSessionJob')) return { status: 'live', data: { rows: [{ brief: 'Compare the fictional pumps', logTail: null, endedNote: null, failedWhy: f.failedWhy, claimedAt: '2026-11-27T10:00:00.000Z', endedAt: f.state === 'running' ? null : '2026-11-27T10:30:00.000Z' }] } };
  if (document.includes('BrickSessionReport')) return { status: 'live', data: { report: f.report === null ? null : { words: f.report } } };
  if (document.includes('BrickSessionEarlier')) return options?.pause ? { status: 'loading' } : { status: 'live', data: { steps: f.all.filter((s) => s.seq < (variables.b as number)).slice(-(variables.n as number)) } };
  if (document.includes('BrickSessionTrace')) return { status: 'live', data: { steps: f.steps, total: f.total ?? f.steps.length, gone: f.gone } };
  if (document.includes('BrickSessionStep')) return { status: 'live', data: { steps: f.steps.slice(-1) } };
  return { status: 'live', data: { jobs: [{ id: 'child-job', title: 'Compare pumps', state: f.state, queuedAt: '2026-11-27T10:00:00.000Z', usage: { model: 'fictional-model', harness: 'claude', tools: [{ name: 'Bash', count: 2 }] } }], cv: { agent: 'art', label: 'Compare pumps', venue: f.venue } } };
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
afterEach(async () => { await act(async () => tree?.unmount()); f.asked.length = 0; f.venue = 'handoff'; f.steps = []; f.gone = false; f.total = null; f.all = []; f.state = 'running'; f.report = null; f.failedWhy = null; });
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
// A step's own line; the fold over a run of them (its "N steps" line) is not one.
const titles = () => slots(tree.toJSON(), 'trace-title').filter((n) => typeof n !== 'string' && n.props['data-session-run-count'] === undefined && n.props['data-session-reasoning-title'] === undefined).map(text);
const stepStates = () => slots(stepLines(), 'trace-description').map(text);
const stepLines = () => slots(tree.toJSON(), 'trace').filter((n) => typeof n !== 'string' && n.type === 'li');

it('draws the handed-off job\'s steps in the big form, oldest first, beside the facts it already showed', async () => {
  f.steps = steps;
  const drawn = await draw('primary');
  // A call and its result are one card; the newest step is last.
  const log = tree.root.find((node: { props: Record<string, unknown> }) => node.props['data-session-trace'] === '');
  expect(log.props.role).toBe('log');
  expect(stepLines()).toHaveLength(2);
  expect(titles()).toHaveLength(2);
  expect(titles()[0]).toContain('ls house');
  expect(titles()[1]).toBe('Read');
  expect(stepStates()).toEqual(['done', 'running']);
  // The facts are kept.
  for (const kept of ['Asked', 'Compare the fictional pumps', 'Running on', 'fictional-model', 'Result', 'Conversation', 'Stop…']) expect(drawn).toContain(kept);
  const asked = f.asked.find((q) => q.document.includes('BrickSessionTrace'))!;
  expect(asked.variables).toEqual({ c: 'cv-child', j: 'child-job', n: 100 });
});

it('says so when no step has been reported, and asks for no trace outside a handoff', async () => {
  expect(await draw('primary')).toContain('No steps reported yet.');
  await act(async () => tree.unmount());
  f.asked.length = 0; f.venue = 'wake';
  const drawn = await draw('primary');
  expect(drawn).not.toContain('No steps');
  // A session that keeps no trace never asks for one: its reads stay paused.
  expect(f.asked.some((q) => q.document.includes('sessionTrace') && !q.options?.pause)).toBe(false);
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
  expect(stepLines()).toHaveLength(0);
  expect(f.asked.find((q) => q.document.includes('BrickSessionTrace'))!.document).toContain('gone:sessionTraceExpired(conversation:$c,job:$j)');
  // A job with no steps that is not past the keep time never had any.
  await act(async () => tree.unmount());
  f.gone = false;
  expect(await draw('primary')).not.toContain('no longer kept');
  // While any step is kept, the steps are drawn.
  await act(async () => tree.unmount());
  f.steps = [step(1, call, 'Terminal', 'done', 'ls'), step(2, other, 'Read', 'done', 'Read')];
  expect(await draw('primary')).not.toContain('no longer kept');
  expect(stepLines()).toHaveLength(2);
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
  expect(stepStates()).toEqual(['failed']);
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
  expect(find('trace').filter((n: Found) => n.type === 'li')).toHaveLength(2);
  await press(buttons('Load earlier steps')[0]);
  const asked = f.asked.filter((q) => q.document.includes('BrickSessionEarlier') && !q.options?.pause);
  expect(asked.at(-1)!.variables).toEqual({ c: 'cv-child', j: 'child-job', n: 100, b: 4 });
  expect(asked.at(-1)!.document).toContain('before:$b');
  expect(find('trace').filter((n: Found) => n.type === 'li')).toHaveLength(5);
  expect(line()).toBe('5 steps in all.');
  expect(buttons('Load earlier steps')).toHaveLength(0);
});

// ── The conversation (Jonathan, 2026-11-28: "a session should look a lot like a conversation I just wasn't involved in
// that's 90% tool calls") ──────────────────────────────────────────────────────────────────────────────────────────
const spoke = (seq: number, kind: 'words' | 'reasoning', words: string | null): TraceStep =>
  ({ seq, job: 'child-job', at: '2026-11-27T10:1' + (seq % 10) + ':00.000Z', tool: kind === 'words' ? 'Words' : 'Reasoning', cardState: 'done', clientId: `child-job:${kind === 'words' ? 'say' : 'think'}.${seq}`, words, kind });
const talked = [
  spoke(1, 'reasoning', 'Which **pump** first?'),
  spoke(2, 'words', 'I will read the pump notes, then compare.'),
  ...[3, 4, 5, 6].map((seq) => step(seq, String(seq).repeat(24), 'Read', 'done', 'Read')),
  step(7, '7'.repeat(24), 'Terminal', 'running', 'ls house'), step(8, '7'.repeat(24), 'Terminal', 'failed', 'no such file'),
  spoke(9, 'words', 'The second pump is cheaper.'),
  step(10, '8'.repeat(24), 'Read', 'done', 'Read'),
];
const marked = (attr: string) => tree.root.findAll((node: Found) => typeof node.type === 'string' && node.props[attr] === '') as Found[];
// The log's own pieces, in order, each named by what it is.
const order = () => {
  const log = tree.root.find((node: Found) => node.props['data-session-trace'] === '');
  return (log.children as Found[]).filter((c) => typeof c !== 'string').map((c) => {
    const p = c.props;
    return p['data-session-brief'] === '' ? 'brief' : p['data-session-words'] === '' ? 'words' : p['data-session-report'] === '' ? 'report'
      : p['data-session-failure'] === '' ? 'failure' : p.words !== undefined ? 'reasoning' : p.nodes ? `tools:${p.nodes.length}` : 'other';
  });
};
const toggle = async (node: Found) => { await act(async () => node.props.onClick({ defaultPrevented: false, preventDefault() {} })); };
const trigger = (within: Found) => within.findAll((n: Found) => n.type === 'button' && n.props['data-slot'] === 'trace-collapsible-trigger')[0] as Found;

it('draws a session as a conversation: the brief as the asker\'s message, the agent\'s words as its own, tool runs folded between them, reasoning quiet, the report last', async () => {
  f.steps = talked; f.state = 'done'; f.report = 'Pump B, **by a third**.';
  await draw('primary');
  expect(order()).toEqual(['brief', 'reasoning', 'words', 'tools:5', 'words', 'tools:1', 'report']);
  // The brief is the asker's: on the end side, in a filled bubble; the agent's words on the start side in a bare one.
  const [brief] = marked('data-session-brief');
  expect(brief.props['data-align']).toBe('end');
  expect(words(brief)).toContain('Asked');
  expect(words(brief)).toContain('Compare the fictional pumps');
  expect(brief.findAll((n: Found) => n.props['data-slot'] === 'bubble')[0].props['data-variant']).toBe('secondary');
  const said = marked('data-session-words');
  expect(said.map((m) => m.props['data-align'])).toEqual(['start', 'start']);
  expect(said.map((m) => m.findAll((n: Found) => n.props['data-slot'] === 'bubble')[0].props['data-variant'])).toEqual(['ghost', 'ghost']);
  expect(words(said[0])).toContain('Art · ');
  expect(words(said[0])).toContain('I will read the pump notes, then compare.');
  // A run of tool calls is one quiet line that says how many steps, folded once the session has ended.
  const runs = marked('data-session-run');
  expect(runs.map((run) => words(run.findAll((n: Found) => n.props['data-session-run-count'] === '')[0]))).toEqual(['5 steps', '1 step']);
  expect(words(runs[0])).toContain('1 failed');
  expect(stepLines()).toHaveLength(0);
  // It opens in place, to the steps as the trace draws them (a call and its result one line).
  await toggle(trigger(marked('data-session-run')[0]));
  expect(titles()).toEqual(['Read', 'Read', 'Read', 'Read', 'ls house']);
  expect(stepStates()).toEqual(['done', 'done', 'done', 'done', 'failed']);
  // Reasoning is folded, quiet, and opens to its words through the chat's own renderer.
  const [thought] = marked('data-session-reasoning');
  expect(words(thought)).toBe('Reasoning');
  await toggle(trigger(marked('data-session-reasoning')[0]));
  expect(marked('data-session-reasoning')[0].findAll((n: Found) => n.type === 'strong').map(words)).toEqual(['pump']);
  // The report is the last message, the agent's, as the chat renders a reply.
  const [report] = marked('data-session-report');
  expect(words(report)).toContain('Art · Report');
  expect(report.findAll((n: Found) => n.type === 'strong').map(words)).toEqual(['by a third']);
  // The count still covers every step, words and reasoning among them.
  expect(words(tree.root.find((node: Found) => node.props['data-session-trace-count'] === ''))).toBe('10 steps in all.');
});

it('keeps the latest run of a working session open, and draws its report once, not twice, where its last words are the report', async () => {
  f.steps = [...talked, step(11, '9'.repeat(24), 'Terminal', 'running', 'npm test')];
  await draw('primary');
  // Running: the latest run is open and says it is working; the earlier one is folded.
  expect(titles()).toEqual(['Read', 'npm test']);
  expect(words(marked('data-session-run')[1])).toContain('working');
  await act(async () => tree.unmount());
  f.steps = [...talked, spoke(11, 'words', 'Pump B, by a third.')]; f.state = 'done'; f.report = 'Pump B, by a third.';
  await draw('primary');
  expect(order()).toEqual(['brief', 'reasoning', 'words', 'tools:5', 'words', 'tools:1', 'report']);
  expect(marked('data-session-words')).toHaveLength(2);
});

it('ends a failed session with why it failed, as its last message', async () => {
  f.steps = talked; f.state = 'failed'; f.failedWhy = 'the model\'s usage limit was reached';
  await draw('primary');
  expect(order().at(-1)).toBe('failure');
  const [failure] = marked('data-session-failure');
  expect(words(failure)).toContain('Why it failed');
  expect(words(failure)).toContain('The model\'s usage limit was reached.');
  expect(failure.findAll((n: Found) => n.props['data-slot'] === 'bubble')[0].props['data-variant']).toBe('destructive');
});

it('still draws an old session, recorded before steps had kinds, as its brief and one run of tool steps', async () => {
  // Rows read before schema 55 come from the fixture without a kind at all: each is a tool step.
  f.steps = steps.map(({ kind: _kind, ...s }) => s); f.state = 'done';
  await draw('primary');
  expect(order()).toEqual(['brief', 'tools:2']);
  expect(marked('data-session-words')).toHaveLength(0);
  expect(marked('data-session-reasoning')).toHaveLength(0);
  await toggle(trigger(marked('data-session-run')[0]));
  expect(titles()).toHaveLength(2);
  expect(titles()[0]).toContain('ls house');
  // The side form is as it was: its latest tool step, asked for without words and only among tool steps.
  await act(async () => tree.unmount());
  const drawn = await draw('side');
  expect(drawn).toContain('Latest step: ');
  const asked = f.asked.find((q) => q.document.includes('BrickSessionStep'))!;
  expect(asked.document).toContain('kind:"tool"');
  expect(asked.document).not.toContain('words');
});

it('shows markup in an agent\'s words as text, rendering only what the chat\'s own renderer renders', async () => {
  f.steps = [spoke(1, 'words', 'Look: <script>window.pwned = 1</script> <b>bold</b> <img src=x onerror=alert(1)> and **real bold**'), spoke(2, 'reasoning', '<iframe src="https://evil.example"></iframe>')];
  await draw('primary');
  await toggle(trigger(marked('data-session-reasoning')[0]));
  const all = tree.root.findAll((n: Found) => typeof n.type === 'string') as Found[];
  for (const tag of ['script', 'b', 'img', 'iframe']) expect(all.filter((n) => n.type === tag)).toHaveLength(0);
  const [said] = marked('data-session-words');
  expect(words(said)).toContain('<script>window.pwned = 1</script>');
  expect(words(said)).toContain('<b>bold</b>');
  expect(said.findAll((n: Found) => n.type === 'strong').map(words)).toEqual(['real bold']);
  expect(JSON.stringify(tree.toJSON())).not.toContain('dangerouslySetInnerHTML');
});
