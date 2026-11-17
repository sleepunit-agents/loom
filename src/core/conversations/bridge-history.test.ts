import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDataSchema } from '../data/database.js';
import { agents, members, secrets, bridgeConnections, bridgePeople, bridgeChannels, bridgeIncoming, bridgeSends, household, inbox } from '../data/schema.js';
import { BridgeIncoming } from '../../pieces/bridges/incoming.js';
import { HISTORY_LINES, prepareBridgeHistory } from './bridge-history.js';
import { HISTORY_BYTES } from './history-limit.js';
import { Conversations } from './index.js';

const clients: Database.Database[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); });
function fixture() {
  const client = new Database(':memory:'); clients.push(client);
  let at = Date.parse('2026-11-14T12:00:00.000Z');
  const now = () => new Date(at).toISOString(), db = createDataSchema(client, now);
  db.insert(members).values({ id: 'jonathan', role: 'owner', joinedAt: now() }).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(secrets).values({ name: 'bot', description: '', changedAt: now(), changedBy: 'jonathan' }).run();
  db.insert(bridgeConnections).values({ id: 'c', platform: 'discord', agent: 'art', workspace: 'w', botUser: 'bot-art', tokenSecret: 'bot', enabled: true, state: 'connected', stateAt: now() }).run();
  db.insert(bridgePeople).values({ platform: 'discord', workspace: 'w', user: 'outside', member: 'jonathan' }).run();
  db.insert(bridgeChannels).values({ platform: 'discord', workspace: 'w', channel: 'room', answers: 'art', botsMayTalk: false }).run();
  const ingress = new BridgeIncoming(db, now);
  let n = 0;
  /** A message arrives a minute after the last thing said. */
  const hear = (text: string, where: { channel?: string; isDm?: boolean } = {}) => {
    at += 60_000;
    return ingress.receive({ id: `m${++n}`, connection: 'c', channel: where.channel ?? 'room', isDm: !!where.isDm, user: 'outside', text, postedAt: now(), mentions: [] });
  };
  /** A body finished with the message's mail and posted this. */
  const answer = (incoming: { id: string }, text: string, state: 'sent' | 'held' | 'uncertain' | 'dismissed' = 'sent') => {
    at += 60_000;
    db.update(inbox).set({ state: 'done', doneAt: now() }).where(eq(inbox.id, db.select().from(inbox).all().find(item => item.sourceId?.includes(JSON.parse(incoming.id.slice(3))[1]))!.id)).run();
    db.insert(bridgeSends).values({ id: `s${++n}`, incoming: incoming.id, connection: 'c', channel: 'room', thread: null, text, state, createdAt: now() }).run();
  };
  const history = (conversation: string) => prepareBridgeHistory(db, now, conversation)();
  return { db, now, hear, answer, history, later: (ms: number) => { at += ms; } };
}

it('hands over what was said earlier in the conversation, in order, and not the mail still to be answered', () => {
  const f = fixture();
  const first = f.hear('What is the plan?'); f.answer(first, 'Three steps.');
  const second = f.hear('Do the second one'); f.answer(second, 'Done.');
  const third = f.hear('And the third');
  expect(f.history(third.conversation!).map(line => [line.seq, line.kind, line.sender, line.words])).toEqual([
    [1, 'message', 'jonathan', 'What is the plan?'], [2, 'reply', 'art', 'Three steps.'], [3, 'message', 'jonathan', 'Do the second one'], [4, 'reply', 'art', 'Done.']]);
  // A room's words are kept without limit.
  expect(f.history(third.conversation!).every(line => line.keepUntil === null)).toBe(true);
});

it('keeps to its own conversation, and to posts that were made', () => {
  const f = fixture();
  const room = f.hear('In the room'); f.answer(room, 'Room answer');
  const dm = f.hear('In private', { channel: 'direct', isDm: true }); f.answer(dm, 'Private answer');
  const held = f.hear('Held one'); f.answer(held, 'Never posted', 'held');
  const doubt = f.hear('Doubtful one'); f.answer(doubt, 'Maybe posted', 'uncertain');
  expect(dm.conversation).not.toBe(room.conversation);
  expect(f.history(room.conversation!).map(line => line.words)).toEqual(['In the room', 'Room answer', 'Held one', 'Doubtful one']);
  expect(f.history(dm.conversation!).map(line => line.words)).toEqual(['In private', 'Private answer']);
  // A conversation that is not a bridge's has none, nor one that does not exist.
  const wake = new Conversations(f.db, f.now).open({ agent: 'art', venue: 'wake', place: 'daily', label: 'Daily' });
  expect(f.history(wake.id)).toEqual([]);
  expect(f.history('nowhere')).toEqual([]);
});

it('says when a direct conversation\'s words will be erased, and leaves out what has been or is due', () => {
  const f = fixture();
  f.db.insert(household).values({ commsDays: 2 }).run();
  const old = f.hear('Old private words', { channel: 'direct', isDm: true }); f.answer(old, 'Old private answer');
  f.later(86_400_000);
  const recent = f.hear('Recent private words', { channel: 'direct', isDm: true }); f.answer(recent, 'Recent private answer');
  const lines = f.history(recent.conversation!);
  expect(lines.map(line => line.words)).toEqual(['Old private words', 'Old private answer', 'Recent private words', 'Recent private answer']);
  expect(lines.every(line => line.keepUntil !== null && Date.parse(line.keepUntil) === Date.parse(line.at) + 2 * 86_400_000)).toBe(true);
  // A day later the first exchange is past its keep time, whether or not the sweep has erased it yet.
  f.later(86_400_000);
  expect(f.history(recent.conversation!).map(line => line.words)).toEqual(['Recent private words', 'Recent private answer']);
  // Erased words are not history.
  f.db.update(bridgeIncoming).set({ text: '' }).run(); f.db.update(bridgeSends).set({ text: '' }).run();
  expect(f.history(recent.conversation!)).toEqual([]);
});

it('hands over the newest words that fit, and refuses to hand over what changed since it was prepared', () => {
  const f = fixture();
  let last = f.hear('first');
  for (let n = 0; n < 6; n++) { f.answer(last, 'x'.repeat(200_000)); last = f.hear(`message ${n}`); }
  const lines = f.history(last.conversation!);
  expect(Buffer.byteLength(JSON.stringify(lines))).toBeLessThanOrEqual(HISTORY_BYTES);
  expect(lines.length).toBeLessThan(12);
  // The newest are kept and the oldest dropped.
  expect(lines.at(-1)?.words).toBe('x'.repeat(200_000));
  expect(lines[0].words).not.toBe('first');
  expect(lines.map(line => line.seq)).toEqual(lines.map((_, index) => index + 1));
  expect(HISTORY_LINES).toBe(100);
  const prepared = prepareBridgeHistory(f.db, f.now, last.conversation!);
  f.db.update(bridgeSends).set({ text: '' }).run();
  expect(prepared).toThrow('Dialogue changed');
});

it('keeps things said in the same instant in the order they were recorded', () => {
  const f = fixture();
  const asked = f.hear('One question');
  // Three posts in one instant, as a body that says two things and then replies makes them.
  f.answer(asked, 'First');
  for (const [id, text] of [['zzz', 'Second'], ['aaa', 'Third']]) f.db.insert(bridgeSends).values({ id, incoming: asked.id, connection: 'c', channel: 'room', thread: null, text, state: 'sent', createdAt: f.now() }).run();
  for (let n = 0; n < 5; n++) expect(f.history(asked.conversation!).map(line => line.words)).toEqual(['One question', 'First', 'Second', 'Third']);
});
