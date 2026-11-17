import { graphql } from 'graphql/index.js';
import { dataQueries } from '../../core/data/queries.js';
import { workVisibility } from '../../core/data/work-visibility.js';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDataSchema } from '../../core/data/database.js';
import { agentPeople, agents, members, secrets, bridgeConnections, bridgePeople, bridgeChannels, bridgeChannelFilters, bridgeIncoming, conversations, turns, inbox } from '../../core/data/schema.js';
import { Conversations } from '../../core/conversations/index.js';
import { BridgeIncoming, BOT_NOT_ADMITTED, STOP_WORD, UNKNOWN_SENDER, isStopWord, type IncomingMessage } from './incoming.js';
import { Jobs } from '../../runtime/jobs.js';
import { jobs, memberAgents } from '../../core/data/schema.js';
import { outsidePersonKey } from './keys.js';
import { expirePrivateBridgeWords, oldestPrivateBridgeWords } from '../../core/conversations/private-bridge-words.js';
import { bridgeFileMessages, bridgeFiles, bridgeSendParts, bridgeSends } from '../../core/data/schema.js';
import {normalizeSlack} from './normalize.js';
const clients: Database.Database[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); });
function fixture(platform: 'discord' | 'slack' = 'discord') {
  const client = new Database(':memory:'); clients.push(client);
  const now = () => '2026-11-14T12:00:00.000Z';
  const db = createDataSchema(client, now);
  db.insert(members).values({ id: 'jonathan', role: 'owner', joinedAt: now() }).run();
  for (const id of ['art', 'mark']) db.insert(agents).values({ id, about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(secrets).values({ name: 'bot', description: '', changedAt: now(), changedBy: 'jonathan' }).run();
  db.insert(bridgeConnections).values({ id: 'c', platform, agent: 'art', workspace: 'w', botUser: 'bot-art', tokenSecret: 'bot', enabled: true, state: 'connected', stateAt: now() }).run();
  db.insert(bridgeConnections).values({ id: 'peer', platform, agent: 'mark', workspace: 'w', botUser: 'bot-mark', tokenSecret: 'bot', enabled: true, state: 'connected', stateAt: now() }).run();
  db.insert(bridgePeople).values({ platform, workspace: 'w', user: 'outside', member: 'jonathan' }).run();
  db.insert(bridgeChannels).values({ platform, workspace: 'w', channel: 'room', answers: 'art', botsMayTalk: false }).run();
  const ingress = new BridgeIncoming(db, now);
  const message: IncomingMessage = { id: 'm', connection: 'c', channel: 'room', isDm: false, user: 'outside', text: 'Friday?', postedAt: now(), mentions: [] };
  /** The agent's owner places an outside account: the `bodyPolicy` card's effect. */
  const tier = (user: string, value: 1 | 2 | 3 = 2, agent = 'art') => { db.insert(agentPeople).values({ agent, person: outsidePersonKey(platform, 'w', user), tier: value }).run(); };
  return { client, db, ingress, message, now, tier };
}
describe('shared-schema bridge ingress', () => {
  it.each(['channel','group'] as const)('keeps independent Slack %s roots separate and children with their root',kind=>{
    const f=fixture('slack');
    const receive=(ts:string,thread_ts?:string)=>f.ingress.receive(normalizeSlack({id:'c',workspace:'w'},{type:'event_callback',team_id:'w',event:{type:'message',channel:'room',channel_type:kind,user:'outside',ts,thread_ts,text:'Channel words'}})!);
    const first=receive('1794672000.000001'),second=receive('1794672001.000001'),child=receive('1794672002.000001','1794672000.000001');
    expect([first.state,second.state,child.state]).toEqual(['delivered','delivered','delivered']);
    expect(second.conversation).not.toBe(first.conversation);expect(child.conversation).toBe(first.conversation);
    expect(f.db.select().from(conversations).all()).toHaveLength(2);expect(f.db.select().from(inbox).all()).toHaveLength(3);
  });
  it.each(['im','mpim'] as const)('keeps successive unthreaded Slack %s messages in one conversation',kind=>{
    const f=fixture('slack');
    const receive=(ts:string)=>f.ingress.receive(normalizeSlack({id:'c',workspace:'w'},{type:'event_callback',team_id:'w',event:{type:'message',channel:'direct',channel_type:kind,user:'outside',ts,text:'Direct words'}})!);
    const first=receive('1794672000.000001'),second=receive('1794672001.000001');
    expect(first.state).toBe('delivered');expect(second.state).toBe('delivered');
    expect(second.conversation).toBe(first.conversation);expect(first.thread).toBeNull();
    expect(f.db.select().from(conversations).all()).toHaveLength(1);
    expect(f.db.select().from(inbox).all()).toHaveLength(2);
  });
  it.each(['discord', 'slack'] as const)('delivers %s once into conversation, turn and inbox', platform => {
    const f = fixture(platform);
    const row = f.ingress.receive(f.message);
    expect(row).toMatchObject({ state: 'delivered', member: 'jonathan', deliveredAt: f.now() });
    expect(f.db.select().from(inbox).all()).toEqual([expect.objectContaining({ source: platform, sourceId: JSON.stringify(['w', 'room', 'm']), conversation: row.conversation, fromKind: 'person', fromId: 'jonathan', words: 'Friday?' })]);
    expect(f.db.select().from(turns).all()).toHaveLength(1);
    expect(f.ingress.receive(f.message)).toEqual(row);
    expect(f.db.select().from(turns).all()).toHaveLength(1);
    // The same message with other words is an edit: nothing new is recorded and the first stands.
    expect(f.ingress.receive({ ...f.message, text: 'changed' })).toEqual(row);
    expect(f.db.select().from(turns).all()).toHaveLength(1);
    expect(f.db.select().from(inbox).all().map(item => item.words)).toEqual(['Friday?']);
    // The same id from someone else, or somewhere else, is not that message at all.
    expect(() => f.ingress.receive({ ...f.message, user: 'another' })).toThrow('reused');
    expect(() => f.ingress.receive({ ...f.message, channel: 'elsewhere' })).toThrow('reused');
    f.ingress.receive({ ...f.message, id: 'm2' });
    expect(f.db.select().from(conversations).all()).toHaveLength(1);
    expect(f.db.select().from(turns).all().map(t => t.seq)).toEqual([1, 2]);
  });
  it('addresses explicit mentions, ignores another agent, and allows direct messages', () => {
    const f = fixture();
    expect(f.ingress.receive({ ...f.message, id: 'other', mentions: ['bot-mark'] }).state).toBe('dropped');
    f.db.update(bridgeChannels).set({ answers: 'mark' }).run();
    expect(f.ingress.receive({ ...f.message, id: 'none' }).state).toBe('dropped');
    expect(f.ingress.receive({ ...f.message, id: 'mention', mentions: ['bot-art'] }).state).toBe('delivered');
    const dm = f.ingress.receive({ ...f.message, id: 'dm', channel: 'direct', isDm: true });
    expect(dm.state).toBe('delivered');
    expect(f.db.select().from(conversations).where(eq(conversations.id, dm.conversation!)).get()?.member).toBe('jonathan');
  });
  it('takes an explicit reply to a bot, or a thread under its message, as addressed to that bot, and nothing looser', () => {
    const f = fixture();
    // The room is Art's to answer. Both bots see every message; `to` says which agents got it.
    let n = 0;
    const to = (message: Partial<IncomingMessage>) => {
      const id = `m${++n}`;
      return (['c', 'peer'] as const).filter(connection => f.ingress.receive({ ...f.message, ...message, id, connection }).state === 'delivered').map(connection => connection === 'c' ? 'art' : 'mark');
    };
    expect(to({})).toEqual(['art']);
    // An explicit reply to Mark's message is Mark's, though nobody wrote his mention.
    expect(to({ repliesTo: 'bot-mark' })).toEqual(['mark']);
    // A reply to a person's message addresses no bot: it goes to the agent that answers the room.
    expect(to({ repliesTo: 'someone' })).toEqual(['art']);
    // Mark posted a message through loom; a thread opened under that message is Mark's.
    f.ingress.receive({ ...f.message, id: 'asked', connection: 'peer', mentions: ['bot-mark'] });
    f.db.insert(bridgeSends).values({ id: 'send', incoming: 'bi:["peer","asked"]', connection: 'peer', channel: 'room', thread: null, text: 'Here', state: 'sent', createdAt: f.now() }).run();
    f.db.insert(bridgeSendParts).values([{ send: 'send', part: 0, postedId: 'marks-first-part' }, { send: 'send', part: 1, postedId: 'marks-message' }]).run();
    expect(to({ channel: 'marks-message', parent: 'room', thread: 'marks-message' })).toEqual(['mark']);
    // A long reply goes out in parts, and a thread under any of them is under Mark's message, not only the last.
    expect(to({ channel: 'marks-first-part', parent: 'room', thread: 'marks-first-part' })).toEqual(['mark']);
    // A thread Mark has only spoken in, under somebody else's message, is not: no continuing conversation is inferred.
    f.db.insert(bridgeSends).values({ id: 'send2', incoming: 'bi:["peer","asked"]', connection: 'peer', channel: 'room', thread: 'their-thread', text: 'Here', state: 'sent', createdAt: f.now() }).run();
    f.db.insert(bridgeSendParts).values({ send: 'send2', part: 0, postedId: 'a-reply-inside' }).run();
    expect(to({ channel: 'their-thread', parent: 'room', thread: 'their-thread' })).toEqual(['art']);
  });
  it('labels every direct message conversation direct, and no other', () => {
    const f = fixture();
    const label = (message: Partial<IncomingMessage>) => {
      const row = f.ingress.receive({ ...f.message, ...message });
      const cv = f.db.select().from(conversations).where(eq(conversations.id, row.conversation!)).get()!;
      return { direct: cv.direct, member: cv.member };
    };
    f.tier('stranger');
    expect(label({ id: 'room' })).toEqual({ direct: false, member: null });
    expect(label({ id: 'linked', channel: 'dm1', isDm: true })).toEqual({ direct: true, member: 'jonathan' });
    expect(label({ id: 'stranger', channel: 'dm2', isDm: true, user: 'stranger' })).toEqual({ direct: true, member: null });
    expect(label({ id: 'group', channel: 'dm3', isDm: true, groupDm: true })).toEqual({ direct: true, member: null });
  });
  it('tries a held message again from its own row, with everything admission read the first time', () => {
    const f = fixture();
    f.db.update(bridgeConnections).set({ enabled: false }).run();
    // Mark is mentioned in Art's room: Mark's connection should get it, Art's should not.
    const sent = { ...f.message, mentions: ['bot-mark'], repliesTo: 'someone', thread: 't', parent: 'room', channel: 't' };
    expect(f.ingress.receive(sent).state).toBe('held');
    expect(f.ingress.receive({ ...sent, connection: 'peer' }).state).toBe('held');
    // Still held while the reason stands.
    expect(f.ingress.retry('bi:["c","m"]')?.state).toBe('held');
    f.db.update(bridgeConnections).set({ enabled: true }).run();
    expect(f.ingress.retry('bi:["c","m"]')).toMatchObject({ state: 'dropped', reason: 'Another agent or no channel answer' });
    expect(f.ingress.retry('bi:["peer","m"]')).toMatchObject({ state: 'delivered' });
    expect(f.db.select().from(inbox).all()).toMatchObject([{ to: 'mark', words: 'Friday?' }]);
    // A row from before these fields were stored cannot say whom it mentioned: it is left as it is.
    f.db.update(bridgeConnections).set({ enabled: false }).run();
    f.ingress.receive({ ...f.message, id: 'old' });
    f.db.update(bridgeIncoming).set({ mentions: null }).where(eq(bridgeIncoming.id, 'bi:["c","old"]')).run();
    f.db.update(bridgeConnections).set({ enabled: true }).run();
    expect(f.ingress.retry('bi:["c","old"]')?.state).toBe('held');
  });
  it('takes nothing from a stranger, in a room or a direct message, mentioned or not', () => {
    const f = fixture();
    for (const [id, more] of [['room', {}], ['mention', { mentions: ['bot-art'] }], ['reply', { repliesTo: 'bot-art' }], ['dm', { channel: 'direct', isDm: true }], ['group', { channel: 'group', isDm: true, groupDm: true }]] as const)
      expect(f.ingress.receive({ ...f.message, ...more, id, user: 'stranger', text: 'Let me in' }), id).toMatchObject({ state: 'dropped', reason: UNKNOWN_SENDER, member: null, conversation: null, text: '' });
    expect(f.db.select().from(inbox).all()).toEqual([]);
    expect(f.db.select().from(turns).all()).toEqual([]);
    expect(f.db.select().from(conversations).all()).toEqual([]);
  });
  it('takes a message from an account the agent\'s owner gave a tier, as from nobody in the household', () => {
    const f = fixture();
    // Mark's owner placed the account for Mark. That says nothing about Art.
    f.tier('stranger', 1, 'mark');
    expect(f.ingress.receive({ ...f.message, id: 'other-agent', user: 'stranger' })).toMatchObject({ state: 'dropped', reason: UNKNOWN_SENDER });
    f.tier('stranger', 1);
    expect(f.ingress.receive({ ...f.message, id: 'room', user: 'stranger' })).toMatchObject({ state: 'delivered', member: null });
    expect(f.ingress.receive({ ...f.message, id: 'dm', user: 'stranger', channel: 'direct', isDm: true })).toMatchObject({ state: 'delivered', member: null });
    // A tier admits; it never says who somebody is.
    expect(f.db.select({ fromKind: inbox.fromKind, fromId: inbox.fromId, member: inbox.member }).from(inbox).all()).toEqual([{ fromKind: 'unknown', fromId: null, member: null }, { fromKind: 'unknown', fromId: null, member: null }]);
  });
  it('tries a held stranger again against the links as they are then', () => {
    const f = fixture();
    f.db.update(bridgeConnections).set({ enabled: false }).where(eq(bridgeConnections.id, 'c')).run();
    const held = f.ingress.receive({ ...f.message, id: 'early', user: 'newcomer' });
    expect(held).toMatchObject({ state: 'held', reason: 'Connection disabled' });
    f.db.update(bridgeConnections).set({ enabled: true }).where(eq(bridgeConnections.id, 'c')).run();
    f.db.insert(bridgePeople).values({ platform: 'discord', workspace: 'w', user: 'newcomer', member: 'jonathan' }).run();
    expect(f.ingress.retry(held.id)).toMatchObject({ state: 'delivered', member: 'jonathan' });
  });
  it('takes a bot\'s message only where bots may talk, and only when it writes this agent\'s mention', () => {
    const f = fixture();
    expect(f.ingress.receive({ ...f.message, id: 'self', user: 'bot-art' }).reason).toBe('Own message');
    const mark = { ...f.message, user: 'bot-mark', bot: true };
    expect(f.ingress.receive({ ...mark, id: 'disabled', mentions: ['bot-art'] })).toMatchObject({ state: 'dropped', reason: BOT_NOT_ADMITTED });
    f.db.update(bridgeChannels).set({ botsMayTalk: true }).run();
    // The room is Art's to answer, and still a bot's post with no mention wakes nobody: two agents cannot loop.
    expect(f.ingress.receive({ ...mark, id: 'unaddressed' })).toMatchObject({ state: 'dropped', reason: BOT_NOT_ADMITTED });
    // Nor does a bot's reply to Art's message, or its post in a thread under one: only a written mention.
    expect(f.ingress.receive({ ...mark, id: 'reply', repliesTo: 'bot-art' })).toMatchObject({ state: 'dropped', reason: BOT_NOT_ADMITTED });
    expect(f.ingress.receive({ ...mark, id: 'known', mentions: ['bot-art'] })).toMatchObject({ state: 'delivered', member: null });
    // A household agent's bot is that agent whether or not the platform flagged the message as a bot's.
    expect(f.ingress.receive({ ...mark, id: 'unflagged', bot: false })).toMatchObject({ state: 'dropped', reason: BOT_NOT_ADMITTED });
    expect(f.db.select({ fromKind: inbox.fromKind, fromId: inbox.fromId }).from(inbox).all()).toEqual([{ fromKind: 'agent', fromId: 'mark' }]);
    // A bot in a direct message is never delivered.
    expect(f.ingress.receive({ ...mark, id: 'dm', channel: 'direct', isDm: true, mentions: ['bot-art'] })).toMatchObject({ state: 'dropped', reason: BOT_NOT_ADMITTED });
  });
  it('takes a bot or webhook that is no agent of the household by the platform\'s flag, as from nobody', () => {
    const f = fixture();
    f.db.update(bridgeChannels).set({ botsMayTalk: true }).run();
    expect(f.ingress.receive({ ...f.message, id: 'silent', user: 'fez', bot: true })).toMatchObject({ state: 'dropped', reason: BOT_NOT_ADMITTED });
    expect(f.ingress.receive({ ...f.message, id: 'bot', user: 'fez', bot: true, mentions: ['bot-art'] })).toMatchObject({ state: 'delivered', member: null });
    expect(f.ingress.receive({ ...f.message, id: 'hook', user: 'gabe-hook', webhook: true, mentions: ['bot-art'] })).toMatchObject({ state: 'delivered', member: null });
    // It mentioned Mark, not Art: Mark's connection takes it and Art's does not.
    expect(f.ingress.receive({ ...f.message, id: 'for-mark', user: 'fez', bot: true, mentions: ['bot-mark'] })).toMatchObject({ state: 'dropped' });
    expect(f.ingress.receive({ ...f.message, id: 'for-mark', connection: 'peer', user: 'fez', bot: true, mentions: ['bot-mark'] })).toMatchObject({ state: 'delivered' });
    expect(f.db.select({ fromKind: inbox.fromKind, fromId: inbox.fromId }).from(inbox).all()).toEqual(Array(3).fill({ fromKind: 'unknown', fromId: null }));
    // A person's link is no use to a bot: a linked account flagged as a bot is still held to the bots' rule.
    expect(f.ingress.receive({ ...f.message, id: 'linked-bot', bot: true })).toMatchObject({ state: 'dropped', reason: BOT_NOT_ADMITTED });
  });
  it('holds conflicting recipient assignments for the same bot', () => {
    const f = fixture();
    f.db.update(bridgeConnections).set({ botUser: 'bot-art' }).where(eq(bridgeConnections.id, 'peer')).run();
    const message = { ...f.message, mentions: ['bot-art'] };
    expect(f.ingress.receive(message)).toMatchObject({ state: 'held', reason: 'Ambiguous connection agent', conversation: null });
    expect(f.ingress.receive({ ...message, connection: 'peer' })).toMatchObject({ state: 'held', reason: 'Ambiguous connection agent', conversation: null });
    expect(f.db.select().from(inbox).all()).toHaveLength(0);
    expect(f.db.select().from(turns).all()).toHaveLength(0);
  });
  it('holds conflicting bot-to-agent assignments instead of guessing', () => {
    const f = fixture();
    f.db.insert(bridgeConnections).values({ id: 'conflict', platform: 'discord', agent: 'art', workspace: 'w', botUser: 'bot-mark', tokenSecret: 'bot', enabled: true, state: 'connected', stateAt: f.now() }).run();
    f.db.update(bridgeChannels).set({ botsMayTalk: true }).run();
    expect(f.ingress.receive({ ...f.message, user: 'bot-mark', mentions: ['bot-art'] })).toMatchObject({ state: 'held', reason: 'Ambiguous bot identity', conversation: null });
    expect(f.db.select().from(inbox).all()).toHaveLength(0);
  });
  it('scopes person links to both platform and workspace', () => {
    const f = fixture();
    f.db.insert(members).values({ id: 'other', role: 'member', joinedAt: f.now() }).run();
    f.db.delete(bridgePeople).run();
    f.db.insert(bridgePeople).values([
      { platform: 'slack', workspace: 'w', user: 'outside', member: 'other' },
      { platform: 'discord', workspace: 'another', user: 'outside', member: 'other' },
      { platform: 'discord', workspace: 'w', user: 'outside', member: 'jonathan' },
    ]).run();
    expect(f.ingress.receive(f.message).member).toBe('jonathan');
  });
  it('applies only and ignore filters to a thread parent', () => {
    const f = fixture();
    f.db.insert(bridgeChannelFilters).values({ connection: 'c', channel: 'allowed', rule: 'only' }).run();
    expect(f.ingress.receive(f.message).reason).toBe('Channel filtered');
    expect(f.ingress.receive({ ...f.message, id: 'yes', parent: 'allowed', mentions: ['bot-art'] }).state).toBe('delivered');
    f.db.insert(bridgeChannelFilters).values({ connection: 'c', channel: 'allowed', rule: 'ignore' }).run();
    expect(f.ingress.receive({ ...f.message, id: 'no', parent: 'allowed', mentions: ['bot-art'] }).state).toBe('dropped');
  });
  it('holds disabled connections until explicit retry, without duplicating a turn', () => {
    const f = fixture();
    f.db.update(bridgeConnections).set({ enabled: false }).where(eq(bridgeConnections.id, 'c')).run();
    expect(f.ingress.receive(f.message)).toMatchObject({ state: 'held', reason: 'Connection disabled' });
    expect(f.db.select().from(inbox).all()).toHaveLength(0);
    f.db.update(bridgeConnections).set({ enabled: true }).where(eq(bridgeConnections.id, 'c')).run();
    expect(f.ingress.receive(f.message)).toMatchObject({ state: 'held', reason: 'Connection disabled' });
    expect(f.ingress.receive(f.message, true).state).toBe('delivered');
    f.ingress.receive(f.message, true);
    expect(f.db.select().from(turns).all()).toHaveLength(1);
  });
  it('keeps workspace, channel, and thread conversations distinct', () => {
    const f = fixture();
    f.ingress.receive(f.message);
    f.ingress.receive({ ...f.message, id: 'thread', thread: 't' });
    f.ingress.receive({ ...f.message, id: 'other-channel', channel: 'elsewhere', mentions: ['bot-art'] });
    f.db.update(bridgeConnections).set({ workspace: 'w2' }).where(eq(bridgeConnections.id, 'c')).run();
    // A person link is one workspace's: the same account id elsewhere is somebody else until it is linked there.
    expect(f.ingress.receive({ ...f.message, id: 'unlinked-there', mentions: ['bot-art'] })).toMatchObject({ state: 'dropped', reason: UNKNOWN_SENDER });
    f.db.insert(bridgePeople).values({ platform: 'discord', workspace: 'w2', user: 'outside', member: 'jonathan' }).run();
    f.ingress.receive({ ...f.message, id: 'workspace', mentions: ['bot-art'] });
    expect(f.db.select().from(conversations).all()).toHaveLength(4);
  });
  it('delivers a message seen by two connections for one agent only once', () => {
    const f = fixture();
    f.db.update(bridgeConnections).set({ agent: 'art' }).where(eq(bridgeConnections.id, 'peer')).run();
    const message = { ...f.message, mentions: ['bot-art', 'bot-mark'] };
    const first = f.ingress.receive(message);
    const second = f.ingress.receive({ ...message, connection: 'peer' });
    expect(second).toMatchObject({ state: 'delivered', conversation: first.conversation });
    expect(f.db.select().from(bridgeIncoming).all()).toHaveLength(2);
    expect(f.db.select().from(turns).all()).toHaveLength(1);
    expect(f.db.select().from(inbox).all()).toHaveLength(1);
  });
  it('delivers the same place to separate agents when both are addressed', () => {
    const f = fixture();
    const message = { ...f.message, mentions: ['bot-art', 'bot-mark'] };
    const art = f.ingress.receive(message);
    const mark = f.ingress.receive({ ...message, connection: 'peer' });
    expect(mark.conversation).not.toBe(art.conversation);
    expect(f.db.select().from(conversations).all().map(c => c.agent).sort()).toEqual(['art', 'mark']);
    expect(f.db.select().from(inbox).all().map(i => i.to).sort()).toEqual(['art', 'mark']);
    expect(f.db.select().from(turns).all()).toHaveLength(2);
  });
  it('rolls back incoming and turn creation when inbox insertion fails', () => {
    const f = fixture();
    f.client.exec("CREATE TRIGGER fail_inbox BEFORE INSERT ON inbox BEGIN SELECT RAISE(ABORT, 'inbox unavailable'); END");
    expect(() => f.ingress.receive(f.message)).toThrow('inbox unavailable');
    expect(f.db.select().from(bridgeIncoming).all()).toHaveLength(0);
    expect(f.db.select().from(conversations).all()).toHaveLength(0);
    expect(f.db.select().from(turns).all()).toHaveLength(0);
    f.client.exec('DROP TRIGGER fail_inbox');
    expect(f.ingress.receive(f.message).state).toBe('delivered');
  });
});

it('a changed DM person link opens a separate private conversation and never relabels prior history', () => {
 const f=fixture();
 f.db.insert(members).values({id:'other',role:'member',joinedAt:f.now()}).run();
 const first=f.ingress.receive({...f.message,id:'private-first',isDm:true,channel:'direct'});
 f.db.update(bridgePeople).set({member:'other'}).run();
 const second=f.ingress.receive({...f.message,id:'private-second',isDm:true,channel:'direct'});
 expect(second.conversation).not.toBe(first.conversation);
 expect(f.db.select().from(conversations).where(eq(conversations.id,first.conversation!)).get()?.member).toBe('jonathan');
 expect(f.db.select().from(conversations).where(eq(conversations.id,second.conversation!)).get()?.member).toBe('other');
 expect(f.db.select().from(inbox).where(eq(inbox.conversation,first.conversation!)).get()?.member).toBe('jonathan');
 expect(f.db.select().from(inbox).where(eq(inbox.conversation,second.conversation!)).get()?.member).toBe('other');
});
it('group DMs never use one participant private-member context or a prior single-DM history', () => {
 const f=fixture();
 const first=f.ingress.receive({...f.message,id:'private-first',isDm:true,channel:'direct'});
 const group=f.ingress.receive({...f.message,id:'group-message',isDm:true,groupDm:true,channel:'direct'});
 expect(group.conversation).not.toBe(first.conversation);
 expect(group.member).toBe('jonathan');
 expect(f.db.select().from(conversations).where(eq(conversations.id,group.conversation!)).get()?.member).toBeNull();
 expect(f.db.select().from(conversations).where(eq(conversations.id,first.conversation!)).get()?.member).toBe('jonathan');
});

it('ordinary members read only their own DM generation after a person-link reassignment', async () => {
 const f=fixture();
 f.db.insert(members).values(['alice','bob'].map(id=>({id,role:'member' as const,joinedAt:f.now()}))).run();
 f.db.update(bridgePeople).set({member:'alice'}).run();
 const first=f.ingress.receive({...f.message,id:'alice-private',isDm:true,channel:'direct'});
 f.db.update(bridgePeople).set({member:'bob'}).run();
 const second=f.ingress.receive({...f.message,id:'bob-private',isDm:true,channel:'direct'});
 for(const [member,id] of [['alice',first.conversation],['bob',second.conversation]]){
  const schema=dataQueries(f.client,{tables:['conversations'],visibility:{conversations:workVisibility({kind:'member',id:member!}).approvals}});
  const result=await graphql({schema,source:'{ conversations { id member } }'});expect(result.errors).toBeUndefined();
  expect(result.data?.conversations).toEqual([{id,member}]);
 }
});

it('a delayed duplicate on a second connection preserves the original DM actor and conversation after relinking', () => {
 const f=fixture();f.db.insert(members).values(['alice','bob'].map(id=>({id,role:'member' as const,joinedAt:f.now()}))).run();f.db.update(bridgePeople).set({member:'alice'}).run();
 const connection=f.db.select().from(bridgeConnections).where(eq(bridgeConnections.id,'c')).get()!;
 f.db.insert(bridgeConnections).values({...connection,id:'second'}).run();
 const first=f.ingress.receive({...f.message,id:'same-message',isDm:true,channel:'direct'});
 f.db.update(bridgePeople).set({member:'bob'}).run();
 const again=f.ingress.receive({...f.message,id:'same-message',isDm:true,channel:'direct',connection:'second'});
 expect(again).toMatchObject({conversation:first.conversation,member:'alice',state:'delivered'});
 expect(f.db.select().from(conversations).all()).toHaveLength(1);expect(f.db.select().from(inbox).all()).toHaveLength(1);
});
it('a newly linked single-DM member gets a private conversation without adopting unknown-actor history', () => {
 const f=fixture();f.db.delete(bridgePeople).run();f.tier('outside');
 const first=f.ingress.receive({...f.message,id:'unknown-private',isDm:true,channel:'direct'});
 f.db.insert(members).values({id:'alice',role:'member',joinedAt:f.now()}).run();
 f.db.insert(bridgePeople).values({platform:'discord',workspace:'w',user:'outside',member:'alice'}).run();
 const next=f.ingress.receive({...f.message,id:'known-private',isDm:true,channel:'direct'});
 expect(next.conversation).not.toBe(first.conversation);expect(next.member).toBe('alice');
 expect(f.db.select().from(conversations).where(eq(conversations.id,first.conversation!)).get()?.member).toBeNull();
 expect(f.db.select().from(conversations).where(eq(conversations.id,next.conversation!)).get()?.member).toBe('alice');
});

it('rejects a conflicting cross-connection copy without creating a second receipt or changing history', () => {
 const f=fixture(),connection=f.db.select().from(bridgeConnections).where(eq(bridgeConnections.id,'c')).get()!;f.db.insert(bridgeConnections).values({...connection,id:'second'}).run();
 f.tier('different-sender');
 const first=f.ingress.receive({...f.message,id:'same-message',isDm:true,channel:'direct'});
 expect(()=>f.ingress.receive({...f.message,id:'same-message',isDm:true,channel:'direct',connection:'second',text:'Changed words'})).toThrow('identity changed');
 expect(()=>f.ingress.receive({...f.message,id:'same-message',isDm:true,channel:'direct',connection:'second',user:'different-sender'})).toThrow('identity changed');
 expect(f.db.select().from(bridgeIncoming).all()).toHaveLength(1);expect(f.db.select().from(conversations).all()).toHaveLength(1);expect(f.db.select().from(inbox).get()?.conversation).toBe(first.conversation);
});

it('reuses the original public channel place key',()=>{
 const f=fixture(),prior=new Conversations(f.db,f.now).open({agent:'art',venue:'discord',place:JSON.stringify(['w','room',null]),label:'Existing public room'});
 const row=f.ingress.receive(f.message);
 expect(row.conversation).toBe(prior.id);expect(f.db.select().from(conversations).all()).toHaveLength(1);
});
it('removes a private DM\'s files with its words, and keeps a file another message still carries', () => {
  const f = fixture('slack');
  // One direct message with words and one with a file alone; a room message that carries one of the same files.
  const dm = f.ingress.receive({ ...f.message, id: 'dm', channel: 'direct', isDm: true, text: 'Private words' });
  const bare = f.ingress.receive({ ...f.message, id: 'bare', channel: 'direct', isDm: true, text: '' });
  const room = f.ingress.receive({ ...f.message, id: 'room', text: 'Room words' });
  const keep = (file: string, first: string, ...also: string[]) => {
    f.db.insert(bridgeFiles).values({ connection: 'c', file, name: file, contents: Buffer.from(file), fetchedAt: f.now() }).run();
    for (const incoming of [first, ...also]) f.db.insert(bridgeFileMessages).values({ connection: 'c', file, incoming }).run();
  };
  keep('PRIVATE', dm.id); keep('BARE', bare.id); keep('SHARED', dm.id, room.id); keep('ROOM', room.id);
  const listed = () => f.db.select().from(bridgeFileMessages).all().map(row => `${row.file}@${row.incoming}`).sort();
  expect(oldestPrivateBridgeWords(f.db)).toBe(Date.parse(f.now()));
  expect(expirePrivateBridgeWords(f.db, '2026-11-14T11:59:59.999Z')).toBe(0);
  expect(listed()).toHaveLength(5);
  expirePrivateBridgeWords(f.db, f.now());
  // Neither direct message lists a file any more. What only they carried is gone; the room's are untouched.
  expect(listed()).toEqual([`ROOM@${room.id}`, `SHARED@${room.id}`]);
  expect(f.db.select({ file: bridgeFiles.file }).from(bridgeFiles).all().map(row => row.file).sort()).toEqual(['ROOM', 'SHARED']);
  expect(oldestPrivateBridgeWords(f.db)).toBeUndefined();
});
it('erases a private DM\'s words at the keep time, in every column that holds them, and nothing else', () => {
  const f = fixture(), dm = f.ingress.receive({ ...f.message, id: 'dm', channel: 'direct', isDm: true, text: 'Private words' });
  const room = f.ingress.receive({ ...f.message, id: 'room', text: 'Room words' });
  expect(f.db.select().from(conversations).where(eq(conversations.id, dm.conversation!)).get()?.member).toBe('jonathan');
  for (const [id, incoming, state] of [['sent', dm.id, 'sent'], ['waiting', dm.id, 'held'], ['room', room.id, 'sent']] as const)
    f.db.insert(bridgeSends).values({ id, incoming, connection: 'c', channel: 'x', text: 'Reply words', state, createdAt: f.now() }).run();
  const words = () => ({ mail: f.db.select({ words: inbox.words }).from(inbox).all().map(row => row.words), received: f.db.select({ text: bridgeIncoming.text }).from(bridgeIncoming).all().map(row => row.text),
    replies: Object.fromEntries(f.db.select().from(bridgeSends).all().map(row => [row.id, row.text])) });
  expect(oldestPrivateBridgeWords(f.db)).toBe(Date.parse(f.now()));
  // Younger than the keep time: untouched.
  expect(expirePrivateBridgeWords(f.db, '2026-11-14T11:59:59.999Z')).toBe(0);
  expect(expirePrivateBridgeWords(f.db, '2026-11-14T12:00:00.000Z')).toBe(3);
  // The room is not private, and a reply a person has yet to decide on is still needed.
  expect(words()).toEqual({ mail: [null, 'Room words'], received: ['', 'Room words'], replies: { sent: '', waiting: 'Reply words', room: 'Reply words' } });
  expect(oldestPrivateBridgeWords(f.db)).toBeUndefined();
  // A late replay of the erased message is still the same message, not a reused id.
  expect(f.ingress.receive({ ...f.message, id: 'dm', channel: 'direct', isDm: true, text: 'Private words' })).toMatchObject({ id: dm.id, state: 'delivered', text: '' });
  expect(f.ingress.receive({ ...f.message, id: 'room', text: 'Other words' })).toMatchObject({ text: 'Room words' });
  expect(() => f.ingress.receive({ ...f.message, id: 'room', user: 'another' })).toThrow('reused');
});

it('answers only the listed rooms and still takes direct messages', () => {
  // "Only these channels" chooses rooms. Whether direct messages are taken is a separate choice, not made by it.
  const f = fixture();
  f.db.insert(bridgeChannelFilters).values({ connection: 'c', channel: 'elsewhere', rule: 'only' }).run();
  expect(f.ingress.receive({ ...f.message, id: 'room' })).toMatchObject({ state: 'dropped', reason: 'Channel filtered' });
  expect(f.ingress.receive({ ...f.message, id: 'dm', channel: 'direct', isDm: true, text: 'Hello' })).toMatchObject({ state: 'delivered', member: 'jonathan' });
});

it('keeps no words of a message it drops, direct or not', () => {
  const f = fixture();
  // An `only` filter drops every room outside its channels; a direct message someone chose to ignore is dropped too.
  f.db.insert(bridgeChannelFilters).values([{ connection: 'c', channel: 'elsewhere', rule: 'only' }, { connection: 'c', channel: 'direct', rule: 'ignore' }]).run();
  expect(f.ingress.receive({ ...f.message, id: 'dm', channel: 'direct', isDm: true, text: 'Private words' }))
    .toMatchObject({ state: 'dropped', reason: 'Channel filtered', member: 'jonathan', conversation: null, text: '' });
  expect(f.ingress.receive({ ...f.message, id: 'room', text: 'Room words' })).toMatchObject({ state: 'dropped', text: '' });
  // A replay of a dropped message is still that message.
  expect(f.ingress.receive({ ...f.message, id: 'room', text: 'Room words' })).toMatchObject({ state: 'dropped', text: '' });
  expect(f.db.select().from(inbox).all()).toEqual([]);
});
it('holds a Discord direct message while its bot is connected in two guilds, and then delivers it once', () => {
  const f = fixture();
  // One bot, two guilds: both gateway sessions hear every direct message to the bot.
  f.db.insert(bridgeConnections).values({ id: 'second', platform: 'discord', agent: 'art', workspace: 'other-guild', botUser: 'bot-art', tokenSecret: 'bot', enabled: true, state: 'connected', stateAt: f.now() }).run();
  const dm = { ...f.message, id: 'dm', channel: 'direct', isDm: true };
  expect(f.ingress.receive(dm)).toMatchObject({ state: 'held', reason: 'Bot is connected in another guild', conversation: null });
  expect(f.ingress.receive({ ...dm, connection: 'second' })).toMatchObject({ state: 'held', reason: 'Bot is connected in another guild', conversation: null });
  expect(f.db.select().from(inbox).all()).toEqual([]);
  // A room message belongs to one guild and is not held up by this.
  expect(f.ingress.receive(f.message).state).toBe('delivered');
  f.db.update(bridgeConnections).set({ enabled: false }).where(eq(bridgeConnections.id, 'second')).run();
  expect(f.ingress.retry('bi:["c","dm"]')).toMatchObject({ state: 'delivered' });
  expect(f.ingress.retry('bi:["second","dm"]')).toMatchObject({ state: 'held', reason: 'Connection disabled' });
  expect(f.db.select().from(inbox).all().filter(item => item.words === 'Friday?' && item.sourceId?.includes('direct'))).toHaveLength(1);
});
it('erases the words of every direct message at the keep time, whoever it is from', () => {
  const f = fixture();
  f.tier('stranger');
  const stranger = f.ingress.receive({ ...f.message, id: 'stranger', channel: 'direct-1', isDm: true, user: 'stranger', text: 'Unlinked words' });
  const group = f.ingress.receive({ ...f.message, id: 'group', channel: 'direct-2', isDm: true, groupDm: true, text: 'Group words' });
  f.ingress.receive({ ...f.message, id: 'room', text: 'Room words' });
  expect([stranger, group].map(row => f.db.select().from(conversations).where(eq(conversations.id, row.conversation!)).get())).toEqual([
    expect.objectContaining({ member: null, direct: true }), expect.objectContaining({ member: null, direct: true })]);
  expect(oldestPrivateBridgeWords(f.db)).toBe(Date.parse(f.now()));
  expect(expirePrivateBridgeWords(f.db, f.now())).toBe(4);
  expect(f.db.select({ words: inbox.words }).from(inbox).all().map(row => row.words)).toEqual([null, null, 'Room words']);
  expect(f.db.select({ text: bridgeIncoming.text }).from(bridgeIncoming).all().map(row => row.text)).toEqual(['', '', 'Room words']);
  expect(oldestPrivateBridgeWords(f.db)).toBeUndefined();
});

// Who counts in intake is a household question: a connection that is switched off or removed, or whose
// agent is removed, is no agent's bot, and a removed member's linked account is nobody's.
it.each([
  ['switched off', (f: ReturnType<typeof fixture>) => { f.db.update(bridgeConnections).set({ enabled: false, state: 'disconnected' }).where(eq(bridgeConnections.id, 'peer')).run(); }],
  ['removed', (f: ReturnType<typeof fixture>) => { f.db.update(bridgeConnections).set({ enabled: false, state: 'disconnected', removedAt: f.now() }).where(eq(bridgeConnections.id, 'peer')).run(); }],
  ['removed and then switched on without being restored', (f: ReturnType<typeof fixture>) => { f.db.update(bridgeConnections).set({ removedAt: f.now() }).where(eq(bridgeConnections.id, 'peer')).run(); }],
  ['the connection of a removed agent', (f: ReturnType<typeof fixture>) => { f.db.update(agents).set({ removedAt: f.now() }).where(eq(agents.id, 'mark')).run(); }],
])('does not hold a message for a second connection of the same bot that is %s', (_, retire) => {
  const f = fixture();
  // The owner moved the bot to another agent: a new connection for it, and the old one retired.
  f.db.update(bridgeConnections).set({ botUser: 'bot-art' }).where(eq(bridgeConnections.id, 'peer')).run();
  const message = { ...f.message, mentions: ['bot-art'] };
  expect(f.ingress.receive(message)).toMatchObject({ state: 'held', reason: 'Ambiguous connection agent' });
  retire(f);
  expect(f.ingress.retry(f.ingress.receive(message).id)).toMatchObject({ state: 'delivered', reason: null });
  expect(f.db.select().from(inbox).all()).toHaveLength(1);
});
it('takes a retired connection\'s bot for no agent: not a peer that was addressed, and not a household sender', () => {
  const f = fixture();
  f.db.update(bridgeConnections).set({ enabled: false, state: 'disconnected' }).where(eq(bridgeConnections.id, 'peer')).run();
  f.db.update(bridgeChannels).set({ botsMayTalk: true }).run();
  // A mention of the retired bot is a mention of nobody here, so the room's own agent answers as it would anyone.
  expect(f.ingress.receive({ ...f.message, id: 'mention', mentions: ['bot-mark'] })).toMatchObject({ state: 'delivered' });
  // The retired bot itself is some bot, not the agent it once stood for: taken as from nobody when it writes a mention.
  expect(f.ingress.receive({ ...f.message, id: 'bot', user: 'bot-mark', bot: true, mentions: ['bot-art'] })).toMatchObject({ state: 'delivered', member: null });
  expect(f.db.select().from(inbox).all().map(row => row.fromKind)).toEqual(['person', 'unknown']);
});
it('records a removed member\'s linked account as nobody, in a room and in a direct message', () => {
  const f = fixture();
  f.db.insert(members).values({ id: 'guest', role: 'member', joinedAt: f.now() }).run();
  f.db.insert(bridgePeople).values({ platform: 'discord', workspace: 'w', user: 'guest-account', member: 'guest' }).run();
  const before = f.ingress.receive({ ...f.message, id: 'before', channel: 'dm', isDm: true, user: 'guest-account' });
  expect(before).toMatchObject({ state: 'delivered', member: 'guest' });
  // Removing a member keeps their link (apps/household.ts); it must stop standing for them.
  f.db.update(members).set({ removedAt: f.now() }).where(eq(members.id, 'guest')).run();
  // Their account is then a stranger's.
  expect(f.ingress.receive({ ...f.message, id: 'gone', user: 'guest-account' })).toMatchObject({ state: 'dropped', reason: UNKNOWN_SENDER });
  expect(f.ingress.receive({ ...f.message, id: 'gone-dm', channel: 'dm', isDm: true, user: 'guest-account' })).toMatchObject({ state: 'dropped', reason: UNKNOWN_SENDER });
  // The agent's owner may still place the account; it is then an outside one, not the member it was.
  f.tier('guest-account');
  const room = f.ingress.receive({ ...f.message, id: 'room', user: 'guest-account' });
  const direct = f.ingress.receive({ ...f.message, id: 'after', channel: 'dm', isDm: true, user: 'guest-account' });
  expect(room).toMatchObject({ state: 'delivered', member: null });
  expect(direct).toMatchObject({ state: 'delivered', member: null });
  // Not the private conversation they had as a member.
  expect(direct.conversation).not.toBe(before.conversation);
  expect(f.db.select().from(conversations).where(eq(conversations.id, direct.conversation!)).get()).toMatchObject({ member: null, direct: true });
  expect(f.db.select({ fromKind: inbox.fromKind, fromId: inbox.fromId }).from(inbox).where(eq(inbox.conversation, direct.conversation!)).all()).toEqual([{ fromKind: 'unknown', fromId: null }]);
  expect(f.db.select({ fromKind: inbox.fromKind, fromId: inbox.fromId }).from(inbox).where(eq(inbox.conversation, room.conversation!)).all()).toEqual([{ fromKind: 'unknown', fromId: null }]);
  // Restored, the link stands for them again.
  f.db.update(members).set({ removedAt: null }).where(eq(members.id, 'guest')).run();
  expect(f.ingress.receive({ ...f.message, id: 'restored', channel: 'dm', isDm: true, user: 'guest-account' })).toMatchObject({ member: 'guest', conversation: before.conversation });
});

describe('the stop word', () => {
  /** Intake with the runtime's own Stop, and a job working in the room's conversation. */
  function working() {
    const f = fixture();
    const ingress = new BridgeIncoming(f.db, f.now, (job, member) => { new Jobs(f.db, f.now).stop(job, member, 'stop'); });
    const first = ingress.receive({ ...f.message, id: 'ask', text: 'Do the long thing' });
    const start = (id: string, conversation = first.conversation!) => f.db.insert(jobs).values({ id, agent: 'art', conversation, title: 'Work', state: 'running', queuedAt: f.now(), brief: '', model: 'model', startedByKind: 'agent', startedBy: 'art', houseRepository: 'repo', houseFile: 'Housefile', houseBranch: 'next' }).run();
    start('job');
    const state = (id = 'job') => f.db.select().from(jobs).where(eq(jobs.id, id)).get()!;
    return { ...f, ingress, first, start, state };
  }
  it('is only "stop" or "cancel", whatever the case, with its mentions set aside', () => {
    for (const text of ['stop', 'Stop', 'STOP!', 'cancel', 'Cancel.', 'stop!!!', '<@123> stop', 'stop <@!123>', '<@&456> cancel.', '  stop  ']) expect(isStopWord(text), text).toBe(true);
    for (const text of ['', 'stop it', 'please stop', 'stopped', 'cancel that', "don't stop", 'stop?', 'halt', '<@123>']) expect(isStopWord(text), text).toBe(false);
  });
  it('ends the job working in that conversation, on that member\'s word, and is nobody\'s mail', () => {
    const f = working();
    const row = f.ingress.receive({ ...f.message, id: 'stop', text: 'Stop!' });
    expect(row).toMatchObject({ state: 'dropped', reason: STOP_WORD, text: '', member: 'jonathan', conversation: null });
    expect(f.state()).toMatchObject({ state: 'stopped', endedBy: 'jonathan', endedReason: 'stop' });
    expect(f.ingress.takeStopped()).toEqual([{ job: 'job', incoming: row.id }]);
    expect(f.ingress.takeStopped()).toEqual([]);
    // Nothing was delivered for it: one piece of mail and one turn, the first message's.
    expect(f.db.select().from(inbox).all()).toHaveLength(1);
    expect(f.db.select().from(turns).all()).toHaveLength(1);
    // The same event again is the same dropped message, and stops nothing more.
    f.start('later');
    expect(f.ingress.receive({ ...f.message, id: 'stop', text: 'Stop!' })).toMatchObject({ state: 'dropped', reason: STOP_WORD });
    expect(f.state('later').state).toBe('running');
  });
  it('is an ordinary message when no job is working there, so a stop read late stops nothing later', () => {
    const f = working();
    new Jobs(f.db, f.now).stop('job', 'jonathan', 'write-off');
    expect(f.ingress.receive({ ...f.message, id: 'late', text: 'stop' })).toMatchObject({ state: 'delivered', text: 'stop' });
    expect(f.ingress.takeStopped()).toEqual([]);
    // A job that starts afterwards is not the one anybody asked to stop.
    f.start('next');
    expect(f.state('next').state).toBe('running');
  });
  it('stops only the job of the place it is said in', () => {
    const f = working();
    const dm = f.ingress.receive({ ...f.message, id: 'dm', channel: 'direct', isDm: true, text: 'Another thing' });
    f.start('dm-job', dm.conversation!);
    const thread = f.ingress.receive({ ...f.message, id: 'in-thread', channel: 't', parent: 'room', thread: 't', text: 'A third' });
    f.start('thread-job', thread.conversation!);
    expect(f.ingress.receive({ ...f.message, id: 'stop-dm', channel: 'direct', isDm: true, text: 'cancel' })).toMatchObject({ state: 'dropped', reason: STOP_WORD });
    expect([f.state().state, f.state('dm-job').state, f.state('thread-job').state]).toEqual(['running', 'stopped', 'running']);
    expect(f.ingress.receive({ ...f.message, id: 'stop-thread', channel: 't', parent: 'room', thread: 't', text: 'stop' })).toMatchObject({ reason: STOP_WORD });
    expect([f.state().state, f.state('thread-job').state]).toEqual(['running', 'stopped']);
  });
  it('is not a stop when said to another agent, or by someone who may not end this agent\'s jobs', () => {
    const f = working();
    // Said to Mark: Art's job goes on, and the message is not Art's.
    expect(f.ingress.receive({ ...f.message, id: 'to-mark', text: '<@bot-mark> stop', mentions: ['bot-mark'] })).toMatchObject({ state: 'dropped', reason: 'Another agent or no channel answer' });
    expect(f.state().state).toBe('running');
    // An outside account the owner placed has no member to end a job as: its "stop" is a message.
    f.tier('guest');
    expect(f.ingress.receive({ ...f.message, id: 'guest', user: 'guest', text: 'stop' })).toMatchObject({ state: 'delivered', text: 'stop' });
    // A member who is not an owner and does not have this agent: likewise.
    f.db.insert(members).values({ id: 'daniel', role: 'member', joinedAt: f.now() }).run();
    f.db.insert(bridgePeople).values({ platform: 'discord', workspace: 'w', user: 'daniel-account', member: 'daniel' }).run();
    expect(f.ingress.receive({ ...f.message, id: 'daniel', user: 'daniel-account', text: 'stop' })).toMatchObject({ state: 'delivered' });
    expect(f.state().state).toBe('running');
    // Given the agent, the same member may.
    f.db.insert(memberAgents).values({ member: 'daniel', agent: 'art' }).run();
    expect(f.ingress.receive({ ...f.message, id: 'daniel-2', user: 'daniel-account', text: 'stop' })).toMatchObject({ state: 'dropped', reason: STOP_WORD });
    expect(f.state()).toMatchObject({ state: 'stopped', endedBy: 'daniel' });
    // A stranger's stop is a stranger's message.
    f.start('again');
    expect(f.ingress.receive({ ...f.message, id: 'stranger', user: 'stranger', text: 'stop' })).toMatchObject({ state: 'dropped', reason: UNKNOWN_SENDER });
    expect(f.state('again').state).toBe('running');
  });
  it('stops the job where the agent was called by a mention, in a room it does not answer', () => {
    const f = working();
    f.db.update(bridgeChannels).set({ answers: 'mark' }).run();
    expect(f.ingress.receive({ ...f.message, id: 'plain-stop', text: 'stop' })).toMatchObject({ state: 'dropped', reason: STOP_WORD });
    expect(f.state().state).toBe('stopped');
  });
  it('without the runtime\'s Stop to call, takes the words as a message', () => {
    const f = working();
    expect(f.ingress.receive({ ...f.message, id: 'no-runtime', connection: 'c', text: 'stop' }).reason).toBe(STOP_WORD);
    const plain = new BridgeIncoming(f.db, f.now);
    f.start('other');
    expect(plain.receive({ ...f.message, id: 'plain', text: 'stop' })).toMatchObject({ state: 'delivered' });
    expect(f.state('other').state).toBe('running');
  });
});
