/** The three answers the `question` brick gives beside the Inbox's own, as the desktop's opened item does
 * (docs/specs/boards.md, "The first bricks"): "Discuss with", a task's question, and a machine asking to join. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const feed = vi.hoisted(() => vi.fn());
vi.mock('../data/graphql', () => ({ useDataQuery: feed }));
import { loadBricks } from './bricks';
import { bench } from './bricks-work.test.helper';

await loadBricks();
const b = bench(feed);
const went = vi.fn();
beforeEach(() => { b.before(); went.mockReset(); vi.stubGlobal('window', { location: { assign: went } }); });
afterEach(b.after);

const item = { id: 'in-pump', canAnswer: true, source: 'thread', agent: 'art', project: 'pond', at: '2026-11-14T20:00:00Z', state: 'waiting', volume: 'full', answers: 'yes-no',
  read: false, refs: [], body: { words: 'Replace the pump filter?' } };
const show = (over: object) => b.answer({ InboxItem: { inboxItem: { ...item, ...over } }, InboxApprovals: { approvals: [] }, InboxProposalTitles: { inboxProposalTitles: [] } });
// The primary form: the side form holds the question and its main answer, and nothing else that is tested here.
const draw = (form: 'primary' | 'side' | 'compact' = 'primary') => b.draw('question', { item: 'in-pump' }, form);

it('opens the conversation about an item with the agent loom names, by inbox.discuss, and goes to it on this page', async () => {
  show({ answers: null, source: 'notice', discussionAgent: 'fern' });
  await draw();
  expect(b.labels()).toEqual(['Discuss with Fern']);
  b.reply.value = { thread: 'th:9', conversation: 'cv-9' };
  await b.press('Discuss with Fern');
  expect(b.sent.mock.calls).toEqual([['/api/inbox/discuss', { item: 'in-pump', expectedAgent: 'fern' }]]);
  expect(b.reported.mock.calls).toEqual([['discuss', {}]]);
  expect(went.mock.calls).toEqual([['/app/t/th%3A9']]);
  // Refused: nothing is told and the page stays.
  b.sent.mockReset(); b.reported.mockReset(); went.mockReset(); b.reply.ok = false;
  await b.press('Discuss with Fern');
  expect(b.reported).not.toHaveBeenCalled();
  expect(went).not.toHaveBeenCalled();
  expect(b.alert()).toBe('Could not open the conversation. Try again.');
  // No agent named, no button; and none in the folded form.
  show({ answers: null, source: 'notice' });
  await draw();
  expect(b.controls()).toEqual([]);
  show({ answers: null, source: 'notice', discussionAgent: 'fern' });
  await draw('compact');
  expect(b.controls()).toEqual([]);
});

it('answers a task\'s question through its task, with Yes, No or words and no Mark done or Dismiss, and tells the board which', async () => {
  show({ source: 'task', waitsOnKind: 'task', waitsOnId: 't-12' });
  await draw();
  expect(b.labels()).toEqual(['Yes', 'No', 'Record answer']);
  expect(b.placed()).toContainEqual({ brick: 'ticket', params: { ticket: 't-12' } });
  expect(b.all()).not.toContain('answered where it was asked');
  await b.press('Yes');
  expect(b.sent.mock.calls).toEqual([['/api/tasks/command', { action: 'answer', id: 't-12', question: 'in-pump', answer: 'yes' }]]);
  expect(b.reported.mock.calls).toEqual([['taskAnswer', { answer: 'yes' }]]);
  b.sent.mockReset(); b.reported.mockReset();
  await b.type('Answer in your own words', '  Use the blue one  ');
  await b.submitNth(0);
  expect(b.sent.mock.calls).toEqual([['/api/tasks/command', { action: 'answer', id: 't-12', question: 'in-pump', answer: 'words', text: 'Use the blue one' }]]);
  expect(b.reported.mock.calls).toEqual([['taskAnswer', { answer: 'words' }]]);
  expect(JSON.stringify(b.reported.mock.calls)).not.toContain('blue');
  b.sent.mockReset(); b.reported.mockReset(); b.reply.ok = false;
  await b.press('No');
  expect(b.reported).not.toHaveBeenCalled();
  expect(b.alert()).toBe('Could not save your answer. Reconnect and try again.');
  // One that no longer waits, or whose words are gone, has no answer to give.
  for (const over of [{ state: 'resolved' }, { body: null }, { answers: null }]) {
    show({ source: 'task', waitsOnKind: 'task', waitsOnId: 't-12', ...over });
    await draw();
    expect(b.controls(), JSON.stringify(over)).toEqual([]);
  }
});

it('lets a machine in or blocks it only after asking, by runtime.workerJoinDecide with the notice\'s request and code', async () => {
  const request = '0b9d7c7e-3c0a-4a51-9b6e-0f3e7f5a2d11';
  show({ answers: null, source: 'notice', sourceId: `worker-join:${request}:ABCD-2345`, body: { words: 'A machine asks to join.' } });
  await draw();
  expect(b.labels()).toEqual(['Let it in…', 'Block…']);
  await b.press('Let it in…');
  expect(b.sent).not.toHaveBeenCalled();
  // The question opens in place (brick-kit.tsx, Confirm); the other answer stays beside it.
  expect(b.labels()).toEqual(['Let this machine in', 'Cancel', 'Block…']);
  await b.press('Cancel');
  expect(b.labels()).toEqual(['Let it in…', 'Block…']);
  await b.press('Let it in…');
  await b.press('Let this machine in');
  expect(b.sent.mock.calls).toEqual([['/api/runtime/workerJoinDecide', { request, code: 'ABCD-2345', decision: 'allow' }]]);
  expect(b.reported.mock.calls).toEqual([['join', { decision: 'allow' }]]);
  expect(b.all()).toContain('Machine admitted.');
  b.sent.mockReset(); b.reported.mockReset();
  await b.press('Block…');
  expect(b.sent).not.toHaveBeenCalled();
  await b.press('Block this request');
  expect(b.sent.mock.calls).toEqual([['/api/runtime/workerJoinDecide', { request, code: 'ABCD-2345', decision: 'block' }]]);
  expect(b.reported.mock.calls).toEqual([['join', { decision: 'block' }]]);
  b.sent.mockReset(); b.reported.mockReset(); b.reply.ok = false;
  await b.press('Block…');
  await b.press('Block this request');
  expect(b.reported).not.toHaveBeenCalled();
  expect(b.alert()).toBe('Could not save this decision. Check the request and try again.');
  // A notice that is not a waiting join request, or whose key is not one, offers neither.
  for (const over of [{ state: 'resolved' }, { sourceId: 'worker-join:nope:ABCD-2345' }, { sourceId: null }]) {
    show({ answers: null, source: 'notice', sourceId: `worker-join:${request}:ABCD-2345`, ...over });
    await draw();
    expect(b.controls(), JSON.stringify(over)).toEqual([]);
  }
});
