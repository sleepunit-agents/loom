import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { generateX25519Identity } from 'age-encryption';
import { createDataSchema } from '../core/data/database.js';
import { agents, members } from '../core/data/schema.js';
import { CommsMessages } from '../core/conversations/messages.js';
import { wordsKey } from '../pieces/comms/crypto.js';
import { change } from '../pieces/changes/fixture.js';
import { taskService } from './tasks.js';
import { approvalService } from './approvals.js';
import { changeService } from './changes.js';
import { conversationWork } from './conversation-work.js';

let client: Database.Database;
afterEach(() => client?.close());
const at = '2026-11-14T20:00:00.000Z';
const actor = { kind: 'agent', id: 'art' } as const;
async function fixture() {
  client = new Database(':memory:');
  const db = createDataSchema(client, () => at);
  db.insert(members).values({ id: 'jonathan', role: 'owner', joinedAt: at }).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  const comms = new CommsMessages(db, wordsKey(await generateX25519Identity()), () => at);
  const thread = comms.threads.open({ member: 'jonathan', agent: 'art', title: 'Pump' });
  const other = comms.threads.open({ member: 'jonathan', agent: 'art', title: 'Other pump' });
  const tasks = taskService(db, () => at);
  const approvals = approvalService(db, new Map(), () => at);
  const changes = changeService(db, () => undefined, () => at);
  const work = conversationWork(db);
  const file = (source?: string) => tasks.create({ title: 'Order pump', goal: 'Pump ordered', why: 'Old one failed', owner: actor,
    ...(source ? { source: { kind: 'conversation', id: source } } : {}) }, actor);
  return { comms, thread, other, tasks, approvals, changes, work, file };
}

it('resolves mentioned and made-here tasks to current rows without importing unrelated work', async () => {
  const { comms, thread, other, tasks, work, file } = await fixture();
  const made = file(thread.conversation), mentioned = file(other.conversation), unrelated = file(other.conversation);
  await comms.send({ thread: thread.id, sender: 'art', kind: 'reply', words: `Compare ${mentioned.id}; unknown t-999` });
  let cards = work.read(thread.conversation);
  expect(cards.tasks.map(c => [c.task.id, c.madeHere, c.messageSeq])).toEqual([[made.id, true, null], [mentioned.id, false, 1]]);
  tasks.close(mentioned.id, 'cancelled');
  tasks.edit(made.id, { title: 'Buy the chosen pump' });
  cards = work.read(thread.conversation);
  expect(cards.tasks[0].task.title).toBe('Buy the chosen pump');
  expect(cards.tasks[1].task).toMatchObject({ status: 'closed', closeReason: 'cancelled' });
  expect(cards.tasks.some(c => c.task.id === unrelated.id)).toBe(false);
  expect(work.read('cv-unknown')).toEqual({ tasks: [], approvals: [], changes: [] });
});

it('shows PR references once, distinguishes work made here and follows cached state changes', async () => {
  const { comms, thread, other, tasks, changes, work, file } = await fixture();
  const made = file(thread.conversation), mentioned = file(other.conversation);
  const first = change({ body: made.id }), second = change({ id: 'github:acme/app#4', number: 4, body: mentioned.id });
  changes.put(first); changes.put(second);
  tasks.comment(made.id, `Up as ${first.id}`, actor);
  await comms.send({ thread: thread.id, sender: 'art', kind: 'reply', words: `${first.id}, ${second.id} and ${mentioned.id}` });
  const cards = work.read(thread.conversation).changes;
  expect(cards.map(c => [c.change.id, c.madeHere, c.messageSeq])).toEqual([[first.id, true, 1], [second.id, false, 1]]);
  changes.put({ ...first, state: 'merged', closed: at });
  expect(work.read(thread.conversation).changes[0].change).toMatchObject({ state: 'merged', waitingOn: 'done' });
  // A PR body mentioning a task links the two, but does not establish origin.
  expect(work.read(other.conversation).changes).toEqual([]);
  tasks.comment(mentioned.id, `Up as ${second.id}`, actor);
  expect(work.read(other.conversation).changes.map(c => [c.change.id, c.madeHere])).toEqual([[second.id, true]]);
});

it('uses the same approval row inline and in its tile, without bringing another conversation’s asks', async () => {
  const { thread, other, approvals, work } = await fixture();
  const request = (conversation: string) => approvals.request({ kind: 'command', target: 'box:bench', what: 'Run the pump check',
    why: 'Confirm it works', agent: 'art', askedFrom: 'chat', actingFor: 'owner', conversation,
    ask: 'Run the pump check?', ifYes: 'I run it', ifNo: 'I wait' });
  const approval = request(thread.conversation); request(other.conversation);
  expect(work.read(thread.conversation).approvals).toEqual([approval]);
  approvals.allow(approval.id, 'jonathan');
  expect(work.read(thread.conversation).approvals[0].state).toBe('allowed');
  approvals.use(approval.id, 'art', 'command', 'box:bench');
  expect(work.read(thread.conversation).approvals[0].state).toBe('used');
});
